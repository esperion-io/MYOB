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
 * And its sorting (1.7): every key both ways with empty values
 * last, a sort that only reorders, Inventory's first-click direction for the
 * keys the two share, the address it is kept in, and Inventory's own header
 * left alone.
 * And choosing the supplier on the row (1.8), at the foot: what the dropdown
 * offers and in what order, the request each choice sends, and the wording
 * of the message and of "Why this quantity" for each kind of minimum.
 * No database: public/order-list.js is a plain browser module, imported as is,
 * and queries.ts only for a constant (its pool is created on first use).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-ignore — plain browser module, no types
import {
  BY_ITEM_COLUMNS,
  byRiskThenNumber,
  groupLinesByItem,
  leadBasisSentence,
  leadOwner,
  leadTimeNote,
  ORDER_SORT_DEFAULT,
  orderByItemRows,
  orderListSummary,
  orderSortQuery,
  orderSortSummary,
  parseOrderSort,
  PURCHASING_SORTS,
  qtyCell,
  quantityStaysMessage,
  rowLeadTimes,
  sortDirection,
  sortRows,
  supplierCell,
  supplierChangedMessage,
  supplierChangeRequest,
  supplierOptionLabel,
  supplierRole,
  supplierSelect,
} from "../public/order-list.js";
import { SORT_DEFAULT_DIR } from "../src/insights/queries.js";

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
      "Weekly demand", "Cover excl. on order", "Cover incl. on order", "Gap before delivery", "Lead time", "Est. cost", "",
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
  for (const name of ["orderListView", "orderItemOpen", "orderItemRows", "orderItemDetails", "orderSort"]) {
    const at = src.search(new RegExp(`^(?:let|const) ${name}\\b`, "m"));
    assert.ok(at >= 0 && at < boot, `${name} must be declared before the first route() call`);
  }
});

/* ---------- sorting By item (1.7) ---------- */

/*
 * A cart with an empty value for every key somewhere: no demand (null covers
 * and weekly), no known supplier, no lead time, a 1.4 line with no risk or
 * committed, a split under two leads, and ties on every figure.
 */
const SORTABLE = [
  line("BN1665G", "HANOVA", "suggested", 1779, 0.21, { supplierName: "Hanova", riskScore: 95, leadTimeDays: 120, weeklyDemand: 166.4, coverWeeks: 1.9, coverWeeksInclOnOrder: 14, onHand: 333, qtyCommitted: 10, freeStock: 323, incomingQty: 2000, suggestedQty: 1779, gap: { status: "gap", start: "2026-10-27" } }),
  line("SPW12G", "HANOVA", "edited", 3600, 0.05, { supplierName: "Hanova", riskScore: 95, leadTimeDays: 120, weeklyDemand: 300, coverWeeks: 4, coverWeeksInclOnOrder: 50, onHand: 1200, qtyCommitted: 0, freeStock: 1200, incomingQty: 15000, suggestedQty: 3004, gap: { status: "gap_open", start: "2026-10-27" } }),
  line("FG250P", "SKELLERUP", "split", 142, 1.5, { supplierName: "Skellerup", riskScore: 40, leadTimeDays: 30, weeklyDemand: 0, coverWeeks: null, coverWeeksInclOnOrder: null, onHand: 0, qtyCommitted: 0, freeStock: 0, incomingQty: 0, suggestedQty: 284, gap: { status: "gap_open", start: "2026-10-14" } }),
  line("FG250P", "BREMICK", "split", 142, 1.25, { supplierName: "Bremick", riskScore: 40, leadTimeDays: 90, weeklyDemand: 0, coverWeeks: null, coverWeeksInclOnOrder: null, onHand: 0, qtyCommitted: 0, freeStock: 0, incomingQty: 0, suggestedQty: 284, gap: { status: "gap_open", start: "2026-10-14" } }),
  line("NOSUP", "none", "suggested", 50, 0, { supplierName: null, riskScore: 60, leadTimeDays: null, weeklyDemand: 2, coverWeeks: 0.5, coverWeeksInclOnOrder: 0.5, onHand: 1, qtyCommitted: 0, freeStock: 1, incomingQty: 0, suggestedQty: 50, gap: null }),
  line("OLD14", "TONG MING", "suggested", 500, 0.7, { supplierName: "Tong Ming", riskScore: undefined, qtyCommitted: undefined, coverWeeksInclOnOrder: undefined, leadTimeDays: 42, weeklyDemand: 20, coverWeeks: 4, onHand: 80, freeStock: 80, incomingQty: 0, suggestedQty: 500 }),
  line("A1", "JIAXING", "suggested", 1779, 0.3, { supplierName: "Jiaxing", riskScore: 40, leadTimeDays: 120, weeklyDemand: 166.4, coverWeeks: 1.9, coverWeeksInclOnOrder: 14, onHand: 333, qtyCommitted: 10, freeStock: 323, incomingQty: 2000, suggestedQty: 1779, gap: { status: "covered", start: null, tight: true } }),
];

test("Purchasing sorts: every sortable column has a key, and every key but risk has a column", () => {
  const onColumns = BY_ITEM_COLUMNS.filter((c: { sort?: string }) => c.sort).map((c: { sort: string }) => c.sort);
  for (const k of onColumns) assert.ok(PURCHASING_SORTS[k], `column sorts by unknown key ${k}`);
  assert.deepEqual([...onColumns, "risk"].sort(), Object.keys(PURCHASING_SORTS).sort());
  // Caret and × are not sortable; everything Allied read is.
  assert.deepEqual(BY_ITEM_COLUMNS.filter((c: { sort?: string }) => !c.sort).map((c: { key: string }) => c.key), ["caret", "remove"]);
  assert.deepEqual(ORDER_SORT_DEFAULT, { sort: "risk", dir: "desc" });
});

