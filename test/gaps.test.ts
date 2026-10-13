/**
 * Stock gaps on screen (1.11): the outlook series projection.ts adds to the
 * gap, and the words public/gaps.js puts on the item page tile, the Stock
 * outlook panel, the Gap before delivery cells and the drill-down sentence.
 *
 * The gap objects here come from the server's own projectItem, so the words
 * are tested against the shape the server really sends. No database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addDays, type EtaBasis, type EtaStatus } from "../src/insights/incoming.js";
import { GAP_HORIZON_DAYS, projectItem, runsOutBeforeNextDelivery, type ProjectionLine } from "../src/insights/projection.js";
import { gapCsvCells, GAP_CSV_COLUMNS } from "../src/insights/queries.js";
// @ts-ignore — plain browser module, no types
import * as gaps from "../public/gaps.js";
// @ts-ignore — plain browser module, no types
import { groupLinesByItem, PURCHASING_SORTS, sortRows } from "../public/order-list.js";

const ROOT = join(import.meta.dirname, "..");
const TODAY = "2026-10-13";
const on = (days: number) => addDays(TODAY, days);

function line(qty: number, at: number | null, over: Partial<ProjectionLine> = {}): ProjectionLine {
  const status: EtaStatus = over.status ?? (at == null ? "undated" : at < 0 ? "late" : "due");
  return {
    poUid: over.poUid ?? `U${over.number ?? qty}`,
    number: over.number ?? "00023070",
    supplier: "HANOVA INTERNATIONAL LTD",
    eta: at == null ? null : on(at),
    etaBasis: (over.etaBasis ?? (at == null ? "none" : "estimated")) as EtaBasis,
    status,
    outstanding: qty,
    ...over,
  };
}
const project = (free: number, weekly: number, lines: ProjectionLine[] = [], minLevel: number | null = null) =>
  projectItem({ today: TODAY, freeStock: free, weekly, minLevel, builtHere: false, lines });

/** An item as /items/:uid serves it, with the server's gap fields. */
function itemOf(fields: ReturnType<typeof projectItem>, over: Record<string, unknown> = {}) {
  return { supplierName: "HANOVA INTERNATIONAL LTD", leadTimeDays: 120, leadTimeSource: "supplier", coverWeeksInclOnOrder: 14, ...fields, ...over };
}

/* ---------- the outlook series (projection.ts) ---------- */

test("weeks: BN1665G's projection a week at a time, to the horizon, the gap's depth at its lowest", () => {
  const r = project(323, 166.4, [line(2000, 58)], 2771);
  const w = r.gap!.weeks!;
  // 10 Dec is day 58: weeks start on days 0, 7, … 56, the last 3 days long.
  assert.equal(w.length, 9);
  assert.deepEqual(w.map((x) => x.start), [0, 7, 14, 21, 28, 35, 42, 49, 56].map(on));
  assert.deepEqual(w.map((x) => x.days), [7, 7, 7, 7, 7, 7, 7, 7, 3]);
  // Day 0: 323 at the close of day 6 is 323 − 6 × 23.77 = 180.
  assert.equal(w[0].low, 180);
  assert.equal(w[0].close, 180);
  // The lowest point of the gap, before 00023070 lands, is units short.
  assert.equal(Math.min(...w.map((x) => x.low)), -r.gap!.unitsShort!);
  assert.equal(w[8].low, -1056);
  assert.equal(w[8].close, 2000 - 1056);
  assert.deepEqual(w[8].arrivals, [r.gap!.endingPo]);
  assert.ok(w.slice(0, 8).every((x) => x.arrivals.length === 0));
});

test("weeks: a delivery landing the day stock runs out shows no dip, as it is no gap", () => {
  // 70 free at 10 a day runs out on day 7; 100 lands on day 7.
  const r = project(70, 70, [line(100, 7)]);
  assert.equal(r.gapStatus, "covered");
  const w = r.gap!.weeks!;
  assert.ok(w.every((x) => x.low >= 0), JSON.stringify(w));
});

