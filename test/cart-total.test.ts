/**
 * The Order list header total for split items (1.4).
 *
 * The header leads with what the order is worth, each item counted once at
 * its cheapest and dearest candidate supplier. A split's lines are parts of
 * one order, not alternatives, yet the header took the smallest part at the
 * low end and the largest at the high end: FG250P split 142/142 counted one
 * part at each end and read as a range, as if a decision were outstanding.
 * These pin what 1.4 counts and what it must leave alone:
 *   - a split's parts are summed, so with one line or one split per item the
 *     header is one figure equal to estimatedCost;
 *   - over splits, Δlow = Σ(sum − smallest part) and Δhigh = Σ(sum − largest
 *     part), and nothing else moves;
 *   - estimatedCost and the per-supplier subtotals are unchanged;
 *   - kit.doubleOrders counts items, not lines;
 *   - `stage-check splits`, the acceptance check run on captures, agrees.
 * No database: the totals are pure over the lines purchaseCart builds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { kitDoubleOrderItems, requirementRange, type CartState } from "../src/insights/cart.js";
import { splitChecks } from "../scripts/stage-check.mjs";

interface Line {
  itemUid: string;
  number: string;
  supplierUid: string;
  state: CartState;
  qty: number;
  estCost: number;
  kitDoubleOrder: boolean;
}
const line = (itemUid: string, supplierUid: string, state: CartState, qty: number, unit: number, kit = false): Line => ({
  itemUid, number: itemUid, supplierUid, state, qty, estCost: qty * unit, kitDoubleOrder: kit,
});

/** Lines grouped per supplier with their subtotals, the way purchaseCart serves them. */
function cart(lines: Line[]) {
  const groups = new Map<string, { supplierUid: string; supplierName: string; estimatedCost: number; lines: Line[] }>();
  for (const l of lines) {
    const g = groups.get(l.supplierUid) ?? { supplierUid: l.supplierUid, supplierName: l.supplierUid, estimatedCost: 0, lines: [] };
    g.lines.push(l);
    g.estimatedCost += l.estCost;
    groups.set(l.supplierUid, g);
  }
  return [...groups.values()];
}

/** What 1.3 counted: min and max over every line of an item, splits included. */
function oldRange(lines: Line[]) {
  const per = new Map<string, number[]>();
  for (const l of lines) per.set(l.itemUid, [...(per.get(l.itemUid) ?? []), l.estCost]);
  let low = 0;
  let high = 0;
  for (const c of per.values()) {
    low += Math.min(...c);
    high += Math.max(...c);
  }
  return { low: Number(low.toFixed(2)), high: Number(high.toFixed(2)) };
}

/** The cart payload stage-check reads, from lines and a header range. */
function payload(lines: Line[], range: { requirementLow: number; requirementHigh: number; estimatedCost: number }, doubleOrders: number) {
  return { ...range, totalLines: lines.length, suppliers: cart(lines), kit: { doubleOrders } };
}

// FG250P split 142/142; prices are illustrative, the shape is the live one.
const FG250P = [line("FG250P", "SKELLERUP", "split", 142, 1.5), line("FG250P", "SPECIALISED WASHERS", "split", 142, 1.25)];

test("FG250P split 142/142: both parts count at each end, so the header is one figure", () => {
  const r = requirementRange(cart(FG250P));
  assert.equal(r.requirementLow, 390.5);
  assert.equal(r.requirementHigh, 390.5);
  assert.equal(r.estimatedCost, 390.5);
  // 1.3 counted one part at each end: 177.50 (Specialised Washers) to 213.00 (Skellerup).
  assert.deepEqual(oldRange(FG250P), { low: 177.5, high: 213 });
});

test("over splits, Δlow = Σ(sum − smallest part) and Δhigh = Σ(sum − largest part)", () => {
  const uneven = [line("SPLIT3", "A", "split", 100, 2), line("SPLIT3", "B", "split", 40, 2), line("SPLIT3", "C", "split", 10, 2)];
  const lines = [...FG250P, ...uneven];
  const r = requirementRange(cart(lines));
  const old = oldRange(lines);
  const parts = (item: string) => lines.filter((l) => l.itemUid === item).map((l) => l.estCost);
  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  const dLow = ["FG250P", "SPLIT3"].reduce((a, i) => a + sum(parts(i)) - Math.min(...parts(i)), 0);
  const dHigh = ["FG250P", "SPLIT3"].reduce((a, i) => a + sum(parts(i)) - Math.max(...parts(i)), 0);
  assert.equal(Number((r.requirementLow - old.low).toFixed(2)), Number(dLow.toFixed(2)));
  assert.equal(Number((r.requirementHigh - old.high).toFixed(2)), Number(dHigh.toFixed(2)));
  assert.equal(r.requirementLow, 690.5);
  assert.equal(r.requirementHigh, 690.5);
});

test("a mixed cart: single lines, a pick and a split give one figure equal to estimatedCost", () => {
  const lines = [
    line("BN1665G", "HANOVA", "suggested", 1779, 0.42),
    line("SPW12G", "TONG MING", "edited", 3564, 0.05),
    line("N16G8", "HOBSON", "selected", 500, 0.3),
    ...FG250P,
  ];
  const groups = cart(lines);
  const r = requirementRange(groups);
  assert.equal(r.requirementLow, r.estimatedCost);
  assert.equal(r.requirementHigh, r.estimatedCost);
  assert.equal(r.estimatedCost, Number(lines.reduce((a, l) => a + l.estCost, 0).toFixed(2)));
  // Single lines read as before; only the split moved.
  const old = oldRange(lines);
  assert.equal(Number((r.requirementLow - old.low).toFixed(2)), 177.5 + 213 - 177.5);
  assert.equal(Number((r.requirementHigh - old.high).toFixed(2)), 177.5 + 213 - 213);
});

