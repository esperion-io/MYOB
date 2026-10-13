/**
 * Release plumbing (1.0): the version stamp, the stale-tab write guard, the
 * reload banner's decision, the build's version check and the golden
 * capture/diff. Run with `npm test`.
 *
 * The first test is the one that matters most locally: `.env` holds the
 * PRODUCTION DATABASE_URL and dotenv loads it for every tsx run, so a test
 * that reached for the pool used to reach production. `npm test` now blanks
 * DATABASE_URL, and dotenv never overrides a variable that is already set.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getPool, hasDatabaseUrl } from "../src/db.js";
import { displayVersion, release, staleWriteError } from "../src/release.js";
import { stampDetail } from "../src/insights/changeLog.js";
// @ts-ignore — plain browser module, no types
import { compareVersions, releaseBanner } from "../public/release-banner.js";
// @ts-ignore — build script, no types
import { readDashboardRelease, releaseProblems } from "../scripts/check-release.mjs";
// @ts-ignore — ops script, no types
import { allowMatcher, capture, diffCaptures, loadAllow, makeGetter, parseCsv, proposeAllow, resolveBase } from "../scripts/stage-check.mjs";

const pkgVersion: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/* ---------- npm test cannot reach a database ---------- */

test("npm test runs with no database: getPool throws even with the production .env on disk", () => {
  assert.equal(hasDatabaseUrl(), false, "DATABASE_URL must be blank under npm test (see package.json)");
  assert.throws(() => getPool(), /DATABASE_URL is not set/);
});

/* ---------- what the server reports ---------- */

test("release reports package.json's version, and 'local' off Render", () => {
  assert.equal(release.version, pkgVersion);
  if (!process.env.RENDER_GIT_COMMIT) assert.equal(release.commit, "local");
  assert.ok(!Number.isNaN(Date.parse(release.bootedAt)));
  assert.equal(displayVersion("1.0.0"), "1.0");
  assert.equal(displayVersion("1.10.0"), "1.10");
  assert.equal(displayVersion("1.2.1"), "1.2.1");
});

test("write guard: only a write whose x-ui-version is present and differs is refused", () => {
  // Reads never.
  assert.equal(staleWriteError("GET", "0.9.0", "1.0.0"), null);
  assert.equal(staleWriteError("HEAD", "0.9.0", "1.0.0"), null);
  // A tab older than 1.0 sends no header and must keep working.
  assert.equal(staleWriteError("POST", undefined, "1.0.0"), null);
  assert.equal(staleWriteError("POST", "", "1.0.0"), null);
  // The same version passes.
  assert.equal(staleWriteError("POST", "1.0.0", "1.0.0"), null);
  assert.equal(staleWriteError("delete", "1.0.0", "1.0.0"), null);
  // Different, in either direction, is refused with the reload message.
  assert.equal(
    staleWriteError("POST", "1.1.0", "1.2.0"),
    "The dashboard is now on version 1.2. Reload the page to continue.",
  );
  assert.match(staleWriteError("DELETE", "1.2.0", "1.1.0") ?? "", /version 1\.1\. Reload/);
});

test("change log rows carry the release that wrote them, without disturbing what the rollback reads", () => {
  const stamp = { release: release.version, commit: release.commit };
  assert.deepEqual(stampDetail(undefined), stamp);
  assert.deepEqual(stampDetail(null), stamp);
  assert.deepEqual(stampDetail({ supplierUid: "S1", patch: { isPreferred: true } }), {
    supplierUid: "S1",
    patch: { isPreferred: true },
    ...stamp,
  });
  // apply_suggestions: the rollback script reads detail.inserted; it must survive.
  const inserted = [{ item_uid: "A" }];
  assert.deepEqual((stampDetail({ inserted }) as { inserted: unknown }).inserted, inserted);
  // Not a plain object: left exactly as it was.
  assert.deepEqual(stampDetail(["x"]), ["x"]);
  assert.equal(stampDetail("note"), "note");
});

/* ---------- the reload banner ---------- */

