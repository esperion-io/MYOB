import type { EtaBasis, EtaStatus, ScheduleRow } from "./incoming.js";

/**
 * Stock gaps (1.10, groundwork): Allied's request #2, part 2, "show what gaps
 * might exist between current stock levels, current demand, and incoming
 * stock". This version works the gap out on the server and shows nothing; the
 * next puts it on screen. It ships alone so its cost and its safety can be
 * measured on production first.
 *
 * PURE. No database, no clock, no imports at run time: computedItems hands it
 * the item and that item's lines of today's PO schedule (incoming.ts), and
 * `stage-check gap` hands it the same two things read back from /items/:uid,
 * so the check recomputes the server's answer with the server's own code.
 *
 * THE RULE (FEEDBACK-PLAN Stage 11, the defaults for Q3):
 *
 *   P(d) = free stock today
 *        + Σ outstanding on lines whose ETA is dated, still to come and ≤ d
 *        − (weekly ÷ 7) × d
 *
 *   - Weekly is the rate cover uses, unrounded (weeklyRate below).
 *   - Committed stock, future-dated sale orders included, is reserved today,
 *     as free stock already does.
 *   - Overdue, late and undated lines are NOT counted. A PO that has missed
 *     its date has no date, and inventing one ("today", "next week") would
 *     draw an arrival nobody promised. They stay off the timeline, so an item
 *     whose incoming is all overdue still shows its run-out, with the end of
 *     the gap unknown. KITST1230S on 13 Oct: free stock −425, its only PO
 *     (6,000 on 00022886) 28 days overdue: short from today, end unknown.
 *   - Promised Date is the ETA (Allied's decision of 12 Oct); a PO without
 *     one counts on its labelled estimate, and the gap says which it ended on.
 *   - The threshold is zero. The minimum travels along only as a reference.
 *   - The projection runs to the later of the last dated delivery and the day
 *     free stock alone would run out, capped at 26 weeks.
 *
 * The run-out is the first day P < 0. The gap is the run of days from there
 * until a counted delivery brings P back to ≥ 0: its end is that delivery's
 * ETA, and the PO that ends it is named with its basis. BN1665G (free 323,
 * 166.4 a week, 2,000 on 00023070 estimated 10 Dec): runs out 27 Oct, gap to
 * 10 Dec, 44 days, ~1,056 short. If nothing counted closes it inside the
 * horizon the end is unknown, with the reason: an overdue PO, one late
 * against its estimate, one with no date, one dated beyond 26 weeks, or
 * deliveries too small.
 *
 * NOTHING CALCULATES FROM THIS. Suggestions, risk, flags, both cover figures,
 * the cart and the daily rows never read a gap field (test/incoming.test.ts
 * holds that). A gap is a reading of figures that already exist.
 */

/** How far the projection looks: 26 weeks. */
export const GAP_HORIZON_DAYS = 182;
/** A covered item is tight when its next delivery lands less than this before free stock runs out. */
export const TIGHT_DAYS = 14;

export type GapStatus = "gap" | "gap_open" | "covered" | "nothing_on_order" | "no_demand" | "built_here";
export type GapOpenReason = "overdue" | "late" | "no_date" | "too_small" | "after_26_weeks";

/** The schedule facts a projection reads: one open PO line each. */
export type ProjectionLine = Pick<ScheduleRow, "poUid" | "number" | "supplier" | "eta" | "etaBasis" | "status" | "outstanding">;

export interface ProjectionInput {
  /** The business date the schedule's statuses were worked out for. */
  today: string;
  /** On hand − committed; null when the position is not known. */
  freeStock: number | null;
  /** Units a week, unrounded: the rate free-stock cover divides by. */
  weekly: number;
  /** Allied's minimum, a reference line only. */
  minLevel: number | null;
  /** A kit made here, with no PO for the complete kit: it follows its components, not a timeline of its own. */
  builtHere: boolean;
  lines: ProjectionLine[];
}

