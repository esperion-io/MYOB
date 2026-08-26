import type pg from "pg";
import { config } from "../config.js";
import { getPool } from "../db.js";
import { MyobApiError, myobGetAllPages } from "../myob/client.js";
import type { CompanyConnection } from "../myob/types.js";
import { getActiveConnection } from "../store/connections.js";
import { ensureInsightsSchema } from "./schema.js";
import { establishOpeningBalance, snapshotPositions } from "../insights/ledger.js";

type Raw = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}
/*
 * A number MYOB actually sent, or null.
 *
 * `Number(null)` is 0, so the obvious one-liner turned every field MYOB
 * explicitly returns as null into a hard zero — indistinguishable afterwards
 * from a real zero. On the live file that stored 0 average cost against 39
 * items and 0 minimum level against 23, and the moment one of those items
 * holds stock its value silently reads as nothing.
 *
 * Booleans and objects coerce just as quietly (`Number(true)` is 1,
 * `Number([])` is 0), so only numbers and numeric strings are accepted —
 * MYOB does return some decimals as strings.
 *
 * This also repairs `lineQty`'s fallback chain: `??` does not step over a 0,
 * so a null ShipQuantity used to pin a line at zero instead of falling through
 * to BillQuantity or Quantity.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "number" && typeof v !== "string") return null;
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
  /** Bounded by the history floor on first sync (transactional data). */
  windowed: boolean;
  /**
   * Never apply a LastModified filter to this entity, even on an incremental
   * run. Set for entities where MYOB does not maintain LastModified against the
   * changes we care about — see the items spec for why this matters.
   */
  alwaysFull?: boolean;
  /** OData $expand passed through to the collection request. */
  expand?: string;
  upsertPage: (client: pg.PoolClient, items: Raw[]) => Promise<void>;
}

/** MYOB custom lists/fields are `{ Label, Value }`; empty values mean unset. */
function customValue(v: unknown): string | null {
  const o = (v ?? {}) as Raw;
  return str(o.Value);
}

/**
 * Rows from an item's MYOB Bill of Materials.
 * Shape: `BillOfMaterials: { Quantity, Items: [{ Quantity, Item: {UID,…} }] }`.
 * `Quantity` on the parent is how many units the recipe produces, so qty per
 * single unit is the component quantity divided by it.
 */
