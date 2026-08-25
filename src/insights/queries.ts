import { businessToday } from "./businessDate.js";
import { config } from "../config.js";
import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";

/**
 * Analytics over the mirrored MYOB data.
 *
 * Interpretation rules (documented for Allied in the UI glossary):
 * - Position quantities (on hand / committed / on order / available) are MYOB
 *   facts taken from the item master, never recomputed by us.
 * - Direct demand = item-layout sales invoice lines. Credit notes carry
 *   negative quantities and net demand down automatically.
 * - Component consumption = negative lines on Inventory Build transactions.
 *   These are separate MYOB movements from sales, so adding them to direct
 *   demand does not double count.
 * - Transfers and inventory adjustments are never treated as demand.
 * - Weekly demand uses the trailing 90 days; if an item had no activity in 90
 *   days but did in 365, the 365-day rate is used (flagged "slow").
 * - MYOB's QuantityAvailable INCLUDES stock on order (verified against
 *   Allied's file: available = on hand - committed + on order for every item
 *   with an open PO). It is shown as a MYOB fact but never used in analysis.
 *   Cover, buildability and purchasing suggestions use free stock
 *   (on hand - committed) so incoming supply is only counted once, as
 *   "incoming" from open purchase orders.
 */

/**
 * Supplier regions are PLATFORM labels, not MYOB data. The label is derived
 * automatically from the supplier's MYOB address country and can be
 * overridden per supplier by Allied staff (platform_supplier_meta.region).
 * Fixed set keeps the split meaningful: the question Allied asks is
 * "NZ vs China (vs other) — where is our stock coming from?".
 */
export const SUPPLIER_REGIONS = ["NZ", "Australia", "China", "Overseas — other"] as const;
export type SupplierRegion = (typeof SUPPLIER_REGIONS)[number];

export function autoRegion(country: string | null | undefined): SupplierRegion | null {
  if (!country) return null;
  const c = country.trim().toLowerCase();
  if (!c) return null;
  if (["new zealand", "nz", "aotearoa", "new zealand (aotearoa)"].includes(c)) return "NZ";
  if (["australia", "au", "aus"].includes(c)) return "Australia";
  if (["china", "cn", "prc", "people's republic of china", "china (mainland)"].includes(c))
    return "China";
  return "Overseas — other";
}

/**
 * Demand window options.
 *
 * `windowMonths` is the rolling window Allied choose, 6 by default: a 12-month
 * average flattens their spiky demand profile, so the shorter window is the
 * one that reflects how the business actually moves. Wider views are one click
 * away in the control bar.
 *
 * `longMonths` is a wider look-back used only for items with no activity inside
 * the chosen window, so a genuine slow mover still gets a rate rather than a
 * blank. It must stay strictly wider than the window or that fallback can never
 * fire and nothing is ever detected as a slow mover — hence twice the window,
 * floored at 12 months.
 *
 * Everything is measured up to `asAt`, not to today, so demand and stock
 * position always describe the same moment.
 */
export interface DemandWindow {
  asAt: string;
  windowMonths: number;
  longMonths: number;
}

export const DEFAULT_WINDOW_MONTHS = 6;

export function resolveWindow(o?: Partial<DemandWindow>): DemandWindow {
  const windowMonths = clampMonths(o?.windowMonths, DEFAULT_WINDOW_MONTHS);
  return {
    asAt:
      typeof o?.asAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.asAt)
        ? o.asAt
        : businessToday(),
    windowMonths,
    longMonths: Math.max(
      clampMonths(o?.longMonths, 12),
      Math.min(windowMonths * 2, 60),
    ),
  };
}

/** Months are interpolated into SQL, so they must be whole and bounded. */
function clampMonths(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 60 ? n : fallback;
}

/**
 * The floor for the dead-stock test: a year, or the window when it is wider.
 *
 * The floor stops a narrow view redefining the term — at a 3-month window,
 * plenty of ordinary items have not moved, and none of them are dead. Above a
 * year the window takes over instead, because the reader can see those older
 * movements on screen and calling the item dead would contradict them.
 *
 * Safe as a FILTER over the long look-back because longMonths is floored at 12.
 */
const DEAD_STOCK_MONTHS = 12;

const demandCte = (w: DemandWindow): string => `
  direct_demand AS (
    SELECT l.item_uid,
           COALESCE(SUM(l.qty) FILTER (WHERE i.date <= '${w.asAt}'::date AND i.date >= '${w.asAt}'::date - make_interval(months => ${w.windowMonths})), 0)::float8 AS direct_window,
           COALESCE(SUM(l.qty) FILTER (WHERE i.date >= '${w.asAt}'::date - make_interval(months => ${DEAD_STOCK_MONTHS})), 0)::float8 AS direct_year,
           COALESCE(SUM(l.qty), 0)::float8 AS direct_long
    FROM myob_sale_invoice_lines l
    JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
    WHERE i.date <= '${w.asAt}'::date AND i.date >= '${w.asAt}'::date - make_interval(months => ${w.longMonths}) AND l.item_uid IS NOT NULL
    GROUP BY l.item_uid
  ),
  component_demand AS (
    SELECT bl.item_uid,
           COALESCE(SUM(-bl.qty) FILTER (WHERE b.date <= '${w.asAt}'::date AND b.date >= '${w.asAt}'::date - make_interval(months => ${w.windowMonths})), 0)::float8 AS comp_window,
           COALESCE(SUM(-bl.qty) FILTER (WHERE b.date >= '${w.asAt}'::date - make_interval(months => ${DEAD_STOCK_MONTHS})), 0)::float8 AS comp_year,
           COALESCE(SUM(-bl.qty), 0)::float8 AS comp_long
    FROM myob_build_lines bl
    JOIN myob_builds b ON b.uid = bl.build_uid
    WHERE bl.qty < 0 AND bl.item_uid IS NOT NULL
      AND b.date <= '${w.asAt}'::date AND b.date >= '${w.asAt}'::date - make_interval(months => ${w.longMonths})
    GROUP BY bl.item_uid
  ),
  incoming AS (
    SELECT l.item_uid,
           COALESCE(SUM(GREATEST(COALESCE(l.qty, 0) - COALESCE(l.received_qty, 0), 0)), 0)::float8 AS qty
    FROM myob_purchase_order_lines l
    JOIN myob_purchase_orders o ON o.uid = l.order_uid
    WHERE UPPER(COALESCE(o.status, '')) = 'OPEN' AND l.item_uid IS NOT NULL
    GROUP BY l.item_uid
  ),
  bom_usage AS (
    SELECT component_uid AS item_uid,
           COUNT(DISTINCT parent_uid)::int AS parent_count
    FROM effective_bom
    GROUP BY component_uid
  ),
  -- Products that depend on a component through any number of levels, e.g. a
  -- bolt inside a bolt pack inside a dressing set. Depth-capped and
  -- cycle-guarded; used for operational importance, not for quantities.
  bom_usage_deep AS (
    WITH RECURSIVE up AS (
      SELECT component_uid AS item_uid, parent_uid, 1 AS depth,
             ARRAY[component_uid, parent_uid] AS path
      FROM effective_bom
      UNION ALL
      SELECT u.item_uid, b.parent_uid, u.depth + 1, u.path || b.parent_uid
      FROM effective_bom b
      JOIN up u ON b.component_uid = u.parent_uid
      WHERE u.depth < 6 AND NOT b.parent_uid = ANY(u.path)
    )
    SELECT item_uid, COUNT(DISTINCT parent_uid)::int AS parent_count_deep
    FROM up
    GROUP BY item_uid
  ),
  bom_parents AS (
    SELECT parent_uid AS item_uid,
           COUNT(DISTINCT component_uid)::int AS component_count
    FROM effective_bom
    GROUP BY parent_uid
  ),
  built_output AS (
    SELECT bl.item_uid,
           COALESCE(SUM(bl.qty) FILTER (WHERE b.date <= '${w.asAt}'::date AND b.date >= '${w.asAt}'::date - make_interval(months => ${w.windowMonths})), 0)::float8 AS built_window
    FROM myob_build_lines bl
    JOIN myob_builds b ON b.uid = bl.build_uid
    WHERE bl.qty > 0 AND bl.item_uid IS NOT NULL
      AND b.date <= '${w.asAt}'::date AND b.date >= '${w.asAt}'::date - make_interval(months => ${w.longMonths})
    GROUP BY bl.item_uid
  ),
  purchased_qty AS (
    SELECT l.item_uid,
           COALESCE(SUM(l.qty) FILTER (WHERE b.date <= '${w.asAt}'::date AND b.date >= '${w.asAt}'::date - make_interval(months => ${w.windowMonths})), 0)::float8 AS bought_window
    FROM myob_purchase_bill_lines l
    JOIN myob_purchase_bills b ON b.uid = l.bill_uid
    WHERE l.item_uid IS NOT NULL AND b.date <= '${w.asAt}'::date AND b.date >= '${w.asAt}'::date - make_interval(months => ${w.longMonths})
    GROUP BY l.item_uid
  ),
  -- Parent units sold in the last 90 days that were NOT built or bought in
  -- the same window: they left the door out of finished stock made earlier.
  -- Replacing them by building would pull components that MYOB has not
  -- recorded yet, so this is POTENTIAL demand. It is reported separately and
  -- never added to measured demand, cover, suggestions or the risk score.
  parent_unexplained AS (
    SELECT b.parent_uid, b.component_uid, b.qty_per,
           GREATEST(
             COALESCE(dd.direct_window, 0) - COALESCE(bo.built_window, 0) - COALESCE(pq.bought_window, 0),
             0
           ) AS units
    FROM effective_bom b
    LEFT JOIN direct_demand dd ON dd.item_uid = b.parent_uid
    LEFT JOIN built_output bo ON bo.item_uid = b.parent_uid
    LEFT JOIN purchased_qty pq ON pq.item_uid = b.parent_uid
  ),
  potential_demand AS (
    SELECT component_uid AS item_uid,
           SUM(units * qty_per)::float8 AS potential_window,
           COUNT(*) FILTER (WHERE units > 0)::int AS potential_parents
    FROM parent_unexplained
    GROUP BY component_uid
  ),
  dominant_supplier AS (
    SELECT DISTINCT ON (l.item_uid)
           l.item_uid, b.supplier_uid, b.supplier_name
    FROM myob_purchase_bill_lines l
    JOIN myob_purchase_bills b ON b.uid = l.bill_uid
    WHERE l.item_uid IS NOT NULL AND b.supplier_uid IS NOT NULL
    GROUP BY l.item_uid, b.supplier_uid, b.supplier_name
    ORDER BY l.item_uid, SUM(COALESCE(l.total, 0)) DESC
  ),
  -- Allied's own supplier assignment for an item. The preferred row wins over
  -- MYOB's primary field and over the inferred supplier; alternates are
  -- counted so the UI can show "2 more suppliers on file".
  assigned_supplier AS (
    SELECT s.item_uid, s.supplier_uid, s.supplier_item_number,
           sup.name AS supplier_name,
           (SELECT COUNT(*)::int FROM platform_item_suppliers x WHERE x.item_uid = s.item_uid) AS assigned_count
    FROM platform_item_suppliers s
    JOIN myob_suppliers sup ON sup.uid = s.supplier_uid
    WHERE s.is_preferred
  ),
  assigned_any AS (
    SELECT item_uid, COUNT(*)::int AS assigned_count
    FROM platform_item_suppliers
    GROUP BY item_uid
  )
`;

const itemSelect = (w: DemandWindow): string => `
  SELECT it.uid, it.number, it.name, it.description,
         it.is_active, it.is_bought, it.is_sold, it.is_inventoried,
         pos.on_hand, pos.committed, pos.free_stock, pos.on_order,
         pos.anchor_date::text AS anchor_date, pos.anchor_source, pos.anchor_qty,
         pos.movements_since_anchor, pos.myob_on_hand, pos.myob_committed,
         pos.divergence,
         it.average_cost, it.current_value, it.base_selling_price,
         it.min_level, it.reorder_qty,
         it.primary_supplier_uid, it.primary_supplier_name, it.supplier_item_number,
         it.product_type, it.product_finish,
         COALESCE(tg.tags, ARRAY[]::text[]) AS tags,
         it.synced_at,
         ds.supplier_uid AS inferred_supplier_uid,
         ds.supplier_name AS inferred_supplier_name,
         asg.supplier_uid AS assigned_supplier_uid,
         asg.supplier_name AS assigned_supplier_name,
         asg.supplier_item_number AS assigned_supplier_item_number,
         COALESCE(aa.assigned_count, 0) AS assigned_supplier_count,
         sup.country AS supplier_country,
         sm.region AS supplier_region_override,
         COALESCE(dd.direct_window, 0) AS direct_window,
         COALESCE(dd.direct_year, 0) AS direct_year,
         COALESCE(dd.direct_long, 0) AS direct_long,
         COALESCE(cd.comp_window, 0) AS comp_window,
         COALESCE(cd.comp_year, 0) AS comp_year,
         COALESCE(cd.comp_long, 0) AS comp_long,
         COALESCE(inc.qty, 0) AS incoming_qty,
         COALESCE(u.parent_count, 0) AS parent_count,
         COALESCE(ud.parent_count_deep, 0) AS parent_count_deep,
         COALESCE(p.component_count, 0) AS component_count,
         COALESCE(pot.potential_window, 0) AS potential_window,
         COALESCE(pot.potential_parents, 0) AS potential_parents
  FROM myob_items it
  JOIN item_position_at('${w.asAt}'::date) pos ON pos.item_uid = it.uid
  LEFT JOIN (
    SELECT item_uid, ARRAY_AGG(tag ORDER BY tag) AS tags
    FROM platform_item_tags GROUP BY item_uid
  ) tg ON tg.item_uid = it.uid
  LEFT JOIN direct_demand dd ON dd.item_uid = it.uid
  LEFT JOIN component_demand cd ON cd.item_uid = it.uid
  LEFT JOIN incoming inc ON inc.item_uid = it.uid
  LEFT JOIN bom_usage u ON u.item_uid = it.uid
  LEFT JOIN bom_usage_deep ud ON ud.item_uid = it.uid
  LEFT JOIN bom_parents p ON p.item_uid = it.uid
  LEFT JOIN potential_demand pot ON pot.item_uid = it.uid
  LEFT JOIN dominant_supplier ds ON ds.item_uid = it.uid
  LEFT JOIN assigned_supplier asg ON asg.item_uid = it.uid
  LEFT JOIN assigned_any aa ON aa.item_uid = it.uid
  LEFT JOIN myob_suppliers sup
    ON sup.uid = COALESCE(asg.supplier_uid, it.primary_supplier_uid, ds.supplier_uid)
  LEFT JOIN platform_supplier_meta sm
    ON sm.supplier_uid = COALESCE(asg.supplier_uid, it.primary_supplier_uid, ds.supplier_uid)
`;

