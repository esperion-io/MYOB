#!/usr/bin/env node
/**
 * Roll back Allied's supplier assignments and Order list decisions.
 *
 * Two safety nets sit behind the preferred-supplier Order list release:
 *
 *  1. Backups: plain copies of every decision table, platform_backup_<name>_*,
 *     registered in platform_backups with each copy's row count and checksum.
 *     "pre_preferred_fix" is taken by that release's first boot on Render;
 *     `snapshot` takes more on demand — take one right before deploying.
 *  2. platform_change_log: every supplier or cart change since, with the
 *     item's whole state before and after. From 1.1 it also holds lead-time
 *     and minimum edits (supplier_meta, item_lead_time, min_stock): `log`
 *     lists them and `undo` refuses them, since nothing here writes them back.
 *
 * Nothing is written without --apply AND --confirm <database name>. Every
 * restore and whole-cart undo first snapshots the current tables
 * (pre_restore_<stamp> / pre_undo_<stamp>), so it can itself be reversed with
 * `restore ... --from <that name>`. Every undo is logged with before/after, so
 * it can be undone in turn.
 *
 *   node scripts/supplier-rollback.mjs status
 *   node scripts/supplier-rollback.mjs diff [--from NAME] [--csv out.csv]
 *   node scripts/supplier-rollback.mjs snapshot NAME --apply --confirm DB
 *   node scripts/supplier-rollback.mjs restore suppliers|cart|all [--from NAME] [--items N1,N2] [--accept-mismatch] [--apply --confirm DB]
 *   node scripts/supplier-rollback.mjs log [--item N] [--limit 50]
 *   node scripts/supplier-rollback.mjs undo ID [--force] [--apply --confirm DB]
 *   node scripts/supplier-rollback.mjs prepare-main-rollback [--apply --confirm DB]
 *
 * DATABASE_URL must be set. Item arguments are MYOB item numbers (e.g. FG150P).
 */
import { writeFileSync } from "node:fs";
import pg from "pg";

/** Copy suffix → live table. Must match BACKUP_TABLES in src/sync/schema.ts (a test checks). */
const TABLES = {
  item_suppliers: "platform_item_suppliers",
  item_no_supplier: "platform_item_no_supplier",
  purchase_cart: "platform_purchase_cart",
  cart_pick_ack: "platform_cart_pick_ack",
  cart_item_off: "platform_cart_item_off",
};
const SCOPES = {
  suppliers: ["item_suppliers", "item_no_supplier"],
  cart: ["purchase_cart", "cart_pick_ack", "cart_item_off"],
  all: Object.keys(TABLES),
};
/** Columns that only say when something was saved; ignored when deciding whether a row differs. */
const TIME_COLUMNS = new Set(["updated_at", "set_at", "acked_at", "taken_off_at"]);
const DEFAULT_BACKUP = "pre_preferred_fix";

/* ---------- arguments: strict, so a typo can never widen a restore ---------- */

const VALUE_OPTIONS = new Set(["csv", "items", "item", "limit", "from", "confirm"]);
const FLAG_OPTIONS = new Set(["apply", "force", "accept-mismatch"]);
const ALLOWED = {
  status: [],
  diff: ["from", "csv"],
  snapshot: ["apply", "confirm"],
  restore: ["from", "items", "apply", "confirm", "accept-mismatch"],
  log: ["item", "limit"],
  undo: ["apply", "confirm", "force"],
  "prepare-main-rollback": ["apply", "confirm"],
};
const options = {};
const positional = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (name in options) fail(`--${name} given twice.`);
    if (FLAG_OPTIONS.has(name)) options[name] = true;
    else if (VALUE_OPTIONS.has(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--") || v.trim() === "") fail(`--${name} needs a value.`);
      options[name] = v;
      i++;
    } else fail(`Unknown option ${a}.`);
  }
}
const [command = "status", target] = positional;
if (!ALLOWED[command]) fail(`Unknown command "${command}". Use: ${Object.keys(ALLOWED).join(", ")}`);
{
  const extra = Object.keys(options).filter((o) => !ALLOWED[command].includes(o));
  if (extra.length)
    fail(`${command} does not take ${extra.map((o) => `--${o}`).join(", ")}. It takes: ${ALLOWED[command].map((o) => `--${o}`).join(" ") || "no options"}`);
  if (positional.length > (["restore", "undo", "snapshot"].includes(command) ? 2 : 1))
    fail(`Unexpected argument(s): ${positional.slice(1).join(" ")}`);
}
const flag = (n) => options[n] === true;
const opt = (n) => options[n];

function fail(message) {
  console.error(message);
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL is not set.");
const host = (() => {
  try {
    return new URL(url).hostname;
  } catch {
    return "(unparsed)";
  }
})();
const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const pool = new pg.Pool({
  connectionString: url,
  ssl: LOCAL.has(host) ? undefined : { rejectUnauthorized: false },
  options: "-c timezone=UTC",
});
/** The database actually connected to, from the server — what --confirm must name. */
let dbName = "";

/** Writes need --apply and the database name typed back, so the target is never a guess. */
function mayWrite() {
  if (!flag("apply")) return false;
  if (opt("confirm") !== dbName) fail(`Refusing to write: add --confirm ${dbName} to confirm the database (${host}).`);
  return true;
}

/** JSON with object keys sorted: JSONB does not keep key order, so compare on this. */
const canon = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x,
  );
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const safeName = (n) => {
  if (!/^[a-z0-9_]{1,40}$/.test(n)) fail(`Backup names are lower-case letters, digits and _ (got "${n}").`);
  return n;
};
const copyName = (name, suffix) => `platform_backup_${name}_${suffix}`;

