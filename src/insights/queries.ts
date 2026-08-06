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
 */

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
    FROM platform_bom
    GROUP BY component_uid
  ),
  bom_parents AS (
    SELECT parent_uid AS item_uid,
           COUNT(DISTINCT component_uid)::int AS component_count
    FROM platform_bom
    GROUP BY parent_uid
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
         COALESCE(dd.direct_90, 0) AS direct_90,
         COALESCE(dd.direct_365, 0) AS direct_365,
         COALESCE(cd.comp_90, 0) AS comp_90,
         COALESCE(cd.comp_365, 0) AS comp_365,
         COALESCE(inc.qty, 0) AS incoming_qty,
         COALESCE(u.parent_count, 0) AS parent_count,
         COALESCE(p.component_count, 0) AS component_count
  FROM myob_items it
  LEFT JOIN direct_demand dd ON dd.item_uid = it.uid
  LEFT JOIN component_demand cd ON cd.item_uid = it.uid
  LEFT JOIN incoming inc ON inc.item_uid = it.uid
  LEFT JOIN bom_usage u ON u.item_uid = it.uid
  LEFT JOIN bom_parents p ON p.item_uid = it.uid
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
  averageCost: number | null;
  currentValue: number | null;
  baseSellingPrice: number | null;
  minLevel: number | null;
  reorderQty: number | null;
  supplierUid: string | null;
  supplierName: string | null;
  supplierItemNumber: string | null;
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
  componentCount: number;
  coverWeeks: number | null;
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
  const minLevel = n(row.min_level);
  const avgCost = n(row.average_cost);
  const incomingQty = n(row.incoming_qty) ?? 0;
  const parentCount = n(row.parent_count) ?? 0;
  const isActive = row.is_active as boolean | null;

  const coverWeeks =
    weekly > 0 && available != null ? Math.max(available, 0) / weekly : null;

  const flags: string[] = [];
  if (minLevel != null && minLevel > 0 && (available ?? 0) < minLevel)
    flags.push("below_min");
  if ((onHand ?? 0) < 0) flags.push("negative_stock");
  if ((onHand ?? 0) > 0 && (avgCost ?? 0) === 0) flags.push("stock_no_cost");
  if (isActive === false && (onHand ?? 0) > 0) flags.push("inactive_with_stock");
  if (weekly > 0 && !row.primary_supplier_uid) flags.push("no_supplier");
  if (basis === "365d") flags.push("slow_mover");

  const factors: { label: string; points: number }[] = [];
  if (flags.includes("below_min"))
    factors.push({ label: "Below MYOB minimum level", points: 30 });
  if (coverWeeks != null) {
    if (coverWeeks < 2) factors.push({ label: `Cover ${coverWeeks.toFixed(1)}w (<2w)`, points: 25 });
    else if (coverWeeks < 4) factors.push({ label: `Cover ${coverWeeks.toFixed(1)}w (<4w)`, points: 15 });
    else if (coverWeeks < config.insights.targetCoverWeeks)
      factors.push({ label: `Cover ${coverWeeks.toFixed(1)}w (below target)`, points: 8 });
  }
  if (parentCount > 0)
    factors.push({
      label: `Used in ${parentCount} finished product${parentCount === 1 ? "" : "s"}`,
      points: Math.min(20, parentCount * 2),
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

  // Purchasing suggestion: cover target + min level, net of stock + incoming.
  let suggestion: ItemComputed["suggestion"] = null;
  if (weekly > 0 || flags.includes("below_min")) {
    const target = config.insights.targetCoverWeeks;
    const raw =
      weekly * target + Math.max(minLevel ?? 0, 0) - (available ?? 0) - incomingQty;
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
          available: available ?? 0,
          incoming: incomingQty,
          rawNeed: Number(raw.toFixed(1)),
          reorderMultiple: multiple ?? null,
        },
      };
    }
  }

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
    qtyCommitted: n(row.qty_committed),
    qtyOnOrder: n(row.qty_on_order),
    qtyAvailable: available,
    averageCost: avgCost,
    currentValue: n(row.current_value),
    baseSellingPrice: n(row.base_selling_price),
    minLevel,
    reorderQty: n(row.reorder_qty),
    supplierUid: (row.primary_supplier_uid as string) ?? null,
    supplierName: (row.primary_supplier_name as string) ?? null,
    supplierItemNumber: (row.supplier_item_number as string) ?? null,
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
    componentCount: n(row.component_count) ?? 0,
    coverWeeks: coverWeeks == null ? null : Number(coverWeeks.toFixed(1)),
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
  sort?: string;
  page?: number;
  pageSize?: number;
}

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
  }

  const sorters: Record<string, (a: ItemComputed, b: ItemComputed) => number> = {
    risk: (a, b) => b.risk.score - a.risk.score,
    number: (a, b) => (a.number ?? "").localeCompare(b.number ?? ""),
    name: (a, b) => (a.name ?? "").localeCompare(b.name ?? ""),
    available: (a, b) => (a.qtyAvailable ?? 0) - (b.qtyAvailable ?? 0),
    cover: (a, b) => (a.coverWeeks ?? 1e9) - (b.coverWeeks ?? 1e9),
    weekly: (a, b) => b.demand.weekly - a.demand.weekly,
    value: (a, b) => (b.currentValue ?? 0) - (a.currentValue ?? 0),
    used_in: (a, b) => b.parentCount - a.parentCount,
  };
  rows = [...rows].sort(sorters[params.sort ?? "risk"] ?? sorters.risk);

  const pageSize = Math.min(Math.max(params.pageSize ?? 50, 10), 200);
  const page = Math.max(params.page ?? 1, 1);
  const start = (page - 1) * pageSize;

  return {
    total: rows.length,
    page,
    pageSize,
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

  const attention = [...items]
    .sort((a, b) => b.risk.score - a.risk.score)
    .filter((i) => i.risk.score > 0)
    .slice(0, 15);

  const [constraints, relationships, freshness] = await Promise.all([
    pool.query(`
      SELECT b.component_uid AS uid, i.number, i.name,
             i.qty_available::float8 AS qty_available,
             COUNT(DISTINCT b.parent_uid)::int AS blocked_parents
      FROM platform_bom b
      JOIN myob_items i ON i.uid = b.component_uid
      WHERE COALESCE(i.qty_available, 0) < b.qty_per
      GROUP BY b.component_uid, i.number, i.name, i.qty_available
      ORDER BY blocked_parents DESC
      LIMIT 8
    `),
    pool.query(`
      SELECT source, COUNT(*)::int AS count FROM platform_bom GROUP BY source
    `),
    pool.query(`
      SELECT MIN(last_synced_at) AS oldest, MAX(last_synced_at) AS newest
      FROM sync_state
    `),
  ]);

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
    },
    relationships: relationships.rows,
    attention,
    constraints: constraints.rows,
    freshness: freshness.rows[0] ?? null,
    targetCoverWeeks: config.insights.targetCoverWeeks,
  };
}