test("weeks: an open gap stays in the gap to the horizon; nothing projected has no weeks", () => {
  const open = project(100, 70, [line(50, 20)]).gap!;
  assert.equal(open.status, "gap_open");
  assert.equal(open.weeks!.at(-1)!.start <= open.horizon!, true);
  assert.equal(open.weeks!.length, 3); // days 0–20
  assert.ok(open.weeks![2].low < 0);
  assert.equal(project(100, 0).gap!.weeks, null, "no demand");
  assert.equal(projectItem({ today: TODAY, freeStock: 5, weekly: 7, minLevel: null, builtHere: true, lines: [] }).gap!.weeks, null, "built here");
  // Covered for 26 weeks: 27 entries, the last a single day.
  const long = project(10_000, 7).gap!;
  assert.equal(long.weeks!.length, Math.floor(GAP_HORIZON_DAYS / 7) + 1);
  assert.equal(long.weeks!.at(-1)!.days, 1);
});

test("weeks: two POs in one week are listed day by day, the largest first on a day", () => {
  const r = project(1000, 70, [line(5, 9, { poUid: "B", number: "B" }), line(50, 9, { poUid: "A", number: "A" }), line(20, 8, { poUid: "C", number: "C" })]);
  assert.deepEqual(r.gap!.weeks![1].arrivals.map((a) => a.number), ["C", "A", "B"]);
});

/* ---------- the tile ---------- */

test("tile: a gap with its end, units short and basis; an open gap from today names the PO", () => {
  const bn = itemOf(project(323, 166.4, [line(2000, 58)]));
  assert.deepEqual(gaps.gapTile(bn, { today: TODAY }), {
    value: "27 Oct → 10 Dec",
    note: "~1,056 short · estimate",
    tone: "fail",
    title: "Free stock runs out about 27 Oct; PO 00023070 ends the gap 10 Dec (44 days).",
  });
  const promised = itemOf(project(323, 166.4, [line(2000, 58, { etaBasis: "promised" })]));
  assert.equal(gaps.gapTile(promised, { today: TODAY }).note, "~1,056 short · promised");

  const kitLine = line(6000, -28, { status: "overdue", etaBasis: "promised", number: "00022886", poUid: "P86" });
  const kit = itemOf(project(-425, 120, [kitLine]));
  const rows = [{ ...kitLine, daysLate: 28 }];
  const t = gaps.gapTile(kit, { today: TODAY, rows });
  assert.equal(t.value, "From today");
  assert.equal(t.note, "end unknown (PO 00022886 overdue)");
  assert.equal(t.tone, "fail");
  // Later, and without the rows to name it.
  const later = itemOf(project(1100, 70, [kitLine]));
  assert.deepEqual([gaps.gapTile(later, { today: TODAY }).value, gaps.gapTile(later, { today: TODAY }).note], ["From 1 Feb 2027", "end unknown (a PO overdue)"]);
});

test("tile: covered (tight or not), nothing on order, no demand, built here, a past date, an old server", () => {
  const tight = itemOf(project(323, 166.4, [line(2000, 10)]));
  assert.equal(tight.gapStatus, "covered");
  assert.equal(tight.gap!.tight, true);
  assert.deepEqual([gaps.gapTile(tight).value, gaps.gapTile(tight).note, gaps.gapTile(tight).tone], ["None before next delivery", "tight", "warn"]);
  const easy = itemOf(project(5000, 70, [line(100, 10)]));
  assert.deepEqual([gaps.gapTile(easy).value, gaps.gapTile(easy).note], ["None before next delivery", null]);
  const none = itemOf(project(323, 166.4));
  assert.deepEqual([gaps.gapTile(none, { today: TODAY }).value, gaps.gapTile(none, { today: TODAY }).note], ["Nothing on order", "runs out ~27 Oct"]);
  assert.equal(gaps.gapTile(itemOf(project(10, 0))).value, "No demand");
  const built = itemOf(projectItem({ today: TODAY, freeStock: 5, weekly: 7, minLevel: null, builtHere: true, lines: [] }));
  assert.equal(gaps.gapTile(built).value, "Follows its components");
  // A past date: the server sends the fields, null.
  const past = { gap: null, gapStatus: null, nextDelivery: null, incomingOverdueQty: null };
  assert.deepEqual([gaps.gapTile(past, { historical: true }).value, gaps.gapTile(past, { historical: true }).note], ["—", "today only"]);
  assert.equal(gaps.gapTile(past).value, "—");
  // A server before 1.10 sends none of them.
  assert.equal(gaps.gapTile({ number: "X" }).value, "—");
  assert.equal(gaps.hasGapFields({ number: "X" }), false);
});