const tab = (over: Record<string, unknown> = {}) => ({
  version: "1.1.0",
  known: ["1.1.0", "1.0.0"],
  firstCommit: "abc1234",
  seenRelease: true,
  ...over,
});

test("versions compare as numbers, so 1.10 is newer than 1.9", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("1.2.0", "1.2.1"), -1);
});

test("banner: nothing while the server runs this tab's own build", () => {
  assert.equal(releaseBanner({ version: "1.1.0", commit: "abc1234" }, tab()), null);
});

test("banner: server newer, or a version this tab has never heard of, says updated", () => {
  const newer = releaseBanner({ version: "1.2.0", commit: "def5678" }, tab());
  assert.equal(newer.kind, "updated");
  assert.equal(
    newer.text,
    "The dashboard was updated to version 1.2. Reload to continue; changes can't be saved until you do.",
  );
  // Unknown and numerically lower is still "updated": it shipped after this tab loaded.
  assert.equal(releaseBanner({ version: "1.0.5", commit: "x" }, tab()).kind, "updated");
});

test("banner: server older and listed in this tab's RELEASES says changed back", () => {
  const back = releaseBanner({ version: "1.0.0", commit: "000aaaa" }, tab());
  assert.equal(back.kind, "back");
  assert.equal(back.text, "The dashboard was changed back to version 1.0. Reload.");
  assert.match(back.refusal, /can't be saved/);
});

test("banner: no release after one was seen means rolled back past 1.0; never seen means nothing", () => {
  assert.equal(
    releaseBanner(undefined, tab()).text,
    "The dashboard was changed back to an earlier version. Reload.",
  );
  assert.equal(releaseBanner(undefined, tab({ seenRelease: false })), null);
  assert.equal(releaseBanner({}, tab({ seenRelease: false })), null);
});

test("banner: same version on a different commit still says updated", () => {
  assert.equal(releaseBanner({ version: "1.1.0", commit: "fff0000" }, tab()).kind, "updated");
  // Before the first commit is known there is nothing to compare against.
  assert.equal(releaseBanner({ version: "1.1.0", commit: "fff0000" }, tab({ firstCommit: null })), null);
});

/*
 * dashboard.js now imports from a public/ module. A name it imports that the
 * module no longer exports fails ES module linking, and the whole dashboard
 * loads blank while tsc (which never sees public/) stays green. Read it
 * statically: dashboard.js touches `document` on load, so it can't be imported.
 */
test("every name dashboard.js imports from a public/ module is exported by it", () => {
  const pub = new URL("../public/", import.meta.url);
  const source = readFileSync(new URL("dashboard.js", pub), "utf8");
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/([\w./-]+\.js)["']/g)];
  assert.ok(imports.length > 0, "expected dashboard.js to import from a public/ module");
  for (const [, names, file] of imports) {
    const mod = readFileSync(new URL(file, pub), "utf8");
    const exported = new Set<string>();
    for (const m of mod.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\w$]+)/g)) exported.add(m[1]);
    for (const m of mod.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop();
        if (name) exported.add(name);
      }
    }
    for (const part of names.split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) assert.ok(exported.has(name), `dashboard.js imports ${name} from ./${file}, which does not export it`);
    }
  }
});

/*
 * The other half (1.5): a public/ module is only importable by dashboard.js
 * and by a test if it never touches the DOM at load. Every module but the two
 * page scripts must load under node, so order-list.js (1.5, drawn from 1.6)
 * and release-banner.js stay testable, and a module dashboard.js starts
 * importing later is already known to load.
 */
test("every public/ module except the two page scripts loads without a DOM", async () => {
  const pub = new URL("../public/", import.meta.url);
  const modules = readdirSync(pub).filter((f) => f.endsWith(".js") && f !== "dashboard.js" && f !== "app.js");
  assert.ok(modules.includes("release-banner.js") && modules.includes("order-list.js"));
  for (const f of modules) {
    const mod = await import(new URL(f, pub).href);
    assert.ok(Object.keys(mod).length > 0, `public/${f} exports nothing`);
  }
});