export interface ItemComputed {
  uid: string;
  number: string | null;
  name: string | null;
  description: string | null;
  isActive: boolean | null;
  isInventoried: boolean | null;
  isBought: boolean | null;
  isSold: boolean | null;
  qtyOnHand: number | null;
  qtyCommitted: number | null;
  /** How this item's on-hand figure was reached — shown in the UI. */
  anchorDate: string | null;
  anchorSource: string | null;
  anchorQty: number | null;
  movementsSinceAnchor: number;
  /** MYOB's own figures, carried for comparison only. */
  myobOnHand: number | null;
  myobCommitted: number | null;
  divergence: number | null;
  qtyOnOrder: number | null;
  qtyAvailable: number | null;
  /** on hand - committed. MYOB's "available" also adds on-order stock. */
  qtyFreeStock: number | null;
  averageCost: number | null;
  /** Our on hand x average cost. Never MYOB's stored CurrentValue. */
  currentValue: number | null;
  /** MYOB's stored value, carried for comparison only. */
  myobStockValue: number | null;
  baseSellingPrice: number | null;
  minLevel: number | null;
  reorderQty: number | null;
  /** Effective supplier, in precedence order: Allied's preferred assignment,
   * else MYOB's primary supplier, else the dominant supplier inferred from
   * purchase-bill history. `supplierSource` says which applied. */
  supplierUid: string | null;
  supplierName: string | null;
  supplierSource: "allied" | "myob" | "inferred" | null;
  supplierItemNumber: string | null;
  /** MYOB CustomList1/2, kept as independent facets — never concatenated. */
  productType: string | null;
  productFinish: string | null;
  /** Allied's own free-text tags. */
  tags: string[];
  /** How many suppliers Allied has recorded for this item (0 = none yet). */
  supplierCount: number;
  /** Platform label: user override, else auto from MYOB address country. */
  supplierRegion: string | null;
  supplierRegionSource: "user" | "auto" | null;
  syncedAt: string | null;
  demand: {
    /** Sales inside the chosen rolling window. */
    directWindow: number;
    /** Sales over the wider look-back, used when the window is empty. */
    directLong: number;
    componentWindow: number;
    componentLong: number;
    weekly: number;
    basis: "window" | "long" | "none";
    /** The window these figures were measured over, for labelling. */
    windowMonths: number;
    longMonths: number;
    asAt: string;
  };
  incomingQty: number;
  parentCount: number;
  /** Products depending on this item at any depth (bolt → pack → set). */
  parentCountDeep: number;
  componentCount: number;
  /**
   * Component pull implied by packs/kits that sold more than were built or
   * bought in the last 90 days. Inferred, never measured — reported alongside
   * demand but deliberately excluded from weekly, cover, suggestion and risk.
   */
  potential: {
    qtyWindow: number;
    weekly: number;
    parentCount: number;
    understatesMeasured: boolean;
  };
  coverWeeks: number | null;
  /**
   * Stock beyond the target cover, when it is material. Value tied up that
   * Allied could stop reordering — the counterpart to shortage risk.
   */
  excess: { units: number; value: number; coverWeeks: number } | null;
  flags: string[];
  risk: { score: number; factors: { label: string; points: number }[] };
  suggestion: {
    qty: number;
    rationale: Record<string, number | string | null>;
  } | null;
}

function computeItem(row: Record<string, unknown>, win: DemandWindow): ItemComputed {
  const n = (v: unknown): number | null =>
    v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  const directWindow = n(row.direct_window) ?? 0;
  const directLong = n(row.direct_long) ?? 0;
  const compWindow = n(row.comp_window) ?? 0;
  const compLong = n(row.comp_long) ?? 0;

  const totalWindow = directWindow + compWindow;
  const totalLong = directLong + compLong;
  // Weeks per month averaged over a year, so a 6-month window is 26.09 weeks
  // rather than a rough 26 — the rate feeds cover and order quantities.
  const weeksIn = (months: number) => (months * 365.25) / 12 / 7;
  let weekly = 0;
  let basis: "window" | "long" | "none" = "none";
  if (totalWindow > 0) {
    weekly = totalWindow / weeksIn(win.windowMonths);
    basis = "window";
  } else if (totalLong > 0) {
    // Nothing sold inside the chosen window, so fall back to the wider
    // look-back rather than reporting a slow mover as having no demand at all.
    weekly = totalLong / weeksIn(win.longMonths);
    basis = "long";
  }

  // Every downstream figure — cover, below-minimum, suggestions, risk, sorting,
  // filters — hangs off these three. They come from the platform ledger; MYOB's
  // own quantities travel alongside only so divergence can be shown.
  const onHand = n(row.on_hand);
  const committed = n(row.committed);
  const myobOnHand = n(row.myob_on_hand);
  const myobCommitted = n(row.myob_committed);
  const minLevel = n(row.min_level);
  const avgCost = n(row.average_cost);
  const incomingQty = n(row.incoming_qty) ?? 0;
  const parentCount = n(row.parent_count) ?? 0;
  const isActive = row.is_active as boolean | null;

  // Inferred pack-driven pull. Material when it would move the picture:
  // there is no measured demand at all, or it adds at least a quarter again.
  const potentialWindow = n(row.potential_window) ?? 0;
  const understatesMeasured =
    potentialWindow > 0 && (totalWindow <= 0 || potentialWindow >= totalWindow * 0.25);

  const freeStock = onHand == null ? null : onHand - (committed ?? 0);
  const onOrder = n(row.on_order) ?? 0;
  // Our own "available": free stock plus what is on the water. Kept distinct
  // from free stock, which is what every downstream calculation uses, so
  // un-arrived stock can never be counted as if it were on the shelf.
  const available = freeStock == null ? null : freeStock + onOrder;

  const coverWeeks =
    weekly > 0 && freeStock != null ? Math.max(freeStock, 0) / weekly : null;

  const flags: string[] = [];
  if (minLevel != null && minLevel > 0 && (freeStock ?? 0) < minLevel)
    flags.push("below_min");
  if ((onHand ?? 0) < 0) flags.push("negative_stock");
  if ((onHand ?? 0) > 0 && (avgCost ?? 0) === 0) flags.push("stock_no_cost");
  if (isActive === false && (onHand ?? 0) > 0) flags.push("inactive_with_stock");
  // Effective supplier: Allied's preferred assignment, else MYOB primary,
  // else inferred from purchase history.
  const supplierUid =
    (row.assigned_supplier_uid as string) ??
    (row.primary_supplier_uid as string) ??
    (row.inferred_supplier_uid as string) ??
    null;
  if (weekly > 0 && !supplierUid) flags.push("no_supplier");

  /*
   * Slow mover and dead stock, decided together so an item can only ever be
   * one of them.
   *
   * Dead stock is "nothing has moved at all" — no sales, no builds consuming
   * it — over a year, or over the period being viewed when that is longer than
   * a year. The longer-of rule is what makes it read naturally at wide windows:
   * looking back 18 months at an item that last sold 14 months ago, the reader
   * can see the sale in the period they chose, so calling it dead contradicts
   * what is on screen. It is a slow mover there, and dead stock at a 6-month
   * window where that sale is out of view.
   *
   * Stock on hand is required: an item nobody buys and that Allied does not
   * hold is a dormant catalogue entry, not stock sitting still, and listing
   * thousands of them would bury the ones with money in them.
   */
  const movedInYear = (n(row.direct_year) ?? 0) + (n(row.comp_year) ?? 0) > 0;
  const movedInWindow = totalWindow > 0;
  const movedInDeadPeriod =
    win.windowMonths >= DEAD_STOCK_MONTHS ? movedInWindow : movedInYear;

  if (!movedInDeadPeriod && (onHand ?? 0) > 0) {
    flags.push("dead_stock");
  } else if (basis === "long" || (movedInWindow && !movedInYear)) {
    // Either the rate had to come from the wider look-back, or the only
    // movement inside a wide window is older than a year. Both mean the same
    // thing to the reader: still selling, just not lately.
    flags.push("slow_mover");
  }
  if (understatesMeasured) flags.push("understated_demand");

  const factors: { label: string; points: number }[] = [];
  if (flags.includes("below_min"))
    factors.push({ label: "Below MYOB minimum level", points: 30 });
  if (coverWeeks != null) {
    if (coverWeeks < 2) factors.push({ label: `Cover ${coverWeeks.toFixed(1)}w (<2w)`, points: 25 });
    else if (coverWeeks < 4) factors.push({ label: `Cover ${coverWeeks.toFixed(1)}w (<4w)`, points: 15 });
    else if (coverWeeks < config.insights.targetCoverWeeks)
      factors.push({ label: `Cover ${coverWeeks.toFixed(1)}w (below target)`, points: 8 });
  }
  // Dependency breadth counts products that need this item at any depth, so a
  // bolt inside a pack inside a dressing set scores its true reach.
  const parentCountDeep = n(row.parent_count_deep) ?? 0;
  if (parentCountDeep > 0)
    factors.push({
      label:
        parentCountDeep > parentCount
          ? `Used in ${parentCountDeep} finished products (${parentCount} directly, rest via sub-assemblies)`
          : `Used in ${parentCountDeep} finished product${parentCountDeep === 1 ? "" : "s"}`,
      points: Math.min(20, parentCountDeep * 2),
    });
  if (flags.includes("negative_stock"))
    factors.push({ label: "Negative stock (data quality)", points: 20 });
  const weeklyValue = weekly * (avgCost ?? 0);
  if (weeklyValue > 0)
    factors.push({
      label: `~$${weeklyValue.toFixed(0)}/week consumption value`,
      points: Math.min(15, Math.round(weeklyValue / 50)),
    });
  const score = Math.min(
    100,
    factors.reduce((s, f) => s + f.points, 0),
  );

  // Excess: stock beyond the target cover. Only meaningful with real demand
  // and material value, so slow movers with a handful of cheap parts don't
  // crowd out genuine overstock.
  const excessThreshold = config.insights.excessCoverWeeks;
  let excess: ItemComputed["excess"] = null;
  if (weekly > 0 && coverWeeks != null && coverWeeks > excessThreshold) {
    const units = Math.max((freeStock ?? 0) - weekly * excessThreshold, 0);
    const value = units * (avgCost ?? 0);
    if (units > 0 && value >= config.insights.excessMinValue) {
      excess = {
        units: Number(units.toFixed(1)),
        value: Number(value.toFixed(2)),
        coverWeeks,
      };
    }
  }

  // Purchasing suggestion: cover target + min level, net of free stock and
  // incoming POs. Free stock excludes on-order so incoming is subtracted once.
  let suggestion: ItemComputed["suggestion"] = null;
  if (weekly > 0 || flags.includes("below_min")) {
    const target = config.insights.targetCoverWeeks;
    const raw =
      weekly * target + Math.max(minLevel ?? 0, 0) - (freeStock ?? 0) - incomingQty;
    if (raw > 0) {
      const multiple = n(row.reorder_qty);
      const qty =
        multiple && multiple > 0 ? Math.ceil(raw / multiple) * multiple : Math.ceil(raw);
      suggestion = {
        qty,
        rationale: {
          weeklyDemand: Number(weekly.toFixed(2)),
          demandBasis: basis,
          targetCoverWeeks: target,
          minLevel: minLevel ?? 0,
          freeStock: freeStock ?? 0,
          incoming: incomingQty,
          rawNeed: Number(raw.toFixed(1)),
          reorderMultiple: multiple ?? null,
        },
      };
    }
  }

  // Excess (demand-based) and a suggestion (driven by MYOB's minimum level)
  // can both be true when the minimum is far above what demand justifies.
  // Both numbers are right; the contradiction itself is the insight, so it is
  // flagged rather than resolved by suppressing one of them.
  if (excess && suggestion) flags.push("min_above_demand");

  return {
    uid: String(row.uid),
    number: (row.number as string) ?? null,
    name: (row.name as string) ?? null,
    description: (row.description as string) ?? null,
    isActive,
    isInventoried: row.is_inventoried as boolean | null,
    isBought: row.is_bought as boolean | null,
    isSold: row.is_sold as boolean | null,
    qtyOnHand: onHand,
    qtyCommitted: committed,
    qtyOnOrder: onOrder,
    qtyAvailable: available,
    qtyFreeStock: freeStock,
    // Derivation, so every figure can show its working in the UI.
    anchorDate: (row.anchor_date as string) ?? null,
    anchorSource: (row.anchor_source as string) ?? null,
    anchorQty: n(row.anchor_qty),
    movementsSinceAnchor: n(row.movements_since_anchor) ?? 0,
    myobOnHand,
    myobCommitted,
    divergence: n(row.divergence),
    averageCost: avgCost,
    /*
     * Stock value is computed here, not read from MYOB's CurrentValue.
     *
     * Two reasons. After P1 on hand is ours, so reading MYOB's stored value
     * would silently value our quantity at their quantity — a count entered by
     * Allied would move the stock figure but not the money. And MYOB's stored
     * value is not always right: SW101616G4 holds 180 at $1.8667 and is
     * recorded as $3.36 rather than $336.00, out by exactly 100x.
     */
    currentValue: onHand == null || avgCost == null ? null : onHand * avgCost,
    myobStockValue: n(row.current_value),
    baseSellingPrice: n(row.base_selling_price),
    minLevel,
    reorderQty: n(row.reorder_qty),
    supplierUid,
    supplierName:
      (row.assigned_supplier_name as string) ??
      (row.primary_supplier_name as string) ??
      (row.inferred_supplier_name as string) ??
      null,
    supplierSource: row.assigned_supplier_uid
      ? "allied"
      : row.primary_supplier_uid
        ? "myob"
        : row.inferred_supplier_uid
          ? "inferred"
          : null,
    productType: (row.product_type as string) ?? null,
    productFinish: (row.product_finish as string) ?? null,
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    supplierItemNumber:
      (row.assigned_supplier_item_number as string) ??
      (row.supplier_item_number as string) ??
      null,
    supplierCount: n(row.assigned_supplier_count) ?? 0,
    supplierRegion:
      (row.supplier_region_override as string) ??
      autoRegion(row.supplier_country as string | null),
    supplierRegionSource: row.supplier_region_override
      ? "user"
      : autoRegion(row.supplier_country as string | null)
        ? "auto"
        : null,
    syncedAt: row.synced_at ? new Date(row.synced_at as string).toISOString() : null,
    demand: {
      directWindow,
      directLong,
      componentWindow: compWindow,
      componentLong: compLong,
      weekly: Number(weekly.toFixed(3)),
      basis,
      windowMonths: win.windowMonths,
      longMonths: win.longMonths,
      asAt: win.asAt,
    },
    incomingQty,
    parentCount,
    parentCountDeep: n(row.parent_count_deep) ?? 0,
    componentCount: n(row.component_count) ?? 0,
    potential: {
      qtyWindow: Number(potentialWindow.toFixed(1)),
      weekly: Number((potentialWindow / ((win.windowMonths * 365.25) / 12 / 7)).toFixed(3)),
      parentCount: n(row.potential_parents) ?? 0,
      understatesMeasured,
    },
    coverWeeks: coverWeeks == null ? null : Number(coverWeeks.toFixed(1)),
    excess,
    flags,
    risk: { score, factors },
    suggestion,
  };
}

