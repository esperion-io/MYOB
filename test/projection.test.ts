/**
 * Stock gaps (1.10): the projection, its statuses, the fail-safe around it,
 * and `stage-check gap`, which recomputes the server's answer with the same
 * function.
 *
 * The rule (src/insights/projection.ts): P(d) = free stock today + Σ
 * outstanding on dated lines still to come with ETA ≤ d − (weekly ÷ 7) × d.
 * Overdue, late and undated lines are off the timeline. Run-out is the first
 * day P < 0; the gap ends on the counted delivery that brings P back to ≥ 0,
 * else its end is unknown, with the reason. The horizon is the later of the
 * last dated delivery and free stock's own run-out, capped at 26 weeks.
 * No database: projection.ts is pure, and attachGaps takes its inputs.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addDays, type EtaBasis, type EtaStatus } from "../src/insights/incoming.js";
import {
  GAP_HORIZON_DAYS,
  projectionInput,
  projectItem,
  weeklyRate,
  type ProjectionInput,
  type ProjectionLine,
} from "../src/insights/projection.js";
import { attachGaps, computeItem, GAP_ENABLED, gapsRunFor, type ItemComputed } from "../src/insights/queries.js";
import type { ScheduleRow } from "../src/insights/incoming.js";
// @ts-ignore — plain .mjs script, no types
import { gapChecks, gapSample } from "../scripts/stage-check.mjs";
import * as projection from "../src/insights/projection.js";

const TODAY = "2026-10-13";
const on = (days: number) => addDays(TODAY, days);

let seq = 0;
/** One schedule line: `at` days from today, due unless a status is given. */
function line(qty: number, at: number | null, over: Partial<ProjectionLine> = {}): ProjectionLine {
  const status: EtaStatus = over.status ?? (at == null ? "undated" : at < 0 ? "late" : "due");
  return {
    poUid: over.poUid ?? `PO${++seq}`,
    number: over.number ?? over.poUid ?? `0002${seq}`,
    supplier: "HANOVA INTERNATIONAL LTD",
    eta: at == null ? null : on(at),
    etaBasis: (over.etaBasis ?? (at == null ? "none" : "estimated")) as EtaBasis,
    status,
    outstanding: qty,
    ...over,
  };
}

function input(o: Partial<ProjectionInput> & { free: number | null; weekly: number }): ProjectionInput {
  return { today: TODAY, freeStock: o.free, weekly: o.weekly, minLevel: o.minLevel ?? null, builtHere: o.builtHere ?? false, lines: o.lines ?? [] };
}
const project = (o: Parameters<typeof input>[0]) => projectItem(input(o));

/* ---------- the plan's worked items ---------- */

test("BN1665G: 323 free at 166.4 a week, 2,000 estimated 10 Dec: gap 27 Oct → 10 Dec, 44 days, ~1,056 short", () => {
  const po = line(2000, 58, { poUid: "U23070", number: "00023070" });
  assert.equal(po.eta, "2026-12-10");
  const r = project({ free: 323, weekly: 166.4, minLevel: 2771, lines: [po] });
  assert.equal(r.gapStatus, "gap");
  const g = r.gap!;
  assert.deepEqual([g.start, g.end, g.days, g.unitsShort], ["2026-10-27", "2026-12-10", 44, 1056]);
  assert.equal(g.runOut, g.start);
  assert.deepEqual(g.endingPo, { poUid: "U23070", number: "00023070", supplier: "HANOVA INTERNATIONAL LTD", eta: "2026-12-10", basis: "estimated", qty: 2000 });
  assert.equal(g.openReason, null);
  assert.equal(g.minLevel, 2771, "the minimum travels as a reference only");
  assert.equal(g.freeRunOut, "2026-10-27");
  assert.equal(g.horizon, "2026-12-10");
  assert.deepEqual([g.countedQty, g.offTimelineQty], [2000, 0]);
  assert.deepEqual(r.nextDelivery, { eta: "2026-12-10", etaBasis: "estimated", number: "00023070", poUid: "U23070", qty: 2000, poCount: 1 });
  assert.equal(r.incomingOverdueQty, 0);
  // With Hanova's measured 83 days the PO lands 3 Nov: 7 days, ~177 short.
  const m = project({ free: 323, weekly: 166.4, lines: [line(2000, 21)] }).gap!;
  assert.deepEqual([m.start, m.end, m.days, m.unitsShort], ["2026-10-27", "2026-11-03", 7, 177]);
});

