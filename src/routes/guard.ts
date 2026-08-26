import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";

/**
 * Shared-key guard for every non-public route.
 *
 * This used to live in insights.ts and was mounted only on `/api/insights`,
 * which left `/api` and `/auth` open to the internet: live MYOB inventory
 * through the item proxy, the OAuth connection and its scopes through
 * `/auth/status`, and — worst — `POST /auth/logout`, which runs
 * `DELETE FROM connections` and severs Allied's MYOB link for anyone who found
 * the URL. It is now mounted on all three, with two deliberate exceptions
 * listed in index.ts.
 *
 * The key may arrive as a header or a query parameter. The query form exists
 * because links and CSV downloads cannot set headers; the dashboard strips it
 * from the address bar as soon as it has stored it.
 *
 * When DASHBOARD_ACCESS_KEY is unset the guard is a no-op, which is what makes
 * local development against a scratch database painless.
 */
export function dashboardGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const key = config.insights.dashboardAccessKey;
  if (!key) {
    next();
    return;
  }
  const provided =
    req.get("x-dashboard-key") ||
    (typeof req.query.key === "string" ? req.query.key : undefined);
  if (provided && timingSafeEqual(provided, key)) {
    next();
    return;
  }
  res.status(401).json({ error: "Dashboard access key required." });
}

/**
 * Compare without leaking the answer through how long it took.
 *
 * `===` on strings returns at the first differing byte, so response time is a
 * (noisy, but real) oracle for how much of the key a guess got right. Hashing
 * both sides first keeps the compared buffers equal-length, so a wrong length
 * cannot short-circuit either.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
