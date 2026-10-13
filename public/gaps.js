/*
 * The words and shapes for stock gaps on screen (1.11).
 *
 * Allied's request #2: "show what gaps might exist between current stock
 * levels, current demand, and incoming stock". The server works the gap out
 * (src/insights/projection.ts, attached to every item by computedItems):
 * when free stock runs out, the counted delivery that brings it back, how
 * many units short in between, why an end is unknown, and a week-by-week
 * series of the same projection. This module only words those fields, for
 * the item page's Stock gap tile and Stock outlook panel, the Gap before
 * delivery column on Inventory and on Purchasing's By item, and the
 * sentence in both drill-downs, so the four can't describe one gap two ways.
 * Nothing here adds, projects or compares stock: a figure that isn't in the
 * gap object or the item page's PO rows isn't shown.
 *
 * Kept apart from dashboard.js, like incoming.js and order-list.js, so
 * test/gaps.test.ts can import it: nothing here touches the DOM. Every field
 * is read with `?? null`. A server before 1.11 sends no gap fields at all,
 * and an item without them reads "—"; at a past date the server sends them
 * null (MYOB keeps no PO history) and the screens say "today only".
 *
 * Dates come from the PO's Promised Date in MYOB, which Allied decided on
 * 12 Oct 2026 to enter as the ETA; a PO without one counts on its labelled
 * estimate (PO date + its supplier's lead), and every gap says which it
 * ended on. Overdue and late POs are never counted as arriving, so a gap
 * waiting on one has an unknown end.
 */
import { shortDate } from "./incoming.js";