test("Purchasing sorts: shared keys start in Inventory's direction (SORT_DEFAULT_DIR), the rest as the plan says", () => {
  const shared = ["risk", "number", "on_hand", "committed", "available", "incoming", "weekly", "cover", "cover_incl", "gap"];
  for (const k of shared) {
    assert.ok(PURCHASING_SORTS[k], `${k} is Inventory's key and must be Purchasing's too`);
    assert.equal(PURCHASING_SORTS[k].dir, SORT_DEFAULT_DIR[k] ?? "desc", `${k} starts the other way from Inventory`);
  }
  // Lowest or A first: Item, Supplier, On hand, Free stock, both covers.
  // Highest first: risk, the quantities, cost, lead time, weekly demand, committed.
  const firstClick = Object.fromEntries(Object.entries(PURCHASING_SORTS).map(([k, v]) => [k, (v as { dir: string }).dir]));
  assert.deepEqual(firstClick, {
    risk: "desc", number: "asc", supplier: "asc", suggested: "desc", order_qty: "desc", on_hand: "asc",
    committed: "desc", available: "asc", incoming: "desc", weekly: "desc", cover: "asc", cover_incl: "asc",
    gap: "asc", lead_time: "desc", est_cost: "desc",
  });
});

test("sortRows: every key, both ways, is ordered with empty values last and ties by item number", () => {
  const rows = groupLinesByItem(cart(SORTABLE));
  for (const [key, s] of Object.entries(PURCHASING_SORTS) as [string, { text?: boolean; value: (r: Row) => unknown }][]) {
    for (const dir of ["asc", "desc"]) {
      const out = sortRows(rows, key, dir);
      const vals = out.map((r: Row) => s.value(r));
      const firstEmpty = vals.findIndex((v: unknown) => v == null);
      if (firstEmpty >= 0)
        assert.ok(vals.slice(firstEmpty).every((v: unknown) => v == null), `${key} ${dir}: an empty value before a filled one`);
      for (let i = 1; i < out.length; i++) {
        const [a, b] = [vals[i - 1], vals[i]];
        if (a == null || b == null) {
          if (a == null && b == null) assert.ok(String(out[i - 1].number).localeCompare(String(out[i].number)) < 0);
          continue;
        }
        const c = s.text ? String(a).localeCompare(String(b)) : Number(a) - Number(b);
        assert.ok(dir === "asc" ? c <= 0 : c >= 0, `${key} ${dir}: ${out[i - 1].number} before ${out[i].number}`);
        if (c === 0) assert.ok(String(out[i - 1].number).localeCompare(String(out[i].number)) < 0, `${key} ${dir}: tie not by item number`);
      }
    }
  }
});

test("sortRows: a sort only reorders: same rows, same count and totals, input untouched", () => {
  const rows = groupLinesByItem(cart(SORTABLE));
  const before = rows.map((r: Row) => r.itemUid);
  const qtySum = (rs: Row[]) => rs.reduce((a, r) => a + r.qty, 0);
  const costSum = (rs: Row[]) => rs.reduce((a, r) => a + r.estCost, 0);
  for (const key of [...Object.keys(PURCHASING_SORTS), "nonsense"]) {
    for (const dir of ["asc", "desc", ""]) {
      const out = sortRows(rows, key, dir);
      assert.notEqual(out, rows);
      assert.equal(out.length, rows.length);
      assert.deepEqual(out.map((r: Row) => r.itemUid).sort(), [...before].sort());
      assert.equal(qtySum(out), qtySum(rows));
      close(costSum(out), costSum(rows));
    }
  }
  assert.deepEqual(rows.map((r: Row) => r.itemUid), before, "the rows passed in keep their order");
  assert.deepEqual(sortRows([], "cover", "asc"), []);
  assert.deepEqual(sortRows(undefined, "cover", "asc"), []);
});

test("sortRows: the default is the 1.6 order, and anything unknown falls back to it", () => {
  const c = cart(SORTABLE);
  const ids = (rs: Row[]) => rs.map((r) => r.number);
  const risk = ids(orderByItemRows(c));
  assert.deepEqual(risk, ["BN1665G", "SPW12G", "NOSUP", "A1", "FG250P", "OLD14"]);
  assert.deepEqual(ids(sortRows(groupLinesByItem(c), "risk", "desc")), risk);
  assert.deepEqual(ids(sortRows(groupLinesByItem(c), "risk", "")), risk);
  assert.deepEqual(ids(sortRows(groupLinesByItem(c), "later_key", "asc")), ids(sortRows(groupLinesByItem(c), "risk", "asc")), "an unknown key sorts by risk in the direction asked");
  assert.deepEqual(ids(sortRows(groupLinesByItem(c), "nonsense", "")), risk);
  // risk lowest first still puts the 1.4 line with no score last.
  assert.deepEqual(ids(sortRows(groupLinesByItem(c), "risk", "asc")), ["A1", "FG250P", "NOSUP", "BN1665G", "SPW12G", "OLD14"]);
  assert.equal(sortDirection("cover", ""), "asc");
  assert.equal(sortDirection("cover", "desc"), "desc");
  assert.equal(sortDirection("nonsense", "sideways"), "desc");
});

