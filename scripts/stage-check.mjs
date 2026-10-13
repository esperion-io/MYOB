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
 *   node scripts/stage-check.mjs cover <after> [--before <before>] [--base …]   (1.3: the cover identities)
 *   node scripts/stage-check.mjs splits <after> [--before <before>]   (1.4: the Order list total for splits)
 *   node scripts/stage-check.mjs schedule <after> [--base …]   (1.9: incoming POs add up to On order)
 *   npx tsx scripts/stage-check.mjs gap <after> [--base …]    (1.10: stock gaps, recomputed with the server's projection)
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

/* ---------- 1.3: cover excl. / incl. on order ---------- */

/*
 * `stage-check cover`: the identities 1.3's new figure must satisfy on every
 * item, checked from a capture (and, given --base, two GET lists the capture
 * does not hold). The golden diff proves no existing figure moved; this proves
 * the new one is the figure it claims to be.
 *
 * The identity uses the unrounded weekly rate, rebuilt from the demand fields
 * the capture carries, not `demand.weekly`, which is served to 3 dp. With the
 * served rate a slow mover with years of cover fails on that rounding alone
 * (on the 26 Aug copy 114 items, e.g. 5,007 free at 0.767/wk; coverWeeks
 * fails identically), which says nothing about either figure.
 */
const CSV_COVER_INCL = "Cover incl. on order (weeks)";

function unroundedWeekly(d) {
  const weeksIn = (months) => (months * 365.25) / 12 / 7;
  if (d?.basis === "window") return ((d.directWindow ?? 0) + (d.componentWindow ?? 0)) / weeksIn(d.windowMonths);
  if (d?.basis === "long") return ((d.directLong ?? 0) + (d.componentLong ?? 0)) / weeksIn(d.longMonths);
  return 0;
}

/**
 * Every 1.3 check as { check, ok, detail }. `belowLead` and `sortedIncl` are
 * the /items lists for filter=below_lead and sort=cover_incl (rows in served
 * order, plus the `dir` it reported); a check whose input is missing is
 * skipped, not passed.
 */
export function coverChecks({ items, csv, beforeCsv = null, belowLead = null, sortedIncl = null }) {
  const out = [];
  const add = (check, bad, detail) =>
    out.push({ check, ok: bad.length === 0, detail: bad.length ? `${bad.length}: ${bad.slice(0, 5).join("; ")}` : detail });
  const name = (i) => i.number ?? i.uid;

  add("every item carries coverWeeksInclOnOrder (a 1.3 server)", items.filter((i) => !("coverWeeksInclOnOrder" in i)).map(name), `${items.length} items`);
  const identity = [];
  const below = [];
  const unequal = [];
  const notNull = [];
  for (const i of items) {
    const incl = i.coverWeeksInclOnOrder ?? null;
    const excl = i.coverWeeks ?? null;
    const w = unroundedWeekly(i.demand);
    if (w > 0 && incl != null) {
      const err = Math.abs(incl * w - Math.max(i.qtyAvailable ?? 0, 0));
      if (err > 0.05 * w + 1e-9) identity.push(`${name(i)} ${incl}w × ${w.toFixed(3)} vs ${i.qtyAvailable}`);
    }
    if ((incl == null) !== (excl == null)) unequal.push(`${name(i)} incl ${incl} excl ${excl}`);
    if (incl != null && excl != null && incl < excl) below.push(`${name(i)} ${incl} < ${excl}`);
    if (!(i.qtyOnOrder > 0) && incl !== excl) unequal.push(`${name(i)} on order ${i.qtyOnOrder}: ${incl} ≠ ${excl}`);
    if (!(w > 0) && (incl != null || excl != null)) notNull.push(`${name(i)} no demand: ${excl} / ${incl}`);
  }
  const withDemand = items.filter((i) => unroundedWeekly(i.demand) > 0).length;
  add("|incl × weekly − max(Available, 0)| ≤ 0.05 × weekly", identity, `${withDemand} items with demand`);
  add("incl ≥ excl", below, "holds on every item");
  add("incl = excl with nothing on order, and both null or neither", unequal, "holds on every item");
  add("weekly 0 gives null for both", notNull, `${items.length - withDemand} items with no demand`);

  if (csv != null) {
    const { rows } = csvRecords(csv);
    const header = parseCsv(csv.replace(/^﻿/, ""))[0] ?? [];
    const byNumber = new Map(items.map((i) => [i.number, i]));
    const cells = [];
    if (header.at(-1) !== CSV_COVER_INCL) cells.push(`last column is "${header.at(-1)}"`);
    for (const r of Object.values(rows)) {
      const i = byNumber.get(r["Item number"]);
      const want = i?.coverWeeksInclOnOrder == null ? "" : String(Number(i.coverWeeksInclOnOrder.toFixed(4)));
      if (!i || r[CSV_COVER_INCL] !== want) cells.push(`${r["Item number"]}: ${r[CSV_COVER_INCL]} vs ${want}`);
    }
    add(`items.csv ends with "${CSV_COVER_INCL}", equal to the items list`, cells, `${Object.keys(rows).length} rows`);
  }
  if (beforeCsv != null && csv != null) {
    // Byte for byte: each line of the 1.3 file is the earlier line, a comma,
    // and the new cell. Both captures must be of the same data.
    const a = beforeCsv.split("\r\n");
    const b = csv.split("\r\n");
    const bad = a.length === b.length ? [] : [`${a.length} lines before, ${b.length} after`];
    if (!bad.length)
      a.forEach((line, k) => {
        if (line === "" && b[k] === "") return;
        if (!b[k].startsWith(`${line},`) || /[",]/.test(b[k].slice(line.length + 1))) bad.push(`line ${k + 1}`);
      });
    add("every existing items.csv column byte-identical", bad, `${a.length - 2} rows`);
  }

  if (belowLead) {
    const flagged = items.filter((i) => i.coverBelowLeadTime).length;
    const bad = belowLead.rows.filter((r) => !r.coverBelowLeadTime).map(name);
    if (belowLead.rows.length !== flagged) bad.unshift(`filter lists ${belowLead.rows.length}, ${flagged} flagged`);
    add("filter=below_lead lists exactly the coverBelowLeadTime items", bad, `${flagged} items`);
  }
  if (sortedIncl) {
    const v = sortedIncl.rows.map((r) => r.coverWeeksInclOnOrder ?? null);
    const firstNull = v.indexOf(null);
    const head = firstNull < 0 ? v : v.slice(0, firstNull);
    const bad = [];
    if (sortedIncl.dir !== "asc") bad.push(`first click sorts ${sortedIncl.dir}`);
    head.forEach((x, k) => k && head[k - 1] > x && bad.push(`row ${k + 1}: ${head[k - 1]} then ${x}`));
    if (firstNull >= 0 && v.slice(firstNull).some((x) => x != null)) bad.push("a figure after the first blank");
    if (sortedIncl.rows.length !== items.length) bad.push(`${sortedIncl.rows.length} rows of ${items.length}`);
    add("sort=cover_incl: lowest first, non-decreasing, blanks last", bad, `${head.length} figures, ${v.length - head.length} blank`);
  }
  return out;
}

/** One /items list in served order, every page. GET only. */
async function servedList(get, query) {
  const pageSize = 200;
  const first = await get(`/items?${query}&pageSize=${pageSize}&page=1`);
  const rows = [...first.items];
  for (let page = 2; rows.length < first.total; page++) {
    const next = await get(`/items?${query}&pageSize=${pageSize}&page=${page}`);
    if (!next.items?.length) break;
    rows.push(...next.items);
  }
  return { rows, dir: first.dir ?? null };
}

/** `cover <capture> [--before <capture>] [--base …]`: read the capture, fetch the two lists if asked. */
export async function coverCheck(dir, { get = null, beforeDir = null } = {}) {
  const items = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).items;
  const csv = existsSync(join(dir, "items.csv")) ? readFileSync(join(dir, "items.csv"), "utf8") : null;
  const beforeCsv = beforeDir ? readFileSync(join(beforeDir, "items.csv"), "utf8") : null;
  const belowLead = get ? await servedList(get, "filter=below_lead&sort=number&dir=asc") : null;
  const sortedIncl = get ? await servedList(get, "sort=cover_incl") : null;
  return coverChecks({ items, csv, beforeCsv, belowLead, sortedIncl });
}

/* ---------- 1.4: the Order list total for split items ---------- */

/*
 * `stage-check splits`: the identities 1.4's header total and kit count must
 * satisfy, from the /cart of a capture. With one capture (taken on 1.3 before
 * shipping) it counts what 1.4 will move: split items, kits ordered with their
 * parts, and the figure each header end will gain. With --before (1.3) and the
 * capture after (1.4) on the same data it checks that the ends moved by exactly
 * that: Δlow = Σ(sum − smallest part) and Δhigh = Σ(sum − largest part) over
 * split items, while every line, every supplier subtotal and estimatedCost stay
 * as they were. On the 26 Aug copy the cart holds no decisions, so there both
 * deltas are 0.
 */
function cartSplits(cart) {
  const perItem = new Map();
  for (const g of cart?.suppliers ?? [])
    for (const l of g.lines ?? []) {
      const e = perItem.get(l.itemUid) ?? { number: l.number ?? l.itemUid, split: [], others: [], kit: false };
      (l.state === "split" ? e.split : e.others).push(l.estCost);
      e.kit ||= Boolean(l.kitDoubleOrder);
      perItem.set(l.itemUid, e);
    }
  const sum = (xs) => xs.reduce((a, x) => a + x, 0);
  let dLow = 0;
  let dHigh = 0;
  const split = [];
  for (const e of perItem.values()) {
    if (!e.split.length) continue;
    split.push(e.number);
    // What 1.3 counted at each end (one line, min and max over every line)
    // against what 1.4 counts (the parts together as one candidate).
    const all = [...e.split, ...e.others];
    const now = [sum(e.split), ...e.others];
    dLow += Math.min(...now) - Math.min(...all);
    dHigh += Math.max(...now) - Math.max(...all);
  }
  return {
    split: split.sort(),
    dLow: Number(dLow.toFixed(2)),
    dHigh: Number(dHigh.toFixed(2)),
    kitItems: [...perItem.values()].filter((e) => e.kit).length,
    kitLines: (cart?.suppliers ?? []).reduce((a, g) => a + (g.lines ?? []).filter((l) => l.kitDoubleOrder).length, 0),
  };
}

/** Every 1.4 check as { check, ok, detail }; `before` is optional. */
export function splitChecks({ after, before = null }) {
  const out = [];
  const add = (check, bad, detail) =>
    out.push({ check, ok: bad.length === 0, detail: bad.length ? `${bad.length}: ${bad.slice(0, 5).join("; ")}` : detail });
  const s = cartSplits(before ?? after);
  out.push({
    check: "split items and kit double orders (count before shipping)",
    ok: true,
    detail: `${s.split.length} split item(s)${s.split.length ? ` (${s.split.slice(0, 5).join(", ")})` : ""}; ` +
      `${s.kitItems} kit item(s) on ${s.kitLines} line(s); header low +${s.dLow}, high +${s.dHigh}`,
  });
  if (!before) return out;
  const near = (a, b) => Math.abs((a ?? NaN) - (b ?? NaN)) <= 0.011;
  add("estimatedCost unchanged", near(before.estimatedCost, after.estimatedCost) ? [] : [`${before.estimatedCost} -> ${after.estimatedCost}`], `${after.estimatedCost}`);
  const subA = new Map((before.suppliers ?? []).map((g) => [g.supplierUid, g]));
  const sub = [];
  const lines = [];
  for (const g of after.suppliers ?? []) {
    const b = subA.get(g.supplierUid);
    if (!b || !near(b.estimatedCost, g.estimatedCost)) sub.push(`${g.supplierName}: ${b?.estimatedCost} -> ${g.estimatedCost}`);
    const bl = new Map((b?.lines ?? []).map((l) => [l.itemUid, l]));
    for (const l of g.lines ?? []) {
      const x = bl.get(l.itemUid);
      if (!x || x.qty !== l.qty || !near(x.estCost, l.estCost) || x.state !== l.state) lines.push(`${l.number}|${g.supplierName}`);
    }
  }
  if ((before.suppliers ?? []).length !== (after.suppliers ?? []).length) sub.push(`${before.suppliers?.length} suppliers -> ${after.suppliers?.length}`);
  // And the other way: a line that vanished leaves nothing to walk above, and
  // at $0 (item 9 under No known supplier is one) it moves no subtotal either.
  const kept = new Set((after.suppliers ?? []).flatMap((g) => (g.lines ?? []).map((l) => `${g.supplierUid}|${l.itemUid}`)));
  for (const g of before.suppliers ?? [])
    for (const l of g.lines ?? []) if (!kept.has(`${g.supplierUid}|${l.itemUid}`)) lines.push(`${l.number}|${g.supplierName} gone`);
  if (before.totalLines !== after.totalLines) lines.push(`totalLines ${before.totalLines} -> ${after.totalLines}`);
  add("every supplier subtotal unchanged", sub, `${(after.suppliers ?? []).length} suppliers`);
  add("every line's qty, cost and state unchanged", lines, `${after.totalLines} lines`);
  const dLow = Number((after.requirementLow - before.requirementLow).toFixed(2));
  const dHigh = Number((after.requirementHigh - before.requirementHigh).toFixed(2));
  add("Δlow = Σ(sum − smallest part) over split items", near(dLow, s.dLow) ? [] : [`moved ${dLow}, expected ${s.dLow}`], `+${dLow}`);
  add("Δhigh = Σ(sum − largest part) over split items", near(dHigh, s.dHigh) ? [] : [`moved ${dHigh}, expected ${s.dHigh}`], `+${dHigh}`);
  const sa = cartSplits(after);
  add("kit.doubleOrders counts items, not lines", after.kit?.doubleOrders === sa.kitItems ? [] : [`${after.kit?.doubleOrders} vs ${sa.kitItems} items`], `${sa.kitItems} item(s)`);
  return out;
}

/** `splits <capture> [--before <capture>]`: read the /cart of each. */
export function splitCheck(dir, { beforeDir = null } = {}) {
  const read = (d) => JSON.parse(readFileSync(join(d, "cart.json"), "utf8"));
  return splitChecks({ after: read(dir), before: beforeDir ? read(beforeDir) : null });
}

/* ---------- 1.9: incoming POs with expected dates ---------- */

/*
 * `stage-check schedule`: what 1.9's incoming schedule must satisfy, from the
 * items list of a capture, the item pages (every item with stock on order
 * when --base fetches them, GET only; else the capture's watched pages) and
 * the capture's /divergence open documents. The golden diff proves nothing
 * else moved; this proves the new rows are On order, line for line:
 *   - per item, Σ outstanding over incomingSchedule = qtyOnOrder exactly, and
 *     the summary's dated + overdue + late + undated = total = qtyOnOrder;
 *   - the POs in the schedules are exactly the counted open documents with
 *     something to arrive, and no reversal document appears;
 *   - one date per PO document: every line of a PO, on every item, carries
 *     the same expected date, basis and status (item lead times never move
 *     an ETA), and that is the date /divergence gives the document;
 *   - promised exactly when MYOB's Promised Date is on or after the PO date;
 *     an estimate is the PO date + its lead; nothing estimated reads as
 *     promised;
 *   - the rows are in the panel's order: overdue and late, then dated, then
 *     undated.
 * It prints one line per PO (expected, basis, status) to compare with the
 * plan's table and with what Allied see.
 */
const SCHEDULE_RANK = { overdue: 0, late: 0, due: 1, undated: 2 };

function addDaysIso(iso, days) {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + Math.round(days) * 86_400_000).toISOString().slice(0, 10);
}

/** Every 1.9 check as { check, ok, detail }, and the per-PO table. */
export function scheduleChecks({ items, details, docs }) {
  const out = [];
  const add = (check, bad, detail) =>
    out.push({ check, ok: bad.length === 0, detail: bad.length ? `${bad.length}: ${bad.slice(0, 5).join("; ")}` : detail });
  const name = (i) => i.number ?? i.uid;
  const near = (a, b) => Math.abs((a ?? NaN) - (b ?? NaN)) <= 1e-6;
  const onOrder = items.filter((i) => i.qtyOnOrder > 0);
  const checked = onOrder.filter((i) => details.has(i.uid));

  const missing = checked.filter((i) => !Array.isArray(details.get(i.uid)?.incomingSchedule)).map(name);
  add("every item page carries incomingSchedule (a 1.9 server)", missing, `${checked.length} pages`);
  const sums = [];
  const summary = [];
  const order = [];
  for (const i of checked) {
    const d = details.get(i.uid);
    const rows = d?.incomingSchedule ?? [];
    const sum = rows.reduce((a, r) => a + r.outstanding, 0);
    if (!near(sum, i.qtyOnOrder)) sums.push(`${name(i)} Σ ${sum} vs on order ${i.qtyOnOrder}`);
    const s = d?.incomingSummary;
    if (!s || !near(s.dated + s.overdue + s.late + s.undated, s.total) || !near(s.total, i.qtyOnOrder))
      summary.push(`${name(i)} ${s ? `${s.dated}+${s.overdue}+${s.late}+${s.undated} / ${s.total}` : "no summary"} vs ${i.qtyOnOrder}`);
    rows.forEach((r, k) => {
      if (k && SCHEDULE_RANK[rows[k - 1].status] > SCHEDULE_RANK[r.status]) order.push(`${name(i)} row ${k + 1}`);
    });
  }
  add("Σ schedule outstanding = qtyOnOrder, every item with stock on order", sums, `${checked.length} of ${onOrder.length} items`);
  add("summary: dated + overdue + late + undated = total = qtyOnOrder", summary, `${checked.length} items`);
  add("rows ordered overdue/late, then dated, then undated", order, "holds on every item");

  // One date per document, across every item it carries.
  const perPo = new Map();
  const split = [];
  const rule = [];
  for (const i of checked)
    for (const r of details.get(i.uid)?.incomingSchedule ?? []) {
      const key = `${r.eta}|${r.etaBasis}|${r.status}`;
      const seen = perPo.get(r.poUid);
      if (seen && seen.key !== key) split.push(`${r.number}: ${seen.key} vs ${key} (${name(i)})`);
      if (!seen) perPo.set(r.poUid, { key, row: r, units: 0, lines: 0 });
      const e = perPo.get(r.poUid);
      e.units += r.outstanding;
      e.lines += 1;
      const promisedOk = r.promisedDate != null && r.raised != null && r.promisedDate >= r.raised;
      if ((r.etaBasis === "promised") !== promisedOk) rule.push(`${r.number}: ${r.etaBasis} with promised ${r.promisedDate}, raised ${r.raised}`);
      if (r.etaBasis === "estimated" && (r.leadDays == null || r.eta !== addDaysIso(r.raised, r.leadDays)))
        rule.push(`${r.number}: ~${r.eta} ≠ ${r.raised} + ${r.leadDays}`);
      if (r.etaBasis === "promised" && r.eta !== r.promisedDate) rule.push(`${r.number}: ${r.eta} ≠ promised ${r.promisedDate}`);
    }
  add("one expected date, basis and status per PO document", split, `${perPo.size} POs`);
  add("promised exactly when Promised Date ≥ PO date; estimate = PO date + lead", rule, `${perPo.size} POs`);

  if (docs) {
    const counted = docs.filter((x) => x.counted && x.outstanding > 0);
    const notCounted = new Set(docs.filter((x) => !x.counted).map((x) => x.uid));
    const extra = [...perPo.keys()].filter((u) => !counted.some((x) => x.uid === u)).map((u) => perPo.get(u).row.number);
    const reversal = [...perPo.keys()].filter((u) => notCounted.has(u)).map((u) => perPo.get(u).row.number);
    const absent = counted.filter((x) => !perPo.has(x.uid)).map((x) => x.number);
    add("no reversal (not counted) document appears", reversal, `${notCounted.size} not counted`);
    add("every PO in the schedules is a counted open document", extra, `${perPo.size} POs`);
    if (checked.length === onOrder.length)
      add("every counted open document with stock to arrive appears", absent, `${counted.length} documents`);
    const compared = counted.filter((x) => perPo.has(x.uid));
    const disagree = compared
      .filter((x) => {
        const r = perPo.get(x.uid).row;
        return x.expected?.eta !== r.eta || x.expected?.etaBasis !== r.etaBasis || x.expected?.status !== r.status;
      })
      .map((x) => x.number);
    add("Data & Sync gives each document the item pages' date", disagree, `${compared.length} of ${counted.length} documents`);
  }
  const table = [...perPo.values()]
    .map(({ row: r, units, lines }) => ({
      po: r.number,
      supplier: r.supplier,
      raised: r.raised,
      expected: r.eta == null ? "—" : r.etaBasis === "estimated" ? `~${r.eta}` : r.eta,
      basis: r.etaBasis === "estimated" ? `${r.leadSource} ${r.leadDays} d${r.measuredEta ? ` (measured ${r.measuredDays} d: ~${r.measuredEta})` : ""}` : r.etaBasis,
      status: r.status === "due" ? `due in ${r.daysToGo} d` : r.status === "undated" ? "no date" : `${r.status} ${r.daysLate} d`,
      lines,
      units,
    }))
    .sort((a, b) => String(a.po).localeCompare(String(b.po)));
  return { checks: out, table };
}

/** `schedule <capture> [--base …]`: the capture's items and /divergence, item pages fetched if asked. */
export async function scheduleCheck(dir, { get = null } = {}) {
  const items = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).items;
  const docs = existsSync(join(dir, "divergence.json"))
    ? (JSON.parse(readFileSync(join(dir, "divergence.json"), "utf8")).openDocs ?? null)
    : null;
  const details = new Map();
  if (get) {
    for (const i of items.filter((x) => x.qtyOnOrder > 0))
      details.set(i.uid, await get(`/items/${encodeURIComponent(i.uid)}`));
  } else if (existsSync(join(dir, "items"))) {
    for (const f of readdirSync(join(dir, "items"))) {
      const d = JSON.parse(readFileSync(join(dir, "items", f), "utf8"));
      if (d?.item?.uid) details.set(d.item.uid, d);
    }
  }
  return scheduleChecks({ items, details, docs });
}

