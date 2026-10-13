#!/usr/bin/env node
/**
 * Golden capture and diff: proof that a release moved only what it said (1.0).
 *
 * Every release in the rollout either moves no figure at all (a UI release) or
 * moves a named few (a numbers release). Saying so is not evidence. This takes
 * a full read-only snapshot of what the dashboard serves — every item, the
 * Overview, the Order list and both its exports, suppliers, divergence, kits,
 * sync status, the item pages of a fixed watch-list and the kit pages around
 * them — before and after a deploy, and fails on any difference the release
 * did not list in advance.
 *
 *   DASHBOARD_KEY=… node scripts/stage-check.mjs capture <dir> [--base local|prod|URL]
 *   node scripts/stage-check.mjs diff <before> <after> [--allow scripts/expected/<version>.json]
 *   node scripts/stage-check.mjs expect <before> <after> [--stage "…"]   (1.2: generate an allow-list)
 *
 * SAFE BY CONSTRUCTION. It sends GET requests and nothing else: the one
 * function that reaches the network refuses any other method, so it can be
 * pointed at production during a deploy without touching a row. The key is
 * read from DASHBOARD_KEY, sent only as the x-dashboard-key header (never in a
 * URL, where it would land in Render's request log), and never printed or
 * written; a capture that somehow contained it is redacted before it is saved.
 *
 * MATCHED BY IDENTITY, NOT POSITION. Two captures of an unchanged dashboard
 * can still list things in a different order (ties in a sort, a Map's
 * insertion order), and a positional diff would report every row below the
 * first swap. So records are paired by what they are:
 *   - items by uid; cart groups by supplierUid; lines by itemUid + supplierUid;
 *   - decisions, pick conflicts and removed items by itemUid;
 *   - any other list of records that all carry a unique uid, itemUid or
 *     supplierUid, by that;
 *   - CSV rows by item number + supplier.
 * Only lists with no identity at all are compared position by position.
 * `generatedAt`, `bootedAt` and the sync timestamps are ignored: they differ
 * on every capture and say nothing about the figures.
 *
 * Each later stage that adds a record type adds its identity to IDENTITY below.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const BASES = {
  local: "http://localhost:3111",
  prod: "https://esperion-inventory-dashboard.onrender.com",
};

/*
 * The items every stage in the plan is checked against: the ones whose
 * figures the plan quotes (BN1665G's gap, SPW12G's and BN16110G's suggestions,
 * the reversal-PO items, the double-line PO), the item-lead examples, two kits,
 * and one split item found in the cart at capture time.
 */
export const WATCH = [
  "BN1665G", "SPW12G", "BP1675G", "WSBT450G", "WQ16806G", "BN16110G", "BP1690G",
  "N16G8", "N24S16M", "TB12125S16", "KITST1240S", "KITST1230S", "WR16503G", "WR16301.5S16",
];

/** Whole-response captures: file name → GET path under /api/insights. */
export const ENDPOINTS = [
  ["overview.json", "/overview"],
  ["cart.json", "/cart"],
  ["cart.csv", "/cart.csv"],
  ["items.csv", "/items.csv"],
  ["suppliers.json", "/suppliers"],
  ["divergence.json", "/divergence"],
  ["kits-availability.json", "/kits/availability"],
  ["sync-status.json", "/sync/status"],
];

/** Keys that differ on every capture and carry no figure. */
const IGNORED_KEYS = new Set(["generatedAt", "bootedAt"]);
/** Sync bookkeeping, ignored in sync-status.json only: a capture is not a sync. */
const SYNC_TIMESTAMP_KEYS = new Set(["last_synced_at", "last_modified_high", "started_at", "finished_at"]);

/*
 * Explicit identities, by file and list path ("[]" marks a list). Anything not
 * here falls back to a unique uid / itemUid / supplierUid on every record, then
 * to position.
 */
const IDENTITY = {
  "items.json": { "items[]": (r) => r.uid },
  "cart.json": {
    "suppliers[]": (r) => r.supplierUid,
    "suppliers[].lines[]": (r) => `${r.itemUid}|${r.supplierUid}`,
    "decisions[]": (r) => r.itemUid,
    "pickConflicts[]": (r) => r.itemUid,
    "removedItems[]": (r) => r.itemUid,
  },
};
const AUTO_KEYS = ["uid", "itemUid", "supplierUid"];

/** CSV identity: the first of these header pairs present names a row. */
const CSV_IDENTITY = [["Item number", "Supplier"]];