test("sortRows: what each column sorts on", () => {
  const c = cart(SORTABLE);
  const ids = (key: string, dir: string) => sortRows(groupLinesByItem(c), key, dir).map((r: Row) => r.number);
  // Covers: no demand last both ways; equal covers by item number.
  assert.deepEqual(ids("cover", "asc"), ["NOSUP", "A1", "BN1665G", "OLD14", "SPW12G", "FG250P"]);
  assert.deepEqual(ids("cover", "desc"), ["OLD14", "SPW12G", "A1", "BN1665G", "NOSUP", "FG250P"]);
  // Cover incl.: a 1.4 server sends none, so that row has nothing to compare.
  assert.deepEqual(ids("cover_incl", "asc"), ["NOSUP", "A1", "BN1665G", "SPW12G", "FG250P", "OLD14"]);
  // Supplier: the name the cell leads with (a split's first part); no supplier last.
  assert.deepEqual(ids("supplier", "asc"), ["BN1665G", "SPW12G", "A1", "FG250P", "OLD14", "NOSUP"]);
  assert.deepEqual(ids("supplier", "desc"), ["OLD14", "FG250P", "A1", "BN1665G", "SPW12G", "NOSUP"]);
  // Lead time: a split sorts on its slower part (Skellerup 30, Bremick 90 -> 90); unknown last.
  assert.deepEqual(ids("lead_time", "desc"), ["A1", "BN1665G", "SPW12G", "FG250P", "OLD14", "NOSUP"]);
  // Order qty and est. cost are the row's sums: the split counts 284, not 142.
  assert.deepEqual(ids("order_qty", "desc"), ["SPW12G", "A1", "BN1665G", "OLD14", "FG250P", "NOSUP"]);
  assert.deepEqual(ids("est_cost", "desc"), ["A1", "FG250P", "BN1665G", "OLD14", "SPW12G", "NOSUP"]);
  // Committed: the 1.4 line without the field goes last, not first as a zero.
  assert.deepEqual(ids("committed", "desc"), ["A1", "BN1665G", "FG250P", "NOSUP", "SPW12G", "OLD14"]);
  // Gap before delivery (1.11): the run-out day of gap and gap_open, soonest
  // first; covered (A1, even tight), none (NOSUP, a past date) and a line
  // from a server before 1.11 (OLD14) have no gap and go last both ways.
  assert.deepEqual(ids("gap", "asc"), ["FG250P", "BN1665G", "SPW12G", "A1", "NOSUP", "OLD14"]);
  assert.deepEqual(ids("gap", "desc"), ["BN1665G", "SPW12G", "FG250P", "A1", "NOSUP", "OLD14"]);
  assert.deepEqual(ids("number", "asc"), ["A1", "BN1665G", "FG250P", "NOSUP", "OLD14", "SPW12G"]);
  assert.deepEqual(ids("number", "desc"), ["SPW12G", "OLD14", "NOSUP", "FG250P", "BN1665G", "A1"]);
});

test("The sort in the address: round trip, the default writes nothing, unknown keys give the default", () => {
  for (const key of Object.keys(PURCHASING_SORTS)) {
    for (const dir of ["asc", "desc"]) {
      const q = orderSortQuery({ sort: key, dir });
      const back = parseOrderSort(q);
      assert.equal(back.sort, q ? key : "risk");
      assert.equal(sortDirection(back.sort, back.dir), dir, `${key} ${dir} did not survive ${q}`);
    }
  }
  assert.equal(orderSortQuery({ sort: "risk", dir: "" }), "");
  assert.equal(orderSortQuery({ sort: "risk", dir: "desc" }), "");
  assert.equal(orderSortQuery({ sort: "cover_incl", dir: "asc" }), "sort=cover_incl&dir=asc");
  assert.equal(orderSortQuery({ sort: "cover_incl", dir: "" }), "sort=cover_incl&dir=asc", "the direction on screen is written out");
  assert.deepEqual(parseOrderSort("sort=cover_incl&dir=asc"), { sort: "cover_incl", dir: "asc" });
  assert.deepEqual(parseOrderSort("sort=later_key&dir=asc"), { sort: "risk", dir: "" }, "a later version's key opens the default");
  assert.deepEqual(parseOrderSort("sort=gap&dir=asc"), { sort: "gap", dir: "asc" }, "1.11's key");
  assert.deepEqual(parseOrderSort("sort=constructor"), { sort: "risk", dir: "" });
  assert.deepEqual(parseOrderSort("sort=weekly&dir=up"), { sort: "weekly", dir: "" });
  assert.deepEqual(parseOrderSort(""), { sort: "risk", dir: "" });
  assert.deepEqual(parseOrderSort(undefined), { sort: "risk", dir: "" });
});

test("The Sorted by line says what is on screen", () => {
  assert.equal(orderSortSummary({ sort: "risk", dir: "" }), "sorted by risk, highest first");
  assert.equal(orderSortSummary({ sort: "cover_incl", dir: "asc" }), "sorted by cover incl. on order, lowest first");
  assert.equal(orderSortSummary({ sort: "available", dir: "" }), "sorted by free stock, lowest first");
  assert.equal(orderSortSummary({ sort: "supplier", dir: "desc" }), "sorted by supplier, Z to A");
  assert.equal(orderSortSummary({ sort: "number", dir: "" }), "sorted by item number, A to Z");
  assert.equal(orderSortSummary({ sort: "later_key", dir: "asc" }), "sorted by risk, lowest first", "as sortRows: risk, in the direction asked");
  assert.equal(orderSortSummary({ sort: "gap", dir: "" }), "sorted by gap before delivery, soonest first");
  assert.equal(orderSortSummary({ sort: "gap", dir: "desc" }), "sorted by gap before delivery, latest first");
});

