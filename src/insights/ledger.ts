import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";

/**
 * Stocktake-anchored stock ledger (P1).
 *
 * Allied do not trust MYOB's stock figure, and the data supports them: across
 * 51 physical counts, every single one of the 193 counted lines had drifted —
 * NZ$36,563 of stock value corrected in total. So on hand is not read from
 * MYOB, it is derived:
 *
 *     on_hand(item, D) = counted_qty(last count on or before D)
 *                      + Σ movements strictly after that count, up to D
 *
 * Movements come from the four endpoints that actually move stock — purchase
 * bills (+), sale invoices (−), builds (±) and adjustments (±) — unioned in the
 * `stock_movements` view. Purchase and sale orders are excluded on purpose:
 * they are intent, not movement.
 *
 * Two rules fall out of the data and are enforced here:
 *
 *  1. NEVER ROLL BACKWARDS THROUGH A COUNT. A count absorbs drift that no
 *     document explains, so running the ledger back past one produces nonsense
 *     (SPWD20G holds 27,880 but reconstructs to −5,080 across its count).
 *     A date earlier than an item's applicable count is reported as such
 *     rather than answered with a number.
 *
 *  2. A COUNT IS THE LAST WORD ON ITS DATE. MYOB returns dates with no time
 *     component, so same-day ordering is unknowable. Movements are applied only
 *     from the day after an anchor.
 *
 * What this buys over reading MYOB directly, stated honestly: where a count was
 * recorded in MYOB, its counted quantity has to be recovered by rolling back
 * from today, so the resulting figure agrees with a plain reconstruction. The
 * gain there is the *validity boundary* and the measured drift, not a different
 * number. Where Allied enter a count MYOB never had, the figures genuinely
 * diverge — and that is the path to a number they can trust over MYOB's.
 */

export type CountSource = "myob_adjustment" | "manual" | "csv_import";

/** Wording Allied actually use. Deliberately broad — a person confirms. */
const STOCKTAKE_MEMO_PATTERN = "stock ?take|stock ?count|count qty|counted|recount";

export interface StocktakeCandidate {
  adjustmentUid: string;
  number: string | null;
  date: string;
  memo: string | null;
  itemCount: number;
  /** Items whose lines cancel out entirely — no real correction. */
  itemsNetZero: number;
  unitsCorrected: number;
  valueCorrected: number;
  confirmed: boolean | null;
  confirmedBy: string | null;
  strictMatch: boolean;
}

/**
 * Adjustments whose memo suggests a physical count, with the drift each one
 * corrected so a reviewer can judge without opening MYOB.
 *
 * Detection proposes; Allied decides. Memo wording is inconsistent enough that
 * a regex must never silently define an anchor.
 */
export async function stocktakeCandidates(options?: {
  includeConfirmed?: boolean;
}): Promise<StocktakeCandidate[]> {
  await ensureInsightsSchema();
  /*
   * Drift is netted per item before being summed. Allied's adjustments contain
   * offsetting pairs on the same item — the MHS16ES16 count posts −6, −570 and
   * +570, where the ±570 cancels and the real correction is 6 units. Summing
   * absolute line values instead treats that as 1,146 units and overstates
   * drift across all counts by 4.3x ($36,563 gross vs $8,527 net). This is the
   * double debit/credit artefact the brief warns about, and netting is the only
   * honest reading.
   */
  const result = await getPool().query(
    `WITH per_item AS (
       SELECT a.uid AS adjustment_uid, l.item_uid,
              SUM(l.qty) AS net_qty,
              MAX(COALESCE(NULLIF(l.unit_cost, 0), i.average_cost, 0)) AS cost
       FROM myob_adjustments a
       JOIN myob_adjustment_lines l ON l.adjustment_uid = a.uid
       LEFT JOIN myob_items i ON i.uid = l.item_uid
       WHERE l.item_uid IS NOT NULL
       GROUP BY a.uid, l.item_uid
     )
     SELECT a.uid, a.number, a.date::date::text AS date, a.memo,
            COUNT(p.item_uid)::int AS item_count,
            COUNT(*) FILTER (WHERE ABS(p.net_qty) < 0.001)::int AS items_net_zero,
            COALESCE(SUM(ABS(p.net_qty)), 0)::float8 AS units_corrected,
            COALESCE(SUM(ABS(p.net_qty) * p.cost), 0)::float8 AS value_corrected,
            c.is_stocktake, c.confirmed_by,
            (a.memo ~* $1) AS strict_match
     FROM myob_adjustments a
     JOIN per_item p ON p.adjustment_uid = a.uid
     LEFT JOIN platform_stocktake_confirmation c ON c.adjustment_uid = a.uid
     WHERE a.memo ~* $2 OR c.is_stocktake IS NOT NULL
     GROUP BY a.uid, a.number, a.date, a.memo, c.is_stocktake, c.confirmed_by
     ORDER BY a.date DESC`,
    ["stock ?take|stock ?count", STOCKTAKE_MEMO_PATTERN],
  );
  return result.rows
    .filter((r) => options?.includeConfirmed !== false || r.is_stocktake === null)
    .map((r) => ({
      adjustmentUid: r.uid as string,
      number: r.number as string | null,
      date: String(r.date),
      memo: r.memo as string | null,
      itemCount: r.item_count as number,
      itemsNetZero: r.items_net_zero as number,
      unitsCorrected: r.units_corrected as number,
      valueCorrected: r.value_corrected as number,
      confirmed: r.is_stocktake as boolean | null,
      confirmedBy: r.confirmed_by as string | null,
      strictMatch: Boolean(r.strict_match),
    }));
}