/* ---------- 1.10: stock gaps ---------- */

/*
 * `stage-check gap`: the server's gap fields recomputed, field for field,
 * from what /items/:uid serves (the item and its incomingSchedule), with the
 * server's own pure projectItem (src/insights/projection.ts, passed in as
 * `projection`, so this file still runs under plain node for every other
 * command). With --base it fetches every item with stock on order plus 50
 * others spread through the list (GET only); without it, the capture's
 * watched pages. Then the identities the plan names:
 *   - the first run-out with no counted delivery before it is free-stock
 *     cover × 7 days, to within 1 day;
 *   - every known gap end is one of the item's ETAs (a due line's date);
 *   - gapStatus is gap.status; the Overview count, and with --base the
 *     gap and incoming_overdue filters and the gap sort, agree with the
 *     items list.
 * It prints the counts by status, how many gap + gap_open items are NOT
 * flagged below lead time (the 26 Aug prototype found 33 of 34 were), and
 * one line per item that runs out before its next delivery.
 */
const GAP_FIELD_KEYS = ["gap", "gapStatus", "nextDelivery", "incomingOverdueQty"];

/** Key-order-free equality for JSON values. */
function sameJson(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== "object" || typeof b !== "object") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]));
}

function daysFrom(a, b) {
  const t = (iso) => {
    const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((t(b) - t(a)) / 86_400_000);
}

const runsOut = (s) => s === "gap" || s === "gap_open";

/** Every 1.10 check as { check, ok, detail }, the counts and the per-item table. */
export function gapChecks({ items, details, projection, overview = null, lists = null }) {
  const out = [];
  const add = (check, bad, detail) =>
    out.push({ check, ok: bad.length === 0, detail: bad.length ? `${bad.length}: ${bad.slice(0, 5).join("; ")}` : detail });
  const name = (i) => i.number ?? i.uid;

  const old = items.filter((i) => GAP_FIELD_KEYS.some((k) => !(k in i))).map(name);
  add("every item carries gap, gapStatus, nextDelivery, incomingOverdueQty (a 1.10 server)", old, `${items.length} items`);

  // Field for field, from the item page's own inputs.
  const mismatch = [];
  const listDiffers = [];
  const byUid = new Map(items.map((i) => [i.uid, i]));
  for (const [uid, d] of details) {
    const it = d?.item;
    if (!it) continue;
    const today = d.incomingScheduleDate;
    const served = Object.fromEntries(GAP_FIELD_KEYS.map((k) => [k, it[k] ?? null]));
    const lines = Array.isArray(d.incomingSchedule) ? d.incomingSchedule : [];
    // At a past date the server projects nothing; a page served with
    // schedule facts only (no status) must carry null fields.
    const want =
      it.gapStatus === undefined || lines.some((l) => !("status" in l))
        ? { gap: null, gapStatus: null, nextDelivery: null, incomingOverdueQty: null }
        : projection.projectItem(projection.projectionInput(it, lines, today));
    const bad = GAP_FIELD_KEYS.filter((k) => !sameJson(served[k], want[k] ?? null));
    if (bad.length) mismatch.push(`${name(it)}: ${bad.join(", ")}`);
    const row = byUid.get(uid);
    if (row && GAP_FIELD_KEYS.some((k) => !sameJson(row[k] ?? null, served[k]))) listDiffers.push(name(it));
  }
  add("projectItem(item page inputs) = the server's gap fields, field for field", mismatch, `${details.size} item pages`);
  add("the items list carries the item page's gap fields", listDiffers, `${details.size} items`);

  const statusOk = items.filter((i) => (i.gap?.status ?? null) !== (i.gapStatus ?? null)).map(name);
  add("gapStatus = gap.status", statusOk, "holds on every item");

  // The cover identity, over every item: nextDelivery is the soonest
  // counted delivery, so none before the run-out means it is null or on or
  // after that day. From the item's own figures, not the gap's echo of them.
  const cover = [];
  const ends = [];
  let coverChecked = 0;
  const today = [...details.values()].find((d) => d?.incomingScheduleDate)?.incomingScheduleDate ?? null;
  for (const it of items) {
    const g = it.gap;
    if (!g?.runOut || !today) continue;
    if (it.nextDelivery && it.nextDelivery.eta < g.runOut) continue;
    const weekly = unroundedWeekly(it.demand);
    if (!(weekly > 0) || it.qtyFreeStock == null) continue;
    coverChecked += 1;
    const want = (Math.max(it.qtyFreeStock, 0) / weekly) * 7;
    const got = daysFrom(today, g.runOut);
    if (Math.abs(got - want) > 1 + 1e-9) cover.push(`${name(it)} runs out in ${got} d, cover × 7 = ${want.toFixed(2)}`);
  }
  for (const [, d] of details) {
    const it = d?.item;
    const g = it?.gap;
    if (!g?.runOut) continue;
    const lines = d.incomingSchedule ?? [];
    if (g.status === "gap") {
      const etas = new Set(lines.filter((l) => l.status === "due").map((l) => l.eta));
      if (!etas.has(g.end) || g.endingPo?.eta !== g.end) ends.push(`${name(it)} ends ${g.end}, not a due ETA`);
    }
  }
  add("first run-out with no counted delivery before it = free-stock cover × 7, within 1 day", cover, `${coverChecked} items`);
  add("every known gap end is one of the item's ETAs", ends, "holds on every gap");

  const counts = { gap: 0, gap_open: 0, covered: 0, tight: 0, nothing_on_order: 0, no_demand: 0, built_here: 0, none: 0 };
  let notBelowLead = 0;
  let overdueItems = 0;
  for (const i of items) {
    counts[i.gapStatus ?? "none"] = (counts[i.gapStatus ?? "none"] ?? 0) + 1;
    if (i.gapStatus === "covered" && i.gap?.tight) counts.tight += 1;
    if (runsOut(i.gapStatus) && !i.coverBelowLeadTime) notBelowLead += 1;
    if ((i.incomingOverdueQty ?? 0) > 0) overdueItems += 1;
  }
  const runsOutCount = counts.gap + counts.gap_open;

  if (overview) {
    const k = overview.kpis?.runsOutBeforeNextDelivery;
    add("Overview runsOutBeforeNextDelivery = gap + gap_open in the items list", k === runsOutCount ? [] : [`${k} vs ${runsOutCount}`], `${runsOutCount} items`);
  }
  if (lists?.gapFilter) {
    const bad = lists.gapFilter.rows.filter((r) => !runsOut(r.gapStatus)).map(name);
    if (lists.gapFilter.rows.length !== runsOutCount) bad.unshift(`filter lists ${lists.gapFilter.rows.length}, ${runsOutCount} items run out`);
    add("filter=gap lists exactly gap + gap_open", bad, `${runsOutCount} items`);
  }
  if (lists?.overdueFilter) {
    const bad = lists.overdueFilter.rows.filter((r) => !((r.incomingOverdueQty ?? 0) > 0)).map(name);
    if (lists.overdueFilter.rows.length !== overdueItems) bad.unshift(`filter lists ${lists.overdueFilter.rows.length}, ${overdueItems} items have incoming overdue or late`);
    add("filter=incoming_overdue lists exactly the items with incoming past its date", bad, `${overdueItems} items`);
  }
  if (lists?.gapSort) {
    const v = lists.gapSort.rows.map((r) => (runsOut(r.gapStatus) ? r.gap?.start ?? null : null));
    const firstNull = v.indexOf(null);
    const head = firstNull < 0 ? v : v.slice(0, firstNull);
    const bad = [];
    if (lists.gapSort.dir !== "asc") bad.push(`first click sorts ${lists.gapSort.dir}`);
    head.forEach((x, k) => k && head[k - 1] > x && bad.push(`row ${k + 1}: ${head[k - 1]} then ${x}`));
    if (firstNull >= 0 && v.slice(firstNull).some((x) => x != null)) bad.push("a run-out after the first blank");
    if (head.length !== runsOutCount) bad.push(`${head.length} dated rows, ${runsOutCount} items run out`);
    add("sort=gap: soonest run-out first, the rest last", bad, `${head.length} run-outs`);
  }

  const table = items
    .filter((i) => runsOut(i.gapStatus))
    .map((i) => ({
      number: name(i),
      status: i.gapStatus,
      start: i.gap.start,
      end: i.gap.end,
      days: i.gap.days,
      short: i.gap.unitsShort,
      po: i.gap.endingPo ? `${i.gap.endingPo.number} ${i.gap.endingPo.basis}` : null,
      reason: i.gap.openReason,
      belowLead: Boolean(i.coverBelowLeadTime),
    }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)) || String(a.number).localeCompare(String(b.number)));
  return { checks: out, counts: { ...counts, runsOut: runsOutCount, notBelowLead, overdueItems }, table };
}