test("dashboard.js: Purchasing sorts with its own header and state; Inventory's sortTh is untouched", () => {
  const src = read("../public/dashboard.js");
  // Inventory's header still reads Inventory's state and nothing else.
  const sortTh = fnBody(src, "sortTh");
  assert.match(sortTh, /const active = invState\.sort === sortKey;/);
  assert.doesNotMatch(sortTh, /orderSort/);
  // Purchasing's reads only the state it is given, and draws Inventory's classes.
  const header = fnBody(src, "sortableHeader");
  assert.match(src, /^function sortableHeader\(state, key, label, tip, cls = ""\)/m);
  assert.doesNotMatch(header, /\binv(State|LastDir)\b|currentDir\(/);
  for (const cls of ["sortable", "sorted", "th-inner", "sort-arrow"]) assert.match(header, new RegExp(cls));
  assert.match(fnBody(src, "byItemTh"), /sortableHeader\(orderSort, c\.sort,/);
  // Sorted in the browser, over the cart already loaded; header clicks redraw without a fetch.
  assert.match(fnBody(src, "drawOrderByItem"), /sortRows\(orderByItemRows\(d\), orderSort\.sort, orderSort\.dir\)/);
  const wire = fnBody(src, "wireOrderSort");
  assert.doesNotMatch(wire, /fetchJson|reloadOrderList/);
  assert.match(wire, /drawOrderByItem\(\)/);
  // The address: route() reads it for By item only; the redraw writes it back.
  const route = fnBody(src, "route");
  assert.match(route, /if \(view === "inventory"\) applyInventoryQuery\(query\);/);
  assert.match(route, /if \(isOrderByItemRoute\(view, arg\)\) applyOrderSortQuery\(query\);/);
  assert.match(fnBody(src, "isOrderByItemRoute"), /view === "purchasing" && arg !== "suppliers" && arg !== "minimums"/);
  assert.match(fnBody(src, "syncOrderSortUrl"), /history\.replaceState/);
  assert.match(fnBody(src, "drawOrderByItem"), /syncOrderSortUrl\(\)/);
  // By supplier's cards are not sorted by it.
  assert.doesNotMatch(fnBody(src, "drawCart"), /orderSort|sortRows/);
});

/* ---------- choosing the supplier on the row (1.8) ---------- */

// N24S16M on the 26 Aug copy: preferred Shandong Tengda (131 d), MYOB's
// primary Tong Ming (42 d, never billed), two more tagged, in /cart's order.
const N24_OPTIONS = [
  { supplierUid: "SHANDONG", supplierName: "SHANDONG TENGDA", source: "allied", isPreferred: true, leadTimeDays: 131, lastCost: 0.962742 },
  { supplierUid: "TONGMING", supplierName: "TONG MING", source: "myob", isPreferred: false, leadTimeDays: 42, lastCost: null },
  { supplierUid: "ANZOR", supplierName: "ANZOR", source: "allied", isPreferred: false, leadTimeDays: 1, lastCost: 4.3366 },
  { supplierUid: "GONE", supplierName: "OLD CO", source: "picked", isPreferred: false, leadTimeDays: null, lastCost: null },
];
const RATIONALE_LEAD = { demandWindowMonths: 6, leadTimeDays: 131, leadTimeDaysUsed: 131, leadTimeUsedFor: "SHANDONG TENGDA", leadStockBasis: "lead", minWindowMonths: null, minLeadTimeDays: null };
const n24 = (over: Record<string, unknown> = {}) =>
  groupLinesByItem(cart([line("N24S16M", "SHANDONG", "suggested", 2760, 0.962742, {
    supplierName: "SHANDONG TENGDA", isPreferred: true, supplierSource: "allied", options: N24_OPTIONS,
    preferredSupplierUid: "SHANDONG", preferredSupplierName: "SHANDONG TENGDA", leadTimeDays: 131, minLevel: null,
    rationale: RATIONALE_LEAD, ...over,
  })]))[0];
const fixedQty = (v: unknown) => Number(v).toLocaleString("en-NZ");
const fixedPrice = (v: unknown) => `$${Number(v).toFixed(2)}`;

test("Supplier dropdown: the suppliers on file in /cart's order, set to where the item is now", () => {
  const m = supplierSelect(n24());
  assert.equal(m.kind, "select");
  assert.equal(m.current, "SHANDONG");
  assert.equal(m.preferredUid, "SHANDONG");
  assert.equal(m.single, false);
  assert.deepEqual(m.options.map((o: { supplierUid: string }) => o.supplierUid), ["SHANDONG", "TONGMING", "ANZOR", "GONE"]);
  assert.deepEqual(m.options.map((o: { role: string }) => o.role), ["preferred", "MYOB primary", "tagged", "picked earlier"]);
  assert.deepEqual(m.options.filter((o: { selected: boolean }) => o.selected).map((o: { supplierUid: string }) => o.supplierUid), ["SHANDONG"]);
  // A pick: set to the picked supplier, the preferred one still offered first.
  const conflict = { kind: "pick", acknowledged: false, preferredSupplierUid: "SHANDONG", preferredSupplierName: "SHANDONG TENGDA" };
  const pick = supplierSelect(n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, state: "selected", conflict }));
  assert.equal(pick.kind, "select");
  assert.equal(pick.current, "TONGMING");
  assert.equal(pick.cell.kind, "conflict");
  assert.equal(pick.options[0].supplierUid, "SHANDONG");
});

test("Supplier dropdown: option text is role, lead time and last cost, leaving out what is unknown", () => {
  const [pref, myob, , gone] = supplierSelect(n24()).options;
  assert.equal(supplierOptionLabel(pref, fixedPrice), "SHANDONG TENGDA — preferred · 131 d · $0.96 last");
  assert.equal(supplierOptionLabel(myob, fixedPrice), "TONG MING — MYOB primary · 42 d");
  assert.equal(supplierOptionLabel(gone, fixedPrice), "OLD CO — picked earlier");
  assert.equal(supplierOptionLabel({ name: null, role: null, leadTimeDays: null, lastCost: null }), "—");
});

