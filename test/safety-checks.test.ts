/**
 * Safety checks (1.1): the proposed on-order rule's fragments, the "On order
 * vs MYOB" list, the end-of-sync below-MYOB warning, the position parity
 * check, and the lead-time and minimum edit log. Run with `npm test`.
 *
 * The figures are the 26 Aug local copy's: our On order 1,052,943, MYOB's
 * 858,820, the proposed rule 858,796. The 24 between the last two are
 * AFLSA390/490, 12 each on a PO from before the sync floor.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KNOWN_PRE_FLOOR,
  OPEN_PO_DOC,
  OUTSTANDING,
  OUTSTANDING_LINE,
  PO_BILLED_ON_OR_AFTER,
  onOrderBelowMyob,
  onOrderCheck,
  openDocReason,
  type OnOrderCompareRow,
} from "../src/sync/openPo.js";
import { positionParity, type ParityRow } from "../src/insights/ledger.js";
import { logChange } from "../src/insights/changeLog.js";
import { release } from "../src/release.js";
// @ts-ignore — ops script, no types
import { diffCaptures, loadAllow } from "../scripts/stage-check.mjs";

const row = (number: string, ours: number, myob: number | null, proposed: number): OnOrderCompareRow => ({
  uid: `uid-${number}`,
  number,
  name: null,
  ours,
  myob,
  proposed,
});

/** What onOrderComparison returns on the 26 Aug copy (psql, read-only). */
const LOCAL_26_AUG = [
  row("AFLSA390", 0, 12, 0),
  row("AFLSA490", 0, 12, 0),
  row("BN16110G", 5285, 2000, 2000),
  row("BP1675G", 34600, 11000, 11000),
  row("BP1690G", 3135, 3000, 3000),
  row("SPW12G", 15560, 15000, 15000),
  row("WQ16806G", 53670, 0, 0),
  row("WSBT450G", 112897, 0, 0),
];

/* ---------- the shared SQL fragments ---------- */