/**
 * Record Allied's decision on one candidate, then rebuild the counts it implies.
 * Rejecting a previously-confirmed adjustment removes its anchors again.
 */
export async function confirmStocktake(params: {
  adjustmentUid: string;
  isStocktake: boolean;
  confirmedBy?: string | null;
  note?: string | null;
}): Promise<{ countsWritten: number }> {
  await ensureInsightsSchema();
  const pool = getPool();
  await pool.query(
    `INSERT INTO platform_stocktake_confirmation
       (adjustment_uid, is_stocktake, confirmed_by, note, confirmed_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (adjustment_uid) DO UPDATE SET
       is_stocktake = EXCLUDED.is_stocktake,
       confirmed_by = EXCLUDED.confirmed_by,
       note = EXCLUDED.note,
       confirmed_at = NOW()`,
    [params.adjustmentUid, params.isStocktake, params.confirmedBy ?? null, params.note ?? null],
  );
  return { countsWritten: await rebuildCountsFromConfirmed(params.adjustmentUid) };
}

/**
 * Derive `platform_stock_count` rows from confirmed stocktake adjustments.
 *
 * A MYOB adjustment stores a delta, not the counted figure, so the counted
 * quantity is recovered as the running balance immediately after it:
 *
 *     counted_qty = qty_on_hand(today) − Σ movements strictly after the count
 *
 * `drift_qty` is the adjustment line itself: how far MYOB had drifted from
 * physical reality at that moment. That number is only ever knowable at a count,
 * and it is the strongest evidence we can give Allied for why the ledger exists.
 *
 * Only rows sourced from MYOB adjustments are rebuilt — manual and CSV counts
 * are Allied's own input and are never touched here.
 */
export async function rebuildCountsFromConfirmed(
  adjustmentUid?: string,
): Promise<number> {
  await ensureInsightsSchema();
  const pool = getPool();
  const scope = adjustmentUid ? `AND a.uid = $1` : "";
  const args = adjustmentUid ? [adjustmentUid] : [];

  await pool.query(
    `DELETE FROM platform_stock_count sc
     WHERE sc.source = 'myob_adjustment'
       AND ($1::text IS NULL OR sc.source_ref = $1)
       AND NOT EXISTS (
         SELECT 1 FROM platform_stocktake_confirmation c
         WHERE c.adjustment_uid = sc.source_ref AND c.is_stocktake
       )`,
    [adjustmentUid ?? null],
  );

  const result = await pool.query(
    `INSERT INTO platform_stock_count
       (item_uid, count_date, counted_qty, drift_qty, source, source_ref, entered_by, note)
     SELECT l.item_uid,
            a.date::date,
            i.qty_on_hand - COALESCE((
              SELECT SUM(m.qty) FROM stock_movements m
              WHERE m.item_uid = l.item_uid AND m.moved_on > a.date::date
            ), 0),
            SUM(l.qty),
            'myob_adjustment',
            a.uid,
            c.confirmed_by,
            a.memo
     FROM myob_adjustments a
     JOIN myob_adjustment_lines l ON l.adjustment_uid = a.uid
     JOIN myob_items i ON i.uid = l.item_uid
     JOIN platform_stocktake_confirmation c
       ON c.adjustment_uid = a.uid AND c.is_stocktake
     WHERE l.item_uid IS NOT NULL ${scope}
     GROUP BY l.item_uid, a.date, a.uid, a.memo, i.qty_on_hand, c.confirmed_by
     ON CONFLICT (item_uid, count_date, COALESCE(source_ref, '')) DO UPDATE SET
       counted_qty = EXCLUDED.counted_qty,
       drift_qty = EXCLUDED.drift_qty,
       note = EXCLUDED.note,
       updated_at = NOW()`,
    args,
  );
  return result.rowCount ?? 0;
}

