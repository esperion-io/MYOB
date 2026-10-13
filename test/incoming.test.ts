/**
 * Incoming POs with expected dates (1.9): the ETA rule, the schedule's order
 * and summary, the words the screens use, and the stage-check that proves
 * the schedule is On order line for line.
 *
 * The rule is worked out once per PO document (src/insights/incoming.ts):
 *   - promised: MYOB's Promised Date, when it is on or after the PO date;
 *   - an earlier Promised Date is ignored, and said so;
 *   - estimated: PO date + the PO supplier's lead (Allied's, else measured);
 *     a lead set on an item never enters it;
 *   - a passed date with stock outstanding is overdue (promised) or late
 *     (estimated), and stays on its date;
 *   - no lead at all: no date.
 * These pin each case, a part-received line, two lines of one item on one
 * PO, and that nothing that calculates a figure imports the schedule.
 * No database: incoming.ts's pool is created only on first use.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  addDays,
  daysBetween,
  poEta,
  scheduleFacts,
  scheduleOrder,
  summariseSchedule,
  type ScheduleRow,
} from "../src/insights/incoming.js";
import type { SupplierLead } from "../src/insights/leadTimes.js";
// @ts-ignore — plain browser module, no types
import * as words from "../public/incoming.js";
// @ts-ignore — plain .mjs script, no types
import { scheduleChecks } from "../scripts/stage-check.mjs";

const ROOT = join(import.meta.dirname, "..");
const TODAY = "2026-10-13";

const measured = (days: number, orders = 11): SupplierLead => ({
  days, setByAllied: false, orders, sameDayExcluded: 0, alliedDays: null, measuredDays: days,
});
const allied = (days: number, measuredDays: number | null, orders = 11): SupplierLead => ({
  days, setByAllied: true, orders, sameDayExcluded: 0, alliedDays: days, measuredDays,
});

/* ---------- the rule ---------- */

test("date helpers: whole days, across month and year ends", () => {
  assert.equal(addDays("2026-08-12", 120), "2026-12-10");
  assert.equal(addDays("2026-08-12", 83), "2026-11-03");
  assert.equal(addDays("2026-12-30", 3), "2027-01-02");
  assert.equal(daysBetween("2026-09-15", TODAY), 28);
  assert.equal(daysBetween(TODAY, "2026-11-01"), 19);
});

test("promised: the Promised Date, due in N days", () => {
  const e = poEta({ poDate: "2026-08-11", promisedDate: "2026-11-01", lead: measured(83) }, TODAY);
  assert.equal(e.etaBasis, "promised");
  assert.equal(e.eta, "2026-11-01");
  assert.equal(e.status, "due");
  assert.equal(e.daysToGo, 19);
  assert.equal(e.daysLate, null);
  assert.equal(e.promisedIgnored, false);
  assert.equal(e.leadDays, null, "a promised date uses no lead");
});

test("promised on the PO date itself counts; due today is due, 0 days to go", () => {
  const e = poEta({ poDate: TODAY, promisedDate: TODAY, lead: null }, TODAY);
  assert.equal(e.etaBasis, "promised");
  assert.equal(e.status, "due");
  assert.equal(e.daysToGo, 0);
});

test("overdue: a passed Promised Date with stock outstanding stays on its date", () => {
  const e = poEta({ poDate: "2026-06-29", promisedDate: "2026-09-15", lead: measured(42, 5) }, TODAY);
  assert.equal(e.status, "overdue");
  assert.equal(e.eta, "2026-09-15", "never moved to today or later");
  assert.equal(e.daysLate, 28);
  assert.equal(e.daysToGo, null);
});

