/**
 * Suggested qty follows the chosen supplier (1.13, Stage 14). Run with
 * `npm test`.
 *
 * Allied answered Q5 on 13 Oct: when they pick a different supplier, "yes it
 * should match with whatever supplier they pick". Pinned here:
 *   - suggestOrderQty, the suggestion arithmetic moved out of computeItem,
 *     gives what computeItem gave: BN1665G 1,779 and SPW12G 3,564 (prod,
 *     13 Oct, SPW12G on 1.2's On order), the MHS20EG case in its comment,
 *     the reorder multiple, and nothing to order;
 *   - suggestionInputs reads back exactly the inputs computeItem used;
 *   - supplierSuggestion, the per-line rule in the cart: the usual
 *     supplier's line keeps the item's own; another supplier's is rebuilt on
 *     its own lead (window minimum re-derived, hand-set minimum unchanged, no
 *     minimum weekly × lead); an unknown lead or the same lead keeps it;
 *   - `stage-check qty`, an independent copy of the rule, agrees with it,
 *     predicts the lines that move from one capture and, from two, proves
 *     that only those moved and that typed quantities did not;
 *   - the words: the message after a supplier change, Why this quantity,
 *     By supplier's working and Compare, and a server before 1.13.
 * No database: computeItem and the rule are pure, the rest is read from
 * source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { supplierSuggestion, type LineLead } from "../src/insights/cart.js";
import { computeItem, demandRate, suggestionInputs, suggestOrderQty, type ItemComputed } from "../src/insights/queries.js";
import { predictQty, predictSupplierSuggestion, qtyChecks } from "../scripts/stage-check.mjs";
import {
  coveredByOnOrderTitle,
  groupLinesByItem,
  leadBasisSentence,
  minLeadOwner,
  quantityChangedMessage,
  quantityStaysMessage,
} from "../public/order-list.js";

const WIN = { asAt: "2026-10-13", windowMonths: 6, longMonths: 12 };

/** A computeItem row: demand as the 13 Oct capture serves it, the rest as given. */
function row(o: {
  directWindow?: number; componentWindow?: number; directLong?: number; componentLong?: number;
  onHand: number; committed?: number; onOrder?: number;
  min?: { level: number; basis: "window" | "manual"; months?: number; burn?: number; lead?: number } | null;
  leadDays?: number | null; itemLead?: number | null; supplierLead?: number | null; orders?: number;
  reorder?: number | null; supplier?: string;
}) {
  return {
    uid: "u",
    number: "X",
    on_hand: o.onHand,
    committed: o.committed ?? 0,
    on_order: o.onOrder ?? 0,
    direct_window: o.directWindow ?? 0,
    comp_window: o.componentWindow ?? 0,
    direct_long: o.directLong ?? 0,
    comp_long: o.componentLong ?? 0,
    direct_year: 1,
    applied_min_level: o.min?.level ?? null,
    min_basis: o.min?.basis ?? null,
    min_window_months: o.min?.months ?? null,
    min_monthly_burn: o.min?.burn ?? null,
    min_lead_time_days: o.min?.lead ?? null,
    lead_time_days: o.leadDays ?? null,
    item_lead_days: o.itemLead ?? null,
    supplier_lead_days: o.supplierLead ?? null,
    lead_time_orders: o.orders ?? 0,
    reorder_qty: o.reorder ?? 0,
    assigned_supplier_uid: o.supplier ?? "SUP",
    assigned_supplier_name: o.supplier ?? "SUP",
  };
}

// BN1665G, prod 13 Oct: 792 sold + 3,548 consumed in 6 months, 323 free,
// 2,000 on order, Hanova's 120 days (Allied's), a 6-month window minimum of
// 2,771 (702.67 a month × 120 ÷ 30.44).
const BN1665G = row({
  directWindow: 792, componentWindow: 3548, directLong: 1404, componentLong: 6428,
  onHand: 323, onOrder: 2000, leadDays: 120, supplierLead: 120, orders: 11, supplier: "HANOVA",
  min: { level: 2771, basis: "window", months: 6, burn: 702.6666666666666, lead: 120 },
});
// SPW12G, prod 13 Oct, with On order as 1.2 counts it (15,560 less 00019910's phantom 560).
const SPW12G = row({
  directWindow: 21610, directLong: 33535, onHand: 1935, onOrder: 15000, leadDays: 120, supplierLead: 120, orders: 11, supplier: "HANOVA",
  min: { level: 13872, basis: "window", months: 6, burn: 3518.3333333333335, lead: 120 },
});
// N24S16M, prod 13 Oct: consumed by builds only, 227 free, 450 on order,
// 107 days set on the item, a 6-month window minimum of 2,349 from it.
const N24S16M = row({
  componentWindow: 3840, componentLong: 6924, onHand: 227, onOrder: 450, leadDays: 107, itemLead: 107, supplierLead: 120, supplier: "SHANDONG",
  min: { level: 2349, basis: "window", months: 6, burn: 668, lead: 107 },
});

