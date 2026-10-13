/**
 * Cover excl. / incl. on order (1.3).
 *
 * Allied asked for cover that counts stock on order beside the cover that
 * does not. The figure already existed inside computeItem, where it decides
 * the cover_below_lead_time flag, but was never returned. These pin what 1.3
 * returns and what it must leave alone:
 *   - coverWeeksInclOnOrder is Available ÷ weekly to 1 dp, null exactly when
 *     coverWeeks is, never below it, and equal to it with nothing on order;
 *   - the flag keeps reading the unrounded figure, so a displayed 1.0w can sit
 *     under a 1.0w lead and still be flagged;
 *   - every filter and sort key the Inventory screen offers exists on the
 *     server (an unknown filter lists everything, an unknown sort falls back
 *     to risk, both silently), and the CSV only gains a last column;
 *   - `stage-check cover`, the acceptance check run on a capture, passes a
 *     consistent capture and fails what a 1.2 server or a moved cell serves.
 * No database: computeItem is pure over one row, and the rest is read from
 * source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { computeItem } from "../src/insights/queries.js";
import { coverChecks } from "../scripts/stage-check.mjs";

const WIN = { asAt: "2026-10-13", windowMonths: 6, longMonths: 12 };
const WEEKS_IN_WINDOW = (6 * 365.25) / 12 / 7;

/** A row selling `weekly` a week over the 6-month window. */
function row(o: { onHand: number; committed?: number; onOrder?: number; weekly: number; leadDays?: number | null }) {
  return {
    uid: "u",
    number: "X",
    on_hand: o.onHand,
    committed: o.committed ?? 0,
    on_order: o.onOrder ?? 0,
    direct_window: o.weekly * WEEKS_IN_WINDOW,
    direct_long: o.weekly * WEEKS_IN_WINDOW * 2,
    direct_year: o.weekly > 0 ? 1 : 0,
    lead_time_days: o.leadDays ?? null,
    primary_supplier_uid: "s",
  };
}

test("BN1665G as at 13 Oct: 1.9w excl., 14.0w incl., below a 17.1w lead", () => {
  // 323 free, 2,000 on order, 166.4 a week, Hanova 120 days.
  const i = computeItem(row({ onHand: 323, onOrder: 2000, weekly: 166.4, leadDays: 120 }), WIN);
  assert.equal(i.coverWeeks, 1.9);
  assert.equal(i.coverWeeksInclOnOrder, 14.0);
  assert.equal(i.leadTimeWeeks, 17.1);
  assert.equal(i.coverBelowLeadTime, true);
  assert.ok(i.flags.includes("cover_below_lead_time"));
});

test("incl. is Available ÷ weekly, never below excl., equal with nothing on order", () => {
  const withPo = computeItem(row({ onHand: 900, committed: 100, onOrder: 1200, weekly: 50, leadDays: 30 }), WIN);
  assert.equal(withPo.qtyAvailable, 2000);
  assert.equal(withPo.coverWeeksInclOnOrder, 40);
  assert.equal(withPo.coverWeeks, 16);
  assert.equal(withPo.coverBelowLeadTime, false);

  const noPo = computeItem(row({ onHand: 900, committed: 100, weekly: 50 }), WIN);
  assert.equal(noPo.coverWeeksInclOnOrder, noPo.coverWeeks);
});

test("no demand gives null for both; a negative position gives 0, not a negative cover", () => {
  const idle = computeItem(row({ onHand: 500, onOrder: 100, weekly: 0 }), WIN);
  assert.equal(idle.coverWeeks, null);
  assert.equal(idle.coverWeeksInclOnOrder, null);

  const short = computeItem(row({ onHand: 10, committed: 400, onOrder: 100, weekly: 20, leadDays: 14 }), WIN);
  assert.equal(short.qtyAvailable, -290);
  assert.equal(short.coverWeeksInclOnOrder, 0);
  assert.equal(short.coverWeeks, 0);
  assert.equal(short.coverBelowLeadTime, true);
});

test("the flag reads the unrounded figure: 0.96w shows as 1w and is still under a 1w lead", () => {
  const i = computeItem(row({ onHand: 96, weekly: 100, leadDays: 7 }), WIN);
  assert.equal(i.coverWeeksInclOnOrder, 1);
  assert.equal(i.leadTimeWeeks, 1);
  assert.equal(i.coverBelowLeadTime, true);
});

test("no lead time: the figure is returned and nothing is flagged", () => {
  const i = computeItem(row({ onHand: 10, weekly: 100, leadDays: null }), WIN);
  assert.equal(i.coverWeeksInclOnOrder, 0.1);
  assert.equal(i.coverBelowLeadTime, false);
});