test("SPW12G-like: runs out 30 Oct, the 10 Dec delivery closes it: 41 days, ~4,929 short", () => {
  const g = project({ free: 2031, weekly: 840, lines: [line(9000, 58)] }).gap!;
  assert.deepEqual([g.status, g.start, g.end, g.days, g.unitsShort], ["gap", "2026-10-30", "2026-12-10", 41, 4929]);
});

test("a gap between two arrivals: the first delivery pushes the run-out back, the second ends it", () => {
  // 100 free at 10 a day: alone it runs out on day 11. 50 on day 5 moves that to day 16; 500 on day 25 ends it.
  const r = project({ free: 100, weekly: 70, lines: [line(50, 5, { number: "A" }), line(500, 25, { number: "B" })] });
  const g = r.gap!;
  assert.deepEqual([g.status, g.start, g.end, g.days, g.unitsShort, g.endingPo?.number], ["gap", on(16), on(25), 9, 100, "B"]);
  assert.equal(g.freeRunOut, on(11));
  assert.equal(r.nextDelivery?.number, "A");
});

test("a delivery too small to close it: end unknown, too_small, no units short when it starts later", () => {
  const g = project({ free: 100, weekly: 70, lines: [line(50, 20)] }).gap!;
  assert.deepEqual([g.status, g.start, g.end, g.days, g.openReason], ["gap_open", on(11), null, null, "too_small"]);
  // The depth of an open gap is not known: the deepest seen by day 20 (100)
  // would read as a total. Only an open gap that starts today has a figure.
  assert.equal(g.unitsShort, null);
  assert.equal(g.horizon, on(20));
  assert.equal(g.endingPo, null);
});

test("short now with only overdue incoming (KITST1230S): gap_open from today, overdue, the shortfall today", () => {
  const r = project({ free: -425, weekly: 120, lines: [line(6000, -28, { status: "overdue", etaBasis: "promised", number: "00022886" })] });
  assert.equal(r.gapStatus, "gap_open");
  const g = r.gap!;
  assert.deepEqual([g.start, g.end, g.openReason, g.unitsShort, g.horizon], [TODAY, null, "overdue", 425, TODAY]);
  assert.deepEqual([g.countedQty, g.offTimelineQty], [0, 6000]);
  assert.equal(r.incomingOverdueQty, 6000);
  assert.equal(r.nextDelivery, null, "an overdue PO is not a next delivery");
});

test("future run-out with only overdue incoming (KITST1240S): gap_open from the run-out day", () => {
  const g = project({ free: 1100, weekly: 70, lines: [line(6000, -28, { status: "overdue", etaBasis: "promised" })] }).gap!;
  assert.deepEqual([g.status, g.start, g.openReason], ["gap_open", on(111), "overdue"]);
  assert.equal(g.unitsShort, null, "~1 on its first day is not a shortfall to report");
});

test("short today with a dated delivery too small: units short is today's shortfall, not the deepest ahead", () => {
  const g = project({ free: -30, weekly: 70, lines: [line(20, 5)] }).gap!;
  assert.deepEqual([g.status, g.start, g.openReason, g.unitsShort], ["gap_open", TODAY, "too_small", 30]);
});

