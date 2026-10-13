import { businessToday } from "./businessDate.js";
import { getPool } from "../db.js";
import { OPEN_PO_DOC, OUTSTANDING, OUTSTANDING_LINE } from "../sync/openPo.js";
import { supplierLeadTimes, type SupplierLead } from "./leadTimes.js";

/**
 * When the stock on order is expected (1.9): Allied's request #2, part 1.
 *
 * MYOB has one date that says when a purchase order should arrive, the PO
 * header's Promised Date, and no date at all on a line. Allied decided on
 * 12 Oct 2026 to enter their ETAs there, so the Promised Date is the expected
 * date. Until a PO has one, it gets an estimate, labelled as such and never
 * passed off as promised: the PO date plus that PO's supplier's lead time.
 * On the 26 Aug copy 3 of the 16 counted open POs carry a Promised Date
 * (00022886 and 00023063, Tong Ming; 00023060, Hanova), 133,979 of the
 * 858,796 units on order; the other 13 are estimates, and listing them on
 * Data & Sync is how Allied find the ones still to date.
 *
 * THE RULE, worked out once per PO DOCUMENT, never per line:
 *
 *   1. Promised: the Promised Date, when it is on or after the PO date. An
 *      earlier one is ignored and said so. On the copy 6 converted POs carry
 *      one, every one a same-day pair whose PO date was moved to the bill
 *      date at conversion, so the date is real but the PO date is not; on an
 *      open PO it can only be a typing slip.
 *   2. Estimated: PO date + the PO's own supplier's lead time, Allied's
 *      figure on the Suppliers page if set, else the measured median
 *      (leadTimes.ts, the figure the cart shows). Neither: no date.
 *   3. A date that has passed with stock still outstanding is Overdue
 *      (promised) or Late against estimate (estimated). It stays on its
 *      date: the line is never placed in the past as if it had arrived, and
 *      never moved to "today + something", which would invent a date.
 *
 * A LEAD TIME SET ON AN ITEM NEVER MOVES AN ETA. One document arrives once.
 * On prod WR16503G and WR16301.5S16 carry 107 days against Hanova's 120, so a
 * per-line rule would give 00023070 two arrival dates, 27 Nov and 10 Dec.
 * The item lead stays what it was, a planning input for the suggestion, the
 * minimum and the cart (which, from 1.12, shows it only under the item's
 * usual supplier: cart.ts leadForSupplier).
 *
 * NOTHING HERE FEEDS A CALCULATION. On order, cover, suggestions, flags, the
 * cart and the daily rows are exactly what they were; this only says when.
 * The rows come from the same fragments On order is built from (openPo.ts),
 * so per item they add up to On order exactly: on the copy 150 lines (149
 * document–item pairs: 00023096 has BN16525LTG on two lines) over 125
 * items, Σ 858,796.
 *
 * Today only. MYOB overwrites Promised Date, status and received quantities
 * in place and keeps no history of them, so there is no way to say what was
 * expected on a past date; at a past as-at itemDetail serves the rows
 * without dates (FEEDBACK-PLAN §4.7).
 */

export type EtaBasis = "promised" | "estimated" | "none";
export type EtaStatus = "due" | "overdue" | "late" | "undated";

/** Allied's lead differing from the measured one by more than this gets both dates. */
export const MEASURED_DIFFERS_DAYS = 14;

/** The expected date of one PO document, and everything its basis text needs. */
export interface PoEta {
  /** The expected date (yyyy-mm-dd), or null when there is none. */
  eta: string | null;
  etaBasis: EtaBasis;
  /** The Promised Date as MYOB holds it, ignored or not. */
  promisedDate: string | null;
  /** A Promised Date earlier than the PO date, ignored. */
  promisedIgnored: boolean;
  /** The lead time (whole days) an estimate is built on. */
  leadDays: number | null;
  /** Whose that lead is: Allied's figure on the Suppliers page, or measured. */
  leadSource: "allied" | "measured" | null;
  /** Orders the measured median is built on. */
  leadOrders: number;
  /** The measured median, when it differs from Allied's lead by > 14 days. */
  measuredDays: number | null;
  /** The date that measured lead would give. */
  measuredEta: string | null;
  status: EtaStatus;
  /** Days past the date, overdue or late; null otherwise. */
  daysLate: number | null;
  /** Days until the date (0 = today), when due; null otherwise. */
  daysToGo: number | null;
}

const DAY_MS = 86_400_000;