export function bomRows(item: Raw): unknown[][] {
  const parentUid = str(item.UID);
  if (!parentUid || item.BillOfMaterials == null) return [];

  // MYOB has returned this as a single object; tolerate a collection too rather
  // than silently dropping recipes if the shape differs from the documentation.
  const raw = item.BillOfMaterials as Raw | Raw[];
  const bom = (Array.isArray(raw) ? raw[0] : raw) ?? null;
  if (!bom || typeof bom !== "object") return [];

  const buildQty = num(bom.Quantity) ?? 1;
  const components = Array.isArray(bom.Items) ? (bom.Items as Raw[]) : [];
  const rows: unknown[][] = [];
  const seen = new Set<string>();

  for (const line of components) {
    const component = ref(line.Item);
    const qty = num(line.Quantity);
    if (!component.uid || qty == null || component.uid === parentUid) continue;
    // MYOB permits a component to repeat; the primary key does not.
    if (seen.has(component.uid)) continue;
    seen.add(component.uid);
    rows.push([
      parentUid,
      component.uid,
      buildQty > 0 ? qty / buildQty : qty,
      buildQty,
      str((line.Item as Raw)?.Number),
      component.name,
    ]);
  }
  return rows;
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
        ["uid", "display_id", "name", "is_active", "city", "country", "phone", "email"],
        items.map((s) => {
          const addresses = Array.isArray(s.Addresses) ? (s.Addresses as Raw[]) : [];
          const addr = addresses[0] ?? {};
          return [
            str(s.UID),
            str(s.DisplayID),
            str(s.CompanyName) ?? [str(s.FirstName), str(s.LastName)].filter(Boolean).join(" ") ?? null,
            bool(s.IsActive),
            str(addr.City),
            str(addr.Country),
            str(addr.Phone1),
            str(addr.Email),
          ];
        }),
        `ON CONFLICT (uid) DO UPDATE SET display_id = EXCLUDED.display_id,
          name = EXCLUDED.name, is_active = EXCLUDED.is_active,
          city = EXCLUDED.city, country = EXCLUDED.country,
          phone = EXCLUDED.phone, email = EXCLUDED.email, synced_at = NOW()`,
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
    /*
     * MYOB does NOT update Item.LastModified when a transaction changes an
     * item's quantity — only when the item record itself is edited. Verified on
     * Allied's file: of 177 items with stock movement after 12 Aug 2026, just 14
     * had a touched item record, and 2,978 of 3,061 items still carry a
     * LastModified of 6-7 May 2026 from a bulk edit.
     *
     * A LastModified-filtered incremental sync therefore never re-fetches the
     * items whose stock actually moved, and silently serves stale quantities
     * while reporting success. Every quantity-derived figure in the product
     * inherits that error, so this entity is always fully refreshed. It is only
     * ~3,100 rows / ~8 pages.
     */
    alwaysFull: true,
    // Pulls MYOB's real recipes, including auto-build items that never appear
    // as Build transactions and so can never be derived from observed builds.
    expand: "BillOfMaterials",
    upsertPage: async (client, items) => {
      const cols = [
        "uid", "number", "name", "description", "is_active", "is_bought",
        "is_sold", "is_inventoried", "qty_on_hand", "qty_committed",
        "qty_on_order", "qty_available", "average_cost", "current_value",
        "base_selling_price", "min_level", "reorder_qty",
        "primary_supplier_uid", "primary_supplier_name", "supplier_item_number",
        "product_type", "product_finish", "bin_location", "location_details",
        "quantities_as_of", "last_modified", "raw",
      ];
      const rows = items.map((it) => {
        const buying = (it.BuyingDetails ?? {}) as Raw;
        const restock = (buying.RestockingInformation ?? {}) as Raw;
        /*
         * MYOB names this key `Supplier`, not `PrimarySupplier`. Reading the
         * wrong name silently produced null for every item and led to the
         * recorded conclusion that Allied never set a primary supplier — in
         * fact 2,008 of 3,101 items have one. Everything downstream then fell
         * back to inferring a supplier from purchase-bill history.
         */
        const supplier = ref(
          restock.Supplier ?? restock.PrimarySupplier ?? restock.PrimaryVendor,
        );
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
          // MYOB's key is DefaultOrderQuantity; the older name never matched.
          num(restock.DefaultOrderQuantity) ?? num(restock.DefaultReorderQuantity),
          supplier.uid,
          supplier.name,
          str(restock.SupplierItemNumber) ?? str(restock.VendorItemNumber),
          customValue(it.CustomList1),
          customValue(it.CustomList2),
          customValue(it.CustomList3),
          it.LocationDetails ? JSON.stringify(it.LocationDetails) : null,
          new Date().toISOString(),
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

      // Replace this page's BOM rows wholesale, so recipes removed in MYOB
      // disappear here too rather than lingering.
      const uids = items.map((it) => str(it.UID)).filter(Boolean);
      if (uids.length) {
        await client.query(
          `DELETE FROM myob_item_bom WHERE parent_uid = ANY($1)`,
          [uids],
        );
      }
      const bom = items.flatMap(bomRows);
      if (bom.length) {
        await insertRows(
          client,
          "myob_item_bom",
          [
            "parent_uid", "component_uid", "qty_per", "build_qty",
            "component_number", "component_name",
          ],
          bom,
          "",
        );
      }
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

/**
 * Earliest transaction date to mirror. A fixed SYNC_SINCE date is preferred
 * over a rolling window so the history floor does not creep forward and drop
 * the runway the stock ledger needs; syncWindowDays remains the fallback.
 */
function historyFloor(): Date {
  const since = config.insights.syncSince;
  if (since) {
    const parsed = new Date(`${since}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(
    Date.now() - config.insights.syncWindowDays * 24 * 60 * 60 * 1000,
  );
}

let running = false;

export function isSyncRunning(): boolean {
  return running;
}

/** When any sync last completed, for the boot catch-up check. */
export async function lastSyncedAt(): Promise<Date | null> {
  await ensureInsightsSchema();
  const r = await getPool().query(
    `SELECT MAX(finished_at) AS at FROM sync_runs WHERE status = 'success'`,
  );
  const at = r.rows[0]?.at;
  return at ? new Date(at) : null;
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

    /*
     * Rebuild the derived recipes inside a transaction.
     *
     * deriveBomFromBuilds clears source='derived' and re-inserts it. Run
     * without a transaction — as this was — a failure between the two, or a
     * process that dies in the gap, leaves the table permanently empty of
     * derived rows and effective_bom silently falls back to MYOB's own BOM
     * alone. That drops 111 parent-component pairs which exist only as
     * observed builds, and nothing about the resulting numbers looks wrong.
     */
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      stats.derived_bom_rows = await deriveBomFromBuilds(client);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    /*
     * Own the numbers, then record them.
     *
     * The opening balance is the single point where MYOB's stock figure is used
     * as an input; it is a no-op once established. Everything after it is this
     * platform's own arithmetic over its own movement ledger.
     *
     * The snapshot is what makes the history real: without a row written every
     * day, "what did we hold on 31 July" can only ever be reconstructed, never
     * looked up. It must not fail the sync — the mirrored MYOB data is still
     * correct and useful without it.
     */
    try {
      stats.opening_balance = await establishOpeningBalance();
      stats.position_snapshot = await snapshotPositions();
    } catch (err) {
      stats.position_snapshot_error =
        err instanceof Error ? err.message : String(err);
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
  if (mode === "incremental" && high && !spec.alwaysFull) {
    // 5-minute overlap so we never miss edits racing the previous sync.
    const since = new Date(high.getTime() - 5 * 60 * 1000);
    filter = `LastModified gt ${myobDateLiteral(since)}`;
  } else if (spec.windowed) {
    filter = `Date ge ${myobDateLiteral(historyFloor())}`;
  }

  let rows = 0;
  let maxModified: string | null = null;

  const onPage = async (items: Raw[]): Promise<void> => {
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
  };

  let pages = 0;
  let expandError: string | null = null;
  try {
    ({ pages } = await myobGetAllPages(connection, spec.path, {
      filter,
      expand: spec.expand,
      onPage,
    }));
  } catch (err) {
    // If MYOB rejects the $expand, the quantities still matter far more than the
    // recipes do — retry without it rather than failing the whole sync and
    // leaving stock stale. Upserts are idempotent, so replaying pages is safe.
    const rejected =
      spec.expand && err instanceof MyobApiError && err.status >= 400 && err.status < 500;
    if (!rejected) throw err;
    expandError = err instanceof Error ? err.message : String(err);
    rows = 0;
    maxModified = null;
    ({ pages } = await myobGetAllPages(connection, spec.path, { filter, onPage }));
  }

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

  return {
    pages,
    fetched: rows,
    filter: filter ?? "none",
    ...(spec.expand ? { expand: expandError ? "rejected — retried without" : spec.expand } : {}),
    ...(expandError ? { expandError } : {}),
  };
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
