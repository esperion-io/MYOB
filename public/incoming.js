/*
 * The words for when stock on order is expected (1.9).
 *
 * The server works out every date, status and day count (src/insights/
 * incoming.ts): the Promised Date where MYOB has one on or after the PO date,
 * otherwise the PO date plus that PO's supplier's lead time, labelled as an
 * estimate. This module only turns those fields into the text the item page,
 * the expand panel, the Purchasing drill-down and Data & Sync show, so the
 * four can't word one PO two ways. Allied decided on 12 Oct 2026 to enter
 * ETAs as Promised Dates in MYOB, so an estimate always says the ETA is
 * missing, and never reads as promised.
 *
 * Kept apart from dashboard.js, like order-list.js, so test/incoming.test.ts
 * can import it: nothing here touches the DOM. Every field is read with
 * `?? null`, and a row with no `etaBasis` (a past date, or a server before
 * 1.9) gets "—" rather than a guess.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15 Sep", with the year only when it isn't today's year ("16 Apr 2025"). */
export function shortDate(iso, today = null) {
  if (!iso) return "—";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return "—";
  const sameYear = today != null && String(today).slice(0, 4) === String(y);
  return `${d} ${MONTHS[m - 1]}${today == null || sameYear ? "" : ` ${y}`}`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The Expected cell: "1 Nov" when promised, "~10 Dec" when estimated, "—" with no date. */
export function expectedText(row, today = null) {
  const eta = row?.eta ?? null;
  if (eta == null) return "—";
  return row.etaBasis === "estimated" ? `~${shortDate(eta, today)}` : shortDate(eta, today);
}

/** Whose lead an estimate is built on, as the Basis cell says it. */
function leadOwnerText(row) {
  const who = row?.supplier ?? "the supplier";
  if (row?.leadSource === "allied") return `${who} lead set by Allied`;
  const n = row?.leadOrders ?? 0;
  return `${who}, measured over ${plural(n, "order")}`;
}

/**
 * The Basis cell.
 *   promised:  "Promised in MYOB"
 *   estimated: "ETA missing — estimated: raised 12 Aug + 120 days (HANOVA
 *              INTERNATIONAL LTD lead set by Allied) · measured 83 days would
 *              give ~3 Nov"
 *   none:      "No date: no lead time for TANDL; set one under Suppliers"
 * An ignored Promised Date (earlier than the PO date) is said first, so the
 * estimate beside it is never taken for the date MYOB holds.
 */
export function basisText(row, today = null) {
  const basis = row?.etaBasis ?? null;
  if (basis == null) return "—";
  const ignored = row.promisedIgnored ? "Promised date earlier than PO date (ignored) · " : "";
  if (basis === "promised") return "Promised in MYOB";
  if (basis === "estimated") {
    const measured =
      row.measuredDays != null && row.measuredEta != null
        ? ` · measured ${plural(row.measuredDays, "day")} would give ~${shortDate(row.measuredEta, today)}`
        : "";
    return `${ignored}ETA missing — estimated: raised ${shortDate(row.raised, today)} + ${plural(row.leadDays, "day")} (${leadOwnerText(row)})${measured}`;
  }
  return `${ignored}No date: no lead time for ${row.supplier ?? "this supplier"}; set one under Suppliers`;
}

/**
 * The Status cell as { text, tone } (tone is a badge class):
 *   due      "Due in 58 days" (ok), "Due today"
 *   overdue  "Overdue 28 days: promised 15 Sep, nothing received" (fail, red)
 *   late     "Late against estimate by 13 days" (warn, amber)
 *   undated  "No date" (idle)
 * A part-received overdue line says what is still to come instead of
 * "nothing received"; a row with no `received` (a whole document) says
 * neither.
 */
export function statusModel(row, today = null, qty = (v) => Number(v).toLocaleString()) {
  const status = row?.status ?? null;
  if (status === "due") {
    const n = row.daysToGo ?? 0;
    return { text: n === 0 ? "Due today" : `Due in ${plural(n, "day")}`, tone: "ok" };
  }
  if (status === "overdue") {
    // A line knows what it has received; a whole document (Data & Sync)
    // doesn't say, so it gets no clause rather than a guess.
    const got =
      row.received == null
        ? ""
        : row.received > 0
          ? `, ${qty(row.outstanding)} of ${qty(row.ordered)} still to come`
          : ", nothing received";
    return { text: `Overdue ${plural(row.daysLate ?? 0, "day")}: promised ${shortDate(row.eta, today)}${got}`, tone: "fail" };
  }
  if (status === "late") return { text: `Late against estimate by ${plural(row.daysLate ?? 0, "day")}`, tone: "warn" };
  if (status === "undated") return { text: "No date", tone: "idle" };
  return { text: "—", tone: "idle" };
}

/**
 * The note under On order: what is overdue or late, then the next date to
 * come. "1 PO overdue", "next ~10 Dec (est.)", "next 1 Nov (promised)", or
 * both joined by " · ". Null with nothing to say (nothing on order, a past
 * date, a server before 1.9). tone is "fail" when anything is overdue,
 * "warn" when late against an estimate.
 */
export function nextDeliveryNote(summary, today = null) {
  if (!summary || !(summary.total > 0)) return null;
  const parts = [];
  if (summary.overduePos > 0) parts.push(`${plural(summary.overduePos, "PO")} overdue`);
  if (summary.latePos > 0) parts.push(`${plural(summary.latePos, "PO")} late against estimate`);
  const next = summary.next ?? null;
  if (next?.eta)
    parts.push(
      next.etaBasis === "promised"
        ? `next ${shortDate(next.eta, today)} (promised)`
        : `next ~${shortDate(next.eta, today)} (est.)`,
    );
  if (!parts.length && summary.undatedPos > 0) parts.push(`${plural(summary.undatedPos, "PO")} with no date`);
  if (!parts.length) return null;
  return { text: parts.join(" · "), tone: summary.overduePos > 0 ? "fail" : summary.latePos > 0 ? "warn" : "" };
}

/**
 * How Promised Dates have held up, once under the list rather than on every
 * promised row: "Promised dates have run a median ~5 days late; 7 of 20 were
 * over 2 weeks late." Null with no history to go on.
 */
export function promisedHistoryText(h) {
  if (!h || !(h.orders > 0) || h.medianDaysLate == null) return null;
  const m = Math.round(h.medianDaysLate);
  const median =
    m > 0 ? `a median ~${plural(m, "day")} late` : m < 0 ? `a median ~${plural(-m, "day")} early` : "on time at the median";
  return `Promised dates have run ${median}; ${h.overTwoWeeks} of ${h.orders} were over 2 weeks late.`;
}

export const PROMISED_FOOTNOTE =
  "Enter a Promised Date on the PO in MYOB to replace an estimate (picked up within 6 hours).";

/**
 * Data & Sync's "Needs an ETA" line, from /divergence openDocs: the counted
 * documents with something still to arrive, and how many of them have no
 * Promised Date MYOB will use (none, or one earlier than the PO date).
 * Null against a server before 1.9 (no `expected` on any document).
 */
export function promisedDateGaps(docs) {
  if (!Array.isArray(docs) || !docs.some((d) => d && "expected" in d)) return null;
  const open = docs.filter((d) => d?.expected != null);
  const missing = open.filter((d) => d.expected.etaBasis !== "promised");
  return {
    total: open.length,
    missing: missing.length,
    ignored: missing.filter((d) => d.expected.promisedIgnored).length,
    numbers: missing.map((d) => d.number).filter(Boolean),
  };
}

/** The line itself: "13 of 16 open POs have no Promised Date — enter one in MYOB." */
export function promisedDateGapsText(g) {
  if (!g || !g.total) return null;
  if (!g.missing) return `All ${plural(g.total, "open PO")} have a Promised Date in MYOB.`;
  const ignored = g.ignored ? ` (${g.ignored} ${g.ignored === 1 ? "has one" : "have one"} earlier than its PO date, which is ignored)` : "";
  return `${g.missing} of ${plural(g.total, "open PO")} ${g.missing === 1 ? "has" : "have"} no Promised Date${ignored} — enter one in MYOB.`;
}
