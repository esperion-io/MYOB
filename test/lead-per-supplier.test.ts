/**
 * Lead time per supplier in Purchasing (1.12, Stage 13), tested on the
 * shape of N24S16M on prod, with illustrative figures. Run with `npm test`.
 *
 * Allied answered Q5 on 12–14 Oct: "when they pick a different supplier, the
 * suggested qty should match with whatever supplier they pick". Q2b was not
 * answered directly; our reading is that a lead time set on an item is for
 * its usual supplier. This release does the
 * lead-time half: under any supplier but the item's usual (effective) one,
 * the cart shows that supplier's own lead. Two things are pinned here:
 *   - leadForSupplier, the one rule the cart uses for every line and option;
 *   - `stage-check leads`, which predicts the rows that move from one 1.11
 *     capture (the list Allied get) and, from two, proves that only those
 *     moved and that quantities, costs and totals did not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { leadForSupplier } from "../src/insights/cart.js";

// Illustrative, shaped on N24S16M: 107 days on the item, usual supplier
// Shandong Tengda (Allied's 120, as on prod 13 Oct). The others are made up to
// cover each source: Hobson set to 30 by Allied, Tong Ming measured at 42 over
// 3 orders, Anzor no lead at all. (On prod Tong Ming is Allied's 45, Anzor
// measured at 1 day over 84 orders, and Hobson is not on file for N24S16M.)
const SUPPLIER_LEAD = new Map([
  ["SHANDONG", { days: 120, setByAllied: true, orders: 1, sameDayExcluded: 0 }],
  ["HOBSON", { days: 30, setByAllied: true, orders: 2, sameDayExcluded: 0 }],
  ["TONGMING", { days: 42, setByAllied: false, orders: 3, sameDayExcluded: 1 }],
]);
const N24 = { leadTimeItemDays: 107, supplierUid: "SHANDONG" };

test("leadForSupplier: an item's own lead applies under its usual supplier", () => {
  assert.deepEqual(leadForSupplier(N24, "SHANDONG", SUPPLIER_LEAD), {
    days: 107, setByAllied: true, orders: 0, sameDayExcluded: 0, source: "item",
  });
});

test("leadForSupplier: under another supplier, that supplier's own lead: Allied's, else measured, else none", () => {
  assert.deepEqual(leadForSupplier(N24, "HOBSON", SUPPLIER_LEAD), {
    days: 30, setByAllied: true, orders: 2, sameDayExcluded: 0, source: "supplier",
  });
  assert.deepEqual(leadForSupplier(N24, "TONGMING", SUPPLIER_LEAD), {
    days: 42, setByAllied: false, orders: 3, sameDayExcluded: 1, source: "measured",
  });
  assert.equal(leadForSupplier(N24, "ANZOR", SUPPLIER_LEAD), undefined);
});

test("leadForSupplier: with no item lead, every supplier its own, the usual one included", () => {
  const plain = { leadTimeItemDays: null, supplierUid: "SHANDONG" };
  assert.equal(leadForSupplier(plain, "SHANDONG", SUPPLIER_LEAD)?.days, 120);
  assert.equal(leadForSupplier(plain, "SHANDONG", SUPPLIER_LEAD)?.source, "supplier");
  assert.equal(leadForSupplier(plain, "TONGMING", SUPPLIER_LEAD)?.source, "measured");
  assert.equal(leadForSupplier(plain, "ANZOR", SUPPLIER_LEAD), undefined);
});

test("leadForSupplier: an item with no usual supplier keeps its own lead on every line, as before", () => {
  // No supplier on file, or ruled none: its "No known supplier" line is the
  // one the suggestion is built for.
  const orphan = { leadTimeItemDays: 60, supplierUid: null };
  assert.equal(leadForSupplier(orphan, "none", SUPPLIER_LEAD)?.days, 60);
  assert.equal(leadForSupplier(orphan, "HOBSON", SUPPLIER_LEAD)?.source, "item");
});

test("cart.ts: every line and option takes its lead from leadForSupplier; the quantity reads it only through supplierSuggestion (1.13)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/insights/cart.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function purchaseCart"), src.indexOf("export function requirementRange"));
  // One leadFor, delegating; no second rule inline.
  assert.match(body, /const leadFor = \(item: ItemComputed, supplierUid: string\) => leadForSupplier\(item, supplierUid, supplierLead\);/);
  assert.doesNotMatch(body, /leadTimeItemDays/);
  assert.equal((body.match(/leadTimeSource: lt\?\.source \?\? null/g) ?? []).length, 2);
  // The item's own suggestion is still at hand; from 1.13 each supplier's
  // own is supplierSuggestion on that supplier's lead (test/suggest-qty.test.ts),
  // and the lead it was built on is the item's unless the line was rebuilt.
  assert.match(body, /const suggested = item\.suggestion\?\.qty \?\? 0;/);
  assert.match(body, /supplierSuggestion\(item, o\.supplierUid, o\.supplierName, leadFor\(item, o\.supplierUid\)\)/);
  assert.match(body, /leadTimeDaysUsed: rebuilt \? own\.suggestionFor\.leadDays : item\.leadTimeDays,/);
});

/* ---------- stage-check leads ---------- */

