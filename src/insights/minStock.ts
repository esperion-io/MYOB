import { businessToday } from "./businessDate.js";
import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";
import { computedItems, invalidateItemsCache, type ItemComputed } from "./queries.js";

/**
 * Minimum stock review (Purchasing › Minimum stock review).
 *
 * One rule, stated by Allied: minimum stock = average monthly consumption over
 * a chosen window × the supplier's lead time in months. It is the stock that
 * carries the shelf through the wait for a replacement, and it replaces MYOB's
 * hand-typed minimum everywhere — the below-minimum flag, the risk score and
 * the order quantity all read the applied figure (see platform_min_stock).
 *
 * Consumption is the same measure the rest of the dashboard calls demand:
 * invoice lines plus components consumed by builds. A bolt that only ever
 * leaves inside a pack has no sales of its own but is consumed all the same,
 * and its minimum has to reflect that. Credit notes net off automatically.
 *
 * Three windows are always computed together so the page can show the 6, 12
 * and 18-month figures side by side. Which one Allied apply is decided per
 * item, or per filtered view — a stainless range on 18 months, galvanised on 6.
 */

export const MIN_STOCK_WINDOWS = [6, 12, 18] as const;
export type MinStockWindow = (typeof MIN_STOCK_WINDOWS)[number];

const DAYS_PER_MONTH = 365.25 / 12;

export function isMinStockWindow(v: unknown): v is MinStockWindow {
  return (MIN_STOCK_WINDOWS as readonly number[]).includes(Number(v));
}

/**
 * The rule itself. Whole units, rounded up: a minimum of 0.4 washers means
 * "keep one", not "keep none".
 *
 * Null where there is no lead time to multiply by. Zero would read as a real
 * figure — "you need nothing on the shelf" — and then get applied.
 */
export function suggestedMinimum(monthlyBurn: number, leadTimeDays: number | null): number | null {
  if (leadTimeDays == null || leadTimeDays <= 0 || monthlyBurn <= 0) return null;
  return Math.ceil(monthlyBurn * (leadTimeDays / DAYS_PER_MONTH));
}

export type MinStockStatus = "unset" | "window" | "manual";

export interface MinStockRow {
  uid: string;
  number: string | null;
  name: string | null;
  productType: string | null;
  productFinish: string | null;
  tags: string[];
  supplierName: string | null;
  supplierRegion: string | null;
  leadTimeDays: number | null;
  leadTimeSource: "item" | "supplier" | "measured" | null;
  leadTimeOrders: number;
  /** What an item-level figure would be overriding, so the page can say so. */
  leadTimeItemDays: number | null;
  leadTimeSupplierDays: number | null;
  leadTimeMeasuredDays: number | null;
  /** Units consumed over each window, and the monthly rate that implies. */
  consumed: Record<MinStockWindow, number>;
  burn: Record<MinStockWindow, number>;
  /** Consumption × lead time for each window; null where no lead time. */
  suggested: Record<MinStockWindow, number | null>;
  applied: ItemComputed["minStock"];
  status: MinStockStatus;
  /**
   * For a window-based minimum: what its own window gives today. Set only
   * when it differs from the applied figure, so the page can show drift.
   */
  nowForWindow: number | null;
  myobMinLevel: number | null;
  freeStock: number | null;
  belowMin: boolean;
}

export interface MinStockFilters {
  windowMonths?: number;
  q?: string;
  productType?: string;
  productFinish?: string;
  region?: string;
  tag?: string;
  /**
   * all      — every item that moved in the window
   * unset    — moved, no minimum applied yet
   * window   — applied from a window
   * manual   — applied by hand
   * drift    — window-based, and today's figure differs from the applied one
   * nolead   — moved, but no lead time so nothing can be suggested
   * stale    — has a minimum but did NOT move in the window (dead stock with a
   *            minimum still driving reorders)
   */
  status?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
  all?: boolean;
}

const NOT_SET = "(not set)";

