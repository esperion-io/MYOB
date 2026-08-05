import { Router } from "express";
import {
  getCompanyInfo,
  listInventoryItems,
  listInventoryLocations,
  MyobApiError,
  probeEndpoints,
} from "../myob/client.js";
import { getActiveConnection, loadStore } from "../store/connections.js";

export const apiRouter = Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ ok: true });
});

apiRouter.get("/company", async (_req, res) => {
  try {
    const connection = await getActiveConnection();
    if (!connection) {
      res.status(401).json({ error: "No MYOB company connected" });
      return;
    }
    const info = await getCompanyInfo(connection);
    res.json({ businessId: connection.businessId, company: info });
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/companies", async (_req, res) => {
  const store = await loadStore();
  res.json({
    activeBusinessId: store.activeBusinessId,
    companies: store.connections.map((c) => ({
      businessId: c.businessId,
      displayName: c.displayName,
      username: c.tokens.username,
      connectedAt: c.connectedAt,
    })),
  });
});

apiRouter.get("/connection/probe", async (_req, res) => {
  try {
    const connection = await getActiveConnection();
    if (!connection) {
      res.status(401).json({ error: "No MYOB company connected" });
      return;
    }
    const report = await probeEndpoints(connection);
    const groups = ["Contact", "Sale", "Purchase", "Inventory"].map((group) => {
      const items = report.results.filter((r) => r.group === group);
      const okCount = items.filter((r) => r.ok).length;
      return {
        group,
        ok: okCount === items.length,
        okCount,
        total: items.length,
        endpoints: items,
      };
    });
    res.json({
      businessId: report.businessId,
      probedAt: report.probedAt,
      summary: {
        ok: groups.every((g) => g.ok),
        okCount: report.results.filter((r) => r.ok).length,
        total: report.results.length,
      },
      groups,
      results: report.results,
    });
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/inventory/items", async (req, res) => {
  try {
    const top = parsePositiveInt(req.query.top, 50);
    const skip = parsePositiveInt(req.query.skip, 0);
    const filter =
      typeof req.query.filter === "string" ? req.query.filter : undefined;

    const connection = await getActiveConnection();
    if (!connection) {
      res.status(401).json({ error: "No MYOB company connected" });
      return;
    }

    const page = await listInventoryItems({ top, skip, filter, connection });
    const items = (page.Items ?? []).map((item) => ({
      uid: item.UID,
      number: item.Number ?? null,
      name: item.Name ?? null,
      description: item.Description ?? null,
      isActive: item.IsActive ?? null,
      isInventoried: item.IsInventoried ?? null,
      quantityOnHand: item.QuantityOnHand ?? null,
      quantityAvailable: item.QuantityAvailable ?? null,
      quantityCommitted: item.QuantityCommitted ?? null,
      quantityOnOrder: item.QuantityOnOrder ?? null,
      averageCost: item.AverageCost ?? null,
      currentValue: item.CurrentValue ?? null,
      baseSellingPrice: item.BaseSellingPrice ?? null,
      lastModified: item.LastModified ?? null,
    }));

    res.json({
      businessId: connection.businessId,
      count: page.Count ?? items.length,
      nextPageLink: page.NextPageLink ?? null,
      items,
    });
  } catch (err) {
    sendError(res, err);
  }
});

apiRouter.get("/inventory/locations", async (_req, res) => {
  try {
    const connection = await getActiveConnection();
    if (!connection) {
      res.status(401).json({ error: "No MYOB company connected" });
      return;
    }
    const page = await listInventoryLocations(connection);
    res.json({
      businessId: connection.businessId,
      locations: page.Items ?? [],
      count: page.Count ?? page.Items?.length ?? 0,
    });
  } catch (err) {
    sendError(res, err);
  }
});

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sendError(res: import("express").Response, err: unknown): void {
  if (err instanceof MyobApiError) {
    res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
      error: err.message,
      myob: err.body,
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  const status = message.includes("No MYOB company connected") ? 401 : 500;
  res.status(status).json({ error: message });
}