test("lines that really are alternatives still give a range; a split beside one is one candidate", () => {
  // Two suppliers each carrying the full quantity, no decision: the gap is the decision's worth.
  const alternatives = [line("X", "A", "suggested", 100, 1), line("X", "B", "edited", 100, 1.2)];
  assert.deepEqual(
    { low: requirementRange(cart(alternatives)).requirementLow, high: requirementRange(cart(alternatives)).requirementHigh },
    { low: 100, high: 120 },
  );
  // A legacy pick left beside a split: either the pick (300) or both parts (100 + 150).
  const mixed = [line("Y", "P", "selected", 300, 1), line("Y", "A", "split", 100, 1), line("Y", "B", "split", 150, 1)];
  const r = requirementRange(cart(mixed));
  assert.deepEqual([r.requirementLow, r.requirementHigh, r.estimatedCost], [250, 300, 550]);
});

test("estimatedCost and every supplier subtotal are what they were", () => {
  const lines = [line("BN1665G", "HANOVA", "suggested", 1779, 0.42), ...FG250P, line("FG250P2", "SKELLERUP", "split", 10, 3), line("FG250P2", "HANOVA", "split", 5, 3)];
  const groups = cart(lines);
  const before = groups.map((g) => [g.supplierUid, Number(g.estimatedCost.toFixed(2))]);
  const r = requirementRange(groups);
  assert.equal(r.estimatedCost, Number(lines.reduce((a, l) => a + l.estCost, 0).toFixed(2)));
  // requirementRange reads the groups; it never rewrites a line or a subtotal.
  assert.deepEqual(groups.map((g) => [g.supplierUid, Number(g.estimatedCost.toFixed(2))]), before);
  assert.deepEqual(groups.flatMap((g) => g.lines.map((l) => l.estCost)), cart(lines).flatMap((g) => g.lines.map((l) => l.estCost)));
});

test("an empty cart totals 0 at both ends", () => {
  assert.deepEqual(requirementRange([]), { requirementLow: 0, requirementHigh: 0, estimatedCost: 0 });
});

test("kit.doubleOrders counts items, not lines: a split kit is one", () => {
  const lines = [
    line("KITST1240S", "HANOVA", "split", 50, 4, true),
    line("KITST1240S", "JIAXING", "split", 50, 4, true),
    line("ST1240S16", "HANOVA", "suggested", 2000, 0.1, true),
    line("BN1665G", "HANOVA", "suggested", 1779, 0.42),
  ];
  assert.equal(kitDoubleOrderItems(cart(lines)), 2);
  assert.equal(kitDoubleOrderItems(cart(lines.filter((l) => !l.kitDoubleOrder))), 0);
});

const failed = (checks: { check: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.check);

test("stage-check splits passes a 1.3 → 1.4 pair and counts what moved", () => {
  const lines = [line("BN1665G", "HANOVA", "suggested", 1779, 0.42), ...FG250P.map((l) => ({ ...l, kitDoubleOrder: true }))];
  const est = Number(lines.reduce((a, l) => a + l.estCost, 0).toFixed(2));
  const old = oldRange(lines);
  const before = payload(lines, { requirementLow: old.low, requirementHigh: old.high, estimatedCost: est }, 2);
  const after = payload(lines, requirementRange(cart(lines)), kitDoubleOrderItems(cart(lines)));
  const checks = splitChecks({ before, after });
  assert.deepEqual(failed(checks), []);
  assert.match(checks[0].detail, /1 split item\(s\) \(FG250P\); 1 kit item\(s\) on 2 line\(s\); header low \+213, high \+177\.5/);
  // One capture alone: counted, nothing to compare.
  assert.equal(splitChecks({ after: before }).length, 1);
});

test("stage-check splits fails a header that kept the old rule, a moved subtotal and a line-counted kit total", () => {
  const lines = [...FG250P.map((l) => ({ ...l, kitDoubleOrder: true }))];
  const est = Number(lines.reduce((a, l) => a + l.estCost, 0).toFixed(2));
  const old = oldRange(lines);
  const before = payload(lines, { requirementLow: old.low, requirementHigh: old.high, estimatedCost: est }, 2);
  const unchanged = payload(lines, { requirementLow: old.low, requirementHigh: old.high, estimatedCost: est }, 2);
  assert.deepEqual(failed(splitChecks({ before, after: unchanged })), [
    "Δlow = Σ(sum − smallest part) over split items",
    "Δhigh = Σ(sum − largest part) over split items",
    "kit.doubleOrders counts items, not lines",
  ]);
  const moved = payload(lines.map((l, k) => (k ? l : { ...l, qty: 143, estCost: 143 * 1.5 })), requirementRange(cart(lines)), 1);
  assert.deepEqual(failed(splitChecks({ before, after: moved })), [
    "every supplier subtotal unchanged",
    "every line's qty, cost and state unchanged",
  ]);
});

test("stage-check splits fails a $0 line that vanished, though no subtotal moved", () => {
  const lines = [line("ITEM9", "NONE", "suggested", 12, 0), line("BN1665G", "NONE", "suggested", 10, 1)];
  const range = requirementRange(cart(lines));
  const before = payload(lines, range, 0);
  const after = payload(lines.slice(1), requirementRange(cart(lines.slice(1))), 0);
  assert.deepEqual(failed(splitChecks({ before, after })), ["every line's qty, cost and state unchanged"]);
});
