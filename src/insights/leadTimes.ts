import type pg from "pg";
import { getPool } from "../db.js";

/**
 * Every supplier's lead time, read once per request (1.9; moved out of
 * cart.ts unchanged).
 *
 * Two readers now need the same per-supplier figure: the cart, for the lead
 * time it shows against each supplier a new order could go to, and the
 * expected date of an open purchase order (incoming.ts), which is the PO date
 * plus its own supplier's lead wherever MYOB has no Promised Date. Moving the
 * query here means the two can never name different leads for one supplier.
 * The cart's output is byte-identical: it reads the same four fields it read
 * when the query sat inline; alliedDays and measuredDays are for the ETA only.
 *
 * Allied's figure on the supplier wins over the measured one, the same
 * precedence the item set uses. The cart used to show the measured median
 * here even after Allied had overridden it on the Suppliers page, so the card
 * could name one wait while the order quantity was built on another.
 *
 * This is a runtime SELECT over supplier_lead_time, not a new view or
 * function on top of it (FEEDBACK-PLAN §4.3: nothing in the database may
 * depend on that view, which is dropped and recreated at every boot). A lead
 * time set on one item is deliberately not here: it is a planning input for
 * the cart and the minimum, and never moves an ETA (incoming.ts).
 */
export interface SupplierLead {
  /** Allied's figure if set, else the measured median. */
  days: number | null;
  /** True when `days` is Allied's figure. */
  setByAllied: boolean;
  /** Order/bill pairs the measured median is built on (0 when none). */
  orders: number;
  /** Same-day order/bill pairs ignored — see supplier_lead_time for why. */
  sameDayExcluded: number;
  /** Allied's figure on the Suppliers page, or null. */
  alliedDays: number | null;
  /** The measured median, or null when there is no history to measure. */
  measuredDays: number | null;
}

/** Supplier uid → lead, for every supplier with Allied's or a measured figure. */
export async function supplierLeadTimes(pool: pg.Pool = getPool()): Promise<Map<string, SupplierLead>> {
  const r = await pool.query(
    `SELECT s.uid AS supplier_uid,
            COALESCE(m.lead_time_days, l.median_lead_days)::float8 AS days,
            (m.lead_time_days IS NOT NULL) AS set_by_allied,
            COALESCE(l.orders_measured, 0)::int AS orders_measured,
            COALESCE(l.same_day_excluded, 0)::int AS same_day_excluded,
            m.lead_time_days::float8 AS allied_days,
            l.median_lead_days::float8 AS measured_days
     FROM myob_suppliers s
     LEFT JOIN supplier_lead_time l ON l.supplier_uid = s.uid
     LEFT JOIN platform_supplier_meta m ON m.supplier_uid = s.uid
     WHERE m.lead_time_days IS NOT NULL OR l.median_lead_days IS NOT NULL`,
  );
  return new Map(
    r.rows.map((x) => [
      x.supplier_uid as string,
      {
        days: x.days as number | null,
        setByAllied: x.set_by_allied as boolean,
        orders: x.orders_measured as number,
        sameDayExcluded: x.same_day_excluded as number,
        alliedDays: x.allied_days as number | null,
        measuredDays: x.measured_days as number | null,
      },
    ]),
  );
}
