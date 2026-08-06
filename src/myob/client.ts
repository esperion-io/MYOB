import { config } from "../config.js";
import {
  getActiveConnection,
  updateTokens,
} from "../store/connections.js";
import { companyFileTokenHeader, refreshAccessToken } from "./auth.js";
import type {
  CompanyConnection,
  MyobInventoryItem,
  MyobPagedResponse,
} from "./types.js";

export class MyobApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "MyobApiError";
    this.status = status;
    this.body = body;
  }
}

async function ensureFreshTokens(
  connection: CompanyConnection,
): Promise<CompanyConnection> {
  if (connection.tokens.expiresAt > Date.now()) {
    return connection;
  }

  const refreshed = await refreshAccessToken(connection.tokens.refreshToken);
  await updateTokens(connection.businessId, refreshed);
  return { ...connection, tokens: refreshed };
}

function buildHeaders(accessToken: string): HeadersInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "x-myobapi-key": config.myob.apiKey(),
    "x-myobapi-version": "v2",
    Accept: "application/json",
  };

  const cfToken = companyFileTokenHeader();
  if (cfToken) {
    headers["x-myobapi-cftoken"] = cfToken;
  }

  return headers;
}

async function myobFetch<T>(
  connection: CompanyConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const fresh = await ensureFreshTokens(connection);
  const url = path.startsWith("http")
    ? path
    : `${config.myob.apiBaseUrl.replace(/\/$/, "")}/${fresh.businessId}/${path.replace(/^\//, "")}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      ...buildHeaders(fresh.tokens.accessToken),
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new MyobApiError(
      `MYOB API ${response.status} for ${url}`,
      response.status,
      body,
    );
  }

  return body as T;
}

/**
 * Read-only GET against the MYOB Business API. This is the ONLY verb the
 * platform uses — there is deliberately no write path to MYOB anywhere.
 * Retries once on throttle/transient errors (MYOB allows ~8 req/s).
 */
export async function myobGet<T>(
  connection: CompanyConnection,
  pathOrUrl: string,
): Promise<T> {
  try {
    return await myobFetch<T>(connection, pathOrUrl);
  } catch (err) {
    if (
      err instanceof MyobApiError &&
      [429, 500, 502, 503, 504].includes(err.status)
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      return myobFetch<T>(connection, pathOrUrl);
    }
    throw err;
  }
}

/**
 * Fetch every page of a MYOB collection, invoking `onPage` per page so large
 * datasets stream through without being held in memory. Follows NextPageLink
 * and paces requests to stay inside MYOB's throttle limit.
 */
export async function myobGetAllPages(
  connection: CompanyConnection,
  path: string,
  options: {
    top?: number;
    filter?: string;
    onPage: (items: Record<string, unknown>[], pageIndex: number) => Promise<void>;
  },
): Promise<{ pages: number; rows: number }> {
  const top = options.top ?? 400;
  const params = new URLSearchParams();
  params.set("$top", String(top));
  if (options.filter) params.set("$filter", options.filter);

  let url: string | null = `${path}?${params.toString()}`;
  let pages = 0;
  let rows = 0;

  while (url) {
    const page: MyobPagedResponse<Record<string, unknown>> = await myobGet(
      connection,
      url,
    );
    const items = page.Items ?? [];
    await options.onPage(items, pages);
    pages += 1;
    rows += items.length;
    url = page.NextPageLink ?? null;
    if (url) {
      // ~7 req/s keeps us under MYOB's 8 req/s throttle.
      await new Promise((r) => setTimeout(r, 140));
    }
  }

  return { pages, rows };
}

export async function getCompanyInfo(
  connection?: CompanyConnection | null,
): Promise<Record<string, unknown>> {
  const active = connection ?? (await getActiveConnection());
  if (!active) {
    throw new Error("No MYOB company connected. Complete OAuth first.");
  }
  // Company file root often returns file metadata.
  return myobFetch<Record<string, unknown>>(active, "");
}

export async function listInventoryItems(options?: {
  top?: number;
  skip?: number;
  filter?: string;
  connection?: CompanyConnection | null;
}): Promise<MyobPagedResponse<MyobInventoryItem>> {
  const active = options?.connection ?? (await getActiveConnection());
  if (!active) {
    throw new Error("No MYOB company connected. Complete OAuth first.");
  }

  const params = new URLSearchParams();
  if (options?.top) params.set("$top", String(options.top));
  if (options?.skip) params.set("$skip", String(options.skip));
  if (options?.filter) params.set("$filter", options.filter);

  const query = params.toString();
  const path = query ? `Inventory/Item?${query}` : "Inventory/Item";
  return myobFetch<MyobPagedResponse<MyobInventoryItem>>(active, path);
}

export async function listInventoryLocations(
  connection?: CompanyConnection | null,
): Promise<MyobPagedResponse<Record<string, unknown>>> {
  const active = connection ?? (await getActiveConnection());
  if (!active) {
    throw new Error("No MYOB company connected. Complete OAuth first.");
  }
  return myobFetch(active, "Inventory/Location");
}

/** Representative collection roots used to verify scope access. */
export const ENDPOINT_PROBES = [
  { group: "Contact", path: "Contact/Customer", scope: "sme-contacts-customer" },
  { group: "Contact", path: "Contact/Supplier", scope: "sme-contacts-supplier" },
  { group: "Contact", path: "Contact/Employee", scope: "sme-contacts-employee" },
  { group: "Contact", path: "Contact/Personal", scope: "sme-contacts-personal" },
  { group: "Sale", path: "Sale/Invoice", scope: "sme-sales" },
  { group: "Sale", path: "Sale/Order", scope: "sme-sales" },
  { group: "Sale", path: "Sale/Quote", scope: "sme-sales" },
  { group: "Sale", path: "Sale/CustomerPayment", scope: "sme-sales" },
  { group: "Purchase", path: "Purchase/Bill", scope: "sme-purchases" },
  { group: "Purchase", path: "Purchase/Order", scope: "sme-purchases" },
  { group: "Purchase", path: "Purchase/SupplierPayment", scope: "sme-purchases" },
  { group: "Inventory", path: "Inventory/Item", scope: "sme-inventory" },
  { group: "Inventory", path: "Inventory/Location", scope: "sme-inventory" },
  { group: "Inventory", path: "Inventory/Adjustment", scope: "sme-inventory" },
] as const;

export type EndpointProbeResult = {
  group: string;
  path: string;
  scope: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  count: number | null;
  error: string | null;
};

export async function probeEndpoints(
  connection?: CompanyConnection | null,
): Promise<{
  businessId: string;
  probedAt: string;
  results: EndpointProbeResult[];
}> {
  const active = connection ?? (await getActiveConnection());
  if (!active) {
    throw new Error("No MYOB company connected. Complete OAuth first.");
  }

  const results: EndpointProbeResult[] = [];

  // Sequential to stay under MYOB's throttle (≈8 req/s).
  for (const probe of ENDPOINT_PROBES) {
    const started = Date.now();
    try {
      const page = await myobFetch<MyobPagedResponse<Record<string, unknown>>>(
        active,
        `${probe.path}?$top=1`,
      );
      results.push({
        group: probe.group,
        path: probe.path,
        scope: probe.scope,
        ok: true,
        status: 200,
        latencyMs: Date.now() - started,
        count: typeof page.Count === "number" ? page.Count : page.Items?.length ?? null,
        error: null,
      });
    } catch (err) {
      const status = err instanceof MyobApiError ? err.status : null;
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        group: probe.group,
        path: probe.path,
        scope: probe.scope,
        ok: false,
        status,
        latencyMs: Date.now() - started,
        count: null,
        error: message,
      });
    }
  }

  return {
    businessId: active.businessId,
    probedAt: new Date().toISOString(),
    results,
  };
}
