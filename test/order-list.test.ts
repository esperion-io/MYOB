/**
 * Purchasing groundwork (1.5): the Order list regrouped by item, and the
 * refactors the by-item view (1.6) builds on.
 *
 * groupLinesByItem is the only place the browser turns /cart's supplier
 * groups into one row per item. The by-item view leads with its totals, so a
 * line dropped, counted twice, or a split counted as one part would show
 * Allied a different order from the one the order sheets send. These pin:
 *   - every line lands in exactly one row, and rows = distinct items;
 *   - per item and overall, qty and est. cost are the sums of the lines;
 *   - a split's parts add up into one row, and the row keeps the parts;
 *   - options are taken once per item, and the item's stock fields are carried;
 *   - an empty cart (and a 1.4 server's lines, without the 1.5 fields) works;
 *   - the module is DOM-free and free of the names the ledger guard bans;
 *   - in dashboard.js, every /cart re-fetch goes through reloadOrderList and
 *     the expand panel no longer reads Inventory's globals.
 * And the By item view (1.6) drawn from it, further down: its columns, its
 * order, what each Supplier and Order qty cell says, and that it lists the
 * same (item, supplier, qty) set as By supplier.
 * No database: public/order-list.js is a plain browser module, imported as is.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-ignore — plain browser module, no types
import {
  BY_ITEM_COLUMNS,
  byRiskThenNumber,
  groupLinesByItem,
  orderByItemRows,
  orderListSummary,
  qtyCell,
  rowLeadTimes,
  supplierCell,
  supplierRole,
} from "../public/order-list.js";

interface Line {
  itemUid: string;
  number: string;
  supplierUid: string;
  state: string;
  qty: number;
  estCost: number;
  [k: string]: unknown;
}

/** One cart line, with the item-level fields 1.5 serves, as purchaseCart builds it. */
function line(itemUid: string, supplierUid: string, state: string, qty: number, unit: number, over: Record<string, unknown> = {}): Line {
  return {
    itemUid,
    number: itemUid,
    name: `${itemUid} name`,
    productFinish: null,
    supplierUid,
    supplierName: supplierUid,
    state,
    qty,
    estCost: qty * unit,
    onHand: 946,
    qtyCommitted: 0,
    freeStock: 946,
    incomingQty: 2000,
    minLevel: 1500,
    weeklyDemand: 111.2,
    coverWeeks: 8.5,
    coverWeeksInclOnOrder: 26.5,
    coverBelowLeadTime: false,
    riskScore: 40,
    suggestedQty: qty,
    averageCost: unit,
    options: [{ supplierUid: "OPTS-" + itemUid }],
    preferredSupplierUid: null,
    preferredSupplierName: null,
    conflict: null,
    kitForm: null,
    kitDoubleOrder: false,
    ...over,
  };
}