export type PositionBasis = "counted" | "reconstructed" | "precedes_count";

export interface LedgerPosition {
  uid: string;
  number: string | null;
  name: string | null;
  onHand: number | null;
  myobOnHand: number | null;
  divergence: number | null;
  anchorDate: string | null;
  anchorQty: number | null;
  anchorSource: CountSource | null;
  anchorDrift: number | null;
  movementsSinceAnchor: number;
  basis: PositionBasis;
}

/**
 * On-hand position for every inventoried item as at a date.
 *
 * Anchored items roll forward from their count. Items with no count on or
 * before the date fall back to rolling today's MYOB figure backwards, labelled
 * `reconstructed` — honest, but only as good as MYOB. Items whose only counts
 * fall *after* the date are reported `precedes_count` with no number, because
 * rolling back through a count is invalid.
 */
export async function positionsAsAt(asAt: string): Promise<LedgerPosition[]> {
  await ensureInsightsSchema();
  const result = await getPool().query(
    `WITH anchor AS (
       SELECT DISTINCT ON (item_uid)
              item_uid, count_date, counted_qty, drift_qty, source
       FROM platform_stock_count
       WHERE count_date <= $1::date
       ORDER BY item_uid, count_date DESC, id DESC
     ),
     later_count AS (
       SELECT DISTINCT ON (item_uid) item_uid, count_date
       FROM platform_stock_count
       WHERE count_date > $1::date
       ORDER BY item_uid, count_date ASC, id ASC
     ),
     since_anchor AS (
       SELECT m.item_uid, SUM(m.qty)::float8 AS qty
       FROM stock_movements m
       JOIN anchor a ON a.item_uid = m.item_uid
       WHERE m.moved_on > a.count_date AND m.moved_on <= $1::date
       GROUP BY m.item_uid
     ),
     after_asat AS (
       SELECT item_uid, SUM(qty)::float8 AS qty
       FROM stock_movements
       WHERE moved_on > $1::date
       GROUP BY item_uid
     )
     SELECT i.uid, i.number, i.name, i.qty_on_hand::float8 AS myob_on_hand,
            a.count_date::text AS count_date, a.counted_qty::float8, a.drift_qty::float8, a.source,
            COALESCE(sa.qty, 0)::float8 AS since_anchor,
            COALESCE(aa.qty, 0)::float8 AS after_asat,
            (a.item_uid IS NULL AND lc.item_uid IS NOT NULL) AS precedes_count
     FROM myob_items i
     LEFT JOIN anchor a ON a.item_uid = i.uid
     LEFT JOIN later_count lc ON lc.item_uid = i.uid
     LEFT JOIN since_anchor sa ON sa.item_uid = i.uid
     LEFT JOIN after_asat aa ON aa.item_uid = i.uid
     WHERE i.is_inventoried
     ORDER BY i.number`,
    [asAt],
  );

  return result.rows.map((r) => {
    const anchored = r.count_date != null;
    const precedes = Boolean(r.precedes_count);
    const onHand = precedes
      ? null
      : anchored
        ? Number(r.counted_qty) + Number(r.since_anchor)
        : Number(r.myob_on_hand ?? 0) - Number(r.after_asat);
    return {
      uid: r.uid as string,
      number: r.number as string | null,
      name: r.name as string | null,
      onHand,
      myobOnHand: r.myob_on_hand as number | null,
      divergence:
        onHand == null || r.myob_on_hand == null ? null : onHand - Number(r.myob_on_hand),
      anchorDate: anchored ? String(r.count_date) : null,
      anchorQty: anchored ? Number(r.counted_qty) : null,
      anchorSource: anchored ? (r.source as CountSource) : null,
      anchorDrift: r.drift_qty == null ? null : Number(r.drift_qty),
      movementsSinceAnchor: Number(r.since_anchor),
      basis: precedes ? "precedes_count" : anchored ? "counted" : "reconstructed",
    };
  });
}