/* ---------- the column ---------- */

test("cell: '6.3w from 27 Oct' over '~1,056 short'; 'from today, end unknown'; 'tight'; '—' for the rest", () => {
  const bn = project(323, 166.4, [line(2000, 58)]);
  const c = gaps.gapCell(bn.gap, bn.gapStatus, { today: TODAY });
  assert.deepEqual([c.text, c.sub, c.tone], ["6.3w from 27 Oct", "~1,056 short", "fail"]);
  assert.match(c.title, /PO 00023070 \(estimated\) ends it 10 Dec: 44 days, ~1,056 units short/);
  // The weeks formatter is the caller's (cover's weeks / months toggle).
  assert.equal(gaps.gapCell(bn.gap, bn.gapStatus, { today: TODAY, weeks: (w: number) => `${(w * 12 / 52).toFixed(1)}mo` }).text, "1.5mo from 27 Oct");
  const kit = project(-425, 120, [line(6000, -28, { status: "overdue", etaBasis: "promised" })]);
  const k = gaps.gapCell(kit.gap, kit.gapStatus, { today: TODAY });
  assert.deepEqual([k.text, k.sub], ["from today", "end unknown"]);
  const n16 = project(-30, 70, [line(500, 10)]);
  assert.equal(gaps.gapCell(n16.gap, n16.gapStatus, { today: TODAY }).text, "1.4w from today");
  const tight = project(323, 166.4, [line(2000, 10)]);
  assert.deepEqual([gaps.gapCell(tight.gap, tight.gapStatus).text, gaps.gapCell(tight.gap, tight.gapStatus).tone], ["tight", "warn"]);
  for (const r of [project(5000, 70, [line(100, 10)]), project(323, 166.4), project(10, 0)])
    assert.equal(gaps.gapCell(r.gap, r.gapStatus).text, "—", String(r.gapStatus));
  assert.match(gaps.gapCell(null, null, { historical: true }).title, /Today only/);
  assert.match(gaps.gapCell(undefined, undefined, { present: false }).title, /newer server/);
});

/* ---------- the sentence ---------- */

