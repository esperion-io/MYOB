import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, hasMyobCredentials } from "./config.js";
import { ensureSchema, hasDatabaseUrl } from "./db.js";
import { apiRouter } from "./routes/api.js";
import { authRouter } from "./routes/auth.js";
import { insightsRouter } from "./routes/insights.js";
import { storageBackend } from "./store/connections.js";
import { ensureInsightsSchema } from "./sync/schema.js";
import { isSyncRunning, runSync } from "./sync/engine.js";

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

  app.use("/auth", authRouter);
  app.use("/api/insights", insightsRouter);
  app.use("/api", apiRouter);

  app.get("/dashboard", (_req, res) => {
    res.sendFile(path.join(publicDir, "dashboard.html"));
  });

  // Optional scheduled refresh (only effective while the instance is awake).
  const intervalHours = config.insights.syncIntervalHours;
  if (hasDatabaseUrl() && intervalHours > 0) {
    setInterval(
      () => {
        if (!isSyncRunning()) {
          runSync("incremental", "schedule").catch((err) =>
            console.error("Scheduled sync failed:", err),
          );
        }
      },
      intervalHours * 60 * 60 * 1000,
    );
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