/** A PO named by the projection: the one that ends a gap, or the next to land. */
export interface GapPo {
  poUid: string;
  number: string | null;
  supplier: string | null;
  eta: string;
  basis: EtaBasis;
  /** This item's units on that PO landing that day. */
  qty: number;
}

export interface Gap {
  status: GapStatus;
  /** First day projected free stock is below zero (gap, gap_open; nothing_on_order when inside the horizon). */
  runOut: string | null;
  /** The gap: its first day (= runOut), its end (a counted delivery's ETA, or null when unknown), days between. */
  start: string | null;
  end: string | null;
  days: number | null;
  /**
   * The deepest shortfall inside the gap, today's included, in whole units.
   * An open gap has no known depth: today's shortfall when it starts today,
   * else null.
   */
  unitsShort: number | null;
  endingPo: GapPo | null;
  openReason: GapOpenReason | null;
  /** Covered, but the next counted delivery lands under 14 days before free stock alone would run out. */
  tight: boolean;
  /** The day free stock alone would first be below zero; null without demand or beyond 26 weeks. */
  freeRunOut: string | null;
  /** The last day projected; null when no projection was run (built here, no demand). */
  horizon: string | null;
  /**
   * The item page's "Stock outlook" strip (1.11): the same projection, one
   * entry a week from today to the horizon, so the browser draws the series
   * this function walked rather than replaying it. Null when no projection
   * was run.
   */
  weeks: GapWeek[] | null;
  /** Units on the timeline (dated, still to come) and off it (overdue, late, undated). */
  countedQty: number;
  offTimelineQty: number;
  /** The inputs, so a reader (and stage-check) can see what it was worked from. */
  freeStock: number;
  weekly: number;
  minLevel: number | null;
}

/**
 * One week of the outlook (1.11). Units are whole, rounded down, as units
 * short is rounded up: a week reading −1,056 at its lowest is the gap's
 * ~1,056 short. Inside a gap the lowest point is taken before that day's
 * delivery lands (the depth units short measures); elsewhere after it, so a
 * delivery that lands on the day stock would run out shows no dip, exactly
 * as it counts as no gap. BN1665G (13 Oct): nine weeks, the lowest −1,056 in
 * the week of 8 Dec, when 00023070 lands.
 */
export interface GapWeek {
  /** Its first day: today, then every 7 days. */
  start: string;
  /** Days of it inside the projection: 7, or fewer for the last week. */
  days: number;
  /** The lowest projected free stock that week. */
  low: number;
  /** Projected free stock at the end of its last day. */
  close: number;
  /** The counted deliveries landing that week, day by day, the largest PO first. */
  arrivals: GapPo[];
}

export interface NextDelivery {
  eta: string;
  etaBasis: EtaBasis;
  /** The largest PO landing that day; poCount says how many land then. */
  number: string | null;
  poUid: string;
  /** Every unit of this item due that day, across those POs. */
  qty: number;
  poCount: number;
}

/** The four fields computedItems attaches to every item (all null at a past date). */
export interface GapFields {
  gap: Gap | null;
  gapStatus: GapStatus | null;
  nextDelivery: NextDelivery | null;
  /** Units on lines past their date: overdue against a Promised Date, or late against an estimate. */
  incomingOverdueQty: number | null;
}

export const NO_GAP_FIELDS: Readonly<GapFields> = Object.freeze({
  gap: null,
  gapStatus: null,
  nextDelivery: null,
  incomingOverdueQty: null,
});

/** Floating-point slack: a balance within this of zero is zero, not short. */
const EPS = 1e-9;
const DAY_MS = 86_400_000;