/** Consumption per item over the three windows, up to today. */
async function consumption(): Promise<Map<string, Record<MinStockWindow, number>>> {
  const today = businessToday();
  /*
   * Half-open windows, (today − N months, today], matching demandCte in
   * queries.ts — a closed lower bound makes every rate ~0.5% high.
   */
  const r = await getPool().query(
    `WITH moves AS (
       SELECT l.item_uid, i.date AS d, l.qty
       FROM myob_sale_invoice_lines l
       JOIN myob_sale_invoices i ON i.uid = l.invoice_uid
       WHERE l.item_uid IS NOT NULL
         AND i.date <= $1::date AND i.date > $1::date - make_interval(months => 18)
       UNION ALL
       SELECT bl.item_uid, b.date, -bl.qty
       FROM myob_build_lines bl
       JOIN myob_builds b ON b.uid = bl.build_uid
       WHERE bl.qty < 0 AND bl.item_uid IS NOT NULL
         AND b.date <= $1::date AND b.date > $1::date - make_interval(months => 18)
     )
     SELECT item_uid,
            COALESCE(SUM(qty) FILTER (WHERE d > $1::date - make_interval(months => 6)), 0)::float8 AS m6,
            COALESCE(SUM(qty) FILTER (WHERE d > $1::date - make_interval(months => 12)), 0)::float8 AS m12,
            COALESCE(SUM(qty), 0)::float8 AS m18
     FROM moves
     GROUP BY item_uid`,
    [today],
  );
  return new Map(
    r.rows.map((x) => [
      x.item_uid as string,
      { 6: Number(x.m6), 12: Number(x.m12), 18: Number(x.m18) },
    ]),
  );
}

function buildRows(items: ItemComputed[], cons: Map<string, Record<MinStockWindow, number>>): MinStockRow[] {
  const rows: MinStockRow[] = [];
  for (const i of items) {
    if (i.isInventoried === false) continue;
    const consumed = cons.get(i.uid) ?? { 6: 0, 12: 0, 18: 0 };
    const moved = consumed[18] > 0 || consumed[12] > 0 || consumed[6] > 0;
    // Only items that moved, or that hold a minimum worth reviewing.
    if (!moved && !i.minStock) continue;

    const burn = {
      6: Math.max(consumed[6], 0) / 6,
      12: Math.max(consumed[12], 0) / 12,
      18: Math.max(consumed[18], 0) / 18,
    };
    const suggested = {
      6: suggestedMinimum(burn[6], i.leadTimeDays),
      12: suggestedMinimum(burn[12], i.leadTimeDays),
      18: suggestedMinimum(burn[18], i.leadTimeDays),
    };
    const applied = i.minStock;
    let nowForWindow: number | null = null;
    if (applied?.basis === "window" && isMinStockWindow(applied.windowMonths)) {
      const now = suggested[applied.windowMonths];
      if (now != null && now !== applied.level) nowForWindow = now;
    }
    rows.push({
      uid: i.uid,
      number: i.number,
      name: i.name,
      productType: i.productType,
      productFinish: i.productFinish,
      tags: i.tags,
      supplierName: i.supplierName,
      supplierRegion: i.supplierRegion,
      leadTimeDays: i.leadTimeDays,
      leadTimeSource: i.leadTimeSource,
      leadTimeOrders: i.leadTimeOrders,
      leadTimeItemDays: i.leadTimeItemDays,
      leadTimeSupplierDays: i.leadTimeSupplierDays,
      leadTimeMeasuredDays: i.leadTimeMeasuredDays,
      consumed,
      burn,
      suggested,
      applied,
      status: !applied ? "unset" : applied.basis,
      nowForWindow,
      myobMinLevel: i.myobMinLevel,
      freeStock: i.qtyFreeStock,
      belowMin: i.flags.includes("below_min"),
    });
  }
  return rows;
}

