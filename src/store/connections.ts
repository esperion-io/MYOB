import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { openToken, sealToken } from "../crypto/tokens.js";
import { ensureSchema, getPool, hasDatabaseUrl } from "../db.js";
import type {
  CompanyConnection,
  ConnectionStore,
  StoredTokens,
} from "../myob/types.js";

const STORE_FILE = () => path.join(config.dataDir, "connections.json");

type ConnectionRow = {
  business_id: string;
  display_name: string | null;
  connected_at: Date | string;
  access_token: string;
  refresh_token: string;
  expires_at: Date | string;
  scope: string | null;
  user_uid: string | null;
  username: string | null;
  is_active: boolean;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowToConnection(row: ConnectionRow): CompanyConnection {
  return {
    businessId: row.business_id,
    displayName: row.display_name ?? undefined,
    connectedAt: toIso(row.connected_at),
    tokens: {
      accessToken: openToken(row.access_token),
      refreshToken: openToken(row.refresh_token),
      expiresAt: new Date(row.expires_at).getTime(),
      scope: row.scope ?? undefined,
      userUid: row.user_uid ?? undefined,
      username: row.username ?? undefined,
    },
  };
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

async function loadFileStore(): Promise<ConnectionStore> {
  try {
    const raw = await fs.readFile(STORE_FILE(), "utf8");
    const parsed = JSON.parse(raw) as ConnectionStore;
    return {
      connections: parsed.connections ?? [],
      activeBusinessId: parsed.activeBusinessId,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { connections: [] };
    }
    throw err;
  }
}

async function saveFileStore(store: ConnectionStore): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(STORE_FILE(), JSON.stringify(store, null, 2), "utf8");
}

async function loadDbStore(): Promise<ConnectionStore> {
  await ensureSchema();
  const result = await getPool().query<ConnectionRow>(
    `SELECT * FROM connections ORDER BY connected_at ASC`,
  );
  // Decrypt per-row so a single unreadable token (e.g. after a
  // TOKEN_ENCRYPTION_KEY change) degrades to "that connection is skipped"
  // instead of throwing and taking down every endpoint that loads the store.
  const connections: CompanyConnection[] = [];
  for (const row of result.rows) {
    try {
      connections.push(rowToConnection(row));
    } catch (err) {
      console.warn(
        `Skipping connection ${row.business_id}: token could not be decrypted ` +
          `(TOKEN_ENCRYPTION_KEY may have changed since it was stored) — ${
            (err as Error).message
          }`,
      );
    }
  }
  const usable = new Set(connections.map((c) => c.businessId));
  const active = result.rows.find((r) => r.is_active && usable.has(r.business_id));
  return {
    connections,
    activeBusinessId: active?.business_id ?? connections[0]?.businessId,
  };
}

export async function loadStore(): Promise<ConnectionStore> {
  if (hasDatabaseUrl()) return loadDbStore();
  return loadFileStore();
}

export async function upsertConnection(
  businessId: string,
  tokens: StoredTokens,
  displayName?: string,
): Promise<CompanyConnection> {
  if (!hasDatabaseUrl()) {
    const store = await loadFileStore();
    const existing = store.connections.find((c) => c.businessId === businessId);
    const connection: CompanyConnection = {
      businessId,
      displayName: displayName ?? existing?.displayName,
      connectedAt: existing?.connectedAt ?? new Date().toISOString(),
      tokens,
    };
    store.connections = [
      ...store.connections.filter((c) => c.businessId !== businessId),
      connection,
    ];
    store.activeBusinessId = businessId;
    await saveFileStore(store);
    return connection;
  }

  await ensureSchema();
  const connectedAt = new Date().toISOString();
  const result = await getPool().query<ConnectionRow>(
    `
    INSERT INTO connections (
      business_id, display_name, connected_at,
      access_token, refresh_token, expires_at,
      scope, user_uid, username, is_active, updated_at
    ) VALUES (
      $1, $2, $3,
      $4, $5, to_timestamp($6 / 1000.0),
      $7, $8, $9, TRUE, NOW()
    )
    ON CONFLICT (business_id) DO UPDATE SET
      display_name = COALESCE(EXCLUDED.display_name, connections.display_name),
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      user_uid = EXCLUDED.user_uid,
      username = EXCLUDED.username,
      is_active = TRUE,
      updated_at = NOW()
    RETURNING *
    `,
    [
      businessId,
      displayName ?? null,
      connectedAt,
      sealToken(tokens.accessToken),
      sealToken(tokens.refreshToken),
      tokens.expiresAt,
      tokens.scope ?? null,
      tokens.userUid ?? null,
      tokens.username ?? null,
    ],
  );

  // Ensure only this company file is marked active.
  await getPool().query(
    `UPDATE connections SET is_active = (business_id = $1)`,
    [businessId],
  );

  return rowToConnection(result.rows[0]!);
}

export async function updateTokens(
  businessId: string,
  tokens: StoredTokens,
): Promise<void> {
  if (!hasDatabaseUrl()) {
    const store = await loadFileStore();
    const connection = store.connections.find((c) => c.businessId === businessId);
    if (!connection) {
      throw new Error(`No connection found for businessId ${businessId}`);
    }
    connection.tokens = tokens;
    await saveFileStore(store);
    return;
  }

  await ensureSchema();
  const result = await getPool().query(
    `
    UPDATE connections SET
      access_token = $2,
      refresh_token = $3,
      expires_at = to_timestamp($4 / 1000.0),
      scope = $5,
      user_uid = $6,
      username = $7,
      updated_at = NOW()
    WHERE business_id = $1
    `,
    [
      businessId,
      sealToken(tokens.accessToken),
      sealToken(tokens.refreshToken),
      tokens.expiresAt,
      tokens.scope ?? null,
      tokens.userUid ?? null,
      tokens.username ?? null,
    ],
  );
  if (result.rowCount === 0) {
    throw new Error(`No connection found for businessId ${businessId}`);
  }
}

export async function setActiveBusinessId(businessId: string): Promise<void> {
  if (!hasDatabaseUrl()) {
    const store = await loadFileStore();
    if (!store.connections.some((c) => c.businessId === businessId)) {
      throw new Error(`Unknown businessId: ${businessId}`);
    }
    store.activeBusinessId = businessId;
    await saveFileStore(store);
    return;
  }

  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const exists = await client.query(
      `SELECT 1 FROM connections WHERE business_id = $1`,
      [businessId],
    );
    if (!exists.rowCount) {
      throw new Error(`Unknown businessId: ${businessId}`);
    }
    await client.query(`UPDATE connections SET is_active = FALSE`);
    await client.query(
      `UPDATE connections SET is_active = TRUE, updated_at = NOW() WHERE business_id = $1`,
      [businessId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getActiveConnection(): Promise<CompanyConnection | null> {
  const store = await loadStore();
  if (!store.connections.length) return null;
  if (store.activeBusinessId) {
    const active = store.connections.find(
      (c) => c.businessId === store.activeBusinessId,
    );
    if (active) return active;
  }
  return store.connections[0] ?? null;
}

export async function removeConnection(businessId: string): Promise<void> {
  if (!hasDatabaseUrl()) {
    const store = await loadFileStore();
    store.connections = store.connections.filter(
      (c) => c.businessId !== businessId,
    );
    if (store.activeBusinessId === businessId) {
      store.activeBusinessId = store.connections[0]?.businessId;
    }
    await saveFileStore(store);
    return;
  }

  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM connections WHERE business_id = $1`, [
      businessId,
    ]);
    await client.query(
      `
      UPDATE connections
      SET is_active = TRUE, updated_at = NOW()
      WHERE business_id = (
        SELECT business_id FROM connections
        ORDER BY connected_at ASC
        LIMIT 1
      )
      AND NOT EXISTS (SELECT 1 FROM connections WHERE is_active = TRUE)
      `,
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function clearAllConnections(): Promise<void> {
  if (!hasDatabaseUrl()) {
    await saveFileStore({ connections: [] });
    return;
  }
  await ensureSchema();
  await getPool().query(`DELETE FROM connections`);
}

export function storageBackend(): "postgres" | "file" {
  return hasDatabaseUrl() ? "postgres" : "file";
}
