#!/usr/bin/env node
/**
 * Guard: the version Allied see is the version that shipped (1.0).
 *
 * Three places name the running version and they must never disagree:
 * package.json (what the server reports on /sync/status), UI_VERSION in
 * public/dashboard.js (what an open tab compares it with, to raise the reload
 * banner) and the newest RELEASES entry (what What's new tells Allied). If
 * package.json moves and UI_VERSION does not, every tab shows the banner
 * forever and every write gets 409; if RELEASES lags, What's new describes the
 * previous release as the current one. `npm run build` runs this before tsc,
 * so Render refuses to deploy a mismatch.
 *
 * It also checks that RELEASES runs strictly newest first and that every entry
 * names its stage, because "which stage is 1.4?" is the question a rollback
 * starts with.
 *
 *   node scripts/check-release.mjs              (the build)
 *   node scripts/check-release.mjs --pre-push   (also: newer than the newest v* tag)
 *
 * --pre-push is for a local run before pushing. The build cannot use it:
 * Render's clone may carry no tags at all.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
// The same comparison the reload banner uses, so the two can never disagree on "newer".
import { compareVersions } from "../public/release-banner.js";

const SEMVER = /^\d+\.\d+\.\d+$/;
/** What's new limits (1.17): a headline that fits one or two lines of the drawer, a summary of a sentence or two. */
export const TITLE_MAX = 70;
export const SUMMARY_MAX = 260;

/**
 * Pull UI_VERSION and RELEASES out of dashboard.js without running it — it
 * reads `document` on load. RELEASES must be a literal array closed by a `];`
 * at the start of a line; it is evaluated on its own in an empty context.
 */
export function readDashboardRelease(source) {
  const ui = /^const UI_VERSION = "([^"]*)";/m.exec(source);
  const start = source.search(/^const RELEASES = \[/m);
  if (start < 0) return { uiVersion: ui?.[1] ?? null, releases: null };
  const open = source.indexOf("[", start);
  const close = source.indexOf("\n];", open);
  if (close < 0) return { uiVersion: ui?.[1] ?? null, releases: null };
  const literal = source.slice(open, close + 2);
  const releases = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
  return { uiVersion: ui?.[1] ?? null, releases };
}

/** Every problem with the three version sources, as plain sentences. Empty means OK. */
export function releaseProblems({ pkgVersion, uiVersion, releases, newestTag = undefined }) {
  const problems = [];
  if (!SEMVER.test(pkgVersion ?? "")) problems.push(`package.json version "${pkgVersion}" is not N.N.N.`);
  if (uiVersion == null) problems.push('public/dashboard.js has no `const UI_VERSION = "N.N.N";` line.');
  else if (uiVersion !== pkgVersion)
    problems.push(`UI_VERSION is ${uiVersion} but package.json is ${pkgVersion}. Bump both together.`);
  if (!Array.isArray(releases) || !releases.length) {
    problems.push("RELEASES in public/dashboard.js is missing or empty.");
    return problems;
  }
  if (releases[0]?.version !== pkgVersion)
    problems.push(
      `The newest RELEASES entry is ${releases[0]?.version} but package.json is ${pkgVersion}. Add the new entry at the top.`,
    );
  const versions = releases.map((r) => r?.version);
  releases.forEach((r, i) => {
    const label = `RELEASES[${i}]${r?.version ? ` (${r.version})` : ""}`;
    if (!SEMVER.test(r?.version ?? "")) problems.push(`${label} has no N.N.N version.`);
    if (typeof r?.stage !== "string" || !r.stage.trim()) problems.push(`${label} has no stage label.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.date ?? "")) problems.push(`${label} has no yyyy-mm-dd date.`);
    // What's new leads with these (1.17): a plain headline, a short summary,
    // and whether any figure Allied see changed. Kept short so the panel
    // stays readable at a glance; the full notes go in changes/numbers/check.
    if (typeof r?.title !== "string" || !r.title.trim()) problems.push(`${label} has no title (What's new headline).`);
    else if (r.title.length > TITLE_MAX) problems.push(`${label} title is ${r.title.length} characters; keep it to ${TITLE_MAX}.`);
    if (typeof r?.summary !== "string" || !r.summary.trim()) problems.push(`${label} has no summary.`);
    else if (r.summary.length > SUMMARY_MAX) problems.push(`${label} summary is ${r.summary.length} characters; keep it to ${SUMMARY_MAX}.`);
    if (typeof r?.numbersChanged !== "boolean") problems.push(`${label} has no numbersChanged (true or false).`);
    else if (r.numbersChanged && !(typeof r.numbersShort === "string" && r.numbersShort.trim()))
      problems.push(`${label} changes figures but has no numbersShort saying which.`);
    if (i > 0 && SEMVER.test(r?.version ?? "") && SEMVER.test(versions[i - 1] ?? "")) {
      if (compareVersions(versions[i - 1], r.version) <= 0)
        problems.push(`RELEASES is not strictly newest first: ${versions[i - 1]} is listed above ${r.version}.`);
    }
    // A withdrawal is always made by a later release, which must be listed.
    if (r?.withdrawn != null) {
      if (!versions.includes(r.withdrawn) || compareVersions(r.withdrawn, r.version) <= 0)
        problems.push(`${label} is marked withdrawn in ${r.withdrawn}, which is not a later listed release.`);
    }
  });
  if (newestTag !== undefined && newestTag !== null) {
    const tagged = newestTag.replace(/^v/, "");
    if (SEMVER.test(tagged) && compareVersions(pkgVersion, tagged) <= 0)
      problems.push(`package.json ${pkgVersion} is not newer than the newest tag ${newestTag}. Bump the version.`);
  }
  return problems;
}

/** Newest v<N.N.N> tag, or null when there are none. */
function newestGitTag() {
  const out = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" });
  const tags = out
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => SEMVER.test(t.replace(/^v/, "")));
  tags.sort((a, b) => compareVersions(b.replace(/^v/, ""), a.replace(/^v/, "")));
  return tags[0] ?? null;
}

function main() {
  const prePush = process.argv.includes("--pre-push");
  const root = process.cwd();
  const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  let uiVersion = null;
  let releases = null;
  try {
    ({ uiVersion, releases } = readDashboardRelease(readFileSync(join(root, "public/dashboard.js"), "utf8")));
  } catch (err) {
    console.error(`Could not read RELEASES from public/dashboard.js: ${err.message}`);
    process.exit(1);
  }
  const newestTag = prePush ? newestGitTag() : undefined;
  const problems = releaseProblems({ pkgVersion, uiVersion, releases, newestTag });
  if (problems.length) {
    console.error("Release versions disagree:\n");
    for (const p of problems) console.error("  " + p);
    console.error(`\n${problems.length} problem(s). See RELEASING.md.`);
    process.exit(1);
  }
  console.log(
    `release ${pkgVersion} consistent: package.json, UI_VERSION and RELEASES agree; ${releases.length} release(s) listed newest first.` +
      (prePush ? ` Newer than ${newestTag ?? "every tag (there are none yet)"}.` : ""),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
