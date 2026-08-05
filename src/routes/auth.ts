import { Router } from "express";
import { hasMyobCredentials } from "../config.js";
import { buildAuthorizeUrl, exchangeCodeForTokens } from "../myob/auth.js";
import { getCompanyInfo } from "../myob/client.js";
import {
  clearAllConnections,
  loadStore,
  removeConnection,
  setActiveBusinessId,
  storageBackend,
  upsertConnection,
} from "../store/connections.js";

export const authRouter = Router();

authRouter.get("/status", async (_req, res) => {
  const store = await loadStore();
  res.json({
    configured: hasMyobCredentials(),
    storage: storageBackend(),
    connections: store.connections.map((c) => ({
      businessId: c.businessId,
      displayName: c.displayName,
      connectedAt: c.connectedAt,
      username: c.tokens.username,
      scope: c.tokens.scope,
      tokenExpiresAt: new Date(c.tokens.expiresAt).toISOString(),
    })),
    activeBusinessId: store.activeBusinessId ?? store.connections[0]?.businessId,
  });
});

authRouter.get("/login", (req, res) => {
  if (!hasMyobCredentials()) {
    res.status(503).json({
      error:
        "MYOB credentials not configured. Copy .env.example to .env and set MYOB_API_KEY / MYOB_API_SECRET.",
    });
    return;
  }

  const state =
    typeof req.query.state === "string" ? req.query.state : crypto.randomUUID();
  const url = buildAuthorizeUrl(state);
  res.redirect(url);
});

authRouter.get("/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : undefined;
  const businessId =
    typeof req.query.businessId === "string"
      ? req.query.businessId
      : typeof req.query.businessid === "string"
        ? req.query.businessid
        : undefined;
  const error =
    typeof req.query.error === "string" ? req.query.error : undefined;
  const errorDescription =
    typeof req.query.error_description === "string"
      ? req.query.error_description
      : undefined;

  if (error) {
    res.status(400).send(renderResultPage(false, errorDescription || error));
    return;
  }

  if (!code) {
    res.status(400).send(renderResultPage(false, "Missing OAuth code in callback."));
    return;
  }

  if (!businessId) {
    res
      .status(400)
      .send(
        renderResultPage(
          false,
          "Missing businessId in callback. Ensure prompt=consent is used and an Administrator authorises the company file.",
        ),
      );
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    let displayName: string | undefined;
    try {
      const info = await getCompanyInfo({
        businessId,
        connectedAt: new Date().toISOString(),
        tokens,
      });
      displayName =
        (info.Name as string | undefined) ||
        (info.CompanyName as string | undefined);
    } catch {
      // Company metadata fetch is best-effort; tokens still saved.
    }

    await upsertConnection(businessId, tokens, displayName);
    res.redirect("/?connected=1");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).send(renderResultPage(false, message));
  }
});

authRouter.post("/active", async (req, res) => {
  const businessId = req.body?.businessId as string | undefined;
  if (!businessId) {
    res.status(400).json({ error: "businessId is required" });
    return;
  }
  try {
    await setActiveBusinessId(businessId);
    res.json({ ok: true, activeBusinessId: businessId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: message });
  }
});

authRouter.delete("/connections/:businessId", async (req, res) => {
  await removeConnection(req.params.businessId);
  res.json({ ok: true });
});

authRouter.post("/logout", async (_req, res) => {
  await clearAllConnections();
  res.json({ ok: true });
});

function renderResultPage(ok: boolean, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>MYOB Auth ${ok ? "OK" : "Error"}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <main class="wrap">
    <h1>${ok ? "Connected" : "Authentication failed"}</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/">Back to connection console</a></p>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