function utc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
function addDays(iso: string, days: number): string {
  return new Date(utc(iso) + days * DAY_MS).toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

/**
 * The weekly rate free-stock cover divides by, unrounded. computeItem keeps
 * it only to 3 dp in demand.weekly; the sums it is built from are carried
 * whole, so the server and stage-check rebuild the same figure from them
 * (the same arithmetic as computeItem: weeks per month averaged over a year).
 */
export function weeklyRate(d: {
  basis?: string | null;
  directWindow?: number | null;
  componentWindow?: number | null;
  directLong?: number | null;
  componentLong?: number | null;
  windowMonths?: number | null;
  longMonths?: number | null;
} | null | undefined): number {
  const weeksIn = (months: number) => (months * 365.25) / 12 / 7;
  if (d?.basis === "window" && d.windowMonths)
    return ((d.directWindow ?? 0) + (d.componentWindow ?? 0)) / weeksIn(d.windowMonths);
  if (d?.basis === "long" && d.longMonths)
    return ((d.directLong ?? 0) + (d.componentLong ?? 0)) / weeksIn(d.longMonths);
  return 0;
}

/**
 * An item as /items and /items/:uid serve it, plus its schedule lines, as a
 * projection's input. One mapping, used by computedItems and by stage-check.
 */
export function projectionInput(
  item: {
    qtyFreeStock: number | null;
    demand: Parameters<typeof weeklyRate>[0];
    minLevel: number | null;
    kit?: { form?: string | null } | null;
  },
  lines: ProjectionLine[],
  today: string,
): ProjectionInput {
  return {
    today,
    freeStock: item.qtyFreeStock,
    weekly: weeklyRate(item.demand),
    minLevel: item.minLevel ?? null,
    // A kit made here follows its components: buildable stock is not a
    // shelf quantity to run down, and is never additive across kits. A kit
    // bought complete is projected like any item, as it sits, and never
    // broken open: one Allied mark buy_allowed, and one with a PO open for
    // the complete kit, whatever its form says. The form is derived from
    // bills, so a kit on its first order still reads made_here: on the 26
    // Aug copy KITST1230S and KITST1240S do, with 6,000 and 11,250 on Tong
    // Ming's overdue 00022886. Those POs are kits arriving, not parts.
    builtHere: item.kit?.form === "made_here" && !lines.some((l) => l.outstanding > 0),
    lines,
  };
}

/** Same-day lines of this item, one entry per PO, the largest first. */
function posOn(lines: ProjectionLine[]): GapPo[] {
  const by = new Map<string, GapPo>();
  for (const l of lines) {
    const e = by.get(l.poUid);
    if (e) e.qty += l.outstanding;
    else
      by.set(l.poUid, {
        poUid: l.poUid,
        number: l.number,
        supplier: l.supplier,
        eta: l.eta as string,
        basis: l.etaBasis,
        qty: l.outstanding,
      });
  }
  return [...by.values()].sort(
    (a, b) => b.qty - a.qty || String(a.number ?? "").localeCompare(String(b.number ?? "")),
  );
}

/**
 * The outlook strip (1.11): P(d) walked again, day by day to the horizon,
 * and reported a week at a time. It is the walk projectItem has just made,
 * carried on past the gap's end so the strip shows the recovery too. Inside
 * the gap (start to end, or to the horizon when the end is unknown) a day's
 * low is taken before its delivery lands, the depth units short measures.
 */
function weekSeries(p: {
  today: string;
  free: number;
  daily: number;
  due: Map<number, ProjectionLine[]>;
  horizon: number;
  start: number | null;
  end: number | null;
}): GapWeek[] {
  const whole = (v: number) => Math.floor(v + EPS);
  const weeks: GapWeek[] = [];
  let cumBefore = 0;
  for (let w = 0; w * 7 <= p.horizon; w++) {
    let low = Infinity;
    let close = 0;
    const landing: ProjectionLine[] = [];
    const last = Math.min(w * 7 + 6, p.horizon);
    for (let d = w * 7; d <= last; d++) {
      const lands = p.due.get(d) ?? [];
      const pre = p.free + cumBefore - p.daily * d;
      cumBefore += lands.reduce((s, l) => s + l.outstanding, 0);
      const bal = p.free + cumBefore - p.daily * d;
      const inGap = p.start != null && d >= p.start && (p.end == null || d <= p.end);
      low = Math.min(low, inGap ? pre : bal);
      close = bal;
      landing.push(...lands);
    }
    // One entry per PO per day, the largest first, days in order.
    const byDay = new Map<string, ProjectionLine[]>();
    for (const l of landing) byDay.set(l.eta as string, [...(byDay.get(l.eta as string) ?? []), l]);
    weeks.push({
      start: addDays(p.today, w * 7),
      days: last - w * 7 + 1,
      low: whole(low),
      close: whole(close),
      arrivals: [...byDay.keys()].sort().flatMap((eta) => posOn(byDay.get(eta)!)),
    });
  }
  return weeks;
}

/** The projection for one item (pure). */
export function projectItem(input: ProjectionInput): GapFields {
  const { today, freeStock: free, minLevel, lines } = input;
  const weekly = Number.isFinite(input.weekly) && input.weekly > 0 ? input.weekly : 0;
  const late = (s: EtaStatus) => s === "overdue" || s === "late";

  const incomingOverdueQty = lines.reduce((s, l) => s + (late(l.status) ? l.outstanding : 0), 0);

  // On the timeline: dated and still to come. Keyed by days from today.
  const due = new Map<number, ProjectionLine[]>();
  let countedQty = 0;
  for (const l of lines) {
    if (l.status !== "due" || l.eta == null || !(l.outstanding > 0)) continue;
    const at = daysBetween(today, l.eta);
    if (at < 0) continue; // defensive: "due" is never in the past
    countedQty += l.outstanding;
    due.set(at, [...(due.get(at) ?? []), l]);
  }
  const offTimelineQty = lines.reduce((s, l) => s + (l.status === "due" ? 0 : l.outstanding), 0);
  const days = [...due.keys()].sort((a, b) => a - b);

  let nextDelivery: NextDelivery | null = null;
  if (days.length) {
    const that = due.get(days[0])!;
    const pos = posOn(that);
    nextDelivery = {
      eta: pos[0].eta,
      etaBasis: pos[0].basis,
      number: pos[0].number,
      poUid: pos[0].poUid,
      qty: that.reduce((s, l) => s + l.outstanding, 0),
      poCount: pos.length,
    };
  }

  const fields = (gap: Gap | null): GapFields => ({
    gap,
    gapStatus: gap?.status ?? null,
    nextDelivery,
    incomingOverdueQty,
  });
  // A position we do not have is not a position of zero (computeItem says
  // the same): nothing is projected from a shelf we cannot see.
  if (free == null || !Number.isFinite(free)) return fields(null);

  const base: Gap = {
    status: "covered",
    runOut: null,
    start: null,
    end: null,
    days: null,
    unitsShort: null,
    endingPo: null,
    openReason: null,
    tight: false,
    freeRunOut: null,
    horizon: null,
    weeks: null,
    countedQty,
    offTimelineQty,
    freeStock: free,
    weekly,
    minLevel,
  };
  if (input.builtHere) return fields({ ...base, status: "built_here" });
  // Nothing sells and nothing is short: nothing can run out. Free stock that
  // is already negative (committed beyond the shelf) is short today whether
  // or not it sells, so it is projected.
  if (weekly <= 0 && free >= -EPS) return fields({ ...base, status: "no_demand" });

  const daily = weekly / 7;
  // The first day free stock alone is below zero: floor(free ÷ daily) + 1,
  // so free-stock cover × 7 to within a day. Nudged for rounding at the edge,
  // and only near the horizon: a float left over in a demand sum (3.0000000000000004
  // − 3 is a weekly of 4.4e-16) puts free ÷ daily past 2^53, where ++ no longer
  // moves the number and the nudge would spin forever. That is a hang, not a
  // throw, so the fail-safe in attachGaps could not catch it. Beyond the
  // horizon the exact day is never read, so it is simply "after".
  let freeOut = Infinity;
  if (free < -EPS) freeOut = 0;
  else if (daily > 0) {
    const q = free / daily;
    if (q > GAP_HORIZON_DAYS + TIGHT_DAYS + 2) freeOut = Number.isFinite(q) ? Math.floor(q) + 1 : Infinity;
    else {
      freeOut = Math.max(Math.floor(q), 0);
      for (let k = 0; k < 3 && freeOut > 0 && free - daily * (freeOut - 1) < -EPS; k++) freeOut--;
      for (let k = 0; k < 3 && free - daily * freeOut >= -EPS; k++) freeOut++;
    }
  }
  const lastDated = days.length ? days[days.length - 1] : 0;
  const horizon = Math.min(Math.max(lastDated, Number.isFinite(freeOut) ? freeOut : GAP_HORIZON_DAYS), GAP_HORIZON_DAYS);

  let cumBefore = 0;
  let start: number | null = null;
  let end: number | null = null;
  let worst = 0;
  let shortToday = 0;
  for (let d = 0; d <= horizon; d++) {
    const landing = (due.get(d) ?? []).reduce((s, l) => s + l.outstanding, 0);
    const pre = free + cumBefore - daily * d;
    const bal = pre + landing;
    if (d === 0) shortToday = bal;
    cumBefore += landing;
    if (start == null) {
      if (bal < -EPS) {
        start = d;
        worst = pre;
      }
      continue;
    }
    worst = Math.min(worst, pre);
    if (bal >= -EPS) {
      end = d;
      break;
    }
  }

  const g: Gap = {
    ...base,
    freeRunOut: freeOut <= GAP_HORIZON_DAYS ? addDays(today, freeOut) : null,
    horizon: addDays(today, horizon),
    weeks: weekSeries({ today, free, daily, due, horizon, start, end }),
  };

  if (start == null) {
    if (!lines.length) return fields({ ...g, status: "nothing_on_order" });
    // Covered to the horizon. Tight when the next counted delivery has under
    // two weeks in hand: WR16301.5S16 runs out ~30 Oct and 00023070 is
    // estimated for 31 Oct, so it is covered with nothing to spare.
    const tight = days.length > 0 && Number.isFinite(freeOut) && freeOut - days[0] < TIGHT_DAYS;
    return fields({ ...g, status: "covered", tight });
  }

  const runOut = addDays(today, start);
  const unitsShort = Math.max(Math.ceil(-worst - EPS), 0);
  // "Already covered by Reorder now": nothing on order at all, so there is
  // no delivery for the gap to end on and nothing to say about one.
  if (!lines.length) return fields({ ...g, status: "nothing_on_order", runOut });

  if (end != null) {
    const ending = posOn(due.get(end)!)[0];
    return fields({
      ...g,
      status: "gap",
      runOut,
      start: runOut,
      end: ending.eta,
      days: end - start,
      unitsShort,
      endingPo: ending,
    });
  }

  // End unknown. The reason names what is keeping the gap open, most
  // actionable first: a PO past its promised date, one past its estimate,
  // one with no date at all, one dated beyond the horizon, else the counted
  // deliveries are simply not enough.
  const has = (s: EtaStatus) => lines.some((l) => l.status === s && l.outstanding > 0);
  const openReason: GapOpenReason = has("overdue")
    ? "overdue"
    : has("late")
      ? "late"
      : has("undated")
        ? "no_date"
        : days.some((d) => d > GAP_HORIZON_DAYS)
          ? "after_26_weeks"
          : "too_small";
  // Units short only when it is a fact: an open gap that starts today is
  // short by today's figure (KITST1230S, "already short by 425"). One that
  // starts later has no known depth, the projection stops at its first day,
  // so the deepest seen there (often 1) would read as a total. Null instead.
  return fields({
    ...g,
    status: "gap_open",
    runOut,
    start: runOut,
    unitsShort: start === 0 ? Math.max(Math.ceil(-shortToday - EPS), 0) : null,
    openReason,
  });
}

/** gap and gap_open: free stock runs out before a counted delivery lands. */
export function runsOutBeforeNextDelivery(status: GapStatus | null | undefined): boolean {
  return status === "gap" || status === "gap_open";
}