let itemsCache: { key: string; at: number; items: ItemComputed[] } | null = null;

export async function computedItems(
  opts?: Partial<DemandWindow> | boolean,
): Promise<ItemComputed[]> {
  // Historic callers passed `force` as a boolean; keep that working.
  const force = opts === true;
  const win = resolveWindow(typeof opts === "object" ? opts : undefined);
  const key = `${win.asAt}|${win.windowMonths}|${win.longMonths}`;
  if (!force && itemsCache?.key === key && Date.now() - itemsCache.at < 30_000) {
    return itemsCache.items;
  }
  await ensureInsightsSchema();
  const result = await getPool().query(
    `WITH ${demandCte(win)} ${itemSelect(win)}`,
  );
  const items = result.rows.map((r) => computeItem(r, win));
  itemsCache = { key, at: Date.now(), items };
  return items;
}

export function invalidateItemsCache(): void {
  itemsCache = null;
}

export interface ListParams extends Partial<DemandWindow> {
  q?: string;
  /** Independent facets — never combined into one compound category. */
  productType?: string;
  productFinish?: string;
  tag?: string;
  /** Return every matching row, bypassing the page cap. Exports only. */
  all?: boolean;
  filter?: string;
  region?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
}

/**
 * Sortable columns. Values are extracted once per row; `null` always sorts
 * last regardless of direction, so "no demand" items never masquerade as the
 * best or worst of a list.
 */
const SORT_VALUES: Record<string, (i: ItemComputed) => number | string | null> = {
  risk: (i) => i.risk.score,
  number: (i) => i.number ?? "",
  name: (i) => i.name ?? "",
  on_hand: (i) => i.qtyOnHand,
  committed: (i) => i.qtyCommitted,
  available: (i) => i.qtyFreeStock,
  incoming: (i) => i.incomingQty,
  cover: (i) => i.coverWeeks,
  weekly: (i) => i.demand.weekly,
  value: (i) => i.currentValue,
  excess: (i) => i.excess?.value ?? null,
  potential: (i) => (i.potential.qtyWindow > 0 ? i.potential.qtyWindow : null),
  used_in: (i) => Math.max(i.parentCountDeep, i.parentCount),
};

/** Direction that is most useful when a column is first chosen. */
const SORT_DEFAULT_DIR: Record<string, "asc" | "desc"> = {
  number: "asc",
  name: "asc",
  cover: "asc",
  available: "asc",
  on_hand: "asc",
};

/**
 * Whether the selected date has a stored daily snapshot.
 *
 * On hand reconstructs cleanly from the ledger either way, but committed
 * cannot: MYOB records an order's status now, never when it changed, so for a
 * date with no snapshot we can only count orders still open today and the
 * figure is understated. Every view that reports an as-at position returns
 * this so the UI can say so on exactly the dates where it is true.
 */
async function snapshotState(asAt: string) {
  const snap = await getPool().query(
    `SELECT EXISTS (SELECT 1 FROM platform_daily_position WHERE as_at_date = $1::date) AS has_snapshot,
            MIN(as_at_date)::text AS snapshots_from
     FROM platform_daily_position`,
    [asAt],
  );
  return {
    hasSnapshot: Boolean(snap.rows[0]?.has_snapshot),
    snapshotsFrom: (snap.rows[0]?.snapshots_from as string) ?? null,
  };
}