test("estimated from Allied's supplier lead, with the measured date when they differ by more than 14 days", () => {
  const e = poEta({ poDate: "2026-08-12", promisedDate: null, lead: allied(120, 83) }, TODAY);
  assert.equal(e.etaBasis, "estimated");
  assert.equal(e.eta, "2026-12-10");
  assert.equal(e.leadDays, 120);
  assert.equal(e.leadSource, "allied");
  assert.equal(e.measuredDays, 83);
  assert.equal(e.measuredEta, "2026-11-03");
  assert.equal(e.status, "due");
  assert.equal(e.daysToGo, 58);
  // TANDL: 102 set against 117 measured, 15 days apart, so both.
  const tandl = poEta({ poDate: "2026-08-14", promisedDate: null, lead: allied(102, 117) }, TODAY);
  assert.deepEqual([tandl.eta, tandl.measuredEta], ["2026-11-24", "2026-12-09"]);
  // Within two weeks of each other: no second date.
  const close = poEta({ poDate: "2026-08-14", promisedDate: null, lead: allied(102, 116) }, TODAY);
  assert.equal(close.measuredEta, null);
  assert.equal(close.measuredDays, null);
});

test("estimated from the measured median when Allied set none", () => {
  const e = poEta({ poDate: "2026-08-12", promisedDate: null, lead: measured(83) }, TODAY);
  assert.deepEqual([e.etaBasis, e.eta, e.leadSource, e.leadOrders, e.measuredEta], ["estimated", "2026-11-03", "measured", 11, null]);
});

test("late: a passed estimate", () => {
  const e = poEta({ poDate: "2026-09-28", promisedDate: null, lead: measured(2, 5) }, TODAY);
  assert.equal(e.eta, "2026-09-30");
  assert.equal(e.status, "late");
  assert.equal(e.daysLate, 13);
});

test("a Promised Date earlier than the PO date is ignored, and the estimate is used", () => {
  const e = poEta({ poDate: "2025-12-04", promisedDate: "2025-11-08", lead: measured(83) }, TODAY);
  assert.equal(e.promisedIgnored, true);
  assert.equal(e.promisedDate, "2025-11-08", "kept as MYOB holds it");
  assert.equal(e.etaBasis, "estimated");
  assert.equal(e.eta, "2026-02-25");
  assert.equal(e.status, "late");
  // With no lead either, there is no date at all.
  const none = poEta({ poDate: "2025-12-04", promisedDate: "2025-11-08", lead: null }, TODAY);
  assert.deepEqual([none.etaBasis, none.eta, none.status, none.promisedIgnored], ["none", null, "undated", true]);
});

test("undated: no Promised Date and no lead for the supplier", () => {
  const e = poEta({ poDate: "2026-08-12", promisedDate: null, lead: undefined }, TODAY);
  assert.deepEqual([e.etaBasis, e.eta, e.status, e.daysLate, e.daysToGo], ["none", null, "undated", null, null]);
});

/* ---------- the schedule ---------- */

let seq = 0;
function row(over: Partial<ScheduleRow> & Pick<ScheduleRow, "poUid">): ScheduleRow {
  const base = poEta({ poDate: over.raised ?? "2026-08-12", promisedDate: over.promisedDate ?? null, lead: measured(83) }, TODAY);
  return {
    ...base,
    number: over.poUid,
    supplierUid: "s",
    supplier: "HANOVA INTERNATIONAL LTD",
    itemUid: "i",
    line: seq++,
    raised: "2026-08-12",
    ordered: 100,
    received: 0,
    outstanding: 100,
    ...over,
  } as ScheduleRow;
}

test("order: overdue and late first (oldest first), then by date, then undated", () => {
  const due = row({ poUid: "P2", eta: "2026-11-03", status: "due" });
  const dueSooner = row({ poUid: "P3", eta: "2026-11-01", etaBasis: "promised", status: "due" });
  const overdue = row({ poUid: "P4", eta: "2026-09-15", etaBasis: "promised", status: "overdue" });
  const late = row({ poUid: "P5", eta: "2026-04-16", status: "late" });
  const undated = row({ poUid: "P1", eta: null, etaBasis: "none", status: "undated", raised: "2026-01-01" });
  const sorted = [due, undated, overdue, dueSooner, late].sort(scheduleOrder).map((r) => r.poUid);
  assert.deepEqual(sorted, ["P5", "P4", "P3", "P2", "P1"]);
});