async function columnsOf(db, table) {
  const r = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND table_schema = current_schema() ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x) => x.column_name);
}
const quoteCols = (cols) => cols.map((c) => `"${c.replaceAll('"', '""')}"`).join(", ");

/* ---------- backups ---------- */

async function backupInfo(name) {
  const r = await pool.query(`SELECT name, taken_at, note, detail FROM platform_backups WHERE name = $1`, [name]);
  if (!r.rows.length) return null;
  const b = r.rows[0];
  const problems = [];
  if (!b.detail?.counts) problems.push("registered without row counts, so it cannot be checked");
  for (const suffix of Object.keys(TABLES)) {
    const t = copyName(name, suffix);
    const ok = (await pool.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [t])).rows[0].ok;
    if (!ok) {
      problems.push(`${t} is missing`);
      continue;
    }
    const c = (await pool.query(`SELECT COUNT(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS sum FROM ${t} t`)).rows[0];
    const expected = b.detail?.counts?.[suffix];
    if (expected != null && expected !== c.n) problems.push(`${t} has ${c.n} rows, registered with ${expected}`);
    const sum = b.detail?.checksums?.[suffix];
    if (sum !== undefined && sum !== c.sum) problems.push(`${t} rows changed since it was taken (checksum differs)`);
  }
  return { ...b, problems };
}

async function requireBackup(name) {
  const b = await backupInfo(name);
  if (!b) fail(`No backup named "${name}" on ${dbName}.`);
  if (b.problems.length && !flag("accept-mismatch"))
    fail(`Backup "${name}" does not match what was registered:\n  ${b.problems.join("\n  ")}\nAdd --accept-mismatch to use it anyway.`);
  return b;
}

/** Copy every decision table aside under `name`, registered with counts and checksums. */
async function takeSnapshot(client, name, note) {
  if ((await client.query(`SELECT 1 FROM platform_backups WHERE name = $1`, [name])).rows.length)
    throw new Error(`A backup named "${name}" already exists.`);
  const counts = {};
  const checksums = {};
  for (const [suffix, table] of Object.entries(TABLES)) {
    const copy = copyName(name, suffix);
    await client.query(`CREATE TABLE ${copy} AS SELECT * FROM ${table}`);
    const c = (await client.query(`SELECT COUNT(*)::int AS n, md5(string_agg(t::text, '|' ORDER BY t::text)) AS sum FROM ${copy} t`)).rows[0];
    counts[suffix] = c.n;
    checksums[suffix] = c.sum;
  }
  await client.query(`INSERT INTO platform_backups (name, note, detail) VALUES ($1, $2, $3)`, [
    name,
    note,
    JSON.stringify({ counts, checksums, takenBy: "supplier-rollback.mjs" }),
  ]);
  return counts;
}