test("suggestOrderQty gives computeItem's suggestion: BN1665G 1,779, SPW12G 3,564 (prod, 13 Oct)", () => {
  const bn = computeItem(BN1665G, WIN);
  assert.equal(bn.suggestion?.qty, 1779);
  assert.equal(bn.suggestion?.rationale.leadStock, 2771);
  assert.equal(bn.suggestion?.rationale.leadStockSource, "minimum");
  assert.equal(bn.suggestion?.rationale.leadTimeSource, "set by Allied on the supplier");
  const spw = computeItem(SPW12G, WIN);
  assert.equal(spw.suggestion?.qty, 3564);
  // The moved arithmetic is the only arithmetic: the round trip is exact.
  for (const i of [bn, spw, computeItem(N24S16M, WIN)])
    assert.deepEqual(suggestOrderQty(suggestionInputs(i)), i.suggestion);
});

test("suggestOrderQty: the minimum replaces the live lead term, never adds to it (MHS20EG in computeItem's comment)", () => {
  // 300 a week, 3.2 weeks of free stock, a 100-day (14.3-week) lead. With
  // no minimum the lead term is 300 × 14.29 = 4,286; a minimum of 5,250
  // stands in for it. Both together would be 4,286 more again, which the
  // comment rounds to "10,980 instead of 6,690".
  const base = { weekly: 300, basis: "window" as const, freeStock: 960, incoming: 0, belowMin: false, leadDays: 100, leadSource: "measured over 4 orders", reorderMultiple: null, targetCoverWeeks: 8 };
  assert.equal(suggestOrderQty({ ...base, minLevel: 5250 })?.qty, 6690);
  assert.equal(suggestOrderQty({ ...base, minLevel: null })?.qty, Math.ceil(300 * 8 + 300 * (100 / 7) - 960));
  assert.equal(suggestOrderQty({ ...base, minLevel: 5250 })?.rationale.leadStock, 5250);
  // A minimum re-derived for another supplier's lead stands in the same way (1.13).
  assert.equal(suggestOrderQty({ ...base, minLevel: 5250, minLeadStock: 1000 })?.qty, 2440);
  assert.equal(suggestOrderQty({ ...base, minLevel: 5250, minLeadStock: 1000 })?.rationale.minLevel, 5250);
});

test("suggestOrderQty: rounded up to MYOB's reorder multiple; nothing to order is qty 0, and no suggestion in computeItem", () => {
  const base = { weekly: 10, basis: "window" as const, freeStock: 5, incoming: 0, belowMin: false, minLevel: null, leadDays: null, leadSource: "not measured", targetCoverWeeks: 8 };
  assert.equal(suggestOrderQty({ ...base, reorderMultiple: 50 })?.qty, 100); // 75 -> 100
  assert.equal(suggestOrderQty({ ...base, reorderMultiple: 0 })?.qty, 75);
  const covered = suggestOrderQty({ ...base, incoming: 500, reorderMultiple: null });
  assert.equal(covered?.qty, 0);
  assert.equal(covered?.rationale.rawNeed, -425);
  // Unknown position, or no demand and not below the minimum: nothing to say.
  assert.equal(suggestOrderQty({ ...base, freeStock: null, reorderMultiple: null }), null);
  assert.equal(suggestOrderQty({ ...base, weekly: 0, reorderMultiple: null }), null);
  assert.equal(suggestOrderQty({ ...base, weekly: 0, belowMin: true, minLevel: 40, reorderMultiple: null })?.qty, 35);
  const item = computeItem(row({ directWindow: 10 * ((6 * 365.25) / 12 / 7), onHand: 5, onOrder: 500 }), WIN);
  assert.equal(item.suggestion, null);
  assert.equal(suggestOrderQty(suggestionInputs(item))?.qty, 0);
});

test("demandRate is computeItem's unrounded rate, which demand.weekly serves to 3 dp", () => {
  const i = computeItem(BN1665G, WIN);
  const r = demandRate(i.demand);
  assert.equal(r.basis, "window");
  assert.equal(Number(r.weekly.toFixed(3)), i.demand.weekly);
  assert.notEqual(r.weekly, i.demand.weekly);
  assert.deepEqual(demandRate({ directWindow: 0, componentWindow: 0, directLong: 52, componentLong: 0, windowMonths: 6, longMonths: 12 }).basis, "long");
});

/* ---------- the rule per supplier (cart.ts supplierSuggestion) ---------- */