test("two lines of one item on one PO stay two rows, in MYOB's line order, with one date", () => {
  const a = row({ poUid: "00023096", line: 19, outstanding: 1000, ordered: 1000 });
  const b = row({ poUid: "00023096", line: 18, outstanding: 1500, ordered: 1500 });
  const sorted = [a, b].sort(scheduleOrder);
  assert.deepEqual(sorted.map((r) => r.line), [18, 19]);
  assert.equal(sorted[0].eta, sorted[1].eta);
  const s = summariseSchedule(sorted);
  assert.equal(s.total, 2500);
  assert.equal(s.dated, 2500);
});

test("summary: units by status add up to the total; POs counted once each; next is the soonest due", () => {
  const rows = [
    row({ poUid: "OV", eta: "2026-09-15", etaBasis: "promised", status: "overdue", outstanding: 300 }),
    row({ poUid: "OV", eta: "2026-09-15", etaBasis: "promised", status: "overdue", outstanding: 200 }),
    row({ poUid: "LT", eta: "2026-09-30", status: "late", outstanding: 50 }),
    row({ poUid: "D1", eta: "2026-12-10", status: "due", outstanding: 1000 }),
    row({ poUid: "D2", eta: "2026-11-01", etaBasis: "promised", status: "due", outstanding: 11000 }),
    row({ poUid: "UN", eta: null, etaBasis: "none", status: "undated", outstanding: 7 }),
  ];
  const s = summariseSchedule(rows);
  assert.equal(s.overdue, 500);
  assert.equal(s.late, 50);
  assert.equal(s.dated, 12000);
  assert.equal(s.undated, 7);
  assert.equal(s.total, 12557);
  assert.equal(s.dated + s.overdue + s.late + s.undated, s.total);
  assert.deepEqual([s.overduePos, s.latePos, s.undatedPos], [1, 1, 1]);
  assert.deepEqual(s.next, { eta: "2026-11-01", etaBasis: "promised", number: "D2" });
  assert.equal(summariseSchedule([]).next, null);
});

test("a part-received line counts only what is still to come", () => {
  const r = row({ poUid: "PR", ordered: 1000, received: 400, outstanding: 600, eta: "2026-09-15", etaBasis: "promised", status: "overdue", daysLate: 28 });
  assert.equal(summariseSchedule([r]).overdue, 600);
  assert.equal(words.statusModel(r, TODAY).text, "Overdue 28 days: promised 15 Sep, 600 of 1,000 still to come");
});

test("facts only at a past date: no date, basis or status", () => {
  const f = scheduleFacts(row({ poUid: "P", promisedDate: "2026-11-01" }));
  for (const k of ["eta", "etaBasis", "status", "daysLate", "daysToGo", "leadDays"]) assert.ok(!(k in f), k);
  assert.deepEqual(Object.keys(f).sort(), ["itemUid", "line", "number", "ordered", "outstanding", "poUid", "promisedDate", "raised", "received", "supplier", "supplierUid"]);
});

/* ---------- the words ---------- */