/** gap and gap_open: free stock runs out before a counted delivery lands. */
export function runsOut(status) {
  return status === "gap" || status === "gap_open";
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const defaultQty = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
const defaultWeeks = (w) => `${Number(Number(w).toFixed(1))}w`;

const defaultWords = (w) => `${Number(Number(w).toFixed(1))} weeks`;

/*
 * The formatters a caller passes: `qty` for units; `weeks` and `words` for a
 * span in weeks, compact ("6.3w") and in prose ("6.3 weeks") (dashboard.js
 * passes coverLabel and coverWords, so the weeks / months toggle applies
 * here as it does to cover); `today` the business date the gap was worked
 * out for (the item page's incomingScheduleDate, or the as-at date on a
 * list), so a gap starting today says "today" and dates drop this year.
 */
function fmtOf(opts = {}) {
  return {
    qty: opts.qty ?? defaultQty,
    weeks: opts.weeks ?? defaultWeeks,
    words: opts.words ?? defaultWords,
    today: opts.today ?? null,
  };
}

/** "166.4 a week", "3,419.6 a week", three significant figures under 10 (0.038 a week, not 0.0). */
export function weeklyText(weekly) {
  const w = Number(weekly) || 0;
  return `${w >= 10 ? w.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : String(Number(w.toPrecision(3)))} a week`;
}

/*
 * How far free stock is below zero today, after anything landing today: the
 * "already short by" figure. Not unitsShort, which for a gap with a known
 * end is the deepest point of the whole gap: BN12150LTG (13 Oct) is short
 * 893 today and 3,504 at the bottom, the day before 00023096 lands. Only an
 * open gap that starts today carries today's figure there (projection.ts),
 * so that is read as sent. Null when free stock isn't below zero today.
 */
function shortToday(item, g, today) {
  if (g.status === "gap_open" && today != null && g.start === today && g.unitsShort != null) return g.unitsShort;
  if (g.freeStock == null || !Number.isFinite(Number(g.freeStock))) return null;
  const next = item?.nextDelivery ?? null;
  const landing = next && today != null && next.eta === today ? Number(next.qty) || 0 : 0;
  const bal = Number(g.freeStock) + landing;
  return bal < 0 ? Math.ceil(-bal - 1e-9) : null;
}

/** Whether the item carries the 1.11 server's gap fields at all. */
export function hasGapFields(item) {
  return item != null && "gapStatus" in item;
}

/*
 * The POs an open gap is waiting on, from the item page's schedule rows:
 * overdue, late against estimate, or undated, one entry per PO with its
 * units summed, in the server's order (overdue and late first). Empty
 * without the rows (Inventory's list, By item's row), which then say less.
 */
export function offTimelinePos(rows) {
  const by = new Map();
  for (const r of rows ?? []) {
    if (!r || r.status === "due" || !(Number(r.outstanding) > 0)) continue;
    const key = r.poUid ?? r.number;
    const e = by.get(key);
    if (e) e.qty += Number(r.outstanding);
    else
      by.set(key, {
        poUid: r.poUid ?? null,
        number: r.number ?? null,
        supplier: r.supplier ?? null,
        status: r.status ?? null,
        daysLate: r.daysLate ?? null,
        eta: r.eta ?? null,
        qty: Number(r.outstanding),
      });
  }
  return [...by.values()];
}

/** "PO 00022886 overdue", "POs 00022886, 00023063 overdue", "3 POs overdue". */
function posPhrase(pos, verb) {
  const nums = pos.map((p) => p.number).filter(Boolean);
  if (!nums.length) return `${pos.length > 1 ? `${pos.length} POs` : "a PO"} ${verb}`;
  if (nums.length === 1) return `PO ${nums[0]} ${verb}`;
  if (nums.length === 2) return `POs ${nums.join(", ")} ${verb}`;
  return `${nums.length} POs ${verb}`;
}

/*
 * Why an open gap's end is unknown, short, for the tile and the cell:
 * "PO 00022886 overdue", "PO 00023309 late against estimate", "PO 00022464
 * has no date", "next delivery after 26 weeks", "deliveries too small".
 * Names the POs when the item page's rows are there.
 */
export function openReasonText(gap, rows = null) {
  const reason = gap?.openReason ?? null;
  const off = offTimelinePos(rows);
  if (reason === "overdue") return posPhrase(off.filter((p) => p.status === "overdue"), "overdue");
  if (reason === "late") return posPhrase(off.filter((p) => p.status === "late"), "late against estimate");
  if (reason === "no_date") {
    const undated = off.filter((p) => p.status === "undated");
    return undated.length === 1 && undated[0].number ? `PO ${undated[0].number} has no date` : "a PO has no date";
  }
  if (reason === "after_26_weeks") return "next delivery after 26 weeks";
  if (reason === "too_small") return "deliveries too small";
  return "end unknown";
}

const UNAVAILABLE = "Stock gaps aren't available right now.";

/** "estimate" or "promised", as the tile's note says what ended a gap. */
const basisWord = (basis) => (basis === "promised" ? "promised" : basis === "estimated" ? "estimate" : null);

/*
 * The item page's Stock gap tile as { value, note, tone, title }.
 *
 *   gap               "27 Oct → 10 Dec" (red), "~1,056 short · estimate"
 *   gap_open          "From today" (red), "end unknown (PO 00022886 overdue)"
 *   covered           "None before next delivery", "tight" (amber) when it is
 *   nothing_on_order  "Nothing on order"
 *   no_demand         "No demand"
 *   built_here        "Follows its components"
 *   a past date       "—", "today only"
 *   no fields / null  "—"
 *
 * `rows` are the item page's incomingSchedule, to name the PO an open gap
 * waits on.
 */
export function gapTile(item, { historical = false, rows = null, ...opts } = {}) {
  const f = fmtOf(opts);
  const date = (iso) => shortDate(iso, f.today);
  if (!hasGapFields(item)) return { value: "—", note: null, tone: "", title: "Stock gaps need a newer server." };
  if (historical)
    return { value: "—", note: "today only", tone: "", title: "Gaps are worked out for today only: MYOB keeps no history of open POs or their dates." };
  const g = item.gap ?? null;
  const status = item.gapStatus ?? g?.status ?? null;
  // No gap at today with a free-stock figure to project from: gaps are
  // switched off on the server (GAP_ENABLED) or its projection failed.
  if (!g || !status)
    return { value: "—", note: null, tone: "", title: item.qtyFreeStock != null ? UNAVAILABLE : "No stock position to project from." };
  if (status === "gap") {
    const basis = basisWord(g.endingPo?.basis);
    const short = g.unitsShort != null ? `~${f.qty(g.unitsShort)} short` : null;
    return {
      value: `${date(g.start)} → ${date(g.end)}`,
      note: [short, basis].filter(Boolean).join(" · ") || null,
      tone: "fail",
      title: `${f.today != null && g.start === f.today ? "Free stock is already short" : `Free stock runs out about ${date(g.start)}`}; ${g.endingPo?.number ? `PO ${g.endingPo.number}` : "the next delivery"} ends the gap ${date(g.end)} (${plural(g.days ?? 0, "day")}).`,
    };
  }
  if (status === "gap_open") {
    const today = f.today != null && g.start === f.today;
    return {
      value: today ? "From today" : `From ${date(g.start)}`,
      note: `end unknown (${openReasonText(g, rows)})`,
      tone: "fail",
      title: "Free stock runs out before any counted delivery. Overdue and late POs are not counted as arriving, so when this gap ends is not known.",
    };
  }
  if (status === "covered")
    return g.tight
      ? { value: "None before next delivery", note: "tight", tone: "warn", title: "The next delivery lands less than 2 weeks before free stock would run out." }
      : { value: "None before next delivery", note: null, tone: "", title: "Free stock lasts until the next counted delivery." };
  if (status === "nothing_on_order")
    return {
      value: "Nothing on order",
      note: g.runOut ? (f.today != null && g.runOut === f.today ? "already short" : `runs out ~${date(g.runOut)}`) : null,
      tone: "",
      title: "No purchase order is open for this item; Reorder now covers it.",
    };
  if (status === "no_demand") return { value: "No demand", note: null, tone: "", title: "No demand recorded, so nothing runs out." };
  if (status === "built_here")
    return { value: "Follows its components", note: null, tone: "", title: "Made here: its stock follows its components, so it has no timeline of its own." };
  return { value: "—", note: null, tone: "", title: "" };
}

/*
 * The Gap before delivery cell (Inventory and By item) as { text, sub, tone,
 * title }: two short lines at most, so fifteen columns still fit a laptop.
 *
 *   gap               "6.3w from 27 Oct", "~1,056 short"
 *   gap_open          "from today", "end unknown"
 *   covered + tight   "tight"
 *   everything else   "—", with what it is on hover
 *
 * `gap` and `status` are the item's (or a /cart line's) gap and gapStatus;
 * `position` that the item has a free-stock figure, so a missing gap means
 * gaps are unavailable rather than nothing to project from.
 */
export function gapCell(gap, status, { historical = false, present = true, position = false, ...opts } = {}) {
  const f = fmtOf(opts);
  const date = (iso) => shortDate(iso, f.today);
  const none = (title) => ({ text: "—", sub: null, tone: "", title });
  if (!present) return none("Stock gaps need a newer server.");
  if (historical) return none("Today only: MYOB keeps no history of open POs or their dates.");
  const s = status ?? gap?.status ?? null;
  if (!gap || !s) return none(position ? UNAVAILABLE : "No stock position to project from.");
  if (s === "gap") {
    const weeks = gap.days != null ? f.weeks(gap.days / 7) : null;
    const basis = gap.endingPo?.basis === "estimated" ? " (estimated)" : gap.endingPo?.basis === "promised" ? " (promised)" : "";
    const from = f.today != null && gap.start === f.today ? "today" : date(gap.start);
    return {
      text: `${weeks ? `${weeks} ` : ""}from ${from}`,
      sub: gap.unitsShort != null ? `~${f.qty(gap.unitsShort)} short` : null,
      tone: "fail",
      title: `${from === "today" ? "Short now" : `Runs out about ${date(gap.start)}`}; ${gap.endingPo?.number ? `PO ${gap.endingPo.number}` : "the next delivery"}${basis} ends it ${date(gap.end)}: ${plural(gap.days ?? 0, "day")}${gap.unitsShort != null ? `, ~${f.qty(gap.unitsShort)} units short` : ""}.`,
    };
  }
  if (s === "gap_open") {
    const today = f.today != null && gap.start === f.today;
    return {
      text: today ? "from today" : `from ${date(gap.start)}`,
      sub: "end unknown",
      tone: "fail",
      title: `Runs out ${today ? "now" : `about ${date(gap.start)}`} and no counted delivery brings it back: ${openReasonText(gap)}.`,
    };
  }
  if (s === "covered")
    return gap.tight
      ? { text: "tight", sub: null, tone: "warn", title: "Covered, but the next delivery lands less than 2 weeks before free stock would run out." }
      : none("None before next delivery: free stock lasts until it lands.");
  if (s === "nothing_on_order") return none("Nothing on order.");
  if (s === "no_demand") return none("No demand.");
  if (s === "built_here") return none("Made here: follows its components.");
  return none("");
}

/*
 * The plain-English sentence for the item page's outlook and the
 * drill-downs. `detail` is /items/:uid (its incomingSchedule names each PO's
 * basis; without it the sentence leaves those clauses out). Null for an item
 * with no gap fields or none to say (a past date).
 *
 * BN1665G (13 Oct): "Free stock (323) runs out about 27 Oct at 166.4 a
 * week. The next delivery, 2,000 on PO 00023070 (HANOVA INTERNATIONAL LTD),
 * is estimated for 10 Dec (raised 12 Aug + 120 days), about 6.3 weeks and
 * ~1,056 units short. With HANOVA INTERNATIONAL LTD's measured 83 days it
 * would land ~3 Nov. Cover incl. on order (14w) counts that delivery as
 * already here. An order placed with HANOVA INTERNATIONAL LTD today would
 * land about 10 Feb 2027."
 *
 * KITST1230S (13 Oct): "Free stock is already short by 425. The only PO,
 * 6,000 on 00022886, is 28 days overdue and isn't counted, so the end of
 * this gap is unknown."
 */
export function gapSentence(item, detail = null, opts = {}) {
  if (!hasGapFields(item)) return null;
  const g = item.gap ?? null;
  const status = item.gapStatus ?? g?.status ?? null;
  if (!g || !status) return null;
  const f = fmtOf({ today: detail?.incomingScheduleDate ?? null, ...opts });
  const date = (iso) => shortDate(iso, f.today);
  const rows = Array.isArray(detail?.incomingSchedule) ? detail.incomingSchedule : [];
  const free = f.qty(g.freeStock);
  const weekly = weeklyText(g.weekly);
  const rowOf = (po) => rows.find((r) => r && po && (r.poUid ?? r.number) === (po.poUid ?? po.number)) ?? null;
  const orderToday = () => {
    const days = item.leadTimeDays ?? null;
    if (days == null || f.today == null) return null;
    const lands = shortDate(addDays(f.today, days), f.today);
    // From 1.12 an item's own lead is its usual supplier's only (cart.ts
    // leadForSupplier), so say whose: a Purchasing row picked to Tong Ming
    // shows Tong Ming's 45 d beside this sentence's 107.
    if (item.leadTimeSource === "item")
      return `An order placed${item.supplierName ? ` with ${item.supplierName}` : ""} today would land about ${lands} (this item's own lead time, ${plural(days, "day")}).`;
    return item.supplierName ? `An order placed with ${item.supplierName} today would land about ${lands}.` : null;
  };

  if (status === "no_demand") return "No demand is recorded, so nothing runs out.";
  if (status === "built_here") return "Made here: its stock follows its components, so it has no outlook of its own.";
  const short = shortToday(item, g, f.today);
  if (status === "nothing_on_order")
    return short != null
      ? `Free stock is already short by ${f.qty(short)}, and nothing is on order.`
      : g.runOut
      ? `Free stock (${free}) runs out about ${date(g.runOut)} at ${weekly}, and nothing is on order.`
      : `Nothing is on order; free stock (${free}) lasts beyond 26 weeks at ${weekly}.`;
  if (status === "covered") {
    const next = item.nextDelivery ?? null;
    const lasts = g.freeRunOut ? `lasts to about ${date(g.freeRunOut)}` : "lasts beyond 26 weeks";
    if (!next) return `Free stock (${free}) ${lasts} at ${weekly}.`;
    const how = next.etaBasis === "promised" ? "promised" : "estimated";
    const tight = g.tight ? ", with under 2 weeks to spare" : "";
    // nextDelivery.qty is everything due that day; number is only the largest PO.
    const others = Number(next.poCount) > 1 ? ` and ${plural(next.poCount - 1, "other PO")}` : "";
    return `Free stock (${free}) ${lasts} at ${weekly}. The next delivery, ${f.qty(next.qty)} on PO ${next.number ?? "—"}${others}, is ${how} for ${date(next.eta)}${tight}.`;
  }

  // Today's shortfall up front; the gap's depth (unitsShort) is in "~N units short" below.
  const head =
    g.start === f.today && short != null
      ? `Free stock is already short by ${f.qty(short)}.`
      : `Free stock (${free}) runs out about ${date(g.start)} at ${weekly}.`;

  if (status === "gap") {
    const po = g.endingPo ?? null;
    const row = rowOf(po);
    const next = item.nextDelivery ?? null;
    const isNext = next && po && next.poUid === po.poUid && next.eta === po.eta;
    const who = po?.supplier ? ` (${po.supplier})` : "";
    const how =
      po?.basis === "promised"
        ? `is promised for ${date(po.eta)}`
        : `is estimated for ${date(po?.eta)}${row?.raised && row?.leadDays != null ? ` (raised ${date(row.raised)} + ${plural(row.leadDays, "day")})` : ""}`;
    // Under two weeks in days ("about 7 days"), else in the cover unit ("about 6.3 weeks").
    const span = g.days == null ? null : g.days < 14 ? plural(g.days, "day") : f.words(g.days / 7);
    const size = [span ? `about ${span}` : null, g.unitsShort != null ? `~${f.qty(g.unitsShort)} units short` : null]
      .filter(Boolean)
      .join(" and ");
    const parts = [
      head,
      `${isNext ? "The next delivery" : "The delivery that ends it"}, ${f.qty(po?.qty ?? 0)} on PO ${po?.number ?? "—"}${who}, ${how}${size ? `, ${size}` : ""}.`,
    ];
    if (po?.basis === "estimated" && row?.measuredDays != null && row?.measuredEta)
      parts.push(`With ${row.supplier ?? "the supplier"}'s measured ${plural(row.measuredDays, "day")} it would land ~${date(row.measuredEta)}.`);
    if (item.coverWeeksInclOnOrder != null)
      parts.push(`Cover incl. on order (${f.weeks(item.coverWeeksInclOnOrder)}) counts that delivery as already here.`);
    const order = orderToday();
    if (order) parts.push(order);
    return parts.join(" ");
  }

  // gap_open: what the end is waiting on.
  const off = offTimelinePos(rows);
  const allPos = new Set(rows.filter((r) => Number(r?.outstanding) > 0).map((r) => r.poUid ?? r.number));
  const tail = "so the end of this gap is unknown.";
  let why;
  const missed = off.filter((p) => p.status === "overdue" || p.status === "late");
  const stateOf = (p) =>
    p.status === "overdue" ? `${plural(p.daysLate ?? 0, "day")} overdue` : `${plural(p.daysLate ?? 0, "day")} late against its estimate`;
  if ((g.openReason === "overdue" || g.openReason === "late") && missed.length === 1) {
    const p = missed[0];
    why =
      allPos.size === 1
        ? `The only PO, ${f.qty(p.qty)} on ${p.number ?? "—"}, is ${stateOf(p)} and isn't counted, ${tail}`
        : `${f.qty(p.qty)} on PO ${p.number ?? "—"} is ${stateOf(p)} and isn't counted, ${tail}`;
  } else if ((g.openReason === "overdue" || g.openReason === "late") && missed.length > 1) {
    const units = missed.reduce((s, p) => s + p.qty, 0);
    why = `${missed.length} POs (${f.qty(units)} units: ${missed.map((p) => `${p.number ?? "—"} ${stateOf(p)}`).join("; ")}) aren't counted, ${tail}`;
  } else if (g.openReason === "overdue" || g.openReason === "late") {
    why = `A PO is ${g.openReason === "overdue" ? "overdue" : "late against its estimate"} and isn't counted, ${tail}`;
  } else if (g.openReason === "no_date") {
    const p = off.find((x) => x.status === "undated");
    why = p
      ? `${f.qty(p.qty)} on PO ${p.number ?? "—"} has no date (no lead time for ${p.supplier ?? "its supplier"}) and isn't counted, ${tail}`
      : `A PO has no date and isn't counted, ${tail}`;
  } else if (g.openReason === "after_26_weeks") {
    why = `The next dated delivery is more than 26 weeks away, ${tail}`;
  } else {
    why = `The deliveries dated in the next 26 weeks aren't enough to bring free stock back above zero, ${tail}`;
  }
  const parts = [head, why];
  const order = orderToday();
  if (order) parts.push(order);
  return parts.join(" ");
}

/** yyyy-mm-dd plus whole days, for "an order placed today would land about". */
function addDays(iso, days) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + Math.round(Number(days)) * 86_400_000).toISOString().slice(0, 10);
}

