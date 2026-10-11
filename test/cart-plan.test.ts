/**
 * The Order list's per-item decision, tested on the cases found in Allied's
 * live data on 10 Oct 2026. Run with `npm test`.
 *
 * Two rules matter above all: an undecided item is listed once, under its
 * preferred supplier; and nothing Allied already decided in the cart is
 * overridden by that default.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKUP_TABLES } from "../src/sync/schema.js";
import {
  NO_SUPPLIER,
  SUPPLIER_ROLE,
  orderSupplierOptions,
  planItemLines,
  type CartState,
  type SavedDecision,
  type SupplierOption,
} from "../src/insights/cart.js";

const opt = (
  supplierUid: string,
  source: SupplierOption["source"],
  isPreferred = false,
): SupplierOption => ({ supplierUid, supplierName: supplierUid, region: null, source, isPreferred });

const saved = (entries: Record<string, [CartState, number?]>) =>
  new Map<string, SavedDecision>(
    Object.entries(entries).map(([uid, [state, qty]]) => [uid, { state, qty: qty ?? null, note: null }]),
  );

const listed = (plan: ReturnType<typeof planItemLines>) => plan.lines.map((l) => l.option.supplierUid);

test("BN16475G: listed once, under the preferred supplier, not MYOB's or the top biller", () => {
  const plan = planItemLines(
    [opt("HANOVA", "allied", true), opt("SHANGHAI SCREW-FAST", "myob"), opt("TANDL", "inferred")],
    saved({}),
  );
  assert.deepEqual(listed(plan), ["HANOVA"]);
  assert.equal(plan.lines[0].option.isPreferred, true);
  assert.equal(plan.conflict, null);
  assert.equal(plan.decided, false);
});

test("WR12242.5S16: MYOB's old primary supplier is no longer a second line", () => {
  const plan = planItemLines([opt("TONG MING", "allied", true), opt("INOX-MARE", "myob")], saved({}));
  assert.deepEqual(listed(plan), ["TONG MING"]);
});

test("a later change of preferred supplier moves the item straight away", () => {
  const before = planItemLines([opt("HANOVA", "allied", true), opt("ASMUSS", "allied")], saved({}));
  const after = planItemLines([opt("ASMUSS", "allied", true), opt("HANOVA", "allied")], saved({}));
  assert.deepEqual(listed(before), ["HANOVA"]);
  assert.deepEqual(listed(after), ["ASMUSS"]);
});

test("FG150P: an earlier pick of another supplier is kept, and flagged", () => {
  const plan = planItemLines(
    [opt("SKELLERUP", "allied", true), opt("SPECIALISED WASHERS", "allied")],
    saved({ "SPECIALISED WASHERS": ["selected"] }),
  );
  assert.deepEqual(listed(plan), ["SPECIALISED WASHERS"]);
  assert.equal(plan.decided, true);
  assert.equal(plan.conflict?.kind, "pick");
  assert.equal(plan.conflict?.preferredSupplierUid, "SKELLERUP");
  assert.equal(plan.conflict?.acknowledged, false);
});

test("FG150P after Keep: still kept, warning quietened for this preferred supplier only", () => {
  const options = [opt("SKELLERUP", "allied", true), opt("SPECIALISED WASHERS", "allied")];
  const decisions = saved({ "SPECIALISED WASHERS": ["selected"] });
  assert.equal(planItemLines(options, decisions, "SKELLERUP").conflict?.acknowledged, true);
  // Keep was given for a different preferred supplier: the warning comes back.
  assert.equal(planItemLines(options, decisions, "SOMEONE ELSE").conflict?.acknowledged, false);
});

test("TB12135S16: a pick at quantity 0 on MYOB's supplier keeps its 0", () => {
  const plan = planItemLines(
    [opt("SHANDONG TENGDA", "allied", true), opt("Jiaxing Goodway", "myob")],
    saved({ "Jiaxing Goodway": ["selected", 0] }),
  );
  assert.deepEqual(listed(plan), ["Jiaxing Goodway"]);
  assert.equal(plan.lines[0].saved?.qty, 0);
  assert.equal(plan.conflict?.kind, "pick");
});

test("the 44 hand-chosen items: choosing the preferred supplier stays chosen, no warning", () => {
  const plan = planItemLines(
    [opt("HANOVA", "allied", true), opt("SHANGHAI SCREW-FAST", "myob")],
    saved({ HANOVA: ["selected"] }),
  );
  assert.deepEqual(listed(plan), ["HANOVA"]);
  assert.equal(plan.lines[0].saved?.state, "selected");
  assert.equal(plan.conflict, null);
});

test("FG250P: a split that includes the preferred supplier stands, both lines, no warning", () => {
  const plan = planItemLines(
    [opt("SKELLERUP", "allied", true), opt("SPECIALISED WASHERS", "allied")],
    saved({ SKELLERUP: ["split", 142], "SPECIALISED WASHERS": ["split", 142] }),
  );
  assert.deepEqual(listed(plan).sort(), ["SKELLERUP", "SPECIALISED WASHERS"]);
  assert.equal(plan.decided, true);
  assert.equal(plan.conflict, null);
});

test("a split that leaves the preferred supplier out stands, and is flagged", () => {
  const plan = planItemLines(
    [opt("P", "allied", true), opt("A", "myob"), opt("B", "inferred")],
    saved({ A: ["split", 10], B: ["split", 5] }),
  );
  assert.deepEqual(listed(plan), ["A", "B"]);
  assert.equal(plan.conflict?.kind, "split");
});

test("a struck preferred line stays struck; the item moves to the next supplier and says why", () => {
  const plan = planItemLines([opt("P", "allied", true), opt("M", "myob")], saved({ P: ["removed"] }));
  assert.deepEqual(listed(plan), ["M"]);
  assert.equal(plan.conflict?.kind, "removed");
});

test("a struck non-preferred line changes nothing", () => {
  const plan = planItemLines([opt("P", "allied", true), opt("M", "myob")], saved({ M: ["removed"] }));
  assert.deepEqual(listed(plan), ["P"]);
  assert.equal(plan.conflict, null);
});

test("every line struck: the item stays off the list, as before", () => {
  const plan = planItemLines([opt("P", "allied", true), opt("M", "myob")], saved({ P: ["removed"], M: ["removed"] }));
  assert.deepEqual(listed(plan), []);
});

test("a quantity typed on the preferred line is kept", () => {
  const plan = planItemLines([opt("P", "allied", true), opt("M", "myob")], saved({ P: ["edited", 500] }));
  assert.deepEqual(listed(plan), ["P"]);
  assert.equal(plan.lines[0].saved?.qty, 500);
});

test("a quantity typed under another supplier follows the item, with no second line", () => {
  const plan = planItemLines([opt("P", "allied", true), opt("M", "myob")], saved({ M: ["edited", 50] }));
  assert.deepEqual(listed(plan), ["P"]);
  assert.deepEqual(plan.lines[0].carried, { qty: 50, fromSupplierUid: "M" });
  assert.equal(plan.conflict, null);
});

test("typed qty, then the preferred supplier changes: the item moves and keeps the number", () => {
  // Typed 500 while P was preferred; Allied then make Q preferred on the item page.
  const plan = planItemLines(
    [opt("Q", "allied", true), opt("P", "allied"), opt("M", "myob")],
    saved({ P: ["edited", 500] }),
  );
  assert.deepEqual(listed(plan), ["Q"]);
  assert.equal(plan.lines[0].carried?.qty, 500);
});

test("a quantity typed under a supplier no longer on file still follows the item", () => {
  const plan = planItemLines([opt("Q", "allied", true)], saved({ GONE: ["edited", 12] }));
  assert.deepEqual(listed(plan), ["Q"]);
  assert.deepEqual(plan.lines[0].carried, { qty: 12, fromSupplierUid: "GONE" });
});

test("the line's own typed quantity wins over one typed elsewhere", () => {
  const plan = planItemLines([opt("P", "allied", true), opt("M", "myob")], saved({ P: ["edited", 7], M: ["edited", 50] }));
  assert.equal(plan.lines[0].saved?.qty, 7);
  assert.equal(plan.lines[0].carried, null);
});

test("a pick on a supplier no longer on file is kept and flagged, never a default", () => {
  const options = orderSupplierOptions([
    { supplierUid: "Q", supplierName: "Q", region: null, role: SUPPLIER_ROLE.preferred, tagged: true, isPreferred: true },
    { supplierUid: "OLD", supplierName: "OLD", region: null, role: SUPPLIER_ROLE.picked, tagged: false, isPreferred: false },
  ]);
  assert.equal(options[1].source, "picked");
  const kept = planItemLines(options, saved({ OLD: ["selected"] }));
  assert.deepEqual(listed(kept), ["OLD"]);
  assert.equal(kept.conflict?.kind, "pick");
  // Without the pick, the off-file supplier is never where the item goes.
  assert.deepEqual(listed(planItemLines(options, saved({ Q: ["removed"] }))), []);
});

test("nothing undecided ever produces two lines", () => {
  const options = [opt("P", "allied", true), opt("M", "myob"), opt("B", "inferred"), opt("T", "allied")];
  const states: CartState[] = ["edited", "removed", "suggested"];
  for (const a of states)
    for (const b of states)
      for (const c of states) {
        const plan = planItemLines(options, saved({ P: [a, 1], M: [b, 2], B: [c, 3] }));
        assert.ok(plan.lines.length <= 1, `${a}/${b}/${c} gave ${plan.lines.length} lines`);
      }
});

test("no preferred supplier: one line under MYOB's supplier, not under the top biller too", () => {
  const plan = planItemLines([opt("M", "myob"), opt("B", "inferred")], saved({}));
  assert.deepEqual(listed(plan), ["M"]);
  assert.equal(plan.conflict, null);
});

test("no supplier at all (or ruled none): the item stays visible under No known supplier", () => {
  const plan = planItemLines([], saved({}));
  assert.deepEqual(listed(plan), [NO_SUPPLIER.supplierUid]);
  assert.deepEqual(listed(planItemLines([], saved({ none: ["removed"] }))), []);
});

test("fallback order: preferred, then MYOB primary, then top biller, then other tags", () => {
  const options = orderSupplierOptions([
    { supplierUid: "TAG", supplierName: "Alpha", region: null, role: SUPPLIER_ROLE.tag, tagged: true, isPreferred: false },
    { supplierUid: "BILLER", supplierName: "Bravo", region: null, role: SUPPLIER_ROLE.biller, tagged: false, isPreferred: false },
    { supplierUid: "MYOB", supplierName: "Charlie", region: null, role: SUPPLIER_ROLE.myob, tagged: false, isPreferred: false },
    { supplierUid: "PREF", supplierName: "Delta", region: null, role: SUPPLIER_ROLE.preferred, tagged: true, isPreferred: true },
  ]);
  assert.deepEqual(options.map((o) => o.supplierUid), ["PREF", "MYOB", "BILLER", "TAG"]);
  assert.deepEqual(options.map((o) => o.source), ["allied", "myob", "inferred", "allied"]);
});

test("a MYOB primary that Allied also tagged keeps its MYOB place but shows as Allied's", () => {
  const [first] = orderSupplierOptions([
    { supplierUid: "X", supplierName: "X", region: null, role: SUPPLIER_ROLE.myob, tagged: true, isPreferred: false },
    { supplierUid: "Y", supplierName: "Y", region: null, role: SUPPLIER_ROLE.biller, tagged: false, isPreferred: false },
  ]);
  assert.equal(first.supplierUid, "X");
  assert.equal(first.source, "allied");
});

test("most recent typed quantity wins, wherever it was typed", () => {
  const at = (state: CartState, qty: number, updatedAt: number): SavedDecision => ({ state, qty, note: null, updatedAt });
  const options = [opt("P", "allied", true), opt("M", "myob"), opt("T", "allied")];
  // Own older 650 on P, newer 700 typed under T: 700 shows.
  const newer = planItemLines(options, new Map([["P", at("edited", 650, 1)], ["T", at("edited", 700, 2)]]));
  assert.deepEqual(newer.lines[0].carried, { qty: 700, fromSupplierUid: "T" });
  // Own newer 600 on P beats an older 500 typed under M.
  const own = planItemLines(options, new Map([["M", at("edited", 500, 1)], ["P", at("edited", 600, 2)]]));
  assert.equal(own.lines[0].carried, null);
  assert.equal(own.lines[0].saved?.qty, 600);
});

test("a typed quantity never follows an item onto No known supplier", () => {
  const plan = planItemLines([], saved({ GONE: ["edited", 12] }));
  assert.equal(plan.lines[0].carried, null);
});

test("the rollback script backs up exactly the tables the app backs up", () => {
  const script = readFileSync(new URL("../scripts/supplier-rollback.mjs", import.meta.url), "utf8");
  const block = script.match(/const TABLES = \{([\s\S]*?)\};/)?.[1] ?? "";
  const tables = Object.fromEntries([...block.matchAll(/(\w+): "(\w+)"/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(tables, BACKUP_TABLES);
});