const lead = (days: number | null, source: LineLead["source"] = "supplier", orders = 0): LineLead =>
  ({ days, setByAllied: source !== "measured", orders, sameDayExcluded: 0, source });

test("supplierSuggestion: the usual supplier's line is the item's own suggestion, exactly", () => {
  const n24 = computeItem(N24S16M, WIN);
  assert.equal(n24.suggestion?.qty, 2850);
  const s = supplierSuggestion(n24, "SHANDONG", "SHANDONG TENGDA", lead(107, "item"));
  assert.equal(s.qty, 2850);
  assert.equal(s.suggestion, n24.suggestion);
  assert.equal(s.suggestionFor.basis, "usual");
  assert.deepEqual(
    { leadDays: s.suggestionFor.leadDays, leadSource: s.suggestionFor.leadSource, usualQty: s.suggestionFor.usualQty, usualLeadSource: s.suggestionFor.usualLeadSource },
    { leadDays: 107, leadSource: "item", usualQty: 2850, usualLeadSource: "item" },
  );
  // No usual supplier at all: its No known supplier line is the item's own.
  const orphan = computeItem({ ...N24S16M, assigned_supplier_uid: null, assigned_supplier_name: null }, WIN);
  assert.equal(supplierSuggestion(orphan, "none", null, undefined).suggestionFor.basis, "usual");
});

test("supplierSuggestion: a window minimum is re-derived on the chosen supplier's lead (the plan's N24S16M → Hobson)", () => {
  // 668 a month × 30 ÷ 30.44 = 658.4 -> 659; 147.19 × 8 + 659 − 227 − 450 = 1,159.5 -> 1,160 (plan: "about 1,160 instead of 2,850").
  const s = supplierSuggestion(computeItem(N24S16M, WIN), "HOBSON", "HOBSON", lead(30));
  assert.equal(s.qty, 1160);
  assert.equal(s.suggestionFor.basis, "rebuilt");
  assert.equal(s.suggestion?.rationale.leadStock, 659);
  assert.equal(s.suggestion?.rationale.minLevel, 2349);
  assert.equal(s.suggestion?.rationale.leadTimeDays, 30);
  assert.equal(s.suggestion?.rationale.leadTimeSource, "set by Allied on the supplier");
  // At the lead the minimum was set from, the minimum itself: the same suggestion.
  const at107 = supplierSuggestion(computeItem({ ...N24S16M, item_lead_days: null, lead_time_days: 120 }, WIN), "TONGMING", "TONG MING", lead(107));
  assert.equal(at107.suggestionFor.basis, "same_lead");
  assert.equal(at107.qty, 2850);
});

test("supplierSuggestion: with no minimum, weekly × the chosen lead; a longer lead suggests more", () => {
  const i = computeItem(row({ directWindow: 1000, onHand: 50, leadDays: 83, orders: 9, supplier: "HANOVA" }), WIN);
  const weekly = demandRate(i.demand).weekly;
  const s = supplierSuggestion(i, "TANDL", "TANDL", lead(117, "measured", 4));
  assert.equal(s.qty, Math.ceil(weekly * 8 + weekly * (117 / 7) - 50));
  assert.ok(s.qty > (i.suggestion?.qty ?? 0));
  assert.equal(s.suggestion?.rationale.leadTimeSource, "measured over 4 orders");
  assert.equal(supplierSuggestion(i, "BREMICK", "BREMICK", lead(1, "measured", 30)).qty, Math.ceil(weekly * 8 + weekly / 7 - 50));
});

test("supplierSuggestion: a hand-set minimum, an unknown lead or a bare window row keep the item's own, and say which", () => {
  const manual = computeItem(row({ directWindow: 1000, onHand: 50, leadDays: 42, supplier: "TONGMING", min: { level: 900, basis: "manual" } }), WIN);
  const m = supplierSuggestion(manual, "HANOVA", "HANOVA", lead(83));
  assert.equal(m.suggestionFor.basis, "manual");
  assert.equal(m.qty, manual.suggestion?.qty);
  assert.equal(m.suggestion, manual.suggestion);
  const plain = computeItem(row({ directWindow: 1000, onHand: 50, leadDays: 83, supplier: "HANOVA" }), WIN);
  const u = supplierSuggestion(plain, "SCREWFAST", "SHANGHAI SCREW-FAST", undefined);
  assert.equal(u.suggestionFor.basis, "no_lead");
  assert.equal(u.qty, plain.suggestion?.qty);
  assert.equal(u.suggestionFor.leadDays, null);
  const bare = computeItem(row({ directWindow: 1000, onHand: 50, leadDays: 83, supplier: "HANOVA", min: { level: 700, basis: "window", months: 6 } }), WIN);
  assert.equal(supplierSuggestion(bare, "TANDL", "TANDL", lead(117)).suggestionFor.basis, "no_window");
});