function applyFilters(rows: MinStockRow[], f: MinStockFilters, w: MinStockWindow): MinStockRow[] {
  let out = rows;
  const status = f.status ?? "all";
  // The base list is what moved in the window. "stale" is the one view that
  // deliberately looks outside it.
  out =
    status === "stale"
      ? out.filter((r) => r.applied && r.consumed[w] <= 0)
      : out.filter((r) => r.consumed[w] > 0);

  const q = f.q?.trim().toLowerCase();
  if (q)
    out = out.filter((r) =>
      `${r.number ?? ""} ${r.name ?? ""} ${r.supplierName ?? ""}`.toLowerCase().includes(q),
    );
  if (f.productType)
    out = out.filter((r) =>
      f.productType === NOT_SET ? !r.productType : r.productType === f.productType,
    );
  if (f.productFinish)
    out = out.filter((r) =>
      f.productFinish === NOT_SET ? !r.productFinish : r.productFinish === f.productFinish,
    );
  if (f.tag) {
    const wanted = f.tag.trim().toLowerCase();
    out = out.filter((r) => r.tags.some((t) => t.toLowerCase() === wanted));
  }
  if (f.region)
    out =
      f.region === "none"
        ? out.filter((r) => r.supplierRegion == null)
        : out.filter((r) => r.supplierRegion === f.region);

  switch (status) {
    case "unset":
      out = out.filter((r) => r.status === "unset");
      break;
    case "window":
      out = out.filter((r) => r.status === "window");
      break;
    case "manual":
      out = out.filter((r) => r.status === "manual");
      break;
    case "drift":
      out = out.filter((r) => r.nowForWindow != null);
      break;
    case "nolead":
      out = out.filter((r) => r.leadTimeDays == null);
      break;
  }
  return out;
}

const SORT: Record<string, (r: MinStockRow, w: MinStockWindow) => number | string | null> = {
  number: (r) => r.number ?? "",
  burn: (r, w) => r.burn[w],
  suggested: (r, w) => r.suggested[w],
  applied: (r) => r.applied?.level ?? null,
  lead: (r) => r.leadTimeDays,
  free: (r) => r.freeStock,
};

function sortRows(rows: MinStockRow[], f: MinStockFilters, w: MinStockWindow) {
  const key = f.sort && SORT[f.sort] ? f.sort : "burn";
  const dir = f.dir === "asc" || f.dir === "desc" ? f.dir : key === "number" ? "asc" : "desc";
  const value = SORT[key];
  const sorted = [...rows].sort((a, b) => {
    const va = value(a, w);
    const vb = value(b, w);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    const c =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb)
        : Number(va) - Number(vb);
    return dir === "asc" ? c : -c;
  });
  return { sorted, key, dir };
}

function resolveWindow(f: MinStockFilters): MinStockWindow {
  return isMinStockWindow(f.windowMonths) ? (Number(f.windowMonths) as MinStockWindow) : 12;
}

/** The review list: every item that moved in the window, with all three figures. */
export async function minStockReview(f: MinStockFilters) {
  await ensureInsightsSchema();
  const w = resolveWindow(f);
  const [items, cons] = await Promise.all([computedItems(), consumption()]);
  const all = buildRows(items, cons);
  const moved = all.filter((r) => r.consumed[w] > 0);

  const filtered = applyFilters(all, f, w);
  const { sorted, key, dir } = sortRows(filtered, f, w);

  const pageSize = f.all ? sorted.length : Math.min(Math.max(f.pageSize ?? 100, 10), 200);
  const page = f.all ? 1 : Math.max(f.page ?? 1, 1);
  const start = (page - 1) * pageSize;

  return {
    generatedAt: new Date().toISOString(),
    asAt: businessToday(),
    windowMonths: w,
    windows: [...MIN_STOCK_WINDOWS],
    // Counts describe the whole window, before any filter, so the chips read
    // the same whichever slice is on screen.
    summary: {
      moved: moved.length,
      unset: moved.filter((r) => r.status === "unset").length,
      window: moved.filter((r) => r.status === "window").length,
      manual: moved.filter((r) => r.status === "manual").length,
      drift: moved.filter((r) => r.nowForWindow != null).length,
      noLead: moved.filter((r) => r.leadTimeDays == null).length,
      stale: all.filter((r) => r.applied && r.consumed[w] <= 0).length,
      /** Window-based minimums across every item, for the recalculate action. */
      windowBasedTotal: all.filter((r) => r.status === "window").length,
    },
    total: sorted.length,
    page,
    pageSize,
    sort: key,
    dir,
    /** How many of the rows in this view a bulk apply would actually change. */
    applicable: filtered.filter((r) => r.status !== "manual" && r.suggested[w] != null).length,
    /** Rows in this view carrying an item-level lead time, for the bulk clear. */
    leadOverridesInView: filtered.filter((r) => r.leadTimeItemDays != null).length,
    rows: sorted.slice(start, start + pageSize),
  };
}

