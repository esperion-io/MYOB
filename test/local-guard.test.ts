/**
 * Off Render, the app cannot reach production (1.19, src/localGuard.ts).
 *
 * The pure rules are tested with the environment passed in. The wiring
 * (config.ts reading RENDER before .env, db.ts refusing before any pool
 * exists, the app refusing to boot) is tested in child processes whose
 * environment is built from nothing, so these tests read the same under
 * `npm test` here and in Render's build, where RENDER=true and the real MYOB
 * key are set.
 *
 * Nothing here connects to anything. Refused hosts are under `.invalid`,
 * which never resolves (RFC 2606), and are refused before a pool exists. The
 * on-Render case builds a pool and ends it without a query: node-postgres
 * connects on the first query, never on construction.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  databaseHost,
  isRender,
  localDatabaseProblem,
  MYOB_OFF_HERE,
  myobCredentialsUsable,
  syncIntervalHoursFor,
} from "../src/localGuard.js";

const require = createRequire(import.meta.url);

/* ---------- the rules ---------- */

test("only RENDER=true, exactly what Render sets, counts as Render", () => {
  assert.equal(isRender({ RENDER: "true" }), true);
  for (const value of [undefined, "", "1", "TRUE", "yes", "false", " true"]) {
    assert.equal(isRender({ RENDER: value }), false, `RENDER=${JSON.stringify(value)}`);
  }
});

const accepted = [
  "postgres://localhost/allied_dev",
  "postgres://anthony:pw@localhost:5432/allied_dev",
  "postgresql://127.0.0.1:5432/allied_dev",
  "postgres://[::1]:5432/allied_dev",
  "postgres://LOCALHOST/allied_dev",
  "postgres://anthony@/allied_dev", // no host: node-postgres falls back to PGHOST, then localhost
  "postgres://anthony@db.invalid/allied_dev?host=localhost", // the query parameter wins
];

const refused: [string, string | null][] = [
  ["postgres://user:s3cret@db.invalid:5432/allied", "db.invalid"],
  ["postgres://user:s3cret@dpg-test0000000000000000-a/allied", "dpg-test0000000000000000-a"], // Render's internal form
  ["postgres://user:s3cret@dpg-test-a.singapore-postgres.render.invalid/allied", "dpg-test-a.singapore-postgres.render.invalid"],
  ["postgres://user@localhost/allied?host=db.invalid", "db.invalid"], // the query parameter wins
  ["postgres://user@localhost/allied?host=localhost&host=db.invalid", "db.invalid"], // the last one does
  ["postgres://localhost@db.invalid/allied", "db.invalid"], // "localhost" as the user name
  ["postgres://localhost.db.invalid/allied", "localhost.db.invalid"],
  ["postgres://127.0.0.2/allied", "127.0.0.2"],
  ["postgres://0.0.0.0/allied", "0.0.0.0"],
  ["/tmp allied", "/tmp"], // a socket is not one of the three hosts
  ["socket:/tmp?db=allied", "/tmp"],
  ["//db.invalid/allied", "//db.invalid/allied"], // node-postgres reads a leading / as a socket path
  ["not a connection string", null],
  // Only postgres:// and postgresql:// are read. For a special scheme the URL
  // parser reads "\" as "/" (host localhost) while pg-connection-string, which
  // encodes a string with a space first, sees the backslash as part of the
  // user name and connects to db.invalid: the two must never be asked to agree.
  ["https://localhost\\@db.invalid/allied?application_name=dev local", null],
  ["http://localhost/allied", null],
  ["mysql://localhost/allied", null],
  [" postgres://localhost/allied_dev", null], // pg reads this relative to postgres://base
  // pg encodes a string with a space or a stray "%" before parsing it, so an
  // escaped "host" key stays escaped for pg: the URL's own host is used.
  ["postgres://u:s3cret@db.invalid/allied?h%6Fst=localhost&application_name=dev local", "db.invalid"],
  ["postgresql://u:s3cret@db.invalid/allied?h%6Fst=localhost&x=%zz", "db.invalid"],
  ["postgres://u@%6cocalhost/allied?x=a b", "%6cocalhost"],
];

test("a database on this machine is accepted, by name or address", () => {
  for (const url of accepted) assert.equal(localDatabaseProblem(url, {}), null, url);
});