test("OPEN_PO_DOC and OUTSTANDING carry the rule, on the alias given", () => {
  const doc = OPEN_PO_DOC("po");
  assert.match(doc, /UPPER\(COALESCE\(po\.status, ''\)\) = 'OPEN'/);
  assert.match(doc, /COALESCE\(po\.total, 0\) >= 0/);
  // The bill test: same number, same supplier, dated on or after the PO.
  assert.match(doc, /NOT EXISTS \(SELECT 1 FROM myob_purchase_bills open_po_bill/);
  assert.match(doc, /open_po_bill\.number = po\.number/);
  assert.match(doc, /open_po_bill\.supplier_uid = po\.supplier_uid/);
  assert.match(doc, /open_po_bill\.date::date >= po\.date::date/);
  assert.equal(
    OUTSTANDING("l"),
    "(l.qty - LEAST(GREATEST(COALESCE(l.received_qty, 0), 0), l.qty))",
  );
  assert.equal(OUTSTANDING_LINE("l"), "(l.item_uid IS NOT NULL AND l.qty > 0)");
  // Anything but a bare alias is refused, so a fragment can never carry SQL in.
  for (const bad of ["o; DROP TABLE x", "o.status", "", "1o"]) {
    assert.throws(() => OPEN_PO_DOC(bad), /Not a SQL alias/);
    assert.throws(() => OUTSTANDING(bad), /Not a SQL alias/);
  }
});

test("the bill test has one copy: OPEN_PO_DOC negates it and the Open purchase orders list reuses it", () => {
  assert.ok(OPEN_PO_DOC("o").includes(`NOT ${PO_BILLED_ON_OR_AFTER("o")}`));
  assert.throws(() => PO_BILLED_ON_OR_AFTER("o.number"), /Not a SQL alias/);
  // Counted and its reason come from the same fragment, so they cannot
  // disagree: no hand-written bill test may sit beside OPEN_PO_DOC.
  const ledger = readFileSync(new URL("../src/insights/ledger.ts", import.meta.url), "utf8");
  const docs = ledger.slice(ledger.indexOf("async function openPurchaseDocs"));
  const body = docs.slice(0, docs.indexOf("\n}\n"));
  assert.match(body, /\$\{OPEN_PO_DOC\("o"\)\} AS counted/);
  assert.match(body, /\$\{PO_BILLED_ON_OR_AFTER\("o"\)\} AS billed/);
  assert.doesNotMatch(body, /myob_purchase_bills/);
  // Today's figure is reported beside the proposed one (outstandingToday).
  assert.match(body, /outstandingToday: Number\(x\.outstanding_today\)/);
});

test("the line clamp: received below 0 or above ordered can't make a line negative or inflate it", () => {
  // The SQL expression, evaluated the same way in JS.
  const outstanding = (qty: number, received: number | null) =>
    qty - Math.min(Math.max(received ?? 0, 0), qty);
  assert.equal(outstanding(10982, 7697), 3285); // BN16110G on 00019910
  assert.equal(outstanding(100, null), 100);
  assert.equal(outstanding(100, -5), 100);
  assert.equal(outstanding(100, 140), 0);
});

/* ---------- On order vs MYOB ---------- */

test("On order vs MYOB on the 26 Aug copy: six reversal items match MYOB under the proposed rule, AFLSA390/490 known", () => {
  const check = onOrderCheck([...LOCAL_26_AUG].reverse());
  assert.equal(check.diverging, 8);
  assert.deepEqual(
    check.rows.map((r) => r.number),
    ["AFLSA390", "AFLSA490", "BN16110G", "BP1675G", "BP1690G", "SPW12G", "WQ16806G", "WSBT450G"],
  );
  const matching = check.rows.filter((r) => r.proposedMatchesMyob && !r.known).map((r) => r.number);
  assert.deepEqual(matching, ["BN16110G", "BP1675G", "BP1690G", "SPW12G", "WQ16806G", "WSBT450G"]);
  const known = check.rows.filter((r) => r.known);
  assert.deepEqual(known.map((r) => r.number), ["AFLSA390", "AFLSA490"]);
  assert.equal(known[0].known, "PO older than the sync floor");
  assert.equal(known[0].proposedMatchesMyob, false);
  // The totals the plan quotes: 1,052,943 ours on the whole file, of which
  // these rows carry the 194,147 the proposed rule removes.
  const removed = LOCAL_26_AUG.reduce((a, r) => a + r.ours - r.proposed, 0);
  assert.equal(removed, 194_147);
});

test("On order vs MYOB lists an item where only the proposed rule would differ, and never one where all three agree", () => {
  const check = onOrderCheck([
    row("AGREE", 500, 500, 500),
    // Fine today, but Stage 2 would hide it: exactly what the preview is for.
    row("BACKORDER", 800, 800, 300),
    row("NOMYOB", 0, null, 0),
  ]);
  assert.deepEqual(check.rows.map((r) => r.number), ["BACKORDER"]);
  assert.equal(check.rows[0].proposedMatchesMyob, false);
  assert.equal(check.rows[0].known, null);
});

/* ---------- the end-of-sync warning ---------- */

test("below MYOB: today's phantom items read ABOVE MYOB, so nothing is reported on the 26 Aug copy", () => {
  assert.deepEqual(onOrderBelowMyob(LOCAL_26_AUG), []);
  assert.deepEqual([...KNOWN_PRE_FLOOR], ["AFLSA390", "AFLSA490"]);
});

test("below MYOB: hidden incoming is reported, sorted; known pre-floor items and rounding are not", () => {
  const rows = [
    { number: "WSBT450G", ours: 0, myob: 0 },
    { number: "SPW12G", ours: 14000, myob: 15000 }, // a bill hid 1,000 coming units
    { number: "BN16110G", ours: 0, myob: 2000 },
    { number: "AFLSA390", ours: 0, myob: 12 },
    { number: "ROUND", ours: 9.9995, myob: 10 },
    { number: "NULLMYOB", ours: 0, myob: null },
  ];
  assert.deepEqual(onOrderBelowMyob(rows), ["BN16110G", "SPW12G"]);
  // The known list is a parameter, so the tidy-up answer can empty it.
  assert.deepEqual(onOrderBelowMyob(rows, []), ["AFLSA390", "BN16110G", "SPW12G"]);
});

test("the end-of-sync stat sits in its own try/catch after the snapshot, so it can never fail a sync", () => {
  const engine = readFileSync(new URL("../src/sync/engine.ts", import.meta.url), "utf8");
  const snap = engine.indexOf("stats.position_snapshot = await snapshotPositions()");
  const stat = engine.indexOf("stats.on_order_below_myob = await onOrderBelowMyobNow()");
  const success = engine.indexOf("SET status = 'success'");
  assert.ok(snap > 0 && stat > snap && success > stat, "stat runs after the snapshot and before success is written");
  const block = engine.slice(engine.lastIndexOf("try {", stat), engine.indexOf("}", engine.indexOf("catch (err)", stat)) + 1);
  assert.match(block, /^try \{\s+stats\.on_order_below_myob = await onOrderBelowMyobNow\(\);\s+\} catch \(err\) \{\s+stats\.on_order_below_myob_error =/);
  assert.doesNotMatch(block, /throw/);
});

/* ---------- open documents ---------- */

test("open documents: a negative total reads as a reversal even when billed; billed reads as billed", () => {
  // 00020624 (Steelgal): the negative half also has a same-number bill.
  assert.equal(openDocReason({ total: -1809.64, billedOnOrAfter: true }), "negative_total");
  assert.equal(openDocReason({ total: 1809.64, billedOnOrAfter: true }), "billed");
  assert.equal(openDocReason({ total: -121080.53, billedOnOrAfter: false }), "negative_total"); // 00020462
  assert.equal(openDocReason({ total: 121080.53, billedOnOrAfter: true }), "billed"); // 00019910
  assert.equal(openDocReason({ total: 130258.25, billedOnOrAfter: false }), "counted"); // 00023070
  assert.equal(openDocReason({ total: null, billedOnOrAfter: false }), "counted");
  assert.equal(openDocReason({ total: 0, billedOnOrAfter: false }), "counted");
});

/* ---------- position parity ---------- */

const pos = (uid: string, onHand: number | null, committed = 0, onOrder = 0): ParityRow => ({
  uid,
  number: uid.toUpperCase(),
  onHand,
  committed,
  onOrder,
});

test("position parity: identical figures read 0; nulls must agree; each differing item counts once", () => {
  assert.deepEqual(positionParity([pos("a", 5, 1, 2), pos("b", null)], [pos("b", null), pos("a", 5.0004, 1, 2)]), {
    mismatches: 0,
    sample: [],
  });
  const r = positionParity(
    [pos("a", 5, 1, 2), pos("b", null), pos("c", 3, 0, 100), pos("d", 1)],
    [pos("a", 5, 1, 2), pos("b", 0), pos("c", 4, 0, 90)],
  );
  assert.equal(r.mismatches, 3);
  assert.deepEqual(
    r.sample.map((x) => `${x.number} ${x.field}`),
    ["B onHand", "C onHand", "C onOrder", "D missing"],
  );
  const many = Array.from({ length: 30 }, (_, i) => pos(`x${i}`, i));
  assert.equal(positionParity(many, many.map((p) => ({ ...p, onHand: (p.onHand ?? 0) + 1 }))).sample.length, 10);
});

/* ---------- the edit log ---------- */

test("lead-time and minimum edits log with before/after and the release that wrote them", async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const fake = { query: async (text: string, params: unknown[]) => (calls.push({ text, params }), { rows: [] }) };
  const before = [{ item_uid: "U1", min_level: 2771, basis: "window", window_months: 6, lead_time_days: 120 }];
  const after = [{ item_uid: "U1", min_level: 1916, basis: "window", window_months: 6, lead_time_days: 83 }];
  for (const entity of ["supplier_meta", "item_lead_time", "min_stock"] as const) {
    await logChange(fake as never, { entity, itemUid: "U1", action: "recalculate", before, after, changedBy: "dashboard" });
  }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.params[0]), ["supplier_meta", "item_lead_time", "min_stock"]);
  for (const c of calls) {
    assert.match(c.text, /INSERT INTO platform_change_log/);
    assert.deepEqual(JSON.parse(c.params[3] as string), before);
    assert.deepEqual(JSON.parse(c.params[4] as string), after);
    assert.deepEqual(JSON.parse(c.params[5] as string), { release: release.version, commit: release.commit });
  }
});