test("Expected and Basis read as the plan words them", () => {
  const hanova = { ...poEta({ poDate: "2026-08-12", promisedDate: null, lead: allied(120, 83) }, TODAY), supplier: "HANOVA INTERNATIONAL LTD", raised: "2026-08-12" };
  assert.equal(words.expectedText(hanova, TODAY), "~10 Dec");
  assert.equal(
    words.basisText(hanova, TODAY),
    "ETA missing — estimated: raised 12 Aug + 120 days (HANOVA INTERNATIONAL LTD lead set by Allied) · measured 83 days would give ~3 Nov",
  );
  const steel = { ...poEta({ poDate: "2026-09-28", promisedDate: null, lead: measured(2, 5) }, TODAY), supplier: "STEEL & TUBE", raised: "2026-09-28" };
  assert.equal(words.basisText(steel, TODAY), "ETA missing — estimated: raised 28 Sep + 2 days (STEEL & TUBE, measured over 5 orders)");
  assert.equal(words.statusModel(steel, TODAY).text, "Late against estimate by 13 days");
  assert.equal(words.statusModel(steel, TODAY).tone, "warn");
  const promised = { ...poEta({ poDate: "2026-08-11", promisedDate: "2026-11-01", lead: null }, TODAY), supplier: "HANOVA", raised: "2026-08-11" };
  assert.equal(words.expectedText(promised, TODAY), "1 Nov");
  assert.equal(words.basisText(promised, TODAY), "Promised in MYOB");
  assert.equal(words.statusModel(promised, TODAY).text, "Due in 19 days");
  const ignored = { ...poEta({ poDate: "2025-12-04", promisedDate: "2025-11-08", lead: measured(83) }, TODAY), supplier: "HANOVA", raised: "2025-12-04" };
  assert.match(words.basisText(ignored, TODAY), /^Promised date earlier than PO date \(ignored\) · ETA missing — estimated: raised 4 Dec 2025 \+ 83 days/);
  const none = { ...poEta({ poDate: "2026-08-12", promisedDate: null, lead: null }, TODAY), supplier: "TANDL", raised: "2026-08-12" };
  assert.equal(words.expectedText(none, TODAY), "—");
  assert.equal(words.basisText(none, TODAY), "No date: no lead time for TANDL; set one under Suppliers");
  assert.equal(words.statusModel(none, TODAY).text, "No date");
});

test("Status: overdue is red and says nothing was received; a whole document says neither", () => {
  const line = { ...poEta({ poDate: "2026-06-29", promisedDate: "2026-09-15", lead: null }, TODAY), received: 0, ordered: 100, outstanding: 100 };
  assert.deepEqual(words.statusModel(line, TODAY), { text: "Overdue 28 days: promised 15 Sep, nothing received", tone: "fail" });
  const doc = poEta({ poDate: "2026-06-29", promisedDate: "2026-09-15", lead: null }, TODAY);
  assert.equal(words.statusModel(doc, TODAY).text, "Overdue 28 days: promised 15 Sep");
  assert.equal(words.statusModel({ ...doc, status: "due", daysToGo: 1 }, TODAY).text, "Due in 1 day");
  assert.equal(words.statusModel({ ...doc, status: "due", daysToGo: 0 }, TODAY).text, "Due today");
  assert.equal(words.statusModel({}, TODAY).text, "—", "a row from a past date or an old server");
  assert.equal(words.basisText({}, TODAY), "—");
});

test("the On order note: overdue first, then the next date, promised or estimated", () => {
  const base = { dated: 0, overdue: 0, late: 0, undated: 0, total: 100, overduePos: 0, latePos: 0, undatedPos: 0, next: null };
  assert.equal(words.nextDeliveryNote({ ...base, next: { eta: "2026-12-10", etaBasis: "estimated" } }, TODAY).text, "next ~10 Dec (est.)");
  assert.equal(words.nextDeliveryNote({ ...base, next: { eta: "2026-11-01", etaBasis: "promised" } }, TODAY).text, "next 1 Nov (promised)");
  assert.deepEqual(words.nextDeliveryNote({ ...base, overduePos: 1 }, TODAY), { text: "1 PO overdue", tone: "fail" });
  assert.equal(
    words.nextDeliveryNote({ ...base, overduePos: 2, latePos: 1, next: { eta: "2026-11-01", etaBasis: "promised" } }, TODAY).text,
    "2 POs overdue · 1 PO late against estimate · next 1 Nov (promised)",
  );
  assert.equal(words.nextDeliveryNote({ ...base, undatedPos: 1 }, TODAY).text, "1 PO with no date");
  assert.equal(words.nextDeliveryNote({ ...base, total: 0 }, TODAY), null);
  assert.equal(words.nextDeliveryNote(null, TODAY), null);
});