export interface LedgerEntry {
  date: string;
  kind: string;
  docNumber: string | null;
  qty: number;
  party: string | null;
  memo: string | null;
  balance: number;
}

/**
 * The audit trail behind one item's on-hand figure: the anchor, then every
 * movement since, with a running balance. This is what "show the working"
 * means for the number Allied are asked to trust.
 */
export async function itemLedger(
  itemUid: string,
  asAt?: string,
): Promise<{
  anchor: { date: string; qty: number; source: CountSource; drift: number | null } | null;
  entries: LedgerEntry[];
  closing: number | null;
  myobOnHand: number | null;
}> {
  await ensureInsightsSchema();
  const pool = getPool();
  const end = asAt ?? new Date().toISOString().slice(0, 10);

  const [anchorRes, itemRes] = await Promise.all([
    pool.query(
      `SELECT count_date::text AS count_date, counted_qty::float8, drift_qty::float8, source
       FROM platform_stock_count
       WHERE item_uid = $1 AND count_date <= $2::date
       ORDER BY count_date DESC, id DESC LIMIT 1`,
      [itemUid, end],
    ),
    pool.query(`SELECT qty_on_hand::float8 FROM myob_items WHERE uid = $1`, [itemUid]),
  ]);

  const anchorRow = anchorRes.rows[0];
  const anchor = anchorRow
    ? {
        date: String(anchorRow.count_date),
        qty: Number(anchorRow.counted_qty),
        source: anchorRow.source as CountSource,
        drift: anchorRow.drift_qty == null ? null : Number(anchorRow.drift_qty),
      }
    : null;

  // With no anchor there is no defensible opening balance, so the trail starts
  // from the beginning of held history and is labelled reconstructed upstream.
  const from = anchor?.date ?? "1900-01-01";
  const movements = await pool.query(
    `SELECT moved_on::text AS date, kind, doc_number, qty::float8, party, memo
     FROM stock_movements
     WHERE item_uid = $1 AND moved_on > $2::date AND moved_on <= $3::date
     ORDER BY moved_on, kind, doc_number`,
    [itemUid, from, end],
  );

  let balance = anchor?.qty ?? 0;
  const entries: LedgerEntry[] = movements.rows.map((m) => {
    balance += Number(m.qty);
    return {
      date: String(m.date),
      kind: m.kind as string,
      docNumber: m.doc_number as string | null,
      qty: Number(m.qty),
      party: m.party as string | null,
      memo: m.memo as string | null,
      balance,
    };
  });

  return {
    anchor,
    entries,
    closing: anchor ? balance : null,
    myobOnHand: itemRes.rows[0]?.qty_on_hand ?? null,
  };
}

/**
 * How much of the catalogue is anchored to a real count, and how stale those
 * anchors are. This tells Allied where to count next, which is useful in its
 * own right.
 */
export async function anchorCoverage(): Promise<Record<string, unknown>> {
  await ensureInsightsSchema();
  const result = await getPool().query(
    `WITH latest AS (
       SELECT DISTINCT ON (item_uid) item_uid, count_date, source
       FROM platform_stock_count
       ORDER BY item_uid, count_date DESC, id DESC
     )
     SELECT
       (SELECT COUNT(*)::int FROM myob_items WHERE is_inventoried) AS inventoried_items,
       COUNT(*)::int AS anchored_items,
       COUNT(*) FILTER (WHERE count_date > NOW() - INTERVAL '90 days')::int AS anchored_90d,
       COUNT(*) FILTER (WHERE count_date > NOW() - INTERVAL '365 days')::int AS anchored_365d,
       MIN(count_date)::text AS oldest_anchor,
       MAX(count_date)::text AS newest_anchor
     FROM latest`,
  );
  const drift = await getPool().query(
    `SELECT COUNT(*)::int AS counted_lines,
            COALESCE(SUM(ABS(drift_qty)), 0)::float8 AS units_corrected,
            COALESCE(SUM(ABS(drift_qty) * COALESCE(i.average_cost, 0)), 0)::float8 AS value_corrected,
            COUNT(*) FILTER (WHERE drift_qty <> 0)::int AS lines_that_drifted
     FROM platform_stock_count sc
     JOIN myob_items i ON i.uid = sc.item_uid
     WHERE sc.drift_qty IS NOT NULL`,
  );
  return { ...result.rows[0], drift: drift.rows[0] };
}