test("every lead-time and minimum write is logged inside the transaction that makes it", () => {
  const src = readFileSync(new URL("../src/insights/minStock.ts", import.meta.url), "utf8");
  // No write to either table through the pool directly any more.
  assert.doesNotMatch(src, /getPool\(\)\.query\(\s*`(INSERT INTO|DELETE FROM) platform_(min_stock|item_lead_time)/);
  for (const fn of [
    "applyWindowMinimum", "setManualMinimum", "clearMinimum", "applyWindowToView",
    "recalculateWindowMinimums", "refreshWindowMinimums", "setItemLeadTime",
    "clearItemLeadTime", "applyLeadTimeToView",
  ]) {
    const start = src.search(new RegExp(`function ${fn}\\(`));
    assert.ok(start > 0, `${fn} exists`);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(body, /inTransaction\(getPool\(\), async \(client\) =>/, `${fn} writes in a transaction`);
    assert.match(body, /logItems\(client, "(min_stock|item_lead_time)"/, `${fn} logs on the same client`);
  }
  const queries = readFileSync(new URL("../src/insights/queries.ts", import.meta.url), "utf8");
  const meta = queries.slice(queries.indexOf("export async function setSupplierMeta("));
  const metaBody = meta.slice(0, meta.indexOf("\n}\n"));
  assert.match(metaBody, /inTransaction\(pool, async \(client\) =>[\s\S]*INSERT INTO platform_supplier_meta[\s\S]*entity: "supplier_meta"/);
});

test("supplier-rollback: undo refuses lead-time and minimum rows, and only ever writes supplier or cart state", () => {
  const script = readFileSync(new URL("../scripts/supplier-rollback.mjs", import.meta.url), "utf8");
  const undo = script.slice(script.indexOf("async function undo()"), script.indexOf("async function undoSuggestions("));
  const refuse = undo.indexOf('["supplier_meta", "item_lead_time", "min_stock"].includes(entry.entity)');
  assert.ok(refuse > 0, "the three new entities are refused by name");
  assert.match(undo.slice(refuse, refuse + 300), /fail\(/);
  // Refused before anything can write: before mayWrite() and before any BEGIN.
  assert.ok(refuse < undo.indexOf("mayWrite()") && refuse < undo.indexOf("BEGIN"));
  // The generic filter is unchanged: anything else unknown is refused too.
  assert.match(undo, /if \(!\["item_supplier", "cart"\]\.includes\(entry\.entity\)\) fail\(`Unknown entity/);
});

/* ---------- the 1.1 allow-list ---------- */

test("diff --allow 1.1.0: the new divergence fields pass; any figure moving elsewhere fails", () => {
  const writeCapture = (files: Record<string, unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), "stage-1-"));
    mkdirSync(join(dir, "items"), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(body));
    return dir;
  };
  const before = writeCapture({
    "divergence.json": { onHandDiverging: 1, items: [{ number: "A", divergence: 1 }] },
    "sync-status.json": { release: { version: "1.0.0", commit: "a07b495" } },
    "items.json": { items: [{ uid: "a", qtyOnOrder: 112897 }] },
  });
  const after = writeCapture({
    "divergence.json": {
      onHandDiverging: 1,
      items: [{ number: "A", divergence: 1 }],
      onOrder: { rows: [{ uid: "a", number: "WSBT450G", ours: 112897, myob: 0, proposed: 0 }], diverging: 1 },
      openDocs: [{ uid: "p", number: "00022808", counted: false, reason: "negative_total" }],
      positionParity: { mismatches: 0, sample: [] },
    },
    "sync-status.json": { release: { version: "1.1.0", commit: "b000000" } },
    "items.json": { items: [{ uid: "a", qtyOnOrder: 0 }] },
  });
  try {
    const allow = loadAllow(new URL("../scripts/expected/1.1.0.json", import.meta.url));
    const { changes } = diffCaptures(before, after, allow);
    assert.deepEqual(
      changes.map((c: { file: string; path: string; allowed: boolean }) => [`${c.file} ${c.path}`, c.allowed]).sort(),
      [
        ["divergence.json onOrder", true],
        ["divergence.json openDocs", true],
        ["divergence.json positionParity", true],
        ["items.json items[a].qtyOnOrder", false],
        ["sync-status.json release.commit", true],
        ["sync-status.json release.version", true],
      ],
    );
  } finally {
    for (const d of [before, after]) rmSync(d, { recursive: true, force: true });
  }
});
