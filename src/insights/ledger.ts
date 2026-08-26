import type pg from "pg";
import { BUSINESS_TODAY_SQL, businessToday } from "./businessDate.js";
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


/*
 * positionsAsAt() was removed on 26 Aug 2026.
 *
 * Nothing called it, and its anchor logic had drifted away from the live one:
 * it treated the conversion balance as a blocking count, so it would have
 * reported "before the last count — not reported" for every item on every
 * historical date. A second, wrong definition of the product's central
 * calculation sitting unused is worse than no definition at all, because the
 * next person to need it would have reached for it.
 *
 * ownedPositions() and item_position_at() are the two that are real, and they
 * agree with each other by construction.
 */

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
 * The audit trail behind one item's on-hand figure: the reference point, then
 * every document between it and the date, with a running balance. This is what
 * "show the working" means for the number Allied are asked to trust.
 *
 * It runs in whichever direction the ledger ran, and that is the whole point of
 * this function existing rather than a simple forward loop:
 *
 *   forward  — a count on or before the date. Start at the counted quantity and
 *              apply each document since. The ordinary case.
 *   backward — no count yet at that date, but the conversion balance sits after
 *              it. Start at the balance and UNDO each document back to the date.
 *              This is the case that used to be answered with "no reference
 *              point recorded for this item yet", which sent Allied off to count
 *              something that did not need counting, while the position screens
 *              were happily reporting a figure for the same item and date.
 *   blocked  — a physical count sits between the date and now. A count absorbs
 *              drift no document explains, so reading back through one is
 *              invalid and no trail is offered.
 *
 * `closing` always equals the figure `item_position_at` reports for the same
 * item and date; they are two renderings of one calculation.
 */