export async function listItems(params: ListParams) {
  const win = resolveWindow(params);
  const all = await computedItems(win);
  const q = params.q?.trim().toLowerCase();
  let rows = all;

  if (q) {
    rows = rows.filter((r) =>
      `${r.number ?? ""} ${r.name ?? ""} ${r.description ?? ""} ${r.supplierName ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }

  /*
   * Independent facets. Product type and finish are separate dimensions and are
   * never combined into one label: Allied currently stack them by hand into
   * compound categories like "bolt and nut stainless" purely to keep the list
   * workable, and that workaround must not be rebuilt here. Finish is a
   * commercial dimension — stainless is high value, bought from two suppliers
   * and managed far more closely than galvanised.
   *
   * "(not set)" is a selectable value rather than a hidden one, so the 113 items
   * with no finish and 53 with no type stay reachable instead of vanishing.
   */
  const NOT_SET = "(not set)";
  if (params.productType) {
    rows = rows.filter((r) =>
      params.productType === NOT_SET ? !r.productType : r.productType === params.productType,
    );
  }
  if (params.productFinish) {
    rows = rows.filter((r) =>
      params.productFinish === NOT_SET ? !r.productFinish : r.productFinish === params.productFinish,
    );
  }
  if (params.tag) {
    const wanted = params.tag.trim().toLowerCase();
    rows = rows.filter((r) => r.tags.some((t) => t.toLowerCase() === wanted));
  }

  if (params.region) {
    rows =
      params.region === "none"
        ? rows.filter((r) => r.supplierRegion == null)
        : rows.filter((r) => r.supplierRegion === params.region);
  }

  switch (params.filter) {
    case "attention":
      rows = rows.filter((r) => r.risk.score >= 25);
      break;
    case "below_min":
      rows = rows.filter((r) => r.flags.includes("below_min"));
      break;
    case "low_cover":
      rows = rows.filter((r) => r.coverWeeks != null && r.coverWeeks < 4);
      break;
    case "negative":
      rows = rows.filter((r) => r.flags.includes("negative_stock"));
      break;
    case "no_supplier":
      rows = rows.filter((r) => r.flags.includes("no_supplier"));
      break;
    case "inactive_stock":
      rows = rows.filter((r) => r.flags.includes("inactive_with_stock"));
      break;
    case "parents":
      rows = rows.filter((r) => r.componentCount > 0);
      break;
    case "components":
      rows = rows.filter((r) => r.parentCount > 0);
      break;
    case "suggested":
      rows = rows.filter((r) => r.suggestion != null);
      break;
    case "understated":
      rows = rows.filter((r) => r.flags.includes("understated_demand"));
      break;
    case "excess":
      rows = rows.filter((r) => r.excess != null);
      break;
    case "slow_mover":
      rows = rows.filter((r) => r.flags.includes("slow_mover"));
      break;
    case "stock_no_cost":
      rows = rows.filter((r) => r.flags.includes("stock_no_cost"));
      break;
    case "min_above_demand":
      rows = rows.filter((r) => r.flags.includes("min_above_demand"));
      break;
    // Money sitting in stock that is barely selling — the combination is what
    // makes it worth acting on, so it gets its own view.
    case "dead_stock":
      rows = rows.filter((r) => r.flags.includes("dead_stock"));
      break;
    case "committed":
      rows = rows.filter((r) => (r.qtyCommitted ?? 0) > 0);
      break;
  }

  const sortKey = params.sort && SORT_VALUES[params.sort] ? params.sort : "risk";
  const dir =
    params.dir === "asc" || params.dir === "desc"
      ? params.dir
      : (SORT_DEFAULT_DIR[sortKey] ?? "desc");
  const value = SORT_VALUES[sortKey];
  rows = [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // missing values always last
    if (vb == null) return -1;
    const c =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb)
        : Number(va) - Number(vb);
    return dir === "asc" ? c : -c;
  });

  /*
   * The 200 cap protects the browser from a runaway page, but an export must
   * never be silently truncated — a spreadsheet missing 2,900 of 3,100 rows
   * looks complete and is not. `all` opts out, and only the export uses it.
   */
  const pageSize = params.all
    ? rows.length
    : Math.min(Math.max(params.pageSize ?? 50, 10), 200);
  const page = params.all ? 1 : Math.max(params.page ?? 1, 1);
  const start = (page - 1) * pageSize;

  return {
    total: rows.length,
    page,
    pageSize,
    window: win,
    ...(await snapshotState(win.asAt)),
    sort: sortKey,
    dir,
    targetCoverWeeks: config.insights.targetCoverWeeks,
    items: rows.slice(start, start + pageSize),
  };
}

export async function overview(opts?: Partial<DemandWindow>) {
  const win = resolveWindow(opts);
  const items = await computedItems(win);
  const snap = await snapshotState(win.asAt);
  const pool = getPool();

  const active = items.filter((i) => i.isActive !== false);
  const belowMin = items.filter((i) => i.flags.includes("below_min"));
  const lowCover = items.filter((i) => i.coverWeeks != null && i.coverWeeks < 2);
  const negative = items.filter((i) => i.flags.includes("negative_stock"));
  const suggested = items.filter((i) => i.suggestion != null);
  const stockValue = items.reduce((s, i) => s + (i.currentValue ?? 0), 0);
  const parents = items.filter((i) => i.componentCount > 0);
  const excessItems = items.filter((i) => i.excess != null);
  const excessValue = excessItems.reduce((s, i) => s + (i.excess?.value ?? 0), 0);

  const attention = [...items]
    .sort((a, b) => b.risk.score - a.risk.score)
    .filter((i) => i.risk.score > 0)
    .slice(0, 15);

  const [constraints, relationships, freshness, openPoRegions, adjustments] = await Promise.all([
    // Blocking counts every product that depends on the component at any
    // depth, so a bolt short inside a pack also blocks the sets using it.
    pool.query(`
      WITH RECURSIVE up AS (
        SELECT component_uid AS item_uid, parent_uid, qty_per, 1 AS depth,
               ARRAY[component_uid, parent_uid] AS path
        FROM effective_bom
        UNION ALL
        SELECT u.item_uid, b.parent_uid, u.qty_per, u.depth + 1, u.path || b.parent_uid
        FROM effective_bom b
        JOIN up u ON b.component_uid = u.parent_uid
        WHERE u.depth < 6 AND NOT b.parent_uid = ANY(u.path)
      )
      SELECT u.item_uid AS uid, i.number, i.name,
             COALESCE(p.free_stock, 0)::float8 AS stock_free,
             COUNT(DISTINCT u.parent_uid)::int AS blocked_parents,
             MAX(u.depth)::int AS max_depth
      FROM up u
      JOIN myob_items i ON i.uid = u.item_uid
      JOIN item_position_at('${win.asAt}'::date) p ON p.item_uid = u.item_uid
      WHERE COALESCE(p.free_stock, 0) < u.qty_per
      GROUP BY u.item_uid, i.number, i.name, p.free_stock
      ORDER BY blocked_parents DESC
      LIMIT 8
    `),
    // Counted from the effective BOM, so this reflects the recipes actually in
    // use after user > myob > derived precedence, not every row ever recorded.
    pool.query(`
      SELECT source, COUNT(*)::int AS count FROM effective_bom GROUP BY source
    `),
    pool.query(`
      SELECT MIN(last_synced_at) AS oldest, MAX(last_synced_at) AS newest
      FROM sync_state
    `),
    pool.query(`
      SELECT s.country, m.region AS override,
             COALESCE(SUM(o.total), 0)::float8 AS value, COUNT(*)::int AS orders
      FROM myob_purchase_orders o
      LEFT JOIN myob_suppliers s ON s.uid = o.supplier_uid
      LEFT JOIN platform_supplier_meta m ON m.supplier_uid = o.supplier_uid
      WHERE UPPER(COALESCE(o.status, '')) = 'OPEN'
      GROUP BY s.country, m.region
    `),
    // Largest stock adjustments in the 30 days to the selected date, by
    // absolute value — the write-offs, stocktake corrections and reversals
    // worth a second look. Anchored to asAt so a historical view does not list
    // adjustments that had not happened yet.
    //
    // Netted per document and item, not listed line by line. A location move
    // is one adjustment carrying a -30,000 line and six positive lines that
    // give the same 30,000 back; ranking the lines separately put a -30,000
    // "write-off" at the top of the table that no single movement on the item
    // page matched. HAVING drops those net-zero moves entirely — nothing
    // actually left the building.
    pool.query(`
      SELECT a.number, a.date, a.memo AS doc_memo,
             MIN(NULLIF(al.memo, '')) AS line_memo,
             SUM(al.qty)::float8 AS qty,
             COUNT(*)::int AS lines,
             i.uid, i.number AS item_number, i.name AS item_name,
             (ABS(SUM(al.qty))
              * COALESCE(AVG(NULLIF(al.unit_cost, 0)), i.average_cost, 0))::float8 AS value
      FROM myob_adjustment_lines al
      JOIN myob_adjustments a ON a.uid = al.adjustment_uid
      JOIN myob_items i ON i.uid = al.item_uid
      WHERE a.date <= '${win.asAt}'::date
        AND a.date >= '${win.asAt}'::date - INTERVAL '30 days'
      GROUP BY a.uid, a.number, a.date, a.memo, i.uid, i.number, i.name, i.average_cost
      HAVING ABS(SUM(al.qty)) > 1e-6
      ORDER BY value DESC
      LIMIT 10
    `),
  ]);

  // Stock value by supplier region (items' primary supplier) + open-PO value
  // by the ordering supplier's region. Region labels are platform data.
  const regionRows = new Map<
    string,
    { region: string; skus: number; stockValue: number; openPoValue: number; openPoOrders: number }
  >();
  const regionRow = (label: string) => {
    if (!regionRows.has(label))
      regionRows.set(label, { region: label, skus: 0, stockValue: 0, openPoValue: 0, openPoOrders: 0 });
    return regionRows.get(label)!;
  };
  for (const i of items) {
    const label = i.supplierRegion ?? (i.supplierUid ? "Unlabelled" : "No supplier");
    const r = regionRow(label);
    r.skus += 1;
    r.stockValue += i.currentValue ?? 0;
  }
  for (const row of openPoRegions.rows) {
    const label =
      (row.override as string) ??
      autoRegion(row.country as string | null) ??
      "Unlabelled";
    const r = regionRow(label);
    r.openPoValue += Number(row.value) || 0;
    r.openPoOrders += Number(row.orders) || 0;
  }
  const regions = [...regionRows.values()].sort((a, b) => b.stockValue - a.stockValue);

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      totalSkus: items.length,
      activeSkus: active.length,
      stockValue,
      belowMin: belowMin.length,
      coverUnder2w: lowCover.length,
      negativeStock: negative.length,
      suggestedOrders: suggested.length,
      trackedParents: parents.length,
      excessItems: excessItems.length,
      excessValue,
    },
    relationships: relationships.rows,
    attention,
    constraints: constraints.rows,
    regions,
    adjustments: adjustments.rows,
    freshness: freshness.rows[0] ?? null,
    targetCoverWeeks: config.insights.targetCoverWeeks,
    excessCoverWeeks: config.insights.excessCoverWeeks,
    window: win,
    ...snap,
  };
}

async function relationshipRows(uid: string, asAt: string) {
  const pool = getPool();
  const [components, whereUsed] = await Promise.all([
    pool.query(
      `SELECT b.component_uid AS uid, b.qty_per::float8 AS qty_per, b.source,
              b.build_count, b.confidence::float8 AS confidence, b.last_observed,
              d.qty_per::float8 AS shadowed_derived_qty, d.build_count AS shadowed_build_count,
              i.number, i.name,
              COALESCE(p.free_stock, 0)::float8 AS stock_free,
              (SELECT COUNT(*)::int FROM effective_bom x WHERE x.parent_uid = b.component_uid) AS sub_components
       FROM effective_bom b
       JOIN myob_items i ON i.uid = b.component_uid
       JOIN item_position_at('${asAt}'::date) p ON p.item_uid = b.component_uid
       LEFT JOIN platform_bom d ON d.parent_uid = b.parent_uid
         AND d.component_uid = b.component_uid AND d.source = 'derived' AND b.source = 'user'
       WHERE b.parent_uid = $1
       ORDER BY b.qty_per DESC`,
      [uid],
    ),
    pool.query(
      `SELECT b.parent_uid AS uid, b.qty_per::float8 AS qty_per, b.source,
              b.build_count, b.confidence::float8 AS confidence,
              i.number, i.name,
              COALESCE(p.free_stock, 0)::float8 AS stock_free,
              (SELECT COUNT(*)::int FROM effective_bom x WHERE x.component_uid = b.parent_uid) AS used_higher
       FROM effective_bom b
       JOIN myob_items i ON i.uid = b.parent_uid
       JOIN item_position_at('${asAt}'::date) p ON p.item_uid = b.parent_uid
       WHERE b.component_uid = $1
       ORDER BY b.qty_per DESC`,
      [uid],
    ),
  ]);
  return { components: components.rows, whereUsed: whereUsed.rows };
}

export async function relationships(uid: string, opts?: Partial<DemandWindow>) {
  await ensureInsightsSchema();
  return relationshipRows(uid, resolveWindow(opts).asAt);
}

/** Depth cap for BOM explosion; also the cycle guard for malformed data. */
const BOM_MAX_DEPTH = 6;

/**
 * Explode a parent through sub-assemblies to its base components.
 * Returns the tree (for display) and the flattened base requirement per unit,
 * which is what "buildable if sub-assemblies are built first" rests on.
 */
async function explodeBom(uid: string, asAt: string): Promise<BomTreeRow[]> {
  const result = await getPool().query(
    `WITH RECURSIVE tree AS (
       SELECT b.parent_uid, b.component_uid, b.qty_per::float8 AS qty_per,
              b.qty_per::float8 AS qty_total, 1 AS depth,
              ARRAY[b.parent_uid, b.component_uid] AS path
       FROM effective_bom b
       WHERE b.parent_uid = $1
       UNION ALL
       SELECT b.parent_uid, b.component_uid, b.qty_per::float8,
              (t.qty_total * b.qty_per)::float8, t.depth + 1,
              t.path || b.component_uid
       FROM effective_bom b
       JOIN tree t ON b.parent_uid = t.component_uid
       WHERE t.depth < ${BOM_MAX_DEPTH}
         AND NOT b.component_uid = ANY(t.path)
     )
     SELECT t.parent_uid, t.component_uid, t.qty_per, t.qty_total, t.depth,
            i.number, i.name,
            COALESCE(p.free_stock, 0)::float8 AS stock_free,
            EXISTS (SELECT 1 FROM effective_bom c WHERE c.parent_uid = t.component_uid) AS has_children
     FROM tree t
     JOIN myob_items i ON i.uid = t.component_uid
     JOIN item_position_at('${asAt}'::date) p ON p.item_uid = t.component_uid
     ORDER BY t.depth, t.qty_total DESC`,
    [uid],
  );
  return result.rows;
}

interface BomTreeRow {
  parent_uid: string;
  component_uid: string;
  number: string | null;
  name: string | null;
  qty_per: number;
  qty_total: number;
  stock_free: number | null;
  has_children: boolean;
  depth: number;
}

type BuildAnswer = {
  maxUnits: number;
  constraint: { uid: string; number: string | null; name: string | null } | null;
} | null;

/**
 * Two buildability answers, both from free stock (on hand − committed):
 *  - asIs: sub-assemblies counted only as finished units already on the shelf.
 *  - withSubBuilds: a sub-assembly also contributes what could be made from
 *    its own components, recursively — "what could we supply if we did the
 *    work first?". Always >= asIs.
 *
 * Caveat surfaced in the UI: a base component shared by two branches is
 * counted against each branch independently, so withSubBuilds is an upper
 * bound where branches compete for the same part.
 */
function computeBuildability(rows: BomTreeRow[], rootUid: string) {
  const children = new Map<string, BomTreeRow[]>();
  for (const r of rows) {
    const list = children.get(r.parent_uid);
    if (list) list.push(r);
    else children.set(r.parent_uid, [r]);
  }

  const answer = (uid: string, useSubBuilds: boolean, seen: Set<string>): BuildAnswer => {
    const kids = children.get(uid);
    if (!kids?.length || seen.has(uid)) return null;
    const nextSeen = new Set(seen).add(uid);
    let maxUnits: number | null = null;
    let constraint: NonNullable<BuildAnswer>["constraint"] = null;
    for (const k of kids) {
      if (!(k.qty_per > 0)) continue;
      const onShelf = Math.max(k.stock_free ?? 0, 0);
      const extra = useSubBuilds
        ? (answer(k.component_uid, true, nextSeen)?.maxUnits ?? 0)
        : 0;
      const possible = Math.floor((onShelf + extra) / k.qty_per);
      if (maxUnits == null || possible < maxUnits) {
        maxUnits = possible;
        constraint = { uid: k.component_uid, number: k.number, name: k.name };
      }
    }
    return maxUnits == null ? null : { maxUnits, constraint };
  };

  return {
    asIs: answer(rootUid, false, new Set()),
    withSubBuilds: answer(rootUid, true, new Set()),
  };
}

export async function itemDetail(uid: string, opts?: Partial<DemandWindow>) {
  await ensureInsightsSchema();
  const win = resolveWindow(opts);
  const pool = getPool();

  const itemResult = await pool.query(
    `WITH ${demandCte(win)} ${itemSelect(win)} WHERE it.uid = $1`,
    [uid],
  );
  if (!itemResult.rows.length) return null;
  const item = computeItem(itemResult.rows[0], win);
  const chartMonths = Math.max(12, win.windowMonths);

  const [monthly, movements, commitments, incoming, purchases, rels, freshness, potentialParents] =
    await Promise.all([
      // The bar chart ends at the selected date and spans at least a year, or
      // the whole window when that is wider — so the chart and the window
      // figures underneath it always describe the same stretch of time.
      pool.query(
        `SELECT month, SUM(direct)::float8 AS direct, SUM(component)::float8 AS component FROM (
           SELECT date_trunc('month', i.date) AS month, l.qty AS direct, 0 AS component
           FROM myob_sale_invoice_lines l JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
           WHERE l.item_uid = $1
             AND i.date <= '${win.asAt}'::date
             AND i.date >= '${win.asAt}'::date - make_interval(months => ${chartMonths})
           UNION ALL
           SELECT date_trunc('month', b.date), 0, -bl.qty
           FROM myob_build_lines bl JOIN myob_builds b ON b.uid = bl.build_uid
           WHERE bl.item_uid = $1 AND bl.qty < 0
             AND b.date <= '${win.asAt}'::date
             AND b.date >= '${win.asAt}'::date - make_interval(months => ${chartMonths})
         ) x GROUP BY month ORDER BY month`,
        [uid],
      ),
      // Capped at the selected date: movements after it would contradict the
      // on-hand figure in the header, which is reconstructed to that date.
      //
      // doc_uid and seq are sort keys, not display fields. Ordering by date
      // alone left same-day lines in whatever order the planner produced, so
      // the seven lines of one location move scattered through the list and
      // its -30,000 line could fall below the fold while its positive halves
      // sat at the top. Keeping a document's lines adjacent and in MYOB's own
      // line order makes a move read as a move.
      pool.query(
        `SELECT kind, doc, date, delta, counterparty, description FROM (
           SELECT 'sale' AS kind, i.number AS doc, i.date, -l.qty::float8 AS delta,
                  i.customer_name AS counterparty, l.description,
                  i.uid AS doc_uid, l.idx AS seq
           FROM myob_sale_invoice_lines l JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
           WHERE l.item_uid = $1 AND i.date <= '${win.asAt}'::date
           UNION ALL
           SELECT 'purchase', b.number, b.date, l.qty::float8,
                  b.supplier_name, l.description, b.uid, l.idx
           FROM myob_purchase_bill_lines l JOIN myob_purchase_bills b ON b.uid = l.bill_uid
           WHERE l.item_uid = $1 AND b.date <= '${win.asAt}'::date
           UNION ALL
           SELECT 'build', b.number, b.date, bl.qty::float8, b.memo, NULL, b.uid, bl.idx
           FROM myob_build_lines bl JOIN myob_builds b ON b.uid = bl.build_uid
           WHERE bl.item_uid = $1 AND b.date <= '${win.asAt}'::date
           UNION ALL
           SELECT 'adjustment', a.number, a.date, al.qty::float8, a.memo, al.memo,
                  a.uid, al.idx
           FROM myob_adjustment_lines al JOIN myob_adjustments a ON a.uid = al.adjustment_uid
           WHERE al.item_uid = $1 AND a.date <= '${win.asAt}'::date
         ) m
         ORDER BY date DESC NULLS LAST, kind, doc_uid, seq
         LIMIT 60`,
        [uid],
      ),
      pool.query(
        `SELECT o.number, o.date, o.promised_date, o.customer_name, l.qty::float8 AS qty
         FROM myob_sale_order_lines l JOIN myob_sale_orders o ON o.uid = l.order_uid
         WHERE l.item_uid = $1 AND UPPER(COALESCE(o.status,'')) = 'OPEN'
         ORDER BY o.date DESC LIMIT 20`,
        [uid],
      ),
      pool.query(
        `SELECT o.number, o.date, o.promised_date, o.supplier_name,
                l.qty::float8 AS qty, l.received_qty::float8 AS received_qty
         FROM myob_purchase_order_lines l JOIN myob_purchase_orders o ON o.uid = l.order_uid
         WHERE l.item_uid = $1 AND UPPER(COALESCE(o.status,'')) = 'OPEN'
         ORDER BY o.date DESC LIMIT 20`,
        [uid],
      ),
      pool.query(
        `SELECT b.date, b.supplier_name, l.qty::float8 AS qty, l.unit_price::float8 AS unit_price
         FROM myob_purchase_bill_lines l JOIN myob_purchase_bills b ON b.uid = l.bill_uid
         WHERE l.item_uid = $1 AND b.date <= '${win.asAt}'::date
         ORDER BY b.date DESC LIMIT 15`,
        [uid],
      ),
      relationshipRows(uid, win.asAt),
      pool.query(`SELECT entity, last_synced_at FROM sync_state ORDER BY entity`),
      // Which packs/kits drive this component's potential demand, and the
      // sold/built/bought arithmetic behind each one. Uses the same window as
      // the headline figure — pinned to a fixed 90 days these rows silently
      // failed to add up to the total shown above them.
      pool.query(
        `WITH sold AS (
           SELECT l.item_uid, SUM(l.qty)::float8 AS qty
           FROM myob_sale_invoice_lines l JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
           WHERE i.date <= '${win.asAt}'::date
             AND i.date >= '${win.asAt}'::date - make_interval(months => ${win.windowMonths})
             AND l.item_uid IS NOT NULL
           GROUP BY l.item_uid
         ), built AS (
           SELECT bl.item_uid, SUM(bl.qty)::float8 AS qty
           FROM myob_build_lines bl JOIN myob_builds b ON b.uid = bl.build_uid
           WHERE bl.qty > 0 AND bl.item_uid IS NOT NULL
             AND b.date <= '${win.asAt}'::date
             AND b.date >= '${win.asAt}'::date - make_interval(months => ${win.windowMonths})
           GROUP BY bl.item_uid
         ), bought AS (
           SELECT l.item_uid, SUM(l.qty)::float8 AS qty
           FROM myob_purchase_bill_lines l JOIN myob_purchase_bills b ON b.uid = l.bill_uid
           WHERE l.item_uid IS NOT NULL
             AND b.date <= '${win.asAt}'::date
             AND b.date >= '${win.asAt}'::date - make_interval(months => ${win.windowMonths})
           GROUP BY l.item_uid
         )
         SELECT eb.parent_uid AS uid, i.number, i.name, eb.qty_per::float8 AS qty_per,
                COALESCE(s.qty, 0) AS sold_window,
                COALESCE(bt.qty, 0) AS built_window,
                COALESCE(bo.qty, 0) AS bought_window,
                GREATEST(COALESCE(s.qty,0) - COALESCE(bt.qty,0) - COALESCE(bo.qty,0), 0) AS unexplained_units,
                GREATEST(COALESCE(s.qty,0) - COALESCE(bt.qty,0) - COALESCE(bo.qty,0), 0) * eb.qty_per AS potential_qty
         FROM effective_bom eb
         JOIN myob_items i ON i.uid = eb.parent_uid
         LEFT JOIN sold s ON s.item_uid = eb.parent_uid
         LEFT JOIN built bt ON bt.item_uid = eb.parent_uid
         LEFT JOIN bought bo ON bo.item_uid = eb.parent_uid
         WHERE eb.component_uid = $1
           AND GREATEST(COALESCE(s.qty,0) - COALESCE(bt.qty,0) - COALESCE(bo.qty,0), 0) > 0
         ORDER BY potential_qty DESC`,
        [uid],
      ),
    ]);

  // Buildability from free stock, two ways: sub-assemblies as they sit today,
  // or exploded to base components assuming sub-assemblies get built first.
  const tree = rels.components.length ? await explodeBom(uid, win.asAt) : [];
  const buildability = rels.components.length
    ? {
        ...computeBuildability(tree, uid),
        maxDepth: tree.reduce((m, r) => Math.max(m, Number(r.depth)), 0),
        multiLevel: tree.some((r) => Number(r.depth) > 1),
      }
    : null;

  return {
    item,
    monthlyDemand: monthly.rows,
    movements: movements.rows,
    commitments: commitments.rows,
    incoming: incoming.rows,
    purchases: purchases.rows,
    components: rels.components,
    componentTree: tree,
    whereUsed: rels.whereUsed,
    buildability,
    potentialParents: potentialParents.rows,
    freshness: freshness.rows,
    window: win,
    chartMonths,
    ...(await snapshotState(win.asAt)),
  };
}

export async function productsList(
  params: { q?: string; page?: number } & Partial<DemandWindow>,
) {
  await ensureInsightsSchema();
  const win = resolveWindow(params);
  const pool = getPool();
  // Stock is read at the selected date and sales over the selected window, the
  // same as every other view. Read from today's position instead, this page
  // quietly contradicted the inventory page it links to.
  const result = await pool.query(`
    WITH parent_build AS (
      SELECT b.parent_uid,
             COUNT(*)::int AS component_count,
             MIN(FLOOR(GREATEST(COALESCE(cp.free_stock,0), 0) / NULLIF(b.qty_per,0)))::float8 AS buildable,
             BOOL_OR(b.source = 'user') AS has_user_rows,
             MIN(b.confidence)::float8 AS min_confidence
      FROM effective_bom b
      JOIN myob_items ci ON ci.uid = b.component_uid
      JOIN item_position_at('${win.asAt}'::date) cp ON cp.item_uid = b.component_uid
      GROUP BY b.parent_uid
    )
    SELECT p.*, i.number, i.name,
           COALESCE(ip.free_stock, 0)::float8 AS stock_free,
           COALESCE(ip.committed, 0)::float8 AS committed, i.is_active,
           (SELECT COALESCE(SUM(l.qty),0)::float8
              FROM myob_sale_invoice_lines l
              JOIN myob_sale_invoices si ON si.uid = l.invoice_uid
             WHERE l.item_uid = p.parent_uid
               AND si.date <= '${win.asAt}'::date
               AND si.date >= '${win.asAt}'::date - make_interval(months => ${win.windowMonths})
            ) AS sold_window
    FROM parent_build p
    JOIN myob_items i ON i.uid = p.parent_uid
    JOIN item_position_at('${win.asAt}'::date) ip ON ip.item_uid = p.parent_uid
    ORDER BY sold_window DESC NULLS LAST
  `);

  let rows = result.rows;
  const q = params.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      `${r.number ?? ""} ${r.name ?? ""}`.toLowerCase().includes(q),
    );
  }
  const pageSize = 50;
  const page = Math.max(params.page ?? 1, 1);
  return {
    total: rows.length,
    page,
    pageSize,
    window: win,
    parents: rows.slice((page - 1) * pageSize, page * pageSize),
    // Only ~500 of 3,100 items have a recipe, so a search that matches a real
    // item still comes back empty here. Say which it is rather than leaving
    // staff to guess whether they mistyped the number.
    noRecipeMatches:
      q && rows.length === 0 ? await itemsWithoutRecipe(likeEscape(q)) : [],
  };
}

/**
 * Items matching a products search that have no composition on file, so the
 * empty result can name them. Whether the item is used as a component
 * elsewhere is the useful distinction: a nut that is only ever a component is
 * a different situation from a pack nobody has recorded a recipe for.
 */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function itemsWithoutRecipe(q: string) {
  const result = await getPool().query(
    `SELECT i.uid, i.number, i.name, i.is_active,
            (SELECT COUNT(*)::int FROM effective_bom b WHERE b.component_uid = i.uid) AS used_in_count
     FROM myob_items i
     WHERE (COALESCE(i.number, '') || ' ' || COALESCE(i.name, ''))
             ILIKE '%' || $1 || '%' ESCAPE '\\'
       AND NOT EXISTS (SELECT 1 FROM effective_bom b WHERE b.parent_uid = i.uid)
     ORDER BY i.is_active DESC NULLS LAST, i.number
     LIMIT 6`,
    [q],
  );
  return result.rows;
}


export async function dataStatus() {
  await ensureInsightsSchema();
  const pool = getPool();
  const [state, runs, counts] = await Promise.all([
    pool.query(`SELECT * FROM sync_state ORDER BY entity`),
    pool.query(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 8`),
    pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM myob_items) AS items,
        (SELECT COUNT(*)::int FROM myob_sale_invoices) AS invoices,
        (SELECT COUNT(*)::int FROM myob_sale_orders) AS sale_orders,
        (SELECT COUNT(*)::int FROM myob_purchase_bills) AS bills,
        (SELECT COUNT(*)::int FROM myob_purchase_orders) AS purchase_orders,
        (SELECT COUNT(*)::int FROM myob_builds) AS builds,
        (SELECT COUNT(*)::int FROM myob_adjustments) AS adjustments,
        (SELECT COUNT(*)::int FROM myob_suppliers) AS suppliers,
        (SELECT COUNT(*)::int FROM myob_locations) AS locations,
        (SELECT COUNT(*)::int FROM platform_bom WHERE source='derived') AS bom_derived,
        (SELECT COUNT(*)::int FROM platform_bom WHERE source='user') AS bom_user,
        (SELECT COUNT(*)::int FROM effective_bom) AS bom_effective,
        (SELECT COUNT(DISTINCT parent_uid)::int FROM effective_bom) AS bom_parents,
        (SELECT COUNT(*)::int FROM myob_item_bom) AS bom_myob,
        (SELECT COUNT(DISTINCT parent_uid)::int FROM myob_item_bom) AS bom_myob_parents
    `),
  ]);

  /*
   * Quantity freshness. MYOB does not bump Item.LastModified on stock movement,
   * so a stale item is not a cosmetic lag — it means every quantity-derived
   * figure for that item is wrong. The items entity is always fully refreshed,
   * so a non-zero staleItems here is a bug in the sync, not a data condition,
   * and the dashboard says so loudly.
   */
  const freshness = await pool.query(`
    WITH newest AS (SELECT MAX(quantities_as_of) AS at FROM myob_items)
    SELECT
      (SELECT last_synced_at FROM sync_state WHERE entity = 'items') AS items_last_synced,
      MIN(quantities_as_of) AS oldest_quantities_as_of,
      MAX(quantities_as_of) AS newest_quantities_as_of,
      COUNT(*) FILTER (
        WHERE is_inventoried
          AND (quantities_as_of IS NULL
               OR quantities_as_of < (SELECT at FROM newest) - INTERVAL '1 hour')
      )::int AS stale_items,
      COUNT(*) FILTER (WHERE is_inventoried)::int AS inventoried_items
    FROM myob_items
  `);

  const items = await computedItems();
  const dq = {
    negativeStock: items.filter((i) => i.flags.includes("negative_stock")).length,
    stockNoCost: items.filter((i) => i.flags.includes("stock_no_cost")).length,
    inactiveWithStock: items.filter((i) => i.flags.includes("inactive_with_stock")).length,
    demandNoSupplier: items.filter((i) => i.flags.includes("no_supplier")).length,
    understatedDemand: items.filter((i) => i.flags.includes("understated_demand")).length,
  };

  return {
    entities: state.rows,
    recentRuns: runs.rows,
    counts: counts.rows[0],
    dataQuality: dq,
    freshness: freshness.rows[0],
    settings: {
      syncWindowDays: config.insights.syncWindowDays,
      syncSince: config.insights.syncSince,
      targetCoverWeeks: config.insights.targetCoverWeeks,
      syncIntervalHours: config.insights.syncIntervalHours,
    },
  };
}

/**
 * Suppliers with purchasing context and Allied-managed attributes.
 * MYOB facts (name, address, activity) + platform labels (region, lead time,
 * notes) + derived promised lead time (median PO date → promised date).
 */
export async function suppliersList(params: { q?: string } & Partial<DemandWindow>) {
  await ensureInsightsSchema();
  const win = resolveWindow(params);
  const pool = getPool();
  const result = await pool.query(`
    SELECT s.uid, s.name, s.display_id, s.is_active, s.city, s.country,
           s.phone, s.email, s.synced_at,
           m.region AS region_override, m.lead_time_days, m.notes,
           m.updated_at AS meta_updated_at,
           (SELECT COUNT(*)::int FROM myob_items i WHERE i.primary_supplier_uid = s.uid) AS primary_items,
           (SELECT COALESCE(SUM(b.total), 0)::float8 FROM myob_purchase_bills b
             WHERE b.supplier_uid = s.uid
               AND b.date <= '${win.asAt}'::date
               AND b.date >= '${win.asAt}'::date - make_interval(months => ${win.windowMonths})
           ) AS purchase_value_window,
           (SELECT COUNT(*)::int FROM myob_purchase_bills b
             WHERE b.supplier_uid = s.uid
               AND b.date <= '${win.asAt}'::date
               AND b.date >= '${win.asAt}'::date - make_interval(months => ${win.windowMonths})
           ) AS bills_window,
           po.open_value AS open_po_value, po.open_count AS open_po_count,
           lead.promised_days, lead.lead_po_count
    FROM myob_suppliers s
    LEFT JOIN platform_supplier_meta m ON m.supplier_uid = s.uid
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(o.total), 0)::float8 AS open_value, COUNT(*)::int AS open_count
      FROM myob_purchase_orders o
      WHERE o.supplier_uid = s.uid AND UPPER(COALESCE(o.status, '')) = 'OPEN'
    ) po ON TRUE
    LEFT JOIN LATERAL (
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (o.promised_date - o.date)) / 86400.0
             )::float8 AS promised_days,
             COUNT(*)::int AS lead_po_count
      FROM myob_purchase_orders o
      WHERE o.supplier_uid = s.uid
        AND o.date IS NOT NULL AND o.promised_date IS NOT NULL
        AND o.promised_date > o.date
    ) lead ON TRUE
    ORDER BY purchase_value_window DESC NULLS LAST, s.name
  `);

  // Items supplied per supplier under the effective rule (MYOB primary when
  // set, else dominant supplier inferred from purchase bills).
  const items = await computedItems();
  const suppliedCounts = new Map<string, number>();
  for (const i of items) {
    if (i.supplierUid)
      suppliedCounts.set(i.supplierUid, (suppliedCounts.get(i.supplierUid) ?? 0) + 1);
  }

  let rows = result.rows.map((r) => ({
    ...r,
    supplied_items: suppliedCounts.get(r.uid as string) ?? 0,
    auto_region: autoRegion(r.country as string | null),
    region: (r.region_override as string) ?? autoRegion(r.country as string | null),
    region_source: r.region_override
      ? "user"
      : autoRegion(r.country as string | null)
        ? "auto"
        : null,
  }));
  const q = params.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) =>
      `${r.name ?? ""} ${r.display_id ?? ""} ${r.city ?? ""} ${r.country ?? ""} ${r.region ?? ""}`
        .toLowerCase()
        .includes(q),
    );
  }
  return {
    total: rows.length,
    window: win,
    regions: SUPPLIER_REGIONS,
    suppliers: rows,
  };
}

/**
 * Every supplier known for one item, from three angles:
 *  - assigned: Allied's own records (multiple allowed, one preferred)
 *  - MYOB primary: the item-master field, if Allied ever sets it
 *  - purchase history: who has actually billed this item, with volumes and
 *    the latest price, so alternates can be confirmed from evidence
 */
export async function itemSuppliers(itemUid: string) {
  await ensureInsightsSchema();
  const pool = getPool();
  const [item, assigned, history] = await Promise.all([
    pool.query(
      `SELECT i.uid, i.number, i.name,
              i.primary_supplier_uid, i.primary_supplier_name, i.supplier_item_number
       FROM myob_items i WHERE i.uid = $1`,
      [itemUid],
    ),
    pool.query(
      `SELECT s.supplier_uid, s.is_preferred, s.supplier_item_number, s.notes, s.updated_at,
              sup.name AS supplier_name, sup.is_active, sup.country,
              m.region AS region_override
       FROM platform_item_suppliers s
       JOIN myob_suppliers sup ON sup.uid = s.supplier_uid
       LEFT JOIN platform_supplier_meta m ON m.supplier_uid = s.supplier_uid
       WHERE s.item_uid = $1
       ORDER BY s.is_preferred DESC, sup.name`,
      [itemUid],
    ),
    pool.query(
      `SELECT b.supplier_uid, b.supplier_name,
              COUNT(DISTINCT b.uid)::int AS bills,
              SUM(l.qty)::float8 AS qty,
              SUM(COALESCE(l.total, 0))::float8 AS value,
              MAX(b.date) AS last_date,
              (ARRAY_AGG(l.unit_price ORDER BY b.date DESC))[1]::float8 AS last_unit_price,
              sup.country, m.region AS region_override
       FROM myob_purchase_bill_lines l
       JOIN myob_purchase_bills b ON b.uid = l.bill_uid
       LEFT JOIN myob_suppliers sup ON sup.uid = b.supplier_uid
       LEFT JOIN platform_supplier_meta m ON m.supplier_uid = b.supplier_uid
       WHERE l.item_uid = $1 AND b.supplier_uid IS NOT NULL
       GROUP BY b.supplier_uid, b.supplier_name, sup.country, m.region
       ORDER BY value DESC`,
      [itemUid],
    ),
  ]);
  if (!item.rows.length) return null;

  const withRegion = (r: Record<string, unknown>) => ({
    ...r,
    region: (r.region_override as string) ?? autoRegion(r.country as string | null),
    region_source: r.region_override
      ? "user"
      : autoRegion(r.country as string | null)
        ? "auto"
        : null,
  });

  const assignedUids = new Set(assigned.rows.map((r) => r.supplier_uid as string));
  return {
    item: item.rows[0],
    assigned: assigned.rows.map(withRegion),
    // Suppliers seen in bills that Allied has not recorded yet — one click to add.
    history: history.rows.map((r) => ({
      ...withRegion(r),
      already_assigned: assignedUids.has(r.supplier_uid as string),
    })),
  };
}

/** Add or update one Allied supplier record for an item. */
export async function setItemSupplier(
  itemUid: string,
  supplierUid: string,
  patch: { isPreferred?: boolean; supplierItemNumber?: string | null; notes?: string | null },
): Promise<void> {
  await ensureInsightsSchema();
  const pool = getPool();
  const exists = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM myob_items WHERE uid = $1) AS item,
            (SELECT COUNT(*)::int FROM myob_suppliers WHERE uid = $2) AS supplier`,
    [itemUid, supplierUid],
  );
  if (!Number(exists.rows[0].item)) throw new Error("Item not found in synced data.");
  if (!Number(exists.rows[0].supplier)) throw new Error("Supplier not found in synced data.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Only one preferred supplier per item (a partial unique index enforces it).
    if (patch.isPreferred) {
      await client.query(
        `UPDATE platform_item_suppliers SET is_preferred = FALSE, updated_at = NOW()
         WHERE item_uid = $1 AND supplier_uid <> $2 AND is_preferred`,
        [itemUid, supplierUid],
      );
    }
    const notes = patch.notes === undefined ? null : (patch.notes?.trim().slice(0, 500) || null);
    const ref =
      patch.supplierItemNumber === undefined
        ? null
        : (patch.supplierItemNumber?.trim().slice(0, 100) || null);
    await client.query(
      `INSERT INTO platform_item_suppliers
         (item_uid, supplier_uid, is_preferred, supplier_item_number, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (item_uid, supplier_uid) DO UPDATE SET
         is_preferred = CASE WHEN $6 THEN $3 ELSE platform_item_suppliers.is_preferred END,
         supplier_item_number = CASE WHEN $7 THEN $4 ELSE platform_item_suppliers.supplier_item_number END,
         notes = CASE WHEN $8 THEN $5 ELSE platform_item_suppliers.notes END,
         updated_at = NOW()`,
      [
        itemUid,
        supplierUid,
        patch.isPreferred ?? false,
        ref,
        notes,
        patch.isPreferred !== undefined,
        patch.supplierItemNumber !== undefined,
        patch.notes !== undefined,
      ],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  invalidateItemsCache();
}

export async function removeItemSupplier(
  itemUid: string,
  supplierUid: string,
): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(
    `DELETE FROM platform_item_suppliers WHERE item_uid = $1 AND supplier_uid = $2`,
    [itemUid, supplierUid],
  );
  invalidateItemsCache();
}

