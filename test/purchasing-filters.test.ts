/**
 * Purchasing By item filters and the minimum stock quick views (1.15).
 *
 * Allied asked for two things:
 *   - "filtering in the purchasing by item tab as an exact replica for
 *     what's on the inventory tab";
 *   - two quick views on both tabs: every product with 0 minimum stock, and
 *     every product except those.
 * These pin:
 *   - one selection (selectItems) behind Inventory's list and /items/match,
 *     so By item narrowed to a view holds exactly the order-list items
 *     Inventory lists for it;
 *   - min_zero and min_set split every item, with no minimum set reading as
 *     0, and a minimum of exactly 0 too;
 *   - By item's filter is in the address on Inventory's keys, is applied
 *     only from the server's answer, and its quick views are Inventory's.
 * No database: computeItem, selectItems and the order-list helpers are pure;
 * the rest is read from source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { computeItem, filterItems, hasMinAboveZero, selectItems } from "../src/insights/queries.js";
// @ts-ignore — plain browser module, no types
import * as ol from "../public/order-list.js";

const ROOT = join(import.meta.dirname, "..");
const dashboard = readFileSync(join(ROOT, "public/dashboard.js"), "utf8");
const queries = readFileSync(join(ROOT, "src/insights/queries.ts"), "utf8");
const routes = readFileSync(join(ROOT, "src/routes/insights.ts"), "utf8");

const WIN = { asAt: "2026-10-13", windowMonths: 6, longMonths: 12 };
const WEEKS_IN_WINDOW = (6 * 365.25) / 12 / 7;

/** An item with `free` on the shelf, selling `weekly`, with an applied minimum (null for none). */
function item(number: string, free: number, weekly: number, min: number | null, extra: Record<string, unknown> = {}) {
  return computeItem(
    {
      uid: `uid-${number}`,
      number,
      name: `${number} name`,
      on_hand: free,
      committed: 0,
      on_order: 0,
      direct_window: weekly * WEEKS_IN_WINDOW,
      direct_long: weekly * WEEKS_IN_WINDOW * 2,
      direct_year: weekly > 0 ? 1 : 0,
      primary_supplier_uid: "s",
      applied_min_level: min,
      ...extra,
    },
    WIN,
  );
}

const ITEMS = [
  item("NOMIN", 50, 10, null),
  item("ZEROMIN", 50, 10, 0),
  item("BELOW", 5, 10, 20),
  item("ABOVE", 500, 10, 20),
  item("NODEMAND", 10, 0, null),
  item("STAINLESS", 3, 10, 40, { product_finish: "STAINLESS STEEL" }),
];

const numbers = (rows: { number: string | null }[]) => rows.map((r) => r.number);