test("a vanishing weekly rate (a float left in a demand sum) returns, never spins", () => {
  // 3.0000000000000004 − 3: free ÷ daily far past 2^53, where ++ stops moving.
  for (const [free, weekly] of [[100, 1.7e-17], [1e6, 1e-10], [3, 4.440892098500626e-16], [1e12, 1e-12], [1e300, 1e-300]]) {
    const r = project({ free, weekly });
    assert.equal(r.gapStatus, "nothing_on_order", `${free} at ${weekly}`);
    assert.deepEqual([r.gap!.runOut, r.gap!.freeRunOut, r.gap!.horizon], [null, null, on(GAP_HORIZON_DAYS)]);
    assert.equal(project({ free, weekly, lines: [line(5, 10)] }).gap!.tight, false);
  }
  // At the edge of the bound the nudged and the direct day agree with cover × 7.
  for (const free of [180, 181, 182, 197, 198, 199]) {
    const g = project({ free, weekly: 7 }).gap!;
    assert.equal(g.freeRunOut, free + 1 <= GAP_HORIZON_DAYS ? on(free + 1) : null, `free ${free}`);
  }
});

test("late against estimate: off the timeline, gap_open late, counted in incomingOverdueQty", () => {
  const r = project({ free: 50, weekly: 70, lines: [line(1000, -13, { status: "late" })] });
  assert.deepEqual([r.gapStatus, r.gap!.start, r.gap!.openReason, r.incomingOverdueQty], ["gap_open", on(6), "late", 1000]);
});

test("overdue outranks late, late outranks undated, as the reason", () => {
  const lines = [line(10, null), line(10, -3, { status: "late" }), line(10, -9, { status: "overdue", etaBasis: "promised" })];
  assert.equal(project({ free: 0, weekly: 70, lines }).gap!.openReason, "overdue");
  assert.equal(project({ free: 0, weekly: 70, lines: lines.slice(0, 2) }).gap!.openReason, "late");
  assert.equal(project({ free: 0, weekly: 70, lines: lines.slice(0, 1) }).gap!.openReason, "no_date");
});

test("undated: no date, gap_open no_date, not overdue", () => {
  const r = project({ free: 50, weekly: 70, lines: [line(1000, null)] });
  assert.deepEqual([r.gapStatus, r.gap!.openReason, r.incomingOverdueQty, r.nextDelivery], ["gap_open", "no_date", 0, null]);
});

test("BN12150LTG: a late PO off the timeline does not stop a later dated one ending the gap", () => {
  const r = project({ free: -100, weekly: 700, lines: [line(40, -13, { status: "late" }), line(10000, 42, { number: "00023002" })] });
  assert.deepEqual([r.gapStatus, r.gap!.start, r.gap!.end, r.gap!.endingPo?.number, r.incomingOverdueQty], ["gap", TODAY, on(42), "00023002", 40]);
});

test("zero demand: no_demand, whatever is on order; the next delivery is still reported", () => {
  const r = project({ free: 100, weekly: 0, lines: [line(500, 10)] });
  assert.equal(r.gapStatus, "no_demand");
  assert.deepEqual([r.gap!.start, r.gap!.horizon], [null, null]);
  assert.equal(r.nextDelivery?.qty, 500);
  assert.equal(project({ free: 0, weekly: 0 }).gapStatus, "no_demand");
  // Already short with no demand is still short: committed beyond the shelf.
  const neg = project({ free: -30, weekly: 0, lines: [line(500, 10)] });
  assert.deepEqual([neg.gapStatus, neg.gap!.start, neg.gap!.end, neg.gap!.unitsShort], ["gap", TODAY, on(10), 30]);
});

