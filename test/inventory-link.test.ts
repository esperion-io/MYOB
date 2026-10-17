/**
 * Inventory small fixes (1.14).
 *
 * The Overview's tiles promise a list: click the number, get that many items.
 * Two things broke the promise. "Cover < 2 weeks" opened low_cover (under 4
 * weeks), 322 items behind a tile reading 303 on the 26 Aug copy; and every
 * tile set only the filter, keeping whatever search, region, facet and sort
 * the last visit to Inventory left. These pin:
 *   - cover_lt2 lists exactly what the Overview's coverUnder2w counts (one
 *     predicate), at the 2-week boundary too, and low_cover is unchanged;
 *   - every Overview tile opens a filter the screen offers and the server
 *     knows, through the pure tile helper, whose address carries the filter
 *     and nothing else, so the route resets everything a tab left behind;
 *   - "Used in" shows the figure it sorts by, max(deep, direct), and a server
 *     without parentCountDeep still shows the direct count;
 *   - the Inventory subtitle no longer calls platform figures MYOB facts.
 * No database: computeItem and filterItems are pure, the rest is read from
 * source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeItem, coverUnderTwoWeeks, filterItems } from "../src/insights/queries.js";
// @ts-ignore — plain browser module, no types
import * as inv from "../public/inventory.js";

const ROOT = join(import.meta.dirname, "..");
const dashboard = readFileSync(join(ROOT, "public/dashboard.js"), "utf8");
const queries = readFileSync(join(ROOT, "src/insights/queries.ts"), "utf8");

const WIN = { asAt: "2026-10-13", windowMonths: 6, longMonths: 12 };
const WEEKS_IN_WINDOW = (6 * 365.25) / 12 / 7;

/** An item with `free` on the shelf selling `weekly` a week. */
function item(number: string, free: number, weekly: number) {
  return computeItem(
    {
      uid: number,
      number,
      on_hand: free,
      committed: 0,
      on_order: 0,
      direct_window: weekly * WEEKS_IN_WINDOW,
      direct_long: weekly * WEEKS_IN_WINDOW * 2,
      direct_year: weekly > 0 ? 1 : 0,
      primary_supplier_uid: "s",
    },
    WIN,
  );
}

// Cover 0, 1.9, 1.94 (-> 1.9), 1.96 (-> 2.0), 2, 3.5, 5 weeks, a negative
// shelf (cover 0) and no demand (no cover).
const ITEMS = [
  item("ZERO", 0, 10),
  item("C19", 19, 10),
  item("C194", 194, 100),
  item("C196", 196, 100),
  item("C2", 20, 10),
  item("C35", 35, 10),
  item("C5", 50, 10),
  item("NEG", -5, 10),
  item("NODEMAND", 40, 0),
];

const numbers = (rows: { number: string | null }[]) => rows.map((r) => r.number);

test("cover_lt2 lists exactly what the Overview's Cover < 2 weeks counts", () => {
  assert.deepEqual(
    ITEMS.map((i) => i.coverWeeks),
    [0, 1.9, 1.9, 2, 2, 3.5, 5, 0, null],
  );
  const listed = filterItems(ITEMS, "cover_lt2");
  // The served cover, 1 dp, as the tile always counted: 1.96 shows as 2.0w
  // and is not on either.
  assert.deepEqual(numbers(listed), ["ZERO", "C19", "C194", "NEG"]);
  assert.deepEqual(numbers(listed), numbers(ITEMS.filter(coverUnderTwoWeeks)));
  // low_cover, which the tile used to open, is still under 4 weeks.
  assert.deepEqual(numbers(filterItems(ITEMS, "low_cover")), ["ZERO", "C19", "C194", "C196", "C2", "C35", "NEG"]);
  // An unknown key still lists everything (an older tab's bookmark).
  assert.equal(filterItems(ITEMS, "no_such_filter").length, ITEMS.length);
  assert.equal(filterItems(ITEMS, undefined).length, ITEMS.length);

  // The Overview counts with the same predicate, and listItems filters
  // through filterItems after the search, facets and region.
  const ov = queries.slice(queries.indexOf("export async function overview("), queries.indexOf("async function relationshipRows("));
  assert.match(ov, /const lowCover = items\.filter\(coverUnderTwoWeeks\);/);
  assert.match(ov, /coverUnder2w: lowCover\.length,/);
  // From 1.15 the search, facets, region and filter run in selectItems,
  // which listItems (and Purchasing's /items/match) select through.
  const select = queries.slice(queries.indexOf("export function selectItems("), queries.indexOf("export async function listItems("));
  assert.match(select, /if \(params\.region\) \{[\s\S]*?\}\n\n  return applyFilter\(rows, params\.filter\);\n\}/);
  const list = queries.slice(queries.indexOf("export async function listItems("), queries.indexOf("export async function matchItems("));
  assert.match(list, /const filtered = selectItems\(all, params\);\n  let rows = filtered\.rows;\n\n  const sortKey =/);
  // And says which filter it applied, which a 1.14 tab reads for cover_lt2.
  assert.match(list, /\n    filter: filtered\.applied,\n/);
  assert.match(queries, /    default:\n      return \{ rows, applied: "all" \};\n  \}\n  return \{ rows, applied: filter \};\n\}/);
  // A server before 1.14 sends no echo, so the summary drops the filter
  // whatever the sort: not a guess from the first page.
  assert.match(dashboard, /\(invState\.filter === "cover_lt2" && data\.filter !== "cover_lt2"\)/);
  assert.doesNotMatch(list, /switch \(/);
});