/** Lines grouped per supplier, highest subtotal first, the way /cart serves them. */
function cart(lines: Line[]) {
  const groups = new Map<string, { supplierUid: string; estimatedCost: number; lines: Line[] }>();
  for (const l of lines) {
    const g = groups.get(l.supplierUid) ?? { supplierUid: l.supplierUid, estimatedCost: 0, lines: [] };
    g.lines.push(l);
    g.estimatedCost += l.estCost;
    groups.set(l.supplierUid, g);
  }
  return { suppliers: [...groups.values()].sort((a, b) => b.estimatedCost - a.estimatedCost) };
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

// A mixed cart: plain one-line items, FG250P split 142/142, a three-way split,
// an item kept under two suppliers by a saved qty, and a picked supplier.
const MIXED = [
  line("BN1665G", "HANOVA", "suggested", 1779, 0.21),
  line("SPW12G", "HANOVA", "edited", 3600, 0.05),
  line("FG250P", "SKELLERUP", "split", 142, 1.5),
  line("FG250P", "SPECIALISED WASHERS", "split", 142, 1.25),
  line("SPLIT3", "A", "split", 100, 2),
  line("SPLIT3", "B", "split", 40, 2.1),
  line("SPLIT3", "HANOVA", "split", 10, 1.9),
  line("TWOLINE", "A", "edited", 50, 3),
  line("TWOLINE", "B", "suggested", 50, 2.5),
  line("B20140S16", "TONG MING", "selected", 500, 0.7),
];

test("every line appears in exactly one row, and there is one row per distinct item", () => {
  const c = cart(MIXED);
  const rows = groupLinesByItem(c);
  const served = c.suppliers.flatMap((g) => g.lines);
  const grouped = rows.flatMap((r: { lines: Line[] }) => r.lines);
  assert.equal(grouped.length, served.length);
  assert.equal(new Set(grouped).size, served.length, "a line was counted twice");
  for (const l of served) assert.ok(grouped.includes(l), `line ${l.itemUid}|${l.supplierUid} is missing`);
  assert.equal(rows.length, new Set(served.map((l) => l.itemUid)).size);
  for (const r of rows) {
    assert.ok(r.lines.every((l: Line) => l.itemUid === r.itemUid), "a row holds another item's line");
    assert.equal(r.lineCount, r.lines.length);
  }
});

test("qty and est. cost are the sums of each item's lines, and add up to the cart's", () => {
  const c = cart(MIXED);
  const rows = groupLinesByItem(c);
  const served = c.suppliers.flatMap((g) => g.lines);
  for (const r of rows) {
    const mine = served.filter((l) => l.itemUid === r.itemUid);
    assert.equal(r.qty, mine.reduce((a, l) => a + l.qty, 0));
    close(r.estCost, mine.reduce((a, l) => a + l.estCost, 0));
  }
  close(
    rows.reduce((a: number, r: { estCost: number }) => a + r.estCost, 0),
    c.suppliers.reduce((a, g) => a + g.estimatedCost, 0),
  );
  assert.equal(
    rows.reduce((a: number, r: { qty: number }) => a + r.qty, 0),
    served.reduce((a, l) => a + l.qty, 0),
  );
});

test("a split's parts add up into one row that keeps the parts", () => {
  const rows = groupLinesByItem(cart(MIXED));
  const fg = rows.find((r: { itemUid: string }) => r.itemUid === "FG250P");
  assert.equal(fg.split, true);
  assert.equal(fg.qty, 284);
  close(fg.estCost, 142 * 1.5 + 142 * 1.25); // 390.50, the 1.4 header's figure
  assert.deepEqual(fg.lines.map((l: Line) => l.supplierUid).sort(), ["SKELLERUP", "SPECIALISED WASHERS"]);
  const three = rows.find((r: { itemUid: string }) => r.itemUid === "SPLIT3");
  assert.equal(three.qty, 150);
  assert.equal(three.lineCount, 3);
  // Not a split: two saved lines are still summed, as the order sheets send both.
  const two = rows.find((r: { itemUid: string }) => r.itemUid === "TWOLINE");
  assert.equal(two.split, false);
  assert.equal(two.qty, 100);
  close(two.estCost, 275);
  const one = rows.find((r: { itemUid: string }) => r.itemUid === "BN1665G");
  assert.equal(one.split, false);
  assert.equal(one.lineCount, 1);
});

test("options are taken once per item, and the item's stock fields are carried", () => {
  const rows = groupLinesByItem(cart(MIXED));
  const fg = rows.find((r: { itemUid: string }) => r.itemUid === "FG250P");
  assert.deepEqual(fg.options, [{ supplierUid: "OPTS-FG250P" }]);
  assert.equal(fg.options, fg.lines[0].options, "options are the item's, not a merge of every line's");
  for (const k of [
    "onHand", "qtyCommitted", "freeStock", "incomingQty", "minLevel", "weeklyDemand",
    "coverWeeks", "coverWeeksInclOnOrder", "coverBelowLeadTime", "riskScore", "suggestedQty",
  ]) assert.equal(fg[k], fg.lines[0][k], k);
  // Committed is the item's own, so on hand − committed is its free stock.
  assert.equal(fg.onHand - fg.qtyCommitted, fg.freeStock);
});

test("rows keep the order each item first appears in /cart", () => {
  const c = cart(MIXED);
  const firstSeen = [...new Set(c.suppliers.flatMap((g) => g.lines.map((l) => l.itemUid)))];
  assert.deepEqual(groupLinesByItem(c).map((r: { itemUid: string }) => r.itemUid), firstSeen);
});

test("a kit flag on any of an item's lines flags the row", () => {
  const rows = groupLinesByItem(cart([
    line("KIT", "A", "split", 5, 1),
    line("KIT", "B", "split", 5, 1, { kitDoubleOrder: true }),
  ]));
  assert.equal(rows[0].kitDoubleOrder, true);
});

test("an empty cart, or none, gives no rows", () => {
  assert.deepEqual(groupLinesByItem({ suppliers: [] }), []);
  assert.deepEqual(groupLinesByItem({}), []);
  assert.deepEqual(groupLinesByItem(null), []);
  assert.deepEqual(groupLinesByItem(undefined), []);
  // The shape purchaseCart returns when nothing needs an order.
  assert.deepEqual(groupLinesByItem({ suppliers: [], totalLines: 0, totalItems: 0, estimatedCost: 0 }), []);
});

test("a 1.4 server's lines, without the 1.5 fields, read as null rather than failing", () => {
  const old = line("OLD", "A", "suggested", 10, 1);
  for (const k of ["qtyCommitted", "coverWeeksInclOnOrder", "coverBelowLeadTime", "riskScore"]) delete old[k];
  const [row] = groupLinesByItem(cart([old]));
  assert.equal(row.qtyCommitted, null);
  assert.equal(row.coverWeeksInclOnOrder, null);
  assert.equal(row.coverBelowLeadTime, null);
  assert.equal(row.riskScore, null);
  assert.equal(row.qty, 10);
});

/* ---------- static checks on the browser code ---------- */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("order-list.js is DOM-free and never names MYOB's raw quantities", () => {
  const src = read("../public/order-list.js");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\b(document|window|localStorage|fetch)\b/);
  assert.doesNotMatch(src, /\b(qty_on_hand|qty_committed|qty_available)\b/);
});