/* ---------- stage-check qty ---------- */

/** The item fields a capture's items.json carries, from a computed item. */
const served = (i: ItemComputed, uid: string) => ({ ...JSON.parse(JSON.stringify(i)), uid });

test("stage-check's copy of the rule agrees with cart.ts on every case", () => {
  const cases: [ItemComputed, string, LineLead | undefined][] = [];
  const n24 = computeItem(N24S16M, WIN);
  for (const [uid, l] of [["SHANDONG", lead(107, "item")], ["HOBSON", lead(30)], ["TONGMING", lead(42, "measured", 3)], ["ANZOR", lead(1, "measured", 84)], ["NONE", undefined]] as const)
    cases.push([n24, uid, l]);
  const plain = computeItem(row({ directWindow: 1000, onHand: 50, onOrder: 20, leadDays: 83, supplier: "HANOVA", reorder: 25 }), WIN);
  for (const d of [1, 24, 83, 117]) cases.push([plain, "OTHER", lead(d, "measured")]);
  cases.push([computeItem(BN1665G, WIN), "JIAXING", lead(100)]);
  cases.push([computeItem(SPW12G, WIN), "TANDL", lead(102)]);
  for (const [item, uid, l] of cases) {
    const want = supplierSuggestion(item, uid, uid, l);
    const got = predictSupplierSuggestion(served(item, "u"), uid, l ? { days: l.days, source: l.source } : null, 8);
    assert.deepEqual({ qty: got.qty, basis: got.basis }, { qty: want.qty, basis: want.suggestionFor.basis }, `${item.number} under ${uid}`);
  }
});

/*
 * A two-line /cart: N24S16M picked to Hobson showing its suggestion, and
 * PLAIN picked to TANDL with a typed 600. `after` is what 1.13 serves.
 */
function qtyCarts() {
  const n24 = served(computeItem(N24S16M, WIN), "N24");
  const plain = served(computeItem(row({ directWindow: 1000, onHand: 50, leadDays: 83, supplier: "HANOVA" }), WIN), "PLAIN");
  plain.number = "PLAIN";
  n24.number = "N24S16M";
  const opt = (uid: string, d: number | null, cost: number) => ({ supplierUid: uid, supplierName: uid, leadTimeDays: d, leadTimeSource: d == null ? null : "supplier", lastCost: cost, qty: 0, inCart: false });
  const l = (item: typeof n24, uid: string, d: number, state: string, qty: number, extra: Record<string, unknown> = {}) => ({
    itemUid: item.uid, number: item.number, supplierUid: uid, supplierName: uid, state, qty, suggestedQty: item.suggestion?.qty ?? 0,
    estCost: qty * 2, lastCost: 2, averageCost: 1, leadTimeDays: d, leadTimeSource: "supplier", qtyCarriedFrom: null,
    options: [opt(item.supplierUid, item.leadTimeDays, 1.5), { ...opt(uid, d, 2), qty, inCart: true }],
    rationale: { leadStockBasis: item.minStock ? "window" : "lead" }, ...extra,
  });
  const before = {
    estimatedCost: 0, requirementLow: 0, requirementHigh: 0,
    suppliers: [
      { supplierUid: "HOBSON", supplierName: "HOBSON", estimatedCost: 0, lines: [l(n24, "HOBSON", 30, "selected", 2850)] },
      { supplierUid: "TANDL", supplierName: "TANDL", estimatedCost: 0, lines: [l(plain, "TANDL", 117, "selected", 600)] },
    ],
    decisions: [], pickConflicts: [],
  };
  for (const g of before.suppliers) g.estimatedCost = g.lines.reduce((a, x) => a + x.estCost, 0);
  before.estimatedCost = before.requirementLow = before.requirementHigh = Number(before.suppliers.reduce((a, g) => a + g.estimatedCost, 0).toFixed(2));
  return { items: [n24, plain], before };
}

