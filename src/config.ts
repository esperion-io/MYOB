import dotenv from "dotenv";
import path from "node:path";
import {
  isRender,
  MYOB_OFF_HERE,
  myobCredentialsUsable,
  syncIntervalHoursFor,
} from "./localGuard.js";

/*
 * Are we on Render? Read from the real environment BEFORE .env is loaded, so
 * a .env file can never claim to be Render and switch off the guards below
 * (localGuard.ts). Render sets RENDER=true itself; there is no .env there.
 */
export const onRender = isRender(process.env);

dotenv.config();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Set it on the Render service (Environment), then redeploy.`,
    );
  }
  return value;
}

/** Off Render the MYOB key and secret do not exist, whatever the environment says. */
function myobCredential(name: string): string {
  if (!onRender) throw new Error(MYOB_OFF_HERE);
  return required(name);
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  appBaseUrl: process.env.APP_BASE_URL?.trim() || "http://localhost:3000",
  /** Railway Postgres connection string. When set, tokens persist in the DB. */
  databaseUrl: optional("DATABASE_URL"),
  /**
   * Optional AES key material for encrypting tokens at rest in Postgres.
   * Generate with: openssl rand -base64 32
   */
  tokenEncryptionKey: optional("TOKEN_ENCRYPTION_KEY"),
  myob: {
    apiKey: () => myobCredential("MYOB_API_KEY"),
    apiSecret: () => myobCredential("MYOB_API_SECRET"),
    redirectUri: () =>
      optional("MYOB_REDIRECT_URI") ||
      `${process.env.APP_BASE_URL?.trim() || "http://localhost:3000"}/auth/callback`,
    scopes:
      optional("MYOB_SCOPES") ||
      "sme-company-file sme-contacts-customer sme-contacts-supplier sme-contacts-employee sme-contacts-personal sme-sales sme-purchases sme-inventory",
    apiBaseUrl:
      optional("MYOB_API_BASE_URL") ||
      "https://arl2.api.myob.com/accountright",
    authorizeUrl: "https://secure.myob.com/oauth2/account/authorize",
    tokenUrl: "https://secure.myob.com/oauth2/v1/authorize",
    cfUsername: optional("MYOB_CF_USERNAME"),
    cfPassword: optional("MYOB_CF_PASSWORD"),
  },
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR || ".data"),
  insights: {
    /**
     * How far back transactional history is mirrored on a full sync.
     * Superseded by SYNC_SINCE when that is set.
     */
    syncWindowDays: Number(process.env.SYNC_WINDOW_DAYS || 365),
    /**
     * Absolute earliest transaction date to mirror (ISO yyyy-mm-dd). Pins the
     * history floor, taking precedence over the rolling syncWindowDays window,
     * so it cannot creep forward and silently drop the runway the as-at stock
     * ledger needs. Two years is already loaded for Allied.
     */
    syncSince: optional("SYNC_SINCE") || "2024-07-01",
    /** Stock-cover target used by purchasing suggestions. */
    targetCoverWeeks: Number(process.env.TARGET_COVER_WEEKS || 8),
    /** Optional auto-refresh interval (hours). 0 disables. Always 0 off Render. */
    syncIntervalHours: syncIntervalHoursFor(process.env.SYNC_INTERVAL_HOURS, onRender),
    /*
     * The run that closes each business day, as HH:MM in Allied's timezone.
     *
     * A daily position row freezes in whatever state the last sync of its NZ
     * day left it in, so this time decides how much of the trading day the
     * permanent record captures. The whole schedule is counted backwards from
     * here in SYNC_INTERVAL_HOURS steps, which keeps it fixed across deploys
     * instead of drifting with process start.
     *
     * 23:45 leaves the day essentially complete while staying clear of
     * midnight, where an overrun would land the snapshot on the wrong date.
     */
    syncCloseTime: optional("SYNC_CLOSE_TIME") || "23:45",
    /*
     * Remove records MYOB no longer sends (1.16, sync/reconcile.ts). Set
     * SYNC_REMOVE_DELETED=off (or 0 / false) on Render to make the check
     * report only: it still lists what is missing on Data & Sync, removes
     * nothing, and leaves no list for a later sync to confirm. The lever for
     * a list nobody expected, without a code release.
     */
    removeDeleted: !/^(0|false|off|no)$/i.test(process.env.SYNC_REMOVE_DELETED ?? ""),
    /** Cover beyond which stock counts as excess. */
    excessCoverWeeks: Number(process.env.EXCESS_COVER_WEEKS || 26),
    /** Ignore excess worth less than this (NZD) to avoid noise. */
    excessMinValue: Number(process.env.EXCESS_MIN_VALUE || 250),
    /**
     * Allied is a New Zealand business: their month-end is a New Zealand
     * calendar date, and MYOB stores transaction dates in local terms. The
     * server and database both run in UTC, which is 12-13 hours behind, so any
     * date derived from UTC is wrong for a chunk of every day. Every calendar
     * date the platform produces — snapshot dates, "today", as-at defaults — is
     * resolved in this zone instead.
     */
    businessTimeZone: optional("BUSINESS_TIMEZONE") || "Pacific/Auckland",
    /** Optional shared access key protecting dashboard APIs. */
    dashboardAccessKey: optional("DASHBOARD_ACCESS_KEY"),
  },
};

/** Both MYOB credentials are set and usable: never off Render. */
export function hasMyobCredentials(): boolean {
  return myobCredentialsUsable(process.env, onRender);
}