test("sentence: BN1665G, worded as the plan's example", () => {
  const po = line(2000, 58, { poUid: "U23070", number: "00023070" });
  const item = itemOf(project(323, 166.4, [po], 2771));
  const detail = {
    incomingScheduleDate: TODAY,
    incomingSchedule: [{ ...po, raised: "2026-08-12", leadDays: 120, leadSource: "allied", measuredDays: 83, measuredEta: "2026-11-03", daysToGo: 58 }],
  };
  assert.equal(
    gaps.gapSentence(item, detail),
    "Free stock (323) runs out about 27 Oct at 166.4 a week. The next delivery, 2,000 on PO 00023070 (HANOVA INTERNATIONAL LTD), " +
      "is estimated for 10 Dec (raised 12 Aug + 120 days), about 6.3 weeks and ~1,056 units short. " +
      "With HANOVA INTERNATIONAL LTD's measured 83 days it would land ~3 Nov. " +
      "Cover incl. on order (14w) counts that delivery as already here. " +
      "An order placed with HANOVA INTERNATIONAL LTD today would land about 10 Feb 2027.",
  );
  // Without the item page's rows: no basis clause, no measured date.
  const bare = gaps.gapSentence(item, null, { today: TODAY });
  assert.match(bare, /is estimated for 10 Dec, about 6\.3 weeks and ~1,056 units short\. Cover incl/);
  // Promised: no basis, no measured alternative.
  const promised = itemOf(project(323, 166.4, [line(2000, 58, { etaBasis: "promised" })]));
  assert.match(gaps.gapSentence(promised, { incomingScheduleDate: TODAY, incomingSchedule: [] }), /is promised for 10 Dec, about 6\.3 weeks/);
  // A short gap is said in days: SPW12G with the measured 83 days, 27 Oct → 3 Nov.
  const spw = itemOf(project(323, 166.4, [line(2000, 21)]));
  assert.match(gaps.gapSentence(spw, null, { today: TODAY }), /is estimated for 3 Nov, about 7 days and ~177 units short\./);
  // An item's own lead time is said to be the item's, not the supplier's,
  // and (1.12) for its usual supplier, named where known.
  const own = itemOf(project(323, 166.4, [po]), { leadTimeSource: "item", leadTimeDays: 107 });
  assert.match(gaps.gapSentence(own, detail), /An order placed with HANOVA INTERNATIONAL LTD today would land about 28 Jan 2027 \(this item's own lead time, 107 days\)\.$/);
  const ownNoSupplier = itemOf(project(323, 166.4, [po]), { leadTimeSource: "item", leadTimeDays: 107, supplierName: null });
  assert.match(gaps.gapSentence(ownNoSupplier, detail), /An order placed today would land about 28 Jan 2027 \(this item's own lead time, 107 days\)\.$/);
});

test("sentence: KITST1230S, short now, its only PO overdue", () => {
  const po = line(6000, -28, { status: "overdue", etaBasis: "promised", number: "00022886", poUid: "P86" });
  const item = itemOf(project(-425, 120, [po]), { supplierName: "TONG MING", leadTimeDays: null });
  const detail = { incomingScheduleDate: TODAY, incomingSchedule: [{ ...po, daysLate: 28 }] };
  assert.equal(
    gaps.gapSentence(item, detail),
    "Free stock is already short by 425. The only PO, 6,000 on 00022886, is 28 days overdue and isn't counted, so the end of this gap is unknown.",
  );
  // Another PO due as well (too small to close it): the overdue one is not "the only".
  const two = itemOf(project(-425, 120, [po, line(10, 5, { poUid: "Q", number: "Q1" })]), { leadTimeDays: null });
  assert.match(gaps.gapSentence(two, { incomingScheduleDate: TODAY, incomingSchedule: [{ ...po, daysLate: 28 }, line(10, 5, { poUid: "Q", number: "Q1" })] }), /^Free stock is already short by 425\. 6,000 on PO 00022886 is 28 days overdue/);
});

test("sentence: late, undated, too small, after 26 weeks, covered, nothing on order, no demand, built here", () => {
  const ctx = (lines: ProjectionLine[], rows: unknown[] = lines) => ({ incomingScheduleDate: TODAY, incomingSchedule: rows });
  const late = line(300, -13, { status: "late", number: "00023309", poUid: "L" });
  const l = itemOf(project(100, 70, [late]), { leadTimeDays: null });
  assert.match(gaps.gapSentence(l, ctx([late], [{ ...late, daysLate: 13 }])), /runs out about 24 Oct at 70\.0 a week\. The only PO, 300 on 00023309, is 13 days late against its estimate and isn't counted/);
  const undated = line(300, null, { number: "00022464", poUid: "D", supplier: "TANDL" });
  assert.match(gaps.gapSentence(itemOf(project(100, 70, [undated]), { leadTimeDays: null }), ctx([undated])), /300 on PO 00022464 has no date \(no lead time for TANDL\)/);
  assert.match(gaps.gapSentence(itemOf(project(100, 70, [line(50, 20)]), { leadTimeDays: null }), ctx([line(50, 20)])), /aren't enough to bring free stock back above zero/);
  const far = line(5000, 200);
  assert.match(gaps.gapSentence(itemOf(project(100, 70, [far]), { leadTimeDays: null }), ctx([far])), /more than 26 weeks away/);
  const tight = itemOf(project(323, 166.4, [line(2000, 10)]));
  assert.equal(
    gaps.gapSentence(tight, ctx([line(2000, 10)])),
    "Free stock (323) lasts to about 27 Oct at 166.4 a week. The next delivery, 2,000 on PO 00023070, is estimated for 23 Oct, with under 2 weeks to spare.",
  );
  assert.equal(gaps.gapSentence(itemOf(project(323, 166.4)), ctx([])), "Free stock (323) runs out about 27 Oct at 166.4 a week, and nothing is on order.");
  assert.equal(gaps.gapSentence(itemOf(project(323, 0.038)), ctx([])), "Nothing is on order; free stock (323) lasts beyond 26 weeks at 0.038 a week.");
  assert.equal(gaps.gapSentence(itemOf(project(10, 0)), ctx([])), "No demand is recorded, so nothing runs out.");
  const built = itemOf(projectItem({ today: TODAY, freeStock: 5, weekly: 7, minLevel: null, builtHere: true, lines: [] }));
  assert.equal(gaps.gapSentence(built, ctx([])), "Made here: its stock follows its components, so it has no outlook of its own.");
  assert.equal(gaps.gapSentence({ gap: null, gapStatus: null }, ctx([])), null, "a past date");
  assert.equal(gaps.gapSentence({ number: "X" }, ctx([])), null, "a server before 1.10");
});

test("sentence: a gap with a known end that starts today is short by today's figure, deepest later", () => {
  // BN12150LTG (13 Oct): free −893 at 320.6 a week, 12,000 on 00023096 estimated 57 days on.
  const po = line(12000, 57, { poUid: "U23096", number: "00023096", supplier: "TANDL" });
  const item = itemOf(project(-893, 320.6, [po]), { supplierName: "TANDL", leadTimeDays: null, coverWeeksInclOnOrder: null });
  assert.equal(item.gapStatus, "gap");
  assert.equal(item.gap!.unitsShort, 3504);
  assert.equal(
    gaps.gapSentence(item, null, { today: TODAY }),
    "Free stock is already short by 893. The next delivery, 12,000 on PO 00023096 (TANDL), is estimated for 9 Dec, about 8.1 weeks and ~3,504 units short.",
  );
  assert.match(gaps.gapTile(item, { today: TODAY }).title, /^Free stock is already short; PO 00023096 ends the gap 9 Dec/);
  assert.match(gaps.gapCell(item.gap, item.gapStatus, { today: TODAY }).title, /^Short now; PO 00023096/);
  // Nothing on order and already short (FG450NP): no "(-12) runs out".
  const fg = itemOf(project(-12, 1.26), { leadTimeDays: null });
  assert.equal(fg.gapStatus, "nothing_on_order");
  assert.equal(gaps.gapSentence(fg, null, { today: TODAY }), "Free stock is already short by 12, and nothing is on order.");
  assert.equal(gaps.gapTile(fg, { today: TODAY }).note, "already short");
});

test("sentence: covered with two POs due the same day says the other; a weekly over 1,000 has its comma", () => {
  const two = itemOf(project(5000, 70, [line(1000, 10, { poUid: "A", number: "00023001" }), line(400, 10, { poUid: "B", number: "00023002" })]));
  assert.equal(two.nextDelivery!.poCount, 2);
  assert.match(gaps.gapSentence(two, null, { today: TODAY }), /The next delivery, 1,400 on PO 00023001 and 1 other PO, is estimated for 23 Oct\.$/);
  assert.equal(gaps.weeklyText(3419.6), "3,419.6 a week");
  assert.equal(gaps.weeklyText(0.038), "0.038 a week");
});

test("tile and cell: no gap at today beside a free-stock figure means gaps are unavailable, not nothing to project", () => {
  const off = { qtyFreeStock: 100, gap: null, gapStatus: null, nextDelivery: null, incomingOverdueQty: null };
  assert.equal(gaps.gapTile(off).title, "Stock gaps aren't available right now.");
  assert.equal(gaps.gapCell(null, null, { position: true }).title, "Stock gaps aren't available right now.");
  assert.equal(gaps.gapTile({ ...off, qtyFreeStock: null }).title, "No stock position to project from.");
});

/* ---------- the strip ---------- */

test("outlook: the server's weeks as drawn, the gap's weeks marked, overdue POs beside it", () => {
  const po = line(2000, 58, { poUid: "U23070", number: "00023070" });
  const overdue = line(500, -28, { status: "overdue", etaBasis: "promised", number: "00022886", poUid: "P86" });
  const item = itemOf(project(323, 166.4, [po, overdue], 2771));
  const m = gaps.outlookModel(item, { incomingScheduleDate: TODAY, incomingSchedule: [po, { ...overdue, daysLate: 28 }] });
  assert.equal(m.weeks.length, 9);
  // Runs out 27 Oct (day 14), ends 10 Dec (day 58): weeks 2 to 8 are in the gap.
  assert.deepEqual(m.weeks.map((w: { inGap: boolean }) => w.inGap), [false, false, true, true, true, true, true, true, true]);
  assert.deepEqual(m.weeks[8].arrivals.map((a: { solid: boolean; number: string }) => [a.number, a.solid]), [["00023070", false]]);
  assert.equal(m.bottom, -1056);
  // With a gap the scale may reach the gap's depth (1,056), no further: here the 944
  // left once 00023070 lands is under it, so nothing is clipped. Without a gap it is
  // the largest value.
  assert.deepEqual([m.top, m.gapScale], [944, true]);
  const deep = gaps.outlookModel(itemOf(project(323, 166.4, [line(20000, 58)])), null, { today: TODAY });
  assert.equal(deep.top, 1056, "20,000 landing is clipped at the depth of the shortfall");
  const covered = gaps.outlookModel(itemOf(project(5000, 70, [line(100, 10)])), null, { today: TODAY });
  const drawn = covered.weeks.flatMap((w: { low: number; close: number }) => [w.low, w.close]);
  assert.deepEqual([covered.top, covered.gapScale], [Math.max(...drawn), false]);
  assert.equal(m.minLevel, 2771);
  assert.deepEqual(m.off.map((p: { number: string; text: string }) => [p.number, p.text]), [["00022886", "overdue 28 days"]]);
  assert.equal(m.weeks[0].label, "13 Oct");
  // Nothing to draw: no series, a past date's null fields, an old server.
  assert.equal(gaps.outlookModel(itemOf(project(10, 0)), null), null);
  assert.equal(gaps.outlookModel({ gap: null, gapStatus: null }, null), null);
  assert.equal(gaps.outlookModel({ number: "X" }, null), null);
});

/* ---------- Purchasing's sort is the server's ---------- */

test("By item's gap sort reads what the server's sort=gap reads: the start of a gap or gap_open, else nothing", () => {
  const cases = [
    project(323, 166.4, [line(2000, 58)]),
    project(-425, 120, [line(6000, -28, { status: "overdue", etaBasis: "promised" })]),
    project(323, 166.4, [line(2000, 10)]),
    project(323, 166.4),
    project(10, 0),
  ];
  for (const r of cases) {
    const server = runsOutBeforeNextDelivery(r.gapStatus) ? (r.gap?.start ?? null) : null;
    assert.equal(PURCHASING_SORTS.gap.value({ gap: r.gap }), server, String(r.gapStatus));
  }
  assert.equal(PURCHASING_SORTS.gap.value({ gap: null }), null);
  // groupLinesByItem carries the line's gap, and says whether the server sent one.
  const rows = groupLinesByItem({ suppliers: [{ lines: [{ itemUid: "a", number: "A", qty: 1, estCost: 1, gap: cases[0].gap }, { itemUid: "b", number: "B", qty: 1, estCost: 1 }] }] });
  assert.deepEqual(rows.map((r: { gap: unknown; hasGap: boolean }) => [r.gap === cases[0].gap, r.hasGap]), [[true, true], [false, false]]);
  assert.deepEqual(sortRows(rows, "gap", "").map((r: { number: string }) => r.number), ["A", "B"]);
});

/* ---------- items.csv ---------- */

test("items.csv gap columns: next delivery, the gap, overdue units; blank at a past date and without a gap", () => {
  assert.deepEqual([...GAP_CSV_COLUMNS], ["Next delivery date", "Next delivery qty", "ETA basis", "Gap start", "Gap end", "Gap days", "Units short", "Overdue qty"]);
  const bn = project(323, 166.4, [line(2000, 58), line(500, -28, { status: "overdue", etaBasis: "promised", poUid: "O" })]);
  assert.deepEqual(gapCsvCells(bn), ["2026-12-10", 2000, "estimated", "2026-10-27", "2026-12-10", 44, 1056, 500]);
  const open = project(1100, 70, [line(6000, -28, { status: "overdue", etaBasis: "promised" })]);
  assert.deepEqual(gapCsvCells(open), [null, null, null, on(111), null, null, null, 6000]);
  const none = project(323, 166.4);
  assert.deepEqual(gapCsvCells(none), [null, null, null, null, null, null, null, 0], "nothing_on_order has a run-out but no gap before a delivery");
  assert.deepEqual(gapCsvCells({ gap: null, gapStatus: null, nextDelivery: null, incomingOverdueQty: null }), Array(8).fill(null), "a past date");
});

/* ---------- the module ---------- */

test("gaps.js is DOM-free, clear of the banned stock names, and adds no stock of its own", () => {
  const src = readFileSync(join(ROOT, "public/gaps.js"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\b(document|window|localStorage|fetch)\b/);
  assert.doesNotMatch(src, /\b(qty_on_hand|qty_committed|qty_available)\b/);
  // The browser never projects: no daily rate, no running balance.
  assert.doesNotMatch(code, /weekly\s*\/\s*7|\/ 7\)\s*\*/);
  const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
  assert.deepEqual(imports, ['import { shortDate } from "./incoming.js";']);
});

/* ---------- stage-check screen ---------- */

test("stage-check screen: CSV columns appended, cart lines without the series, Purchasing's sort the server's", async () => {
  // @ts-ignore — plain .mjs script, no types
  const { screenChecks, GAP_CSV } = await import("../scripts/stage-check.mjs");
  const orderList = await import("../public/order-list.js");
  const bn = project(323, 166.4, [line(2000, 58)]);
  const none = project(323, 166.4);
  const items = [
    { uid: "a", number: "A", ...bn },
    { uid: "b", number: "B", ...none },
  ];
  const head = "Item number,Supplier";
  const before = `﻿${head}\r\nA,H\r\nB,H\r\n`;
  const cells = (i: (typeof items)[number]) => gapCsvCells(i).map((v) => (v == null ? "" : String(v))).join(",");
  const csv = `﻿${head},${GAP_CSV.join(",")}\r\nA,H,${cells(items[0])}\r\nB,H,${cells(items[1])}\r\n`;
  const { weeks: _w, ...lineGap } = bn.gap!;
  const cart = { suppliers: [{ lines: [{ itemUid: "a", number: "A", qty: 1, estCost: 1, gap: lineGap }, { itemUid: "b", number: "B", qty: 1, estCost: 1, gap: none.gap ? (({ weeks: _x, ...r }) => r)(none.gap) : null }] }] };
  const suggested = { rows: [{ uid: "a" }, { uid: "b" }] };
  const ok = screenChecks({ items, csv, beforeCsv: before, cartCsv: "x", beforeCartCsv: "x", cart, suggested, overview: { kpis: { runsOutBeforeNextDelivery: 1 } }, gapTotal: 1, orderList });
  for (const c of ok) assert.ok(c.ok, `${c.check}: ${c.detail}`);
  assert.equal(ok.length, 7);
  const failing = (over: Record<string, unknown>) =>
    screenChecks({ items, csv, beforeCsv: before, cartCsv: "x", beforeCartCsv: "x", cart, suggested, overview: { kpis: { runsOutBeforeNextDelivery: 1 } }, gapTotal: 1, orderList, ...over })
      .filter((c: { ok: boolean }) => !c.ok)
      .map((c: { check: string }) => c.check);
  assert.deepEqual(failing({ beforeCsv: before.replace("A,H", "A,X") }), ["every existing items.csv column byte-identical, eight cells appended"]);
  assert.deepEqual(failing({ cartCsv: "y" }), ["cart.csv byte-identical"]);
  assert.deepEqual(failing({ cart: { suppliers: [{ lines: [{ ...cart.suppliers[0].lines[0], gap: bn.gap }] }] } }), ["every /cart line carries its item's gap, less the weekly series"]);
  assert.deepEqual(failing({ suggested: { rows: [{ uid: "b" }, { uid: "a" }] } }), ["By item's gap sort = /items?filter=suggested&sort=gap, apart from ties"]);
  assert.deepEqual(failing({ gapTotal: 2 }), ["Overview tile Runs out before next delivery = filter=gap total"]);
});
