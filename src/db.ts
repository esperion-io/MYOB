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
      /*
       * Pin every connection to UTC.
       *
       * MYOB sends transaction dates with no time or zone, so they land at
       * midnight UTC. Casting one back to a date — `i.date::date`, or comparing
       * it against `'2026-08-26'::date` — resolves in the SESSION timezone, and
       * there are around forty such comparisons across the demand, cover and
       * purchasing queries. Under a non-UTC session they silently shift by a
       * day: the same six-month demand window returned 1,147,828 units under
       * UTC and 1,151,325 under Pacific/Auckland.
       *
       * `stock_movements` already defends itself with an explicit
       * `AT TIME ZONE 'UTC'`, which is why the stock ledger was unaffected. This
       * extends the same guarantee to everything else, at the connection rather
       * than in forty places where the next new query would forget it.
       *
       * Business-calendar dates are unaffected: they are resolved explicitly
       * against Allied's timezone (see BUSINESS_TODAY_SQL and businessDate.ts),
       * never against the session.
       *
       * Set as a startup parameter rather than on a `connect` handler, because
       * node-postgres does not await that handler and a query could otherwise
       * reach the server before the SET landed.
       */
      options: "-c timezone=UTC",
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
