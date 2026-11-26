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
 */

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

/**
 * The host node-postgres would connect to for this connection string, read
 * the way it reads it (pg-connection-string's parse, then
 * ConnectionParameters): a `host` query parameter wins over the URL's host
 * (the last one, if repeated), and an empty host falls back to PGHOST, then
 * localhost. A Unix socket comes back as its path. Null when the string can't
 * be read or isn't a postgres:// / postgresql:// URL, which the caller refuses.
 */
export function databaseHost(url: string, env: Env): string | null {
  if (url.startsWith("/")) return url.split(" ")[0];
  let parsed: URL;
  let emptyHost = false;
  try {
    parsed = new URL(url);
  } catch {
    // pg-connection-string's own retry for a URL with no host ("postgres://user@/db").
    try {
      parsed = new URL(url.replace("@/", "@___DUMMY___/"));
      emptyHost = true;
    } catch {
      return null;
    }
  }
  if (parsed.protocol === "socket:") return decodeURI(parsed.pathname) || null;
  // Only Postgres URLs. For http(s)/ws/ftp/file the URL parser reads "\" as "/",
  // while pg-connection-string may encode it first, so the two can disagree on
  // the host ("https://localhost\@db.invalid/…"): refuse rather than guess.
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return null;
  const fromQuery = parsed.searchParams.getAll("host").at(-1);
  let host: string;
  try {
    host = fromQuery || (emptyHost ? "" : decodeURIComponent(parsed.hostname));
  } catch {
    return null;
  }
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