type Lead = { leadTimeDays: number | null; leadTimeSetByAllied: boolean; leadTimeOrders: number; leadTimeSameDayExcluded: number; leadTimeSource?: string | null };
const L = (days: number | null, byAllied: boolean, orders: number, source?: string | null): Lead => ({
  leadTimeDays: days, leadTimeSetByAllied: byAllied, leadTimeOrders: orders, leadTimeSameDayExcluded: 0,
  ...(source === undefined ? {} : { leadTimeSource: source }),
});

/*
 * Two items: N24S16M (item lead 107, usual Shandong Tengda, picked to Hobson,
 * Tong Ming and Anzor also on file) and B16100S16 (no item lead; Shandong
 * Tengda usual, Hobson and Tong Ming on file, which is where the capture
 * reads those suppliers' own leads from).
 */
function capturePair() {
  const opt = (uid: string, name: string, lead: Lead) => ({ supplierUid: uid, supplierName: name, region: null, source: "allied", isPreferred: uid === "SHANDONG", lastCost: 1, ...lead, state: null, qty: 2760, inCart: false });
  const cartOf = (v: "1.11" | "1.12") => {
    const src = (s: string) => (v === "1.12" ? s : undefined);
    const n24Opts = v === "1.11"
      ? [opt("SHANDONG", "SHANDONG TENGDA", L(107, true, 0)), opt("HOBSON", "HOBSON", L(107, true, 0)), opt("TONGMING", "TONG MING", L(107, true, 0)), opt("ANZOR", "ANZOR", L(107, true, 0))]
      : [opt("SHANDONG", "SHANDONG TENGDA", L(107, true, 0, "item")), opt("HOBSON", "HOBSON", L(30, true, 2, "supplier")), opt("TONGMING", "TONG MING", L(42, false, 3, "measured")), opt("ANZOR", "ANZOR", L(null, false, 0, null))];
    const bOpts = [opt("SHANDONG", "SHANDONG TENGDA", L(120, true, 1, src("supplier"))), opt("HOBSON", "HOBSON", L(30, true, 2, src("supplier"))), opt("TONGMING", "TONG MING", L(42, false, 3, src("measured")))];
    const n24Line = { itemUid: "N24", number: "N24S16M", supplierUid: "HOBSON", supplierName: "HOBSON", qty: 2760, suggestedQty: 2760, estCost: 2760, state: "selected",
      ...(v === "1.11" ? L(107, true, 0) : L(30, true, 2, "supplier")), options: n24Opts,
      rationale: { leadTimeDays: v === "1.11" ? 107 : 30, leadTimeDaysUsed: 107, leadTimeUsedFor: "SHANDONG TENGDA", leadTimeUsedSource: "item" } };
    const bLine = { itemUid: "B16", number: "B16100S16", supplierUid: "SHANDONG", supplierName: "SHANDONG TENGDA", qty: 500, suggestedQty: 500, estCost: 500, state: "suggested",
      ...L(120, true, 1, src("supplier")), options: bOpts, rationale: { leadTimeDays: 120, leadTimeDaysUsed: 120, leadTimeUsedFor: "SHANDONG TENGDA", leadTimeUsedSource: "supplier" } };
    return {
      generatedAt: v, totalLines: 2, totalItems: 2, estimatedCost: 3260,
      suppliers: [
        { supplierUid: "HOBSON", supplierName: "HOBSON", leadTimeDays: 30, itemCount: 1, estimatedCost: 2760, lines: [n24Line] },
        { supplierUid: "SHANDONG", supplierName: "SHANDONG TENGDA", leadTimeDays: 120, itemCount: 1, estimatedCost: 500, lines: [bLine] },
      ],
    };
  };
  const items = [
    { uid: "N24", number: "N24S16M", supplierUid: "SHANDONG", leadTimeItemDays: 107, leadTimeSupplierDays: 120, leadTimeMeasuredDays: 131, leadTimeOrders: 1 },
    { uid: "B16", number: "B16100S16", supplierUid: "SHANDONG", leadTimeItemDays: null, leadTimeSupplierDays: 120, leadTimeMeasuredDays: 131, leadTimeOrders: 1 },
  ];
  return { before: cartOf("1.11"), after: cartOf("1.12"), items };
}