test("built here: a kit made here follows its components; a kit bought complete is projected as it sits", () => {
  const r = project({ free: -50, weekly: 100, builtHere: true, lines: [line(10, 5)] });
  assert.equal(r.gapStatus, "built_here");
  assert.deepEqual([r.gap!.start, r.gap!.horizon, r.gap!.unitsShort], [null, null, null]);
  const item = (form: string | null) => ({ qtyFreeStock: 10, minLevel: null, demand: { basis: "window", directWindow: 70, componentWindow: 0, windowMonths: 6, longMonths: 12 }, kit: form ? { form } : null });
  assert.equal(projectionInput(item("made_here"), [], TODAY).builtHere, true);
  assert.equal(projectionInput(item("buy_allowed"), [], TODAY).builtHere, false);
  assert.equal(projectionInput(item(null), [], TODAY).builtHere, false);
  // A kit made here with a PO open for the complete kit is being bought
  // complete (KITST1230S on Tong Ming's 00022886): projected like any item.
  const onPo = projectionInput(item("made_here"), [line(6000, -28, { status: "overdue", etaBasis: "promised" })], TODAY);
  assert.equal(onPo.builtHere, false);
  assert.deepEqual([projectItem(onPo).gapStatus, projectItem(onPo).gap!.openReason], ["gap_open", "overdue"]);
});

test("already negative (N16G8): gap from today, the shortfall today counted", () => {
  const g = project({ free: -2000, weekly: 700, lines: [line(10000, 42)] }).gap!;
  assert.deepEqual([g.status, g.start, g.end, g.days, g.unitsShort, g.freeRunOut], ["gap", TODAY, on(42), 42, 6200, TODAY]);
});

test("an unclosed gap: the only delivery is dated beyond 26 weeks", () => {
  const g = project({ free: 100, weekly: 70, lines: [line(5000, 200)] }).gap!;
  assert.deepEqual([g.status, g.start, g.openReason, g.horizon], ["gap_open", on(11), "after_26_weeks", on(GAP_HORIZON_DAYS)]);
});

test("tight: covered, but the next delivery lands under 14 days before free stock runs out", () => {
  // WR16301.5S16: runs out ~30 Oct, delivery est. 31 Oct.
  const t = project({ free: 160, weekly: 70, lines: [line(2000, 17)] });
  assert.deepEqual([t.gapStatus, t.gap!.tight, t.gap!.freeRunOut], ["covered", true, on(17)]);
  const roomy = project({ free: 300, weekly: 70, lines: [line(2000, 10)] });
  assert.deepEqual([roomy.gapStatus, roomy.gap!.tight], ["covered", false]);
  assert.equal(project({ free: 300, weekly: 70, lines: [line(2000, 17)] }).gap!.tight, false, "31 − 17 = 14 days in hand is not tight; 13 is");
  assert.equal(project({ free: 290, weekly: 70, lines: [line(2000, 17)] }).gap!.tight, true);
  assert.equal(project({ free: 320, weekly: 70, lines: [line(2000, 17)] }).gap!.tight, false);
});

test("horizon: capped at 26 weeks; nothing on order is its own status, with the run-out", () => {
  const far = project({ free: 10000, weekly: 70, lines: [line(10, 30)] }).gap!;
  assert.deepEqual([far.status, far.horizon, far.freeRunOut], ["covered", on(GAP_HORIZON_DAYS), null]);
  const none = project({ free: 50, weekly: 70 });
  assert.deepEqual([none.gapStatus, none.gap!.runOut, none.gap!.start, none.nextDelivery], ["nothing_on_order", on(6), null, null]);
  assert.equal(project({ free: 10000, weekly: 70 }).gap!.runOut, null, "runs out beyond 26 weeks");
});

test("several lines on one day: the day's units together; the largest PO named; two lines of one PO are one PO", () => {
  const lines = [
    line(1500, 20, { poUid: "P96", number: "00023096" }),
    line(1000, 20, { poUid: "P96", number: "00023096" }),
    line(400, 20, { poUid: "P99", number: "00023099", etaBasis: "promised" }),
  ];
  const r = project({ free: 100, weekly: 70, lines });
  assert.deepEqual(r.nextDelivery, { eta: on(20), etaBasis: "estimated", number: "00023096", poUid: "P96", qty: 2900, poCount: 2 });
  assert.deepEqual([r.gap!.status, r.gap!.end, r.gap!.endingPo?.number, r.gap!.endingPo?.qty], ["gap", on(20), "00023096", 2500]);
});