/** The `data-filter` of every Overview tile that links to Inventory. */
function tileFilters(): string[] {
  const ov = dashboard.slice(dashboard.indexOf("async function renderOverview("), dashboard.indexOf("async function renderInventory("));
  // Only the tiles carry data-filter there, and every one is a .kpi.link.
  assert.equal((ov.match(/data-filter="/g) ?? []).length, (ov.match(/<div class="kpi link[ "]/g) ?? []).length);
  return [...ov.matchAll(/data-filter="([a-z_0-9]+)"/g)].map((m) => m[1]);
}

function keysOf(name: string): string[] {
  const start = dashboard.indexOf(`const ${name} = [`);
  assert.ok(start >= 0, `${name} not found in dashboard.js`);
  return [...dashboard.slice(start, dashboard.indexOf("\n];", start)).matchAll(/^\s*\["([a-z_0-9]+)",/gm)].map((m) => m[1]);
}

test("every Overview tile opens a filter the screen offers and the server knows", () => {
  const tiles = tileFilters();
  assert.deepEqual(tiles, ["below_min", "cover_lt2", "suggested", "gap", "negative", "parents", "excess"]);
  const offered = keysOf("INVENTORY_FILTERS");
  // Beside low_cover, which keeps its own meaning.
  assert.equal(offered.indexOf("cover_lt2") + 1, offered.indexOf("low_cover"));
  assert.match(dashboard, /\["cover_lt2", "Cover under 2 weeks"\],\n  \["low_cover", "Cover under 4 weeks \(about a month\)"\],/);
  const fn = queries.slice(queries.indexOf("export function filterItems("), queries.indexOf("export async function overview("));
  for (const k of tiles) {
    assert.ok(offered.includes(k), `tile filter ${k} is not in INVENTORY_FILTERS`);
    assert.ok(fn.includes(`case "${k}":`), `tile filter ${k} has no case in filterItems`);
  }
});

test("a tile's address carries its filter and nothing a tab left behind", () => {
  for (const f of tileFilters()) {
    const hash = inv.overviewTileHash(f);
    assert.equal(hash, `#/inventory?filter=${f}`);
    // The route reads the whole view from an address with a query, so a
    // search, region, facet, tag, sort or page left in the tab can't survive.
    const p = new URLSearchParams(hash.split("?")[1]);
    assert.deepEqual([...p.keys()], ["filter"]);
  }
  const dirty = { q: "bolt", filter: "all", region: "China", sort: "value", dir: "asc", page: 4, productType: "BOLT", productFinish: "GALV", tag: "kits" };
  const state = { ...dirty, ...inv.overviewTileState("suggested") };
  assert.deepEqual(state, { q: "", filter: "suggested", region: "", sort: "risk", dir: "", page: 1, productType: "", productFinish: "", tag: "" });
  assert.deepEqual(inv.overviewTileState("suggested"), { ...inv.INVENTORY_DEFAULTS, filter: "suggested" });
  assert.equal(inv.overviewTileHash(""), "#/inventory");

  // The click handler takes both from the helper, and no longer sets the
  // filter alone on a bare #/inventory.
  const ov = dashboard.slice(dashboard.indexOf("async function renderOverview("), dashboard.indexOf("async function renderInventory("));
  assert.match(ov, /Object\.assign\(invState, overviewTileState\(el\.dataset\.filter\)\);\n\s*location\.hash = overviewTileHash\(el\.dataset\.filter\);/);
  assert.doesNotMatch(ov, /invState\.filter = el\.dataset\.filter/);
  assert.doesNotMatch(ov, /location\.hash = "#\/inventory"/);
});

test("inventoryHashFor writes the address Inventory always wrote", () => {
  // The 1.13 inventoryHash, kept here to hold the moved builder to it.
  function before(s: Record<string, any>) {
    const p = new URLSearchParams();
    if (s.q) p.set("q", s.q);
    if (s.filter && s.filter !== "all") p.set("filter", s.filter);
    if (s.region) p.set("region", s.region);
    if (s.sort && s.sort !== "risk") p.set("sort", s.sort);
    if (s.dir) p.set("dir", s.dir);
    if (s.productType) p.set("productType", s.productType);
    if (s.productFinish) p.set("productFinish", s.productFinish);
    if (s.tag) p.set("tag", s.tag);
    if (s.page > 1) p.set("page", String(s.page));
    const qs = p.toString();
    return `#/inventory${qs ? `?${qs}` : ""}`;
  }
  const states = [
    inv.INVENTORY_DEFAULTS,
    { ...inv.INVENTORY_DEFAULTS, q: "bolt & nut", region: "Overseas — other", sort: "cover", dir: "asc", page: 3 },
    { ...inv.INVENTORY_DEFAULTS, filter: "gap", productType: "(not set)", productFinish: "STAINLESS", tag: "#kits" },
    { ...inv.INVENTORY_DEFAULTS, sort: "risk", filter: "all", page: 1 },
  ];
  for (const s of states) assert.equal(inv.inventoryHashFor(s), before(s));
  assert.match(dashboard, /function inventoryHash\(\) \{\n  return inventoryHashFor\(invState\);\n\}/);
});

test("Used in shows the figure it sorts by, counting sub-assemblies", () => {
  // BN1665G on the 26 Aug copy: 2 products directly, 13 in all.
  assert.equal(inv.usedInCount({ parentCount: 2, parentCountDeep: 13 }), 13);
  assert.equal(inv.usedInTitle({ parentCount: 2, parentCountDeep: 13 }), "Used in 13 products, counting sub-assemblies: 2 directly, 11 more via sub-assemblies");
  assert.equal(inv.usedInCount({ parentCount: 3, parentCountDeep: 3 }), 3);
  assert.equal(inv.usedInTitle({ parentCount: 1, parentCountDeep: 1 }), "Used in 1 product, counting sub-assemblies (all directly)");
  assert.equal(inv.usedInCount({ parentCount: 0, parentCountDeep: 0 }), 0);
  assert.equal(inv.usedInTitle({ parentCount: 0, parentCountDeep: 0 }), "Not used in any product");
  // A server without parentCountDeep: the direct count, as before.
  assert.equal(inv.usedInCount({ parentCount: 4 }), 4);
  // The sort key is the same max.
  assert.match(queries, /^  used_in: \(i\) => Math\.max\(i\.parentCountDeep, i\.parentCount\),$/m);
  // The Inventory cell shows it, with the tooltip; the direct count is gone from it.
  assert.match(dashboard, /<td class="num" title="\$\{esc\(usedInTitle\(i\)\)\}">\$\{usedInCount\(i\) \|\| "—"\}<\/td>/);
  assert.doesNotMatch(dashboard, /<td class="num">\$\{i\.parentCount \|\| "—"\}<\/td>/);
});

test("the Inventory subtitle calls position figures the platform's", () => {
  const inventory = dashboard.slice(dashboard.indexOf("async function renderInventory("), dashboard.indexOf("/** Items on the current inventory page"));
  assert.match(inventory, /<p class="page-sub">[^<]*platform figures built from MYOB transactions\.<\/p>/);
  assert.doesNotMatch(inventory, /MYOB facts/);
});

test("Export this list follows the view: its link is rebuilt on every table load", () => {
  // Fixed in 1.3; 1.14 only checks it stayed fixed. inventoryCsvUrl carries
  // the search, filter, region, sort, direction, facets and the date.
  const load = dashboard.slice(dashboard.indexOf("async function loadInventoryTable("), dashboard.indexOf("/*\n * The minimum stock level and how it was reached"));
  assert.match(load, /const exportLink = document\.getElementById\("inv-export"\);\n  if \(exportLink\) exportLink\.href = inventoryCsvUrl\(\);/);
  const csv = dashboard.slice(dashboard.indexOf("function inventoryCsvUrl("), dashboard.indexOf("function suppliersCsvUrl("));
  for (const k of ["q: invState.q", "filter: invState.filter", "region: invState.region", "sort: invState.sort", 'p.set("dir", invState.dir)', 'p.set("productType"', 'p.set("productFinish"', 'p.set("tag"', "asAt: windowState.asAt"])
    assert.ok(csv.includes(k), `inventoryCsvUrl lacks ${k}`);
});
