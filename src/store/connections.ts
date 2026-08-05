import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type {
  CompanyConnection,
  ConnectionStore,
  StoredTokens,
} from "../myob/types.js";

const STORE_FILE = () => path.join(config.dataDir, "connections.json");

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

export async function loadStore(): Promise<ConnectionStore> {
  try {
    const raw = await fs.readFile(STORE_FILE(), "utf8");
    const parsed = JSON.parse(raw) as ConnectionStore;
    return {
      connections: parsed.connections ?? [],
      activeBusinessId: parsed.activeBusinessId,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { connections: [] };
    }
    throw err;
  }
}

export async function saveStore(store: ConnectionStore): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(STORE_FILE(), JSON.stringify(store, null, 2), "utf8");
}

export async function upsertConnection(
  businessId: string,
  tokens: StoredTokens,
  displayName?: string,
): Promise<CompanyConnection> {
  const store = await loadStore();
  const existing = store.connections.find((c) => c.businessId === businessId);
  const connection: CompanyConnection = {
    businessId,
    displayName: displayName ?? existing?.displayName,
    connectedAt: existing?.connectedAt ?? new Date().toISOString(),
    tokens,
  };

  store.connections = [
    ...store.connections.filter((c) => c.businessId !== businessId),
    connection,
  ];
  store.activeBusinessId = businessId;
  await saveStore(store);
  return connection;
}

export async function updateTokens(
  businessId: string,
  tokens: StoredTokens,
): Promise<void> {
  const store = await loadStore();
  const connection = store.connections.find((c) => c.businessId === businessId);
  if (!connection) {
    throw new Error(`No connection found for businessId ${businessId}`);
  }
  connection.tokens = tokens;
  await saveStore(store);
}

export async function setActiveBusinessId(businessId: string): Promise<void> {
  const store = await loadStore();
  if (!store.connections.some((c) => c.businessId === businessId)) {
    throw new Error(`Unknown businessId: ${businessId}`);
  }
  store.activeBusinessId = businessId;
  await saveStore(store);
}

export async function getActiveConnection(): Promise<CompanyConnection | null> {
  const store = await loadStore();
  if (!store.connections.length) return null;
  if (store.activeBusinessId) {
    const active = store.connections.find(
      (c) => c.businessId === store.activeBusinessId,
    );
    if (active) return active;
  }
  return store.connections[0] ?? null;
}

export async function removeConnection(businessId: string): Promise<void> {
  const store = await loadStore();
  store.connections = store.connections.filter(
    (c) => c.businessId !== businessId,
  );
  if (store.activeBusinessId === businessId) {
    store.activeBusinessId = store.connections[0]?.businessId;
  }
  await saveStore(store);
}

export async function clearAllConnections(): Promise<void> {
  await saveStore({ connections: [] });
}