test("Promised Date history and Data & Sync's line", () => {
  assert.equal(
    words.promisedHistoryText({ orders: 20, medianDaysLate: 4.5, overTwoWeeks: 7 }),
    "Promised dates have run a median ~5 days late; 7 of 20 were over 2 weeks late.",
  );
  assert.equal(words.promisedHistoryText({ orders: 0, medianDaysLate: null, overTwoWeeks: 0 }), null);
  const eta = (p: string | null, poDate = "2026-08-12") => poEta({ poDate, promisedDate: p, lead: measured(83) }, TODAY);
  const docs = [
    { number: "A", counted: true, expected: eta("2026-11-01") },
    { number: "B", counted: true, expected: eta(null) },
    { number: "C", counted: true, expected: eta("2026-01-01") },
    { number: "D", counted: false, expected: null },
  ];
  const g = words.promisedDateGaps(docs);
  assert.deepEqual(g, { total: 3, missing: 2, ignored: 1, numbers: ["B", "C"] });
  assert.equal(
    words.promisedDateGapsText(g),
    "2 of 3 open POs have no Promised Date (1 has one earlier than its PO date, which is ignored) — enter one in MYOB.",
  );
  assert.equal(words.promisedDateGapsText({ total: 16, missing: 1, ignored: 0 }), "1 of 16 open POs has no Promised Date — enter one in MYOB.");
  assert.equal(words.promisedDateGaps([{ number: "X", counted: true }]), null, "a server before 1.9");
});

test("the browser module stays DOM-free and clear of the banned stock names", () => {
  const src = readFileSync(join(ROOT, "public/incoming.js"), "utf8");
  assert.doesNotMatch(src, /\b(document|window)\.|\blocalStorage\b/);
  assert.doesNotMatch(src, /\b(qty_on_hand|qty_committed|qty_available)\b/);
});

/* ---------- nothing calculates from it ---------- */

test("no ETA feeds a calculation: only the item page and Data & Sync read incoming.ts", () => {
  for (const f of ["src/insights/cart.ts", "src/insights/minStock.ts", "src/insights/kits.ts", "src/insights/kitPlan.ts", "src/sync/schema.ts", "src/sync/engine.ts"]) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /incoming\.js/, `${f} imports the schedule`);
  }
  const q = readFileSync(join(ROOT, "src/insights/queries.ts"), "utf8");
  const computeItem = q.slice(q.indexOf("export function computeItem("), q.indexOf("export async function kitRuleSummary("));
  assert.doesNotMatch(computeItem, /schedule|openPoSchedule|poEta/);
  // ledger.ts imports it for Data & Sync's open-document list only: every
  // mention sits in the import, OpenPurchaseDoc or openPurchaseDocs, never in
  // ownedPositions / snapshotPositions (On order and the daily rows).
  const l = readFileSync(join(ROOT, "src/insights/ledger.ts"), "utf8");
  const importAt = l.indexOf('import { openPoEtas, type PoEta } from "./incoming.js";');
  const from = l.indexOf("export interface OpenPurchaseDoc {");
  const to = l.indexOf("async function viewPositions(");
  assert.ok(importAt >= 0 && from > 0 && to > from, "ledger.ts landmarks moved; update this guard");
  for (const m of l.matchAll(/incoming\.js|openPoEtas|openPoSchedule|PoEta|poEta|\betas\b/g)) {
    const at = m.index!;
    const allowed = (at >= importAt && at < importAt + 60) || (at >= from && at < to);
    assert.ok(allowed, `ledger.ts mentions ${m[0]} outside openPurchaseDocs (offset ${at})`);
  }
});

test("the supplier lead query lives in leadTimes.ts; the cart imports it and keeps no copy", () => {
  const cart = readFileSync(join(ROOT, "src/insights/cart.ts"), "utf8");
  assert.match(cart, /import \{ supplierLeadTimes \} from "\.\/leadTimes\.js"/);
  assert.doesNotMatch(cart, /LEFT JOIN supplier_lead_time/);
  const incoming = readFileSync(join(ROOT, "src/insights/incoming.ts"), "utf8");
  assert.match(incoming, /supplierLeadTimes\(pool\)/);
  // An item lead is never read for an ETA.
  assert.doesNotMatch(incoming, /platform_item_lead_time|leadTimeItemDays/);
});