async function relationshipRows(uid: string) {
  const pool = getPool();
  const [components, whereUsed] = await Promise.all([
    pool.query(
      `SELECT b.component_uid AS uid, b.qty_per::float8 AS qty_per, b.source,
              b.build_count, b.confidence::float8 AS confidence, b.last_observed,
              i.number, i.name, i.qty_available::float8 AS qty_available,
              (SELECT COUNT(*)::int FROM platform_bom x WHERE x.parent_uid = b.component_uid) AS sub_components
       FROM platform_bom b
       JOIN myob_items i ON i.uid = b.component_uid
       WHERE b.parent_uid = $1
       ORDER BY b.qty_per DESC`,
      [uid],
    ),
    pool.query(
      `SELECT b.parent_uid AS uid, b.qty_per::float8 AS qty_per, b.source,
              b.build_count, b.confidence::float8 AS confidence,
              i.number, i.name, i.qty_available::float8 AS qty_available,
              (SELECT COUNT(*)::int FROM platform_bom x WHERE x.component_uid = b.parent_uid) AS used_higher
       FROM platform_bom b
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

export async function itemDetail(uid: string) {
  await ensureInsightsSchema();
  const pool = getPool();

  const itemResult = await pool.query(
    `WITH ${DEMAND_CTE} ${ITEM_SELECT} WHERE it.uid = $1`,
    [uid],
  );
  if (!itemResult.rows.length) return null;
  const item = computeItem(itemResult.rows[0]);

  const [monthly, movements, commitments, incoming, purchases, rels, freshness] =
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
    ]);

  // Buildability of this item from direct components (single level).
  type Constraint = { uid: string; number: string | null; name: string | null };
  let buildability: { maxUnits: number | null; constraint: Constraint | null } | null =
    null;
  if (rels.components.length) {
    let maxUnits: number | null = null;
    let constraint: Constraint | null = null;
    for (const c of rels.components) {
      if (!c.qty_per || c.qty_per <= 0) continue;
      const possible = Math.floor(Math.max(c.qty_available ?? 0, 0) / c.qty_per);
      if (maxUnits == null || possible < maxUnits) {
        maxUnits = possible;
        constraint = { uid: c.uid, number: c.number, name: c.name };
      }
    }
    buildability = { maxUnits, constraint };
  }

  return {
    item,
    monthlyDemand: monthly.rows,
    movements: movements.rows,
    commitments: commitments.rows,
    incoming: incoming.rows,
    purchases: purchases.rows,
    components: rels.components,
    whereUsed: rels.whereUsed,
    buildability,
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
             MIN(FLOOR(GREATEST(COALESCE(ci.qty_available,0),0) / NULLIF(b.qty_per,0)))::float8 AS buildable,
             BOOL_OR(b.source = 'user') AS has_user_rows,
             MIN(b.confidence)::float8 AS min_confidence
      FROM platform_bom b
      JOIN myob_items ci ON ci.uid = b.component_uid
      GROUP BY b.parent_uid
    )
    SELECT p.*, i.number, i.name, i.qty_available::float8 AS qty_available,
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

  const groups = new Map<string, { supplier: string; items: ItemComputed[] }>();
  for (const item of rows) {
    const key = item.supplierName ?? "No primary supplier in MYOB";
    if (!groups.has(key)) groups.set(key, { supplier: key, items: [] });
    groups.get(key)!.items.push(item);
  }

  return {
    generatedAt: new Date().toISOString(),
    targetCoverWeeks: config.insights.targetCoverWeeks,
    totalItems: rows.length,
    suppliers: [...groups.values()].map((g) => ({
      supplier: g.supplier,
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
      "Supplier", "Item number", "Item name", "Supplier item no",
      "Available", "Committed", "On order (incoming)", "Min level",
      "Weekly demand", "Demand basis", "Cover (weeks)",
      "Suggested order qty", "Est cost", "Risk score", "Flags",
    ].join(","),
  ];
  for (const g of data.suppliers) {
    for (const i of g.items) {
      lines.push(
        [
          esc(g.supplier), esc(i.number), esc(i.name), esc(i.supplierItemNumber),
          i.qtyAvailable ?? "", i.qtyCommitted ?? "", i.incomingQty,
          i.minLevel ?? "", i.demand.weekly, i.demand.basis,
          i.coverWeeks ?? "", i.suggestion?.qty ?? 0,
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
        (SELECT COUNT(*)::int FROM platform_bom WHERE source='user') AS bom_user
    `),
  ]);

  const items = await computedItems();
  const dq = {
    negativeStock: items.filter((i) => i.flags.includes("negative_stock")).length,
    stockNoCost: items.filter((i) => i.flags.includes("stock_no_cost")).length,
    inactiveWithStock: items.filter((i) => i.flags.includes("inactive_with_stock")).length,
    demandNoSupplier: items.filter((i) => i.flags.includes("no_supplier")).length,
  };

  return {
    entities: state.rows,
    recentRuns: runs.rows,
    counts: counts.rows[0],
    dataQuality: dq,
    settings: {
      syncWindowDays: config.insights.syncWindowDays,
      targetCoverWeeks: config.insights.targetCoverWeeks,
      syncIntervalHours: config.insights.syncIntervalHours,
    },
  };
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
