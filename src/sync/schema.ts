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