/* ---------- stage-check schedule ---------- */

function fixture() {
  const r = (poUid: string, itemUid: string, outstanding: number, over: Record<string, unknown> = {}) => ({
    poUid, number: poUid, itemUid, supplier: "S", raised: "2026-08-12", promisedDate: null,
    eta: "2026-11-03", etaBasis: "estimated", status: "due", daysToGo: 21, daysLate: null, leadDays: 83, leadSource: "measured",
    outstanding, ordered: outstanding, received: 0, line: 0, ...over,
  });
  const sum = (rows: any[]) => {
    const s = { dated: 0, overdue: 0, late: 0, undated: 0, total: 0 } as any;
    for (const x of rows) { s.total += x.outstanding; s[x.status === "due" ? "dated" : x.status] += x.outstanding; }
    return s;
  };
  const a = [r("PO1", "a", 1500), r("PO1", "a", 1000, { line: 1 })];
  const b = [r("PO2", "b", 50, { eta: "2026-09-15", etaBasis: "promised", promisedDate: "2026-09-15", status: "overdue", daysLate: 28 }), r("PO1", "b", 200)];
  const items = [
    { uid: "a", number: "A", qtyOnOrder: 2500 },
    { uid: "b", number: "B", qtyOnOrder: 250 },
    { uid: "c", number: "C", qtyOnOrder: 0 },
  ];
  const details = new Map<string, any>([
    ["a", { incomingSchedule: a, incomingSummary: sum(a) }],
    ["b", { incomingSchedule: b, incomingSummary: sum(b) }],
  ]);
  const docs = [
    { uid: "PO1", number: "PO1", counted: true, outstanding: 2700, expected: { eta: "2026-11-03", etaBasis: "estimated", status: "due" } },
    { uid: "PO2", number: "PO2", counted: true, outstanding: 50, expected: { eta: "2026-09-15", etaBasis: "promised", status: "overdue" } },
    { uid: "REV", number: "00020462", counted: false, outstanding: 0, expected: null },
  ];
  return { items, details, docs };
}

test("stage-check schedule: a consistent capture passes every check", () => {
  const { checks, table } = scheduleChecks(fixture());
  for (const c of checks) assert.ok(c.ok, `${c.check}: ${c.detail}`);
  assert.equal(table.length, 2);
  assert.equal(table.find((t: any) => t.po === "PO1").lines, 3);
});

test("stage-check schedule: a missing line, a split date, a reversal and a wrong basis each fail", () => {
  const bad = (mutate: (f: ReturnType<typeof fixture>) => void) => {
    const f = fixture();
    mutate(f);
    return scheduleChecks(f).checks.filter((c: any) => !c.ok).map((c: any) => c.check);
  };
  assert.ok(bad((f) => f.details.get("a").incomingSchedule.pop()).some((c: string) => /Σ schedule outstanding/.test(c)));
  assert.ok(bad((f) => { f.details.get("b").incomingSchedule[1].eta = "2026-11-24"; }).some((c: string) => /one expected date/.test(c)));
  assert.ok(bad((f) => { f.details.get("b").incomingSchedule[0].poUid = "REV"; }).some((c: string) => /no reversal/.test(c)));
  assert.ok(bad((f) => { f.details.get("a").incomingSchedule.forEach((x: any) => { x.etaBasis = "promised"; }); }).some((c: string) => /promised exactly when/.test(c)));
  assert.ok(bad((f) => { f.docs[0].expected.eta = "2026-12-10"; }).some((c: string) => /Data & Sync/.test(c)));
  assert.ok(bad((f) => { f.details.get("b").incomingSchedule.reverse(); }).some((c: string) => /rows ordered/.test(c)));
});
