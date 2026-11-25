/**
 * What a supplier last charged for an item: the cart's lastCost (1.18).
 *
 * The unit price on the supplier's latest bill line for the item. Before 1.18
 * the cart asked Postgres for "the latest bill date" and nothing more
 * (DISTINCT ON (item, supplier) ... ORDER BY date DESC). When that date had
 * two lines at different prices it got whichever came first on disk. On
 * 25 Nov 2026, PWST15010T from Universal Corrosion Coatings read 25.34375 on
 * production and 25.33 on an identical copy: bill 00023195 (12 Oct 2026) has
 * one line at each. 11 item/supplier pairs had such a tie.
 *
 * From 1.18 the latest line is always the same line:
 *   1. the latest bill date;
 *   2. on that date, a line that bought something (qty above 0) before one
 *      that did not: a zero-quantity line charged nothing at its price;
 *   3. then the later bill: the higher bill number (MYOB numbers bills in
 *      sequence);
 *   4. then the later line on that bill;
 *   5. then the bill uid, so no two lines can ever tie (bill uid and line
 *      index are a bill line's primary key).
 * Only lines priced above 0 count, as before (the query filters them). Steps 2
 * to 5 only ever choose between lines on the same latest date. A pair whose
 * lines on that date share one price reads exactly as before, and so does a
 * pair whose only line on that date bought nothing.
 *
 * It is a pure function, rather than a longer ORDER BY, so that the rule is
 * tested: `npm test` runs with no database.
 */

/** One priced bill line, as the cart's query returns it. */
export interface BillLineCost {
  itemUid: string;
  supplierUid: string;
  unitPrice: number;
  qty: number | null;
  /** The bill's date. An undated bill ranks below every dated one. */
  date: Date | string | null;
  billNumber: string | null;
  billUid: string;
  /** The line's position on its bill (myob_purchase_bill_lines.idx). */
  idx: number;
}

/** The cart's key for an item under one supplier. */
export function lastCostKey(itemUid: string, supplierUid: string): string {
  return `${itemUid}|${supplierUid}`;
}

function when(d: BillLineCost["date"]): number {
  if (d == null) return -Infinity;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

/** Bill numbers by their digits where they are digits ("999" before "1000"). */
function byNumber(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a.localeCompare(b, "en", { numeric: true });
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Above 0 when line a is later than line b under the rule above. */
export function compareBillLines(a: BillLineCost, b: BillLineCost): number {
  const date = when(a.date) - when(b.date);
  if (date) return date;
  const bought = Number((a.qty ?? 0) > 0) - Number((b.qty ?? 0) > 0);
  if (bought) return bought;
  return byNumber(a.billNumber, b.billNumber) || a.idx - b.idx || byText(a.billUid, b.billUid);
}

/** Each item/supplier pair's last cost, keyed by lastCostKey. */
export function pickLastCosts(lines: Iterable<BillLineCost>): Map<string, number> {
  const latest = new Map<string, BillLineCost>();
  for (const line of lines) {
    const key = lastCostKey(line.itemUid, line.supplierUid);
    const held = latest.get(key);
    if (!held || compareBillLines(line, held) > 0) latest.set(key, line);
  }
  return new Map([...latest].map(([key, line]) => [key, line.unitPrice]));
}

/**
 * The query pickLastCosts reads: every priced line of every bill with a
 * supplier, for the items in $1.
 */
export const LAST_COST_LINES_SQL = `
  SELECT l.item_uid, b.supplier_uid, l.unit_price, l.qty, b.date, b.number, b.uid AS bill_uid, l.idx
  FROM myob_purchase_bill_lines l
  JOIN myob_purchase_bills b ON b.uid = l.bill_uid
  WHERE l.item_uid = ANY($1) AND b.supplier_uid IS NOT NULL AND l.unit_price > 0`;

/** A row of LAST_COST_LINES_SQL as a BillLineCost. */
export function billLineCost(r: Record<string, unknown>): BillLineCost {
  return {
    itemUid: String(r.item_uid),
    supplierUid: String(r.supplier_uid),
    unitPrice: Number(r.unit_price),
    qty: r.qty == null ? null : Number(r.qty),
    date: (r.date as Date | string | null) ?? null,
    billNumber: r.number == null ? null : String(r.number),
    billUid: String(r.bill_uid),
    idx: Number(r.idx),
  };
}