test("a part-received line counts only what is still to come", () => {
  // Ordered 1,000, 400 received: 600 outstanding is all the schedule carries.
  const r = project({ free: 100, weekly: 70, lines: [line(600, 20)] });
  assert.deepEqual([r.gap!.status, r.gap!.end, r.gap!.countedQty], ["gap", on(20), 600]);
  assert.equal(project({ free: 100, weekly: 70, lines: [line(50, 20)] }).gapStatus, "gap_open");
});

test("a delivery due today counts today", () => {
  const r = project({ free: -10, weekly: 70, lines: [line(100, 0)] });
  assert.equal(r.gapStatus, "covered");
});

test("no position: no projection; the schedule facts still come through", () => {
  const r = project({ free: null, weekly: 70, lines: [line(5, -2, { status: "late" }), line(9, 4)] });
  assert.deepEqual([r.gap, r.gapStatus, r.incomingOverdueQty, r.nextDelivery?.qty], [null, null, 5, 9]);
});

/* ---------- identities ---------- */

/** A small seeded generator, so a failure reproduces. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

test("identities over 2,000 random items: run-out = cover × 7 within a day; a known end is an ETA; units add up", () => {
  const r = rng(7);
  for (let n = 0; n < 2000; n++) {
    const weekly = r() < 0.1 ? 0 : r() * 500;
    const free = Math.round((r() - 0.15) * 4000);
    const lines: ProjectionLine[] = [];
    for (let k = Math.floor(r() * 4); k > 0; k--) {
      const roll = r();
      lines.push(roll < 0.15 ? line(Math.round(r() * 3000), -5, { status: "overdue" }) : roll < 0.25 ? line(100, null) : line(Math.round(r() * 3000) + 1, Math.floor(r() * 220)));
    }
    const out = projectItem(input({ free, weekly, lines }));
    const g = out.gap!;
    assert.equal(out.gapStatus, g.status);
    assert.equal(g.countedQty + g.offTimelineQty, lines.reduce((s, l) => s + l.outstanding, 0));
    if (g.runOut && weekly > 0 && !lines.some((l) => l.status === "due" && l.eta! < g.runOut!)) {
      const days = (Date.parse(g.runOut) - Date.parse(TODAY)) / 86_400_000;
      assert.ok(Math.abs(days - (Math.max(free, 0) / weekly) * 7) <= 1, `${free} at ${weekly}: ${days}`);
    }
    if (g.status === "gap") {
      assert.ok(lines.some((l) => l.status === "due" && l.eta === g.end), "ends on one of its ETAs");
      assert.equal(g.endingPo?.eta, g.end);
      assert.ok(g.days! > 0 || g.start === g.end);
    }
    if (g.status === "gap") assert.ok(g.unitsShort! >= 1 || free <= 0);
    if (g.status === "gap_open") assert.equal(g.unitsShort == null, g.start !== TODAY);
    if (g.horizon) assert.ok(g.horizon <= on(GAP_HORIZON_DAYS));
  }
});

/* ---------- the weekly rate and the server wiring ---------- */