test("Supplier dropdown: one supplier on file, splits, two lines, ruled none and unknown", () => {
  const one = supplierSelect(n24({ options: [N24_OPTIONS[0]] }));
  assert.equal(one.kind, "select");
  assert.equal(one.single, true);
  const [split] = groupLinesByItem(cart([
    line("FG250P", "SKELLERUP", "split", 142, 1.5, { options: N24_OPTIONS }),
    line("FG250P", "BREMICK", "split", 142, 1.25, { options: N24_OPTIONS }),
  ]));
  assert.deepEqual([supplierSelect(split).kind, supplierSelect(split).count], ["split", 2]);
  const twoLine = groupLinesByItem(cart(MIXED)).find((r: Row) => r.itemUid === "TWOLINE");
  assert.equal(supplierSelect(twoLine).kind, "several");
  const none = { supplierUid: "none", supplierName: "No known supplier", options: [] };
  assert.equal(supplierSelect(single({ ...none, supplierRuledNone: true })).kind, "ruled");
  assert.equal(supplierSelect(single({ ...none, supplierRuledNone: false })).kind, "unknown");
  // A server before 1.8 sends no supplierRuledNone: "No known supplier", as in 1.6.
  assert.equal(supplierSelect(single(none)).kind, "unknown");
  // Nothing to choose from on a row the dropdown isn't drawn for.
  assert.equal(supplierChangeRequest(split, "SKELLERUP"), null);
});

test("Supplier dropdown: another supplier is a select; the preferred again is use-preferred", () => {
  const row = n24();
  assert.deepEqual(supplierChangeRequest(row, "TONGMING"), { endpoint: "select", body: { itemUid: "N24S16M", supplierUid: "TONGMING" } });
  // No change, nothing chosen, or a uid the dropdown never offered: nothing sent.
  assert.equal(supplierChangeRequest(row, "SHANDONG"), null);
  assert.equal(supplierChangeRequest(row, ""), null);
  assert.equal(supplierChangeRequest(row, "MADE-UP"), null);
  // From a pick, the preferred supplier again clears the pick (and keeps a typed qty).
  const conflict = { kind: "pick", acknowledged: false, preferredSupplierUid: "SHANDONG", preferredSupplierName: "SHANDONG TENGDA" };
  const picked = n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, state: "selected", conflict });
  assert.deepEqual(supplierChangeRequest(picked, "SHANDONG"), { endpoint: "use-preferred", body: { itemUid: "N24S16M" } });
  assert.deepEqual(supplierChangeRequest(picked, "ANZOR"), { endpoint: "select", body: { itemUid: "N24S16M", supplierUid: "ANZOR" } });
  // A preferred line struck before × existed: the preferred again is use-preferred too.
  const struck = n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, conflict: { ...conflict, kind: "removed" } });
  assert.equal(supplierChangeRequest(struck, "SHANDONG")?.endpoint, "use-preferred");
});

test("Supplier dropdown: with no preferred supplier every choice is a select, the default again included", () => {
  const noPref = N24_OPTIONS.map((o) => ({ ...o, isPreferred: false }));
  // Tong Ming is MYOB's primary, so it is the default; choosing another, then it again.
  const atDefault = n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, supplierSource: "myob", options: noPref, preferredSupplierUid: null, preferredSupplierName: null });
  assert.equal(supplierChangeRequest(atDefault, "ANZOR")?.endpoint, "select");
  const atAnzor = n24({ supplierUid: "ANZOR", supplierName: "ANZOR", isPreferred: false, state: "selected", options: noPref, preferredSupplierUid: null, preferredSupplierName: null });
  assert.deepEqual(supplierChangeRequest(atAnzor, "TONGMING"), { endpoint: "select", body: { itemUid: "N24S16M", supplierUid: "TONGMING" } });
});

test("Quantity message: worded by the kind of minimum, from the rationale /cart sends", () => {
  // BN1665G, live 13 Oct: a window minimum of 2,771 from Hanova's 120 days over 6 months.
  const windowMin = n24({ minLevel: 2771, qty: 1779, suggestedQty: 1779, rationale: { ...RATIONALE_LEAD, leadTimeDaysUsed: 120, leadTimeUsedFor: "Hanova", leadStockBasis: "window", minWindowMonths: 6, minLeadTimeDays: 120 } });
  assert.equal(
    quantityStaysMessage(windowMin, fixedQty),
    "Quantity stays 1,779. It is built from your minimum of 2,771, which was set from Hanova's 120-day lead time over 6 months of use. Changing the supplier here doesn't change it.",
  );
  const manual = n24({ minLevel: 500, qty: 640, suggestedQty: 640, rationale: { ...RATIONALE_LEAD, leadStockBasis: "manual" } });
  assert.equal(quantityStaysMessage(manual, fixedQty), "Quantity stays 640. It is built from your minimum of 500, which you set by hand.");
  assert.equal(
    quantityStaysMessage(n24(), fixedQty),
    "Quantity stays 2,760. It is built on SHANDONG TENGDA's 131-day lead time, the item's usual supplier.",
  );
  // A window minimum quotes the lead it was set from, not today's: the
  // supplier's lead moved after it was applied and nobody pressed Recalculate.
  const drifted = n24({ minLevel: 2771, qty: 1779, suggestedQty: 1779, rationale: { ...RATIONALE_LEAD, leadTimeDaysUsed: 90, leadTimeUsedFor: "Hanova", leadStockBasis: "window", minWindowMonths: 6, minLeadTimeDays: 120 } });
  assert.match(quantityStaysMessage(drifted, fixedQty), /set from Hanova's 120-day lead time over 6 months/);
  const noLead = n24({ rationale: { ...RATIONALE_LEAD, leadTimeDaysUsed: null } });
  assert.match(quantityStaysMessage(noLead, fixedQty), /No lead time is known for SHANDONG TENGDA, the item's usual supplier/);
  // A server before 1.8: just the quantity.
  assert.equal(quantityStaysMessage(n24({ rationale: { demandWindowMonths: 6, leadTimeDays: 131 } }), fixedQty), "Quantity stays 2,760.");
});

test("Quantity message: a typed quantity stays because it was typed, and the minimum explains only the suggestion", () => {
  // Checklist step 4: 3,000 typed on N24S16M, then the preferred supplier again.
  const edited = n24({ state: "edited", qty: 3000 });
  assert.equal(
    quantityStaysMessage(edited, fixedQty),
    "Quantity stays 3,000, the number you typed. Changing the supplier here doesn't change it. The suggestion (2,760) is built on SHANDONG TENGDA's 131-day lead time, the item's usual supplier.",
  );
  // A pick that kept a typed qty is Chosen, not Edited: told by qty against the suggestion.
  const conflict = { kind: "pick", acknowledged: false, preferredSupplierUid: "SHANDONG", preferredSupplierName: "SHANDONG TENGDA" };
  const pickedTyped = n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, state: "selected", conflict, qty: 3000, suggestedQty: 1779, minLevel: 2771, rationale: { ...RATIONALE_LEAD, leadStockBasis: "window", minWindowMonths: 6, minLeadTimeDays: 120 } });
  assert.equal(
    quantityStaysMessage(pickedTyped, fixedQty),
    "Quantity stays 3,000, the number you typed. Changing the supplier here doesn't change it. The suggestion (1,779) is built from your minimum of 2,771, which was set from SHANDONG TENGDA's 120-day lead time over 6 months of use.",
  );
  const manualTyped = n24({ state: "edited", qty: 3000, minLevel: 500, rationale: { ...RATIONALE_LEAD, leadStockBasis: "manual" } });
  assert.match(quantityStaysMessage(manualTyped, fixedQty), /the number you typed\. .* The suggestion \(2,760\) is built from your minimum of 500, which you set by hand\.$/);
  // A quantity carried from another supplier was typed too.
  assert.match(quantityStaysMessage(n24({ qtyCarriedFrom: "ANZOR" }), fixedQty), /^Quantity stays 2,760, the number you typed\./);
  // A pick still on the suggestion is explained by it.
  const pickedOnSuggestion = n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, state: "selected", conflict });
  assert.match(quantityStaysMessage(pickedOnSuggestion, fixedQty), /^Quantity stays 2,760\. It is built on SHANDONG TENGDA's 131-day lead time/);
  // A server before 1.8: the typed sentence alone.
  assert.equal(
    quantityStaysMessage(n24({ state: "edited", qty: 3000, rationale: { leadTimeDays: 131 } }), fixedQty),
    "Quantity stays 3,000, the number you typed. Changing the supplier here doesn't change it.",
  );
});