// What --base adds: /suppliers.csv, which names Anzor's measured lead (none).
const ANZOR_NAMED = {
  suppliers: { suppliers: [{ uid: "ANZOR", name: "ANZOR", lead_time_days: null }] },
  suppliersCsv: "\uFEFFSupplier,MYOB ID,Lead time (days),Orders measured,Same-day ignored\r\nANZOR,AN,,0,0\r\n",
};

test("stage-check leads: one capture predicts the rows that move, each supplier's own lead read off the capture", async () => {
  const { leadChecks, leadRowText } = await import("../scripts/stage-check.mjs");
  const { before, items } = capturePair();
  const { checks, rows, mode } = leadChecks({ before, items });
  assert.equal(mode, "predicted");
  // Anzor has no lead anywhere in the capture: unknown until suppliers.json says otherwise.
  assert.deepEqual(rows.map((r: { supplierName: string }) => r.supplierName), ["ANZOR", "HOBSON", "TONG MING"]);
  assert.equal(checks.find((c: { check: string }) => /named by the capture/.test(c.check)).ok, false);
  // /suppliers.csv (--base) names a supplier's measured lead, by name; blank is none.
  const csv = "\uFEFFSupplier,MYOB ID,Lead time (days),Orders measured,Same-day ignored\r\nANZOR,AN,,0,0\r\n";
  const viaCsv = leadChecks({ before, items, suppliers: { suppliers: [{ uid: "ANZOR", name: "ANZOR", lead_time_days: null }] }, suppliersCsv: csv });
  assert.ok(viaCsv.checks.every((c: { ok: boolean }) => c.ok));
  assert.equal(viaCsv.rows.find((r: { supplierName: string }) => r.supplierName === "ANZOR").new, null);
  const viaCsv1 = leadChecks({ before, items, suppliers: { suppliers: [{ uid: "ANZOR", name: "ANZOR", lead_time_days: null }] }, suppliersCsv: csv.replace("AN,,0,0", "AN,1,73,58") });
  assert.deepEqual(viaCsv1.rows.find((r: { supplierName: string }) => r.supplierName === "ANZOR").new, { days: 1, setByAllied: false, orders: 73, sameDayExcluded: 58 });
  const withSuppliers = leadChecks({ before, items, suppliers: { suppliers: [{ uid: "ANZOR", lead_time_days: 5 }] } });
  assert.ok(withSuppliers.checks.every((c: { ok: boolean }) => c.ok));
  const text = withSuppliers.rows.map(leadRowText).join("\n");
  assert.match(text, /N24S16M\s+HOBSON\s+line\+option\s+107 d \(on item\) -> 30 d \(set by Allied\)/);
  assert.match(text, /N24S16M\s+TONG MING\s+option\s+107 d \(on item\) -> 42 d \(measured, 3 orders\)/);
  assert.match(text, /N24S16M\s+ANZOR\s+option\s+107 d \(on item\) -> 5 d \(set by Allied\)/);
  // Nothing under the usual supplier, nothing on an item without its own lead.
  assert.ok(!/SHANDONG|B16100S16/.test(text));
});