/* ---------- GET only ---------- */

/**
 * The only door to the network. Anything but GET is refused before a byte is
 * sent, whoever calls it and however.
 */
export function makeGetter({ base, key, fetchImpl = globalThis.fetch }) {
  const root = base.replace(/\/+$/, "");
  return async function get(path, { method = "GET", as = "json" } = {}) {
    if (String(method).toUpperCase() !== "GET") {
      throw new Error(`stage-check sends GET requests only; refused ${method} ${path}.`);
    }
    const headers = { accept: as === "json" ? "application/json" : "text/csv" };
    if (key) headers["x-dashboard-key"] = key;
    const res = await fetchImpl(`${root}/api/insights${path}`, { method: "GET", headers, redirect: "error" });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let msg = body.slice(0, 200);
      try {
        msg = JSON.parse(body).error ?? msg;
      } catch {}
      throw new Error(`GET ${path} failed (${res.status}): ${msg}`);
    }
    return as === "json" ? res.json() : res.text();
  };
}

export function resolveBase(value) {
  const base = BASES[value ?? "local"] ?? value;
  if (!/^https?:\/\/[^/]+/.test(base)) throw new Error(`--base must be local, prod or an http(s) URL; got "${value}".`);
  if (/[?&]key=|@/.test(base)) {
    throw new Error("Put the key in DASHBOARD_KEY, never in --base: a URL lands in logs and shell history.");
  }
  return base;
}

/* ---------- capture ---------- */

