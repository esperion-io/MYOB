import { businessToday } from "../insights/businessDate.js";
import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { hasDatabaseUrl } from "../db.js";
import {
  addUserBom,
  bomBlindspots,
  bomImport,
  dataStatus,
  invalidateItemsCache,
  itemDetail,
  itemSuppliers,
  listItems,
  overview,
  productsList,
  purchasing,
  purchasingCsv,
  relationships,
  removeItemSupplier,
  removeUserBom,
  setItemSupplier,
  setSupplierMeta,
  supplierOptions,
  suppliersList,
} from "../insights/queries.js";
import { getSyncStatus, isSyncRunning, runSync } from "../sync/engine.js";
import {
  anchorCoverage,
  confirmStocktake,
  itemLedger,
  divergenceReport,
  importCounts,
  positionExport,
  ownedPositions,
  recordManualCount,
  snapshotDates,
  snapshotPositions,
  stocktakeCandidates,
} from "../insights/ledger.js";

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


/**
 * The two P3 controls, read from the query string.
 *
 * They are deliberately separate: `asAt` is a moment (what was physically on
 * the shelf that day) and `window` is a period (what sold over it). Conflating
 * them produces figures that reconcile to nothing.
 */
function windowParams(req: Request): {
  asAt?: string;
  windowMonths?: number;
  longMonths?: number;
} {
  return {
    asAt:
      typeof req.query.asAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asAt)
        ? req.query.asAt
        : undefined,
    windowMonths: req.query.windowMonths ? Number(req.query.windowMonths) : undefined,
    longMonths: req.query.longMonths ? Number(req.query.longMonths) : undefined,
  };
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

insightsRouter.get("/overview", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await overview(windowParams(req)));
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
        region: typeof req.query.region === "string" ? req.query.region : undefined,
        sort: typeof req.query.sort === "string" ? req.query.sort : undefined,
        dir: typeof req.query.dir === "string" ? req.query.dir : undefined,
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 50,
        ...windowParams(req),
      }),
    );
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/items/:uid", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const detail = await itemDetail(req.params.uid, windowParams(req));
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

insightsRouter.get("/purchasing", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await purchasing(windowParams(req)));
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
        `attachment; filename="allied-purchasing-${businessToday()}.csv"`,
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

// ---- Suppliers (MYOB facts + platform region/lead-time/notes labels) ----

insightsRouter.get("/suppliers", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(
      await suppliersList({
        q: typeof req.query.q === "string" ? req.query.q : undefined,
      }),
    );
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.get("/supplier-options", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await supplierOptions(typeof req.query.q === "string" ? req.query.q : undefined));
  } catch (err) {
    send500(res, err);
  }
});

// ---- Which suppliers an item can be bought from (platform data) ----

insightsRouter.get("/items/:uid/suppliers", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const data = await itemSuppliers(req.params.uid);
    if (!data) {
      res.status(404).json({ error: "Item not found in synced data." });
      return;
    }
    res.json(data);
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.post("/items/:uid/suppliers", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { supplierUid, isPreferred, supplierItemNumber, notes } = req.body ?? {};
    if (!supplierUid) {
      res.status(400).json({ error: "supplierUid is required." });
      return;
    }
    await setItemSupplier(req.params.uid, String(supplierUid), {
      isPreferred: isPreferred === undefined ? undefined : isPreferred === true,
      supplierItemNumber:
        supplierItemNumber === undefined
          ? undefined
          : supplierItemNumber === null
            ? null
            : String(supplierItemNumber),
      notes: notes === undefined ? undefined : notes === null ? null : String(notes),
    });
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

insightsRouter.delete("/items/:uid/suppliers", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const supplierUid = String(req.query.supplierUid ?? "");
    if (!supplierUid) {
      res.status(400).json({ error: "supplierUid is required." });
      return;
    }
    await removeItemSupplier(req.params.uid, supplierUid);
    res.json({ ok: true });
  } catch (err) {
    send500(res, err);
  }
});

insightsRouter.post("/suppliers/meta", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { supplierUid, region, leadTimeDays, notes } = req.body ?? {};
    if (!supplierUid) {
      res.status(400).json({ error: "supplierUid is required." });
      return;
    }
    await setSupplierMeta(String(supplierUid), {
      region: region === undefined ? undefined : region === null ? "" : String(region),
      leadTimeDays:
        leadTimeDays === undefined ? undefined : leadTimeDays === null ? null : Number(leadTimeDays),
      notes: notes === undefined ? undefined : notes === null ? null : String(notes),
    });
    res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
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

/**
 * Bulk import of Allied-provided relationships. `commit: false` (the default)
 * validates and returns exactly what a commit would do, row by row, so staff
 * can review before anything is written. Platform data only.
 */
insightsRouter.post("/bom/import", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const body = req.body ?? {};
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows) {
      res.status(400).json({ error: "rows[] is required." });
      return;
    }
    const parsed = rows.map((r: Record<string, unknown>) => ({
      parent: String(r?.parent ?? ""),
      component: String(r?.component ?? ""),
      qtyPer: Number(r?.qtyPer),
    }));
    res.json(await bomImport(parsed, body.commit === true));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

insightsRouter.get("/bom/blindspots", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await bomBlindspots());
  } catch (err) {
    send500(res, err);
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

// ---- P1: stocktake-anchored stock ledger --------------------------------

/** Adjustments that look like physical counts, for Allied to confirm or reject. */
insightsRouter.get("/stocktakes", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json({
      candidates: await stocktakeCandidates(),
      coverage: await anchorCoverage(),
    });
  } catch (err) {
    send500(res, err);
  }
});

