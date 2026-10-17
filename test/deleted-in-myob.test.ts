/**
 * Records deleted in MYOB leave the mirror (1.16).
 *
 * Allied asked why PO 00023248 (Steel & Tube, 600 × BN12150LTG), raised and
 * then deleted in MYOB when the supplier couldn't supply, still counted as on
 * order here. The sync only ever upserted what MYOB sent, so a deletion was
 * never seen. These pin the rules that now remove such records:
 *   - only a complete fetch (no filter, or the floor's Date filter) is
 *     checked; a LastModified fetch says nothing about deletions;
 *   - a record goes only when it is missing from two complete fetches in a
 *     row, so one that slipped between pages comes back first;
 *   - more missing than the limit removes nothing (a short answer from MYOB
 *     looks like a mass deletion), and items are only ever reported;
 *   - every document entity the sync fetches whole is checked, sale orders
 *     are now fetched whole, and removed rows are archived before deletion.
 * No database: planRemoval is pure, the wiring is read from source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ABSENT_LIMIT, completeFetch, planRemoval, previousAbsent } from "../src/sync/reconcile.js";

const ROOT = join(import.meta.dirname, "..");
const engine = readFileSync(join(ROOT, "src/sync/engine.ts"), "utf8");
const schema = readFileSync(join(ROOT, "src/sync/schema.ts"), "utf8");

const uids = (n: number, prefix = "po") => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, "0")}`);

test("only a complete fetch is checked for deletions", () => {
  assert.equal(completeFetch(undefined), true, "items: no filter");
  assert.equal(completeFetch("Date ge datetime'2024-07-01T00:00:00'"), true);
  assert.equal(completeFetch("LastModified gt datetime'2026-10-16T01:18:37'"), false);
  assert.equal(completeFetch(""), false);
});

test("a record is removed only when two complete fetches in a row miss it", () => {
  // 1,377 held, MYOB sends 1,375: 00023248 and 00023268 are gone.
  const held = uids(1377);
  const gone = [held[100], held[200]];
  const seen = new Set(held.filter((u) => !gone.includes(u)));

  // First check after the deploy: nothing to confirm against, nothing removed.
  const first = planRemoval(held, seen, null, true);
  assert.deepEqual(first.absent, gone);
  assert.deepEqual(first.remove, []);
  assert.equal(first.skipped, null);

  // Next sync, still missing: removed.
  const second = planRemoval(held, seen, first.absent, true);
  assert.deepEqual(second.remove, gone);

  // One that slipped between pages on one fetch and is back on the next: never removed.
  const blip = planRemoval(held, new Set(held), first.absent, true);
  assert.deepEqual(blip.absent, []);
  assert.deepEqual(blip.remove, []);

  // Missing now but not last time: waits a sync.
  const newly = planRemoval(held, seen, [held[100]], true);
  assert.deepEqual(newly.remove, [held[100]]);
  assert.deepEqual(newly.absent, gone);

  // previousAbsent reads the block a run left; a skipped check left none.
  assert.deepEqual(previousAbsent({ purchase_orders: { reconcile: { absent: gone } } }, "purchase_orders"), gone);
  assert.equal(previousAbsent({ purchase_orders: { reconcile: { skipped: "…", absentCount: 900 } } }, "purchase_orders"), null);
  assert.equal(previousAbsent({ purchase_orders: { fetched: 1375 } }, "purchase_orders"), null);
  assert.equal(previousAbsent(null, "purchase_orders"), null);
});

test("more missing than the limit removes nothing, and says so", () => {
  const held = uids(1377);
  const limit = Math.max(ABSENT_LIMIT.min, Math.ceil(1377 * ABSENT_LIMIT.share));
  assert.equal(limit, 28);
  // MYOB answers with nothing at all: every row would look deleted.
  const empty = planRemoval(held, new Set(), held, true);
  assert.deepEqual(empty.remove, []);
  assert.match(empty.skipped ?? "", /^1377 of 1377 missing from MYOB's answer, more than the 28 one sync may remove; nothing removed$/);
  // At the limit it acts; one over, it doesn't.
  const atLimit = held.slice(0, limit);
  assert.equal(planRemoval(held, new Set(held.slice(limit)), atLimit, true).remove.length, limit);
  assert.equal(planRemoval(held, new Set(held.slice(limit + 1)), held.slice(0, limit + 1), true).remove.length, 0);
  // A small table still gets ABSENT_LIMIT.min.
  assert.equal(planRemoval(uids(5), new Set(), uids(5), true).remove.length, 5);
});

test("items are reported, never removed", () => {
  const held = uids(3105, "item");
  const seen = new Set(held.slice(4));
  const plan = planRemoval(held, seen, held.slice(0, 4), false);
  assert.equal(plan.absent.length, 4);
  assert.deepEqual(plan.remove, []);
  assert.match(engine, /reconcile: \{ table: "myob_items", windowed: false, remove: false \}/);
});

test("the sync checks every document it fetches whole, after the fetch, before sync_state", () => {
  for (const [table, lines, key] of [
    ["myob_sale_invoices", "myob_sale_invoice_lines", "invoice_uid"],
    ["myob_sale_orders", "myob_sale_order_lines", "order_uid"],
    ["myob_purchase_bills", "myob_purchase_bill_lines", "bill_uid"],
    ["myob_purchase_orders", "myob_purchase_order_lines", "order_uid"],
    ["myob_builds", "myob_build_lines", "build_uid"],
    ["myob_adjustments", "myob_adjustment_lines", "adjustment_uid"],
  ]) {
    assert.match(
      engine,
      new RegExp(`reconcile: \\{ table: "${table}", lineTable: "${lines}", lineKey: "${key}", windowed: true, remove: true \\}`),
      `${table} is not reconciled`,
    );
  }
  // Sale orders are fetched whole from 1.16, so a deleted one stops counting as committed.
  const so = engine.slice(engine.indexOf('entity: "sale_orders"'), engine.indexOf('entity: "purchase_bills"'));
  assert.match(so, /alwaysFull: true,/);
  // Every uid MYOB sent is collected, and cleared with the rows on an $expand retry.
  assert.match(engine, /const uid = str\(it\.UID\);\n      if \(uid\) seen\.add\(uid\);/);
  assert.match(engine, /maxModified = null;\n    seen\.clear\(\);/);
  // Checked only after a complete fetch, and before sync_state counts the rows.
  const body = engine.slice(engine.indexOf("async function syncEntity("), engine.indexOf("function entityCountTable("));
  const check = body.indexOf("if (spec.reconcile && completeFetch(filter))");
  assert.ok(check > body.indexOf("myobGetAllPages(connection, spec.path, { filter, onPage })"));
  assert.ok(check < body.indexOf("INSERT INTO sync_state"));
  // A check, never a gate: a failure is recorded and the sync goes on.
  assert.match(body, /try \{\n      reconcile = await reconcileAbsent\(pool, spec\.entity, spec\.reconcile, seen, runId\);\n    \} catch \(err\) \{\n      reconcile = \{ error:/);
  // Archived, then lines, then headers, in one transaction; confirmed against the last check.
  const rec = engine.slice(engine.indexOf("async function reconcileAbsent("));
  const order = ["BEGIN", "INSERT INTO myob_removed_docs", "DELETE FROM ${rc.lineTable}", "DELETE FROM ${rc.table}", "COMMIT"].map((s) => rec.indexOf(s));
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] >= 0 && order[i - 1] < order[i], "archive, lines, headers, in one transaction");
  assert.match(rec, /WHERE status = 'success' AND stats -> \$1 -> 'reconcile' IS NOT NULL/);
  assert.match(rec, /WHERE date >= \$1::timestamptz \+ INTERVAL '1 day'/);
  // The archive is additive DDL.
  assert.match(schema, /CREATE TABLE IF NOT EXISTS myob_removed_docs \(/);
});

test("SYNC_REMOVE_DELETED=off makes every check report only, leaving nothing to confirm", () => {
  const config = readFileSync(join(ROOT, "src/config.ts"), "utf8");
  assert.match(config, /removeDeleted: !\/\^\(0\|false\|off\|no\)\$\/i\.test\(process\.env\.SYNC_REMOVE_DELETED \?\? ""\),/);
  const rec = engine.slice(engine.indexOf("export async function reconcileAbsent("));
  assert.match(rec, /const removing = rc\.remove && config\.insights\.removeDeleted;/);
  assert.match(rec, /planRemoval\(\[\.\.\.numberOf\.keys\(\)\], seen, previousAbsent\(last\.rows\[0\]\?\.stats \?\? null, entity\), removing\)/);
  // Only a removing check leaves its list for the next sync to confirm.
  assert.match(rec, /\.\.\.\(plan\.skipped \? \{ skipped: plan\.skipped \} : removing \? \{ absent: plan\.absent \} : \{\}\),/);
  for (const v of ["off", "0", "false", "NO"]) assert.ok(/^(0|false|off|no)$/i.test(v));
  for (const v of ["", "on", "1", "true"]) assert.ok(!/^(0|false|off|no)$/i.test(v));
});