/**
 * Supplier picker source. Allied has a few hundred suppliers, so the whole
 * list is returned once and filtered as the user types — no round trip per
 * keystroke, and an empty search still shows everyone.
 */
export async function supplierOptions(q: string | undefined) {
  await ensureInsightsSchema();
  const term = `%${(q ?? "").trim()}%`;
  const result = await getPool().query(
    `SELECT s.uid, s.name, s.is_active, s.country, s.display_id,
            m.region AS region_override
     FROM myob_suppliers s
     LEFT JOIN platform_supplier_meta m ON m.supplier_uid = s.uid
     WHERE $1 = '%%' OR s.name ILIKE $1 OR COALESCE(s.display_id,'') ILIKE $1
     ORDER BY s.is_active DESC NULLS LAST, s.name`,
    [term],
  );
  return {
    suppliers: result.rows.map((r) => ({
      ...r,
      region: (r.region_override as string) ?? autoRegion(r.country as string | null),
    })),
  };
}

export async function setSupplierMeta(
  supplierUid: string,
  patch: { region?: string | null; leadTimeDays?: number | null; notes?: string | null },
): Promise<void> {
  await ensureInsightsSchema();
  const pool = getPool();
  const exists = await pool.query(`SELECT 1 FROM myob_suppliers WHERE uid = $1`, [supplierUid]);
  if (!exists.rows.length) throw new Error("Supplier not found in synced data.");

  if (patch.region != null && patch.region !== "" &&
      !SUPPLIER_REGIONS.includes(patch.region as SupplierRegion)) {
    throw new Error(`Region must be one of: ${SUPPLIER_REGIONS.join(", ")} (or empty for auto).`);
  }
  const region = patch.region === "" ? null : (patch.region ?? undefined);
  if (patch.leadTimeDays != null && !(patch.leadTimeDays > 0 && patch.leadTimeDays <= 365)) {
    throw new Error("leadTimeDays must be between 1 and 365, or null to clear.");
  }
  const notes =
    patch.notes === undefined ? undefined : (patch.notes?.trim().slice(0, 500) || null);

  // COALESCE-based partial update: only fields present in the patch change.
  await pool.query(
    `INSERT INTO platform_supplier_meta (supplier_uid, region, lead_time_days, notes, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (supplier_uid) DO UPDATE SET
       region = CASE WHEN $5 THEN $2 ELSE platform_supplier_meta.region END,
       lead_time_days = CASE WHEN $6 THEN $3 ELSE platform_supplier_meta.lead_time_days END,
       notes = CASE WHEN $7 THEN $4 ELSE platform_supplier_meta.notes END,
       updated_at = NOW()`,
    [
      supplierUid,
      region ?? null,
      patch.leadTimeDays ?? null,
      notes ?? null,
      patch.region !== undefined,
      patch.leadTimeDays !== undefined,
      patch.notes !== undefined,
    ],
  );
  invalidateItemsCache();
}

