/**
 * Off Render, this app cannot reach production (1.19).
 *
 * Production's MYOB login is a single-use refresh token: whichever process
 * spends it first holds MYOB, and every other copy, production included, is
 * locked out until someone signs in again. A development machine that boots
 * with production's settings can spend it without anyone pressing anything:
 * the boot catch-up sync, a scheduled sync, or a token refresh. So everywhere
 * but Render the app:
 *
 *   - refuses any DATABASE_URL whose host is not this machine (db.ts getPool);
 *   - schedules no sync, whatever SYNC_INTERVAL_HOURS says (config.ts);
 *   - treats MYOB_API_KEY / MYOB_API_SECRET as absent, so no token refresh and
 *     no MYOB call can be made (config.ts).
 *
 * Render sets RENDER=true on every service, at build time and at run time
 * (render.com/docs/environment-variables: "This value is always `true`"), so
 * on Render none of this applies and production boots exactly as before.
 * config.ts reads RENDER from the real environment before .env is loaded, so
 * a .env file cannot claim to be Render.
 *
 * Everything here is pure: each function judges the environment it is given.
 * (databaseHost loads node-postgres' own connection-string parser on first
 * use, which is off Render only.)
 */

import { createRequire } from "node:module";

export type Env = Readonly<Record<string, string | undefined>>;

/** Exactly what Render sets. Anything else, unset included, is "not Render". */
export function isRender(env: Env): boolean {
  return env.RENDER === "true";
}

/** The only database hosts accepted off Render. */
export const LOCAL_DATABASE_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1"];

/** Said wherever MYOB would otherwise be used or offered off Render. */
export const MYOB_OFF_HERE =
  "MYOB is off on this machine, on purpose: only the dashboard on Render uses the MYOB key, " +
  "because production's MYOB login is single-use and spending it from here would break production's " +
  "MYOB connection. Work on the local copy instead (see CLAUDE.md in the folder above this repository).";

type PgParse = (connectionString: string) => { host?: string | null };
let pgParse: PgParse | undefined;

/**
 * node-postgres' own connection-string parser: the copy of pg-connection-string
 * that the installed `pg` itself requires, so the host read here is the host
 * it would use, by construction, not by imitation. (An imitation drifted: pg
 * encodes a string with a space or a stray "%" before parsing it, so
 * "postgres://…@<remote>/db?h%6Fst=localhost&x=a b" read as localhost to
 * new URL() and as <remote> to pg.) Loaded on first use, which is off Render
 * only.
 */
function parseAsPg(url: string): { host?: string | null } {
  if (!pgParse) {
    const fromHere = createRequire(import.meta.url);
    const fromPg = createRequire(fromHere.resolve("pg"));
    pgParse = (fromPg("pg-connection-string") as { parse: PgParse }).parse;
  }
  return pgParse(url);
}

/** What we read at all: a postgres:// or postgresql:// URL, a socket: URL, or a socket path. */
const POSTGRES_URL = /^(?:postgres(?:ql)?:\/\/|socket:|\/)/i;

/**
 * The host node-postgres would connect to for this connection string: its
 * own parse (a `host` query parameter wins over the URL's host, a socket
 * comes back as its path), then, as ConnectionParameters does, PGHOST when
 * that is empty, then localhost. Null when the string isn't a Postgres URL
 * or can't be parsed, which the caller refuses. Other schemes are never read:
 * pg would connect on them too, and nothing local needs one.
 */
export function databaseHost(url: string, env: Env): string | null {
  if (!POSTGRES_URL.test(url)) return null;
  let parsed: { host?: string | null };
  try {
    parsed = parseAsPg(url);
  } catch {
    return null;
  }
  let host = typeof parsed.host === "string" ? parsed.host : "";
  if (!host) host = env.PGHOST || "localhost";
  host = host.toLowerCase();
  // The URL parser keeps IPv6 brackets; node-postgres is handed the address.
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host;
}

/**
 * Null when the database is on this machine; otherwise why it is refused.
 * Names the host, never the URL (which carries the password).
 */
export function localDatabaseProblem(url: string, env: Env): string | null {
  const host = databaseHost(url, env);
  if (host != null && LOCAL_DATABASE_HOSTS.includes(host)) return null;
  return (
    `Refusing DATABASE_URL: ${
      host == null ? "its host can't be read (only a postgres:// or postgresql:// URL is read)" : `its host is ${host}`
    }. ` +
    `Off Render the database must be on this machine (${LOCAL_DATABASE_HOSTS.join(", ")}), ` +
    "so that nothing here can reach production. Use the local copy (allied_dev on localhost; " +
    "see CLAUDE.md in the folder above this repository)."
  );
}

/** SYNC_INTERVAL_HOURS as read on Render; always 0 (no scheduled sync) anywhere else. */
export function syncIntervalHoursFor(raw: string | undefined, onRender: boolean): number {
  return onRender ? Number(raw || 0) : 0;
}

/** Both MYOB credentials are set and, being on Render, may be used. */
export function myobCredentialsUsable(env: Env, onRender: boolean): boolean {
  return onRender && Boolean(env.MYOB_API_KEY?.trim() && env.MYOB_API_SECRET?.trim());
}
