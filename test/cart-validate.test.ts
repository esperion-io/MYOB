/**
 * Choosing the supplier on the row (1.8): what /cart/select and /cart/split
 * accept, and Undo keeping a typed quantity. Run with `npm test`.
 *
 * Before 1.8 /cart/select wrote whatever supplier uid it was sent and
 * /cart/split checked only that there were two parts, so a stale tab or a
 * typo could put an item with a supplier on file nowhere, or split it twice
 * to one supplier (one row, one part's quantity lost). The compare drawer
 * only ever sends the item's options, so everything a tab from before 1.8
 * sends still passes. The checks are pure, tested here on their own; the
 * routes run them before any write, which the source check at the foot pins.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { selectSupplierProblem, splitPartsProblem, type SupplierOption } from "../src/insights/cart.js";

const opt = (supplierUid: string, source: SupplierOption["source"], isPreferred = false): SupplierOption => ({
  supplierUid,
  supplierName: supplierUid,
  region: null,
  source,
  isPreferred,
});

// N24S16M on the 26 Aug copy: Shandong Tengda preferred, Tong Ming MYOB's
// primary, three more tagged; plus a supplier picked earlier and no longer on file.
const N24S16M = [
  opt("SHANDONG", "allied", true),
  opt("TONGMING", "myob"),
  opt("ANZOR", "allied"),
  opt("HOBSON", "allied"),
  opt("GONE", "picked"),
];

test("select: any supplier on file, or picked earlier, is accepted", () => {
  for (const o of N24S16M) assert.equal(selectSupplierProblem(N24S16M, o.supplierUid), null, o.supplierUid);
});

test("select: a made-up uid, a missing one, or an item with nothing on file is refused", () => {
  assert.match(selectSupplierProblem(N24S16M, "MADE-UP") ?? "", /not a supplier on file/);
  assert.match(selectSupplierProblem(N24S16M, "") ?? "", /supplierUid is required/);
  assert.match(selectSupplierProblem(N24S16M, undefined) ?? "", /supplierUid is required/);
  assert.match(selectSupplierProblem(N24S16M, 42) ?? "", /supplierUid is required/);
  // No supplier on file, or ruled none: loadSourcing offers nothing at all.
  assert.match(selectSupplierProblem([], "SHANDONG") ?? "", /no supplier on file/);
  // "none" is the No known supplier placeholder, never a supplier to choose.
  assert.match(selectSupplierProblem(N24S16M, "none") ?? "", /not a supplier on file/);
});

test("split: what the compare drawer sends passes", () => {
  // The drawer sends every box with a quantity above 0, at least two of them.
  assert.equal(splitPartsProblem(N24S16M, [{ supplierUid: "SHANDONG", qty: 1380 }, { supplierUid: "TONGMING", qty: 1380 }]), null);
  assert.equal(splitPartsProblem(N24S16M, [{ supplierUid: "ANZOR", qty: 0.5 }, { supplierUid: "HOBSON", qty: 7 }, { supplierUid: "GONE", qty: 3 }]), null);
  // Zero is a quantity of zero or more; the drawer drops it, the API allows it.
  assert.equal(splitPartsProblem(N24S16M, [{ supplierUid: "SHANDONG", qty: 0 }, { supplierUid: "TONGMING", qty: 10 }]), null);
});

test("split: fewer than two parts, a supplier twice, or one not on file is refused", () => {
  assert.match(splitPartsProblem(N24S16M, []) ?? "", /at least two parts/);
  assert.match(splitPartsProblem(N24S16M, [{ supplierUid: "SHANDONG", qty: 5 }]) ?? "", /at least two parts/);
  assert.match(splitPartsProblem(N24S16M, "SHANDONG,TONGMING") ?? "", /at least two parts/);
  assert.match(
    splitPartsProblem(N24S16M, [{ supplierUid: "SHANDONG", qty: 5 }, { supplierUid: "SHANDONG", qty: 5 }]) ?? "",
    /only once/,
  );
  assert.match(
    splitPartsProblem(N24S16M, [{ supplierUid: "SHANDONG", qty: 5 }, { supplierUid: "MADE-UP", qty: 5 }]) ?? "",
    /not a supplier on file/,
  );
  assert.match(splitPartsProblem([], [{ supplierUid: "A", qty: 1 }, { supplierUid: "B", qty: 1 }]) ?? "", /not a supplier on file/);
});

test("split: every qty must be a finite number of zero or more", () => {
  for (const qty of [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) {
    assert.match(
      splitPartsProblem(N24S16M, [{ supplierUid: "SHANDONG", qty: 5 }, { supplierUid: "TONGMING", qty }]) ?? "",
      /qty of zero or more/,
      String(qty),
    );
  }
  assert.match(splitPartsProblem(N24S16M, [{ supplierUid: "SHANDONG", qty: 5 }, null]) ?? "", /needs a supplierUid/);
  assert.match(splitPartsProblem(N24S16M, [{ supplierUid: "SHANDONG", qty: 5 }, { qty: 5 }]) ?? "", /needs a supplierUid/);
});

/** The body of one `insightsRouter.post(path, …)` handler, up to the next route. */
function route(src: string, path: string): string {
  const start = src.indexOf(`insightsRouter.post("${path}"`);
  assert.ok(start >= 0, `${path} route not found`);
  const next = src.indexOf("insightsRouter.", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

test("routes: select and split check against the item's options before writing", () => {
  const src = readFileSync(new URL("../src/routes/insights.ts", import.meta.url), "utf8");
  const select = route(src, "/cart/select");
  assert.ok(select.indexOf("selectSupplierProblem(await cartSupplierOptions(itemUid)") >= 0);
  assert.ok(select.indexOf("selectSupplierProblem") < select.indexOf("selectCartSupplier("), "checked before the write");
  assert.match(select, /res\.status\(400\)\.json\(\{ error: problem \}\)/);
  const split = route(src, "/cart/split");
  assert.ok(split.indexOf("splitPartsProblem(await cartSupplierOptions(itemUid)") >= 0);
  assert.ok(split.indexOf("splitPartsProblem") < split.indexOf("splitCartItem("), "checked before the write");
  assert.match(split, /res\.status\(400\)\.json\(\{ error: problem \}\)/);
});

test("cartSupplierOptions is the Order list's own option set (loadSourcing)", () => {
  const src = readFileSync(new URL("../src/insights/cart.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function cartSupplierOptions"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /loadSourcing\(getPool\(\), \[itemUid\]\)\)\.optionsFor\(itemUid\)/);
});

test("undo keeps the typed qty on show, under the default supplier, in the same write", () => {
  const src = readFileSync(new URL("../src/insights/cart.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function undoCartDecision"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  // One cartWrite, so the one undo_decision entry's before and after carry it.
  assert.equal(body.match(/cartWrite\(/g)?.length, 1);
  assert.match(body, /cartWrite\(itemUid, "undo_decision"/);
  // Read before the rows go; re-read after, so a picked-only supplier is no default.
  const keep = body.indexOf("typedQtyOnShow(plan)");
  const del = body.indexOf("DELETE FROM platform_purchase_cart");
  const reread = body.indexOf("loadSourcing(client, [itemUid])");
  const ins = body.indexOf("INSERT INTO platform_purchase_cart");
  assert.ok(keep >= 0 && keep < del && del < reread && reread < ins, "read qty, delete, re-read options, insert");
  assert.match(body, /'edited'/);
});