/* ---------- the build's version check ---------- */

const entry = (version: string, over: Record<string, unknown> = {}) => ({
  version,
  date: "2026-10-13",
  stage: `Stage for ${version}`,
  changes: ["x"],
  ...over,
});

test("check-release: the real package.json, UI_VERSION and RELEASES agree", () => {
  const { uiVersion, releases } = readDashboardRelease(
    readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8"),
  );
  assert.equal(uiVersion, pkgVersion);
  assert.deepEqual(releaseProblems({ pkgVersion, uiVersion, releases }), []);
  assert.ok(releases.every((r: { stage?: string }) => r.stage), "every entry names its stage");
});

test("check-release: a mismatched UI_VERSION fails the build", () => {
  const problems = releaseProblems({ pkgVersion: "1.1.0", uiVersion: "1.0.0", releases: [entry("1.1.0"), entry("1.0.0")] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /UI_VERSION is 1\.0\.0 but package\.json is 1\.1\.0/);
});

test("check-release: a missing RELEASES entry for the new version fails the build", () => {
  const problems = releaseProblems({ pkgVersion: "1.1.0", uiVersion: "1.1.0", releases: [entry("1.0.0")] });
  assert.match(problems.join("\n"), /newest RELEASES entry is 1\.0\.0/);
});

test("check-release: RELEASES out of order, or an entry with no stage, fails the build", () => {
  const disordered = releaseProblems({
    pkgVersion: "1.2.0",
    uiVersion: "1.2.0",
    releases: [entry("1.2.0"), entry("1.0.0"), entry("1.1.0")],
  });
  assert.match(disordered.join("\n"), /not strictly newest first: 1\.0\.0 is listed above 1\.1\.0/);
  const duplicate = releaseProblems({ pkgVersion: "1.1.0", uiVersion: "1.1.0", releases: [entry("1.1.0"), entry("1.1.0")] });
  assert.match(duplicate.join("\n"), /not strictly newest first/);
  const unlabelled = releaseProblems({
    pkgVersion: "1.1.0",
    uiVersion: "1.1.0",
    releases: [entry("1.1.0", { stage: "" }), entry("1.0.0")],
  });
  assert.match(unlabelled.join("\n"), /RELEASES\[0\] \(1\.1\.0\) has no stage label/);
});

test("check-release: withdrawn must name a later listed release; --pre-push needs a version above the tag", () => {
  const ok = releaseProblems({
    pkgVersion: "1.3.0",
    uiVersion: "1.3.0",
    releases: [entry("1.3.0"), entry("1.2.0", { withdrawn: "1.3.0" }), entry("1.1.0")],
  });
  assert.deepEqual(ok, []);
  const bad = releaseProblems({
    pkgVersion: "1.3.0",
    uiVersion: "1.3.0",
    releases: [entry("1.3.0"), entry("1.2.0", { withdrawn: "1.1.0" }), entry("1.1.0")],
  });
  assert.match(bad.join("\n"), /withdrawn in 1\.1\.0, which is not a later listed release/);
  const base = { pkgVersion: "1.1.0", uiVersion: "1.1.0", releases: [entry("1.1.0")] };
  assert.deepEqual(releaseProblems({ ...base, newestTag: "v1.0.0" }), []);
  assert.deepEqual(releaseProblems({ ...base, newestTag: null }), []);
  assert.match(releaseProblems({ ...base, newestTag: "v1.1.0" }).join("\n"), /not newer than the newest tag v1\.1\.0/);
});

/* ---------- stage-check: GET only, key never written ---------- */

test("stage-check refuses any method but GET before anything is sent", async () => {
  let calls = 0;
  const get = makeGetter({ base: "http://x", key: "k", fetchImpl: async () => (calls++, new Response("{}")) });
  for (const method of ["POST", "DELETE", "PUT", "PATCH"]) {
    await assert.rejects(() => get("/cart/reset", { method }), /GET requests only/);
  }
  assert.equal(calls, 0);
});

test("stage-check sends the key as a header, never in a URL, and never writes it", async () => {
  const key = "s3cret-access-key-for-test";
  const seen: { url: string; init: RequestInit }[] = [];
  const fakeFetch = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const path = new URL(url).pathname.replace("/api/insights", "");
    if (path === "/items") {
      return Response.json({ total: 2, page: 1, items: [{ uid: "u1", number: "BN1665G" }, { uid: "u2", number: "SPW12G" }] });
    }
    if (path === "/cart") return Response.json({ suppliers: [], decisions: [{ itemUid: "u2", number: "SPW12G", kind: "split" }] });
    if (path.endsWith(".csv")) return new Response("Item number,Supplier\r\nBN1665G,HANOVA\r\n");
    if (path === "/sync/status") return Response.json({ release: { version: "1.0.0", commit: "local" }, echo: key });
    return Response.json({ path });
  };
  const dir = mkdtempSync(join(tmpdir(), "stage-check-"));
  try {
    const out = await capture(dir, { get: makeGetter({ base: "http://x", key, fetchImpl: fakeFetch }), key });
    assert.ok(seen.length > 10);
    for (const s of seen) {
      assert.equal(s.init.method, "GET");
      assert.ok(!s.url.includes(key), "key must not be in a URL");
      assert.equal((s.init.headers as Record<string, string>)["x-dashboard-key"], key);
    }
    // A response that echoed the key is redacted and reported, never saved.
    const all = [...readdirSync(dir), ...readdirSync(join(dir, "items")).map((f) => join("items", f))]
      .filter((f) => f.includes("."))
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    assert.ok(!all.includes(key));
    assert.match(out.problems.join("\n"), /sync-status\.json: contained the access key/);
    assert.equal(out.watch.BN1665G, "u1");
    assert.equal(out.watch.SPW12G, "u2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stage-check --base takes local, prod or a URL, and refuses a key in the URL", () => {
  assert.equal(resolveBase(undefined), "http://localhost:3111");
  assert.equal(resolveBase("prod"), "https://esperion-inventory-dashboard.onrender.com");
  assert.throws(() => resolveBase("http://localhost:3111/?key=abc"), /DASHBOARD_KEY/);
  assert.throws(() => resolveBase("ftp://x"), /--base must be/);
});

/* ---------- stage-check: diff by identity ---------- */

function writeCapture(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "stage-diff-"));
  mkdirSync(join(dir, "items"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const line = (itemUid: string, supplierUid: string, qty: number) => ({ itemUid, supplierUid, qty, options: [] });

test("diff pairs records by identity: a reorder is no change, a moved figure is exactly one", () => {
  const before = writeCapture({
    "items.json": { total: 2, items: [{ uid: "a", coverWeeks: 3 }, { uid: "b", coverWeeks: 9 }] },
    "cart.json": {
      generatedAt: "2026-10-13T05:00:00Z",
      suppliers: [
        { supplierUid: "HAN", lines: [line("a", "HAN", 10), line("b", "HAN", 4)] },
        { supplierUid: "TONG", lines: [line("c", "TONG", 1)] },
      ],
      decisions: [{ itemUid: "a" }, { itemUid: "b" }],
    },
    "sync-status.json": { entities: [{ entity: "items", last_synced_at: "t1" }], release: { version: "1.0.0", bootedAt: "x" } },
    "items.csv": "﻿Item number,Supplier,Cover\r\nA1,HAN,3\r\nB1,HAN,9\r\n",
    "cart.csv": "NOTE: 1 item\r\n\r\nHanova\r\nSupplier,Item number,Order qty\r\nHAN,A1,10\r\nHAN,B1,4\r\n",
  });
  const reordered = writeCapture({
    "items.json": { total: 2, items: [{ uid: "b", coverWeeks: 9 }, { uid: "a", coverWeeks: 3 }] },
    "cart.json": {
      generatedAt: "2026-10-13T05:01:00Z",
      suppliers: [
        { supplierUid: "TONG", lines: [line("c", "TONG", 1)] },
        { supplierUid: "HAN", lines: [line("b", "HAN", 4), line("a", "HAN", 10)] },
      ],
      decisions: [{ itemUid: "b" }, { itemUid: "a" }],
    },
    "sync-status.json": { entities: [{ entity: "items", last_synced_at: "t2" }], release: { version: "1.0.0", bootedAt: "y" } },
    "items.csv": "﻿Item number,Supplier,Cover\r\nB1,HAN,9\r\nA1,HAN,3\r\n",
    "cart.csv": "NOTE: 1 item\r\n\r\nHanova\r\nSupplier,Item number,Order qty\r\nHAN,B1,4\r\nHAN,A1,10\r\n",
  });
  const moved = writeCapture({
    "items.json": { total: 2, items: [{ uid: "b", coverWeeks: 9 }, { uid: "a", coverWeeks: 3.5 }] },
    "cart.json": {
      generatedAt: "x",
      suppliers: [
        { supplierUid: "HAN", lines: [line("a", "HAN", 12), line("b", "HAN", 4)] },
        { supplierUid: "TONG", lines: [line("c", "TONG", 1)] },
      ],
      decisions: [{ itemUid: "a" }, { itemUid: "b" }],
    },
    "sync-status.json": { entities: [{ entity: "items", last_synced_at: "t3" }], release: { version: "1.1.0", bootedAt: "z" } },
    "items.csv": "﻿Item number,Supplier,Cover\r\nA1,HAN,3.5\r\nB1,HAN,9\r\n",
    "cart.csv": "NOTE: 2 items\r\n\r\nHanova\r\nSupplier,Item number,Order qty\r\nHAN,A1,12\r\nHAN,B1,4\r\n",
  });
  try {
    assert.deepEqual(diffCaptures(before, reordered).changes, []);
    const paths = diffCaptures(before, moved).changes.map((c: { file: string; path: string }) => `${c.file} ${c.path}`);
    assert.deepEqual(paths.sort(), [
      "cart.csv notes[0]",
      "cart.csv rows[A1|HAN].Order qty",
      "cart.json suppliers[HAN].lines[a|HAN].qty",
      "items.csv rows[A1|HAN].Cover",
      "items.json items[a].coverWeeks",
      "sync-status.json release.version",
    ]);
  } finally {
    for (const d of [before, reordered, moved]) rmSync(d, { recursive: true, force: true });
  }
});

test("diff --allow: listed paths pass, anything else fails, and the 1.0 list allows only release", () => {
  const before = writeCapture({ "sync-status.json": { entities: [] }, "items.json": { items: [{ uid: "a", cover: 1 }] } });
  const after = writeCapture({
    "sync-status.json": { entities: [], release: { version: "1.0.0", commit: "local", bootedAt: "t" } },
    "items.json": { items: [{ uid: "a", cover: 2 }] },
  });
  try {
    const allow = loadAllow(new URL("../scripts/expected/1.0.0.json", import.meta.url));
    const { changes } = diffCaptures(before, after, allow);
    assert.deepEqual(
      changes.map((c: { path: string; allowed: boolean }) => [c.path, c.allowed]),
      [["items[a].cover", false], ["release", true]],
    );
  } finally {
    for (const d of [before, after]) rmSync(d, { recursive: true, force: true });
  }
  assert.ok(allowMatcher("items[*].coverWeeks").test("items[07df-dd].coverWeeks"));
  assert.ok(!allowMatcher("items[*].coverWeeks").test("items[07df].coverWeeksIncl"));
  assert.ok(allowMatcher("release").test("release.version"));
  assert.ok(!allowMatcher("release").test("releaseNotes"));
  assert.deepEqual(parseCsv('a,"b,""c"""\r\n1,2\r\n'), [["a", 'b,"c"'], ["1", "2"]]);
});

test("expect (1.2): a generated allow-list passes exactly the captured changes and nothing on another record", () => {
  const items = (a: number, b: number) => ({ items: [{ uid: "a", qtyOnOrder: a }, { uid: "b", qtyOnOrder: b }] });
  const before = writeCapture({
    "items.json": items(112897, 5),
    "cart.csv": "Supplier,Item number,Order qty\r\nHAN,WR16301.5S16,10\r\n",
    "manifest.json": { release: { version: "1.1.0", commit: "local" }, capturedAt: "t1" },
  });
  const after = writeCapture({
    "items.json": items(0, 5),
    "cart.csv": "Supplier,Item number,Order qty\r\nHAN,WR16301.5S16,12\r\n",
    "manifest.json": { release: { version: "1.2.0", commit: "local" }, capturedAt: "t2" },
  });
  const elsewhere = writeCapture({
    "items.json": items(0, 6),
    "cart.csv": "Supplier,Item number,Order qty\r\nHAN,WR16301.5S16,12\r\n",
  });
  const dir = mkdtempSync(join(tmpdir(), "stage-expect-"));
  try {
    const spec = proposeAllow(before, after, { stage: "Stage 2: test" });
    assert.equal(spec.version, "1.2.0");
    assert.deepEqual(
      spec.allow.map((a: { file: string; path: string; before: unknown; after: unknown }) => [a.file, a.path, a.before, a.after]),
      [
        ["cart.csv", "rows[WR16301.5S16|HAN].Order qty", "10", "12"],
        ["items.json", "items[a].qtyOnOrder", 112897, 0],
        // Always listed: a deploy changes the release block even when, as
        // locally, the commit reads the same before and after.
        ["sync-status.json", "release", undefined, undefined],
      ],
    );
    const file = join(dir, "x.json");
    writeFileSync(file, JSON.stringify(spec));
    const allow = loadAllow(file);
    assert.ok(diffCaptures(before, after, allow).changes.every((c: { allowed: boolean }) => c.allowed));
    // The same field on a record the list does not name still fails, and a
    // dotted item number is matched literally, not as "any character".
    const bad = diffCaptures(before, elsewhere, loadAllow(file)).changes.filter((c: { allowed: boolean }) => !c.allowed);
    assert.deepEqual(bad.map((c: { path: string }) => c.path), ["items[b].qtyOnOrder"]);
    assert.ok(!allowMatcher("rows[WR16301.5S16|HAN].Order qty").test("rows[WR16301X5S16|HAN].Order qty"));
  } finally {
    for (const d of [before, after, elsewhere, dir]) rmSync(d, { recursive: true, force: true });
  }
});

test("expect (1.2): a positional list that lost rows is listed whole, one that only moved stays exact", () => {
  const po = (number: string, qty: number, extra = {}) => ({ number, qty, ...extra });
  const before = writeCapture({
    "items/BP1675G.json": { item: { qtyOnOrder: 34600 }, incoming: [po("00023060", 11000), po("00022808", 23600), po("00019910", 0)] },
    "overview.json": { regions: [{ region: "Asia", openPoOrders: 13 }, { region: "NZ", openPoOrders: 8 }] },
  });
  const after = writeCapture({
    "items/BP1675G.json": { item: { qtyOnOrder: 11000 }, incoming: [po("00023060", 11000, { outstanding: 11000 })] },
    "overview.json": { regions: [{ region: "Asia", openPoOrders: 9 }, { region: "NZ", openPoOrders: 8 }] },
  });
  try {
    const spec = proposeAllow(before, after);
    assert.deepEqual(
      spec.allow.map((a: { file: string; path: string; changes?: number }) => [a.file, a.path, a.changes ?? null]),
      [
        ["items/BP1675G.json", "item.qtyOnOrder", null],
        ["items/BP1675G.json", "incoming", 3],
        ["overview.json", "regions[0].openPoOrders", null],
        ["sync-status.json", "release", null],
      ],
    );
  } finally {
    for (const d of [before, after]) rmSync(d, { recursive: true, force: true });
  }
});
