import { getPool } from "../db.js";
import { BUSINESS_TODAY_SQL } from "../insights/businessDate.js";

/**
 * Insights schema. Tables prefixed `myob_` are read-only mirrors of MYOB
 * records (source facts). Tables prefixed `platform_` hold data created by
 * this product (interpretations / user input) and are clearly separated so
 * MYOB facts are never mixed with platform conclusions.
 */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS sync_runs (
    id BIGSERIAL PRIMARY KEY,
    mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    stats JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS sync_state (
    entity TEXT PRIMARY KEY,
    last_modified_high TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ,
    row_count BIGINT NOT NULL DEFAULT 0,
    last_error TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS myob_items (
    uid TEXT PRIMARY KEY,
    number TEXT,
    name TEXT,
    description TEXT,
    is_active BOOLEAN,
    is_bought BOOLEAN,
    is_sold BOOLEAN,
    is_inventoried BOOLEAN,
    qty_on_hand DOUBLE PRECISION,
    qty_committed DOUBLE PRECISION,
    qty_on_order DOUBLE PRECISION,
    qty_available DOUBLE PRECISION,
    average_cost DOUBLE PRECISION,
    current_value DOUBLE PRECISION,
    base_selling_price DOUBLE PRECISION,
    min_level DOUBLE PRECISION,
    reorder_qty DOUBLE PRECISION,
    primary_supplier_uid TEXT,
    primary_supplier_name TEXT,
    supplier_item_number TEXT,
    last_modified TIMESTAMPTZ,
    raw JSONB,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // MYOB item custom lists, promoted from `raw` to real columns so they can be
  // filtered and sorted. CustomList1/2 are Allied's PRODUCT TYPE and PRODUCT
  // FINISH; CustomList3 is labelled BIN LOCATION but actually holds customer
  // names, so it is stored and deliberately not surfaced yet.
  `ALTER TABLE myob_items ADD COLUMN IF NOT EXISTS product_type TEXT`,
  `ALTER TABLE myob_items ADD COLUMN IF NOT EXISTS product_finish TEXT`,
  `ALTER TABLE myob_items ADD COLUMN IF NOT EXISTS bin_location TEXT`,
  // Per-location stock (LocationDetails[]), available on the item master.
  `ALTER TABLE myob_items ADD COLUMN IF NOT EXISTS location_details JSONB`,
  /*
   * When this row's quantities were last read from MYOB.
   *
   * Critical: MYOB does NOT bump Item.LastModified when a transaction changes a
   * quantity, so a LastModified-filtered incremental sync silently serves stale
   * stock. The items entity is therefore always fully refreshed, and this column
   * is the proof — anything older than the last completed sync is a bug.
   */
  `ALTER TABLE myob_items ADD COLUMN IF NOT EXISTS quantities_as_of TIMESTAMPTZ`,

  // One-time backfill: `raw` already carries these for every synced item, so
  // the new columns are usable before the next sync runs. Guarded so it is a
  // no-op on every boot after the first.
  `UPDATE myob_items SET
     product_type   = NULLIF(raw->'CustomList1'->>'Value', ''),
     product_finish = NULLIF(raw->'CustomList2'->>'Value', ''),
     bin_location   = NULLIF(raw->'CustomList3'->>'Value', ''),
     location_details = CASE WHEN jsonb_typeof(raw->'LocationDetails') = 'array'
                             THEN raw->'LocationDetails' END,
     quantities_as_of = COALESCE(quantities_as_of, synced_at)
   WHERE raw IS NOT NULL AND quantities_as_of IS NULL`,

  /*
   * One-time correction: the sync read `RestockingInformation.PrimarySupplier`,
   * but MYOB's key is `Supplier`. Every item therefore stored a null supplier.
   * `raw` already holds the right value, so repair it in place rather than
   * waiting for the next full sync. Guarded to run only while the column is
   * still empty everywhere.
   */
  `UPDATE myob_items SET
     primary_supplier_uid  = raw->'BuyingDetails'->'RestockingInformation'->'Supplier'->>'UID',
     primary_supplier_name = raw->'BuyingDetails'->'RestockingInformation'->'Supplier'->>'Name',
     reorder_qty = COALESCE(
       NULLIF(raw->'BuyingDetails'->'RestockingInformation'->>'DefaultOrderQuantity','')::double precision,
       reorder_qty)
   WHERE raw IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM myob_items x WHERE x.primary_supplier_uid IS NOT NULL)`,

  `CREATE INDEX IF NOT EXISTS idx_items_product_type ON myob_items (product_type)`,
  `CREATE INDEX IF NOT EXISTS idx_items_product_finish ON myob_items (product_finish)`,

  /*
   * MYOB's own Bill of Materials, from Inventory/Item?$expand=BillOfMaterials.
   * This is a source fact and is kept apart from platform_bom, which holds our
   * build-derived guesses and Allied's manual rows. Unlike derived BOMs it also
   * covers auto-build items, which are never observed as Build transactions.
   */
  `CREATE TABLE IF NOT EXISTS myob_item_bom (
    parent_uid TEXT NOT NULL,
    component_uid TEXT NOT NULL,
    qty_per DOUBLE PRECISION NOT NULL,
    build_qty DOUBLE PRECISION,
    component_number TEXT,
    component_name TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (parent_uid, component_uid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_item_bom_component ON myob_item_bom (component_uid)`,

  `CREATE TABLE IF NOT EXISTS myob_locations (
    uid TEXT PRIMARY KEY,
    identifier TEXT,
    name TEXT,
    is_active BOOLEAN,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS myob_suppliers (
    uid TEXT PRIMARY KEY,
    display_id TEXT,
    name TEXT,
    is_active BOOLEAN,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // Address details added for supplier-region analysis (from Contact/Supplier).
  `ALTER TABLE myob_suppliers ADD COLUMN IF NOT EXISTS city TEXT`,
  `ALTER TABLE myob_suppliers ADD COLUMN IF NOT EXISTS country TEXT`,
  `ALTER TABLE myob_suppliers ADD COLUMN IF NOT EXISTS phone TEXT`,
  `ALTER TABLE myob_suppliers ADD COLUMN IF NOT EXISTS email TEXT`,

  `CREATE TABLE IF NOT EXISTS myob_sale_invoices (
    uid TEXT PRIMARY KEY,
    number TEXT,
    date TIMESTAMPTZ,
    status TEXT,
    customer_uid TEXT,
    customer_name TEXT,
    total DOUBLE PRECISION,
    last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS myob_sale_invoice_lines (
    invoice_uid TEXT NOT NULL,
    idx INTEGER NOT NULL,
    item_uid TEXT,
    qty DOUBLE PRECISION,
    unit_price DOUBLE PRECISION,
    total DOUBLE PRECISION,
    description TEXT,
    PRIMARY KEY (invoice_uid, idx)
  )`,

  `CREATE TABLE IF NOT EXISTS myob_sale_orders (
    uid TEXT PRIMARY KEY,
    number TEXT,
    date TIMESTAMPTZ,
    status TEXT,
    customer_uid TEXT,
    customer_name TEXT,
    promised_date TIMESTAMPTZ,
    total DOUBLE PRECISION,
    last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS myob_sale_order_lines (
    order_uid TEXT NOT NULL,
    idx INTEGER NOT NULL,
    item_uid TEXT,
    qty DOUBLE PRECISION,
    unit_price DOUBLE PRECISION,
    total DOUBLE PRECISION,
    description TEXT,
    PRIMARY KEY (order_uid, idx)
  )`,

  `CREATE TABLE IF NOT EXISTS myob_purchase_bills (
    uid TEXT PRIMARY KEY,
    number TEXT,
    date TIMESTAMPTZ,
    status TEXT,
    supplier_uid TEXT,
    supplier_name TEXT,
    total DOUBLE PRECISION,
    last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS myob_purchase_bill_lines (
    bill_uid TEXT NOT NULL,
    idx INTEGER NOT NULL,
    item_uid TEXT,
    qty DOUBLE PRECISION,
    unit_price DOUBLE PRECISION,
    total DOUBLE PRECISION,
    description TEXT,
    PRIMARY KEY (bill_uid, idx)
  )`,

  `CREATE TABLE IF NOT EXISTS myob_purchase_orders (
    uid TEXT PRIMARY KEY,
    number TEXT,
    date TIMESTAMPTZ,
    status TEXT,
    supplier_uid TEXT,
    supplier_name TEXT,
    promised_date TIMESTAMPTZ,
    total DOUBLE PRECISION,
    last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS myob_purchase_order_lines (
    order_uid TEXT NOT NULL,
    idx INTEGER NOT NULL,
    item_uid TEXT,
    qty DOUBLE PRECISION,
    received_qty DOUBLE PRECISION,
    unit_price DOUBLE PRECISION,
    total DOUBLE PRECISION,
    description TEXT,
    PRIMARY KEY (order_uid, idx)
  )`,

  `CREATE TABLE IF NOT EXISTS myob_builds (
    uid TEXT PRIMARY KEY,
    number TEXT,
    date TIMESTAMPTZ,
    memo TEXT,
    last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS myob_build_lines (
    build_uid TEXT NOT NULL,
    idx INTEGER NOT NULL,
    item_uid TEXT,
    qty DOUBLE PRECISION,
    unit_cost DOUBLE PRECISION,
    PRIMARY KEY (build_uid, idx)
  )`,

  `CREATE TABLE IF NOT EXISTS myob_adjustments (
    uid TEXT PRIMARY KEY,
    number TEXT,
    date TIMESTAMPTZ,
    memo TEXT,
    last_modified TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS myob_adjustment_lines (
    adjustment_uid TEXT NOT NULL,
    idx INTEGER NOT NULL,
    item_uid TEXT,
    qty DOUBLE PRECISION,
    unit_cost DOUBLE PRECISION,
    memo TEXT,
    PRIMARY KEY (adjustment_uid, idx)
  )`,

  // Product relationships. source='derived' rows are regenerated from MYOB
  // Build transactions each sync; source='user' rows are Allied-provided and
  // never touched by the sync.
  `CREATE TABLE IF NOT EXISTS platform_bom (
    parent_uid TEXT NOT NULL,
    component_uid TEXT NOT NULL,
    source TEXT NOT NULL,
    qty_per DOUBLE PRECISION NOT NULL,
    build_count INTEGER NOT NULL DEFAULT 0,
    last_observed TIMESTAMPTZ,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (parent_uid, component_uid, source)
  )`,

  /*
   * Effective BOM: one row per parent+component pair, chosen across three
   * sources in strict precedence.
   *
   *   user    — Allied typed it deliberately, to correct something. A sync must
   *             never silently overwrite a human decision.
   *   myob    — MYOB's own Bill of Materials. Verified against Allied's file on
   *             18 Aug 2026: 489 of 496 pairs that could be cross-checked match
   *             the quantities actually consumed by build transactions exactly,
   *             and it covers 299 extra live parents (kits, bolt packs, spacer
   *             bar kits) that are pre-packed and so never produce a build.
   *   derived — inferred from observed builds. Weakest: a pair seen in a single
   *             build is one noisy observation, which is exactly where the 3
   *             disagreements above came from.
   *
   * Losing rows stay in their own tables so the UI can show what was overridden
   * rather than hiding the disagreement.
   */
  `CREATE OR REPLACE VIEW effective_bom AS
   SELECT DISTINCT ON (parent_uid, component_uid)
          parent_uid, component_uid, source, qty_per, build_count,
          last_observed, confidence, updated_at
   FROM (
     SELECT parent_uid, component_uid, source, qty_per, build_count,
            last_observed, confidence, updated_at
     FROM platform_bom
     UNION ALL
     SELECT parent_uid, component_uid, 'myob'::text, qty_per, 0::int,
            synced_at, 1.0::double precision, synced_at
     FROM myob_item_bom
   ) sources
   ORDER BY parent_uid, component_uid,
            CASE source WHEN 'user' THEN 0 WHEN 'myob' THEN 1 ELSE 2 END`,

  // Allied-assigned suppliers per item. A product may have several; exactly
  // one may be marked preferred, which becomes the item's effective supplier.
  // Platform data only — MYOB's own primary-supplier field is never written.
  `CREATE TABLE IF NOT EXISTS platform_item_suppliers (
    item_uid TEXT NOT NULL,
    supplier_uid TEXT NOT NULL,
    is_preferred BOOLEAN NOT NULL DEFAULT FALSE,
    supplier_item_number TEXT,
    notes TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_uid, supplier_uid)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_item_supplier_preferred
     ON platform_item_suppliers (item_uid) WHERE is_preferred`,
  `CREATE INDEX IF NOT EXISTS idx_item_supplier_supplier
     ON platform_item_suppliers (supplier_uid)`,

  // Allied-managed supplier attributes (region label, lead time, notes).
  // Platform data only — never written to MYOB. A row exists only once a
  // user edits something; region falls back to an auto label derived from
  // the MYOB address country.
  `CREATE TABLE IF NOT EXISTS platform_supplier_meta (
    supplier_uid TEXT PRIMARY KEY,
    region TEXT,
    lead_time_days DOUBLE PRECISION,
    notes TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  /*
   * ---- P1: stocktake-anchored stock ledger -------------------------------
   *
   * Every line that physically moves stock, in one place. This is the ledger's
   * spine and the audit trail behind every on-hand figure.
   *
   * Purchase orders and sale orders are deliberately absent: they are intent,
   * not movement. Counting them would double-count stock that has not arrived
   * or has not shipped.
   *
   * NOTE ON TIME ZONES: MYOB returns transaction dates at midnight with no zone,
   * and they are stored as timestamptz, so they sit at midnight UTC. Casting
   * with a bare ::date would use whatever session timezone happens to be set;
   * pinning it to UTC makes the calendar date match what MYOB actually sent,
   * regardless of who is querying from where.
   *
   * NOTE ON DATES: MYOB returns transaction dates with no time component (0 of
   * 1,314 adjustments carry one), so same-day ordering is unknowable. The ledger
   * therefore treats a physical count as the last word on its date — movements
   * are applied only from the day *after* an anchor.
   */
  `CREATE OR REPLACE VIEW stock_movements AS
     SELECT h.uid AS doc_uid, 'bill'::text AS kind, h.number AS doc_number,
            (h.date AT TIME ZONE 'UTC')::date AS moved_on, l.item_uid, l.qty::double precision AS qty,
            h.supplier_name AS party, NULL::text AS memo
     FROM myob_purchase_bill_lines l
     JOIN myob_purchase_bills h ON h.uid = l.bill_uid
     WHERE l.item_uid IS NOT NULL AND l.qty IS NOT NULL
     UNION ALL
     SELECT h.uid, 'invoice', h.number, (h.date AT TIME ZONE 'UTC')::date, l.item_uid,
            (-l.qty)::double precision, h.customer_name, NULL
     FROM myob_sale_invoice_lines l
     JOIN myob_sale_invoices h ON h.uid = l.invoice_uid
     WHERE l.item_uid IS NOT NULL AND l.qty IS NOT NULL
     UNION ALL
     SELECT h.uid, 'build', h.number, (h.date AT TIME ZONE 'UTC')::date, l.item_uid,
            l.qty::double precision, NULL, h.memo
     FROM myob_build_lines l
     JOIN myob_builds h ON h.uid = l.build_uid
     WHERE l.item_uid IS NOT NULL AND l.qty IS NOT NULL
     UNION ALL
     SELECT h.uid, 'adjustment', h.number, (h.date AT TIME ZONE 'UTC')::date, l.item_uid,
            l.qty::double precision, NULL, COALESCE(NULLIF(l.memo, ''), h.memo)
     FROM myob_adjustment_lines l
     JOIN myob_adjustments h ON h.uid = l.adjustment_uid
     WHERE l.item_uid IS NOT NULL AND l.qty IS NOT NULL`,

  /*
   * Allied's confirmation that a given MYOB adjustment was a physical count.
   * Detection proposes candidates by memo wording; a person decides. Memo
   * wording is inconsistent enough ("Stock Count", "STOCK TAKE", "COUNT QTY" —
   * 51 strict matches vs 159 loose) that a regex must never silently define an
   * anchor.
   */
  `CREATE TABLE IF NOT EXISTS platform_stocktake_confirmation (
    adjustment_uid TEXT PRIMARY KEY,
    is_stocktake BOOLEAN NOT NULL,
    confirmed_by TEXT,
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note TEXT
  )`,

  /*
   * Physical counts — the reference points the whole ledger hangs off.
   *
   * `counted_qty` is the stock level the count asserted. For a count Allied
   * types in, that is the number they counted. For one recovered from a MYOB
   * adjustment it is the running balance immediately after that adjustment,
   * because a MYOB adjustment records a *delta*, never the counted figure
   * (their own memo: "N8S16 COUNT QTY 66 … QTY 919 ADDED").
   *
   * `drift_qty` is what the count corrected — how far MYOB had drifted from
   * physical reality at that moment. It is the single most useful number here
   * and is only knowable at a count.
   */
  `CREATE TABLE IF NOT EXISTS platform_stock_count (
    id BIGSERIAL PRIMARY KEY,
    item_uid TEXT NOT NULL,
    count_date DATE NOT NULL,
    counted_qty DOUBLE PRECISION NOT NULL,
    drift_qty DOUBLE PRECISION,
    source TEXT NOT NULL,
    source_ref TEXT,
    entered_by TEXT,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_count_unique
     ON platform_stock_count (item_uid, count_date, COALESCE(source_ref, ''))`,
  `CREATE INDEX IF NOT EXISTS idx_stock_count_item_date
     ON platform_stock_count (item_uid, count_date DESC)`,

  /*
   * Daily position snapshot — the permanent historical trail.
   *
   * Every figure here is computed by this platform from its own movement
   * ledger and its own open-order arithmetic. `myob_on_hand` is stored only as
   * a comparison column so divergence can be shown and explained; it is never
   * an input to on_hand, committed or free.
   *
   * Rows are immutable once written: this is what "look back at these numbers
   * historically" means, and rewriting history would defeat it.
   */
  `CREATE TABLE IF NOT EXISTS platform_daily_position (
    as_at_date DATE NOT NULL,
    item_uid TEXT NOT NULL,
    on_hand DOUBLE PRECISION,
    committed DOUBLE PRECISION,
    free_stock DOUBLE PRECISION,
    on_order DOUBLE PRECISION,
    average_cost DOUBLE PRECISION,
    stock_value DOUBLE PRECISION,
    basis TEXT NOT NULL,
    anchor_date DATE,
    anchor_source TEXT,
    myob_on_hand DOUBLE PRECISION,
    myob_committed DOUBLE PRECISION,
    divergence DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (as_at_date, item_uid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_daily_position_item
     ON platform_daily_position (item_uid, as_at_date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_daily_position_date
     ON platform_daily_position (as_at_date)`,

  /*
   * The platform's position for every item **as at any date** — one definition
   * the whole product reads, at today's date or a historical one.
   *
   * on_hand comes from the anchored ledger, committed from our own open sale
   * orders, on_order from our own unreceived purchase orders. MYOB's raw
   * quantities appear only as myob_* comparison columns; a guard test stops
   * anything outside the sync, schema and ledger reading them.
   *
   * Three cases, distinguished by `basis`:
   *   counted        — rolled forward from a physical count on or before the date
   *   reconstructed  — rolled forward from the conversion balance, or backwards
   *                    through it, which is ordinary reconstruction and valid
   *   precedes_count — the date sits before a physical count, so no number is
   *                    returned. A count absorbs drift no document explains, and
   *                    reading back through one produces nonsense.
   */
  `CREATE OR REPLACE FUNCTION item_position_at(p_as_at date)
   RETURNS TABLE (
     item_uid text, on_hand double precision, committed double precision,
     free_stock double precision, on_order double precision,
     anchor_date date, anchor_source text, anchor_qty double precision,
     movements_since_anchor double precision, has_anchor boolean,
     myob_on_hand double precision, myob_committed double precision,
     divergence double precision, basis text
   )
   LANGUAGE sql STABLE AS $fn$
     WITH anchor AS (
       SELECT DISTINCT ON (sc.item_uid)
              sc.item_uid, sc.count_date, sc.counted_qty, sc.source
       FROM platform_stock_count sc
       WHERE sc.count_date <= p_as_at
       ORDER BY sc.item_uid, sc.count_date DESC,
                (sc.source <> 'opening_balance') DESC, sc.id DESC
     ),
     later_count AS (
       SELECT DISTINCT ON (sc.item_uid) sc.item_uid
       FROM platform_stock_count sc
       WHERE sc.count_date > p_as_at AND sc.source <> 'opening_balance'
       ORDER BY sc.item_uid, sc.count_date ASC
     ),
     opening AS (
       SELECT DISTINCT ON (sc.item_uid) sc.item_uid, sc.count_date, sc.counted_qty
       FROM platform_stock_count sc
       WHERE sc.source = 'opening_balance'
       ORDER BY sc.item_uid, sc.count_date ASC
     ),
     since_anchor AS (
       SELECT m.item_uid, SUM(m.qty)::double precision AS qty
       FROM stock_movements m JOIN anchor a ON a.item_uid = m.item_uid
       WHERE m.moved_on > a.count_date AND m.moved_on <= p_as_at
       GROUP BY m.item_uid
     ),
     back_from_opening AS (
       SELECT m.item_uid, SUM(m.qty)::double precision AS qty
       FROM stock_movements m JOIN opening o ON o.item_uid = m.item_uid
       WHERE m.moved_on > p_as_at AND m.moved_on <= o.count_date
       GROUP BY m.item_uid
     ),
     our_committed AS (
       SELECT l.item_uid, SUM(l.qty)::double precision AS qty
       FROM myob_sale_order_lines l
       JOIN myob_sale_orders o ON o.uid = l.order_uid
       WHERE UPPER(COALESCE(o.status, '')) = 'OPEN'
         AND l.item_uid IS NOT NULL AND o.date::date <= p_as_at
       GROUP BY l.item_uid
     ),
     our_on_order AS (
       SELECT l.item_uid,
              SUM(GREATEST(COALESCE(l.qty,0) - COALESCE(l.received_qty,0), 0))::double precision AS qty
       FROM myob_purchase_order_lines l
       JOIN myob_purchase_orders o ON o.uid = l.order_uid
       WHERE UPPER(COALESCE(o.status, '')) = 'OPEN'
         AND l.item_uid IS NOT NULL AND o.date::date <= p_as_at
       GROUP BY l.item_uid
     ),
     resolved AS (
       SELECT i.uid AS item_uid,
              CASE
                WHEN a.item_uid IS NOT NULL
                  THEN a.counted_qty + COALESCE(sa.qty, 0)
                WHEN lc.item_uid IS NOT NULL THEN NULL
                WHEN op.item_uid IS NOT NULL
                  THEN op.counted_qty - COALESCE(bo.qty, 0)
                ELSE NULL
              END::double precision AS on_hand,
              COALESCE(oc.qty, 0)::double precision AS committed,
              COALESCE(oo.qty, 0)::double precision AS on_order,
              COALESCE(a.count_date, op.count_date) AS anchor_date,
              CASE
                WHEN a.item_uid IS NOT NULL THEN a.source
                WHEN lc.item_uid IS NOT NULL THEN NULL
                WHEN op.item_uid IS NOT NULL THEN 'opening_balance_rolled_back'
              END AS anchor_source,
              a.counted_qty::double precision AS anchor_qty,
              COALESCE(sa.qty, 0)::double precision AS movements_since_anchor,
              (a.item_uid IS NOT NULL) AS has_anchor,
              i.qty_on_hand::double precision AS myob_on_hand,
              i.qty_committed::double precision AS myob_committed,
              CASE
                WHEN a.item_uid IS NOT NULL AND a.source <> 'opening_balance' THEN 'counted'
                WHEN lc.item_uid IS NOT NULL AND a.item_uid IS NULL THEN 'precedes_count'
                WHEN a.item_uid IS NOT NULL OR op.item_uid IS NOT NULL THEN 'reconstructed'
                ELSE 'no_opening_balance'
              END AS basis
       FROM myob_items i
       LEFT JOIN anchor a ON a.item_uid = i.uid
       LEFT JOIN later_count lc ON lc.item_uid = i.uid
       LEFT JOIN opening op ON op.item_uid = i.uid
       LEFT JOIN since_anchor sa ON sa.item_uid = i.uid
       LEFT JOIN back_from_opening bo ON bo.item_uid = i.uid
       LEFT JOIN our_committed oc ON oc.item_uid = i.uid
       LEFT JOIN our_on_order oo ON oo.item_uid = i.uid
     )
     SELECT item_uid, on_hand, committed,
            (on_hand - committed)::double precision AS free_stock,
            on_order, anchor_date, anchor_source, anchor_qty,
            movements_since_anchor, has_anchor, myob_on_hand, myob_committed,
            (on_hand - COALESCE(myob_on_hand, 0))::double precision AS divergence,
            basis
     FROM resolved
   $fn$`,

  // Today's position, so existing callers need no change.
  /*
   * Today's position. CURRENT_DATE would be the *database's* today, and the
   * database runs in UTC — 12-13 hours behind New Zealand, so for much of each
   * NZ day it names yesterday. Allied's calendar decides what "today" means.
   */
  `CREATE OR REPLACE VIEW item_position AS
     SELECT * FROM item_position_at(${BUSINESS_TODAY_SQL})`,

  /*
   * ---- P4: Allied's own free-text tags -----------------------------------
   *
   * Many per item, user-created, filterable. This is also how the brief's
   * "never require new item codes" rule is honoured: Allied carry a backlog of
   * dead codes in MYOB that cannot be deleted and will not create new ones, so
   * every classification problem has to be solvable against the existing SKU.
   *
   * Tags are platform data and never written to MYOB. Stored lower-cased for
   * matching with the original casing kept for display, so "Slow Movers" and
   * "slow movers" are one tag rather than two.
   */
  `CREATE TABLE IF NOT EXISTS platform_item_tags (
    item_uid TEXT NOT NULL,
    tag_key TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_uid, tag_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_item_tags_key ON platform_item_tags (tag_key)`,

  /*
   * ---- P5 + P6: the purchasing cart ---------------------------------------
   *
   * The old purchasing view was a stateless recomputation: it bucketed each item
   * under exactly one supplier and kept nothing, so there was nowhere to put an
   * edited quantity, a removal, a supplier choice or a deliberate split. All of
   * P5's and P6's requirements need state, which is what this table is.
   *
   * A row is one (item, supplier) decision. An item below its minimum appears
   * under every supplier tagged against it — that is the P6 fix — and these rows
   * record what Allied decided to do about each appearance.
   *
   * `state`:
   *   suggested — the platform's recommendation, untouched
   *   edited    — Allied changed the quantity; they always want the final call
   *   removed   — struck from this supplier's order
   *   selected  — chosen as THE supplier, which removes the item elsewhere
   *   split     — deliberately ordered from more than one supplier at once
   */
  `CREATE TABLE IF NOT EXISTS platform_purchase_cart (
    item_uid TEXT NOT NULL,
    supplier_uid TEXT NOT NULL,
    qty DOUBLE PRECISION,
    state TEXT NOT NULL DEFAULT 'suggested',
    note TEXT,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_uid, supplier_uid)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cart_supplier ON platform_purchase_cart (supplier_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_cart_state ON platform_purchase_cart (state)`,

  /*
   * Measured supplier lead time: purchase order raised to goods billed.
   *
   * Promised dates exist on only 30 orders, but 1,153 of 1,265 converted orders
   * match their bill by number and supplier, which gives what actually happened
   * rather than what was promised.
   *
   * SAME-DAY PAIRS ARE EXCLUDED, and this is the whole accuracy of the figure.
   * 31% of matched pairs are billed on the day the order was raised — 359 of
   * 1,158. A container cannot cross from China in zero days, so those rows are
   * not a wait at all: the paperwork was entered after the goods turned up.
   *
   * Leaving them in does not merely add noise, it dominates the answer, because
   * for several suppliers they are most of the sample. HOBSON has 13 pairs, 7 of
   * them same-day, so the plain median was 0 days. HANOVA read 40 days against a
   * real 83, TONG MING 18 against 42. Planning a reorder against 40 days when
   * the goods take 83 is how a stockout happens.
   *
   * The trade-off is deliberate: excluding same-day slightly overstates local
   * suppliers Allied genuinely buy from over the counter (Specialised Washers
   * moves from 2 days to 4). Overstating a two-day local wait is harmless;
   * understating a three-month import is not.
   *
   * `orders_measured` counts only the pairs actually used, and
   * `same_day_excluded` is reported so a thin or heavily-filtered measurement is
   * visible rather than implied.
   */
  // Columns changed shape, and CREATE OR REPLACE cannot rename or reorder them.
  `DROP VIEW IF EXISTS supplier_lead_time`,
  `CREATE VIEW supplier_lead_time AS
   WITH pairs AS (
     SELECT o.supplier_uid, (b.date::date - o.date::date) AS days
     FROM myob_purchase_orders o
     JOIN myob_purchase_bills b
       ON b.number = o.number AND b.supplier_uid = o.supplier_uid
     WHERE b.date >= o.date AND o.supplier_uid IS NOT NULL
   )
   SELECT supplier_uid,
          COUNT(*) FILTER (WHERE days > 0)::int AS orders_measured,
          COUNT(*) FILTER (WHERE days = 0)::int AS same_day_excluded,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days)
            FILTER (WHERE days > 0)::int AS median_lead_days,
          MAX(days) FILTER (WHERE days > 0)::int AS slowest_lead_days
   FROM pairs
   GROUP BY supplier_uid
   HAVING COUNT(*) FILTER (WHERE days > 0) > 0`,

  /*
   * ---- P7: kits and components --------------------------------------------
   *
   * The same physical thing exists in two forms. A bolt pack is either bought
   * complete from a specialist supplier, or made here from a bolt, a nut and
   * two washers. Allied do both, and the file proves it: BP1675G was billed in
   * container loads of 6,000-10,000 every few months and built in-house in
   * batches of 50-1,450 in between.
   *
   * Treating those two forms as unrelated item codes is what produced the three
   * failures in the brief: stock counted twice, components ordered that are
   * already in the building, and an afternoon of spreadsheet reconciliation
   * each month.
   *
   * THE COUNTING RULE, stated once and enforced everywhere below: a unit is
   * counted in the form it is physically held in. Four loose bolts are four
   * bolts; the same four inside a sealed pack are one pack. Embedded quantities
   * are therefore a VIEW of stock already valued under the kit, never an
   * addition to it, and kitReconciliation() proves the total is unchanged.
   */

  /*
   * Allied's override, for the rare item where the bills mislead.
   *
   * Two values only, and the default is derived rather than stored:
   *   made_here   — its shortfall is a build sheet, not a purchase order
   *   buy_allowed — buying it complete is a real option
   *
   * An earlier version carried four states plus a graded-evidence model plus a
   * confirmation queue, all of it built to serve one rule that turned out to
   * move a single item. It was removed. What survives is the part that pays:
   * a default read straight from purchase bills, and a way to disagree with it.
   */
  `CREATE TABLE IF NOT EXISTS platform_kit_policy (
    item_uid TEXT PRIMARY KEY,
    form TEXT NOT NULL,
    note TEXT,
    decided_by TEXT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  /*
   * How each recipe parent is sourced, decided by one question: has Allied ever
   * actually bought it complete?
   *
   * Purchase bills answer that and nothing else is consulted. In particular
   * MYOB's "I buy this item" checkbox is ignored: 51 recipe parents carry it
   * with no purchase behind it, and acting on it once withheld 1,539 stainless
   * nuts from an order Allied genuinely needed. A checkbox is not a purchase.
   *
   * On the live file this splits 500 made-here against 13 bought-complete.
   * "Hybrid" needs no state of its own — an item bought before simply has
   * buying allowed, and the build comparison sits alongside it either way.
   */
  // Both views changed shape, and CREATE OR REPLACE cannot drop or reorder
  // columns. kit_form depended on kit_candidate, so it goes first.
  `DROP VIEW IF EXISTS kit_form`,
  `DROP VIEW IF EXISTS kit_candidate`,
  `DROP VIEW IF EXISTS kit_embedded_stock`,
  `CREATE VIEW kit_form AS
   WITH billed AS (
     /*
      * What Allied have ACTUALLY paid, weighted across every bill.
      *
      * Not MYOB's average_cost, which for a built item is the cost of building
      * it: BP1675S16 carries an average_cost of $12.86 and has never once been
      * purchased. Presenting that as a purchase price invented a buying option
      * that does not exist. A buy price exists only where a bill exists.
      */
     SELECT l.item_uid, SUM(l.qty)::double precision AS qty,
            COUNT(DISTINCT l.bill_uid)::int AS bills, MAX(h.date) AS last_bought,
            (SUM(l.total) / NULLIF(SUM(l.qty), 0))::double precision AS buy_price,
            (ARRAY_AGG(h.supplier_name ORDER BY h.date DESC))[1] AS last_supplier
     FROM myob_purchase_bill_lines l
     JOIN myob_purchase_bills h ON h.uid = l.bill_uid
     WHERE l.item_uid IS NOT NULL AND l.qty > 0
     GROUP BY l.item_uid
   ),
   built AS (
     SELECT bl.item_uid, SUM(bl.qty)::double precision AS qty,
            COUNT(*)::int AS build_lines, MAX(b.date) AS last_built
     FROM myob_build_lines bl
     JOIN myob_builds b ON b.uid = bl.build_uid
     WHERE bl.qty > 0 AND bl.item_uid IS NOT NULL
     GROUP BY bl.item_uid
   ),
   recipe AS (
     SELECT parent_uid, COUNT(*)::int AS component_count FROM effective_bom GROUP BY parent_uid
   )
   SELECT r.parent_uid AS item_uid,
          COALESCE(p.form,
                   CASE WHEN bi.item_uid IS NOT NULL THEN 'buy_allowed' ELSE 'made_here' END) AS form,
          bi.buy_price,
          bi.last_supplier,
          (CASE WHEN bi.item_uid IS NOT NULL THEN 'buy_allowed' ELSE 'made_here' END) AS derived_form,
          (p.item_uid IS NOT NULL) AS overridden,
          r.component_count,
          COALESCE(bi.qty, 0) AS bought_qty,
          COALESCE(bi.bills, 0) AS bought_bills,
          bi.last_bought,
          COALESCE(bu.qty, 0) AS built_qty,
          COALESCE(bu.build_lines, 0) AS built_lines,
          bu.last_built,
          p.note, p.decided_by, p.decided_at
   FROM recipe r
   LEFT JOIN billed bi ON bi.item_uid = r.parent_uid
   LEFT JOIN built bu ON bu.item_uid = r.parent_uid
   LEFT JOIN platform_kit_policy p ON p.item_uid = r.parent_uid`,

  /*
   * kit_embedded_stock was removed on 26 Aug 2026.
   *
   * It exploded kit stock back into component units — 8,123 packs shown as
   * 32,492 bolts — and a rule then reduced component orders by that figure.
   * Both were wrong about how Allied operate: a pack bought from a supplier is
   * never broken open, so the bolts inside it cannot fill a loose bolt order,
   * and showing them as if they could invited exactly the double-count the
   * feature exists to prevent.
   *
   * The counting rule stands and is now true by construction: a kit is counted
   * as a kit, a component as a component, and nothing is added across the two.
   * What replaced the view is the question Allied actually asked — how many
   * kits can we field, on hand plus buildable.
   */
  /*
   * The build route, priced and stock-checked, for every item with a recipe.
   *
   * component_cost is the roll-up at average cost. It is only ever compared
   * against kit_form.buy_price — a real price from a real bill — and never
   * against MYOB's average_cost for the parent, which for a built item is just
   * the cost of having built it. 500 of the 513 recipe parents have no buy
   * price at all, and for those there is no comparison to draw.
   *
   * buildable_now is the binding constraint, not the cost: the scarcest
   * component decides how many can be made today, and it is frequently zero.
   *
   * costed_components is carried so the UI can refuse to draw a conclusion from
   * a roll-up with holes in it. An item whose components have no average cost
   * would otherwise look free to build.
   */
  `CREATE OR REPLACE VIEW kit_build_option AS
   SELECT e.parent_uid AS item_uid,
          COUNT(*)::int AS component_count,
          COUNT(*) FILTER (WHERE COALESCE(ci.average_cost, 0) > 0)::int AS costed_components,
          SUM(e.qty_per * COALESCE(ci.average_cost, 0))::double precision AS component_cost,
          MIN(FLOOR(GREATEST(COALESCE(pos.free_stock, 0), 0) / e.qty_per))::double precision AS buildable_now,
          COUNT(*) FILTER (WHERE COALESCE(pos.free_stock, 0) <= 0)::int AS components_out_of_stock
   FROM effective_bom e
   JOIN myob_items ci ON ci.uid = e.component_uid
   JOIN item_position pos ON pos.item_uid = e.component_uid
   WHERE e.qty_per > 0
   GROUP BY e.parent_uid`,

  `CREATE INDEX IF NOT EXISTS idx_inv_lines_item ON myob_sale_invoice_lines (item_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_so_lines_item ON myob_sale_order_lines (item_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_bill_lines_item ON myob_purchase_bill_lines (item_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_po_lines_item ON myob_purchase_order_lines (item_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_build_lines_item ON myob_build_lines (item_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_adj_lines_item ON myob_adjustment_lines (item_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_invoices_date ON myob_sale_invoices (date)`,
  `CREATE INDEX IF NOT EXISTS idx_bills_date ON myob_purchase_bills (date)`,
  `CREATE INDEX IF NOT EXISTS idx_builds_date ON myob_builds (date)`,
  `CREATE INDEX IF NOT EXISTS idx_adjustments_date ON myob_adjustments (date)`,
  `CREATE INDEX IF NOT EXISTS idx_bom_component ON platform_bom (component_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_items_number ON myob_items (number)`,
];

let ready: Promise<void> | null = null;

export async function ensureInsightsSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const client = await getPool().connect();
      try {
        for (const statement of DDL) {
          await client.query(statement);
        }
      } finally {
        client.release();
      }
    })();
  }
  await ready;
}