async function freeName(client, base) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}_${n}`;
    if (!(await client.query(`SELECT 1 FROM platform_backups WHERE name = $1`, [name])).rows.length) return name;
  }
}

async function inTx(fn, isolation = "REPEATABLE READ") {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/* ---------- what differs, and what changed outside the log ---------- */

/** Per item: preferred supplier and ruling in the backup vs now. */
async function preferredDiff(name, itemUids) {
  const S = copyName(name, "item_suppliers");
  const R = copyName(name, "item_no_supplier");
  const r = await pool.query(
    `WITH then_p AS (SELECT item_uid, supplier_uid FROM ${S} WHERE is_preferred),
          now_p  AS (SELECT item_uid, supplier_uid FROM platform_item_suppliers WHERE is_preferred),
          then_r AS (SELECT item_uid FROM ${R}),
          now_r  AS (SELECT item_uid FROM platform_item_no_supplier),
          items  AS (SELECT item_uid FROM then_p UNION SELECT item_uid FROM now_p
                     UNION SELECT item_uid FROM then_r UNION SELECT item_uid FROM now_r)
     SELECT i.item_uid, it.number,
            ts.name AS then_name, tp.supplier_uid AS then_uid, (tr.item_uid IS NOT NULL) AS then_ruled,
            ns.name AS now_name,  np.supplier_uid AS now_uid,  (nr.item_uid IS NOT NULL) AS now_ruled
     FROM items i
     LEFT JOIN myob_items it ON it.uid = i.item_uid
     LEFT JOIN then_p tp ON tp.item_uid = i.item_uid
     LEFT JOIN now_p  np ON np.item_uid = i.item_uid
     LEFT JOIN then_r tr ON tr.item_uid = i.item_uid
     LEFT JOIN now_r  nr ON nr.item_uid = i.item_uid
     LEFT JOIN myob_suppliers ts ON ts.uid = tp.supplier_uid
     LEFT JOIN myob_suppliers ns ON ns.uid = np.supplier_uid
     WHERE (tp.supplier_uid IS DISTINCT FROM np.supplier_uid OR (tr.item_uid IS NULL) <> (nr.item_uid IS NULL))
       AND ($1::text[] IS NULL OR i.item_uid = ANY($1))
     ORDER BY it.number`,
    [itemUids],
  );
  return r.rows;
}

/**
 * Whole-row differences between a backup and the live tables, per table:
 * rows the restore would delete or insert, and the items they belong to.
 * Every column but the "when saved" ones counts — an alternate supplier, a
 * supplier item number, a note or a ruling's reason is a difference.
 */
async function rowDiff(name, suffixes, itemUids) {
  const out = [];
  for (const suffix of suffixes) {
    const live = TABLES[suffix];
    const copy = copyName(name, suffix);
    const liveCols = await columnsOf(pool, live);
    const copyCols = new Set(await columnsOf(pool, copy));
    const cols = quoteCols(liveCols.filter((c) => copyCols.has(c) && !TIME_COLUMNS.has(c)));
    const f = `WHERE ($1::text[] IS NULL OR item_uid = ANY($1))`;
    const r = await pool.query(
      `WITH gone AS (SELECT ${cols} FROM ${live} ${f} EXCEPT SELECT ${cols} FROM ${copy} ${f}),
            back AS (SELECT ${cols} FROM ${copy} ${f} EXCEPT SELECT ${cols} FROM ${live} ${f})
       SELECT (SELECT COUNT(*) FROM gone)::int AS deleted, (SELECT COUNT(*) FROM back)::int AS inserted,
              ARRAY(SELECT DISTINCT item_uid FROM (SELECT item_uid FROM gone UNION SELECT item_uid FROM back) u) AS items`,
      [itemUids],
    );
    out.push({ suffix, ...r.rows[0] });
  }
  return out;
}

/**
 * Items changed since the backup was taken with no change-log entry to show
 * for it — most likely made under the previous release, which logs nothing.
 * A restore reverts them too, and the log cannot bring them back.
 */
async function changedOutsideLog(takenAt, itemUids) {
  // A supplier change is accounted for only by a supplier log entry for that
  // item (or a seed or restore that covered it); a cart change only by a cart
  // entry. "Start again" clears the cart, so it accounts for nothing later.
  const r = await pool.query(
    `WITH sup AS (
       SELECT item_uid FROM platform_item_suppliers WHERE updated_at > $1
       UNION SELECT item_uid FROM platform_item_no_supplier WHERE set_at > $1
     ),
     crt AS (SELECT item_uid FROM platform_purchase_cart WHERE updated_at > $1),
     outside AS (
       SELECT s.item_uid FROM sup s
       WHERE NOT EXISTS (SELECT 1 FROM platform_change_log l
                         WHERE l.changed_at >= $1 AND l.entity = 'item_supplier' AND l.item_uid = s.item_uid)
         AND NOT EXISTS (SELECT 1 FROM platform_change_log a, jsonb_array_elements(COALESCE(a.detail->'inserted', '[]'::jsonb)) e
                         WHERE a.changed_at >= $1 AND a.action = 'apply_suggestions' AND e->>'item_uid' = s.item_uid)
       UNION
       SELECT c.item_uid FROM crt c
       WHERE NOT EXISTS (SELECT 1 FROM platform_change_log l
                         WHERE l.changed_at >= $1 AND l.entity = 'cart' AND l.item_uid = c.item_uid)
     )
     SELECT o.item_uid, it.number FROM outside o LEFT JOIN myob_items it ON it.uid = o.item_uid
     WHERE ($2::text[] IS NULL OR o.item_uid = ANY($2))
       AND NOT EXISTS (SELECT 1 FROM platform_change_log r
                       WHERE r.entity = 'restore' AND r.changed_at >= $1
                         AND (r.detail->'items' IS NULL OR jsonb_typeof(r.detail->'items') = 'null' OR r.detail->'items' ? o.item_uid))
     ORDER BY it.number`,
    [takenAt, itemUids],
  );
  return r.rows;
}

const label = (uid, name, ruled) => (ruled ? "NO SUPPLIER" : uid ? (name ?? uid) : "(none)");
const numbers = (rows, n = 30) =>
  rows.length ? ` — ${rows.slice(0, n).map((r) => r.number ?? r.item_uid).join(", ")}${rows.length > n ? ", …" : ""}` : "";

/* ---------- commands ---------- */

async function status() {
  console.log(`Database ${dbName} on ${host}`);
  let names;
  try {
    names = (await pool.query(`SELECT name FROM platform_backups ORDER BY taken_at`)).rows.map((r) => r.name);
  } catch (err) {
    if (err.code === "42P01") names = [];
    else throw err;
  }
  if (!names.length) console.log("No backups yet. The pre-fix backup is taken on the first boot of the release on Render.");
  for (const name of names) {
    const b = await backupInfo(name);
    console.log(`Backup ${name}: taken ${b.taken_at.toISOString()}${b.detail?.commit ? ` at commit ${b.detail.commit.slice(0, 7)}` : ""} (${b.detail?.takenBy ?? "?"})`);
    console.log(`  rows: ${JSON.stringify(b.detail?.counts ?? {})}`);
    for (const p of b.problems) console.log(`  PROBLEM: ${p}`);
  }
  const pre = names.includes(DEFAULT_BACKUP) ? await backupInfo(DEFAULT_BACKUP) : null;
  if (pre && !pre.problems.length) {
    const diff = await preferredDiff(DEFAULT_BACKUP, null);
    console.log(`Items whose preferred supplier or no-supplier ruling differs from ${DEFAULT_BACKUP}: ${diff.length}`);
    const outside = await changedOutsideLog(pre.taken_at, null);
    if (outside.length)
      console.log(`WARNING: ${outside.length} item(s) changed since ${DEFAULT_BACKUP} with no change-log entry (made outside this release?)${numbers(outside)}`);
  }
  let log = { rows: [] };
  try {
    log = await pool.query(`SELECT entity, COUNT(*)::int AS n, MAX(changed_at) AS last FROM platform_change_log GROUP BY entity ORDER BY entity`);
  } catch (err) {
    if (err.code !== "42P01") throw err;
  }
  for (const r of log.rows) console.log(`Change log: ${r.n} ${r.entity} change(s), last ${r.last.toISOString()}`);
}

async function diff() {
  const name = safeName(opt("from") ?? DEFAULT_BACKUP);
  const b = await requireBackup(name);
  const rows = await preferredDiff(name, null);
  console.log(`Preferred supplier in backup ${name} → now (${rows.length} item(s)):`);
  for (const r of rows)
    console.log(`  ${r.number ?? r.item_uid}\t${label(r.then_uid, r.then_name, r.then_ruled)}\t→ now ${label(r.now_uid, r.now_name, r.now_ruled)}`);
  for (const d of await rowDiff(name, SCOPES.all, null))
    console.log(`  ${TABLES[d.suffix]}: ${d.deleted} row(s) differ now, ${d.inserted} in the backup, across ${d.items.length} item(s)`);
  const outside = await changedOutsideLog(b.taken_at, null);
  if (outside.length) console.log(`Changed outside the change log since ${name}: ${outside.length} item(s)${numbers(outside)}`);
  const csv = opt("csv");
  if (csv) {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
    writeFileSync(
      csv,
      [`Item,In backup ${name},Now`, ...rows.map((r) =>
        [r.number ?? r.item_uid, label(r.then_uid, r.then_name, r.then_ruled), label(r.now_uid, r.now_name, r.now_ruled)].map(esc).join(","),
      )].join("\n") + "\n",
    );
    console.log(`Written to ${csv}`);
  }
}

async function snapshot() {
  if (!target) fail("snapshot needs a name, e.g. `snapshot pre_go_live`.");
  const name = safeName(target);
  console.log(`Database ${dbName} on ${host}`);
  if (!mayWrite()) {
    console.log(`Would copy every decision table to platform_backup_${name}_*. Add --apply --confirm ${dbName}.`);
    return;
  }
  const counts = await inTx((c) => takeSnapshot(c, name, "Taken by hand with supplier-rollback.mjs"));
  console.log(`Snapshot ${name} taken: ${JSON.stringify(counts)}`);
}

async function uidsForNumbers(list) {
  if (list === undefined) return null;
  const nums = list.split(",").map((s) => s.trim()).filter(Boolean);
  if (!nums.length) fail("--items lists no item numbers.");
  const r = await pool.query(`SELECT uid, number FROM myob_items WHERE number = ANY($1)`, [nums]);
  const found = new Set(r.rows.map((x) => x.number));
  const missing = nums.filter((n) => !found.has(n));
  if (missing.length) fail(`Unknown item number(s): ${missing.join(", ")}`);
  return r.rows.map((x) => x.uid);
}

async function numbersFor(uids) {
  if (!uids?.length) return null;
  const r = await pool.query(`SELECT number FROM myob_items WHERE uid = ANY($1) ORDER BY number`, [uids]);
  return r.rows.map((x) => x.number).join(",");
}

async function restore() {
  const suffixes = SCOPES[target];
  if (!suffixes) fail("restore needs: suppliers | cart | all");
  const name = safeName(opt("from") ?? DEFAULT_BACKUP);
  const b = await requireBackup(name);
  const items = await uidsForNumbers(opt("items"));

  console.log(`Database ${dbName} on ${host}`);
  console.log(`Restore ${target} to backup ${name} (taken ${b.taken_at.toISOString()}) for ${items ? `${items.length} item(s)` : "EVERY item"}.`);
  if (target !== "cart") {
    const rows = await preferredDiff(name, items);
    console.log(`Preferred supplier / ruling that would change: ${rows.length} item(s)`);
    for (const r of rows)
      console.log(`  ${r.number ?? r.item_uid}\tnow ${label(r.now_uid, r.now_name, r.now_ruled)}\t→ back to ${label(r.then_uid, r.then_name, r.then_ruled)}`);
  }
  for (const d of await rowDiff(name, suffixes, items))
    console.log(`  ${TABLES[d.suffix]}: ${d.deleted} row(s) would be removed or changed, ${d.inserted} put back, across ${d.items.length} item(s)`);
  const outside = await changedOutsideLog(b.taken_at, items);
  if (outside.length)
    console.log(`WARNING: ${outside.length} item(s) changed since this backup with no change-log entry; a restore reverts them and only the pre_restore copy will hold them${numbers(outside)}`);
  if (!mayWrite()) {
    console.log(`Dry run. Nothing changed. Add --apply --confirm ${dbName} to restore.`);
    return;
  }
  const saved = await inTx(async (client) => {
    const copy = await freeName(client, `pre_restore_${stamp()}`);
    await takeSnapshot(client, copy, `Taken before restoring ${target} from ${name}`);
    const filter = items ? `WHERE item_uid = ANY($1)` : "";
    const params = items ? [items] : [];
    for (const suffix of suffixes) {
      const table = TABLES[suffix];
      // Columns both tables have; any newer live column takes its default.
      const copyCols = new Set(await columnsOf(client, copyName(name, suffix)));
      const liveCols = await columnsOf(client, table);
      const cols = quoteCols(liveCols.filter((c) => copyCols.has(c)));
      const defaulted = liveCols.filter((c) => !copyCols.has(c));
      if (defaulted.length) console.log(`  ${table}: ${defaulted.join(", ")} not in the backup; left to defaults`);
      await client.query(`DELETE FROM ${table} ${filter}`, params);
      await client.query(`INSERT INTO ${table} (${cols}) SELECT ${cols} FROM ${copyName(name, suffix)} ${filter}`, params);
    }
    await client.query(
      `INSERT INTO platform_change_log (entity, item_uid, action, detail, changed_by)
       VALUES ('restore', NULL, 'restore', $1, 'supplier-rollback.mjs')`,
      [JSON.stringify({ scope: target, from: name, items, savedAs: copy })],
    );
    return copy;
  });
  console.log(`Restored. What it replaced is saved as backup ${saved}. To reverse (dry run first):`);
  console.log(`  node scripts/supplier-rollback.mjs restore ${target} --from ${saved}${opt("items") ? ` --items ${opt("items")}` : ""}`);
  console.log("The app's cached item list refreshes within 30 seconds.");
}

async function showLog() {
  const items = await uidsForNumbers(opt("item"));
  const limit = Number(opt("limit") ?? 50);
  if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a whole number.");
  const r = await pool.query(
    `SELECT l.id, l.changed_at, l.entity, l.action, it.number, l.detail
     FROM platform_change_log l LEFT JOIN myob_items it ON it.uid = l.item_uid
     WHERE $2::text[] IS NULL OR l.item_uid = ANY($2)
        OR (l.item_uid IS NULL AND (l.detail->'items' IS NULL OR jsonb_typeof(l.detail->'items') = 'null'
            OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(l.detail->'items') u WHERE u = ANY($2))))
     ORDER BY l.id DESC LIMIT $1`,
    [limit, items],
  );
  for (const x of r.rows)
    console.log(`#${x.id}\t${x.changed_at.toISOString()}\t${x.entity}\t${x.action}\t${x.number ?? "(all)"}\t${JSON.stringify(x.detail)}`);
}