/** What a 1.13 server would serve for that cart, from cart.ts's own rule. */
function served113(items: ReturnType<typeof qtyCarts>["items"], before: ReturnType<typeof qtyCarts>["before"]) {
  const after = JSON.parse(JSON.stringify(before));
  const byUid = new Map(items.map((i) => [i.uid, i]));
  for (const g of after.suppliers) {
    for (const ln of g.lines) {
      const item = byUid.get(ln.itemUid);
      const own = supplierSuggestion(item, ln.supplierUid, ln.supplierName, lead(ln.leadTimeDays));
      const typed = ln.qty !== ln.suggestedQty;
      ln.qtyTyped = typed;
      ln.suggestedQty = own.qty;
      if (!typed) ln.qty = own.qty;
      ln.estCost = ln.qty * 2;
      ln.rationale = { ...ln.rationale, suggestionFor: own.suggestionFor };
      for (const o of ln.options) {
        const s = supplierSuggestion(item, o.supplierUid, o.supplierName, o.leadTimeDays == null ? undefined : lead(o.leadTimeDays));
        Object.assign(o, { suggestedQty: s.qty, suggestedEstCost: s.qty * o.lastCost, suggestionBasis: s.suggestionFor.basis });
        if (o.inCart) o.qty = ln.qty;
      }
    }
    g.estimatedCost = g.lines.reduce((a: number, x: { estCost: number }) => a + x.estCost, 0);
  }
  after.estimatedCost = after.requirementLow = after.requirementHigh = Number(after.suppliers.reduce((a: number, g: { estimatedCost: number }) => a + g.estimatedCost, 0).toFixed(2));
  return after;
}

test("stage-check qty: predicts the untyped pick old -> new and leaves the typed one's qty", () => {
  const { items, before } = qtyCarts();
  const p = predictQty({ items, cart: before });
  assert.deepEqual(
    p.changed.map((r: { number: string; new: { suggestedQty: number; qty: number }; typed: boolean }) => [r.number, r.new.suggestedQty, r.new.qty, r.typed]),
    [["N24S16M", 1160, 1160, false], ["PLAIN", supplierSuggestion(items[1], "TANDL", "TANDL", lead(117)).qty, 600, true]],
  );
  const { checks } = qtyChecks({ before, items });
  assert.ok(checks.every((c: { ok: boolean }) => c.ok));
});

test("stage-check qty: passes 1.13's cart, and fails a typed qty that moved or a line nobody predicted", () => {
  const { items, before } = qtyCarts();
  const after = served113(items, before);
  const ok = qtyChecks({ before, after, items, afterItems: items });
  assert.deepEqual(ok.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { check: string }) => c.check), []);
  const failing = (mutate: (a: typeof after) => void) => {
    const bad = JSON.parse(JSON.stringify(after));
    mutate(bad);
    return qtyChecks({ before, after: bad, items, afterItems: items }).checks.filter((c: { ok: boolean }) => !c.ok).map((c: { check: string }) => c.check);
  };
  const typedMoved = failing((a) => {
    const ln = a.suppliers[1].lines[0];
    ln.qty = ln.suggestedQty;
    ln.estCost = ln.qty * 2;
    a.suppliers[1].estimatedCost = ln.estCost;
  });
  assert.ok(typedMoved.includes("typed quantities never move"));
  assert.ok(typedMoved.includes("each line's suggested, order qty and est. cost = the prediction"));
  assert.ok(failing((a) => { a.suppliers[0].lines[0].options[0].suggestedQty += 1; }).includes("each compare option's own suggestion = the prediction; an option in the cart shows its line's qty"));
  assert.ok(failing((a) => { a.estimatedCost += 1; }).includes("supplier subtotals and the header add up from the lines"));
  assert.ok(failing((a) => { a.suppliers[0].lines[0].leadTimeDays = 31; }).includes("every other /cart field identical"));
});

/* ---------- the words (order-list.js, dashboard.js) ---------- */

const fixedQty = (v: unknown) => Number(v).toLocaleString("en-NZ");

// N24S16M on the 26 Aug copy with the Stage 14 setup: 107 days on the item, a
// 6-month minimum of 1,725 from it (490.67 a month), Shandong Tengda usual,
// picked to Hobson (measured 24 days), as /cart serves it.
const SF_USUAL = { supplierUid: "SHANDONG", supplierName: "SHANDONG TENGDA", basis: "usual", leadDays: 107, leadSource: "item", usualQty: 2361, usualSupplierName: "SHANDONG TENGDA", usualLeadDays: 107, usualLeadSource: "item" };
const SF_HOBSON = { ...SF_USUAL, supplierUid: "HOBSON", supplierName: "HOBSON ENGINEERING Co. PTY.LTD", basis: "rebuilt", leadDays: 24, leadSource: "measured" };
const WINDOW_R = { demandWindowMonths: 6, leadStockBasis: "window", minWindowMonths: 6, minLeadTimeDays: 107, minLevel: 1725 };
function n24Row(sf: Record<string, unknown> | null, over: Record<string, unknown> = {}, rationale: Record<string, unknown> = {}) {
  const usual = sf?.basis === "usual";
  const l = {
    itemUid: "N24", number: "N24S16M", supplierUid: usual ? "SHANDONG" : "HOBSON", supplierName: usual ? "SHANDONG TENGDA" : "HOBSON ENGINEERING Co. PTY.LTD",
    isPreferred: usual, state: usual ? "suggested" : "selected", qty: usual ? 2361 : 1023, suggestedQty: usual ? 2361 : 1023, estCost: 0,
    leadTimeDays: usual ? 107 : 24, leadTimeSource: usual ? "item" : "measured", minLevel: 1725, qtyTyped: false,
    rationale: {
      ...WINDOW_R,
      leadStock: usual ? 1725 : 387,
      leadTimeDaysUsed: usual ? 107 : 24, leadTimeUsedFor: usual ? "SHANDONG TENGDA" : "HOBSON ENGINEERING Co. PTY.LTD", leadTimeUsedSource: usual ? "item" : "measured",
      ...(sf ? { suggestionFor: sf } : {}),
      ...rationale,
    },
    ...over,
  };
  return groupLinesByItem({ suppliers: [{ supplierUid: l.supplierUid, lines: [l] }] })[0];
}