test("weeklyRate is the unrounded rate free-stock cover uses in computeItem", () => {
  const WEEKS = (6 * 365.25) / 12 / 7;
  for (const [sold, free] of [[4342.3, 323], [17, 5], [1, 1000]]) {
    const i = computeItem({ uid: "u", on_hand: free, committed: 0, on_order: 0, direct_window: sold, direct_long: sold * 2, direct_year: 1 }, { asAt: TODAY, windowMonths: 6, longMonths: 12 });
    const w = weeklyRate(i.demand);
    assert.equal(w, sold / WEEKS);
    assert.equal(i.demand.weekly, Number(w.toFixed(3)));
    assert.equal(i.coverWeeks, Number((free / w).toFixed(1)));
  }
  const slow = computeItem({ uid: "s", on_hand: 5, direct_window: 0, direct_long: 52, direct_year: 1 }, { asAt: TODAY, windowMonths: 6, longMonths: 12 });
  assert.equal(slow.demand.basis, "long");
  assert.equal(weeklyRate(slow.demand), 52 / ((12 * 365.25) / 12 / 7));
  assert.equal(weeklyRate(null), 0);
});

function itemsFor(): ItemComputed[] {
  const WIN = { asAt: TODAY, windowMonths: 6, longMonths: 12 };
  return [
    computeItem({ uid: "a", number: "A", on_hand: 323, on_order: 2000, direct_window: (166.4 * 6 * 365.25) / 12 / 7, direct_year: 1 }, WIN),
    computeItem({ uid: "b", number: "B", on_hand: 50, direct_window: 100, direct_year: 1 }, WIN),
  ];
}
const sched = (itemUid: string, qty: number, at: number): ScheduleRow =>
  ({ ...line(qty, at, { poUid: "P1", number: "00023070" }), itemUid, line: 0, raised: "2026-08-12", ordered: qty, received: 0 }) as unknown as ScheduleRow;

test("attachGaps: each item gets its own lines' projection; a past date gets null fields", () => {
  const items = itemsFor();
  attachGaps(items, [sched("a", 2000, 58)], TODAY);
  assert.equal(items[0].gapStatus, "gap");
  assert.equal(items[0].gap?.end, on(58));
  assert.equal(items[1].gapStatus, "nothing_on_order");
  const past = itemsFor();
  attachGaps(past, null, TODAY);
  for (const i of past) assert.deepEqual([i.gap, i.gapStatus, i.nextDelivery, i.incomingOverdueQty], [null, null, null, null]);
});

test("switch-off: GAP_ENABLED false runs no schedule and leaves every field null, with nothing logged", () => {
  // Not pinned to true: a switch-off release sets it false and must still build.
  assert.equal(typeof GAP_ENABLED, "boolean");
  assert.equal(gapsRunFor(TODAY, TODAY, true), true);
  assert.equal(gapsRunFor(TODAY, TODAY, false), false, "off: no schedule query");
  assert.equal(gapsRunFor("2026-08-26", TODAY, true), false, "a past date: no schedule query");
  // computedItems hands attachGaps a null schedule whenever gapsRunFor is false.
  const items = itemsFor();
  const logged: string[] = [];
  attachGaps(items, null, TODAY, () => { throw new Error("must not run"); }, (m) => logged.push(m));
  for (const i of items) assert.deepEqual([i.gap, i.gapStatus, i.nextDelivery, i.incomingOverdueQty], [null, null, null, null]);
  assert.deepEqual(logged, [], "off is not a failure");
});

test("attachGaps fail-safe: a throwing projection or a failed schedule leaves every field null, logs once, never throws", () => {
  for (const [schedule, project] of [
    [[sched("a", 2000, 58)], () => { throw new Error("forced"); }],
    [new Error("relation does not exist"), projectItem],
  ] as const) {
    const items = itemsFor();
    const logged: string[] = [];
    assert.doesNotThrow(() => attachGaps(items, schedule as never, TODAY, project as never, (m) => logged.push(m)));
    assert.equal(logged.length, 1, "once per cache build");
    for (const i of items) {
      assert.deepEqual([i.gap, i.gapStatus, i.nextDelivery, i.incomingOverdueQty], [null, null, null, null]);
      assert.ok("gap" in i, "the fields are present, as null");
    }
    // Nothing else on the item moved.
    assert.deepEqual(items.map((i) => [i.suggestion, i.flags, i.risk]), itemsFor().map((i) => [i.suggestion, i.flags, i.risk]));
  }
  // One item throwing blanks them all: no half-projected set.
  const items = itemsFor();
  let calls = 0;
  attachGaps(items, [sched("a", 2000, 58)], TODAY, (x) => { if (++calls === 2) throw new Error("second"); return projectItem(x); }, () => {});
  assert.deepEqual(items.map((i) => i.gapStatus), [null, null]);
});