test("Lead set on the item: credited to the item, not to the usual supplier", () => {
  // N24S16M on prod: 107 days set on the item, Shandong Tengda's own 131, Tong Ming's 42.
  const ITEM_LEAD = { ...RATIONALE_LEAD, leadTimeDays: 107, leadTimeDaysUsed: 107, leadTimeUsedSource: "item" };
  const conflict = { kind: "pick", acknowledged: false, preferredSupplierUid: "SHANDONG", preferredSupplierName: "SHANDONG TENGDA" };
  const picked = n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, state: "selected", conflict, leadTimeDays: 107, rationale: ITEM_LEAD });
  assert.equal(
    quantityStaysMessage(picked, fixedQty),
    "Quantity stays 2,760. It is built on this item's own 107-day lead time, set on the item page, whichever supplier it is ordered from.",
  );
  // Every line carries the item's lead, so there is no "Tong Ming's is …" to add.
  assert.equal(
    leadBasisSentence(picked.lines[0], N24_OPTIONS, fixedQty),
    "Built on this item's own 107-day lead time (set on the item page), whichever supplier it is ordered from.",
  );
  // A window minimum set from the item's lead says so; from another figure, it names no one.
  const winItem = { ...ITEM_LEAD, leadStockBasis: "window", minWindowMonths: 6, minLeadTimeDays: 107 };
  const m = n24({ minLevel: 2771, suggestedQty: 2760, rationale: winItem });
  assert.match(quantityStaysMessage(m, fixedQty), /set from this item's own 107-day lead time over 6 months of use\./);
  assert.equal(leadBasisSentence(m.lines[0], [], fixedQty), "Your minimum (2,771, from this item's own 107 days) sets the lead-time stock.");
  const older = n24({ minLevel: 2771, rationale: { ...winItem, minLeadTimeDays: 120 } });
  assert.match(quantityStaysMessage(older, fixedQty), /set from a 120-day lead time over 6 months of use\./);
  assert.equal(leadBasisSentence(older.lines[0], [], fixedQty), "Your minimum (2,771, from 120 days) sets the lead-time stock.");
  assert.equal(leadOwner(winItem, 107), "this item's own");
  assert.equal(leadOwner(winItem, 120), null);
  assert.equal(leadOwner(RATIONALE_LEAD), "SHANDONG TENGDA's");
  // A server from before this field: the usual supplier, as before.
  assert.equal(leadOwner({ leadTimeUsedFor: "Hanova", leadTimeDaysUsed: 120 }), "Hanova's");
});

