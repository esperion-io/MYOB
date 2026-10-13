import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Which code is running, so "is 1.2 live yet?" has an answer.
 *
 * Until 1.0 nothing identified a deploy: the only way to tell which commit
 * Render was serving was to read its dashboard, and a tab left open through a
 * deploy kept running the old JS with no sign anything had changed. Every
 * release now bumps `package.json`, and the server reports that version and the
 * commit it was built from on `/api/insights/sync/status`, which every open tab
 * already polls once a minute.
 *
 * The version is read from package.json at boot rather than compiled in,
 * because tsc's rootDir is src/ and the file sits one level above it. The path
 * is the same from src/ under tsx and from dist/ in production.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface Release {
  /** package.json version, e.g. "1.0.0". The UI shows it as "1.0". */
  version: string;
  /** Short commit Render built from; "local" anywhere else. */
  commit: string;
  /** When this instance started, so two instances can be told apart. */
  bootedAt: string;
}

export const release: Release = Object.freeze({
  version: packageVersion(),
  commit: process.env.RENDER_GIT_COMMIT?.trim().slice(0, 7) || "local",
  bootedAt: new Date().toISOString(),
});

/** "1.2.0" → "1.2"; a fix release keeps its patch ("1.2.1"). Matches the UI. */
export function displayVersion(version: string): string {
  return version.replace(/\.0$/, "");
}

/** Methods that only read. Everything else is a write and is version-checked. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/*
 * The stale-tab rule, separate from Express so it can be tested on its own.
 *
 * A tab keeps the JS it loaded. After a deploy or a rollback that JS may send
 * a body the server no longer reads the same way, and the 60-second poll that
 * raises the reload banner leaves up to a minute in which it still can. So from
 * 1.0 every write carries the tab's own version in `x-ui-version`, and a write
 * whose version differs from the server's is refused before it touches a row.
 *
 * A write with NO header passes. Tabs opened before 1.0 cannot send one, and
 * refusing them would break every open tab on the very deploy that introduces
 * the banner they would need to recover — so the first 1.0 deploy instead
 * needs one manual reload (see RELEASING.md).
 */
export function staleWriteError(
  method: string,
  uiVersion: string | undefined,
  serverVersion: string = release.version,
): string | null {
  if (READ_METHODS.has(method.toUpperCase())) return null;
  const sent = uiVersion?.trim();
  if (!sent || sent === serverVersion) return null;
  return `The dashboard is now on version ${displayVersion(serverVersion)}. Reload the page to continue.`;
}