async function writeWindowMinimum(
  client: { query: (q: string, p?: unknown[]) => Promise<unknown> },
  r: MinStockRow,
  w: MinStockWindow,
  level: number,
  setBy: string | null,
) {
  await client.query(
    `INSERT INTO platform_min_stock
       (item_uid, min_level, basis, window_months, monthly_burn, lead_time_days, set_by, set_at)
     VALUES ($1, $2, 'window', $3, $4, $5, $6, NOW())
     ON CONFLICT (item_uid) DO UPDATE SET
       min_level = EXCLUDED.min_level, basis = 'window', window_months = EXCLUDED.window_months,
       monthly_burn = EXCLUDED.monthly_burn, lead_time_days = EXCLUDED.lead_time_days,
       set_by = EXCLUDED.set_by, set_at = NOW()`,
    [r.uid, level, w, r.burn[w], r.leadTimeDays, setBy],
  );
}

/** Apply one window's figure to one item. */
export async function applyWindowMinimum(params: {
  itemUid: string;
  windowMonths: MinStockWindow;
  setBy?: string | null;
}): Promise<{ minLevel: number }> {
  await ensureInsightsSchema();
  const [items, cons] = await Promise.all([computedItems(), consumption()]);
  const row = buildRows(items, cons).find((r) => r.uid === params.itemUid);
  if (!row) throw new Error("Item not found, or it has no consumption to base a minimum on.");
  const level = row.suggested[params.windowMonths];
  if (level == null)
    throw new Error(
      row.leadTimeDays == null
        ? "No lead time is known for this item's supplier, so no minimum can be calculated. Set one on the Suppliers page."
        : `Nothing was consumed in the last ${params.windowMonths} months, so there is no figure to apply.`,
    );
  await writeWindowMinimum(getPool(), row, params.windowMonths, level, params.setBy ?? null);
  invalidateItemsCache();
  return { minLevel: level };
}

/** Allied typing a number in. Never touched by a bulk action afterwards. */
export async function setManualMinimum(params: {
  itemUid: string;
  minLevel: number;
  setBy?: string | null;
}): Promise<void> {
  await ensureInsightsSchema();
  if (!Number.isFinite(params.minLevel) || params.minLevel < 0)
    throw new Error("minLevel must be a number of zero or more.");
  await getPool().query(
    `INSERT INTO platform_min_stock (item_uid, min_level, basis, set_by, set_at)
     VALUES ($1, $2, 'manual', $3, NOW())
     ON CONFLICT (item_uid) DO UPDATE SET
       min_level = EXCLUDED.min_level, basis = 'manual', window_months = NULL,
       monthly_burn = NULL, lead_time_days = NULL, set_by = EXCLUDED.set_by, set_at = NOW()`,
    [params.itemUid, params.minLevel, params.setBy ?? null],
  );
  invalidateItemsCache();
}

export async function clearMinimum(itemUid: string): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(`DELETE FROM platform_min_stock WHERE item_uid = $1`, [itemUid]);
  invalidateItemsCache();
}

/**
 * Apply one window's figure to every item in a filtered view.
 *
 * This is how a mixed policy is built: filter to the stainless range and apply
 * 18 months, then to galvanised and apply 6. The server re-runs the same
 * filter the page used, so "all N items in this view" means exactly that and
 * not just the page on screen. Manual figures are skipped — a number someone
 * typed in deliberately must not be overwritten by a sweep.
 */
export async function applyWindowToView(
  f: MinStockFilters,
  setBy?: string | null,
): Promise<{ applied: number; skippedManual: number; skippedNoFigure: number }> {
  await ensureInsightsSchema();
  const w = resolveWindow(f);
  const [items, cons] = await Promise.all([computedItems(), consumption()]);
  const rows = applyFilters(buildRows(items, cons), f, w);

  let applied = 0;
  let skippedManual = 0;
  let skippedNoFigure = 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      if (r.status === "manual") {
        skippedManual += 1;
        continue;
      }
      const level = r.suggested[w];
      if (level == null) {
        skippedNoFigure += 1;
        continue;
      }
      await writeWindowMinimum(client, r, w, level, setBy ?? null);
      applied += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  invalidateItemsCache();
  return { applied, skippedManual, skippedNoFigure };
}