/** True when adding parent→component would create a loop, i.e. the parent is
 * already reachable from the component through the effective BOM. */
async function wouldCreateCycle(
  parentUid: string,
  componentUid: string,
): Promise<boolean> {
  const result = await getPool().query(
    `WITH RECURSIVE walk AS (
       SELECT component_uid AS node, 1 AS depth FROM effective_bom WHERE parent_uid = $1
       UNION ALL
       SELECT b.component_uid, w.depth + 1
       FROM effective_bom b JOIN walk w ON b.parent_uid = w.node
       WHERE w.depth < 8
     )
     SELECT 1 FROM walk WHERE node = $2 LIMIT 1`,
    [componentUid, parentUid],
  );
  return result.rows.length > 0;
}

export async function addUserBom(
  parentUid: string,
  componentUid: string,
  qtyPer: number,
): Promise<void> {
  await ensureInsightsSchema();
  if (parentUid === componentUid) throw new Error("An item cannot contain itself.");
  if (!(qtyPer > 0)) throw new Error("qtyPer must be positive.");
  const pool = getPool();
  const exists = await pool.query(
    `SELECT COUNT(*)::int AS c FROM myob_items WHERE uid = ANY($1)`,
    [[parentUid, componentUid]],
  );
  if (Number(exists.rows[0].c) !== 2)
    throw new Error("Both items must exist in the synced item list.");
  if (await wouldCreateCycle(parentUid, componentUid))
    throw new Error("That relationship would create a loop (the component already contains the parent).");
  await pool.query(
    `INSERT INTO platform_bom (parent_uid, component_uid, source, qty_per, confidence, updated_at)
     VALUES ($1, $2, 'user', $3, 1.0, NOW())
     ON CONFLICT (parent_uid, component_uid, source)
     DO UPDATE SET qty_per = EXCLUDED.qty_per, updated_at = NOW()`,
    [parentUid, componentUid, qtyPer],
  );
  invalidateItemsCache();
}

export async function removeUserBom(
  parentUid: string,
  componentUid: string,
): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(
    `DELETE FROM platform_bom WHERE parent_uid = $1 AND component_uid = $2 AND source = 'user'`,
    [parentUid, componentUid],
  );
  invalidateItemsCache();
}

// ---- Bulk BOM import (user rows only; preview before commit) ----

export interface BomImportInputRow {
  parent: string;
  component: string;
  qtyPer: number;
}

export interface BomImportRowResult {
  idx: number;
  parent: string;
  component: string;
  qtyPer: number;
  status: "ok" | "error";
  action: "new" | "update" | "override_derived" | null;
  detail: string;
  parentName?: string | null;
  componentName?: string | null;
}

const BOM_IMPORT_MAX_ROWS = 2000;

/**
 * Validate (and optionally apply) a batch of user BOM rows.
 * Never touches derived rows; committed rows land as source='user' and win
 * over derived rows via the effective_bom view. Preview (commit=false)
 * returns exactly what commit would do, row by row.
 */