/* ---------- undo one logged change ---------- */

async function supplierStateNow(client, itemUid) {
  const s = await client.query(
    `SELECT supplier_uid, is_preferred, supplier_item_number, notes
     FROM platform_item_suppliers WHERE item_uid = $1 ORDER BY supplier_uid`,
    [itemUid],
  );
  const n = await client.query(`SELECT reason, set_by, set_at FROM platform_item_no_supplier WHERE item_uid = $1`, [itemUid]);
  return {
    suppliers: s.rows,
    ruledNone: n.rows[0] ? { ...n.rows[0], set_at: n.rows[0].set_at.toISOString() } : null,
  };
}

async function writeSupplierState(client, itemUid, state) {
  await client.query(`DELETE FROM platform_item_suppliers WHERE item_uid = $1`, [itemUid]);
  await client.query(`DELETE FROM platform_item_no_supplier WHERE item_uid = $1`, [itemUid]);
  for (const s of state.suppliers)
    await client.query(
      `INSERT INTO platform_item_suppliers (item_uid, supplier_uid, is_preferred, supplier_item_number, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [itemUid, s.supplier_uid, s.is_preferred, s.supplier_item_number, s.notes],
    );
  if (state.ruledNone)
    await client.query(`INSERT INTO platform_item_no_supplier (item_uid, reason, set_by, set_at) VALUES ($1, $2, $3, $4)`, [
      itemUid, state.ruledNone.reason, state.ruledNone.set_by, state.ruledNone.set_at,
    ]);
}

/** Cart state of one item, or of every item when itemUid is null — the shapes changeLog.ts logs. */
async function cartStateNow(client, itemUid) {
  const f = itemUid ? "WHERE item_uid = $1" : "";
  const p = itemUid ? [itemUid] : [];
  const rows = (await client.query(`SELECT * FROM platform_purchase_cart ${f} ORDER BY item_uid, supplier_uid`, p)).rows;
  const acks = (await client.query(`SELECT item_uid, preferred_supplier_uid, acked_at FROM platform_cart_pick_ack ${f} ORDER BY item_uid`, p)).rows;
  const off = (await client.query(`SELECT item_uid, taken_off_at FROM platform_cart_item_off ${f} ORDER BY item_uid`, p)).rows;
  return itemUid
    ? {
        rows,
        ack: acks[0] ? { preferred_supplier_uid: acks[0].preferred_supplier_uid, acked_at: acks[0].acked_at } : null,
        takenOff: off.length > 0,
        takenOffAt: off[0]?.taken_off_at ?? null,
      }
    : { rows, acks, takenOff: off.map((o) => o.item_uid), takenOffAt: Object.fromEntries(off.map((o) => [o.item_uid, o.taken_off_at])) };
}

/** Either shape reduced to the decisions themselves, sorted, without timestamps. */
function cartEssence(state, itemUid) {
  const rows = (state?.rows ?? [])
    .map(({ item_uid, supplier_uid, qty, state: st, note }) => ({ item_uid, supplier_uid, qty, state: st, note }))
    .sort((a, b) => `${a.item_uid}|${a.supplier_uid}`.localeCompare(`${b.item_uid}|${b.supplier_uid}`));
  const acks = (itemUid
    ? state?.ack ? [{ item_uid: itemUid, preferred_supplier_uid: state.ack.preferred_supplier_uid, acked_at: state.ack.acked_at }] : []
    : (state?.acks ?? []).map(({ item_uid, preferred_supplier_uid, acked_at }) => ({ item_uid, preferred_supplier_uid, acked_at }))
  ).sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  const offAt = itemUid ? { [itemUid]: state?.takenOffAt ?? null } : (state?.takenOffAt ?? {});
  const off = (itemUid ? (state?.takenOff ? [itemUid] : []) : (state?.takenOff ?? []))
    .map((u) => ({ item_uid: u, taken_off_at: offAt[u] ?? null }))
    .sort((a, b) => a.item_uid.localeCompare(b.item_uid));
  return { rows, acks, off };
}
const decisionsOnly = (e) => ({
  rows: e.rows,
  acks: e.acks.map(({ item_uid, preferred_supplier_uid }) => ({ item_uid, preferred_supplier_uid })),
  off: e.off.map(({ item_uid }) => item_uid),
});

/** Write one item's (or, with itemUid null, these items') cart state back exactly. */
async function writeCartState(client, itemUid, state, onlyItems = null) {
  const e = cartEssence(state, itemUid);
  const scope = itemUid ? [itemUid] : onlyItems;
  const f = scope ? "WHERE item_uid = ANY($1)" : "";
  const p = scope ? [scope] : [];
  const keep = (u) => !scope || scope.includes(u);
  await client.query(`DELETE FROM platform_purchase_cart ${f}`, p);
  await client.query(`DELETE FROM platform_cart_pick_ack ${f}`, p);
  await client.query(`DELETE FROM platform_cart_item_off ${f}`, p);
  for (const r of (state.rows ?? []).filter((x) => keep(x.item_uid)))
    await client.query(
      `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, qty, state, note, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()))`,
      [r.item_uid, r.supplier_uid, r.qty, r.state, r.note, r.updated_by, r.updated_at],
    );
  for (const a of e.acks.filter((x) => keep(x.item_uid)))
    await client.query(
      `INSERT INTO platform_cart_pick_ack (item_uid, preferred_supplier_uid, acked_at) VALUES ($1, $2, COALESCE($3, NOW()))`,
      [a.item_uid, a.preferred_supplier_uid, a.acked_at],
    );
  for (const o of e.off.filter((x) => keep(x.item_uid)))
    await client.query(
      `INSERT INTO platform_cart_item_off (item_uid, taken_off_at, updated_by) VALUES ($1, COALESCE($2, NOW()), 'supplier-rollback.mjs')`,
      [o.item_uid, o.taken_off_at],
    );
}

/** Later log entries that touch the same item (or anything, for an every-item entry). */
async function laterChanges(client, entry) {
  const r = await client.query(
    `SELECT id, action, item_uid FROM platform_change_log
     WHERE id > $1
       AND (entity = $2 OR entity = 'restore')
       AND ($3::text IS NULL OR item_uid = $3 OR item_uid IS NULL)
     ORDER BY id`,
    [entry.id, entry.entity, entry.item_uid],
  );
  return r.rows;
}

async function undo() {
  const id = Number(target);
  if (!Number.isInteger(id)) fail("undo needs a change id (see `log`).");
  const entry = (await pool.query(`SELECT * FROM platform_change_log WHERE id = $1`, [id])).rows[0];
  if (!entry) fail(`No change #${id}.`);
  console.log(`Database ${dbName} on ${host}`);
  console.log(`Change #${id}: ${entry.entity} ${entry.action} on ${entry.item_uid ?? "every item"} at ${entry.changed_at.toISOString()}`);

  if (entry.entity === "restore") {
    const nums = await numbersFor(entry.detail?.items);
    fail(
      `#${id} was a restore. To reverse it, restore from the copy it saved (dry run first):\n` +
        `  node scripts/supplier-rollback.mjs restore ${entry.detail?.scope ?? "all"} --from ${entry.detail?.savedAs ?? "<pre_restore name>"}${nums ? ` --items ${nums}` : ""}`,
    );
  }
  // Lead times and minimums (1.1) are logged for the record only. This script
  // writes back supplier and cart state and nothing else, so it says what to
  // re-enter instead of guessing at a write it was never built for.
  if (["supplier_meta", "item_lead_time", "min_stock"].includes(entry.entity))
    fail(
      `#${id} is a lead-time or minimum edit (${entry.entity}). It is logged for the record only: undo puts back supplier and cart decisions, nothing else.\n` +
        `To put it back, re-enter the "before" figures in the dashboard:\n  ${JSON.stringify(entry.before)}`,
    );
  if (entry.action === "apply_suggestions") return undoSuggestions(entry);
  if (entry.before == null || entry.after == null) fail(`#${id} has no before/after state recorded, so it cannot be undone by itself.`);
  if (!["item_supplier", "cart"].includes(entry.entity)) fail(`Unknown entity ${entry.entity}.`);

  const write = mayWrite();
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const whole = entry.entity === "cart" && !entry.item_uid;
    const now = entry.entity === "item_supplier" ? await supplierStateNow(client, entry.item_uid) : await cartStateNow(client, entry.item_uid);
    const same = entry.entity === "item_supplier"
      ? canon(now) === canon(entry.after)
      : canon(decisionsOnly(cartEssence(now, entry.item_uid))) === canon(decisionsOnly(cartEssence(entry.after, entry.item_uid)));
    const later = same ? [] : await laterChanges(client, entry);

    /*
     * Undoing "Start again" after newer decisions: by default only the items
     * nobody has touched since are put back, and the rest are listed. --force
     * puts back everything and discards the newer decisions (they stay logged).
     */
    let onlyItems = null;
    if (!same && whole && !flag("force")) {
      if (later.some((l) => !l.item_uid)) fail(`A later change covers every item (${later.filter((l) => !l.item_uid).map((l) => `#${l.id} ${l.action}`).join(", ")}); add --force to put #${id}'s state back anyway.`);
      const touched = new Set(later.map((l) => l.item_uid));
      const all = new Set([...(entry.before.rows ?? []).map((r) => r.item_uid), ...(entry.before.acks ?? []).map((a) => a.item_uid), ...(entry.before.takenOff ?? [])]);
      onlyItems = [...all].filter((u) => !touched.has(u));
      console.log(`Putting back ${onlyItems.length} item(s) untouched since #${id}; leaving ${touched.size} changed since (${[...touched].slice(0, 20).join(", ")}). --force puts back all.`);
    } else if (!same && !flag("force")) {
      fail(`Changed again since #${id}${later.length ? ` (${later.map((l) => `#${l.id} ${l.action}`).join(", ")})` : ""}. --force puts the #${id} "before" state back and DISCARDS those later decisions (they stay in the log).`);
    } else if (!same) {
      console.log(`--force: discarding later decisions ${later.map((l) => `#${l.id} ${l.action}`).join(", ") || "(none logged)"}`);
    }
    if (!whole) {
      console.log(`Now:     ${canon(entry.entity === "cart" ? decisionsOnly(cartEssence(now, entry.item_uid)) : now)}`);
      console.log(`Back to: ${canon(entry.entity === "cart" ? decisionsOnly(cartEssence(entry.before, entry.item_uid)) : entry.before)}`);
    }
    if (!write) {
      await client.query("ROLLBACK");
      console.log(`Dry run. Nothing changed. Add --apply --confirm ${dbName} to undo.`);
      return;
    }
    let savedAs = null;
    if (whole) {
      savedAs = await freeName(client, `pre_undo_${stamp()}`);
      await takeSnapshot(client, savedAs, `Taken before undoing change #${id}`);
    }
    if (entry.entity === "item_supplier") await writeSupplierState(client, entry.item_uid, entry.before);
    else await writeCartState(client, entry.item_uid, entry.before, onlyItems);
    const after = entry.entity === "item_supplier" ? await supplierStateNow(client, entry.item_uid) : await cartStateNow(client, entry.item_uid);
    // Logged with before/after like any change, so this undo can be undone too.
    await client.query(
      `INSERT INTO platform_change_log (entity, item_uid, action, before, after, detail, changed_by)
       VALUES ($1, $2, 'undo_change', $3, $4, $5, 'supplier-rollback.mjs')`,
      [entry.entity, entry.item_uid, JSON.stringify(now), JSON.stringify(after), JSON.stringify({ undid: id, forced: !same && flag("force"), onlyItems, savedAs })],
    );
    await client.query("COMMIT");
    console.log(`Change #${id} undone.${savedAs ? ` The cart it replaced is saved as backup ${savedAs}.` : ""}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Take a bulk seed back out: only rows it inserted that nobody has touched
 * since — same flag and seed note, not updated after the seed, and no later
 * logged change to the item. Each item's removal is logged with before/after.
 */
async function undoSuggestions(entry) {
  const inserted = entry.detail?.inserted ?? [];
  const write = mayWrite();
  await inTx(async (client) => {
    const untouched = [];
    const skipped = [];
    for (const row of inserted) {
      const cur = (await client.query(
        `SELECT is_preferred, notes, updated_at FROM platform_item_suppliers WHERE item_uid = $1 AND supplier_uid = $2 FOR UPDATE`,
        [row.item_uid, row.supplier_uid],
      )).rows[0];
      const later = (await client.query(
        `SELECT 1 FROM platform_change_log WHERE id > $1 AND entity = 'item_supplier' AND item_uid = $2 LIMIT 1`,
        [entry.id, row.item_uid],
      )).rows.length;
      const clean = cur && !later && cur.is_preferred === row.is_preferred
        && String(cur.notes ?? "").startsWith("Suggested from purchase history")
        && new Date(cur.updated_at) <= new Date(entry.changed_at);
      (clean ? untouched : skipped).push(row);
    }
    console.log(`${untouched.length} seeded row(s) untouched since #${entry.id}; ${skipped.length} changed, confirmed or gone (left alone).`);
    if (!write) {
      console.log(`Dry run. Nothing changed. Add --apply --confirm ${dbName} to remove the untouched rows.`);
      return;
    }
    const savedAs = await freeName(client, `pre_undo_${stamp()}`);
    await takeSnapshot(client, savedAs, `Taken before undoing change #${entry.id}`);
    for (const item of [...new Set(untouched.map((r) => r.item_uid))]) {
      const before = await supplierStateNow(client, item);
      for (const row of untouched.filter((r) => r.item_uid === item))
        await client.query(`DELETE FROM platform_item_suppliers WHERE item_uid = $1 AND supplier_uid = $2`, [row.item_uid, row.supplier_uid]);
      await client.query(
        `INSERT INTO platform_change_log (entity, item_uid, action, before, after, detail, changed_by)
         VALUES ('item_supplier', $1, 'undo_change', $2, $3, $4, 'supplier-rollback.mjs')`,
        [item, JSON.stringify(before), JSON.stringify(await supplierStateNow(client, item)), JSON.stringify({ undid: entry.id, savedAs })],
      );
    }
    console.log(`Removed ${untouched.length} row(s). The state before is saved as backup ${savedAs}.`);
  });
}