/**
 * Bring every window-based minimum up to date using its own window.
 *
 * An item set on 12 months stays on 12 months; one set on 18 stays on 18. A
 * row whose window now shows no consumption is left alone rather than zeroed —
 * it appears under the "stale" view for a person to decide.
 */
export async function recalculateWindowMinimums(
  setBy?: string | null,
): Promise<{ updated: number; unchanged: number; noFigure: number }> {
  await ensureInsightsSchema();
  const [items, cons] = await Promise.all([computedItems(), consumption()]);
  const rows = buildRows(items, cons).filter((r) => r.status === "window");

  let updated = 0;
  let unchanged = 0;
  let noFigure = 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const w = r.applied?.windowMonths;
      if (!isMinStockWindow(w)) continue;
      const level = r.suggested[w];
      if (level == null) {
        noFigure += 1;
        continue;
      }
      if (level === r.applied?.level) {
        unchanged += 1;
        continue;
      }
      await writeWindowMinimum(client, r, w, level, setBy ?? null);
      updated += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  invalidateItemsCache();
  return { updated, unchanged, noFigure };
}

/*
 * ---- Lead times, set from the review ---------------------------------------
 *
 * The minimum is consumption × lead time, so a lead time that is missing or
 * wrong leaves the minimum missing or wrong. Rather than send Allied to the
 * Suppliers page mid-review, the figure can be set here — on one item, or on
 * everything a filtered view selects. It lands on the item, wins over the
 * supplier's figure everywhere lead time is read, and any minimum that was
 * set from a window is re-derived from it in the same action, so the two can
 * never describe different waits.
 */

function validLeadDays(v: unknown): number {
  const d = Number(v);
  if (!Number.isFinite(d) || d <= 0 || d > 365)
    throw new Error("leadTimeDays must be between 1 and 365.");
  return Math.round(d);
}

/**
 * Re-derive window-based minimums for the given items from today's figures.
 * Manual minimums are left alone; an item whose window now gives nothing keeps
 * what it had and shows as drift.
 */
async function refreshWindowMinimums(itemUids: string[], setBy: string | null): Promise<number> {
  if (!itemUids.length) return 0;
  invalidateItemsCache();
  const wanted = new Set(itemUids);
  const [items, cons] = await Promise.all([computedItems(), consumption()]);
  const rows = buildRows(items, cons).filter((r) => wanted.has(r.uid) && r.status === "window");
  let updated = 0;
  const pool = getPool();
  for (const r of rows) {
    const w = r.applied?.windowMonths;
    if (!isMinStockWindow(w)) continue;
    const level = r.suggested[w];
    if (level == null || level === r.applied?.level) continue;
    await writeWindowMinimum(pool, r, w, level, setBy);
    updated += 1;
  }
  if (updated) invalidateItemsCache();
  return updated;
}

export async function setItemLeadTime(params: {
  itemUid: string;
  leadTimeDays: number;
  setBy?: string | null;
}): Promise<{ leadTimeDays: number; minimumsRefreshed: number }> {
  await ensureInsightsSchema();
  const days = validLeadDays(params.leadTimeDays);
  await getPool().query(
    `INSERT INTO platform_item_lead_time (item_uid, lead_time_days, set_by, set_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (item_uid) DO UPDATE SET
       lead_time_days = EXCLUDED.lead_time_days, set_by = EXCLUDED.set_by, set_at = NOW()`,
    [params.itemUid, days, params.setBy ?? null],
  );
  invalidateItemsCache();
  const minimumsRefreshed = await refreshWindowMinimums([params.itemUid], params.setBy ?? null);
  return { leadTimeDays: days, minimumsRefreshed };
}

