import { getPool } from "../db.js";

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
   * NOTE ON DATES: MYOB returns transaction dates with no time component (0 of
   * 1,314 adjustments carry one), so same-day ordering is unknowable. The ledger
   * therefore treats a physical count as the last word on its date — movements
   * are applied only from the day *after* an anchor.
   */
  `CREATE OR REPLACE VIEW stock_movements AS
     SELECT h.uid AS doc_uid, 'bill'::text AS kind, h.number AS doc_number,
            h.date::date AS moved_on, l.item_uid, l.qty::double precision AS qty,
            h.supplier_name AS party, NULL::text AS memo
     FROM myob_purchase_bill_lines l
     JOIN myob_purchase_bills h ON h.uid = l.bill_uid
     WHERE l.item_uid IS NOT NULL AND l.qty IS NOT NULL
     UNION ALL
     SELECT h.uid, 'invoice', h.number, h.date::date, l.item_uid,
            (-l.qty)::double precision, h.customer_name, NULL
     FROM myob_sale_invoice_lines l
     JOIN myob_sale_invoices h ON h.uid = l.invoice_uid
     WHERE l.item_uid IS NOT NULL AND l.qty IS NOT NULL
     UNION ALL
     SELECT h.uid, 'build', h.number, h.date::date, l.item_uid,
            l.qty::double precision, NULL, h.memo
     FROM myob_build_lines l
     JOIN myob_builds h ON h.uid = l.build_uid
     WHERE l.item_uid IS NOT NULL AND l.qty IS NOT NULL
     UNION ALL
     SELECT h.uid, 'adjustment', h.number, h.date::date, l.item_uid,
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