function utc(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** yyyy-mm-dd plus whole days. */
export function addDays(iso: string, days: number): string {
  return new Date(utc(iso) + Math.round(days) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((utc(b) - utc(a)) / DAY_MS);
}

/**
 * The ETA rule for one document (pure). `lead` is its own supplier's,
 * from supplierLeadTimes; `today` is the business date.
 */
export function poEta(
  doc: { poDate: string | null; promisedDate: string | null; lead: SupplierLead | null | undefined },
  today: string,
): PoEta {
  const promised = doc.promisedDate?.slice(0, 10) ?? null;
  const raised = doc.poDate?.slice(0, 10) ?? null;
  const promisedIgnored = promised != null && raised != null && promised < raised;
  const out: PoEta = {
    eta: null,
    etaBasis: "none",
    promisedDate: promised,
    promisedIgnored,
    leadDays: null,
    leadSource: null,
    leadOrders: doc.lead?.orders ?? 0,
    measuredDays: null,
    measuredEta: null,
    status: "undated",
    daysLate: null,
    daysToGo: null,
  };
  if (promised != null && !promisedIgnored) {
    out.eta = promised;
    out.etaBasis = "promised";
  } else if (raised != null && doc.lead?.days != null) {
    const lead = doc.lead;
    out.leadDays = Math.round(lead.days as number);
    out.leadSource = lead.setByAllied ? "allied" : "measured";
    out.eta = addDays(raised, out.leadDays);
    out.etaBasis = "estimated";
    // Allied's 120 days for Hanova against 83 measured moves 00023070 from
    // ~3 Nov to ~10 Dec, so where the two disagree by more than two weeks
    // both dates are shown and Allied can judge which is real.
    if (
      lead.setByAllied &&
      lead.measuredDays != null &&
      Math.abs(out.leadDays - Math.round(lead.measuredDays)) > MEASURED_DIFFERS_DAYS
    ) {
      out.measuredDays = Math.round(lead.measuredDays);
      out.measuredEta = addDays(raised, out.measuredDays);
    }
  }
  if (out.eta != null) {
    const ahead = daysBetween(today, out.eta);
    if (ahead >= 0) {
      out.status = "due";
      out.daysToGo = ahead;
    } else {
      out.status = out.etaBasis === "promised" ? "overdue" : "late";
      out.daysLate = -ahead;
    }
  }
  return out;
}

/** One open PO line with something still to arrive, and its document's ETA. */
export interface ScheduleRow extends PoEta {
  poUid: string;
  number: string | null;
  supplierUid: string | null;
  supplier: string | null;
  itemUid: string;
  /** MYOB's line number, so two lines of one item on one PO stay apart. */
  line: number;
  /** The PO date. */
  raised: string | null;
  ordered: number;
  /** Received, clamped as OUTSTANDING clamps it (ordered − outstanding). */
  received: number;
  /** Still to arrive: what On order counts for this line. */
  outstanding: number;
}

/** A line as facts only, with no date or status: what a past date is served. */
export type ScheduleFacts = Pick<
  ScheduleRow,
  "poUid" | "number" | "supplierUid" | "supplier" | "itemUid" | "line" | "raised" | "promisedDate" | "ordered" | "received" | "outstanding"
>;

export function scheduleFacts(r: ScheduleRow): ScheduleFacts {
  const { poUid, number, supplierUid, supplier, itemUid, line, raised, promisedDate, ordered, received, outstanding } = r;
  return { poUid, number, supplierUid, supplier, itemUid, line, raised, promisedDate, ordered, received, outstanding };
}

const STATUS_RANK: Record<EtaStatus, number> = { overdue: 0, late: 0, due: 1, undated: 2 };

/**
 * The order the panel lists lines in: overdue and late first (longest past
 * its date first), then by expected date, then the undated ones by PO date;
 * within a date by PO number, then MYOB's line order.
 */
export function scheduleOrder(a: ScheduleRow, b: ScheduleRow): number {
  return (
    STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
    String(a.eta ?? a.raised ?? "").localeCompare(String(b.eta ?? b.raised ?? "")) ||
    String(a.number ?? "").localeCompare(String(b.number ?? "")) ||
    a.line - b.line
  );
}

/**
 * One item's schedule in units: dated (due), overdue, late and undated add up
 * to total, which is On order. `next` is the soonest date still to come;
 * the PO counts are documents, for "1 PO overdue".
 */
export interface IncomingSummary {
  dated: number;
  overdue: number;
  late: number;
  undated: number;
  total: number;
  overduePos: number;
  latePos: number;
  undatedPos: number;
  next: { eta: string; etaBasis: EtaBasis; number: string | null } | null;
}

export function summariseSchedule(rows: ScheduleRow[]): IncomingSummary {
  const s: IncomingSummary = {
    dated: 0, overdue: 0, late: 0, undated: 0, total: 0,
    overduePos: 0, latePos: 0, undatedPos: 0, next: null,
  };
  const pos = { overdue: new Set<string>(), late: new Set<string>(), undated: new Set<string>() };
  for (const r of rows) {
    s.total += r.outstanding;
    if (r.status === "due") {
      s.dated += r.outstanding;
      if (r.eta != null && (s.next == null || r.eta < s.next.eta))
        s.next = { eta: r.eta, etaBasis: r.etaBasis, number: r.number };
    } else {
      s[r.status] += r.outstanding;
      pos[r.status].add(r.poUid);
    }
  }
  s.overduePos = pos.overdue.size;
  s.latePos = pos.late.size;
  s.undatedPos = pos.undated.size;
  return s;
}

/**
 * Every counted open PO line with something to arrive, for the given items
 * (all items when omitted), in the panel's order. Today's: the documents are
 * the ones open now, whatever date is on screen.
 */
export async function openPoSchedule(
  itemUids?: string[],
  today: string = businessToday(),
): Promise<ScheduleRow[]> {
  const pool = getPool();
  const [lines, leads] = await Promise.all([
    pool.query(
      `SELECT o.uid AS po_uid, o.number, o.supplier_uid, o.supplier_name,
              o.date::date::text AS po_date, o.promised_date::date::text AS promised_date,
              l.item_uid, l.idx, l.qty::float8 AS ordered,
              ${OUTSTANDING("l")}::float8 AS outstanding
       FROM myob_purchase_order_lines l JOIN myob_purchase_orders o ON o.uid = l.order_uid
       WHERE ${OPEN_PO_DOC("o")} AND ${OUTSTANDING_LINE("l")} AND ${OUTSTANDING("l")} > 0
         ${itemUids ? "AND l.item_uid = ANY($1)" : ""}`,
      itemUids ? [itemUids] : [],
    ),
    supplierLeadTimes(pool),
  ]);
  // Once per document: every line of a PO shares its date.
  const etas = new Map<string, PoEta>();
  const rows: ScheduleRow[] = lines.rows.map((x) => {
    const poUid = x.po_uid as string;
    let eta = etas.get(poUid);
    if (!eta) {
      eta = poEta(
        {
          poDate: x.po_date as string | null,
          promisedDate: x.promised_date as string | null,
          lead: x.supplier_uid ? leads.get(x.supplier_uid as string) : null,
        },
        today,
      );
      etas.set(poUid, eta);
    }
    return {
      ...eta,
      poUid,
      number: x.number as string | null,
      supplierUid: x.supplier_uid as string | null,
      supplier: x.supplier_name as string | null,
      itemUid: x.item_uid as string,
      line: Number(x.idx),
      raised: x.po_date as string | null,
      ordered: Number(x.ordered),
      received: Number(x.ordered) - Number(x.outstanding),
      outstanding: Number(x.outstanding),
    };
  });
  return rows.sort(scheduleOrder);
}

/**
 * The expected date of each counted open PO document, by PO uid, for the
 * Open purchase orders list on Data & Sync: the same rule and the same leads
 * as the item page, so the two can't disagree about a PO.
 */
export async function openPoEtas(today: string = businessToday()): Promise<Map<string, PoEta>> {
  const pool = getPool();
  const [docs, leads] = await Promise.all([
    pool.query(
      `SELECT o.uid, o.supplier_uid, o.date::date::text AS po_date,
              o.promised_date::date::text AS promised_date
       FROM myob_purchase_orders o
       WHERE ${OPEN_PO_DOC("o")}`,
    ),
    supplierLeadTimes(pool),
  ]);
  return new Map(
    docs.rows.map((x) => [
      x.uid as string,
      poEta(
        {
          poDate: x.po_date as string | null,
          promisedDate: x.promised_date as string | null,
          lead: x.supplier_uid ? leads.get(x.supplier_uid as string) : null,
        },
        today,
      ),
    ]),
  );
}

/**
 * How Promised Dates have held up, for the "Promised in MYOB" hint: every
 * PO that had one (after its PO date) and has since been billed, the bill
 * standing in for arrival as it does in supplier_lead_time. A bill on the PO
 * date is left out for the same reason it is there: the PO date was moved to
 * the bill date at conversion. On the 26 Aug copy that is 20 POs, a median of
 * 4.5 days late (mean 14), 7 more than two weeks late and 4 on time or early.
 */
export interface PromisedHistory {
  orders: number;
  medianDaysLate: number | null;
  overTwoWeeks: number;
}

export async function promisedHistory(): Promise<PromisedHistory> {
  const r = await getPool().query(
    `WITH p AS (
       SELECT (b.date::date - o.promised_date::date) AS late
       FROM myob_purchase_orders o
       JOIN myob_purchase_bills b
         ON b.number = o.number AND b.supplier_uid = o.supplier_uid AND b.date::date > o.date::date
       WHERE o.promised_date IS NOT NULL AND o.promised_date::date > o.date::date
     )
     SELECT COUNT(*)::int AS orders,
            (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY late))::float8 AS median_late,
            COUNT(*) FILTER (WHERE late > 14)::int AS over_two_weeks
     FROM p`,
  );
  const x = r.rows[0] ?? {};
  return {
    orders: Number(x.orders ?? 0),
    medianDaysLate: x.median_late == null ? null : Number(x.median_late),
    overTwoWeeks: Number(x.over_two_weeks ?? 0),
  };
}
