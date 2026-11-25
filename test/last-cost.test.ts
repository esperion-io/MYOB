/**
 * The cart's last cost is one line, always the same one (1.18). Run with
 * `npm test`.
 *
 * Before 1.18 the cart took each supplier's latest bill date and let Postgres
 * pick any line on it. On 25 Nov 2026 PWST15010T from Universal Corrosion
 * Coatings read 25.34375 on production and 25.33 on an identical copy (bill
 * 00023195, 12 Oct 2026, one line at each), and 11 item/supplier pairs had
 * such a tie. The cases below are those bills' own lines (src/insights/lastCost.ts
 * has the rule). The item page's Last price (purchase history) had the same
 * tie on the same pairs, and from 1.18 takes the same line.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  billLineCost,
  compareBillLines,
  lastCostKey,
  latestLines,
  pickLastCosts,
  type BillLineCost,
} from "../src/insights/lastCost.js";

const UCC = "02eacbca-4766-4c63-a5ec-cc7ac6206146"; // Universal Corrosion Coatings
const BREMICK = "BREMICK";
const JIAXING = "JIAXING";

function line(over: Partial<BillLineCost>): BillLineCost {
  return {
    itemUid: "ITEM",
    supplierUid: "SUPPLIER",
    unitPrice: 1,
    qty: 1,
    date: "2026-10-12T00:00:00Z",
    billNumber: "00023195",
    billUid: "BILL",
    idx: 0,
    ...over,
  };
}

function costOf(lines: BillLineCost[], itemUid: string, supplierUid: string): number | undefined {
  return pickLastCosts(lines).get(lastCostKey(itemUid, supplierUid));
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

// PWST15010T, bill 00023195 (12 Oct 2026): 408 rolls at 25.33 on line 4, 120 at 25.34375 on line 6.
const PWST = [
  line({ itemUid: "PWST15010T", supplierUid: UCC, billUid: "B23195", idx: 4, qty: 408, unitPrice: 25.33 }),
  line({ itemUid: "PWST15010T", supplierUid: UCC, billUid: "B23195", idx: 6, qty: 120, unitPrice: 25.34375 }),
];

test("two lines on the latest bill: the later line, whichever order they arrive in", () => {
  assert.equal(costOf(PWST, "PWST15010T", UCC), 25.34375);
  assert.equal(costOf([...PWST].reverse(), "PWST15010T", UCC), 25.34375);
});

test("two bills on the same day: the higher bill number", () => {
  // BN825G from Bremick: bills 00021129 and 00021229, both 14 Apr 2025.
  const bills = [
    line({ itemUid: "BN825G", supplierUid: BREMICK, date: "2025-04-14T00:00:00Z", billNumber: "00021229", billUid: "B21229", qty: 200, unitPrice: 0.1574 }),
    line({ itemUid: "BN825G", supplierUid: BREMICK, date: "2025-04-14T00:00:00Z", billNumber: "00021129", billUid: "B21129", qty: 200, unitPrice: 0.1246 }),
  ];
  assert.equal(costOf(bills, "BN825G", BREMICK), 0.1574);
  assert.equal(costOf([...bills].reverse(), "BN825G", BREMICK), 0.1574);
});

test("on the latest date, a line that bought something beats a later line that bought nothing", () => {
  // CTB12180S16 from Jiaxing Goodway, bill 00019682 (8 Aug 2024): 660 at 1.9987 on line 2, 0 at 1.48 on line 12.
  const bill = [
    line({ itemUid: "CTB12180S16", supplierUid: JIAXING, date: "2024-08-08T00:00:00Z", billNumber: "00019682", idx: 2, qty: 660, unitPrice: 1.9987 }),
    line({ itemUid: "CTB12180S16", supplierUid: JIAXING, date: "2024-08-08T00:00:00Z", billNumber: "00019682", idx: 12, qty: 0, unitPrice: 1.48 }),
  ];
  assert.equal(costOf(bill, "CTB12180S16", JIAXING), 1.9987);
  // A return line (qty below 0) ranks with the zero line.
  bill[1].qty = -5;
  assert.equal(costOf(bill, "CTB12180S16", JIAXING), 1.9987);
});

test("a later bill date always wins: the tie-break only chooses within the latest date", () => {
  const lines = [
    ...PWST,
    // An older bill with a higher number, a later line and more bought still loses.
    line({ itemUid: "PWST15010T", supplierUid: UCC, date: "2026-09-30T00:00:00Z", billNumber: "00099999", billUid: "OLD", idx: 99, qty: 5000, unitPrice: 30 }),
  ];
  assert.equal(costOf(lines, "PWST15010T", UCC), 25.34375);
  // And a newer one wins even with nothing bought: nothing is excluded that counted before.
  lines.push(line({ itemUid: "PWST15010T", supplierUid: UCC, date: "2026-11-01T00:00:00Z", billNumber: "00000001", billUid: "NEW", idx: 0, qty: 0, unitPrice: 26 }));
  assert.equal(costOf(lines, "PWST15010T", UCC), 26);
});

test("one price on the latest date reads as it always did", () => {
  // PWMHT3L-shaped, but at one price: whichever line is taken, the cost is the same.
  const lines = [0, 7, 8].map((idx) =>
    line({ itemUid: "PWMHT3L", supplierUid: UCC, date: "2025-12-15T00:00:00Z", billNumber: "00022007", idx, qty: 160, unitPrice: 29.3369 }),
  );
  assert.equal(costOf(lines, "PWMHT3L", UCC), 29.3369);
});

test("each supplier keeps its own last cost", () => {
  const lines = [
    ...PWST,
    line({ itemUid: "PWST15010T", supplierUid: "OTHER", date: "2026-11-20T00:00:00Z", unitPrice: 31 }),
    line({ itemUid: "OTHER-ITEM", supplierUid: UCC, date: "2026-11-20T00:00:00Z", unitPrice: 9 }),
  ];
  const costs = pickLastCosts(lines);
  assert.equal(costs.get(lastCostKey("PWST15010T", UCC)), 25.34375);
  assert.equal(costs.get(lastCostKey("PWST15010T", "OTHER")), 31);
  assert.equal(costs.get(lastCostKey("OTHER-ITEM", UCC)), 9);
  assert.equal(costs.size, 3);
});

test("bill numbers compare by their digits, and the bill uid settles a repeated number", () => {
  const day = "2026-10-12T00:00:00Z";
  const a = line({ date: day, billNumber: "999", billUid: "A", unitPrice: 1 });
  const b = line({ date: day, billNumber: "1000", billUid: "B", unitPrice: 2 });
  assert.ok(compareBillLines(b, a) > 0);
  // MYOB has held two documents under one number before (PO 00023268, 1.16).
  const c = line({ date: day, billNumber: "00023195", billUid: "C", unitPrice: 3 });
  const d = line({ date: day, billNumber: "00023195", billUid: "D", unitPrice: 4 });
  assert.equal(costOf([c, d], "ITEM", "SUPPLIER"), 4);
  assert.equal(costOf([d, c], "ITEM", "SUPPLIER"), 4);
  // An undated bill ranks below a dated one.
  assert.equal(costOf([line({ date: null, billUid: "E", unitPrice: 5 }), c], "ITEM", "SUPPLIER"), 3);
});

test("no two lines tie, so every arrival order gives the same last cost", () => {
  const day = "2026-10-12T00:00:00Z";
  const lines = [
    ...PWST,
    line({ itemUid: "PWST15010T", supplierUid: UCC, date: day, billNumber: "00023195", billUid: "B23195b", idx: 6, qty: 1, unitPrice: 25.4 }),
    line({ itemUid: "PWST15010T", supplierUid: UCC, date: day, billNumber: "00023194", billUid: "B23194", idx: 9, qty: 50, unitPrice: 25.1 }),
    line({ itemUid: "PWST15010T", supplierUid: UCC, date: day, billNumber: "00023196", billUid: "B23196", idx: 0, qty: 0, unitPrice: 25.9 }),
  ];
  const seen = new Set(permutations(lines).map((p) => costOf(p, "PWST15010T", UCC)));
  // 00023195 line 6 twice (bill uids B23195 and B23195b): the higher uid, B23195b.
  assert.deepEqual([...seen], [25.4]);
});

test("the item page takes the same line as the cart, but keeps its $0 lines", () => {
  // Same tie: the item page's Last price for PWST15010T is the cart's.
  assert.equal(latestLines(PWST).get(lastCostKey("PWST15010T", UCC))?.unitPrice, 25.34375);
  // Shaped on the catch-all item NOTE under Bremick (the 25 Nov copy): an older
  // priced line, then a later $0 one. The item page lists every line, so it
  // reads $0.00; the cart counts only lines priced above 0, so it costs 56.22.
  const note = [
    line({ itemUid: "NOTE", supplierUid: BREMICK, date: "2025-01-10T00:00:00Z", billNumber: "00020001", unitPrice: 56.22 }),
    line({ itemUid: "NOTE", supplierUid: BREMICK, date: "2025-06-10T00:00:00Z", billNumber: "00021001", unitPrice: 0 }),
  ];
  assert.equal(latestLines(note).get(lastCostKey("NOTE", BREMICK))?.unitPrice, 0);
  assert.equal(costOf(note.filter((l) => (l.unitPrice ?? 0) > 0), "NOTE", BREMICK), 56.22);
});

test("a row with no price reads as no price, not $0", () => {
  const r = { item_uid: "I", supplier_uid: "S", unit_price: null, qty: "2", date: null, number: null, bill_uid: "B", idx: 3 };
  assert.deepEqual(billLineCost(r), {
    itemUid: "I", supplierUid: "S", unitPrice: null, qty: 2, date: null, billNumber: null, billUid: "B", idx: 3,
  });
});

const SRC = fileURLToPath(new URL("../src", import.meta.url));
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return f.endsWith(".ts") ? [full] : [];
  });
}

test("the cart and the item page read last prices through lastCost.ts, with no tie-prone copy left", () => {
  const read = (f: string) => readFileSync(join(SRC, f), "utf8");
  assert.match(read("insights/cart.ts"), /pickLastCosts\(/);
  assert.match(read("insights/queries.ts"), /latestLines\(/);
  for (const file of tsFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /DISTINCT ON \(l\.item_uid, b\.supplier_uid\)/, file);
    assert.doesNotMatch(text, /ARRAY_AGG\(l\.unit_price/, file);
  }
});