test("After a supplier change: the quantity rebuilt on the chosen supplier, and back again", () => {
  const usual = n24Row(SF_USUAL);
  const hobson = n24Row(SF_HOBSON);
  assert.equal(
    quantityChangedMessage(hobson, usual, fixedQty),
    "Quantity is now 1,023, rebuilt on HOBSON ENGINEERING Co. PTY.LTD's 24-day lead time (was 2,361 on this item's own 107 days).",
  );
  assert.equal(
    quantityChangedMessage(usual, hobson, fixedQty),
    "Quantity is now 2,361, built on this item's own 107-day lead time (was 1,023 on HOBSON ENGINEERING Co. PTY.LTD's 24 days).",
  );
  // Without the row as it was: "was" is the item's own suggestion.
  assert.equal(quantityChangedMessage(hobson, null, fixedQty), "Quantity is now 1,023, rebuilt on HOBSON ENGINEERING Co. PTY.LTD's 24-day lead time (was 2,361 on this item's own 107 days).");
  // Rebuilt to the same number (a rounding, or 0 both ways): it stays.
  assert.equal(quantityChangedMessage(n24Row(SF_HOBSON, { qty: 2361, suggestedQty: 2361 }), usual, fixedQty), "Quantity stays 2,361, rebuilt on HOBSON ENGINEERING Co. PTY.LTD's 24-day lead time.");
});

test("After a supplier change: a typed qty stays, a hand-set minimum stays, an unknown lead keeps the usual suggestion", () => {
  const typed = n24Row(SF_HOBSON, { qty: 600, qtyTyped: true });
  assert.equal(quantityChangedMessage(typed, n24Row(SF_USUAL, { qty: 600, qtyTyped: true }), fixedQty), "Quantity stays 600, the number you typed. The suggestion for HOBSON ENGINEERING Co. PTY.LTD is 1,023.");
  // A hand-set minimum keeps the item's own on every line (usualQty = qty).
  const manual = n24Row({ ...SF_HOBSON, basis: "manual", leadDays: null, leadSource: null, usualQty: 9259, usualLeadDays: null, usualLeadSource: null }, { qty: 9259, suggestedQty: 9259 }, { leadStockBasis: "manual" });
  assert.equal(quantityChangedMessage(manual, null, fixedQty), "Quantity stays 9,259 — your hand-set minimum doesn't depend on lead time.");
  const noLead = n24Row({ ...SF_HOBSON, basis: "no_lead", supplierName: "SHANGHAI SCREW-FAST", leadDays: null, leadSource: null }, { qty: 2361, suggestedQty: 2361 });
  assert.equal(quantityChangedMessage(noLead, null, fixedQty), "Quantity stays 2,361. No lead time is known for SHANGHAI SCREW-FAST, so it keeps the suggestion built on this item's own 107 days.");
  const same = n24Row({ ...SF_HOBSON, basis: "same_lead", leadDays: 107 }, { qty: 2361, suggestedQty: 2361 });
  assert.equal(quantityChangedMessage(same, null, fixedQty), "Quantity stays 2,361: HOBSON ENGINEERING Co. PTY.LTD's lead time is 107 days, the same as the one the suggestion is built on.");
});

