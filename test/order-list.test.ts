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
 * No database: public/order-list.js is a plain browser module, imported as is.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// @ts-ignore — plain browser module, no types
import { groupLinesByItem } from "../public/order-list.js";

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
  const calls = src.match(/toggleExpandRow\([^)]*\)/g)?.filter((c) => !c.startsWith("toggleExpandRow(tr, lookup")) ?? [];
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.match(c, /toggleExpandRow\(tr, invItems, headers\.length, \{ targetCoverWeeks: invTargetCover \}/);
});