test("any other host is refused, named, and the password never appears", () => {
  for (const [url, host] of refused) {
    assert.equal(databaseHost(url, {}), host, url);
    const problem = localDatabaseProblem(url, {});
    assert.ok(problem, `${url} must be refused`);
    assert.match(problem, /^Refusing DATABASE_URL: /);
    assert.match(problem, host == null ? /its host can't be read/ : new RegExp(`its host is ${host.replace(/[.]/g, "\\.")}\\.`));
    assert.match(problem, /localhost, 127\.0\.0\.1, ::1/);
    assert.ok(!problem.includes("s3cret"), "the URL's password must not be echoed");
  }
});

test("no host in the URL means PGHOST, as node-postgres reads it", () => {
  assert.equal(databaseHost("postgres://anthony@/allied_dev", { PGHOST: "db.invalid" }), "db.invalid");
  assert.ok(localDatabaseProblem("postgres://anthony@/allied_dev", { PGHOST: "db.invalid" }));
  assert.equal(localDatabaseProblem("postgres://anthony@/allied_dev", { PGHOST: "127.0.0.1" }), null);
  // A host in the URL wins over PGHOST, as in node-postgres.
  assert.equal(databaseHost("postgres://localhost/allied_dev", { PGHOST: "db.invalid" }), "localhost");
});

test("the host read here is the one node-postgres would connect to", () => {
  // node-postgres' own reading, without a client, a pool or a socket.
  const ConnectionParameters = require("pg/lib/connection-parameters.js");
  const bare = (host: string) => host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const saved = process.env.PGHOST;
  try {
    for (const pghost of [undefined, "db.invalid"]) {
      if (pghost == null) delete process.env.PGHOST;
      else process.env.PGHOST = pghost;
      const urls = [...accepted, ...refused.filter(([, host]) => host != null).map(([url]) => url)];
      for (const url of urls) {
        const theirs = bare(new ConnectionParameters({ connectionString: url }).host);
        assert.equal(databaseHost(url, { PGHOST: pghost }), theirs, `${url} with PGHOST=${pghost ?? "(unset)"}`);
      }
    }
  } finally {
    if (saved == null) delete process.env.PGHOST;
    else process.env.PGHOST = saved;
  }
});

test("whatever the guard accepts, node-postgres reads as this machine too (thousands of tricky URLs)", () => {
  const ConnectionParameters = require("pg/lib/connection-parameters.js");
  const local = new Set(["localhost", "127.0.0.1", "::1"]);
  const bare = (host: string) => host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  const schemes = ["postgres://", "postgresql://", "POSTGRES://"];
  const users = ["", "u@", "u:s3cret@", "localhost@", "u%40x@"];
  const hosts = ["localhost", "LOCALHOST", "127.0.0.1", "[::1]", "", "db.invalid", "%6cocalhost", "localhost\\", "localhost.db.invalid"];
  const queries = ["", "?host=localhost", "?h%6Fst=localhost", "?host=db.invalid", "?host=%2Ftmp", "?host=localhost&host=db.invalid", "?host=db.invalid&host=localhost"];
  const tails = ["", "&x=a b", "&x=%zz", "&x=%4", "&x=%41"];
  const saved = process.env.PGHOST;
  let accepted = 0;
  let checked = 0;
  try {
    for (const pghost of [undefined, "db.invalid"]) {
      if (pghost == null) delete process.env.PGHOST;
      else process.env.PGHOST = pghost;
      for (const scheme of schemes) for (const user of users) for (const host of hosts) for (const query of queries) for (const tail of tails) {
        const rest = query ? query + tail : tail ? "?" + tail.slice(1) : "";
        const url = `${scheme}${user}${host}/allied${rest}`;
        let theirs: string;
        try {
          theirs = bare(String(new ConnectionParameters({ connectionString: url }).host));
        } catch {
          continue; // node-postgres can't read it either, so it can't connect anywhere
        }
        checked++;
        const ours = databaseHost(url, { PGHOST: pghost });
        if (ours != null) assert.equal(ours, theirs, `${url} with PGHOST=${pghost ?? "(unset)"}`);
        if (localDatabaseProblem(url, { PGHOST: pghost }) == null) {
          accepted++;
          assert.ok(local.has(theirs), `accepted ${url}, which node-postgres reads as ${theirs}`);
        }
      }
    }
  } finally {
    if (saved == null) delete process.env.PGHOST;
    else process.env.PGHOST = saved;
  }
  assert.ok(checked > 8000 && accepted > 500, `swept ${checked} URLs, ${accepted} accepted`);
});

test("off Render the sync interval is always 0; on Render it is SYNC_INTERVAL_HOURS as before", () => {
  assert.equal(syncIntervalHoursFor("6", true), 6);
  assert.equal(syncIntervalHoursFor("0.5", true), 0.5);
  assert.equal(syncIntervalHoursFor(undefined, true), 0);
  assert.equal(syncIntervalHoursFor("", true), 0);
  assert.equal(syncIntervalHoursFor("6", false), 0);
  assert.equal(syncIntervalHoursFor(undefined, false), 0);
});

test("off Render the MYOB key and secret count as absent", () => {
  const both = { MYOB_API_KEY: "k", MYOB_API_SECRET: "s" };
  assert.equal(myobCredentialsUsable(both, true), true);
  assert.equal(myobCredentialsUsable({ MYOB_API_KEY: "k", MYOB_API_SECRET: " " }, true), false);
  assert.equal(myobCredentialsUsable({ MYOB_API_KEY: "k" }, true), false);
  assert.equal(myobCredentialsUsable(both, false), false);
  assert.match(MYOB_OFF_HERE, /^MYOB is off on this machine, on purpose/);
});

/* ---------- the wiring, in a clean child process ---------- */

const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const src = (file: string) => new URL(`../src/${file}`, import.meta.url).href;

/** Runs `code` as an ES module under tsx, in `cwd`, with exactly `env` (plus PATH, HOME, TMPDIR). */
function runIsolated(code: string, env: Record<string, string>, cwd: string) {
  const base: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[name];
    if (value != null) base[name] = value;
  }
  return spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", code], {
    cwd,
    env: { ...base, ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
}

const probe = `
  const { config, onRender, hasMyobCredentials } = await import(${JSON.stringify(src("config.ts"))});
  const { getPool, hasDatabaseUrl } = await import(${JSON.stringify(src("db.ts"))});
  const attempt = (fn) => { try { return { value: fn() }; } catch (err) { return { error: err.message }; } };
  const key = attempt(() => config.myob.apiKey());
  const secret = attempt(() => config.myob.apiSecret());
  const pool = attempt(() => getPool());
  const out = {
    onRender,
    renderAfterDotenv: process.env.RENDER ?? null,
    keyInEnv: process.env.MYOB_API_KEY ?? null,
    hasMyobCredentials: hasMyobCredentials(),
    key,
    secret,
    syncIntervalHours: config.insights.syncIntervalHours,
    hasDatabaseUrl: hasDatabaseUrl(),
    poolError: pool.error ?? null,
    poolMade: Boolean(pool.value),
    poolClients: pool.value ? pool.value.totalCount : null,
  };
  if (pool.value) await pool.value.end();
  console.log(JSON.stringify(out));
`;

function parseProbe(result: ReturnType<typeof runIsolated>) {
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
}

test("off Render, even a .env that claims RENDER=true cannot switch the guard off", () => {
  const dir = mkdtempSync(join(tmpdir(), "local-guard-"));
  try {
    writeFileSync(
      join(dir, ".env"),
      [
        "RENDER=true",
        "DATABASE_URL=postgres://user:s3cret@db.invalid:5432/allied",
        "MYOB_API_KEY=key-from-dotenv",
        "MYOB_API_SECRET=secret-from-dotenv",
        "SYNC_INTERVAL_HOURS=6",
        "",
      ].join("\n"),
    );
    const out = parseProbe(runIsolated(probe, {}, dir));
    // dotenv did load the file...
    assert.equal(out.renderAfterDotenv, "true");
    assert.equal(out.keyInEnv, "key-from-dotenv");
    // ...and none of it counts.
    assert.equal(out.onRender, false);
    assert.equal(out.hasMyobCredentials, false);
    assert.deepEqual(out.key, { error: MYOB_OFF_HERE });
    assert.deepEqual(out.secret, { error: MYOB_OFF_HERE });
    assert.equal(out.syncIntervalHours, 0);
    assert.equal(out.hasDatabaseUrl, true);
    assert.equal(out.poolMade, false);
    assert.match(out.poolError, /^Refusing DATABASE_URL: its host is db\.invalid\./);
    assert.ok(!out.poolError.includes("s3cret"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("off Render, the local copy is accepted with sync and MYOB off", () => {
  const dir = mkdtempSync(join(tmpdir(), "local-guard-"));
  try {
    const out = parseProbe(
      runIsolated(
        probe,
        {
          DATABASE_URL: "postgres://anthony@localhost:5432/allied_dev",
          SYNC_INTERVAL_HOURS: "6",
          MYOB_API_KEY: "k",
          MYOB_API_SECRET: "s",
        },
        dir,
      ),
    );
    assert.equal(out.onRender, false);
    assert.equal(out.poolError, null);
    assert.equal(out.poolMade, true);
    assert.equal(out.poolClients, 0, "a pool connects on its first query, not before");
    assert.equal(out.syncIntervalHours, 0);
    assert.equal(out.hasMyobCredentials, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("on Render nothing changes: Render's own database, the sync interval and the MYOB key all stand", () => {
  const dir = mkdtempSync(join(tmpdir(), "local-guard-"));
  try {
    const out = parseProbe(
      runIsolated(
        probe,
        {
          RENDER: "true",
          DATABASE_URL: "postgres://user:s3cret@dpg-test0000000000000000-a/allied",
          SYNC_INTERVAL_HOURS: "6",
          MYOB_API_KEY: "k",
          MYOB_API_SECRET: "s",
        },
        dir,
      ),
    );
    assert.equal(out.onRender, true);
    assert.equal(out.poolError, null);
    assert.equal(out.poolMade, true);
    assert.equal(out.poolClients, 0, "a pool connects on its first query, not before");
    assert.equal(out.syncIntervalHours, 6);
    assert.equal(out.hasMyobCredentials, true);
    assert.deepEqual(out.key, { value: "k" });
    assert.deepEqual(out.secret, { value: "s" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("off Render the app refuses to boot on a database that isn't this machine's", () => {
  const dir = mkdtempSync(join(tmpdir(), "local-guard-"));
  try {
    const result = runIsolated(
      `await import(${JSON.stringify(src("index.ts"))});`,
      { DATABASE_URL: "postgres://user:s3cret@db.invalid:5432/allied", PORT: "0" },
      dir,
    );
    assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Failed to start server: Error: Refusing DATABASE_URL: its host is db\.invalid\./);
    assert.doesNotMatch(result.stdout, /listening/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("s3cret"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