export async function bomImport(
  input: BomImportInputRow[],
  commit: boolean,
): Promise<{
  commit: boolean;
  applied: number;
  okCount: number;
  errorCount: number;
  rows: BomImportRowResult[];
}> {
  await ensureInsightsSchema();
  if (input.length > BOM_IMPORT_MAX_ROWS)
    throw new Error(`Too many rows (max ${BOM_IMPORT_MAX_ROWS} per import).`);
  const pool = getPool();

  // Resolve item numbers case-insensitively in one query.
  const numbers = [
    ...new Set(
      input.flatMap((r) => [r.parent?.trim().toUpperCase(), r.component?.trim().toUpperCase()])
        .filter(Boolean),
    ),
  ];
  const itemsResult = numbers.length
    ? await pool.query(
        `SELECT uid, number, name FROM myob_items WHERE UPPER(number) = ANY($1)`,
        [numbers],
      )
    : { rows: [] as Record<string, unknown>[] };
  const byNumber = new Map<string, { uid: string; number: string; name: string | null }[]>();
  for (const r of itemsResult.rows) {
    const key = String(r.number).toUpperCase();
    if (!byNumber.has(key)) byNumber.set(key, []);
    byNumber.get(key)!.push({ uid: String(r.uid), number: String(r.number), name: (r.name as string) ?? null });
  }

  // Existing rows for the referenced pairs (user + derived).
  const existing = await pool.query(
    `SELECT parent_uid, component_uid, source, qty_per::float8 AS qty_per, build_count
     FROM platform_bom`,
  );
  const userRows = new Map<string, number>();
  const derivedRows = new Map<string, { qty: number; builds: number }>();
  for (const r of existing.rows) {
    const key = `${r.parent_uid}|${r.component_uid}`;
    if (r.source === "user") userRows.set(key, Number(r.qty_per));
    else derivedRows.set(key, { qty: Number(r.qty_per), builds: Number(r.build_count) });
  }

  const results: BomImportRowResult[] = [];
  const lastOccurrence = new Map<string, number>(); // pair key -> last row idx
  const resolved: ({ parentUid: string; componentUid: string } | null)[] = [];

  input.forEach((row, idx) => {
    const parentKey = row.parent?.trim().toUpperCase() ?? "";
    const componentKey = row.component?.trim().toUpperCase() ?? "";
    const res: BomImportRowResult = {
      idx,
      parent: row.parent?.trim() ?? "",
      component: row.component?.trim() ?? "",
      qtyPer: row.qtyPer,
      status: "error",
      action: null,
      detail: "",
    };
    results.push(res);
    resolved.push(null);

    const parents = byNumber.get(parentKey) ?? [];
    const components = byNumber.get(componentKey) ?? [];
    if (!parentKey || !componentKey) return void (res.detail = "Missing item number.");
    if (!Number.isFinite(row.qtyPer) || row.qtyPer <= 0)
      return void (res.detail = "Qty per unit must be a positive number.");
    if (!parents.length) return void (res.detail = `Parent "${res.parent}" not found in synced items.`);
    if (parents.length > 1) return void (res.detail = `Parent "${res.parent}" is ambiguous (${parents.length} items).`);
    if (!components.length) return void (res.detail = `Component "${res.component}" not found in synced items.`);
    if (components.length > 1) return void (res.detail = `Component "${res.component}" is ambiguous.`);
    const parentUid = parents[0].uid;
    const componentUid = components[0].uid;
    res.parentName = parents[0].name;
    res.componentName = components[0].name;
    if (parentUid === componentUid) return void (res.detail = "An item cannot contain itself.");

    const pairKey = `${parentUid}|${componentUid}`;
    lastOccurrence.set(pairKey, idx);
    resolved[idx] = { parentUid, componentUid };
    res.status = "ok";
  });

  // Within-batch duplicates: last occurrence wins, earlier become errors.
  results.forEach((res, idx) => {
    const r = resolved[idx];
    if (!r || res.status !== "ok") return;
    const pairKey = `${r.parentUid}|${r.componentUid}`;
    if (lastOccurrence.get(pairKey) !== idx) {
      res.status = "error";
      res.detail = `Duplicate of row ${lastOccurrence.get(pairKey)! + 1} (last occurrence wins).`;
      resolved[idx] = null;
    }
  });

  // Cycle check against existing effective BOM (memoised per pair).
  for (let idx = 0; idx < results.length; idx++) {
    const res = results[idx];
    const r = resolved[idx];
    if (!r || res.status !== "ok") continue;
    if (await wouldCreateCycle(r.parentUid, r.componentUid)) {
      res.status = "error";
      res.detail = "Would create a loop: the component already contains this parent.";
      resolved[idx] = null;
      continue;
    }
    const pairKey = `${r.parentUid}|${r.componentUid}`;
    if (userRows.has(pairKey)) {
      res.action = "update";
      const prev = userRows.get(pairKey)!;
      res.detail =
        prev === res.qtyPer
          ? "Unchanged (same qty already entered)."
          : `Updates existing Allied row (was ${prev}).`;
    } else if (derivedRows.has(pairKey)) {
      const d = derivedRows.get(pairKey)!;
      res.action = "override_derived";
      res.detail = `Overrides derived qty ${d.qty.toFixed(2)} (observed across ${d.builds} build${d.builds === 1 ? "" : "s"}).`;
    } else {
      res.action = "new";
      res.detail = "New relationship.";
    }
  }

  const okRows = results.filter((r) => r.status === "ok");
  let applied = 0;
  if (commit && okRows.length) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const res of okRows) {
        const r = resolved[res.idx]!;
        await client.query(
          `INSERT INTO platform_bom (parent_uid, component_uid, source, qty_per, confidence, updated_at)
           VALUES ($1, $2, 'user', $3, 1.0, NOW())
           ON CONFLICT (parent_uid, component_uid, source)
           DO UPDATE SET qty_per = EXCLUDED.qty_per, updated_at = NOW()`,
          [r.parentUid, r.componentUid, res.qtyPer],
        );
        applied++;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    invalidateItemsCache();
  }

  return {
    commit,
    applied,
    okCount: okRows.length,
    errorCount: results.length - okRows.length,
    rows: results,
  };
}

/**
 * Blind-spot worklist: items that sold inside the wider look-back, look like
 * assembled products (name/number heuristic — labelled as such in the UI), and
 * have no known composition in the effective BOM. Sits on the Products page,
 * so it answers to the same date and window controls as everything there.
 */
export async function bomBlindspots(opts?: Partial<DemandWindow>) {
  await ensureInsightsSchema();
  const win = resolveWindow(opts);
  const result = await getPool().query(`
    WITH sold AS (
      SELECT l.item_uid,
             COALESCE(SUM(l.qty) FILTER (
               WHERE si.date >= '${win.asAt}'::date - make_interval(months => ${win.windowMonths})
             ), 0)::float8 AS sold_window,
             COALESCE(SUM(l.qty), 0)::float8 AS sold_long
      FROM myob_sale_invoice_lines l
      JOIN myob_sale_invoices si ON si.uid = l.invoice_uid
      WHERE si.date <= '${win.asAt}'::date
        AND si.date >= '${win.asAt}'::date - make_interval(months => ${win.longMonths})
        AND l.item_uid IS NOT NULL
      GROUP BY l.item_uid
    )
    SELECT i.uid, i.number, i.name,
           COALESCE(p.free_stock, 0)::float8 AS stock_free,
           s.sold_window, s.sold_long,
           COUNT(*) OVER ()::int AS total_count
    FROM myob_items i
    JOIN item_position_at('${win.asAt}'::date) p ON p.item_uid = i.uid
    JOIN sold s ON s.item_uid = i.uid AND s.sold_long > 0
    WHERE i.is_active IS NOT FALSE
      AND COALESCE(i.is_sold, TRUE)
      AND NOT EXISTS (SELECT 1 FROM effective_bom b WHERE b.parent_uid = i.uid)
      AND (i.name ~* '(pack|kit|dressing|assembl)' OR i.number ~* '^(BP|DS)')
    ORDER BY s.sold_window DESC, s.sold_long DESC
    LIMIT 100
  `);
  return {
    window: win,
    heuristic:
      `Active items sold in the ${win.longMonths} months to ${win.asAt} whose name contains pack/kit/dressing/assembly (or number starts BP/DS) and that have no known composition.`,
    total: result.rows.length ? Number(result.rows[0].total_count) : 0,
    items: result.rows.map(({ total_count, ...r }) => r),
  };
}


/**
 * Every value each facet actually holds, with counts — the input to the filter
 * menus.
 *
 * Nothing is suppressed. The brief assumed only galvanised and stainless were
 * live, but the data disagrees (ZINC PLATED alone is on 381 items), so the
 * choice of what matters is Allied's to make from real numbers rather than ours
 * to hardcode. Items with no value are surfaced as "(not set)" so they stay
 * reachable.
 */
export async function facetValues(): Promise<{
  productType: { value: string; items: number; withStock: number }[];
  productFinish: { value: string; items: number; withStock: number }[];
  tags: { value: string; items: number }[];
}> {
  await ensureInsightsSchema();
  const pool = getPool();
  const facet = async (column: "product_type" | "product_finish") => {
    const r = await pool.query(
      `SELECT COALESCE(NULLIF(i.${column}, ''), '(not set)') AS value,
              COUNT(*)::int AS items,
              COUNT(*) FILTER (WHERE p.on_hand > 0)::int AS with_stock
       FROM myob_items i
       LEFT JOIN item_position p ON p.item_uid = i.uid
       GROUP BY 1 ORDER BY 2 DESC`,
    );
    return r.rows.map((x) => ({
      value: x.value as string,
      items: x.items as number,
      withStock: x.with_stock as number,
    }));
  };
  const tags = await pool.query(
    `SELECT t.tag AS value, COUNT(*)::int AS items
     FROM platform_item_tags t
     GROUP BY t.tag ORDER BY 2 DESC, 1`,
  );
  return {
    productType: await facet("product_type"),
    productFinish: await facet("product_finish"),
    tags: tags.rows.map((x) => ({ value: x.value as string, items: x.items as number })),
  };
}

/** Add a tag to an item. Case-insensitive, so one tag cannot become two. */
export async function addItemTag(params: {
  itemUid: string;
  tag: string;
  createdBy?: string | null;
}): Promise<{ tag: string }> {
  await ensureInsightsSchema();
  const tag = params.tag.trim().replace(/\s+/g, " ");
  if (!tag) throw new Error("Tag cannot be empty.");
  if (tag.length > 60) throw new Error("Tag must be 60 characters or fewer.");
  await getPool().query(
    `INSERT INTO platform_item_tags (item_uid, tag_key, tag, created_by)
     VALUES ($1, LOWER($2), $2, $3)
     ON CONFLICT (item_uid, tag_key) DO UPDATE SET tag = EXCLUDED.tag`,
    [params.itemUid, tag, params.createdBy ?? null],
  );
  return { tag };
}

export async function removeItemTag(itemUid: string, tag: string): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(
    `DELETE FROM platform_item_tags WHERE item_uid = $1 AND tag_key = LOWER($2)`,
    [itemUid, tag],
  );
}

/* ---- Seeding multi-supplier tagging from real purchase history ---- */

export interface SupplierSuggestion {
  itemUid: string;
  itemNumber: string | null;
  itemName: string | null;
  productFinish: string | null;
  suppliers: {
    supplierUid: string;
    supplierName: string | null;
    bills: number;
    qty: number;
    value: number;
    sharePct: number;
    lastBought: string;
    isMyobPrimary: boolean;
    preferred: boolean;
  }[];
}

/**
 * Items Allied have genuinely bought from more than one supplier, read from
 * purchase-bill history.
 *
 * The multi-supplier cart (P6) has nothing to work with until items carry more
 * than one supplier, and asking Allied to tag 264 items by hand is work they
 * have already done once — every one of those sourcing decisions is recorded in
 * their own purchase history.
 *
 * Two thresholds keep it honest rather than noisy:
 *
 *  - **share** — a supplier must account for at least `minSharePct` of that
 *    item's purchase spend. BN12110G has eight suppliers on paper, but two of
 *    them are single top-ups of 34 and 12 units at 0.1% of spend. Those are not
 *    sourcing options, they are what someone grabbed when they ran short.
 *  - **recency** — bought within `withinYears`, so a supplier Allied stopped
 *    using years ago is not presented as a live choice.
 *
 * This is inference from history, not a statement of fact, so every row is
 * labelled as such and Allied can remove any of them.
 */
export async function suggestSuppliersFromHistory(opts?: {
  minSharePct?: number;
  withinYears?: number;
}): Promise<SupplierSuggestion[]> {
  await ensureInsightsSchema();
  const minShare = opts?.minSharePct ?? 5;
  const withinYears = opts?.withinYears ?? 2;

  const result = await getPool().query(
    `WITH buys AS (
       SELECT l.item_uid, b.supplier_uid,
              COUNT(*)::int AS bills,
              SUM(l.qty)::float8 AS qty,
              SUM(COALESCE(l.total, 0))::float8 AS value,
              MAX(b.date)::date AS last_bought
       FROM myob_purchase_bill_lines l
       JOIN myob_purchase_bills b ON b.uid = l.bill_uid
       WHERE l.item_uid IS NOT NULL AND b.supplier_uid IS NOT NULL AND l.qty > 0
       GROUP BY 1, 2
     ),
     shared AS (
       SELECT *,
              100.0 * value / NULLIF(SUM(value) OVER (PARTITION BY item_uid), 0) AS share_pct
       FROM buys
     ),
     qualifying AS (
       SELECT * FROM shared
       WHERE share_pct >= $1
         AND last_bought > (CURRENT_DATE - make_interval(years => $2))
     ),
     multi AS (
       SELECT item_uid FROM qualifying GROUP BY item_uid HAVING COUNT(*) > 1
     )
     SELECT q.item_uid, i.number AS item_number, i.name AS item_name,
            i.product_finish, q.supplier_uid, s.name AS supplier_name,
            q.bills, q.qty, q.value, q.share_pct, q.last_bought::text AS last_bought,
            (i.primary_supplier_uid = q.supplier_uid) AS is_myob_primary
     FROM qualifying q
     JOIN multi m ON m.item_uid = q.item_uid
     JOIN myob_items i ON i.uid = q.item_uid
     LEFT JOIN myob_suppliers s ON s.uid = q.supplier_uid
     ORDER BY i.number, q.value DESC`,
    [minShare, withinYears],
  );

  const byItem = new Map<string, SupplierSuggestion>();
  for (const r of result.rows) {
    const uid = r.item_uid as string;
    if (!byItem.has(uid)) {
      byItem.set(uid, {
        itemUid: uid,
        itemNumber: r.item_number as string | null,
        itemName: r.item_name as string | null,
        productFinish: r.product_finish as string | null,
        suppliers: [],
      });
    }
    byItem.get(uid)!.suppliers.push({
      supplierUid: r.supplier_uid as string,
      supplierName: r.supplier_name as string | null,
      bills: r.bills as number,
      qty: Number(r.qty),
      value: Number(r.value),
      sharePct: Number(Number(r.share_pct).toFixed(1)),
      lastBought: r.last_bought as string,
      isMyobPrimary: Boolean(r.is_myob_primary),
      preferred: false,
    });
  }

  // Preferred is MYOB's own primary supplier where Allied have set one — that is
  // their stated choice. Otherwise the supplier they have spent the most with.
  for (const s of byItem.values()) {
    const chosen = s.suppliers.find((x) => x.isMyobPrimary) ?? s.suppliers[0];
    if (chosen) chosen.preferred = true;
  }
  return [...byItem.values()];
}