/*
 * The Stock outlook strip's model: the server's weekly series as drawn,
 * with each week marked in the gap or not, its arrivals (solid when
 * promised, hollow when estimated), and the POs that aren't on it (overdue,
 * late, undated), listed beside it rather than placed on it. Null when there
 * is nothing to draw: no series (no demand, built here, no position, a
 * server before 1.11) or a past date.
 *
 *   weeks   [{ start, label, low, close, inGap, arrivals, title }]
 *   top     the top of the scale, never below 1: with a gap, free stock
 *           today or the gap's depth if more (a bar above it is clipped),
 *           else the largest value
 *   gapScale  whether top was set that way
 *   bottom  the lowest (≤ 0)
 *   off     [{ number, supplier, qty, status, text }]
 */
export function outlookModel(item, detail = null, opts = {}) {
  const g = item?.gap ?? null;
  if (!hasGapFields(item) || !Array.isArray(g?.weeks) || !g.weeks.length) return null;
  const f = fmtOf({ today: detail?.incomingScheduleDate ?? null, ...opts });
  const date = (iso) => shortDate(iso, f.today);
  const gapEnd = g.end ?? g.horizon ?? null;
  const weeks = g.weeks.map((w) => {
    const last = addDays(w.start, (w.days ?? 7) - 1);
    const inGap = runsOut(g.status) && g.start != null && g.start <= last && (gapEnd == null || w.start <= gapEnd);
    const arrivals = (w.arrivals ?? []).map((a) => ({
      number: a.number ?? null,
      supplier: a.supplier ?? null,
      qty: a.qty,
      eta: a.eta,
      basis: a.basis,
      solid: a.basis === "promised",
    }));
    const arriving = arrivals.map((a) => `${f.qty(a.qty)} on ${a.number ?? "a PO"} ${a.basis === "promised" ? "promised" : "estimated"} ${date(a.eta)}`);
    return {
      start: w.start,
      label: date(w.start),
      low: w.low,
      close: w.close,
      inGap,
      arrivals,
      title: `Week of ${date(w.start)}: lowest ${f.qty(w.low)}, ends at ${f.qty(w.close)}${arriving.length ? `; arriving ${arriving.join(", ")}` : ""}${inGap ? " · in the gap" : ""}`,
    };
  });
  const values = weeks.flatMap((w) => [w.low, w.close]);
  // With a gap, its depth is what the strip is for, so the top of the scale
  // is free stock today and the lows up to the gap's end, not the stock once
  // a delivery lands: SPW12G's 15,000 on 00023070 (13 Oct) set the top and
  // left its 555 shortfall 3 px of 90. The delivery week's bar is clipped,
  // but may stand as tall as the shortfall is deep, so stock already short
  // today (BN12150LTG, −893) still shows its delivery as more than a sliver.
  const gapScale = runsOut(g.status);
  const upTo = weeks.filter((w) => gapEnd == null || w.start <= gapEnd).map((w) => w.low);
  const deepest = -Math.min(0, ...values);
  const top = gapScale
    ? Math.max(1, Number(g.freeStock) || 0, ...upTo, Math.min(Math.max(...values), deepest))
    : Math.max(1, ...values);
  const off = offTimelinePos(detail?.incomingSchedule).map((p) => ({
    ...p,
    text:
      p.status === "overdue"
        ? `overdue ${plural(p.daysLate ?? 0, "day")}`
        : p.status === "late"
          ? `late against estimate by ${plural(p.daysLate ?? 0, "day")}`
          : "no date",
  }));
  return {
    weeks,
    top,
    gapScale,
    bottom: Math.min(0, ...values),
    minLevel: g.minLevel ?? null,
    off,
  };
}