test("Lead set on the item, from 1.12: the usual supplier's only, so a pick's own lead is given beside it", () => {
  // Shaped on N24S16M (107 days on the item, usual supplier Shandong Tengda), no minimum; Hobson's 30 (Allied's) is illustrative.
  const ITEM_LEAD = { ...RATIONALE_LEAD, leadTimeDays: 30, leadTimeDaysUsed: 107, leadTimeUsedSource: "item" };
  const conflict = { kind: "pick", acknowledged: false, preferredSupplierUid: "SHANDONG", preferredSupplierName: "SHANDONG TENGDA" };
  const picked = n24({ supplierUid: "HOBSON", supplierName: "HOBSON", isPreferred: false, state: "selected", conflict, leadTimeDays: 30, leadTimeSetByAllied: true, leadTimeSource: "supplier", rationale: ITEM_LEAD });
  assert.equal(
    leadBasisSentence(picked.lines[0], N24_OPTIONS, fixedQty),
    "Built on this item's own 107-day lead time (set on the item page). HOBSON's is 30 days.",
  );
  assert.equal(
    quantityStaysMessage(picked, fixedQty),
    "Quantity stays 2,760. It is built on this item's own 107-day lead time, set on the item page. Changing the supplier here doesn't change it.",
  );
  // Typed: it stays because it was typed; the item lead explains only the suggestion.
  assert.equal(
    quantityStaysMessage(n24({ ...picked.lines[0], qty: 3000 }), fixedQty),
    "Quantity stays 3,000, the number you typed. Changing the supplier here doesn't change it. The suggestion (2,760) is built on this item's own 107-day lead time, set on the item page.",
  );
  // On the usual supplier's line: the item's lead, nothing to compare.
  const usual = n24({ leadTimeDays: 107, leadTimeSource: "item", rationale: { ...ITEM_LEAD, leadTimeDays: 107 } });
  assert.equal(leadBasisSentence(usual.lines[0], N24_OPTIONS, fixedQty), "Built on this item's own 107-day lead time (set on the item page).");
  // A window minimum set from the item's lead, on a pick: the pick's own lead too.
  const win = n24({ ...picked.lines[0], minLevel: 2349, rationale: { ...ITEM_LEAD, leadStockBasis: "window", minWindowMonths: 6, minLeadTimeDays: 107 } });
  assert.equal(
    leadBasisSentence(win.lines[0], N24_OPTIONS, fixedQty),
    "Your minimum (2,349, from this item's own 107 days) sets the lead-time stock. HOBSON's lead time is 30 days.",
  );
  // A split's parts each show their own: left out, as before.
  assert.equal(leadBasisSentence(picked.lines[0], N24_OPTIONS, fixedQty, false), "Built on this item's own 107-day lead time (set on the item page).");
});

test("Lead note in Compare and the drill-down: a lead set on the item says so (1.12)", () => {
  assert.equal(leadTimeNote({ leadTimeDays: 107, leadTimeSetByAllied: true, leadTimeOrders: 0, leadTimeSource: "item" }), "set on the item");
  assert.equal(leadTimeNote({ leadTimeDays: 30, leadTimeSetByAllied: true, leadTimeOrders: 2, leadTimeSource: "supplier" }), "set by Allied");
  assert.equal(leadTimeNote({ leadTimeDays: 42, leadTimeSetByAllied: false, leadTimeOrders: 3, leadTimeSource: "measured" }), "from 3 orders");
  assert.equal(leadTimeNote({ leadTimeDays: 2, leadTimeSetByAllied: false, leadTimeOrders: 1 }), "from 1 order");
  // A server before 1.12: as it always read.
  assert.equal(leadTimeNote({ leadTimeDays: 107, leadTimeSetByAllied: true, leadTimeOrders: 0 }), "set by Allied");
  const src = read("../public/dashboard.js");
  assert.match(fnBody(src, "openSupplierCompare"), /esc\(\s*leadTimeNote\(o\),?\s*\)/);
  assert.match(fnBody(src, "orderItemPanelHtml"), /esc\(leadTimeNote\(o\)\)/);
  assert.doesNotMatch(fnBody(src, "openSupplierCompare"), /"set by Allied"/);
});

test("Why this quantity: names the lead time and minimum actually used, and the pick's own lead", () => {
  const conflict = { kind: "pick", acknowledged: false, preferredSupplierUid: "SHANDONG", preferredSupplierName: "SHANDONG TENGDA" };
  const picked = n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, state: "selected", conflict, leadTimeDays: 42 });
  assert.equal(
    leadBasisSentence(picked.lines[0], N24_OPTIONS, fixedQty),
    "Built on SHANDONG TENGDA's 131-day lead time (preferred). TONG MING's is 42 days.",
  );
  // With the usual supplier, only the lead it is built on.
  assert.equal(leadBasisSentence(n24().lines[0], N24_OPTIONS, fixedQty), "Built on SHANDONG TENGDA's 131-day lead time (preferred).");
  // A split's parts each show their own lead; the sentence leaves it out.
  assert.equal(leadBasisSentence(picked.lines[0], N24_OPTIONS, fixedQty, false), "Built on SHANDONG TENGDA's 131-day lead time (preferred).");
  const windowMin = n24({ supplierName: "Hanova", minLevel: 2771, rationale: { ...RATIONALE_LEAD, leadTimeDaysUsed: 120, leadTimeUsedFor: "Hanova", leadStockBasis: "window", minWindowMonths: 6, minLeadTimeDays: 120 } });
  assert.equal(leadBasisSentence(windowMin.lines[0], [], fixedQty), "Your minimum (2,771, from Hanova's 120 days) sets the lead-time stock.");
  const windowPick = { ...windowMin.lines[0], supplierUid: "J", supplierName: "Jiaxing", leadTimeDays: 120 };
  assert.equal(
    leadBasisSentence(windowPick, [], fixedQty),
    "Your minimum (2,771, from Hanova's 120 days) sets the lead-time stock. Jiaxing's lead time is 120 days.",
  );
  const manual = n24({ minLevel: 500, rationale: { ...RATIONALE_LEAD, leadStockBasis: "manual" } });
  assert.equal(leadBasisSentence(manual.lines[0], N24_OPTIONS, fixedQty), "Your minimum (500, set by hand) sets the lead-time stock.");
  // Anzor's one day is a day.
  const anzorPick = { ...manual.lines[0], supplierUid: "ANZOR", supplierName: "ANZOR", leadTimeDays: 1 };
  assert.equal(leadBasisSentence(anzorPick, N24_OPTIONS, fixedQty), "Your minimum (500, set by hand) sets the lead-time stock. ANZOR's lead time is 1 day.");
  assert.equal(leadBasisSentence(n24({ rationale: { leadTimeDays: 131 } }).lines[0], N24_OPTIONS, fixedQty), null);
});