test("the gap fields leave the suggestion, flags, risk and covers exactly as computeItem made them", () => {
  const before = itemsFor();
  const after = itemsFor();
  attachGaps(after, [sched("a", 2000, 58)], TODAY);
  const strip = (i: ItemComputed) => {
    const { gap, gapStatus, nextDelivery, incomingOverdueQty, ...rest } = i;
    return rest;
  };
  assert.deepEqual(after.map(strip), before);
});

/* ---------- stage-check gap ---------- */

function capture() {
  const items = itemsFor();
  const rows = [sched("a", 2000, 58)];
  attachGaps(items, rows, TODAY);
  const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
  const served = json(items);
  const details = new Map<string, any>(served.map((i: any) => [i.uid, { item: json(i), incomingSchedule: json(rows.filter((r) => r.itemUid === i.uid)), incomingScheduleDate: TODAY }]));
  const overview = { kpis: { runsOutBeforeNextDelivery: 1 } };
  return { items: served, details, overview };
}

test("stage-check gap: a consistent capture passes; the counts and table say what runs out", () => {
  const { checks, counts, table } = gapChecks({ ...capture(), projection });
  for (const c of checks) assert.ok(c.ok, `${c.check}: ${c.detail}`);
  assert.equal(counts.gap, 1);
  assert.equal(counts.nothing_on_order, 1);
  assert.equal(counts.runsOut, 1);
  assert.deepEqual(table.map((t: any) => [t.number, t.start, t.end, t.days, t.short]), [["A", "2026-10-27", "2026-12-10", 44, 1056]]);
});

test("stage-check gap: a moved end, a wrong count, a stale list row or an old server each fail", () => {
  const bad = (mutate: (f: ReturnType<typeof capture>) => void) => {
    const f = capture();
    mutate(f);
    return gapChecks({ ...f, projection }).checks.filter((c: any) => !c.ok).map((c: any) => c.check);
  };
  assert.ok(bad((f) => { f.details.get("a").item.gap.end = "2026-12-11"; }).some((c: string) => /field for field/.test(c)));
  assert.ok(bad((f) => { f.details.get("a").incomingSchedule[0].eta = "2026-12-01"; }).some((c: string) => /field for field/.test(c)));
  assert.ok(bad((f) => { f.overview.kpis.runsOutBeforeNextDelivery = 2; }).some((c: string) => /Overview/.test(c)));
  assert.ok(bad((f) => { f.items[0].gapStatus = "covered"; }).some((c: string) => /items list carries/.test(c)));
  assert.ok(bad((f) => { delete f.items[1].nextDelivery; }).some((c: string) => /1\.10 server/.test(c)));
  assert.ok(bad((f) => {
    const d = f.details.get("a");
    d.item.gap.runOut = d.item.gap.start = "2026-11-20";
    f.items[0].gap.runOut = f.items[0].gap.start = "2026-11-20";
  }).some((c: string) => /cover × 7/.test(c)));
});

test("stage-check gap samples every item on order plus 50 others spread through the list", () => {
  const items = Array.from({ length: 300 }, (_, k) => ({ uid: `u${k}`, number: `N${String(k).padStart(3, "0")}`, qtyOnOrder: k % 10 === 0 ? 5 : 0 }));
  const s = gapSample(items);
  assert.equal(s.length, 30 + 50);
  assert.equal(new Set(s.map((i: any) => i.uid)).size, s.length);
});