/** Every item with stock on order, plus `others` more spread evenly through the rest by item number. */
export function gapSample(items, others = 50) {
  const onOrder = items.filter((i) => i.qtyOnOrder > 0);
  const rest = items.filter((i) => !(i.qtyOnOrder > 0)).sort((a, b) => String(a.number).localeCompare(String(b.number)));
  const step = rest.length / Math.max(Math.min(others, rest.length), 1);
  const picked = [];
  for (let k = 0; k < Math.min(others, rest.length); k++) picked.push(rest[Math.floor(k * step)]);
  return [...onOrder, ...picked];
}

/** `gap <capture> [--base …]`: the capture's items and Overview, item pages and lists fetched if asked. */
export async function gapCheck(dir, { get = null, projection }) {
  const items = JSON.parse(readFileSync(join(dir, "items.json"), "utf8")).items;
  const overview = existsSync(join(dir, "overview.json")) ? JSON.parse(readFileSync(join(dir, "overview.json"), "utf8")) : null;
  const details = new Map();
  let lists = null;
  if (get) {
    for (const i of gapSample(items)) details.set(i.uid, await get(`/items/${encodeURIComponent(i.uid)}`));
    lists = {
      gapFilter: await servedList(get, "filter=gap&sort=number&dir=asc"),
      overdueFilter: await servedList(get, "filter=incoming_overdue&sort=number&dir=asc"),
      gapSort: await servedList(get, "sort=gap"),
    };
  } else if (existsSync(join(dir, "items"))) {
    for (const f of readdirSync(join(dir, "items"))) {
      const d = JSON.parse(readFileSync(join(dir, "items", f), "utf8"));
      if (d?.item?.uid) details.set(d.item.uid, d);
    }
  }
  return gapChecks({ items, details, projection, overview, lists });
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
    if (!["base", "allow", "stage", "before"].includes(name)) fail(`Unknown option --${name}.`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) fail(`--${name} needs a value.`);
    options[name] = v;
  }
  const [command, ...args] = positional;

  if (command === "cover" && args.length === 1 && !options.allow) {
    // GET only, like capture: the two lists come through the same getter.
    const get = options.base
      ? makeGetter({ base: resolveBase(options.base), key: process.env.DASHBOARD_KEY?.trim() ?? "" })
      : null;
    const checks = await coverCheck(args[0], { get, beforeDir: options.before ?? null });
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.check}  (${c.detail})`);
    if (!get) console.log("note: filter=below_lead and sort=cover_incl not checked; pass --base to fetch them (GET only).");
    if (!options.before) console.log("note: existing items.csv columns not compared; pass --before <the 1.2 capture>.");
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  }

  if (command === "schedule" && args.length === 1 && !options.allow && !options.before) {
    // GET only, like capture: the item pages come through the same getter.
    const get = options.base
      ? makeGetter({ base: resolveBase(options.base), key: process.env.DASHBOARD_KEY?.trim() ?? "" })
      : null;
    const { checks, table } = await scheduleCheck(args[0], { get });
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.check}  (${c.detail})`);
    for (const r of table)
      console.log(`  ${String(r.po).padEnd(9)} ${String(r.supplier ?? "—").slice(0, 28).padEnd(29)} raised ${r.raised}  ${r.expected.padEnd(12)} ${r.basis.padEnd(36)} ${r.status}  (${r.lines} line(s), ${r.units})`);
    if (!get) console.log("note: only the capture's watched item pages checked; pass --base to fetch every item with stock on order (GET only).");
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  }

  if (command === "gap" && args.length === 1 && !options.allow && !options.before) {
    // The server's own pure projection, so a match means the same code gave
    // the same answer. It is TypeScript: run this command under tsx.
    let projection;
    try {
      projection = await import("../src/insights/projection.ts");
    } catch (err) {
      fail(`stage-check gap reads src/insights/projection.ts; run it with tsx: npx tsx scripts/stage-check.mjs gap <capture> [--base …] (${err.message})`);
    }
    const get = options.base
      ? makeGetter({ base: resolveBase(options.base), key: process.env.DASHBOARD_KEY?.trim() ?? "" })
      : null;
    const { checks, counts, table } = await gapCheck(args[0], { get, projection });
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.check}  (${c.detail})`);
    console.log(
      `counts: gap ${counts.gap}, gap_open ${counts.gap_open}, covered ${counts.covered} (tight ${counts.tight}), nothing_on_order ${counts.nothing_on_order}, ` +
        `no_demand ${counts.no_demand}, built_here ${counts.built_here}, no position ${counts.none}; incoming overdue or late on ${counts.overdueItems} items`,
    );
    console.log(`${counts.notBelowLead} of the ${counts.runsOut} that run out before their next delivery are NOT flagged below lead time.`);
    for (const r of table)
      console.log(
        `  ${String(r.number).padEnd(16)} ${r.status.padEnd(8)} ${r.start} → ${r.end ?? `end unknown (${r.reason})`}` +
          `${r.days != null ? `, ${r.days} d` : ""}${r.short != null ? `, ~${r.short} short` : ""}${r.po ? `, ends on ${r.po}` : ""}${r.belowLead ? "" : "  [not below lead time]"}`,
      );
    if (!get) console.log("note: only the capture's watched item pages recomputed; pass --base to fetch every item with stock on order plus 50 others, and the filter and sort lists (GET only).");
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  }

  if (command === "splits" && args.length === 1 && !options.allow && !options.base) {
    const checks = splitCheck(args[0], { beforeDir: options.before ?? null });
    for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.check}  (${c.detail})`);
    if (!options.before) console.log("note: counted only; pass --before <the 1.3 capture> to check the header moved by exactly that.");
    process.exit(checks.every((c) => c.ok) ? 0 : 1);
  }

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
      "  node scripts/stage-check.mjs expect <before> <after> [--stage \"Stage N: …\"] > scripts/expected/<version>.json\n" +
      "  node scripts/stage-check.mjs cover <after> [--before <before>] [--base local|prod|URL]\n" +
      "  node scripts/stage-check.mjs splits <after> [--before <before>]\n" +
      "  node scripts/stage-check.mjs schedule <after> [--base local|prod|URL]\n" +
      "  npx tsx scripts/stage-check.mjs gap <after> [--base local|prod|URL]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => fail(err.message));
}