test("stage-check leads: two captures pass when only the predicted leads moved", async () => {
  const { leadChecks } = await import("../scripts/stage-check.mjs");
  const { before, after, items } = capturePair();
  const { checks, rows, mode } = leadChecks({ before, after, items, ...ANZOR_NAMED, cartCsv: "x", beforeCartCsv: "x" });
  assert.equal(mode, "actual");
  for (const c of checks) assert.ok(c.ok, `${c.check}: ${c.detail}`);
  // Without --base Anzor's new figure has nothing to be held to, so it fails.
  const bare = leadChecks({ before, after, items }).checks.filter((c: { ok: boolean }) => !c.ok).map((c: { check: string }) => c.check);
  assert.deepEqual(bare, ["every predicted row's new lead named (pass --base for /suppliers.csv)"]);
  assert.deepEqual(rows.map((r: { supplierName: string; where: string[] }) => `${r.supplierName}:${r.where.join("+")}`), ["ANZOR:option", "HOBSON:line+option+why", "TONG MING:option"]);
});

test("stage-check leads: a moved quantity, an unpredicted lead, a wrong figure or a missing source each fail", async () => {
  const { leadChecks } = await import("../scripts/stage-check.mjs");
  const failing = (mutate: (after: any) => void) => {
    const { before, after, items } = capturePair();
    mutate(after);
    return leadChecks({ before, after, items, ...ANZOR_NAMED }).checks.filter((c: { ok: boolean }) => !c.ok).map((c: { check: string }) => c.check);
  };
  assert.deepEqual(failing((a) => { a.suppliers[0].lines[0].suggestedQty = 1160; }), ["quantities, costs, states, totals and cards identical"]);
  assert.deepEqual(failing((a) => { a.estimatedCost += 1; }), ["quantities, costs, states, totals and cards identical"]);
  // The usual supplier's lead moving is not 1.12's rule.
  assert.ok(failing((a) => { a.suppliers[0].lines[0].options[0].leadTimeDays = 120; }).includes("every row that moved was predicted"));
  // Hobson's line shows the item's lead still: predicted but not moved.
  assert.ok(failing((a) => { Object.assign(a.suppliers[0].lines[0], { leadTimeDays: 107, leadTimeOrders: 0 }); a.suppliers[0].lines[0].rationale.leadTimeDays = 107; }).includes("a line, its option and its Why this quantity lead move together"));
  assert.ok(failing((a) => { a.suppliers[0].lines[0].options[2].leadTimeDays = 41; }).includes("each moved to the predicted lead"));
  // Compare's "N same-day ignored": wrong on a moved measured lead, or drifting
  // on an item 1.12 doesn't touch (B16100S16 has no item lead).
  assert.deepEqual(failing((a) => { a.suppliers[0].lines[0].options[2].leadTimeSameDayExcluded = 2; }), ["each moved to the predicted lead"]);
  assert.deepEqual(failing((a) => { a.suppliers[1].lines[0].options[2].leadTimeSameDayExcluded = 3; }), ["quantities, costs, states, totals and cards identical"]);
  assert.ok(failing((a) => { delete a.suppliers[1].lines[0].leadTimeSource; }).includes("leadTimeSource says where each shown lead came from"));
  assert.ok(failing((a) => { a.suppliers[0].lines[0].options[0].leadTimeSource = "supplier"; }).includes("leadTimeSource says where each shown lead came from"));
});
