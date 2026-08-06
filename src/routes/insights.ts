import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { hasDatabaseUrl } from "../db.js";
import {
  addUserBom,
  dataStatus,
  invalidateItemsCache,
  itemDetail,
  listItems,
  overview,
  productsList,
  purchasing,
  purchasingCsv,
  relationships,
  removeUserBom,
} from "../insights/queries.js";
import { getSyncStatus, isSyncRunning, runSync } from "../sync/engine.js";

export const insightsRouter = Router();

/**
 * Shared-key guard for dashboard APIs. When DASHBOARD_ACCESS_KEY is unset the
 * guard is a no-op (local development). The connection console and its
 * existing routes are intentionally not touched by this.
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
  if (provided === key) {
    next();
    return;
  }
  res.status(401).json({ error: "Dashboard access key required." });
}

function requireDb(res: Response): boolean {
  if (!hasDatabaseUrl()) {
    res.status(503).json({
      error:
        "DATABASE_URL is not configured. The dashboard needs Postgres for synced MYOB data.",
    });
    return false;
  }
  return true;
}

function send500(res: Response, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}

insightsRouter.use(dashboardGuard);

// ---- Sync control (read-only toward MYOB; writes only to our Postgres) ----

insightsRouter.post("/sync/run", async (req, res) => {
  if (!requireDb(res)) return;
  const mode = req.body?.mode === "full" ? "full" : "incremental";
  if (isSyncRunning()) {
    res.status(409).json({ error: "A sync is already running." });
    return;
  }
  // Fire and forget: sync can take minutes on first run, longer than proxies allow.
  runSync(mode, "dashboard")
    .then(() => invalidateItemsCache())
    .catch((err) => console.error("Sync failed:", err));
  res.status(202).json({ started: true, mode });
});

insightsRouter.get("/sync/status", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await getSyncStatus());
  } catch (err) {
    send500(res, err);
  }
});

// ---- Insights ----

insightsRouter.get("/overview", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await overview());
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/items", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(
      await listItems({
        q: typeof req.query.q === "string" ? req.query.q : undefined,
        filter: typeof req.query.filter === "string" ? req.query.filter : undefined,
        sort: typeof req.query.sort === "string" ? req.query.sort : undefined,
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 50,
      }),
    );
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/items/:uid", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const detail = await itemDetail(req.params.uid);
    if (!detail) {
      res.status(404).json({ error: "Item not found in synced data." });
      return;
    }
    res.json(detail);
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/relationships/:uid", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await relationships(req.params.uid));
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/products", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(
      await productsList({
        q: typeof req.query.q === "string" ? req.query.q : undefined,
        page: Number(req.query.page) || 1,
      }),
    );
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/purchasing", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await purchasing());
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/purchasing.csv", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    const data = await purchasing();
    res
      .type("text/csv")
      .set(
        "Content-Disposition",
        `attachment; filename="allied-purchasing-${new Date().toISOString().slice(0, 10)}.csv"`,
      )
      .send(purchasingCsv(data));
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/data", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await dataStatus());
  } catch (err) {
    send500(res, err);
  }
});

// ---- User-provided relationships (platform data, never written to MYOB) ----

insightsRouter.post("/bom", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { parentUid, componentUid, qtyPer } = req.body ?? {};
    if (!parentUid || !componentUid) {
      res.status(400).json({ error: "parentUid and componentUid are required." });
      return;
    }
    await addUserBom(String(parentUid), String(componentUid), Number(qtyPer));
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

insightsRouter.delete("/bom", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const parentUid = String(req.query.parentUid ?? "");
    const componentUid = String(req.query.componentUid ?? "");
    if (!parentUid || !componentUid) {
      res.status(400).json({ error: "parentUid and componentUid are required." });
      return;
    }
    await removeUserBom(parentUid, componentUid);
    res.json({ ok: true });
  } catch (err) {
    send500(res, err);
  }
});