export async function itemLedger(
  itemUid: string,
  asAt?: string,
): Promise<{
  anchor: { date: string; qty: number; source: CountSource; drift: number | null } | null;
  entries: LedgerEntry[];
  closing: number | null;
  myobOnHand: number | null;
  asAt: string;
  /** Which way the ledger ran, so the UI can say so rather than imply forward. */
  direction: "forward" | "backward" | null;
  /** Set when no trail can honestly be drawn, with the reason in plain words. */
  blocked: { reason: "precedes_count"; countDate: string } | null;
}> {
  await ensureInsightsSchema();
  const pool = getPool();
  const end = asAt ?? businessToday();

  const [anchorRes, laterRes, openingRes, itemRes] = await Promise.all([
    /*
     * The applicable reference point. The tiebreak matters and is shared with
     * item_position_at and ownedPositions: where a real count and the opening
     * balance carry the same date, the count wins, because the opening balance
     * is a bookkeeping conversion and the count is an observation of the shelf.
     */
    pool.query(
      `SELECT count_date::text AS count_date, counted_qty::float8, drift_qty::float8, source
       FROM platform_stock_count
       WHERE item_uid = $1 AND count_date <= $2::date
       ORDER BY count_date DESC, (source <> 'opening_balance') DESC, id DESC
       LIMIT 1`,
      [itemUid, end],
    ),
    pool.query(
      `SELECT count_date::text AS count_date
       FROM platform_stock_count
       WHERE item_uid = $1 AND count_date > $2::date AND source <> 'opening_balance'
       ORDER BY count_date ASC, id ASC LIMIT 1`,
      [itemUid, end],
    ),
    pool.query(
      `SELECT count_date::text AS count_date, counted_qty::float8
       FROM platform_stock_count
       WHERE item_uid = $1 AND source = 'opening_balance'
       ORDER BY count_date ASC LIMIT 1`,
      [itemUid],
    ),
    pool.query(`SELECT qty_on_hand::float8 FROM myob_items WHERE uid = $1`, [itemUid]),
  ]);

  const myobOnHand = (itemRes.rows[0]?.qty_on_hand as number | null) ?? null;
  const empty = { entries: [] as LedgerEntry[], closing: null, myobOnHand, asAt: end };

  const anchorRow = anchorRes.rows[0];
  const openingRow = openingRes.rows[0];

  // A count between the date and now. Reading back through it is invalid.
  if (!anchorRow && laterRes.rows[0]) {
    return {
      ...empty,
      anchor: null,
      direction: null,
      blocked: { reason: "precedes_count", countDate: String(laterRes.rows[0].count_date) },
    };
  }

  const backward = !anchorRow && Boolean(openingRow);
  const reference = anchorRow ?? openingRow;
  if (!reference) {
    // No count and no conversion balance: nothing to measure from. Only
    // reachable for items MYOB does not inventory.
    return { ...empty, anchor: null, direction: null, blocked: null };
  }

  const anchor = {
    date: String(reference.count_date),
    qty: Number(reference.counted_qty),
    source: (anchorRow?.source ?? "opening_balance") as CountSource,
    drift: anchorRow?.drift_qty == null ? null : Number(anchorRow.drift_qty),
  };

  /*
   * Forward: documents after the reference, up to the date, oldest first.
   * Backward: documents after the date, up to the reference, newest first —
   * so the running balance walks back from the balance to the date.
   */
  const [from, to] = backward ? [end, anchor.date] : [anchor.date, end];
  const movements = await pool.query(
    `SELECT moved_on::text AS date, kind, doc_number, qty::float8, party, memo
     FROM stock_movements
     WHERE item_uid = $1 AND moved_on > $2::date AND moved_on <= $3::date
     ORDER BY moved_on ${backward ? "DESC" : "ASC"}, kind, doc_number`,
    [itemUid, from, to],
  );

  let balance = anchor.qty;
  const entries: LedgerEntry[] = movements.rows.map((m) => {
    const qty = Number(m.qty);
    // Going backwards, each document is undone rather than applied, and the
    // balance shown against it is the balance *before* it happened.
    balance += backward ? -qty : qty;
    return {
      date: String(m.date),
      kind: m.kind as string,
      docNumber: m.doc_number as string | null,
      qty,
      party: m.party as string | null,
      memo: m.memo as string | null,
      balance,
    };
  });

  return {
    anchor,
    entries,
    closing: balance,
    myobOnHand,
    asAt: end,
    direction: backward ? "backward" : "forward",
    blocked: null,
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

/* ---- Owning the numbers: opening balance, our committed, daily snapshots ---- */

/**
 * Establish the opening balance — the one and only time MYOB's stock figure is
 * used as an input.
 *
 * Why this is necessary rather than counting up from zero: MYOB exposes
 * `Inventory/Adjustment` and `Inventory/Build` only from 2023-04-03, while
 * `Sale/Invoice` goes back to 2011 and 507 pre-2023 invoices already sell
 * inventoried items. There is no opening-stock entry anywhere in the file. So a
 * from-zero ledger would be missing years of receipts and adjustments and would
 * be confidently wrong. Probed against the live file on 18 Aug 2026.
 *
 * This is the standard conversion-balance approach used when moving onto a new
 * inventory system: take the outgoing system's closing position once, then own
 * every movement after it. It is written as a normal anchor with
 * source 'opening_balance', so:
 *   - the ledger treats it exactly like a count,
 *   - it is visible and auditable rather than hidden in the arithmetic,
 *   - any real stocktake after it supersedes it automatically, which is how
 *     MYOB's contribution gets progressively replaced by physical reality.
 *
 * Safe to call repeatedly: it will not move an existing opening balance, since
 * doing so would silently rewrite history.
 */
/**
 * Re-derive the conversion balance for every item that still has nothing better.
 *
 * THE BUG THIS FIXES. The opening balance is a snapshot taken at one instant,
 * but it was written as a normal anchor and so inherited the physical-count
 * rule: movements apply only from the day *after* it. A document dated on or
 * before the cutover date but keyed into MYOB after the snapshot instant is
 * then in neither half — not in the anchor, and excluded from the movements.
 * It was dropped from the ledger permanently, and nothing ever corrected it.
 *
 * On the live file that lost 17 items' worth of stock, every one of them with
 * movements dated on the cutover day, six matching a single late-entered
 * document exactly (DSSS200P +13 against a −13 adjustment, and so on).
 *
 * The repair is the same arithmetic `rebuildCountsFromConfirmed` already uses
 * to recover a counted quantity from a MYOB adjustment: work back from what
 * MYOB holds now.
 *
 *     counted_qty = qty_on_hand(now) − Σ movements after the anchor, to today
 *
 * Late entries land inside `qty_on_hand` and outside the subtracted window, so
 * they are absorbed into the anchor where they belong. Running it every sync
 * makes the conversion balance self-healing rather than a one-shot guess.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO. It never touches an item that has a
 * real physical count — the whole point of a count is that Allied's figure
 * beats MYOB's, and re-deriving from `qty_on_hand` would hand the file back to
 * MYOB. And it never moves `count_date`, so the ledger's validity boundary and
 * every audit trail hanging off it stay where they were.
 *
 * The upper bound is today, not open-ended: it makes on-hand agree with MYOB
 * exactly at today's date. There are no post-dated movements on the file, so
 * the bound costs nothing now, and if one ever appears it will project forward
 * from the anchor instead of being silently folded into it.
 */
export async function reconcileOpeningBalances(): Promise<{
  itemsCorrected: number;
  unitsCorrected: number;
}> {
  const today = businessToday();
  const result = await getPool().query(
    `WITH target AS (
       SELECT sc.id, sc.counted_qty AS was,
              (i.qty_on_hand - COALESCE((
                 SELECT SUM(m.qty) FROM stock_movements m
                 WHERE m.item_uid = sc.item_uid
                   AND m.moved_on > sc.count_date
                   AND m.moved_on <= $1::date
               ), 0))::float8 AS should_be
       FROM platform_stock_count sc
       JOIN myob_items i ON i.uid = sc.item_uid
       WHERE sc.source = 'opening_balance'
         AND NOT EXISTS (
           SELECT 1 FROM platform_stock_count x
           WHERE x.item_uid = sc.item_uid AND x.source <> 'opening_balance'
         )
     ),
     changed AS (
       SELECT * FROM target WHERE ABS(should_be - was) > 0.0001
     ),
     applied AS (
       UPDATE platform_stock_count sc
       SET counted_qty = c.should_be, updated_at = NOW()
       FROM changed c WHERE c.id = sc.id
       RETURNING 1
     )
     SELECT (SELECT COUNT(*)::int FROM applied) AS items_corrected,
            (SELECT COALESCE(SUM(ABS(should_be - was)), 0)::float8 FROM changed) AS units_corrected`,
    [today],
  );
  return {
    itemsCorrected: result.rows[0].items_corrected as number,
    unitsCorrected: result.rows[0].units_corrected as number,
  };
}

export async function establishOpeningBalance(params?: {
  asOf?: string;
  force?: boolean;
}): Promise<{
  asOf: string;
  itemsAnchored: number;
  alreadyExisted: boolean;
  reconciled?: { itemsCorrected: number; unitsCorrected: number };
}> {
  await ensureInsightsSchema();
  const pool = getPool();
  const asOf = params?.asOf ?? businessToday();

  const existing = await pool.query(
    `SELECT count_date::text AS d, COUNT(*)::int AS n
     FROM platform_stock_count WHERE source = 'opening_balance'
     GROUP BY count_date ORDER BY count_date LIMIT 1`,
  );
  if (existing.rows[0] && !params?.force) {
    /*
     * The cutover has happened, but items created in MYOB since then have no
     * anchor at all and would drop out of every position query. Give each of
     * them its own opening balance dated today. Existing anchors are untouched:
     * re-dating them would rewrite history.
     */
    const reconciled = await reconcileOpeningBalances();
    const topUp = await pool.query(
      `INSERT INTO platform_stock_count
         (item_uid, count_date, counted_qty, drift_qty, source, source_ref, entered_by, note)
       SELECT i.uid, $1::date, COALESCE(i.qty_on_hand, 0), NULL,
              'opening_balance', NULL, 'system',
              'Opening balance for an item first seen after cutover.'
       FROM myob_items i
       WHERE i.is_inventoried
         AND NOT EXISTS (SELECT 1 FROM platform_stock_count c WHERE c.item_uid = i.uid)
       ON CONFLICT (item_uid, count_date, COALESCE(source_ref, '')) DO NOTHING`,
      // CURRENT_DATE is the database's date and the database runs in UTC, which
      // names yesterday for half of every New Zealand day. Allied's calendar
      // decides what "today" means, here as everywhere else.
      [asOf],
    );
    return {
      asOf: existing.rows[0].d as string,
      itemsAnchored: (existing.rows[0].n as number) + (topUp.rowCount ?? 0),
      alreadyExisted: true,
      reconciled,
    };
  }
  if (params?.force) {
    await pool.query(`DELETE FROM platform_stock_count WHERE source = 'opening_balance'`);
  }

  const result = await pool.query(
    `INSERT INTO platform_stock_count
       (item_uid, count_date, counted_qty, drift_qty, source, source_ref, entered_by, note)
     SELECT uid, $1::date, COALESCE(qty_on_hand, 0), NULL,
            'opening_balance', NULL, 'system',
            'Opening balance taken from MYOB once at cutover. Every movement after this date is computed by this platform.'
     FROM myob_items WHERE is_inventoried
     ON CONFLICT (item_uid, count_date, COALESCE(source_ref, '')) DO NOTHING`,
    [asOf],
  );
  return { asOf, itemsAnchored: result.rowCount ?? 0, alreadyExisted: false };
}

export interface OwnedPosition {
  uid: string;
  number: string | null;
  name: string | null;
  onHand: number | null;
  committed: number;
  freeStock: number | null;
  onOrder: number;
  averageCost: number | null;
  stockValue: number | null;
  basis: PositionBasis | "no_opening_balance";
  anchorDate: string | null;
  anchorSource: string | null;
  myobOnHand: number | null;
  myobCommitted: number | null;
  divergence: number | null;
}

/**
 * The platform's own position for every item, as at a date.
 *
 * on hand   — anchor + our movement ledger. Never MYOB's figure.
 * committed — our sum of open sale-order lines. Never MYOB's figure. This one
 *             already disagrees with MYOB on 19 items: WR16503G carries 5,000
 *             units on open orders that MYOB reports as 0 committed, which
 *             would read as free-to-sell stock.
 * free      — our on hand minus our committed.
 * on order  — our sum of open purchase-order lines not yet billed.
 *
 * MYOB's figures come back on the row for comparison only, so divergence can be
 * shown and explained rather than quietly resolved.
 */
export async function ownedPositions(asAt?: string): Promise<OwnedPosition[]> {
  await ensureInsightsSchema();
  const date = asAt ?? businessToday();
  const result = await getPool().query(
    `WITH anchor AS (
       SELECT DISTINCT ON (item_uid) item_uid, count_date, counted_qty, source
       FROM platform_stock_count
       WHERE count_date <= $1::date
       ORDER BY item_uid, count_date DESC,
                (source <> 'opening_balance') DESC, id DESC
     ),
     /*
      * Only a *physical* count blocks rolling backwards. The opening balance is
      * a bookkeeping conversion, not an observation of the shelf, so reading
      * back through it is ordinary reconstruction and is perfectly valid —
      * which is what makes historical dates answerable at all.
      */
     later_count AS (
       SELECT DISTINCT ON (item_uid) item_uid FROM platform_stock_count
       WHERE count_date > $1::date AND source <> 'opening_balance'
       ORDER BY item_uid, count_date ASC
     ),
     opening AS (
       SELECT DISTINCT ON (item_uid) item_uid, count_date, counted_qty
       FROM platform_stock_count WHERE source = 'opening_balance'
       ORDER BY item_uid, count_date ASC
     ),
     back_from_opening AS (
       SELECT m.item_uid, SUM(m.qty)::float8 AS qty
       FROM stock_movements m JOIN opening o ON o.item_uid = m.item_uid
       WHERE m.moved_on > $1::date AND m.moved_on <= o.count_date
       GROUP BY m.item_uid
     ),
     since_anchor AS (
       SELECT m.item_uid, SUM(m.qty)::float8 AS qty
       FROM stock_movements m JOIN anchor a ON a.item_uid = m.item_uid
       WHERE m.moved_on > a.count_date AND m.moved_on <= $1::date
       GROUP BY m.item_uid
     ),
     /*
      * Open orders, as at the date. The bound applies only to historical dates
      * — see the matching note in item_position_at(). A future-dated order is
      * open now, so it is committed now; bounding today's figure by the order
      * date hid 31,600 reserved units and showed them as free to sell.
      */
     our_committed AS (
       SELECT l.item_uid, SUM(l.qty)::float8 AS qty
       FROM myob_sale_order_lines l
       JOIN myob_sale_orders o ON o.uid = l.order_uid
       WHERE UPPER(COALESCE(o.status, '')) = 'OPEN'
         AND l.item_uid IS NOT NULL
         AND (o.date::date <= $1::date OR $1::date >= ${BUSINESS_TODAY_SQL})
       GROUP BY l.item_uid
     ),
     our_on_order AS (
       SELECT l.item_uid, SUM(GREATEST(COALESCE(l.qty, 0) - COALESCE(l.received_qty, 0), 0))::float8 AS qty
       FROM myob_purchase_order_lines l
       JOIN myob_purchase_orders o ON o.uid = l.order_uid
       WHERE UPPER(COALESCE(o.status, '')) = 'OPEN'
         AND l.item_uid IS NOT NULL
         AND (o.date::date <= $1::date OR $1::date >= ${BUSINESS_TODAY_SQL})
       GROUP BY l.item_uid
     )
     SELECT i.uid, i.number, i.name, i.average_cost::float8,
            i.qty_on_hand::float8 AS myob_on_hand,
            i.qty_committed::float8 AS myob_committed,
            a.count_date::text AS anchor_date, a.counted_qty::float8, a.source AS anchor_source,
            COALESCE(sa.qty, 0)::float8 AS since_anchor,
            COALESCE(oc.qty, 0)::float8 AS committed,
            COALESCE(oo.qty, 0)::float8 AS on_order,
            (a.item_uid IS NULL AND lc.item_uid IS NOT NULL) AS precedes_count,
            op.counted_qty::float8 AS opening_qty,
            op.count_date::text AS opening_date,
            COALESCE(bo.qty, 0)::float8 AS back_from_opening
     FROM myob_items i
     LEFT JOIN anchor a ON a.item_uid = i.uid
     LEFT JOIN later_count lc ON lc.item_uid = i.uid
     LEFT JOIN opening op ON op.item_uid = i.uid
     LEFT JOIN back_from_opening bo ON bo.item_uid = i.uid
     LEFT JOIN since_anchor sa ON sa.item_uid = i.uid
     LEFT JOIN our_committed oc ON oc.item_uid = i.uid
     LEFT JOIN our_on_order oo ON oo.item_uid = i.uid
     WHERE i.is_inventoried
     ORDER BY i.number`,
    [date],
  );

  return result.rows.map((r) => {
    const anchored = r.anchor_date != null;
    const precedes = Boolean(r.precedes_count);
    // Before the conversion balance and with no physical count in between, roll
    // the opening balance backwards — the same reconstruction as before, just
    // pinned to a recorded anchor instead of a live MYOB read.
    const preOpening =
      !anchored && !precedes && r.opening_qty != null
        ? Number(r.opening_qty) - Number(r.back_from_opening)
        : null;
    const onHand = anchored
      ? Number(r.counted_qty) + Number(r.since_anchor)
      : preOpening;
    const committed = Number(r.committed);
    const cost = r.average_cost == null ? null : Number(r.average_cost);
    return {
      uid: r.uid as string,
      number: r.number as string | null,
      name: r.name as string | null,
      onHand,
      committed,
      freeStock: onHand == null ? null : onHand - committed,
      onOrder: Number(r.on_order),
      averageCost: cost,
      stockValue: onHand == null || cost == null ? null : onHand * cost,
      basis: anchored
        ? (r.anchor_source === "opening_balance" ? "reconstructed" : "counted")
        : precedes
          ? "precedes_count"
          : preOpening != null
            ? "reconstructed"
            : "no_opening_balance",
      anchorDate: anchored
        ? String(r.anchor_date)
        : preOpening != null
          ? String(r.opening_date)
          : null,
      anchorSource: anchored
        ? (r.anchor_source as string)
        : preOpening != null
          ? "opening_balance_rolled_back"
          : null,
      myobOnHand: r.myob_on_hand == null ? null : Number(r.myob_on_hand),
      myobCommitted: r.myob_committed == null ? null : Number(r.myob_committed),
      divergence:
        onHand == null || r.myob_on_hand == null ? null : onHand - Number(r.myob_on_hand),
    };
  });
}

/**
 * Persist one day's positions. Called at the end of every sync so the history
 * accumulates without anyone having to remember.
 *
 * Existing rows for the date are left alone unless `overwrite` is set: a
 * snapshot is a record of what we believed on that day, and silently rewriting
 * it would destroy the trail it exists to provide.
 */
export async function snapshotPositions(params?: {
  asAt?: string;
  overwrite?: boolean;
}): Promise<{ asAt: string; rows: number; rewritten: boolean }> {
  await ensureInsightsSchema();
  const asAt = params?.asAt ?? businessToday();
  const positions = await ownedPositions(asAt);
  const pool = getPool();

  if (params?.overwrite) {
    await pool.query(`DELETE FROM platform_daily_position WHERE as_at_date = $1::date`, [asAt]);
  }

  /*
   * A day that has not finished is not history yet.
   *
   * The row used to be written with ON CONFLICT DO NOTHING, so the first sync
   * of each New Zealand day claimed it and the five later syncs were silently
   * discarded (run #77 reported `rows: 0` for exactly this reason). Today's
   * snapshot was therefore a 9am figure carrying the whole day's date, and
   * every transaction Allied entered afterwards was missing from it forever.
   * For a month-end valuation, "31 July as at nine in the morning" is not what
   * anyone means by 31 July.
   *
   * So the current day's row is rewritten on every sync, and freezes on its own
   * once the date passes. Rows for dates already closed stay immutable, which
   * is the property the history table exists to provide.
   */
  const stillOpen = asAt >= businessToday();
  const conflict = stillOpen
    ? `ON CONFLICT (as_at_date, item_uid) DO UPDATE SET
         on_hand = EXCLUDED.on_hand, committed = EXCLUDED.committed,
         free_stock = EXCLUDED.free_stock, on_order = EXCLUDED.on_order,
         average_cost = EXCLUDED.average_cost, stock_value = EXCLUDED.stock_value,
         basis = EXCLUDED.basis, anchor_date = EXCLUDED.anchor_date,
         anchor_source = EXCLUDED.anchor_source, myob_on_hand = EXCLUDED.myob_on_hand,
         myob_committed = EXCLUDED.myob_committed, divergence = EXCLUDED.divergence,
         created_at = NOW()`
    : `ON CONFLICT (as_at_date, item_uid) DO NOTHING`;

  let rows = 0;
  const batch = 500;
  for (let i = 0; i < positions.length; i += batch) {
    const slice = positions.slice(i, i + batch);
    const values: unknown[] = [];
    const tuples = slice
      .map((p, n) => {
        const b = n * 14;
        values.push(
          asAt, p.uid, p.onHand, p.committed, p.freeStock, p.onOrder,
          p.averageCost, p.stockValue, p.basis, p.anchorDate, p.anchorSource,
          p.myobOnHand, p.myobCommitted, p.divergence,
        );
        return `($${b + 1}::date,$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10}::date,$${b + 11},$${b + 12},$${b + 13},$${b + 14})`;
      })
      .join(",");
    const res = await pool.query(
      `INSERT INTO platform_daily_position
         (as_at_date, item_uid, on_hand, committed, free_stock, on_order,
          average_cost, stock_value, basis, anchor_date, anchor_source,
          myob_on_hand, myob_committed, divergence)
       VALUES ${tuples}
       ${conflict}`,
      values,
    );
    rows += res.rowCount ?? 0;
  }
  return { asAt, rows, rewritten: stillOpen };
}

/** Dates for which a stored snapshot exists, newest first. */
export async function snapshotDates(): Promise<
  { asAt: string; items: number; stockValue: number }[]
> {
  await ensureInsightsSchema();
  const r = await getPool().query(
    `SELECT as_at_date::text AS as_at, COUNT(*)::int AS items,
            COALESCE(SUM(stock_value), 0)::float8 AS stock_value
     FROM platform_daily_position
     GROUP BY as_at_date ORDER BY as_at_date DESC`,
  );
  return r.rows.map((x) => ({
    asAt: x.as_at as string,
    items: x.items as number,
    stockValue: x.stock_value as number,
  }));
}


/**
 * Record a physical count Allied performed themselves.
 *
 * This is the mechanism by which the platform's numbers stop agreeing with
 * MYOB: a count entered here supersedes the conversion balance and every
 * MYOB-sourced anchor before it, so on hand is driven by what Allied actually
 * counted rather than by what MYOB believes.
 *
 * `drift_qty` records how far the platform's own figure was out at that moment,
 * which is the honest measure of how much the number needed correcting.
 */
export async function recordManualCount(params: {
  itemUid: string;
  countDate: string;
  countedQty: number;
  enteredBy?: string | null;
  note?: string | null;
  source?: "manual" | "csv_import";
  /** Join a caller's transaction, so a bulk import commits as one unit. */
  client?: { query: pg.Pool["query"] };
}): Promise<{ itemUid: string; countDate: string; countedQty: number; drift: number | null }> {
  await ensureInsightsSchema();
  const pool = params.client ?? getPool();

  // What we believed on that date, before the count lands.
  const before = await pool.query(
    `SELECT on_hand FROM (
       SELECT (sc.counted_qty + COALESCE((
         SELECT SUM(m.qty) FROM stock_movements m
         WHERE m.item_uid = sc.item_uid
           AND m.moved_on > sc.count_date AND m.moved_on <= $2::date
       ), 0)) AS on_hand
       FROM platform_stock_count sc
       WHERE sc.item_uid = $1 AND sc.count_date <= $2::date
       ORDER BY sc.count_date DESC, (sc.source <> 'opening_balance') DESC, sc.id DESC
       LIMIT 1
     ) x`,
    [params.itemUid, params.countDate],
  );
  const expected = before.rows[0]?.on_hand == null ? null : Number(before.rows[0].on_hand);
  const drift = expected == null ? null : params.countedQty - expected;

  await pool.query(
    `INSERT INTO platform_stock_count
       (item_uid, count_date, counted_qty, drift_qty, source, source_ref, entered_by, note)
     VALUES ($1, $2::date, $3, $4, $5, NULL, $6, $7)
     ON CONFLICT (item_uid, count_date, COALESCE(source_ref, '')) DO UPDATE SET
       counted_qty = EXCLUDED.counted_qty,
       drift_qty = EXCLUDED.drift_qty,
       entered_by = EXCLUDED.entered_by,
       note = EXCLUDED.note,
       updated_at = NOW()`,
    [
      params.itemUid, params.countDate, params.countedQty, drift,
      params.source ?? "manual", params.enteredBy ?? null, params.note ?? null,
    ],
  );
  return {
    itemUid: params.itemUid,
    countDate: params.countDate,
    countedQty: params.countedQty,
    drift,
  };
}

/**
 * Bulk count entry from a pasted sheet: `item number, counted qty[, count date]`.
 * Validated in full before anything is written, so a typo halfway down does not
 * leave the ledger half-updated.
 */
export async function importCounts(params: {
  rows: { itemNumber: string; countedQty: number; countDate?: string }[];
  countDate: string;
  enteredBy?: string | null;
  dryRun?: boolean;
}): Promise<{
  accepted: { itemNumber: string; countedQty: number; countDate: string; drift: number | null }[];
  rejected: { itemNumber: string; reason: string }[];
  written: number;
}> {
  await ensureInsightsSchema();
  const pool = getPool();
  const numbers = params.rows.map((r) => r.itemNumber);
  const known = await pool.query(
    `SELECT uid, number FROM myob_items WHERE number = ANY($1) AND is_inventoried`,
    [numbers],
  );
  const byNumber = new Map(known.rows.map((r) => [r.number as string, r.uid as string]));

  const accepted: { itemNumber: string; countedQty: number; countDate: string; drift: number | null }[] = [];
  const rejected: { itemNumber: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const row of params.rows) {
    const date = row.countDate ?? params.countDate;
    if (!byNumber.has(row.itemNumber)) {
      rejected.push({ itemNumber: row.itemNumber, reason: "not a stocked item in MYOB" });
    } else if (!Number.isFinite(row.countedQty) || row.countedQty < 0) {
      rejected.push({ itemNumber: row.itemNumber, reason: "counted quantity must be zero or more" });
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      rejected.push({ itemNumber: row.itemNumber, reason: `count date "${date}" is not yyyy-mm-dd` });
    } else if (seen.has(`${row.itemNumber}|${date}`)) {
      rejected.push({ itemNumber: row.itemNumber, reason: "duplicate row for the same item and date" });
    } else {
      seen.add(`${row.itemNumber}|${date}`);
      accepted.push({ itemNumber: row.itemNumber, countedQty: row.countedQty, countDate: date, drift: null });
    }
  }

  if (params.dryRun) return { accepted, rejected, written: 0 };

  /*
   * All of it or none of it.
   *
   * The rows were already validated as a batch, but they were then written one
   * at a time with no transaction, so a failure partway down — a dropped
   * connection, a constraint nobody anticipated — left half a counting sheet in
   * the ledger and half of it not. A half-applied stocktake is worse than a
   * rejected one, because nothing on screen says which half landed.
   */
  const client = await pool.connect();
  let written = 0;
  try {
    await client.query("BEGIN");
    for (const a of accepted) {
      const res = await recordManualCount({
        itemUid: byNumber.get(a.itemNumber)!,
        countDate: a.countDate,
        countedQty: a.countedQty,
        enteredBy: params.enteredBy,
        source: "csv_import",
        note: "Bulk count import",
        client,
      });
      a.drift = res.drift;
      written += 1;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  return { accepted, rejected, written };
}


/**
 * Where the platform's figures disagree with MYOB's, priced so the biggest
 * discrepancies come first. Committed differences are shown separately from
 * on-hand ones because they have different causes: committed diverges as soon
 * as MYOB miscounts open orders, whereas on hand only diverges once a real
 * count lands or our movement ledger parts company with MYOB's.
 */
export async function divergenceReport(): Promise<Record<string, unknown>> {
  await ensureInsightsSchema();
  const r = await getPool().query(
    `SELECT i.number, i.name,
            p.on_hand::float8, p.myob_on_hand::float8, p.divergence::float8,
            p.committed::float8, p.myob_committed::float8,
            (p.committed - COALESCE(p.myob_committed, 0))::float8 AS committed_divergence,
            i.average_cost::float8,
            (p.on_hand * COALESCE(i.average_cost, 0))::float8 AS our_stock_value,
            i.current_value::float8 AS myob_stock_value,
            ((p.on_hand * COALESCE(i.average_cost, 0)) - COALESCE(i.current_value, 0))::float8 AS value_divergence,
            (ABS(COALESCE(p.divergence, 0)) * COALESCE(i.average_cost, 0))::float8 AS on_hand_value_at_risk,
            (ABS(p.committed - COALESCE(p.myob_committed, 0)) * COALESCE(i.average_cost, 0))::float8 AS committed_value_at_risk,
            p.anchor_date::text, p.anchor_source
     FROM item_position p
     JOIN myob_items i ON i.uid = p.item_uid
     WHERE i.is_inventoried
       AND (ABS(COALESCE(p.divergence, 0)) > 0.001
            OR ABS(p.committed - COALESCE(p.myob_committed, 0)) > 0.001
            OR ABS((p.on_hand * COALESCE(i.average_cost, 0)) - COALESCE(i.current_value, 0)) > 0.5)
     ORDER BY GREATEST(
       ABS(COALESCE(p.divergence, 0)) * COALESCE(i.average_cost, 0),
       ABS(p.committed - COALESCE(p.myob_committed, 0)) * COALESCE(i.average_cost, 0)
     ) DESC`,
  );
  const onHand = r.rows.filter((x) => Math.abs(Number(x.divergence ?? 0)) > 0.001);
  const committed = r.rows.filter((x) => Math.abs(Number(x.committed_divergence ?? 0)) > 0.001);
  const value = r.rows.filter((x) => Math.abs(Number(x.value_divergence ?? 0)) > 0.5);
  return {
    onHandDiverging: onHand.length,
    committedDiverging: committed.length,
    valueDiverging: value.length,
    valueDifference: value.reduce((a, x) => a + Number(x.value_divergence ?? 0), 0),
    committedValueAtRisk: committed.reduce((a, x) => a + Number(x.committed_value_at_risk ?? 0), 0),
    onHandValueAtRisk: onHand.reduce((a, x) => a + Number(x.on_hand_value_at_risk ?? 0), 0),
    items: r.rows,
  };
}

/**
 * The as-at stock position as a spreadsheet, for Allied's month-end run.
 *
 * The audit trail travels with the numbers: every row carries the anchor its
 * on-hand figure was measured from, that anchor's date and kind, and MYOB's own
 * figures beside ours. A number the client cannot trace is a number they will
 * not act on, and this is the file they will sit next to their own analysis.
 *
 * Emitted as CSV with a UTF-8 BOM so Excel opens it directly without an import
 * step and without mangling non-ASCII supplier names.
 */
export async function positionExport(asAt?: string): Promise<{
  filename: string;
  csv: string;
  rows: number;
}> {
  await ensureInsightsSchema();
  const date = asAt ?? businessToday();
  const result = await getPool().query(
    /*
     * The supplier column is the EFFECTIVE supplier, the same three-deep rule
     * the rest of the product uses: Allied's own preferred assignment, then
     * MYOB's primary field, then whoever has billed the item most.
     *
     * It used to read i.primary_supplier_name alone, which is blank on 1,093 of
     * 3,103 items — so a third of the month-end file had no supplier against it
     * while the inventory export sitting beside it did.
     */
    `WITH assigned AS (
       SELECT ps.item_uid, sup.name
       FROM platform_item_suppliers ps
       JOIN myob_suppliers sup ON sup.uid = ps.supplier_uid
       WHERE ps.is_preferred
     ),
     billed AS (
       SELECT DISTINCT ON (l.item_uid) l.item_uid, b.supplier_name AS name
       FROM myob_purchase_bill_lines l
       JOIN myob_purchase_bills b ON b.uid = l.bill_uid
       WHERE l.item_uid IS NOT NULL AND b.supplier_uid IS NOT NULL
       GROUP BY l.item_uid, b.supplier_uid, b.supplier_name
       ORDER BY l.item_uid, SUM(COALESCE(l.total, 0)) DESC
     )
     SELECT i.number, i.name, i.product_type, i.product_finish,
            i.is_active,
            COALESCE(asg.name, i.primary_supplier_name, bl.name) AS supplier_name,
            CASE
              WHEN asg.name IS NOT NULL THEN 'Set by Allied'
              WHEN i.primary_supplier_name IS NOT NULL THEN 'MYOB primary'
              WHEN bl.name IS NOT NULL THEN 'Inferred from bills'
            END AS supplier_source,
            i.supplier_item_number,
            p.on_hand, p.committed, p.free_stock, p.on_order,
            i.average_cost, (p.on_hand * COALESCE(i.average_cost, 0)) AS stock_value,
            i.min_level, p.basis, p.anchor_date::text AS anchor_date,
            p.anchor_source, p.anchor_qty, p.movements_since_anchor,
            p.myob_on_hand, p.myob_committed, p.divergence
     FROM item_position_at($1::date) p
     JOIN myob_items i ON i.uid = p.item_uid
     LEFT JOIN assigned asg ON asg.item_uid = i.uid
     LEFT JOIN billed bl ON bl.item_uid = i.uid
     WHERE i.is_inventoried
     ORDER BY i.number`,
    [date],
  );

  const anchorLabel: Record<string, string> = {
    opening_balance: "Opening balance",
    opening_balance_rolled_back: "Opening balance (rolled back)",
    myob_adjustment: "Stocktake in MYOB",
    manual: "Count entered by Allied",
    csv_import: "Count imported by Allied",
  };
  const basisLabel: Record<string, string> = {
    counted: "Anchored to a physical count",
    reconstructed: "Reconstructed from the ledger",
    precedes_count: "Before the last count — not reported",
    no_opening_balance: "No reference point",
  };

  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(Number(v.toFixed(4))) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };

  const header = [
    "Item number", "Item name", "Product type", "Product finish", "Active",
    "Supplier", "Supplier source", "Supplier item no",
    "On hand", "Committed", "Free stock", "On order",
    "Average cost", "Stock value", "Min level",
    "How it was reached", "Reference point", "Reference date", "Reference qty",
    "Movements since", "MYOB on hand", "MYOB committed", "Difference vs MYOB",
  ];

  const lines = [header.join(",")];
  for (const r of result.rows) {
    lines.push([
      esc(r.number), esc(r.name), esc(r.product_type), esc(r.product_finish),
      r.is_active ? "Yes" : "No",
      esc(r.supplier_name), esc(r.supplier_source), esc(r.supplier_item_number),
      esc(r.on_hand), esc(r.committed), esc(r.free_stock), esc(r.on_order),
      esc(r.average_cost), esc(r.stock_value), esc(r.min_level),
      esc(basisLabel[r.basis as string] ?? r.basis),
      esc(anchorLabel[r.anchor_source as string] ?? r.anchor_source),
      esc(r.anchor_date), esc(r.anchor_qty), esc(r.movements_since_anchor),
      esc(r.myob_on_hand), esc(r.myob_committed), esc(r.divergence),
    ].join(","));
  }

  return {
    filename: `allied-stock-position-${date}.csv`,
    // BOM first: without it Excel guesses the encoding and mangles accents.
    csv: `﻿${lines.join("\r\n")}\r\n`,
    rows: result.rows.length,
  };
}