function safeName(number) {
  return String(number).replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Every item, across pages, sorted by item number so paging cannot shift under a tie. */
async function allItems(get) {
  const pageSize = 200;
  const first = await get(`/items?sort=number&dir=asc&pageSize=${pageSize}&page=1`);
  const items = [...first.items];
  for (let page = 2; items.length < first.total; page++) {
    const next = await get(`/items?sort=number&dir=asc&pageSize=${pageSize}&page=${page}`);
    if (!next.items?.length) break;
    items.push(...next.items);
  }
  const { items: _drop, page: _p, ...meta } = first;
  const unique = new Set(items.map((i) => i.uid)).size;
  return { meta, items, problems: unique === first.total ? [] : [`/items paged ${unique} unique of ${first.total}`] };
}

/**
 * Save one full capture into `dir`. Returns what it wrote and anything that
 * failed; a capture with failures is still written, but is not a baseline.
 */
export async function capture(dir, { get, key = "", base = "", log = () => {} }) {
  mkdirSync(join(dir, "items"), { recursive: true });
  const problems = [];
  const write = (name, content) => {
    let text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    if (key && key.length >= 6 && text.includes(key)) {
      text = text.split(key).join("[REDACTED]");
      problems.push(`${name}: contained the access key; redacted before saving`);
    }
    writeFileSync(join(dir, name), text);
  };

  let numbers = new Map();
  try {
    const { meta, items, problems: p } = await allItems(get);
    problems.push(...p);
    numbers = new Map(items.map((i) => [i.number, i.uid]));
    write("items.json", { ...meta, items });
    log(`${"items.json".padEnd(24)}${items.length} items`);
  } catch (err) {
    problems.push(err.message);
  }

  let cart = null;
  let release = null;
  for (const [file, path] of ENDPOINTS) {
    try {
      const body = await get(path, { as: file.endsWith(".csv") ? "text" : "json" });
      if (file === "cart.json") cart = body;
      if (file === "sync-status.json") release = body.release ?? null;
      write(file, body);
      log(`${file.padEnd(24)}ok`);
    } catch (err) {
      problems.push(err.message);
    }
  }

  // One split item, if Allied have split any: splits are the case the Order
  // list total gets wrong (Stage 4), so one is always watched.
  const split = (cart?.decisions ?? [])
    .filter((d) => d.kind === "split" && d.number)
    .map((d) => d.number)
    .sort()[0] ?? null;
  const watch = [...WATCH, ...(split && !WATCH.includes(split) ? [split] : [])];
  const resolved = {};
  // Kit pages (1.2): every watched item that is a kit, and every kit a watched
  // item goes into. "Buildable incl. incoming" lives only there, and it moves
  // whenever a component's On order does.
  const kits = new Map();
  for (const number of watch) {
    const uid = numbers.get(number) ?? null;
    resolved[number] = uid;
    if (!uid) {
      log(`items/${number}: not in /items, skipped`);
      continue;
    }
    try {
      const detail = await get(`/items/${encodeURIComponent(uid)}`);
      write(join("items", `${safeName(number)}.json`), detail);
      if (detail?.components?.length) kits.set(uid, number);
      for (const p of detail?.whereUsed ?? []) if (p?.uid && p.number) kits.set(p.uid, p.number);
    } catch (err) {
      problems.push(err.message);
    }
  }
  log(`${"items/".padEnd(24)}${Object.values(resolved).filter(Boolean).length} of ${watch.length} watched items`);
  if (kits.size) mkdirSync(join(dir, "kits"), { recursive: true });
  for (const [uid, number] of [...kits].sort((a, b) => a[1].localeCompare(b[1]))) {
    try {
      write(join("kits", `${safeName(number)}.json`), await get(`/kits/${encodeURIComponent(uid)}`));
    } catch (err) {
      problems.push(err.message);
    }
  }
  log(`${"kits/".padEnd(24)}${kits.size} kit pages (watched kits and the kits watched items go into)`);

  write("manifest.json", {
    capturedAt: new Date().toISOString(),
    base,
    release,
    watch: resolved,
    splitItem: split,
    problems,
  });
  return { problems, release, watch: resolved };
}

/* ---------- diff ---------- */

function isRecord(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** How to pair the records of one list, or null to compare by position. */
function identityFor(file, listPath, a, b) {
  const explicit = IDENTITY[file]?.[listPath];
  if (explicit) return explicit;
  const all = [...a, ...b];
  if (!all.length || !all.every(isRecord)) return null;
  for (const k of AUTO_KEYS) {
    if (!all.every((r) => r[k] != null)) continue;
    if (new Set(a.map((r) => r[k])).size === a.length && new Set(b.map((r) => r[k])).size === b.length) {
      return (r) => r[k];
    }
  }
  return null;
}

function diffValue(file, a, b, path, shape, out) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const listShape = `${shape}[]`;
    const id = identityFor(file, listShape, a, b);
    if (id) {
      const ma = new Map(a.map((r) => [String(id(r)), r]));
      const mb = new Map(b.map((r) => [String(id(r)), r]));
      for (const [k, v] of ma) {
        if (!mb.has(k)) out.push({ file, path: `${path}[${k}]`, before: v, after: undefined });
        else diffValue(file, v, mb.get(k), `${path}[${k}]`, listShape, out);
      }
      for (const [k, v] of mb) if (!ma.has(k)) out.push({ file, path: `${path}[${k}]`, before: undefined, after: v });
      return;
    }
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) out.push({ file, path: `${path}[${i}]`, before: undefined, after: b[i] });
      else if (i >= b.length) out.push({ file, path: `${path}[${i}]`, before: a[i], after: undefined });
      else diffValue(file, a[i], b[i], `${path}[${i}]`, listShape, out);
    }
    return;
  }
  if (isRecord(a) && isRecord(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (IGNORED_KEYS.has(k)) continue;
      if (file === "sync-status.json" && SYNC_TIMESTAMP_KEYS.has(k)) continue;
      const p = path ? `${path}.${k}` : k;
      const s = shape ? `${shape}.${k}` : k;
      if (!(k in b)) out.push({ file, path: p, before: a[k], after: undefined });
      else if (!(k in a)) out.push({ file, path: p, before: undefined, after: b[k] });
      else diffValue(file, a[k], b[k], p, s, out);
    }
    return;
  }
  if (!Object.is(a, b) && JSON.stringify(a) !== JSON.stringify(b)) out.push({ file, path, before: a, after: b });
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF, a leading BOM. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/*
 * A CSV as records. cart.csv is not one table: it opens with WARNING/NOTE
 * lines and repeats the header above each supplier's block. So any row equal
 * to a header starts a table, rows of the same width under it are records
 * keyed by item + supplier, and every other non-blank line is kept as a note
 * — compared as text, because "WARNING: 3 item(s)…" becoming 4 is a change.
 */
function csvRecords(text) {
  const records = {};
  const notes = [];
  let header = null;
  let idCols = null;
  for (const row of parseCsv(text)) {
    if (row.length === 1 && row[0] === "") {
      header = null;
      continue;
    }
    const pair = CSV_IDENTITY.find(([x]) => row.includes(x));
    if (pair && row.length > 2) {
      header = row;
      idCols = pair.map((c) => row.indexOf(c));
      continue;
    }
    if (header && row.length === header.length) {
      const key = idCols.map((i) => (i >= 0 ? row[i] : "")).join("|");
      const rec = Object.fromEntries(header.map((h, i) => [h, row[i]]));
      // Same item + supplier twice would be its own finding; keep both.
      let k = key;
      for (let n = 2; k in records; n++) k = `${key}#${n}`;
      records[k] = rec;
    } else notes.push(row.join(","));
  }
  return { rows: records, notes };
}

