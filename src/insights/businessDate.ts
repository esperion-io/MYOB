import { config } from "../config.js";

/**
 * Calendar dates in Allied's own timezone.
 *
 * A stock position is dated by the business's calendar, not the server's. The
 * app and database both run in UTC; New Zealand is 12-13 hours ahead, so
 * `new Date().toISOString().slice(0, 10)` names yesterday for roughly half of
 * every New Zealand day.
 *
 * This was not theoretical: the daily snapshot written at 18:21 UTC on 19 Aug
 * 2026 was stored as "2026-08-19" when it was already 06:21 on 20 August in
 * Auckland. For a month-end valuation, that off-by-one is exactly the kind of
 * error that costs trust.
 */
export function businessToday(): string {
  return businessDateOf(new Date());
}

/** The calendar date an instant falls on, in the business timezone. */
export function businessDateOf(at: Date): string {
  // en-CA renders ISO-style yyyy-mm-dd, so no manual part assembly is needed.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.insights.businessTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** SQL fragment for "today" in the business timezone, for use in views. */
export const BUSINESS_TODAY_SQL = `((NOW() AT TIME ZONE '${
  config.insights.businessTimeZone
}')::date)`;