test("After a supplier change: a hand-set minimum back with the usual supplier, and a second pick that moves back", () => {
  // ST20170G-style: Hanova pick of a hand-set minimum, then Use preferred.
  // The usual line carries no usual lead (cart.ts: a hand-set minimum has none).
  const manualSf = { ...SF_USUAL, leadDays: null, leadSource: null, usualQty: 9259, usualLeadDays: null, usualLeadSource: null };
  const back = n24Row(manualSf, { qty: 9259, suggestedQty: 9259, minLevel: 9000 }, { leadStockBasis: "manual" });
  const pick = n24Row({ ...manualSf, supplierUid: "HOBSON", supplierName: "HOBSON ENGINEERING Co. PTY.LTD", basis: "manual" }, { qty: 9259, suggestedQty: 9259, minLevel: 9000 }, { leadStockBasis: "manual" });
  assert.equal(quantityChangedMessage(back, pick, fixedQty), "Quantity stays 9,259 — your hand-set minimum doesn't depend on lead time.");
  // Hobson's rebuilt 1,023, then a supplier with no lead known: back to the item's own.
  const noLead = n24Row({ ...SF_HOBSON, basis: "no_lead", supplierName: "SHANGHAI SCREW-FAST", leadDays: null, leadSource: null }, { qty: 2361, suggestedQty: 2361 });
  assert.equal(
    quantityChangedMessage(noLead, n24Row(SF_HOBSON), fixedQty),
    "Quantity is now 2,361 (was 1,023 on HOBSON ENGINEERING Co. PTY.LTD's 24 days). No lead time is known for SHANGHAI SCREW-FAST, so it keeps the suggestion built on this item's own 107 days.",
  );
  const same = n24Row({ ...SF_HOBSON, basis: "same_lead", leadDays: 107 }, { qty: 2361, suggestedQty: 2361 });
  assert.match(quantityChangedMessage(same, n24Row(SF_HOBSON), fixedQty), /^Quantity is now 2,361 \(was 1,023 on .*24 days\): HOBSON/);
});

test("A window minimum set from a lead that is no longer the item's is credited to no supplier", () => {
  const drifted = { ...SF_HOBSON, usualLeadDays: 120, usualLeadSource: null };
  assert.equal(
    leadBasisSentence(n24Row(drifted, {}, { minLeadTimeDays: 120 }).lines[0], [], fixedQty),
    "Rebuilt on HOBSON ENGINEERING Co. PTY.LTD's 24 days: your minimum (1,725, from a 120-day lead time) comes to 387 at that lead time, and that sets the lead-time stock. On a 120-day lead time it would be 2,361.",
  );
  assert.equal(minLeadOwner(n24Row(drifted, {}, { minLeadTimeDays: 120 }).lines[0].rationale), null);
});

test("A split row's Why this quantity is the item's own, whichever part /cart lists first", () => {
  const tong = n24Row({ ...SF_HOBSON, supplierName: "TONG MING", leadDays: 42 }).lines[0];
  const shandong = n24Row(SF_USUAL).lines[0];
  const split = groupLinesByItem({ suppliers: [{ lines: [{ ...tong, state: "split" }] }, { lines: [{ ...shandong, state: "split" }] }] })[0];
  assert.equal(split.suggestedQty, 2361);
  assert.equal(leadBasisSentence(split.lines[0], [], fixedQty, false), leadBasisSentence(shandong, [], fixedQty, false));
  assert.equal(leadBasisSentence(split.lines[0], [], fixedQty, false), "Your minimum (1,725, from this item's own 107 days) sets the lead-time stock.");
});

