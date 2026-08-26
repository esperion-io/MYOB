import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, hasMyobCredentials } from "./config.js";
import { ensureSchema, hasDatabaseUrl } from "./db.js";
import { apiRouter } from "./routes/api.js";
import { authRouter } from "./routes/auth.js";
import { dashboardGuard } from "./routes/guard.js";
import { insightsRouter } from "./routes/insights.js";
import { storageBackend } from "./store/connections.js";
import { ensureInsightsSchema } from "./sync/schema.js";
import { isSyncRunning, lastSyncedAt, runSync } from "./sync/engine.js";
import {
  msUntilNextRun,
  scheduleDescription,
  shouldSyncOnBoot,
} from "./sync/schedule.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");

async function main() {
  if (hasDatabaseUrl()) {
    await ensureSchema();
    await ensureInsightsSchema();
  }

  const app = express();

  app.use(express.json());
  app.use(express.static(publicDir));

  /*
   * Everything behind the shared key, with exactly two exceptions.
   *
   * `/api/health` stays open so uptime checks do not need a secret, and it
   * returns nothing but `{ok:true}`.
   *
   * `/auth/callback` stays open because it cannot be anything else: MYOB
   * redirects the operator's browser there and will not attach our header. It
   * is protected instead by the one-time `state` that `/auth/login` mints —
   * and `/auth/login` IS behind the key, so a callback cannot be driven by
   * anyone who has not already authenticated here. That matters more than it
   * looks: `upsertConnection` marks the company file it just saved as the
   * active one, so an unauthenticated callback let anybody who completed an
   * OAuth round trip against their own MYOB file take over the dashboard.
   */
  const openPaths: Record<string, string> = {
    "/api": "/health",
    "/auth": "/callback",
  };
  for (const [mount, open] of Object.entries(openPaths)) {
    app.use(mount, (req, res, next) => {
      if (req.path === open) {
        next();
        return;
      }
      dashboardGuard(req, res, next);
    });
  }

  app.use("/auth", authRouter);
  app.use("/api/insights", insightsRouter);
  app.use("/api", apiRouter);

  app.get("/dashboard", (_req, res) => {
    res.sendFile(path.join(publicDir, "dashboard.html"));
  });

  /*
   * Scheduled refresh, pinned to Allied's clock.
   *
   * Each run re-arms from the real NZ wall clock rather than repeating a fixed
   * interval, so the times survive deploys and DST alike. See schedule.ts for
   * why the day-closing run is the one that matters.
   */
  const intervalHours = config.insights.syncIntervalHours;
  if (hasDatabaseUrl() && intervalHours > 0) {
    const fire = (trigger: string): void => {
      if (isSyncRunning()) return;
      runSync("incremental", trigger).catch((err) =>
        console.error(`Sync (${trigger}) failed:`, err),
      );
    };

    const arm = (): void => {
      const wait = msUntilNextRun();
      setTimeout(() => {
        fire("schedule");
        arm();
      }, wait).unref?.();
      console.log(
        `Next sync in ${Math.round(wait / 60000)} min · schedule ${scheduleDescription()}`,
      );
    };
    arm();

    /*
     * A deploy used to leave the data untouched for a full interval, because
     * nothing ran at startup and the timer began from zero. Catch up if the
     * last sync is already older than one interval.
     */
    void (async () => {
      try {
        const last = await lastSyncedAt();
        if (shouldSyncOnBoot(last)) fire("boot-catchup");
      } catch (err) {
        console.error("Boot catch-up check failed:", err);
      }
    })();
  }

  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api") || req.path.startsWith("/auth")) {
      next();
      return;
    }
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.listen(config.port, () => {
    const configured = hasMyobCredentials();
    console.log(`MYOB inventory app listening on ${config.appBaseUrl}`);
    console.log(`Connection store: ${storageBackend()}`);
    console.log(
      configured
        ? "MYOB credentials detected — visit /auth/login to connect a company file."
        : "MYOB credentials missing — copy .env.example to .env and add your API key/secret.",
    );
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