const queries = readFileSync(new URL("../src/insights/queries.ts", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");

/** The [key, label] pairs of a `const NAME = [ ... ];` list in dashboard.js. */
function keysOf(name: string): string[] {
  const start = dashboard.indexOf(`const ${name} = [`);
  assert.ok(start >= 0, `${name} not found in dashboard.js`);
  const body = dashboard.slice(start, dashboard.indexOf("\n];", start));
  return [...body.matchAll(/^\s*\["([a-z_]+)",/gm)].map((m) => m[1]);
}

test("every Inventory filter and sort the screen offers exists on the server", () => {
  const filters = keysOf("INVENTORY_FILTERS").filter((k) => k !== "all");
  assert.ok(filters.includes("below_lead"));
  for (const k of filters) assert.ok(queries.includes(`case "${k}":`), `filter ${k} has no case in listItems`);

  const sortBlock = queries.slice(queries.indexOf("const SORT_VALUES"), queries.indexOf("const SORT_DEFAULT_DIR"));
  const sorts = keysOf("INVENTORY_SORTS");
  assert.ok(sorts.includes("cover_incl"));
  for (const k of sorts) assert.match(sortBlock, new RegExp(`^\\s*${k}: \\(i\\)`, "m"), `sort ${k} not in SORT_VALUES`);
  const dirBlock = queries.slice(queries.indexOf("const SORT_DEFAULT_DIR"), queries.indexOf("};", queries.indexOf("const SORT_DEFAULT_DIR")));
  assert.match(dirBlock, /cover_incl: "asc"/);
});

test("the flag has a label, and items.csv only gains a last column", () => {
  assert.match(dashboard, /cover_below_lead_time: \["Below lead time", "fail"\]/);
  const header = queries.slice(queries.indexOf("const header = [", queries.indexOf("export async function itemsCsv")));
  const cols = [...header.slice(0, header.indexOf("];")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(cols.at(-1), "Cover incl. on order (weeks)");
  assert.deepEqual(cols.slice(-5, -1), ["Reference point", "Reference date", "MYOB on hand", "Difference vs MYOB"]);
  assert.equal(cols.indexOf("Cover (weeks)"), 21);
});

/* ---------- stage-check cover ---------- */

const demand = (weekly: number) => ({ basis: weekly > 0 ? "window" : "none", directWindow: weekly * WEEKS_IN_WINDOW, componentWindow: 0, directLong: 0, componentLong: 0, windowMonths: 6, longMonths: 12, weekly: Number(weekly.toFixed(3)) });
const good = [
  { uid: "a", number: "A", qtyAvailable: 2323, qtyOnOrder: 2000, demand: demand(166.4), coverWeeks: 1.9, coverWeeksInclOnOrder: 14, coverBelowLeadTime: true },
  { uid: "b", number: "B", qtyAvailable: 50, qtyOnOrder: 0, demand: demand(10), coverWeeks: 5, coverWeeksInclOnOrder: 5, coverBelowLeadTime: false },
  { uid: "c", number: "C", qtyAvailable: 50, qtyOnOrder: 0, demand: demand(0), coverWeeks: null, coverWeeksInclOnOrder: null, coverBelowLeadTime: false },
];
const failed = (checks: { check: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.check);

test("stage-check cover passes a consistent 1.3 capture", () => {
  const before = "﻿Item number,Supplier,Cover (weeks)\r\nA,S,1.9\r\nB,S,5\r\nC,S,\r\n";
  const after = "﻿Item number,Supplier,Cover (weeks),Cover incl. on order (weeks)\r\nA,S,1.9,14\r\nB,S,5,5\r\nC,S,,\r\n";
  const checks = coverChecks({
    items: good, csv: after, beforeCsv: before,
    belowLead: { rows: [good[0]], dir: "asc" },
    sortedIncl: { rows: [good[1], good[0], good[2]], dir: "asc" },
  });
  assert.deepEqual(failed(checks), []);
  assert.equal(checks.length, 9);
});

test("stage-check cover fails a 1.2 server, a wrong figure, a moved CSV cell and a bad sort", () => {
  const old = good.map(({ coverWeeksInclOnOrder: _x, ...i }) => i);
  assert.ok(failed(coverChecks({ items: old, csv: null })).includes("every item carries coverWeeksInclOnOrder (a 1.3 server)"));

  const wrong = [{ ...good[0], coverWeeksInclOnOrder: 14.2 }, good[1], good[2]];
  assert.deepEqual(failed(coverChecks({ items: wrong, csv: null })), ["|incl × weekly − max(Available, 0)| ≤ 0.05 × weekly"]);

  const before = "Item number,Supplier,Cover (weeks)\r\nA,S,1.9\r\nB,S,5\r\nC,S,\r\n";
  const moved = "Item number,Supplier,Cover (weeks),Cover incl. on order (weeks)\r\nA,S,2,14\r\nB,S,5,5\r\nC,S,,\r\n";
  assert.deepEqual(failed(coverChecks({ items: good, csv: moved, beforeCsv: before })), ["every existing items.csv column byte-identical"]);

  // What a 1.2 server serves for the new keys: everything for the filter, risk order for the sort.
  const checks = coverChecks({ items: good, csv: null, belowLead: { rows: good, dir: "desc" }, sortedIncl: { rows: [good[0], good[1], good[2]], dir: "desc" } });
  assert.deepEqual(failed(checks), ["filter=below_lead lists exactly the coverBelowLeadTime items", "sort=cover_incl: lowest first, non-decreasing, blanks last"]);
});
