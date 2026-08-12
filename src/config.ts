import "dotenv/config";
import path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Copy .env.example to .env and fill in MYOB credentials.`,
    );
  }
  return value;
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
    apiKey: () => required("MYOB_API_KEY"),
    apiSecret: () => required("MYOB_API_SECRET"),
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
    /** How far back transactional history is mirrored on a full sync. */
    syncWindowDays: Number(process.env.SYNC_WINDOW_DAYS || 365),
    /** Stock-cover target used by purchasing suggestions. */
    targetCoverWeeks: Number(process.env.TARGET_COVER_WEEKS || 8),
    /** Optional auto-refresh interval (hours). 0 disables. */
    syncIntervalHours: Number(process.env.SYNC_INTERVAL_HOURS || 0),
    /** Cover beyond which stock counts as excess. */
    excessCoverWeeks: Number(process.env.EXCESS_COVER_WEEKS || 26),
    /** Ignore excess worth less than this (NZD) to avoid noise. */
    excessMinValue: Number(process.env.EXCESS_MIN_VALUE || 250),
    /** Optional shared access key protecting dashboard APIs. */
    dashboardAccessKey: optional("DASHBOARD_ACCESS_KEY"),
  },
};

export function hasMyobCredentials(): boolean {
  return Boolean(
    process.env.MYOB_API_KEY?.trim() && process.env.MYOB_API_SECRET?.trim(),
  );
}
