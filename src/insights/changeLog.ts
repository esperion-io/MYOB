import type { Pool, PoolClient } from "pg";
import { release } from "../release.js";

/**
 * The before/after record behind every supplier and cart change.
 *
 * Allied's preferred suppliers and the choices they make in the cart are
 * decisions, not derived data: nothing can rebuild them if they are lost. Each
 * write therefore records the item's whole state on both sides of the change,
 * in the same transaction, so any one change can be put back exactly — see
 * scripts/supplier-rollback.mjs.
 */

type Db = Pool | PoolClient;

export interface SupplierState {
  suppliers: {
    supplier_uid: string;
    is_preferred: boolean;
    supplier_item_number: string | null;
    notes: string | null;
  }[];
  ruledNone: { reason: string | null; set_by: string | null; set_at: string } | null;
}

/** Everything Allied have recorded about who supplies one item. */
export async function supplierStateOf(db: Db, itemUid: string): Promise<SupplierState> {
  // One after another: these often run on a single transaction's client, which
  // takes one query at a time.
  const rows = await db.query(
    `SELECT supplier_uid, is_preferred, supplier_item_number, notes
     FROM platform_item_suppliers WHERE item_uid = $1 ORDER BY supplier_uid`,
    [itemUid],
  );
  const ruling = await db.query(
    `SELECT reason, set_by, set_at FROM platform_item_no_supplier WHERE item_uid = $1`,
    [itemUid],
  );
  return {
    suppliers: rows.rows as SupplierState["suppliers"],
    ruledNone: (ruling.rows[0] as SupplierState["ruledNone"]) ?? null,
  };
}

export interface CartRow {
  item_uid: string;
  supplier_uid: string;
  qty: number | null;
  state: string;
  note: string | null;
  updated_by: string | null;
  updated_at: string;
}

/**
 * One item's saved cart decisions, whole: its rows, Allied's "Keep" on an
 * earlier pick, and whether they took it off this order. Logged together so an
 * undo puts all three back at once.
 */
export interface CartState {
  rows: CartRow[];
  ack: { preferred_supplier_uid: string; acked_at: string } | null;
  takenOff: boolean;
  /** When it was taken off, so an undo puts back the same moment. */
  takenOffAt?: string | null;
}

export async function cartStateOf(db: Db, itemUid: string): Promise<CartState> {
  const rows = await db.query(`SELECT * FROM platform_purchase_cart WHERE item_uid = $1 ORDER BY supplier_uid`, [itemUid]);
  const ack = await db.query(
    `SELECT preferred_supplier_uid, acked_at FROM platform_cart_pick_ack WHERE item_uid = $1`,
    [itemUid],
  );
  const off = await db.query(`SELECT taken_off_at FROM platform_cart_item_off WHERE item_uid = $1`, [itemUid]);
  return {
    rows: rows.rows as CartRow[],
    ack: (ack.rows[0] as CartState["ack"]) ?? null,
    takenOff: off.rows.length > 0,
    takenOffAt: (off.rows[0]?.taken_off_at as string | undefined) ?? null,
  };
}

/** Every item's saved cart decisions, for "Start again". */
export async function cartStateAll(db: Db): Promise<{
  rows: CartRow[];
  acks: { item_uid: string; preferred_supplier_uid: string; acked_at: string }[];
  takenOff: string[];
  takenOffAt: Record<string, string>;
}> {
  const rows = await db.query(`SELECT * FROM platform_purchase_cart ORDER BY item_uid, supplier_uid`);
  const acks = await db.query(`SELECT item_uid, preferred_supplier_uid, acked_at FROM platform_cart_pick_ack ORDER BY item_uid`);
  const off = await db.query(`SELECT item_uid, taken_off_at FROM platform_cart_item_off ORDER BY item_uid`);
  return {
    rows: rows.rows as CartRow[],
    acks: acks.rows as { item_uid: string; preferred_supplier_uid: string; acked_at: string }[],
    takenOff: off.rows.map((r) => r.item_uid as string),
    takenOffAt: Object.fromEntries(off.rows.map((r) => [r.item_uid as string, r.taken_off_at as string])),
  };
}

/*
 * Which release wrote a log row (1.0).
 *
 * "Did this change come from 1.2 or from 1.3?" is the first question when a
 * release is suspected of writing something wrong, and `changed_at` alone only
 * answers it if the deploy time is known to the minute. The version and commit
 * go into `detail`, which is JSONB and which the rollback script reads only for
 * `items`, `inserted`, `scope` and `savedAs`, so adding keys changes nothing it
 * does. A detail that is not a plain object (none today) is left as it is
 * rather than wrapped, so its shape never changes under a reader.
 */
export function stampDetail(detail: unknown): unknown {
  const stamp = { release: release.version, commit: release.commit };
  if (detail == null) return stamp;
  if (typeof detail === "object" && !Array.isArray(detail)) return { ...detail, ...stamp };
  return detail;
}

export async function logChange(
  db: Db,
  entry: {
    entity: "item_supplier" | "cart";
    itemUid: string | null;
    action: string;
    before: unknown;
    after: unknown;
    detail?: unknown;
    changedBy?: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO platform_change_log (entity, item_uid, action, before, after, detail, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.entity,
      entry.itemUid,
      entry.action,
      JSON.stringify(entry.before ?? null),
      JSON.stringify(entry.after ?? null),
      JSON.stringify(stampDetail(entry.detail)),
      entry.changedBy ?? "dashboard",
    ],
  );
}

/** Run `fn` in a transaction on its own client, committing only if it returns. */
export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