/** Back to the supplier's figure. */
export async function clearItemLeadTime(
  itemUid: string,
  setBy?: string | null,
): Promise<{ minimumsRefreshed: number }> {
  await ensureInsightsSchema();
  await getPool().query(`DELETE FROM platform_item_lead_time WHERE item_uid = $1`, [itemUid]);
  invalidateItemsCache();
  return { minimumsRefreshed: await refreshWindowMinimums([itemUid], setBy ?? null) };
}

/**
 * Set one lead time on every item the filters select, or clear the item-level
 * figures from them (`leadTimeDays: null`) so they fall back to their suppliers.
 */
export async function applyLeadTimeToView(
  f: MinStockFilters,
  leadTimeDays: number | null,
  setBy?: string | null,
): Promise<{ items: number; minimumsRefreshed: number }> {
  await ensureInsightsSchema();
  const w = resolveWindow(f);
  const days = leadTimeDays == null ? null : validLeadDays(leadTimeDays);
  const [items, cons] = await Promise.all([computedItems(), consumption()]);
  const rows = applyFilters(buildRows(items, cons), f, w);
  const uids = days == null ? rows.filter((r) => r.leadTimeItemDays != null).map((r) => r.uid) : rows.map((r) => r.uid);
  if (!uids.length) return { items: 0, minimumsRefreshed: 0 };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    if (days == null) {
      await client.query(`DELETE FROM platform_item_lead_time WHERE item_uid = ANY($1)`, [uids]);
    } else {
      await client.query(
        `INSERT INTO platform_item_lead_time (item_uid, lead_time_days, set_by, set_at)
         SELECT u, $2, $3, NOW() FROM UNNEST($1::text[]) AS u
         ON CONFLICT (item_uid) DO UPDATE SET
           lead_time_days = EXCLUDED.lead_time_days, set_by = EXCLUDED.set_by, set_at = NOW()`,
        [uids, days, setBy ?? null],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  invalidateItemsCache();
  return { items: uids.length, minimumsRefreshed: await refreshWindowMinimums(uids, setBy ?? null) };
}

/** The review as a spreadsheet, honouring the filters on screen. */
export async function minStockCsv(f: MinStockFilters): Promise<{ filename: string; csv: string }> {
  const data = await minStockReview({ ...f, all: true });
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(Number(v.toFixed(4))) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const header = [
    "Item number", "Item name", "Product type", "Product finish", "Tags",
    "Supplier", "Region", "Lead time (days)", "Lead time source",
    "Consumed 6m", "Consumed 12m", "Consumed 18m",
    "Per month 6m", "Per month 12m", "Per month 18m",
    "Suggested min 6m", "Suggested min 12m", "Suggested min 18m",
    "Applied min stock", "Applied basis", "Applied window (months)", "Applied on",
    "Now for that window", "MYOB min level", "Free stock", "Below min",
  ];
  const lines = [header.join(",")];
  for (const r of data.rows) {
    lines.push(
      [
        esc(r.number), esc(r.name), esc(r.productType), esc(r.productFinish), esc(r.tags.join(" ")),
        esc(r.supplierName), esc(r.supplierRegion), esc(r.leadTimeDays),
        esc(
          r.leadTimeSource === "item"
            ? "Set by Allied on the item"
            : r.leadTimeSource === "supplier"
              ? "Set by Allied on the supplier"
              : r.leadTimeSource === "measured"
                ? `Measured over ${r.leadTimeOrders} orders`
                : "",
        ),
        esc(r.consumed[6]), esc(r.consumed[12]), esc(r.consumed[18]),
        esc(r.burn[6]), esc(r.burn[12]), esc(r.burn[18]),
        esc(r.suggested[6]), esc(r.suggested[12]), esc(r.suggested[18]),
        esc(r.applied?.level), esc(r.applied ? (r.applied.basis === "manual" ? "By hand" : "Window") : ""),
        esc(r.applied?.windowMonths), esc(r.applied?.setAt?.slice(0, 10)),
        esc(r.nowForWindow), esc(r.myobMinLevel), esc(r.freeStock), r.belowMin ? "Yes" : "",
      ].join(","),
    );
  }
  return {
    filename: `allied-minimum-stock-${data.windowMonths}m-${businessToday()}.csv`,
    csv: `﻿${lines.join("\r\n")}\r\n`,
  };
}
