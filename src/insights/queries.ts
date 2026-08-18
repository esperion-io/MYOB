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

const DEMAND_CTE = `
  direct_demand AS (
    SELECT l.item_uid,
           COALESCE(SUM(l.qty) FILTER (WHERE i.date >= NOW() - INTERVAL '90 days'), 0)::float8 AS direct_90,
           COALESCE(SUM(l.qty), 0)::float8 AS direct_365
    FROM myob_sale_invoice_lines l
    JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
    WHERE i.date >= NOW() - INTERVAL '365 days' AND l.item_uid IS NOT NULL
    GROUP BY l.item_uid
  ),
  component_demand AS (
    SELECT bl.item_uid,
           COALESCE(SUM(-bl.qty) FILTER (WHERE b.date >= NOW() - INTERVAL '90 days'), 0)::float8 AS comp_90,
           COALESCE(SUM(-bl.qty), 0)::float8 AS comp_365
    FROM myob_build_lines bl
    JOIN myob_builds b ON b.uid = bl.build_uid
    WHERE bl.qty < 0 AND bl.item_uid IS NOT NULL
      AND b.date >= NOW() - INTERVAL '365 days'
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
           COALESCE(SUM(bl.qty) FILTER (WHERE b.date >= NOW() - INTERVAL '90 days'), 0)::float8 AS built_90
    FROM myob_build_lines bl
    JOIN myob_builds b ON b.uid = bl.build_uid
    WHERE bl.qty > 0 AND bl.item_uid IS NOT NULL
      AND b.date >= NOW() - INTERVAL '365 days'
    GROUP BY bl.item_uid
  ),
  purchased_qty AS (
    SELECT l.item_uid,
           COALESCE(SUM(l.qty) FILTER (WHERE b.date >= NOW() - INTERVAL '90 days'), 0)::float8 AS bought_90
    FROM myob_purchase_bill_lines l
    JOIN myob_purchase_bills b ON b.uid = l.bill_uid
    WHERE l.item_uid IS NOT NULL AND b.date >= NOW() - INTERVAL '365 days'
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
             COALESCE(dd.direct_90, 0) - COALESCE(bo.built_90, 0) - COALESCE(pq.bought_90, 0),
             0
           ) AS units
    FROM effective_bom b
    LEFT JOIN direct_demand dd ON dd.item_uid = b.parent_uid
    LEFT JOIN built_output bo ON bo.item_uid = b.parent_uid
    LEFT JOIN purchased_qty pq ON pq.item_uid = b.parent_uid
  ),
  potential_demand AS (
    SELECT component_uid AS item_uid,
           SUM(units * qty_per)::float8 AS potential_90,
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

const ITEM_SELECT = `
  SELECT it.uid, it.number, it.name, it.description,
         it.is_active, it.is_bought, it.is_sold, it.is_inventoried,
         it.qty_on_hand, it.qty_committed, it.qty_on_order, it.qty_available,
         it.average_cost, it.current_value, it.base_selling_price,
         it.min_level, it.reorder_qty,
         it.primary_supplier_uid, it.primary_supplier_name, it.supplier_item_number,
         it.synced_at,
         ds.supplier_uid AS inferred_supplier_uid,
         ds.supplier_name AS inferred_supplier_name,
         asg.supplier_uid AS assigned_supplier_uid,
         asg.supplier_name AS assigned_supplier_name,
         asg.supplier_item_number AS assigned_supplier_item_number,
         COALESCE(aa.assigned_count, 0) AS assigned_supplier_count,
         sup.country AS supplier_country,
         sm.region AS supplier_region_override,
         COALESCE(dd.direct_90, 0) AS direct_90,
         COALESCE(dd.direct_365, 0) AS direct_365,
         COALESCE(cd.comp_90, 0) AS comp_90,
         COALESCE(cd.comp_365, 0) AS comp_365,
         COALESCE(inc.qty, 0) AS incoming_qty,
         COALESCE(u.parent_count, 0) AS parent_count,
         COALESCE(ud.parent_count_deep, 0) AS parent_count_deep,
         COALESCE(p.component_count, 0) AS component_count,
         COALESCE(pot.potential_90, 0) AS potential_90,
         COALESCE(pot.potential_parents, 0) AS potential_parents
  FROM myob_items it
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
  qtyOnOrder: number | null;
  qtyAvailable: number | null;
  /** on hand - committed. MYOB's "available" also adds on-order stock. */
  qtyFreeStock: number | null;
  averageCost: number | null;
  currentValue: number | null;
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
  /** How many suppliers Allied has recorded for this item (0 = none yet). */
  supplierCount: number;
  /** Platform label: user override, else auto from MYOB address country. */
  supplierRegion: string | null;
  supplierRegionSource: "user" | "auto" | null;
  syncedAt: string | null;
  demand: {
    direct90: number;
    direct365: number;
    component90: number;
    component365: number;
    weekly: number;
    basis: "90d" | "365d" | "none";
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
    qty90: number;
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

function computeItem(row: Record<string, unknown>): ItemComputed {
  const n = (v: unknown): number | null =>
    v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null;
  const direct90 = n(row.direct_90) ?? 0;
  const direct365 = n(row.direct_365) ?? 0;
  const comp90 = n(row.comp_90) ?? 0;
  const comp365 = n(row.comp_365) ?? 0;

  const total90 = direct90 + comp90;
  const total365 = direct365 + comp365;
  let weekly = 0;
  let basis: "90d" | "365d" | "none" = "none";
  if (total90 > 0) {
    weekly = total90 / (90 / 7);
    basis = "90d";
  } else if (total365 > 0) {
    weekly = total365 / (365 / 7);
    basis = "365d";
  }

  const available = n(row.qty_available);
  const onHand = n(row.qty_on_hand);
  const committed = n(row.qty_committed);
  const minLevel = n(row.min_level);
  const avgCost = n(row.average_cost);
  const incomingQty = n(row.incoming_qty) ?? 0;
  const parentCount = n(row.parent_count) ?? 0;
  const isActive = row.is_active as boolean | null;

  // Inferred pack-driven pull. Material when it would move the picture:
  // there is no measured demand at all, or it adds at least a quarter again.
  const potential90 = n(row.potential_90) ?? 0;
  const understatesMeasured =
    potential90 > 0 && (total90 <= 0 || potential90 >= total90 * 0.25);

  // MYOB's qty_available includes on-order stock; analysis uses free stock.
  const freeStock = onHand == null ? null : onHand - (committed ?? 0);

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
  if (basis === "365d") flags.push("slow_mover");
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
    qtyOnOrder: n(row.qty_on_order),
    qtyAvailable: available,
    qtyFreeStock: freeStock,
    averageCost: avgCost,
    currentValue: n(row.current_value),
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
      direct90,
      direct365,
      component90: comp90,
      component365: comp365,
      weekly: Number(weekly.toFixed(3)),
      basis,
    },
    incomingQty,
    parentCount,
    parentCountDeep: n(row.parent_count_deep) ?? 0,
    componentCount: n(row.component_count) ?? 0,
    potential: {
      qty90: Number(potential90.toFixed(1)),
      weekly: Number((potential90 / (90 / 7)).toFixed(3)),
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

let itemsCache: { at: number; items: ItemComputed[] } | null = null;

export async function computedItems(force = false): Promise<ItemComputed[]> {
  if (!force && itemsCache && Date.now() - itemsCache.at < 30_000) {
    return itemsCache.items;
  }
  await ensureInsightsSchema();
  const result = await getPool().query(`WITH ${DEMAND_CTE} ${ITEM_SELECT}`);
  const items = result.rows.map(computeItem);
  itemsCache = { at: Date.now(), items };
  return items;
}

export function invalidateItemsCache(): void {
  itemsCache = null;
}

export interface ListParams {
  q?: string;
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
  potential: (i) => (i.potential.qty90 > 0 ? i.potential.qty90 : null),
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

export async function listItems(params: ListParams) {
  const all = await computedItems();
  const q = params.q?.trim().toLowerCase();
  let rows = all;

  if (q) {
    rows = rows.filter((r) =>
      `${r.number ?? ""} ${r.name ?? ""} ${r.description ?? ""} ${r.supplierName ?? ""}`
        .toLowerCase()
        .includes(q),
    );
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
      rows = rows.filter((r) => r.excess != null && r.flags.includes("slow_mover"));
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

  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 10), 200);
  const page = Math.max(params.page ?? 1, 1);
  const start = (page - 1) * pageSize;

  return {
    total: rows.length,
    page,
    pageSize,
    sort: sortKey,
    dir,
    targetCoverWeeks: config.insights.targetCoverWeeks,
    items: rows.slice(start, start + pageSize),
  };
}

export async function overview() {
  const items = await computedItems();
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
             (COALESCE(i.qty_on_hand, 0) - COALESCE(i.qty_committed, 0))::float8 AS stock_free,
             COUNT(DISTINCT u.parent_uid)::int AS blocked_parents,
             MAX(u.depth)::int AS max_depth
      FROM up u
      JOIN myob_items i ON i.uid = u.item_uid
      WHERE COALESCE(i.qty_on_hand, 0) - COALESCE(i.qty_committed, 0) < u.qty_per
      GROUP BY u.item_uid, i.number, i.name, i.qty_on_hand, i.qty_committed
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
    // Largest stock adjustments in the last 30 days by absolute value — the
    // write-offs, stocktake corrections and reversals worth a second look.
    pool.query(`
      SELECT a.number, a.date, a.memo AS doc_memo, al.memo AS line_memo,
             al.qty::float8 AS qty,
             i.uid, i.number AS item_number, i.name AS item_name,
             (ABS(al.qty) * COALESCE(NULLIF(al.unit_cost, 0), i.average_cost, 0))::float8 AS value
      FROM myob_adjustment_lines al
      JOIN myob_adjustments a ON a.uid = al.adjustment_uid
      JOIN myob_items i ON i.uid = al.item_uid
      WHERE a.date >= NOW() - INTERVAL '30 days' AND al.qty <> 0
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
  };
}

async function relationshipRows(uid: string) {
  const pool = getPool();
  const [components, whereUsed] = await Promise.all([
    pool.query(
      `SELECT b.component_uid AS uid, b.qty_per::float8 AS qty_per, b.source,
              b.build_count, b.confidence::float8 AS confidence, b.last_observed,
              d.qty_per::float8 AS shadowed_derived_qty, d.build_count AS shadowed_build_count,
              i.number, i.name,
              (COALESCE(i.qty_on_hand, 0) - COALESCE(i.qty_committed, 0))::float8 AS stock_free,
              (SELECT COUNT(*)::int FROM effective_bom x WHERE x.parent_uid = b.component_uid) AS sub_components
       FROM effective_bom b
       JOIN myob_items i ON i.uid = b.component_uid
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
              (COALESCE(i.qty_on_hand, 0) - COALESCE(i.qty_committed, 0))::float8 AS stock_free,
              (SELECT COUNT(*)::int FROM effective_bom x WHERE x.component_uid = b.parent_uid) AS used_higher
       FROM effective_bom b
       JOIN myob_items i ON i.uid = b.parent_uid
       WHERE b.component_uid = $1
       ORDER BY b.qty_per DESC`,
      [uid],
    ),
  ]);
  return { components: components.rows, whereUsed: whereUsed.rows };
}

export async function relationships(uid: string) {
  await ensureInsightsSchema();
  return relationshipRows(uid);
}

/** Depth cap for BOM explosion; also the cycle guard for malformed data. */
const BOM_MAX_DEPTH = 6;

/**
 * Explode a parent through sub-assemblies to its base components.
 * Returns the tree (for display) and the flattened base requirement per unit,
 * which is what "buildable if sub-assemblies are built first" rests on.
 */
async function explodeBom(uid: string): Promise<BomTreeRow[]> {
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
            (COALESCE(i.qty_on_hand, 0) - COALESCE(i.qty_committed, 0))::float8 AS stock_free,
            EXISTS (SELECT 1 FROM effective_bom c WHERE c.parent_uid = t.component_uid) AS has_children
     FROM tree t
     JOIN myob_items i ON i.uid = t.component_uid
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

export async function itemDetail(uid: string) {
  await ensureInsightsSchema();
  const pool = getPool();

  const itemResult = await pool.query(
    `WITH ${DEMAND_CTE} ${ITEM_SELECT} WHERE it.uid = $1`,
    [uid],
  );
  if (!itemResult.rows.length) return null;
  const item = computeItem(itemResult.rows[0]);

  const [monthly, movements, commitments, incoming, purchases, rels, freshness, potentialParents] =
    await Promise.all([
      pool.query(
        `SELECT month, SUM(direct)::float8 AS direct, SUM(component)::float8 AS component FROM (
           SELECT date_trunc('month', i.date) AS month, l.qty AS direct, 0 AS component
           FROM myob_sale_invoice_lines l JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
           WHERE l.item_uid = $1 AND i.date >= NOW() - INTERVAL '365 days'
           UNION ALL
           SELECT date_trunc('month', b.date), 0, -bl.qty
           FROM myob_build_lines bl JOIN myob_builds b ON b.uid = bl.build_uid
           WHERE bl.item_uid = $1 AND bl.qty < 0 AND b.date >= NOW() - INTERVAL '365 days'
         ) x GROUP BY month ORDER BY month`,
        [uid],
      ),
      pool.query(
        `SELECT * FROM (
           SELECT 'sale' AS kind, i.number AS doc, i.date, -l.qty::float8 AS delta,
                  i.customer_name AS counterparty, l.description
           FROM myob_sale_invoice_lines l JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
           WHERE l.item_uid = $1
           UNION ALL
           SELECT 'purchase', b.number, b.date, l.qty::float8,
                  b.supplier_name, l.description
           FROM myob_purchase_bill_lines l JOIN myob_purchase_bills b ON b.uid = l.bill_uid
           WHERE l.item_uid = $1
           UNION ALL
           SELECT 'build', b.number, b.date, bl.qty::float8, b.memo, NULL
           FROM myob_build_lines bl JOIN myob_builds b ON b.uid = bl.build_uid
           WHERE bl.item_uid = $1
           UNION ALL
           SELECT 'adjustment', a.number, a.date, al.qty::float8, a.memo, al.memo
           FROM myob_adjustment_lines al JOIN myob_adjustments a ON a.uid = al.adjustment_uid
           WHERE al.item_uid = $1
         ) m ORDER BY date DESC NULLS LAST LIMIT 60`,
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
         WHERE l.item_uid = $1 ORDER BY b.date DESC LIMIT 15`,
        [uid],
      ),
      relationshipRows(uid),
      pool.query(`SELECT entity, last_synced_at FROM sync_state ORDER BY entity`),
      // Which packs/kits drive this component's potential demand, and the
      // sold/built/bought arithmetic behind each one.
      pool.query(
        `WITH sold AS (
           SELECT l.item_uid, SUM(l.qty)::float8 AS qty
           FROM myob_sale_invoice_lines l JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
           WHERE i.date >= NOW() - INTERVAL '90 days' AND l.item_uid IS NOT NULL
           GROUP BY l.item_uid
         ), built AS (
           SELECT bl.item_uid, SUM(bl.qty)::float8 AS qty
           FROM myob_build_lines bl JOIN myob_builds b ON b.uid = bl.build_uid
           WHERE bl.qty > 0 AND b.date >= NOW() - INTERVAL '90 days' AND bl.item_uid IS NOT NULL
           GROUP BY bl.item_uid
         ), bought AS (
           SELECT l.item_uid, SUM(l.qty)::float8 AS qty
           FROM myob_purchase_bill_lines l JOIN myob_purchase_bills b ON b.uid = l.bill_uid
           WHERE b.date >= NOW() - INTERVAL '90 days' AND l.item_uid IS NOT NULL
           GROUP BY l.item_uid
         )
         SELECT eb.parent_uid AS uid, i.number, i.name, eb.qty_per::float8 AS qty_per,
                COALESCE(s.qty, 0) AS sold_90,
                COALESCE(bt.qty, 0) AS built_90,
                COALESCE(bo.qty, 0) AS bought_90,
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
  const tree = rels.components.length ? await explodeBom(uid) : [];
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
  };
}

export async function productsList(params: { q?: string; page?: number }) {
  await ensureInsightsSchema();
  const pool = getPool();
  const result = await pool.query(`
    WITH parent_build AS (
      SELECT b.parent_uid,
             COUNT(*)::int AS component_count,
             MIN(FLOOR(GREATEST(COALESCE(ci.qty_on_hand,0) - COALESCE(ci.qty_committed,0), 0) / NULLIF(b.qty_per,0)))::float8 AS buildable,
             BOOL_OR(b.source = 'user') AS has_user_rows,
             MIN(b.confidence)::float8 AS min_confidence
      FROM effective_bom b
      JOIN myob_items ci ON ci.uid = b.component_uid
      GROUP BY b.parent_uid
    )
    SELECT p.*, i.number, i.name,
           (COALESCE(i.qty_on_hand,0) - COALESCE(i.qty_committed,0))::float8 AS stock_free,
           i.qty_committed::float8 AS qty_committed, i.is_active,
           (SELECT COALESCE(SUM(l.qty),0)::float8
              FROM myob_sale_invoice_lines l
              JOIN myob_sale_invoices si ON si.uid = l.invoice_uid
             WHERE l.item_uid = p.parent_uid
               AND si.date >= NOW() - INTERVAL '90 days') AS sold_90
    FROM parent_build p
    JOIN myob_items i ON i.uid = p.parent_uid
    ORDER BY sold_90 DESC NULLS LAST
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
    parents: rows.slice((page - 1) * pageSize, page * pageSize),
  };
}

export async function purchasing() {
  const items = await computedItems();
  const rows = items
    .filter((i) => i.suggestion != null || i.flags.includes("below_min"))
    .sort((a, b) => b.risk.score - a.risk.score);

  const groups = new Map<
    string,
    { supplier: string; region: string | null; regionSource: string | null; items: ItemComputed[] }
  >();
  for (const item of rows) {
    const key = item.supplierName ?? "No known supplier";
    if (!groups.has(key))
      groups.set(key, {
        supplier: key,
        region: item.supplierRegion,
        regionSource: item.supplierRegionSource,
        items: [],
      });
    groups.get(key)!.items.push(item);
  }

  return {
    generatedAt: new Date().toISOString(),
    targetCoverWeeks: config.insights.targetCoverWeeks,
    totalItems: rows.length,
    suppliers: [...groups.values()].map((g) => ({
      supplier: g.supplier,
      region: g.region,
      regionSource: g.regionSource,
      itemCount: g.items.length,
      estimatedCost: g.items.reduce(
        (s, i) => s + (i.suggestion?.qty ?? 0) * (i.averageCost ?? 0),
        0,
      ),
      items: g.items,
    })),
  };
}

export function purchasingCsv(data: Awaited<ReturnType<typeof purchasing>>): string {
  const esc = (v: unknown): string => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines = [
    [
      "Supplier", "Supplier source", "Item number", "Item name", "Supplier item no",
      "On hand", "Committed", "Free stock", "On order (incoming)", "Min level",
      "Weekly demand", "Demand basis", "Cover (weeks)",
      "Potential pack demand 90d (not in totals)",
      "Suggested order qty", "Est cost", "Risk score", "Flags",
    ].join(","),
  ];
  for (const g of data.suppliers) {
    for (const i of g.items) {
      lines.push(
        [
          esc(g.supplier),
          i.supplierSource === "inferred" ? "inferred from purchases" : i.supplierSource === "myob" ? "MYOB primary" : "",
          esc(i.number), esc(i.name), esc(i.supplierItemNumber),
          i.qtyOnHand ?? "", i.qtyCommitted ?? "", i.qtyFreeStock ?? "", i.incomingQty,
          i.minLevel ?? "", i.demand.weekly, i.demand.basis,
          i.coverWeeks ?? "", i.potential.qty90 || "",
          i.suggestion?.qty ?? 0,
          ((i.suggestion?.qty ?? 0) * (i.averageCost ?? 0)).toFixed(2),
          i.risk.score, esc(i.flags.join(" ")),
        ].join(","),
      );
    }
  }
  return lines.join("\n");
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
export async function suppliersList(params: { q?: string }) {
  await ensureInsightsSchema();
  const pool = getPool();
  const result = await pool.query(`
    SELECT s.uid, s.name, s.display_id, s.is_active, s.city, s.country,
           s.phone, s.email, s.synced_at,
           m.region AS region_override, m.lead_time_days, m.notes,
           m.updated_at AS meta_updated_at,
           (SELECT COUNT(*)::int FROM myob_items i WHERE i.primary_supplier_uid = s.uid) AS primary_items,
           (SELECT COALESCE(SUM(b.total), 0)::float8 FROM myob_purchase_bills b
             WHERE b.supplier_uid = s.uid AND b.date >= NOW() - INTERVAL '365 days') AS purchase_value_365,
           (SELECT COUNT(*)::int FROM myob_purchase_bills b
             WHERE b.supplier_uid = s.uid AND b.date >= NOW() - INTERVAL '365 days') AS bills_365,
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
    ORDER BY purchase_value_365 DESC NULLS LAST, s.name
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
 * Blind-spot worklist: items that sold in the last year, look like assembled
 * products (name/number heuristic — labelled as such in the UI), and have no
 * known composition in the effective BOM.
 */
export async function bomBlindspots() {
  await ensureInsightsSchema();
  const result = await getPool().query(`
    WITH sold AS (
      SELECT l.item_uid,
             COALESCE(SUM(l.qty) FILTER (WHERE si.date >= NOW() - INTERVAL '90 days'), 0)::float8 AS sold_90,
             COALESCE(SUM(l.qty), 0)::float8 AS sold_365
      FROM myob_sale_invoice_lines l
      JOIN myob_sale_invoices si ON si.uid = l.invoice_uid
      WHERE si.date >= NOW() - INTERVAL '365 days' AND l.item_uid IS NOT NULL
      GROUP BY l.item_uid
    )
    SELECT i.uid, i.number, i.name,
           (COALESCE(i.qty_on_hand, 0) - COALESCE(i.qty_committed, 0))::float8 AS stock_free,
           s.sold_90, s.sold_365,
           COUNT(*) OVER ()::int AS total_count
    FROM myob_items i
    JOIN sold s ON s.item_uid = i.uid AND s.sold_365 > 0
    WHERE i.is_active IS NOT FALSE
      AND COALESCE(i.is_sold, TRUE)
      AND NOT EXISTS (SELECT 1 FROM effective_bom b WHERE b.parent_uid = i.uid)
      AND (i.name ~* '(pack|kit|dressing|assembl)' OR i.number ~* '^(BP|DS)')
    ORDER BY s.sold_90 DESC, s.sold_365 DESC
    LIMIT 100
  `);
  return {
    heuristic:
      "Active items sold in the last 365 days whose name contains pack/kit/dressing/assembly (or number starts BP/DS) and that have no known composition.",
    total: result.rows.length ? Number(result.rows[0].total_count) : 0,
    items: result.rows.map(({ total_count, ...r }) => r),
  };
}
