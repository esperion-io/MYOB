/*
 * The reload banner's decision, kept apart from dashboard.js (1.0).
 *
 * dashboard.js reads `document` the moment it loads, so nothing in it can be
 * imported by a test. This module touches no DOM: it takes what the server
 * reported and what this tab is running, and says which banner to show, if
 * any. `npm test` exercises every case below (test/release.test.ts).
 *
 * The banner never reloads the page by itself. A reload in the middle of
 * typing a quantity loses the quantity; a banner that says why and offers a
 * button does not.
 */

/** "1.2.0" → "1.2"; a fix release keeps its patch ("1.2.1"). */
export function displayVersion(version) {
  return String(version ?? "").replace(/\.0$/, "");
}

/** Numeric, part by part: 1.10.0 is newer than 1.9.0, which string order gets wrong. */
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const SAVE_BLOCKED = "Changes can't be saved until you do.";

/**
 * Which banner, if any, for one poll of /sync/status.
 *
 * `server` is the `release` the server reported, or null/undefined when it
 * reported none. `tab` is { version, known, firstCommit, seenRelease }: this
 * tab's UI_VERSION, the versions in its own RELEASES, the commit seen on its
 * first poll, and whether any poll has carried a release yet.
 *
 * Returns null, or { kind: "updated" | "back", text, refusal } where `text` is
 * the banner and `refusal` the message a blocked write shows.
 */
export function releaseBanner(server, tab) {
  if (!server || !server.version) {
    // Only a server that has said a version and then stopped saying one has
    // gone back past 1.0. One that never said anything is not news.
    if (!tab.seenRelease) return null;
    const text = "The dashboard was changed back to an earlier version. Reload.";
    return { kind: "back", text, refusal: `${text} ${SAVE_BLOCKED}` };
  }
  if (server.version !== tab.version) {
    // Older only if this tab knows the version: an unknown one can only be a
    // release that shipped after this tab loaded.
    const older =
      (tab.known ?? []).includes(server.version) && compareVersions(server.version, tab.version) < 0;
    const shown = displayVersion(server.version);
    if (older) {
      const text = `The dashboard was changed back to version ${shown}. Reload.`;
      return { kind: "back", text, refusal: `${text} ${SAVE_BLOCKED}` };
    }
    const text = `The dashboard was updated to version ${shown}. Reload to continue; changes can't be saved until you do.`;
    return { kind: "updated", text, refusal: text };
  }
  // Same version, different build. Every push bumps the version, so this
  // should not happen — but if it does, the tab is still running other code.
  if (tab.firstCommit && server.commit && server.commit !== tab.firstCommit) {
    const text = "The dashboard was updated. Reload to continue; changes can't be saved until you do.";
    return { kind: "updated", text, refusal: text };
  }
  return null;
}
