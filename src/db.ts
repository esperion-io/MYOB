import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function hasDatabaseUrl(): boolean {
  return Boolean(config.databaseUrl);
}

export function getPool(): pg.Pool {
  if (!config.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Add Postgres on Railway and reference DATABASE_URL on the app service.",
    );
  }
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      // Railway private networking uses SSL sometimes; public URL usually needs it.
      ssl: config.databaseUrl.includes("localhost")
        ? undefined
        : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function ensureSchema(): Promise<void> {
  if (!hasDatabaseUrl()) return;
  if (!schemaReady) {
    schemaReady = (async () => {
      const client = await getPool().connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS connections (
            business_id TEXT PRIMARY KEY,
            display_name TEXT,
            connected_at TIMESTAMPTZ NOT NULL,
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            scope TEXT,
            user_uid TEXT,
            username TEXT,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS connections_active_idx
          ON connections (is_active)
          WHERE is_active = TRUE;
        `);
      } finally {
        client.release();
      }
    })();
  }
  await schemaReady;
}