/**
 * Before rolling the CODE back to the previous release: that release does not
 * know "taken off this order" markers and would put those items back on the
 * order. This strikes, the way it understands, every supplier currently on
 * file for each taken-off item that has no saved decision on it. Items with a
 * chosen supplier, split or typed quantity are listed instead — the previous
 * release would show those under that supplier whatever is struck. The
 * markers stay, so redeploying this release behaves as before.
 */
async function prepareMainRollback() {
  console.log(`Database ${dbName} on ${host}`);
  const r = await pool.query(
    `WITH off AS (SELECT item_uid FROM platform_cart_item_off),
          opts AS (
            SELECT ps.item_uid, ps.supplier_uid FROM platform_item_suppliers ps JOIN off USING (item_uid)
            UNION SELECT i.uid, i.primary_supplier_uid FROM myob_items i JOIN off ON off.item_uid = i.uid WHERE i.primary_supplier_uid IS NOT NULL
            UNION (SELECT DISTINCT ON (l.item_uid) l.item_uid, b.supplier_uid
                   FROM myob_purchase_bill_lines l JOIN myob_purchase_bills b ON b.uid = l.bill_uid JOIN off ON off.item_uid = l.item_uid
                   WHERE b.supplier_uid IS NOT NULL
                   GROUP BY l.item_uid, b.supplier_uid ORDER BY l.item_uid, SUM(COALESCE(l.total, 0)) DESC)
          )
     SELECT o.item_uid, it.number, o.supplier_uid, c.state
     FROM opts o LEFT JOIN platform_purchase_cart c ON c.item_uid = o.item_uid AND c.supplier_uid = o.supplier_uid
     LEFT JOIN myob_items it ON it.uid = o.item_uid
     ORDER BY it.number, o.supplier_uid`,
  );
  const decided = new Set(r.rows.filter((x) => x.state && x.state !== "removed").map((x) => x.item_uid));
  const toStrike = r.rows.filter((x) => !x.state && !decided.has(x.item_uid));
  const items = [...new Set(r.rows.map((x) => x.item_uid))];
  console.log(`${items.length} item(s) taken off this order; ${toStrike.length} supplier line(s) to strike for the previous release.`);
  if (decided.size)
    console.log(`${decided.size} item(s) keep a chosen/split/typed decision and would still show under the previous release: ${[...new Set(r.rows.filter((x) => decided.has(x.item_uid)).map((x) => x.number))].join(", ")}`);
  if (!mayWrite()) {
    console.log(`Dry run. Nothing changed. Add --apply --confirm ${dbName}.`);
    return;
  }
  await inTx(async (client) => {
    const savedAs = await freeName(client, `pre_main_rollback_${stamp()}`);
    await takeSnapshot(client, savedAs, "Taken before striking taken-off items for the previous release");
    for (const item of [...new Set(toStrike.map((x) => x.item_uid))]) {
      const before = await cartStateNow(client, item);
      for (const x of toStrike.filter((y) => y.item_uid === item))
        await client.query(
          `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, state, updated_by, updated_at)
           VALUES ($1, $2, 'removed', 'supplier-rollback.mjs', NOW()) ON CONFLICT DO NOTHING`,
          [x.item_uid, x.supplier_uid],
        );
      await client.query(
        `INSERT INTO platform_change_log (entity, item_uid, action, before, after, detail, changed_by)
         VALUES ('cart', $1, 'prepare_main_rollback', $2, $3, $4, 'supplier-rollback.mjs')`,
        [item, JSON.stringify(before), JSON.stringify(await cartStateNow(client, item)), JSON.stringify({ savedAs })],
      );
    }
    console.log(`Done. The state before is saved as backup ${savedAs}.`);
  });
}

const commands = { status, diff, snapshot, restore, log: showLog, undo, "prepare-main-rollback": prepareMainRollback };
try {
  dbName = (await pool.query(`SELECT current_database() AS db`)).rows[0].db;
  await commands[command]();
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
