import type pg from "pg";
import { config } from "../config.js";
import { getPool } from "../db.js";
import { myobGetAllPages } from "../myob/client.js";
import type { CompanyConnection } from "../myob/types.js";
import { getActiveConnection } from "../store/connections.js";
import { ensureInsightsSchema } from "./schema.js";

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function ref(v: unknown): { uid: string | null; name: string | null } {
  const o = (v ?? {}) as Raw;
  return {
    uid: str(o.UID),
    name: str(o.Name) ?? str(o.CompanyName),
  };
}

/** Transaction lines only; MYOB header/subtotal lines have other Type values. */
function transactionLines(doc: Raw): Raw[] {
  const lines = Array.isArray(doc.Lines) ? (doc.Lines as Raw[]) : [];
  return lines.filter((l) => {
    const type = str(l.Type);
    return !type || type === "Transaction";
  });
}

function lineQty(line: Raw): number | null {
  return (
    num(line.ShipQuantity) ??
    num(line.BillQuantity) ??
    num(line.Quantity) ??
    num(line.ReceivedQuantity)
  );
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function insertRows(
  client: pg.PoolClient,
  table: string,
  columns: string[],
  rows: unknown[][],
  conflict: string,
): Promise<void> {
  for (const batch of chunk(rows, 100)) {
    const values: unknown[] = [];
    const tuples = batch
      .map((row, r) => {
        const placeholders = row.map((_, c) => `$${r * columns.length + c + 1}`);
        values.push(...row);
        return `(${placeholders.join(",")})`;
      })
      .join(",");
    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples} ${conflict}`,
      values,
    );
  }
}

/** Upsert header + replace lines for line-bearing documents. */
async function upsertDocs(options: {
  client: pg.PoolClient;
  docs: Raw[];
  headerTable: string;
  headerColumns: string[];
  headerRow: (doc: Raw) => unknown[];
  lineTable?: string;
  lineColumns?: string[];
  lineRows?: (doc: Raw) => unknown[][];
  uidColumn?: string;
}): Promise<void> {
  const {
    client,
    docs,
    headerTable,
    headerColumns,
    headerRow,
    lineTable,
    lineColumns,
    lineRows,
  } = options;
  if (!docs.length) return;

  const uidCol = options.uidColumn ?? "uid";
  const updates = headerColumns
    .filter((c) => c !== uidCol)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat("synced_at = NOW()")
    .join(", ");

  await insertRows(
    client,
    headerTable,
    headerColumns,
    docs.map(headerRow),
    `ON CONFLICT (${uidCol}) DO UPDATE SET ${updates}`,
  );

  if (lineTable && lineColumns && lineRows) {
    const uids = docs.map((d) => str(d.UID)).filter(Boolean);
    await client.query(
      `DELETE FROM ${lineTable} WHERE ${lineTable.includes("invoice") ? "invoice_uid" : lineTable.includes("bill") ? "bill_uid" : lineTable.includes("build") ? "build_uid" : lineTable.includes("adjustment") ? "adjustment_uid" : "order_uid"} = ANY($1)`,
      [uids],
    );
    const allLines = docs.flatMap(lineRows);
    if (allLines.length) {
      await insertRows(client, lineTable, lineColumns, allLines, "");
    }
  }
}

interface EntitySpec {
  entity: string;
  path: string;
  /** Bounded by SYNC_WINDOW_DAYS on first sync (transactional data). */
  windowed: boolean;
  upsertPage: (client: pg.PoolClient, items: Raw[]) => Promise<void>;
}

const ENTITIES: EntitySpec[] = [
  {
    entity: "suppliers",
    path: "Contact/Supplier",
    windowed: false,
    upsertPage: (client, items) =>
      insertRows(
        client,
        "myob_suppliers",
        ["uid", "display_id", "name", "is_active"],
        items.map((s) => [
          str(s.UID),
          str(s.DisplayID),
          str(s.CompanyName) ?? [str(s.FirstName), str(s.LastName)].filter(Boolean).join(" ") ?? null,
          bool(s.IsActive),
        ]),
        `ON CONFLICT (uid) DO UPDATE SET display_id = EXCLUDED.display_id,
          name = EXCLUDED.name, is_active = EXCLUDED.is_active, synced_at = NOW()`,
      ),
  },
  {
    entity: "locations",
    path: "Inventory/Location",
    windowed: false,
    upsertPage: (client, items) =>
      insertRows(
        client,
        "myob_locations",
        ["uid", "identifier", "name", "is_active"],
        items.map((l) => [
          str(l.UID),
          str(l.Identifier),
          str(l.Name),
          bool(l.IsActive),
        ]),
        `ON CONFLICT (uid) DO UPDATE SET identifier = EXCLUDED.identifier,
          name = EXCLUDED.name, is_active = EXCLUDED.is_active, synced_at = NOW()`,
      ),
  },
  {
    entity: "items",
    path: "Inventory/Item",
    windowed: false,
    upsertPage: async (client, items) => {
      const cols = [
        "uid", "number", "name", "description", "is_active", "is_bought",
        "is_sold", "is_inventoried", "qty_on_hand", "qty_committed",
        "qty_on_order", "qty_available", "average_cost", "current_value",
        "base_selling_price", "min_level", "reorder_qty",
        "primary_supplier_uid", "primary_supplier_name", "supplier_item_number",
        "last_modified", "raw",
      ];
      const rows = items.map((it) => {
        const buying = (it.BuyingDetails ?? {}) as Raw;
        const restock = (buying.RestockingInformation ?? {}) as Raw;
        const supplier = ref(restock.PrimarySupplier ?? restock.PrimaryVendor);
        return [
          str(it.UID),
          str(it.Number),
          str(it.Name),
          str(it.Description),
          bool(it.IsActive),
          bool(it.IsBought),
          bool(it.IsSold),
          bool(it.IsInventoried),
          num(it.QuantityOnHand),
          num(it.QuantityCommitted),
          num(it.QuantityOnOrder),
          num(it.QuantityAvailable),
          num(it.AverageCost),
          num(it.CurrentValue),
          num(it.BaseSellingPrice),
          num(restock.MinimumLevelForRestockingAlert),
          num(restock.DefaultReorderQuantity),
          supplier.uid,
          supplier.name,
          str(restock.SupplierItemNumber) ?? str(restock.VendorItemNumber),
          str(it.LastModified),
          JSON.stringify(it),
        ];
      });
      const updates = cols
        .filter((c) => c !== "uid")
        .map((c) => `${c} = EXCLUDED.${c}`)
        .concat("synced_at = NOW()")
        .join(", ");
      await insertRows(
        client,
        "myob_items",
        cols,
        rows,
        `ON CONFLICT (uid) DO UPDATE SET ${updates}`,
      );
    },
  },
  {
    entity: "sale_invoices",
    path: "Sale/Invoice/Item",
    windowed: true,
    upsertPage: (client, docs) =>
      upsertDocs({
        client,
        docs,
        headerTable: "myob_sale_invoices",
        headerColumns: [
          "uid", "number", "date", "status", "customer_uid", "customer_name",
          "total", "last_modified",
        ],
        headerRow: (d) => {
          const customer = ref(d.Customer);
          return [
            str(d.UID), str(d.Number), str(d.Date), str(d.Status),
            customer.uid, customer.name, num(d.TotalAmount) ?? num(d.Subtotal),
            str(d.LastModified),
          ];
        },
        lineTable: "myob_sale_invoice_lines",
        lineColumns: [
          "invoice_uid", "idx", "item_uid", "qty", "unit_price", "total", "description",
        ],
        lineRows: (d) =>
          transactionLines(d).map((l, i) => [
            str(d.UID), i, ref(l.Item).uid, lineQty(l), num(l.UnitPrice),
            num(l.Total), str(l.Description),
          ]),
      }),
  },
  {
    entity: "sale_orders",
    path: "Sale/Order/Item",
    windowed: true,
    upsertPage: (client, docs) =>
      upsertDocs({
        client,
        docs,
        headerTable: "myob_sale_orders",
        headerColumns: [
          "uid", "number", "date", "status", "customer_uid", "customer_name",
          "promised_date", "total", "last_modified",
        ],
        headerRow: (d) => {
          const customer = ref(d.Customer);
          return [
            str(d.UID), str(d.Number), str(d.Date), str(d.Status),
            customer.uid, customer.name, str(d.PromisedDate),
            num(d.TotalAmount) ?? num(d.Subtotal), str(d.LastModified),
          ];
        },
        lineTable: "myob_sale_order_lines",
        lineColumns: [
          "order_uid", "idx", "item_uid", "qty", "unit_price", "total", "description",
        ],
        lineRows: (d) =>
          transactionLines(d).map((l, i) => [
            str(d.UID), i, ref(l.Item).uid, lineQty(l), num(l.UnitPrice),
            num(l.Total), str(l.Description),
          ]),
      }),
  },
  {
    entity: "purchase_bills",
    path: "Purchase/Bill/Item",
    windowed: true,
    upsertPage: (client, docs) =>
      upsertDocs({
        client,
        docs,
        headerTable: "myob_purchase_bills",
        headerColumns: [
          "uid", "number", "date", "status", "supplier_uid", "supplier_name",
          "total", "last_modified",
        ],
        headerRow: (d) => {
          const supplier = ref(d.Supplier);
          return [
            str(d.UID), str(d.Number), str(d.Date), str(d.Status),
            supplier.uid, supplier.name, num(d.TotalAmount) ?? num(d.Subtotal),
            str(d.LastModified),
          ];
        },
        lineTable: "myob_purchase_bill_lines",
        lineColumns: [
          "bill_uid", "idx", "item_uid", "qty", "unit_price", "total", "description",
        ],
        lineRows: (d) =>
          transactionLines(d).map((l, i) => [
            str(d.UID), i, ref(l.Item).uid, lineQty(l), num(l.UnitPrice),
            num(l.Total), str(l.Description),
          ]),
      }),
  },
  {
    entity: "purchase_orders",
    path: "Purchase/Order/Item",
    windowed: true,
    upsertPage: (client, docs) =>
      upsertDocs({
        client,
        docs,
        headerTable: "myob_purchase_orders",
        headerColumns: [
          "uid", "number", "date", "status", "supplier_uid", "supplier_name",
          "promised_date", "total", "last_modified",
        ],
        headerRow: (d) => {
          const supplier = ref(d.Supplier);
          return [
            str(d.UID), str(d.Number), str(d.Date), str(d.Status),
            supplier.uid, supplier.name, str(d.PromisedDate),
            num(d.TotalAmount) ?? num(d.Subtotal), str(d.LastModified),
          ];
        },
        lineTable: "myob_purchase_order_lines",
        lineColumns: [
          "order_uid", "idx", "item_uid", "qty", "received_qty", "unit_price",
          "total", "description",
        ],
        lineRows: (d) =>
          transactionLines(d).map((l, i) => [
            str(d.UID), i, ref(l.Item).uid, lineQty(l), num(l.ReceivedQuantity),
            num(l.UnitPrice), num(l.Total), str(l.Description),
          ]),
      }),
  },
  {
    entity: "builds",
    path: "Inventory/Build",
    windowed: true,
    upsertPage: (client, docs) =>
      upsertDocs({
        client,
        docs,
        headerTable: "myob_builds",
        headerColumns: ["uid", "number", "date", "memo", "last_modified"],
        headerRow: (d) => [
          str(d.UID), str(d.Number) ?? str(d.DisplayID), str(d.Date),
          str(d.Memo), str(d.LastModified),
        ],
        lineTable: "myob_build_lines",
        lineColumns: ["build_uid", "idx", "item_uid", "qty", "unit_cost"],
        lineRows: (d) =>
          transactionLines(d).map((l, i) => [
            str(d.UID), i, ref(l.Item).uid, num(l.Quantity), num(l.UnitCost),
          ]),
      }),
  },
  {
    entity: "adjustments",
    path: "Inventory/Adjustment",
    windowed: true,
    upsertPage: (client, docs) =>
      upsertDocs({
        client,
        docs,
        headerTable: "myob_adjustments",
        headerColumns: ["uid", "number", "date", "memo", "last_modified"],
        headerRow: (d) => [
          str(d.UID), str(d.Number) ?? str(d.DisplayID), str(d.Date),
          str(d.Memo), str(d.LastModified),
        ],
        lineTable: "myob_adjustment_lines",
        lineColumns: ["adjustment_uid", "idx", "item_uid", "qty", "unit_cost", "memo"],
        lineRows: (d) =>
          transactionLines(d).map((l, i) => [
            str(d.UID), i, ref(l.Item).uid, num(l.Quantity), num(l.UnitCost),
            str(l.Memo),
          ]),
      }),
  },
];

/**
 * Rebuild source='derived' relationships from Build transactions.
 * A build with exactly one produced (positive) line is treated as evidence of
 * that parent's composition; qty_per is averaged across observed builds and
 * confidence grows with the number of corroborating builds.
 */
async function deriveBomFromBuilds(client: pg.PoolClient): Promise<number> {
  await client.query(`DELETE FROM platform_bom WHERE source = 'derived'`);
  const result = await client.query(`
    WITH produced AS (
      SELECT build_uid, item_uid, qty
      FROM myob_build_lines
      WHERE qty > 0 AND item_uid IS NOT NULL
    ),
    single_output AS (
      SELECT build_uid, MIN(item_uid) AS parent_uid, SUM(qty) AS built_qty
      FROM produced
      GROUP BY build_uid
      HAVING COUNT(DISTINCT item_uid) = 1 AND SUM(qty) > 0
    ),
    consumed AS (
      SELECT bl.build_uid, bl.item_uid AS component_uid, -bl.qty AS used_qty
      FROM myob_build_lines bl
      WHERE bl.qty < 0 AND bl.item_uid IS NOT NULL
    )
    INSERT INTO platform_bom
      (parent_uid, component_uid, source, qty_per, build_count, last_observed, confidence, updated_at)
    SELECT
      s.parent_uid,
      c.component_uid,
      'derived',
      SUM(c.used_qty) / SUM(s.built_qty),
      COUNT(DISTINCT s.build_uid)::int,
      MAX(b.date),
      LEAST(1.0, COUNT(DISTINCT s.build_uid) / 3.0),
      NOW()
    FROM single_output s
    JOIN consumed c ON c.build_uid = s.build_uid
    JOIN myob_builds b ON b.uid = s.build_uid
    WHERE s.parent_uid <> c.component_uid
    GROUP BY s.parent_uid, c.component_uid
    HAVING SUM(c.used_qty) > 0
  `);
  return result.rowCount ?? 0;
}

function myobDateLiteral(d: Date): string {
  return `datetime'${d.toISOString().slice(0, 19)}'`;
}

let running = false;

export function isSyncRunning(): boolean {
  return running;
}

export interface SyncResult {
  runId: number;
  status: string;
  stats: Record<string, unknown>;
}

/**
 * Sync MYOB → Postgres. mode:
 *  - "incremental": only records modified since the last high-water mark
 *  - "full": everything again (bounded by SYNC_WINDOW_DAYS for transactions)
 * Read-only toward MYOB in all modes.
 */
export async function runSync(
  mode: "full" | "incremental",
  trigger: string,
): Promise<SyncResult> {
  if (running) throw new Error("A sync is already running.");
  const connection = await getActiveConnection();
  if (!connection) throw new Error("No MYOB company connected.");

  running = true;
  await ensureInsightsSchema();
  const pool = getPool();
  const run = await pool.query(
    `INSERT INTO sync_runs (mode, stats) VALUES ($1, $2) RETURNING id`,
    [mode, JSON.stringify({ trigger })],
  );
  const runId = Number(run.rows[0].id);
  const stats: Record<string, unknown> = { trigger };

  try {
    for (const spec of ENTITIES) {
      stats[spec.entity] = await syncEntity(pool, connection, spec, mode);
      await pool.query(`UPDATE sync_runs SET stats = $2 WHERE id = $1`, [
        runId,
        JSON.stringify(stats),
      ]);
    }

    const client = await pool.connect();
    try {
      stats.derived_bom_rows = await deriveBomFromBuilds(client);
    } finally {
      client.release();
    }

    await pool.query(
      `UPDATE sync_runs SET status = 'success', finished_at = NOW(), stats = $2 WHERE id = $1`,
      [runId, JSON.stringify(stats)],
    );
    return { runId, status: "success", stats };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await pool.query(
      `UPDATE sync_runs SET status = 'error', finished_at = NOW(), error = $2, stats = $3 WHERE id = $1`,
      [runId, message, JSON.stringify(stats)],
    );
    throw err;
  } finally {
    running = false;
  }
}

async function syncEntity(
  pool: pg.Pool,
  connection: CompanyConnection,
  spec: EntitySpec,
  mode: "full" | "incremental",
): Promise<Record<string, unknown>> {
  const state = await pool.query(
    `SELECT last_modified_high FROM sync_state WHERE entity = $1`,
    [spec.entity],
  );
  const high: Date | null = state.rows[0]?.last_modified_high ?? null;

  let filter: string | undefined;
  if (mode === "incremental" && high) {
    // 5-minute overlap so we never miss edits racing the previous sync.
    const since = new Date(high.getTime() - 5 * 60 * 1000);
    filter = `LastModified gt ${myobDateLiteral(since)}`;
  } else if (spec.windowed) {
    const windowStart = new Date(
      Date.now() - config.insights.syncWindowDays * 24 * 60 * 60 * 1000,
    );
    filter = `Date ge ${myobDateLiteral(windowStart)}`;
  }

  let rows = 0;
  let maxModified: string | null = null;

  const { pages } = await myobGetAllPages(connection, spec.path, {
    filter,
    onPage: async (items) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await spec.upsertPage(client, items);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      rows += items.length;
      for (const it of items) {
        const lm = typeof it.LastModified === "string" ? it.LastModified : null;
        if (lm && (!maxModified || lm > maxModified)) maxModified = lm;
      }
    },
  });

  await pool.query(
    `INSERT INTO sync_state (entity, last_modified_high, last_synced_at, row_count, last_error)
     VALUES ($1, $2, NOW(),
       (SELECT COUNT(*) FROM ${entityCountTable(spec.entity)}), NULL)
     ON CONFLICT (entity) DO UPDATE SET
       last_modified_high = GREATEST(COALESCE(EXCLUDED.last_modified_high, sync_state.last_modified_high), COALESCE(sync_state.last_modified_high, EXCLUDED.last_modified_high)),
       last_synced_at = NOW(),
       row_count = EXCLUDED.row_count,
       last_error = NULL`,
    [spec.entity, maxModified],
  );

  return { pages, fetched: rows, filter: filter ?? "none" };
}

function entityCountTable(entity: string): string {
  const map: Record<string, string> = {
    suppliers: "myob_suppliers",
    locations: "myob_locations",
    items: "myob_items",
    sale_invoices: "myob_sale_invoices",
    sale_orders: "myob_sale_orders",
    purchase_bills: "myob_purchase_bills",
    purchase_orders: "myob_purchase_orders",
    builds: "myob_builds",
    adjustments: "myob_adjustments",
  };
  return map[entity] ?? "myob_items";
}

export async function getSyncStatus(): Promise<Record<string, unknown>> {
  await ensureInsightsSchema();
  const pool = getPool();
  const [state, runs] = await Promise.all([
    pool.query(`SELECT * FROM sync_state ORDER BY entity`),
    pool.query(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 10`),
  ]);
  return {
    running,
    entities: state.rows,
    recentRuns: runs.rows,
  };
}