function readCapture(dir) {
  const files = {};
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const full = join(d, f);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(dir, full).replace(/\\/g, "/")] = full;
    }
  };
  walk(dir);
  return files;
}

/**
 * Turn an allow path into a matcher. `*` is one name, `[*]` any one record, and
 * a path covers everything under it; an empty path covers the whole file.
 */
export function allowMatcher(pattern) {
  if (!pattern) return /^/;
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith("[*]", i)) {
      re += "\\[[^\\]]*\\]";
      i += 2;
    } else if (pattern[i] === "*") re += "[^.\\[]*";
    else re += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?=$|[.\\[])`);
}

export function loadAllow(file) {
  if (!file) return [];
  const spec = JSON.parse(readFileSync(file, "utf8"));
  return (spec.allow ?? []).map((a) => ({ ...a, match: allowMatcher(a.path ?? "") }));
}

/** Every difference between two captures, each marked allowed or not. */
export function diffCaptures(beforeDir, afterDir, allow = []) {
  const a = readCapture(beforeDir);
  const b = readCapture(afterDir);
  const changes = [];
  for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (name === "manifest.json") continue;
    if (!a[name] || !b[name]) {
      changes.push({ file: name, path: "", before: a[name] ? "(file)" : undefined, after: b[name] ? "(file)" : undefined });
      continue;
    }
    const ta = readFileSync(a[name], "utf8");
    const tb = readFileSync(b[name], "utf8");
    if (ta === tb) continue;
    if (name.endsWith(".csv")) {
      // Rows as rows[<item>|<supplier>], so an allow path can say rows[*].Order qty
      // even though item numbers such as WR16301.5S16 contain dots.
      const ra = csvRecords(ta);
      const rb = csvRecords(tb);
      for (const k of new Set([...Object.keys(ra.rows), ...Object.keys(rb.rows)])) {
        diffValue(name, ra.rows[k], rb.rows[k], `rows[${k}]`, "rows[]", changes);
      }
      diffValue(name, ra.notes, rb.notes, "notes", "notes", changes);
    } else diffValue(name, JSON.parse(ta), JSON.parse(tb), "", "", changes);
  }
  for (const c of changes) {
    const hit = allow.find((x) => (x.file === c.file || x.file === "*") && x.match.test(c.path));
    c.allowed = Boolean(hit);
    if (hit) hit.used = true;
  }
  return { changes, unused: allow.filter((x) => !x.used) };
}

/* ---------- generating an allow-list ---------- */

/**
 * A numbers release's allow-list, generated rather than hand-written (1.2):
 * capture the same data before and after the change (locally, on one copy of
 * the database), and every difference becomes one entry with its exact path
 * and the before and after it showed. A hand-written list says what we think
 * moves; this one says what did, and is then read line by line before it is
 * committed. Paths keep their record identities (an item's uid, a cart line's
 * item|supplier), so on production a figure moving on any other record still
 * fails. A record key containing `*` would widen its entry (allowMatcher reads
 * it as a wildcard); no item number or uid does today.
 *
 * Two changes are not listed one by one:
 *   - sync-status.json `release` is one entry: every deploy changes its
 *     version and commit, and locally the commit reads "local" both times;
 *   - a list compared by position (no uid to pair its records by) that gained
 *     or lost a record is one entry for the whole list. Past the first record
 *     removed, positions no longer line up, so per-position entries would be
 *     describing an accident of order (the item page's PO rows, in 1.2).
 *
 * Entries carry `before` and `after` for the reviewer; loadAllow reads only
 * `file`, `path` and `why`.
 */
export function proposeAllow(beforeDir, afterDir, { version = null, stage = null, note = null } = {}) {
  const manifest = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const ma = manifest(beforeDir);
  const mb = manifest(afterDir);
  const { changes } = diffCaptures(beforeDir, afterDir);
  const whole = new Map(); // `${file} ${list path}` -> entry
  for (const c of changes) {
    const m = /^(.*)\[\d+\]$/.exec(c.path);
    if (m && m[1] && (c.before === undefined || c.after === undefined)) {
      whole.set(`${c.file} ${m[1]}`, {
        file: c.file,
        path: m[1],
        why: "a list compared by position gained or lost records between the two captures; listed whole",
        changes: 0,
      });
    }
  }
  const allow = [];
  let release = null;
  for (const c of changes) {
    if (c.file === "sync-status.json" && /^release(\.|$)/.test(c.path)) {
      if (!release) {
        release = { file: c.file, path: "release", why: "every deploy reports its own version and commit" };
        allow.push(release);
      }
      continue;
    }
    const list = [...whole.values()].find((w) => w.file === c.file && c.path.startsWith(`${w.path}[`));
    if (list) {
      if (!list.changes++) allow.push(list);
      continue;
    }
    allow.push({
      file: c.file,
      path: c.path,
      why: "moved between the two captures this list was generated from",
      before: c.before,
      after: c.after,
    });
  }
  if (!release) allow.push({ file: "sync-status.json", path: "release", why: "every deploy reports its own version and commit" });
  return {
    version: version ?? mb?.release?.version ?? null,
    stage,
    note:
      note ??
      `Generated by stage-check expect from two captures of the same data: ${changes.length} differences as ${allow.length} entries. Review each entry before committing; any change not listed here fails the diff.`,
    generatedFrom: {
      before: { release: ma?.release ?? null, capturedAt: ma?.capturedAt ?? null },
      after: { release: mb?.release ?? null, capturedAt: mb?.capturedAt ?? null },
    },
    allow,
  };
}

/* ---------- command line ---------- */

function show(v) {
  if (v === undefined) return "(absent)";
  const s = JSON.stringify(v);
  return s.length > 90 ? `${s.slice(0, 87)}...` : s;
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) {
      positional.push(argv[i]);
      continue;
    }
    const name = argv[i].slice(2);
    if (!["base", "allow", "stage"].includes(name)) fail(`Unknown option --${name}.`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value.`);
    options[name] = v;
  }
  const [command, ...args] = positional;

  if (command === "capture" && args.length === 1 && !options.allow) {
    const base = resolveBase(options.base);
    const key = process.env.DASHBOARD_KEY?.trim() ?? "";
    if (!key) console.warn("DASHBOARD_KEY is not set: fine for a local copy with no key, a 401 anywhere else.");
    if (existsSync(args[0]) && readdirSync(args[0]).length) fail(`${args[0]} is not empty; capture into a new directory.`);
    console.log(`Capturing ${base} into ${args[0]} (GET only)`);
    const out = await capture(args[0], { get: makeGetter({ base, key }), key, base, log: (m) => console.log(`  ${m}`) });
    console.log(`release: ${out.release ? `${out.release.version} (${out.release.commit})` : "none reported"}`);
    if (out.problems.length) {
      console.error(`\n${out.problems.length} problem(s); this capture is not a baseline:`);
      for (const p of out.problems) console.error(`  ${p}`);
      process.exit(1);
    }
    return;
  }

  if (command === "diff" && args.length === 2 && !options.base) {
    const allow = loadAllow(options.allow);
    const { changes, unused } = diffCaptures(args[0], args[1], allow);
    const bad = changes.filter((c) => !c.allowed);
    for (const c of changes) {
      console.log(`${c.allowed ? "allowed " : "CHANGED "} ${c.file}  ${c.path || "(whole file)"}  ${show(c.before)} -> ${show(c.after)}`);
    }
    for (const u of unused) console.log(`note: expected change did not appear: ${u.file} ${u.path}${u.why ? ` (${u.why})` : ""}`);
    console.log(`\n${changes.length} difference(s): ${changes.length - bad.length} allowed, ${bad.length} not allowed.`);
    process.exit(bad.length ? 1 : 0);
  }

  if (command === "expect" && args.length === 2 && !options.base && !options.allow) {
    // Prints the list; redirect it into scripts/expected/<version>.json and review it.
    process.stdout.write(`${JSON.stringify(proposeAllow(args[0], args[1], { stage: options.stage ?? null }), null, 2)}\n`);
    return;
  }

  fail(
    "Usage:\n" +
      "  DASHBOARD_KEY=… node scripts/stage-check.mjs capture <dir> [--base local|prod|URL]\n" +
      "  node scripts/stage-check.mjs diff <before> <after> [--allow scripts/expected/<version>.json]\n" +
      "  node scripts/stage-check.mjs expect <before> <after> [--stage \"Stage N: …\"] > scripts/expected/<version>.json",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => fail(err.message));
}
