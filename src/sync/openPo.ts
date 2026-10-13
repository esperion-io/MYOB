/**
 * Which purchase orders count as stock on order, and how much of each line
 * is still to arrive (1.1; the rule On order follows from 1.2).
 *
 * Before 1.2 five places read open POs, each with its own copy of one rule:
 * every line of every document MYOB calls Open, ordered minus received. That rule
 * counts MYOB's reversal artefacts. When a PO is converted to a bill and then
 * reversed, MYOB leaves an Open twin behind, sometimes a negative one, and on
 * the 26 Aug copy those twins add 194,147 units nobody is waiting for: our On
 * order reads 1,052,943 against MYOB's own 858,820. WSBT450G alone shows
 * 112,897 on order where MYOB shows none.
 *
 * The rule here reproduces MYOB to 24 units (858,796), and the 24 are known
 * (KNOWN_PRE_FLOOR below):
 *
 *   a document counts when it is Open, its total is not negative, and no bill
 *   with the same number from the same supplier is dated on or after it;
 *   a line counts what is still to receive, never less than nothing and never
 *   more than was ordered.
 *
 * The bill test is what drops a billed PO's twin. 1,163 of the 1,275 POs MYOB
 * converted to a bill share their number with that bill, no number has two
 * bills, and no bill predates its PO. The date bound keeps an older bill that
 * happens to share a number from cancelling a new order.
 *
 * In 1.1 these fragments were used only by the comparison on Data & Sync and
 * the end-of-sync check, so the rule could be previewed on production before
 * any figure moved. From 1.2 all five readers use them: item_position_at and
 * ownedPositions (On order), the item page's PO rows, the Suppliers open-PO
 * count and the Overview region table. test/open-po-rule.test.ts fails the
 * build if a sixth reader tests status 'OPEN' without OPEN_PO_DOC. The SQL is
 * shared as text rather than as a view or function: a function body changes
 * at boot, before the code that reads it has been proven, and a fragment
 * ships and reverts with the code. (item_position_at is itself a function,
 * so its body still changes at boot; it is built from these same fragments.)
 */

/** A table alias, checked so a fragment can never be handed anything else. */
function alias(a: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(a)) throw new Error(`Not a SQL alias: ${a}`);
  return a;
}

/**
 * A bill with the same number from the same supplier is dated on or after the
 * document `o`: the bill test, in one copy. OPEN_PO_DOC uses it negated, and
 * the Open purchase orders list uses it for its "billed" reason, so the
 * Counted column and the reason beside it cannot drift apart.
 */
export function PO_BILLED_ON_OR_AFTER(o: string): string {
  const d = alias(o);
  return `EXISTS (SELECT 1 FROM myob_purchase_bills open_po_bill
                    WHERE open_po_bill.number = ${d}.number
                      AND open_po_bill.supplier_uid = ${d}.supplier_uid
                      AND open_po_bill.date::date >= ${d}.date::date)`;
}

/** The document `o` (a myob_purchase_orders row) counts as stock on order. */
export function OPEN_PO_DOC(o: string): string {
  const d = alias(o);
  return `(UPPER(COALESCE(${d}.status, '')) = 'OPEN'
    AND COALESCE(${d}.total, 0) >= 0
    AND NOT ${PO_BILLED_ON_OR_AFTER(d)})`;
}

/** The line `l` can carry stock on order at all. Pair with OUTSTANDING. */
export function OUTSTANDING_LINE(l: string): string {
  const d = alias(l);
  return `(${d}.item_uid IS NOT NULL AND ${d}.qty > 0)`;
}

/**
 * What line `l` still has to arrive: ordered minus received, with received
 * clamped to 0..ordered. Only meaningful under OUTSTANDING_LINE. No open PO
 * with a total of zero or more has a negative or over-received line today, so
 * the clamp changes nothing now; it stops one bad line from going negative or
 * cancelling another line's stock later.
 */
export function OUTSTANDING(l: string): string {
  const d = alias(l);
  return `(${d}.qty - LEAST(GREATEST(COALESCE(${d}.received_qty, 0), 0), ${d}.qty))`;
}

/*
 * Items whose MYOB on-order figure comes from a PO raised before the sync
 * floor (1 Jul 2024), which this platform never fetched. MYOB shows 12 on
 * order for each; we show 0, and so does the proposed rule. Whether that PO is
 * real is on the MYOB tidy-up list sent to Allied: if it is, the fix is to the
 * sync and these come off this list; if it is not, Allied close it in MYOB and
 * they come off by themselves.
 */
export const KNOWN_PRE_FLOOR: readonly string[] = ["AFLSA390", "AFLSA490"];

const TOLERANCE = 0.001;

export interface OnOrderCompareRow {
  uid: string;
  number: string | null;
  name: string | null;
  /** Our On order today, under the rule Allied see. */
  ours: number;
  /** MYOB's item-master figure. Null where MYOB sent none. */
  myob: number | null;
  /** What the rule in this file gives. */
  proposed: number;
}

export interface OnOrderCheckRow extends OnOrderCompareRow {
  /** The proposed rule lands on MYOB's figure. */
  proposedMatchesMyob: boolean;
  /** Why a remaining difference is expected, or null. */
  known: string | null;
}

/**
 * The "On order vs MYOB" list: every item where our figure or the proposed
 * one differs from MYOB's. Rows where only the proposed figure differs are
 * kept on purpose: those are the items Stage 2 would get wrong, and the
 * preview exists to find them before it ships.
 */
export function onOrderCheck(
  rows: OnOrderCompareRow[],
  known: readonly string[] = KNOWN_PRE_FLOOR,
): { rows: OnOrderCheckRow[]; diverging: number } {
  const out = rows
    .filter(
      (r) =>
        Math.abs(r.ours - (r.myob ?? 0)) > TOLERANCE ||
        Math.abs(r.proposed - (r.myob ?? 0)) > TOLERANCE,
    )
    .map((r) => ({
      ...r,
      proposedMatchesMyob: Math.abs(r.proposed - (r.myob ?? 0)) <= TOLERANCE,
      known: r.number != null && known.includes(r.number) ? "PO older than the sync floor" : null,
    }))
    .sort((a, b) => String(a.number ?? "").localeCompare(String(b.number ?? "")));
  return { rows: out, diverging: out.length };
}

/**
 * The end-of-sync warning: items whose On order reads BELOW MYOB's, known
 * pre-floor items aside. Above MYOB means counting stock that is not coming;
 * below means stock that is coming has been hidden, which is the failure an
 * on-order rule that depends on bills can produce (a deleted bill MYOB never
 * told us about, or a part-billed backorder). One false reading is possible
 * when a PO is received while the sync runs, hence "check again after the
 * next sync".
 */
export function onOrderBelowMyob(
  rows: Pick<OnOrderCompareRow, "number" | "ours" | "myob">[],
  known: readonly string[] = KNOWN_PRE_FLOOR,
): string[] {
  return rows
    .filter((r) => r.number != null && !known.includes(r.number))
    .filter((r) => (r.myob ?? 0) - r.ours > TOLERANCE)
    .map((r) => r.number as string)
    .sort();
}

export type OpenDocReason = "counted" | "negative_total" | "billed";

/**
 * Why one Open document does or does not count, in the order the rule tests
 * it. A negative document is a reversal whatever else is true of it, so it
 * reads as that even when a bill shares its number (00020624).
 */
export function openDocReason(doc: { total: number | null; billedOnOrAfter: boolean }): OpenDocReason {
  if ((doc.total ?? 0) < 0) return "negative_total";
  if (doc.billedOnOrAfter) return "billed";
  return "counted";
}