/** The body of a top-level `function name(` in dashboard.js, up to the next top-level declaration. */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `dashboard.js has no function ${name}`);
  const rest = src.slice(start + 1);
  const end = rest.search(/^(?:async function |function |const |let |\/\*)/m);
  return end < 0 ? rest : rest.slice(0, end);
}

test("dashboard.js: every /cart re-fetch goes through reloadOrderList", () => {
  const src = read("../public/dashboard.js");
  const fetches = src.match(/fetchJson\(withWindow\("\/api\/insights\/cart"\)\)/g) ?? [];
  assert.equal(fetches.length, 1, "only reloadOrderList may fetch /cart");
  assert.match(fnBody(src, "reloadOrderList"), /fetchJson\(withWindow\("\/api\/insights\/cart"\)\)/);
  // The eight sites the plan names: the first load plus seven writes.
  assert.ok((src.match(/await reloadOrderList\(\)/g) ?? []).length >= 8);
});

test("dashboard.js: the expand panel reads only what its caller passes", () => {
  const src = read("../public/dashboard.js");
  for (const name of ["toggleExpandRow", "expandPanelHtml"]) {
    assert.doesNotMatch(fnBody(src, name), /\binv(Items|TargetCover|State)\b/, `${name} still reads Inventory's globals`);
  }
  assert.match(src, /^function toggleExpandRow\(tr, lookup, colspan, ctx = \{\}\)/m);
  assert.match(src, /^function expandPanelHtml\(i, ctx = \{\}\)/m);
  // Inventory passes its rows, its header count and its target cover.
  assert.match(fnBody(src, "loadInventoryTable"), /toggleExpandRow\(tr, invItems, headers\.length, \{ targetCoverWeeks: invTargetCover \}\)/);
  // By item (1.6) passes its own: the one item it fetched and its own column
  // count, never Inventory's rows or header count.
  const byItem = fnBody(src, "toggleOrderItemRow");
  assert.match(byItem, /toggleExpandRow\(tr, new Map\(\[\[uid, detail\.item\]\]\), cols, \{/);
  assert.doesNotMatch(byItem, /\binv(Items|TargetCover|State)\b|headers\.length/);
  // Nobody else opens it.
  const callers = [...src.matchAll(/toggleExpandRow\(tr, (\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(callers)].sort(), ["invItems", "lookup", "new", "null"]);
});

/* ---------- the By item view (1.6) ---------- */

type Row = ReturnType<typeof groupLinesByItem>[number];

test("By item: the columns are exactly the ones Allied asked for, in order", () => {
  assert.deepEqual(
    BY_ITEM_COLUMNS.map((c: { label: string }) => c.label),
    [
      "", "Item", "Supplier", "Suggested", "Order qty", "On hand", "Committed", "Free stock", "On order",
      "Weekly demand", "Cover excl. on order", "Cover incl. on order", "Lead time", "Est. cost", "",
    ],
  );
  // Labels shared with Inventory use Inventory's glossary entry, and its label.
  const src = read("../public/dashboard.js");
  const terms = src.slice(src.indexOf("const TERMS = {"), src.indexOf("const FLAG_HELP"));
  for (const c of BY_ITEM_COLUMNS.filter((x: { term?: string }) => x.term)) {
    const m = new RegExp(`\\n  ${c.term}: \\{\\n    label: "([^"]+)"`).exec(terms);
    assert.ok(m, `TERMS has no ${c.term}`);
    if (c.term !== "supplier_source") assert.equal(m[1], c.label, `${c.label} differs from Inventory's label`);
  }
  // Every column without a glossary entry explains itself on hover.
  for (const c of BY_ITEM_COLUMNS.filter((x: { term?: string; label: string }) => !x.term && x.label && x.label !== "Item" && x.label !== "On hand"))
    assert.ok(c.tip, `${c.label} has no tip`);
});

test("By item: highest risk first, then item number; a missing score goes last", () => {
  const c = cart([
    line("B2", "A", "suggested", 1, 1, { riskScore: 40 }),
    line("A1", "A", "suggested", 1, 1, { riskScore: 40 }),
    line("Z9", "B", "suggested", 1, 1, { riskScore: 95 }),
    line("OLD", "B", "suggested", 1, 1, { riskScore: undefined }),
    line("C3", "C", "suggested", 1, 1, { riskScore: 0 }),
  ]);
  assert.deepEqual(orderByItemRows(c).map((r: Row) => r.number), ["Z9", "A1", "B2", "C3", "OLD"]);
  assert.equal(byRiskThenNumber({ riskScore: null, number: "A" }, { riskScore: 0, number: "B" }), 1);
});

test("By item lists the same (item, supplier, qty) set as By supplier, and the same totals", () => {
  const c = cart(MIXED);
  const rows = orderByItemRows(c);
  const key = (l: Line) => `${l.itemUid}|${l.supplierUid}|${l.qty}`;
  const bySupplier = c.suppliers.flatMap((g) => g.lines).map(key).sort();
  const byItem = rows.flatMap((r: Row) => r.lines).map(key).sort();
  assert.deepEqual(byItem, bySupplier);
  assert.equal(rows.length, new Set(c.suppliers.flatMap((g) => g.lines.map((l) => l.itemUid))).size);
  // A permutation of groupLinesByItem: sorting adds and drops nothing.
  assert.deepEqual(
    rows.map((r: Row) => r.itemUid).sort(),
    groupLinesByItem(c).map((r: Row) => r.itemUid).sort(),
  );
});

test("By item header: items to order + taken off = items needing an order; $ is the cart's own total", () => {
  const c = {
    ...cart(MIXED),
    totalItems: 8,
    estimatedCost: 1234.5,
    removedItems: [
      { itemUid: "OFF1", number: "OFF1", name: null, how: "taken_off" },
      { itemUid: "OFF2", number: "OFF2", name: null, how: "struck" },
    ],
  };
  const s = orderListSummary(c, orderByItemRows(c));
  assert.equal(s.toOrder, 6);
  assert.equal(s.takenOff, 2);
  assert.equal(s.toOrder + s.takenOff, c.totalItems);
  assert.equal(s.estimatedCost, 1234.5, "the server's figure, not re-added in the browser");
  // A server without estimatedCost: the rows' sum, which is the same lines.
  const bare = cart(MIXED);
  close(orderListSummary(bare).estimatedCost, bare.suppliers.reduce((a, g) => a + g.estimatedCost, 0));
  assert.deepEqual(orderListSummary({ suppliers: [], totalItems: 0, estimatedCost: 0 }), {
    toOrder: 0, takenOff: 0, totalItems: 0, estimatedCost: 0,
  });
});

/** One single-line row with the given line fields. */
const single = (over: Record<string, unknown>) => groupLinesByItem(cart([line("X", "S1", "suggested", 10, 1, { supplierName: "Hanova", ...over })]))[0];

test("Supplier cell: preferred, MYOB primary, from bills, tagged, picked earlier", () => {
  assert.deepEqual(supplierCell(single({ isPreferred: true, supplierSource: "allied" })), { kind: "single", name: "Hanova", role: "preferred" });
  assert.equal(supplierCell(single({ isPreferred: false, supplierSource: "myob" })).role, "MYOB primary");
  assert.equal(supplierCell(single({ isPreferred: false, supplierSource: "inferred" })).role, "from bills");
  assert.equal(supplierCell(single({ isPreferred: false, supplierSource: "allied" })).role, "tagged");
  assert.equal(supplierCell(single({ isPreferred: false, supplierSource: "picked" })).role, "picked earlier");
  // The compare drawer's options carry `source`, not `supplierSource`.
  assert.equal(supplierRole({ isPreferred: false, source: "myob" }), "MYOB primary");
  assert.equal(supplierRole({ isPreferred: true, source: "myob" }), "preferred");
  assert.deepEqual(supplierCell(single({ supplierUid: "none", supplierName: "No known supplier" })), { kind: "unknown", name: "No known supplier" });
});

test("Supplier cell: a pick that disagrees asks, and a kept one says so", () => {
  const conflict = { kind: "pick", acknowledged: false, preferredSupplierUid: "H", preferredSupplierName: "Hanova" };
  const open = supplierCell(single({ supplierName: "Jiaxing", isPreferred: false, supplierSource: "allied", conflict }));
  assert.equal(open.kind, "conflict");
  assert.equal(open.name, "Jiaxing");
  assert.equal(open.preferredName, "Hanova");
  const kept = supplierCell(single({ supplierName: "Jiaxing", isPreferred: false, conflict: { ...conflict, acknowledged: true } }));
  assert.equal(kept.kind, "kept");
  assert.equal(open.struck, false);
  // The preferred line itself never shows as a pick.
  assert.equal(supplierCell(single({ isPreferred: true, supplierSource: "allied", conflict })).kind, "single");

  // A preferred line struck before × existed: the item fell to the next
  // supplier, nobody picked it, so the cell must not say "your pick".
  const removed = { ...conflict, kind: "removed" };
  const struck = supplierCell(single({ supplierName: "Jiaxing", isPreferred: false, conflict: removed }));
  assert.equal(struck.kind, "conflict");
  assert.equal(struck.struck, true);
  assert.equal(supplierCell(single({ supplierName: "Jiaxing", isPreferred: false, conflict: { ...removed, acknowledged: true } })).struck, true);
});

test("A split down to one part is still a split, and read-only", () => {
  // By supplier's × strikes one part while two or more remain.
  const [row] = groupLinesByItem(cart([line("S", "A", "split", 7, 1, { supplierName: "Hanova", isPreferred: true })]));
  const cell = supplierCell(row);
  assert.equal(cell.kind, "split");
  assert.deepEqual(cell.parts.map((p: { name: string; qty: number }) => `${p.name} ${p.qty}`), ["Hanova 7"]);
  const q = qtyCell(row);
  assert.equal(q.editable, false);
  assert.equal(q.why, "split");
  assert.equal(q.qty, 7);
});

test("Supplier cell: a split names its parts in order; one without the preferred keeps its question", () => {
  const rows = groupLinesByItem(cart(MIXED));
  const fg = supplierCell(rows.find((r: Row) => r.itemUid === "FG250P"));
  assert.equal(fg.kind, "split");
  assert.deepEqual(fg.parts.map((p: { name: string; qty: number }) => `${p.name} ${p.qty}`), ["SKELLERUP 142", "SPECIALISED WASHERS 142"]);
  assert.equal(fg.conflict, null);
  assert.equal(supplierCell(rows.find((r: Row) => r.itemUid === "TWOLINE")).kind, "several");

  const conflict = { kind: "split", acknowledged: false, preferredSupplierUid: "H", preferredSupplierName: "Hanova" };
  const [split] = groupLinesByItem(cart([
    line("S", "A", "split", 5, 1, { conflict, isPreferred: false }),
    line("S", "B", "split", 5, 1, { conflict, isPreferred: false }),
  ]));
  assert.equal(supplierCell(split).conflict, conflict);
});

test("Order qty cell: one line is editable under its supplier; a split is not", () => {
  const plain = qtyCell(single({ state: "suggested" }));
  assert.equal(plain.editable, true);
  assert.equal(plain.supplierUid, "S1");
  assert.equal(plain.decided, false);
  assert.equal(plain.edited, false);
  assert.equal(qtyCell(single({ state: "edited" })).edited, true);
  // A Chosen supplier keeps its state when its qty is typed, as in By supplier.
  assert.equal(qtyCell(single({ state: "selected" })).decided, true);
  const rows = groupLinesByItem(cart(MIXED));
  const fg = qtyCell(rows.find((r: Row) => r.itemUid === "FG250P"));
  assert.equal(fg.editable, false);
  assert.equal(fg.why, "split");
  assert.equal(fg.qty, 284);
  assert.equal(qtyCell(rows.find((r: Row) => r.itemUid === "TWOLINE")).why, "several");
});

test("Order qty cell: below minimum but covered by on order shows 0, labelled, until a qty is typed", () => {
  // In /cart because it is below its minimum; the suggestion is 0 because
  // free stock plus on order meets the target.
  const covered = (over: Record<string, unknown>) =>
    qtyCell(groupLinesByItem(cart([line("C", "S1", "suggested", 0, 1, { suggestedQty: 0, incomingQty: 2000, ...over })]))[0]);
  assert.equal(covered({}).coveredByOnOrder, true);
  assert.equal(covered({}).qty, 0);
  assert.equal(covered({ qty: 500, estCost: 500, state: "edited" }).coveredByOnOrder, false);
  assert.equal(covered({ incomingQty: 0 }).coveredByOnOrder, false);
  assert.equal(qtyCell(single({})).coveredByOnOrder, false);
});

test("Lead time cell: each line's figure once, in line order", () => {
  const [row] = groupLinesByItem(cart([
    line("L", "A", "split", 5, 1, { leadTimeDays: 120, leadTimeSetByAllied: true }),
    line("L", "B", "split", 5, 1, { leadTimeDays: 30, leadTimeOrders: 4 }),
    line("L", "C", "split", 5, 1, { leadTimeDays: 120, leadTimeSetByAllied: true }),
    line("L", "D", "split", 5, 1, { leadTimeDays: null }),
  ]));
  assert.deepEqual(rowLeadTimes(row), [
    { days: 120, setByAllied: true, orders: 0 },
    { days: 30, setByAllied: false, orders: 4 },
    { days: null, setByAllied: false, orders: 0 },
  ]);
});

test("dashboard.js: Purchasing routes and both views share one way to save", () => {
  const src = read("../public/dashboard.js");
  const tabs = fnBody(src, "purchasingTabs");
  for (const [href, label] of [["#/purchasing", "By item"], ["#/purchasing/suppliers", "By supplier"], ["#/purchasing/minimums", "Minimum stock review"]])
    assert.match(tabs, new RegExp(`href="${href}"[^>]*>${label}<`));
  const render = fnBody(src, "renderPurchasing");
  assert.match(render, /orderListView = tab === "suppliers" \? "suppliers" : "items"/);
  assert.match(fnBody(src, "drawOrderList"), /orderListView === "suppliers"\) drawCart\(\);\s*else drawOrderByItem\(\)/);
  // A typed qty: the same helper, so the same POST /cart/line, from both views.
  assert.match(fnBody(src, "wireCartCards"), /wireCartQtyInput\(qtyInput, itemUid, supplierUid, tr\.dataset\.state\)/);
  assert.match(fnBody(src, "wireOrderByItem"), /wireCartQtyInput\(qtyInput, itemUid, tr\.dataset\.supplier, tr\.dataset\.state\)/);
  assert.match(fnBody(src, "wireOrderByItem"), /\/api\/insights\/cart\/take-off/);
  assert.match(fnBody(src, "drawOrderByItem"), /const cols = BY_ITEM_COLUMNS\.length/);
  assert.match(fnBody(src, "drawOrderByItem"), /cartRemovedItems\(d\)/);
});

/*
 * route() runs while dashboard.js is still loading. A tab opened on
 * #/purchasing reaches renderPurchasing then, and assigning a `let` declared
 * further down the file throws (temporal dead zone): the page would show an
 * error instead of the Order list.
 */
test("dashboard.js: the Order list's view state is declared before the first route()", () => {
  const src = read("../public/dashboard.js");
  const boot = src.search(/^route\(\);$/m);
  assert.ok(boot > 0);
  for (const name of ["orderListView", "orderItemOpen", "orderItemRows", "orderItemDetails"]) {
    const at = src.search(new RegExp(`^(?:let|const) ${name}\\b`, "m"));
    assert.ok(at >= 0 && at < boot, `${name} must be declared before the first route() call`);
  }
});