test("dashboard.js: the lead bit of Why this quantity follows what the quantity was built on", () => {
  const src = read("../public/dashboard.js");
  const fn = (name: string) => `function${fnBody(src, name).slice("unction".length)}`;
  const esc = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const cartLeadBit = new Function("esc", "leadOwner", `${fn("cartLeadBit")}; return cartLeadBit;`)(esc, leadOwner);
  const text = (l: Record<string, unknown>) => String(cartLeadBit(l)).replace(/<[^>]*>/g, "");
  // N24S16M picked to Tong Ming (42 d); the usual supplier is Shandong Tengda (131 d).
  const pick = (r: Record<string, unknown>) => ({ supplierUid: "TONGMING", supplierName: "TONG MING", leadTimeDays: 42, leadTimeOrders: 3, rationale: { ...RATIONALE_LEAD, ...r } });
  assert.equal(text(pick({})), "built on SHANDONG TENGDA's 131d lead · this supplier 42d lead");
  assert.equal(text(pick({ leadStockBasis: "window", minWindowMonths: 6, minLeadTimeDays: 120 })), "min from SHANDONG TENGDA's 120d lead · this supplier 42d lead");
  assert.equal(text(pick({ leadStockBasis: "manual" })), "this supplier 42d lead");
  // An item lead is every line's: the line's own bit says it, credited to no supplier.
  assert.equal(text({ ...pick({ leadTimeDaysUsed: 107, leadTimeUsedSource: "item" }), leadTimeDays: 107, leadTimeSetByAllied: true }), "107d lead");
  // From 1.12 the pick shows its own lead, so the item's is given beside it.
  assert.equal(
    text({ ...pick({ leadTimeDaysUsed: 107, leadTimeUsedSource: "item" }), leadTimeSource: "measured" }),
    "built on this item's own 107d lead · this supplier 42d lead",
  );
  assert.equal(text({ supplierUid: "SHANDONG", supplierName: "SHANDONG TENGDA", leadTimeDays: 107, leadTimeSetByAllied: true, leadTimeSource: "item", rationale: { ...RATIONALE_LEAD, leadTimeDaysUsed: 107, leadTimeUsedSource: "item" } }), "107d lead");
  // With the usual supplier, or from a server before 1.8, as it always read.
  assert.equal(text({ supplierUid: "SHANDONG", supplierName: "SHANDONG TENGDA", leadTimeDays: 131, leadTimeOrders: 3, rationale: RATIONALE_LEAD }), "131d lead");
  assert.equal(text({ ...pick({}), rationale: { leadTimeDays: 42 } }), "42d lead");
});

test("After a choice: what happened, for this order only", () => {
  const conflict = { kind: "pick", acknowledged: false, preferredSupplierUid: "SHANDONG", preferredSupplierName: "SHANDONG TENGDA" };
  const picked = n24({ supplierUid: "TONGMING", supplierName: "TONG MING", isPreferred: false, state: "selected", conflict });
  assert.equal(
    supplierChangedMessage(picked, "select"),
    "N24S16M is now ordered from TONG MING, for this order only. Its preferred supplier is still SHANDONG TENGDA; change that on the item page.",
  );
  assert.equal(supplierChangedMessage(n24(), "use-preferred"), "N24S16M is back with its preferred supplier, SHANDONG TENGDA.");
  assert.equal(
    supplierChangedMessage(n24({ preferredSupplierUid: null, preferredSupplierName: null, isPreferred: false, state: "selected" }), "select"),
    "N24S16M is now ordered from SHANDONG TENGDA, for this order only.",
  );
});

test("dashboard.js: the row's dropdown sends only the existing select / use-preferred requests", () => {
  const src = read("../public/dashboard.js");
  assert.match(fnBody(src, "byItemSupplierHtml"), /supplierSelect\(r\)/);
  assert.match(fnBody(src, "byItemSupplierHtml"), /class="obi-supplier-select"/);
  assert.match(fnBody(src, "byItemSupplierHtml"), /Add a supplier on the item page →/);
  assert.match(fnBody(src, "byItemSupplierHtml"), /No supplier \(ruled\)/);
  assert.match(fnBody(src, "wireOrderByItem"), /changeRowSupplier\(tr, supplierPick\.value\)/);
  const change = fnBody(src, "changeRowSupplier");
  assert.match(change, /const before = orderItemRows\.get\(itemUid\);\s*const req = supplierChangeRequest\(before, supplierUid\)/);
  assert.match(change, /`\/api\/insights\/cart\/\$\{req\.endpoint\}`/);
  // Locked while it saves; a refusal says why and fetches /cart again (a 400
  // means the tab's options are stale), falling back to a redraw that unlocks it.
  assert.match(change, /el\.disabled = true/);
  assert.match(change, /alert\(err\.message\);[\s\S]*?reloadOrderList\(\)\.catch\(\(\) => drawOrderList\(\)\)/);
  assert.doesNotMatch(change, /drawOrderByItem\(\)/);
  assert.match(change, /orderListView === "items"/);
  // 1.13: what the quantity did, against the row as it was (1.12's words from an older server).
  assert.match(change, /quantityChangedMessage\(row, before, qty\)/);
  // Compare's Choose and Split say why when refused, not fail silently.
  const compare = fnBody(src, "openSupplierCompare");
  assert.equal((compare.match(/catch \(err\) \{\s*await refused\(err\);/g) ?? []).length, 2);
  // No new endpoint: every /cart write the page knows is one 1.7 already sent.
  const writes = new Set([...src.matchAll(/\/api\/insights\/cart\/([a-z-]+)/g)].map((m) => m[1]));
  for (const w of writes)
    assert.ok(["line", "select", "split", "reset", "undo", "take-off", "put-back", "use-preferred", "keep-pick"].includes(w), w);
});