/**
 * Record Allied's decision on one candidate. Detection only proposes — memo
 * wording is too inconsistent for a regex to define an anchor on its own.
 */
insightsRouter.post("/stocktakes/:uid/confirm", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const isStocktake = req.body?.isStocktake;
    if (typeof isStocktake !== "boolean") {
      res.status(400).json({ error: "isStocktake (boolean) is required." });
      return;
    }
    const result = await confirmStocktake({
      adjustmentUid: req.params.uid,
      isStocktake,
      confirmedBy: typeof req.body?.confirmedBy === "string" ? req.body.confirmedBy : null,
      note: typeof req.body?.note === "string" ? req.body.note : null,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    send500(res, err);
  }
});

/** On-hand for every item as at a date, from the anchored ledger. */
insightsRouter.get("/positions", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const asAt = typeof req.query.asAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asAt)
      ? req.query.asAt
      : businessToday();
    const positions = await ownedPositions(asAt);
    res.json({
      asAt,
      counted: positions.filter((p) => p.basis === "counted").length,
      fromOpeningBalance: positions.filter((p) => p.basis === "reconstructed").length,
      committedDiffersFromMyob: positions.filter(
        (p) => Math.abs(p.committed - (p.myobCommitted ?? 0)) > 0.001,
      ).length,
      onHandDivergesFromMyob: positions.filter(
        (p) => p.divergence != null && Math.abs(p.divergence) > 0.001,
      ).length,
      positions,
    });
  } catch (err) {
    send500(res, err);
  }
});

/** The audit trail behind one item's figure: anchor, then every movement since. */
insightsRouter.get("/ledger/:uid", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const asAt = typeof req.query.asAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asAt)
      ? req.query.asAt
      : undefined;
    res.json(await itemLedger(req.params.uid, asAt));
  } catch (err) {
    send500(res, err);
  }
});

/** Dates for which a stored position snapshot exists — the historical trail. */
insightsRouter.get("/snapshots", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json({ snapshots: await snapshotDates() });
  } catch (err) {
    send500(res, err);
  }
});

/** Force a snapshot for today. Normally the sync does this automatically. */
insightsRouter.post("/snapshots", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await snapshotPositions({ overwrite: req.body?.overwrite === true }));
  } catch (err) {
    send500(res, err);
  }
});

/** Record a physical count Allied performed — this is what diverges us from MYOB. */
insightsRouter.post("/counts", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { itemUid, countDate, countedQty } = req.body ?? {};
    if (typeof itemUid !== "string" || !itemUid) {
      res.status(400).json({ error: "itemUid is required." });
      return;
    }
    if (typeof countedQty !== "number" || !Number.isFinite(countedQty) || countedQty < 0) {
      res.status(400).json({ error: "countedQty must be a number of zero or more." });
      return;
    }
    if (typeof countDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(countDate)) {
      res.status(400).json({ error: "countDate must be yyyy-mm-dd." });
      return;
    }
    res.json(
      await recordManualCount({
        itemUid,
        countDate,
        countedQty,
        enteredBy: typeof req.body?.enteredBy === "string" ? req.body.enteredBy : null,
        note: typeof req.body?.note === "string" ? req.body.note : null,
      }),
    );
  } catch (err) {
    send500(res, err);
  }
});

/** Bulk count entry. Send dryRun to validate a pasted sheet before committing. */
insightsRouter.post("/counts/import", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) {
      res.status(400).json({ error: "rows[] is required." });
      return;
    }
    const countDate =
      typeof req.body?.countDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.body.countDate)
        ? req.body.countDate
        : businessToday();
    res.json(
      await importCounts({
        rows,
        countDate,
        enteredBy: typeof req.body?.enteredBy === "string" ? req.body.enteredBy : null,
        dryRun: req.body?.dryRun === true,
      }),
    );
  } catch (err) {
    send500(res, err);
  }
});

/** Items where our figures disagree with MYOB's, ranked by what it is worth. */
insightsRouter.get("/divergence", async (_req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json(await divergenceReport());
  } catch (err) {
    send500(res, err);
  }
});

/** The as-at stock position as a spreadsheet — the month-end deliverable. */
insightsRouter.get("/positions.csv", async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const asAt =
      typeof req.query.asAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.asAt)
        ? req.query.asAt
        : undefined;
    const out = await positionExport(asAt);
    res
      .type("text/csv; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${out.filename}"`)
      .send(out.csv);
  } catch (err) {
    send500(res, err);
  }
});