test("The min tooltip on a rebuilt line names the minimum's own lead, and covered-by-on-order says why", () => {
  const src = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
  const cartMinTitle = new Function("minLeadOwner", "qty", `${fnBody(src, "cartMinTitle")}; return cartMinTitle;`)(minLeadOwner, fixedQty);
  assert.equal(
    cartMinTitle(n24Row(SF_HOBSON).lines[0]),
    "Minimum stock level set under Purchasing › Minimum stock review, from this item's own 107-day lead time over 6 months of use. At this supplier's 24-day lead time it comes to 387, and that sets the lead-time stock.",
  );
  // BN16425G with TANDL: the minimum came from the usual supplier's 83 days.
  const tandl = { ...SF_HOBSON, supplierName: "TANDL", leadDays: 117, usualSupplierName: "HANOVA", usualLeadDays: 83, usualLeadSource: "measured" };
  assert.match(cartMinTitle(n24Row(tandl, {}, { minLeadTimeDays: 83, leadStock: 973 }).lines[0]), /from HANOVA's 83-day lead time .* At this supplier's 117-day lead time it comes to 973/);
  assert.match(cartMinTitle(n24Row(SF_USUAL).lines[0]), /from this item's own 107-day lead time over 6 months of use\. It sets the lead-time stock\.$/);
  // B20140S16 with Hobson: rebuilt to 0, no minimum.
  const zero = n24Row(SF_HOBSON, { qty: 0, suggestedQty: 0, minLevel: null, incomingQty: 600 }, { leadStockBasis: "lead" });
  assert.match(coveredByOnOrderTitle(zero), /^Free stock plus what is already on order covers this supplier's lead time/);
  assert.match(coveredByOnOrderTitle(n24Row(SF_USUAL, { qty: 0, suggestedQty: 0 })), /^Below its minimum/);
});

test("After a supplier change: a server before 1.13 (no suggestionFor) gets 1.12's words", () => {
  const old = n24Row(null);
  assert.equal(quantityChangedMessage(old, null, fixedQty), quantityStaysMessage(old, fixedQty));
  assert.match(quantityChangedMessage(old, null, fixedQty), /^Quantity stays 1,023\./);
});

test("Why this quantity names the line's own lead and what it made of the minimum", () => {
  assert.equal(
    leadBasisSentence(n24Row(SF_HOBSON).lines[0], [], fixedQty),
    "Rebuilt on HOBSON ENGINEERING Co. PTY.LTD's 24 days: your minimum (1,725, from this item's own 107 days) comes to 387 at that lead time, and that sets the lead-time stock. On this item's own 107 days it would be 2,361.",
  );
  const tongMing = { ...SF_HOBSON, supplierName: "TONG MING", leadDays: 42, usualQty: 1158, usualLeadDays: 131, usualLeadSource: "measured" };
  assert.equal(
    leadBasisSentence(n24Row(tongMing, { minLevel: null }, { leadStockBasis: "lead", minLevel: 0 }).lines[0], [], fixedQty),
    "Rebuilt on TONG MING's 42-day lead time, this order's supplier. On SHANDONG TENGDA's 131 days it would be 1,158.",
  );
  // The usual supplier's line reads as in 1.12.
  assert.equal(leadBasisSentence(n24Row(SF_USUAL).lines[0], [], fixedQty), "Your minimum (1,725, from this item's own 107 days) sets the lead-time stock.");
});

test("By item: a one-line row suggests its line's own; a split row the item's own, not the parts' sum", () => {
  assert.equal(n24Row(SF_HOBSON).suggestedQty, 1023);
  const part = (uid: string, sug: number, qty: number, sf: Record<string, unknown>) => ({ itemUid: "N10", number: "N10S16", supplierUid: uid, supplierName: uid, state: "split", qty, suggestedQty: sug, estCost: qty, rationale: { suggestionFor: sf } });
  const split = groupLinesByItem({ suppliers: [
    { lines: [part("TONGMING", 4495, 2000, { basis: "rebuilt", usualQty: 9472 })] },
    { lines: [part("SHANDONG", 9472, 5000, { basis: "usual", usualQty: 9472 })] },
  ] })[0];
  assert.equal(split.suggestedQty, 9472);
  assert.equal(split.qty, 7000);
  // A server before 1.13: the first line's, which was every line's.
  const old = groupLinesByItem({ suppliers: [{ lines: [{ ...part("A", 151, 142, {}), rationale: {} }, { ...part("B", 151, 142, {}), rationale: {} }] }] })[0];
  assert.equal(old.suggestedQty, 151);
});

/** The body of a top-level `function name(` in dashboard.js. */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `dashboard.js has no function ${name}`);
  const rest = src.slice(start + 1);
  const end = rest.search(/^(?:async )?function |^const |^let |^\/\*/m);
  return src.slice(start, start + 1 + (end < 0 ? rest.length : end));
}

test("dashboard.js: By supplier's working and Compare's Est cost follow the line's own supplier", () => {
  const src = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");
  const esc = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const qty = fixedQty;
  const money = (v: unknown) => `$${Number(v).toFixed(2)}`;
  const leadOwner = () => null;
  const cartLeadBit = new Function("esc", "leadOwner", "qty", `${fnBody(src, "cartLeadBit")}; return cartLeadBit;`)(esc, leadOwner, qty);
  const text = (v: unknown) => String(v).replace(/<[^>]*>/g, "");
  const hobson = n24Row(SF_HOBSON).lines[0];
  assert.equal(text(cartLeadBit(hobson)), "min at this supplier's 24d lead: 387");
  const lead = { ...hobson, minLevel: null, rationale: { ...hobson.rationale, leadStockBasis: "lead" } };
  assert.equal(text(cartLeadBit(lead)), "built on this supplier's 24d lead");
  assert.match(String(cartLeadBit(lead)), /With SHANDONG TENGDA it would be 2,361/);
  const compareEstCell = new Function("esc", "qty", "money", `${fnBody(src, "compareEstCell")}; return compareEstCell;`)(esc, qty, money);
  assert.equal(text(compareEstCell({ suggestedQty: 1023, suggestedEstCost: 1933.33, suggestionBasis: "rebuilt" }, { suggestedQty: 2361 }, 1.89)), "$1933.33for 1,023 suggested");
  // A server before 1.13: every supplier at the line's suggestion, as before.
  assert.equal(compareEstCell({}, { suggestedQty: 2361 }, 2), "$4722.00");
  // The row's dropdown change words the quantity with the row as it was.
  assert.match(fnBody(src, "changeRowSupplier"), /quantityChangedMessage\(row, before, qty\)/);
});