/**
 * Write the suggestions into `platform_item_suppliers`.
 *
 * Never overwrites a row Allied created: existing pairs keep their preferred
 * flag and notes. Seeding is a starting point, not an authority.
 */
export async function applySupplierSuggestions(opts?: {
  minSharePct?: number;
  withinYears?: number;
}): Promise<{ items: number; links: number; skippedExisting: number }> {
  const suggestions = await suggestSuppliersFromHistory(opts);
  const pool = getPool();

  // One statement rather than a round-trip per link: 641 sequential inserts
  // against a remote database took minutes and timed out.
  const rows = suggestions.flatMap((s) =>
    s.suppliers.map((sup) => [
      s.itemUid,
      sup.supplierUid,
      sup.preferred,
      `Suggested from purchase history: ${sup.bills} bill(s), ${Math.round(sup.qty)} units, ${sup.sharePct}% of spend, last bought ${sup.lastBought}.`,
    ]),
  );
  if (!rows.length) return { items: 0, links: 0, skippedExisting: 0 };

  const values: unknown[] = [];
  const tuples = rows
    .map((r, i) => {
      values.push(...r);
      const b = i * 4;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},NOW())`;
    })
    .join(",");
  const res = await pool.query(
    `INSERT INTO platform_item_suppliers
       (item_uid, supplier_uid, is_preferred, notes, updated_at)
     VALUES ${tuples}
     ON CONFLICT (item_uid, supplier_uid) DO NOTHING`,
    values,
  );
  const links = res.rowCount ?? 0;
  invalidateItemsCache();
  return { items: suggestions.length, links, skippedExisting: rows.length - links };
}

/* ---- Inferring supplier region from the details Allied already hold ---- */

export interface RegionSuggestion {
  supplierUid: string;
  name: string | null;
  region: SupplierRegion | null;
  /** Each signal that fired, so the conclusion can be checked rather than trusted. */
  evidence: string[];
  /** Left null when signals conflict or none fire — never guessed. */
  conflict: boolean;
  bills: number;
  purchaseValue: number;
}

/**
 * Work out where a supplier is from the details already on their MYOB card.
 *
 * Only 37 of 292 suppliers have a country set, but 242 have an email, 276 a
 * phone and 250 a city — and for a New Zealand wholesaler those are strong
 * signals. `accounts@anzor.co.nz` with an Auckland address and an 09 number is
 * not ambiguous.
 *
 * Signals are gathered independently and only agreed conclusions are kept.
 * Where they disagree — an Auckland branch of an Australian firm carrying a
 * .com.au address — the region is left unset rather than guessed, because a
 * wrong region silently misstates Allied's China-versus-NZ exposure, which is
 * one of the questions the Overview exists to answer.
 */
export async function suggestSupplierRegions(): Promise<RegionSuggestion[]> {
  await ensureInsightsSchema();
  const result = await getPool().query(
    `SELECT s.uid, s.name, s.country, s.city, s.email, s.phone,
            COALESCE(b.bills, 0)::int AS bills,
            COALESCE(b.value, 0)::float8 AS purchase_value,
            m.region AS existing_region
     FROM myob_suppliers s
     LEFT JOIN (
       SELECT supplier_uid, COUNT(*)::int AS bills, SUM(COALESCE(total, 0)) AS value
       FROM myob_purchase_bills WHERE supplier_uid IS NOT NULL GROUP BY 1
     ) b ON b.supplier_uid = s.uid
     LEFT JOIN platform_supplier_meta m ON m.supplier_uid = s.uid
     ORDER BY COALESCE(b.value, 0) DESC`,
  );

  const NZ_CITIES = [
    "auckland", "wellington", "christchurch", "hamilton", "tauranga", "dunedin",
    "napier", "palmerston north", "nelson", "rotorua", "whangarei", "invercargill",
    "new plymouth", "manukau", "north shore", "waitakere", "rolleston", "porirua",
    "hastings", "gisborne", "timaru", "blenheim", "masterton", "levin", "pukekohe",
    "papakura", "takanini", "penrose", "onehunga", "mt wellington", "east tamaki",
  ];
  const AU_CITIES = [
    "sydney", "melbourne", "brisbane", "perth", "adelaide", "canberra",
    "newcastle", "wollongong", "geelong", "gold coast", "darwin", "hobart",
  ];
  const CN_CITIES = [
    "shanghai", "beijing", "shenzhen", "guangzhou", "ningbo", "qingdao",
    "tianjin", "hangzhou", "suzhou", "dongguan", "xiamen", "wenzhou", "handan",
    "shandong", "jiangsu", "zhejiang", "hebei",
  ];

  return result.rows.map((r) => {
    const evidence: string[] = [];
    const votes = new Set<SupplierRegion>();
    const add = (region: SupplierRegion, why: string) => {
      votes.add(region);
      evidence.push(why);
    };

    const country = (r.country as string | null)?.trim();
    if (country) {
      // autoRegion matches exact names; Allied's values are inconsistently cased
      // and include a typo ("Tawain"), so normalise before asking.
      const normalised = country.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
      const reg =
        normalised.includes("new zealand") ? "NZ"
        : normalised.includes("australia") ? "Australia"
        : normalised.includes("china") ? "China"
        : autoRegion(normalised) ?? "Overseas — other";
      add(reg as SupplierRegion, `Country on the MYOB card: ${country}`);
    }

    const email = ((r.email as string | null) ?? "").toLowerCase();
    if (email.includes("@")) {
      if (/\.nz(\b|$)/.test(email)) add("NZ", `Email domain ends .nz (${email})`);
      else if (/\.au(\b|$)/.test(email)) add("Australia", `Email domain ends .au (${email})`);
      else if (/\.cn(\b|$)/.test(email)) add("China", `Email domain ends .cn (${email})`);
    }

    const phone = ((r.phone as string | null) ?? "").replace(/[^\d+]/g, "");
    if (phone) {
      if (/^\+?64/.test(phone)) add("NZ", `Phone begins +64 (${r.phone})`);
      else if (/^\+?61/.test(phone)) add("Australia", `Phone begins +61 (${r.phone})`);
      else if (/^\+?86/.test(phone)) add("China", `Phone begins +86 (${r.phone})`);
      // Bare NZ landline/mobile prefixes, which is how Allied record local numbers.
      else if (/^0(3|4|6|7|9|21|22|27)/.test(phone)) add("NZ", `New Zealand dialling code (${r.phone})`);
    }

    const city = ((r.city as string | null) ?? "").toLowerCase().trim();
    if (city) {
      if (NZ_CITIES.some((c) => city.includes(c))) add("NZ", `City is in New Zealand: ${r.city}`);
      else if (AU_CITIES.some((c) => city.includes(c))) add("Australia", `City is in Australia: ${r.city}`);
      else if (CN_CITIES.some((c) => city.includes(c))) add("China", `City is in China: ${r.city}`);
    }

    const conflict = votes.size > 1;
    return {
      supplierUid: r.uid as string,
      name: r.name as string | null,
      region: conflict || votes.size === 0 ? null : [...votes][0],
      evidence,
      conflict,
      bills: r.bills as number,
      purchaseValue: Number(r.purchase_value),
    };
  });
}

/**
 * Store the confident conclusions. Anything conflicting or unevidenced is left
 * alone, and a region Allied set by hand is never overwritten.
 */
export async function applySupplierRegions(): Promise<{
  assigned: number;
  skippedConflict: number;
  skippedNoSignal: number;
  skippedExisting: number;
}> {
  const suggestions = await suggestSupplierRegions();
  const pool = getPool();
  const confident = suggestions.filter((s) => s.region && !s.conflict);
  if (!confident.length) {
    return {
      assigned: 0,
      skippedConflict: suggestions.filter((s) => s.conflict).length,
      skippedNoSignal: suggestions.filter((s) => !s.region && !s.conflict).length,
      skippedExisting: 0,
    };
  }

  const values: unknown[] = [];
  const tuples = confident
    .map((s, i) => {
      values.push(s.supplierUid, s.region);
      const b = i * 2;
      return `($${b + 1},$${b + 2},NOW())`;
    })
    .join(",");
  const res = await pool.query(
    `INSERT INTO platform_supplier_meta (supplier_uid, region, updated_at)
     VALUES ${tuples}
     ON CONFLICT (supplier_uid) DO UPDATE SET
       region = COALESCE(platform_supplier_meta.region, EXCLUDED.region),
       updated_at = CASE WHEN platform_supplier_meta.region IS NULL THEN NOW()
                         ELSE platform_supplier_meta.updated_at END`,
    values,
  );
  invalidateItemsCache();
  return {
    assigned: res.rowCount ?? 0,
    skippedConflict: suggestions.filter((s) => s.conflict).length,
    skippedNoSignal: suggestions.filter((s) => !s.region && !s.conflict).length,
    skippedExisting: confident.length - (res.rowCount ?? 0),
  };
}

/**
 * The inventory list as a spreadsheet, honouring whatever filters are applied.
 *
 * The brief asks for an export on every view this work touches, because Allied's
 * whole existing workflow lives in spreadsheets — a number they cannot get out
 * of the tool is a number they will go back to Excel to recreate. Exporting the
 * *filtered* list matters: "stainless washers below minimum" is the view they
 * built, so that is what should land in the file.
 */
export async function itemsCsv(params: ListParams): Promise<string> {
  const data = await listItems({ ...params, all: true });
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(Number(v.toFixed(4))) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const header = [
    "Item number", "Item name", "Product type", "Product finish", "Tags",
    "Supplier", "Supplier source", "Region",
    "On hand", "Committed", "Free stock", "On order", "Available",
    "Average cost", "Stock value", "Min level",
    "Weekly demand", "Demand window (months)", "Demand basis", "Cover (weeks)",
    "Suggested order qty", "Risk score", "Flags",
    "Reference point", "Reference date", "MYOB on hand", "Difference vs MYOB",
  ];
  const lines = [header.join(",")];
  for (const i of data.items) {
    lines.push([
      esc(i.number), esc(i.name), esc(i.productType), esc(i.productFinish),
      esc(i.tags.join(" ")),
      esc(i.supplierName), esc(i.supplierSource), esc(i.supplierRegion),
      esc(i.qtyOnHand), esc(i.qtyCommitted), esc(i.qtyFreeStock),
      esc(i.qtyOnOrder), esc(i.qtyAvailable),
      esc(i.averageCost), esc(i.currentValue), esc(i.minLevel),
      esc(i.demand.weekly), esc(i.demand.windowMonths), esc(i.demand.basis),
      esc(i.coverWeeks), esc(i.suggestion?.qty ?? 0), esc(i.risk.score),
      esc(i.flags.join(" ")),
      esc(i.anchorSource), esc(i.anchorDate), esc(i.myobOnHand), esc(i.divergence),
    ].join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** The supplier list as a spreadsheet, with the measured lead time. */
export async function suppliersCsv(): Promise<string> {
  await ensureInsightsSchema();
  const r = await getPool().query(
    `SELECT s.name, s.display_id, s.city, s.country, s.email, s.phone,
            m.region, l.median_lead_days, l.orders_measured, l.same_day_excluded,
            COALESCE(b.bills, 0)::int AS bills,
            COALESCE(b.value, 0)::float8 AS purchase_value,
            COALESCE(pi.items, 0)::int AS items_tagged,
            (SELECT COUNT(*)::int FROM myob_items i WHERE i.primary_supplier_uid = s.uid) AS items_myob_primary
     FROM myob_suppliers s
     LEFT JOIN platform_supplier_meta m ON m.supplier_uid = s.uid
     LEFT JOIN supplier_lead_time l ON l.supplier_uid = s.uid
     LEFT JOIN (SELECT supplier_uid, COUNT(*)::int AS bills, SUM(COALESCE(total,0)) AS value
                FROM myob_purchase_bills WHERE supplier_uid IS NOT NULL GROUP BY 1) b
       ON b.supplier_uid = s.uid
     LEFT JOIN (SELECT supplier_uid, COUNT(*)::int AS items
                FROM platform_item_suppliers GROUP BY 1) pi ON pi.supplier_uid = s.uid
     ORDER BY COALESCE(b.value, 0) DESC`,
  );
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const header = [
    "Supplier", "MYOB ID", "City", "Country", "Region", "Email", "Phone",
    "Lead time (days)", "Orders measured", "Same-day ignored",
    "Bills", "Purchase value", "Items tagged here", "Items where MYOB primary",
  ];
  const lines = [header.join(",")];
  for (const s of r.rows) {
    lines.push([
      esc(s.name), esc(s.display_id), esc(s.city), esc(s.country), esc(s.region),
      esc(s.email), esc(s.phone),
      esc(s.median_lead_days), esc(s.orders_measured), esc(s.same_day_excluded),
      esc(s.bills), esc(Number(s.purchase_value).toFixed(2)),
      esc(s.items_tagged), esc(s.items_myob_primary),
    ].join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