test("Min stock 0 and Min stock above 0 split every item between them", () => {
  const zero = filterItems(ITEMS, "min_zero");
  const set = filterItems(ITEMS, "min_set");
  // No minimum set (the "—" in the Min stock column) reads as 0, and so does a minimum of 0.
  assert.deepEqual(numbers(zero), ["NOMIN", "ZEROMIN", "NODEMAND"]);
  assert.deepEqual(numbers(set), ["BELOW", "ABOVE", "STAINLESS"]);
  assert.equal(zero.length + set.length, ITEMS.length);
  for (const i of zero) assert.ok(!set.includes(i));
  assert.equal(hasMinAboveZero({ minLevel: null }), false);
  assert.equal(hasMinAboveZero({ minLevel: 0 }), false);
  assert.equal(hasMinAboveZero({ minLevel: 0.5 }), true);
  // below_min is unchanged and sits inside Min stock above 0.
  assert.deepEqual(numbers(filterItems(ITEMS, "below_min")), ["BELOW", "STAINLESS"]);
  // The keys are offered on screen, beside Below min stock, and Inventory has the two quick views.
  assert.match(
    dashboard,
    /\["below_min", "Below min stock"\],\n  \["min_zero", "Min stock 0 or not set"\],\n  \["min_set", "Min stock above 0"\],/,
  );
  assert.match(dashboard, /\{ id: "min_zero", label: "Min stock 0", state: \{ filter: "min_zero" \},/);
  assert.match(dashboard, /\{ id: "min_set", label: "Min stock above 0", state: \{ filter: "min_set" \},/);
});

test("one selection behind Inventory's list and Purchasing's /items/match", () => {
  // listItems and matchItems both select through selectItems; neither filters on its own.
  const list = queries.slice(queries.indexOf("export async function listItems("), queries.indexOf("export async function matchItems("));
  const match = queries.slice(queries.indexOf("export async function matchItems("), queries.indexOf("export function hasMinAboveZero("));
  assert.match(list, /selectItems\(all, params\)/);
  assert.match(match, /selectItems\(await computedItems\(win\), params\)/);
  for (const body of [list, match]) assert.doesNotMatch(body, /applyFilter\(|\.filter\(\(r\) =>/);
  // A search, a facet and a filter together, in Inventory's order.
  const sel = selectItems(ITEMS, { q: "stain", productFinish: "STAINLESS STEEL", filter: "min_set" });
  assert.deepEqual(numbers(sel.rows), ["STAINLESS"]);
  assert.equal(sel.applied, "min_set");
  // An unknown key lists everything and says "all", as /items echoes it.
  assert.equal(selectItems(ITEMS, { filter: "later_key" }).applied, "all");
  assert.equal(selectItems(ITEMS, { filter: "later_key" }).rows.length, ITEMS.length);
  // /items/match takes /items' keys and is declared before /items/:uid, which would read "match" as a uid.
  const at = routes.indexOf('insightsRouter.get("/items/match"');
  assert.ok(at > 0 && at < routes.indexOf('insightsRouter.get("/items/:uid"'));
  const handler = routes.slice(at, routes.indexOf("});\n", at));
  for (const k of ["q", "filter", "region", "productType", "productFinish", "tag"]) assert.match(handler, new RegExp(`${k}: text\\("${k}"\\)`));
  assert.match(handler, /\.\.\.windowParams\(req\)/);
});

/** A one-supplier cart line for an item. */
function line(number: string) {
  return { itemUid: `uid-${number}`, number, supplierUid: "s", supplierName: "S", qty: 10, estCost: 5, state: "suggested", riskScore: 50, lines: [] };
}

test("By item keeps exactly the order-list rows whose item is in the server's answer", () => {
  const cart = { suppliers: [{ supplierUid: "s", lines: ["BELOW", "STAINLESS", "NOMIN", "NODEMAND"].map(line) }] };
  const rows = ol.orderByItemRows(cart);
  const answer = new Set(selectItems(ITEMS, { filter: "min_set" }).rows.map((r) => r.uid));
  const shown = ol.rowsInView(rows, answer);
  // Inventory's min_set list is BELOW, ABOVE, STAINLESS; ABOVE is not on the order list.
  assert.deepEqual(shown.map((r: { number: string }) => r.number).sort(), ["BELOW", "STAINLESS"]);
  // The rows are the cart's own, untouched; no answer means every row.
  for (const r of shown) assert.ok(rows.includes(r));
  assert.equal(ol.rowsInView(rows, null).length, rows.length);
  assert.equal(ol.rowsInView(rows, new Set()).length, 0);
  // dashboard.js narrows only from the server's answer: no filter rule of its own.
  const draw = dashboard.slice(dashboard.indexOf("function drawOrderByItemList("), dashboard.indexOf("function orderFilterBarHtml("));
  assert.match(draw, /rowsInView\(all, filtered \? orderMatch\.uids : null\)/);
  assert.doesNotMatch(draw, /minLevel|flags\.includes|supplierRegion/);
  const load = dashboard.slice(dashboard.indexOf("async function loadOrderMatch("), dashboard.indexOf("/** Draw whichever Order list view is active. */"));
  assert.match(load, /withWindow\(`\/api\/insights\/items\/match\?\$\{orderFilterQuery\(orderFilter\)\}`\)/);
  // The header still counts the whole order list.
  const page = dashboard.slice(dashboard.indexOf("function drawOrderByItem("), dashboard.indexOf("function drawOrderByItemList("));
  assert.match(page, /const sum = orderListSummary\(d, orderByItemRows\(d\)\);/);
});

test("By item's filter is in the address on Inventory's keys, beside the sort", () => {
  const none = { ...ol.ORDER_FILTER_DEFAULTS };
  assert.equal(ol.orderFilterQuery(none), "");
  assert.equal(ol.orderFilterActive(none), false);
  assert.equal(ol.orderViewQuery({ sort: "risk", dir: "" }, none), "", "the default writes nothing");
  const view = { q: "bolt", filter: "min_zero", region: "China", productType: "BOLT", productFinish: "GALV", tag: "kits" };
  const qs = ol.orderFilterQuery(view);
  assert.equal(qs, "q=bolt&filter=min_zero&region=China&productType=BOLT&productFinish=GALV&tag=kits");
  assert.deepEqual(ol.parseOrderFilter(qs), view);
  assert.equal(ol.orderViewQuery({ sort: "cover", dir: "asc" }, { ...none, filter: "below_min" }), "filter=below_min&sort=cover&dir=asc");
  // A query sets the whole view; what it leaves out is the default. A 1.7 sort bookmark opens unfiltered.
  assert.deepEqual(ol.parseOrderFilter("sort=cover&dir=asc"), none);
  assert.deepEqual(ol.parseOrderSort("filter=below_min&sort=cover&dir=asc"), { sort: "cover", dir: "asc" });
  assert.deepEqual(ol.parseOrderFilter(undefined), none);
  // "all" is the default filter and is never written.
  assert.equal(ol.orderFilterQuery({ ...none, filter: "all" }), "");
  // The keys are Inventory's: the address builder and the server read the same names.
  for (const k of Object.keys(ol.ORDER_FILTER_DEFAULTS)) {
    assert.match(dashboard, new RegExp(`invState\\.${k} = p\\.get\\("${k}"\\)`), `${k} is not an Inventory address key`);
  }
  // route() applies it with the sort; the redraw writes both back.
  assert.match(dashboard, /Object\.assign\(orderFilter, parseOrderFilter\(queryString\)\);/);
  assert.match(dashboard, /const qs = orderViewQuery\(orderSort, orderFilter\);/);
});

test("By item's quick views and filter bar are Inventory's", () => {
  const start = dashboard.indexOf("const INVENTORY_PRESETS = [");
  const presets = [...dashboard.slice(start, dashboard.indexOf("\n];", start)).matchAll(/state: \{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(presets.length, 8);
  // Every quick view's sort maps to By item's: its own where By item has the
  // column, else the default order. Stock value has no By item column.
  for (const p of presets) {
    const sort = /sort: "([a-z_]+)"/.exec(p)?.[1];
    const dir = /dir: "([a-z]+)"/.exec(p)?.[1];
    const mapped = ol.presetOrderSort(sort, dir);
    assert.ok(ol.PURCHASING_SORTS[mapped.sort], `${sort} maps to an unknown By item sort`);
    if (sort && ol.PURCHASING_SORTS[sort]) assert.deepEqual(mapped, { sort, dir: dir ?? "" });
    else assert.deepEqual(mapped, { sort: "risk", dir: "" });
  }
  assert.deepEqual(ol.presetOrderSort("value", "desc"), { sort: "risk", dir: "" });
  assert.deepEqual(ol.presetOrderSort("cover", "asc"), { sort: "cover", dir: "asc" });
  // One list of filters, regions and quick views for both tabs.
  const bar = dashboard.slice(dashboard.indexOf("function orderFilterBarHtml("), dashboard.indexOf("function orderFilterBits("));
  assert.match(bar, /presetButtonsHtml\("data-obi-preset"\)/);
  assert.match(bar, /INVENTORY_FILTERS\.map/);
  assert.match(bar, /INVENTORY_REGIONS\.map/);
  const inv = dashboard.slice(dashboard.indexOf("async function renderInventory("), dashboard.indexOf("/** Items on the current inventory page"));
  assert.match(inv, /presetButtonsHtml\("data-preset"\)/);
  assert.match(inv, /INVENTORY_REGIONS\.map/);
  // Inventory's region choices are the ones it always offered.
  assert.match(
    dashboard,
    /const INVENTORY_REGIONS = \[\n  \["", "All regions"\],\n  \["NZ", "Region: NZ"\],\n  \["Australia", "Region: Australia"\],\n  \["China", "Region: China"\],\n  \["Overseas — other", "Region: Overseas — other"\],\n  \["none", "Region: unlabelled"\],\n\];/,
  );
  // The filter state is declared before the first route(), like the sort.
  const boot = dashboard.search(/^route\(\);$/m);
  for (const name of ["orderFilter", "orderMatch", "orderMatchSeq"]) {
    const at = dashboard.search(new RegExp(`^(?:let|const) ${name}\\b`, "m"));
    assert.ok(at >= 0 && at < boot, `${name} must be declared before the first route() call`);
  }
});

/*
 * Found by the pre-deploy review (18 Oct 2026). Splitting the rows out of
 * drawOrderByItem left the rows' own Use preferred / Keep unwired: the panel
 * above is wired by wireOrderListCommon before the rows exist. A write that
 * landed while someone typed in the search box redrew the bar and lost the
 * typing. And the two new Inventory filters had no guard for a server that
 * ignores them (a rollback), as cover_lt2 has.
 */
test("By item's rows wire their own Use preferred / Keep, and the bar survives a write", () => {
  const list = dashboard.slice(dashboard.indexOf("function drawOrderByItemList("), dashboard.indexOf("function orderFilterBarHtml("));
  const wired = list.indexOf("wirePickConflictButtons(el);");
  assert.ok(wired > list.indexOf("el.innerHTML = `") && wired < list.indexOf("wireOrderByItem(cols);"), "rows' pick buttons wired after they are drawn");
  // wireOrderListCommon wires only what is drawn before the rows, so nothing is bound twice.
  const page = dashboard.slice(dashboard.indexOf("function drawOrderByItem("), dashboard.indexOf("function drawOrderByItemList("));
  assert.ok(page.indexOf("wireOrderListCommon();") < page.indexOf("drawOrderByItemList();"));
  assert.match(page, /<div id="obi-list"><\/div>`;/);
  // The bar on screen is moved into the redrawn page, focus and caret kept; rebuilt only on request.
  assert.match(page, /const bar = rebuildBar \? null : document\.getElementById\("obi-bar"\);/);
  assert.match(page, /main\.querySelector\("#obi-bar-slot"\)\.replaceWith\(bar\);/);
  assert.match(page, /focus\.setSelectionRange\(caret\[0\], caret\[1\]\)/);
  assert.match(dashboard, /if \(whole\) return drawOrderByItem\(true\);/);
  assert.match(dashboard, /if \(!q\.isConnected\) return;\n      orderFilter\.q = q\.value;/);
  assert.match(fnBodyOf("orderFilterBarHtml"), /<div id="obi-bar">/);
});

test("Inventory's min stock filters say so when the server ignores them", () => {
  assert.match(dashboard, /const MIN_ZERO_FILTERS = new Set\(\["min_zero", "min_set"\]\);/);
  assert.match(dashboard, /\(MIN_ZERO_FILTERS\.has\(invState\.filter\) && data\.filter !== invState\.filter\);/);
});

function fnBodyOf(name: string): string {
  const start = dashboard.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `dashboard.js has no function ${name}`);
  const rest = dashboard.slice(start + 1);
  const end = rest.search(/^(?:async function |function |const |let |\/\*)/m);
  return end < 0 ? rest : rest.slice(0, end);
}
