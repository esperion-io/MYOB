#!/usr/bin/env node
/**
 * Guard: MYOB's raw stock quantities may only be read by the sync that fetches
 * them, the schema that defines them, and the ledger that owns them.
 *
 * P0 fixed a bug where the product served month-old MYOB quantities. P1 replaced
 * those quantities with figures the platform computes itself. Both fixes are
 * undone the moment any other file reaches back to `qty_on_hand` and friends,
 * and that would be invisible in review — hence this check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = /\b(qty_on_hand|qty_committed|qty_available)\b/;
const ALLOWED = new Set([
  "src/sync/engine.ts",   // fetches them from MYOB
  "src/sync/schema.ts",   // defines the columns and item_position
  "src/insights/ledger.ts", // owns the conversion balance and comparisons
]);

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const offenders = [];
for (const file of [...walk("src"), ...walk("public")]) {
  if (!/\.(ts|js)$/.test(file)) continue;
  const rel = file.replace(/\\/g, "/");
  if (ALLOWED.has(rel)) continue;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (FORBIDDEN.test(line) && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*")) {
      offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
    }
  });
}

if (offenders.length) {
  console.error("MYOB raw stock quantities read outside the ledger boundary:\n");
  for (const o of offenders) console.error("  " + o);
  console.error(`\n${offenders.length} violation(s). Read from item_position (SQL) or the ledger module instead.`);
  process.exit(1);
}
console.log("ledger boundary intact: no raw MYOB quantities read outside the sync, schema and ledger.");

/*
 * Guard 2 (P7): embedded kit quantities are a VIEW of stock already counted
 * under the kit, never an addition to it.
 *
 * BN1675G holds 3,301 loose and 32,612 more inside BP1675G packs. Both figures
 * are right, and adding them overstates Allied's stock by NZ$40,509 — 4.7% of
 * the file. The rule that prevents it is that a unit is counted in the form it
 * is physically held in, which is a rule about arithmetic and so cannot be
 * enforced by types.
 *
 * What can be enforced is the blast radius: only the two kit modules and the
 * dashboard that displays them may touch these fields. Anything summing them
 * into a valuation, a cart total or an overview KPI has to come through here
 * first, which is the moment to think about it.
 */
const EMBEDDED = /\b(embeddedValue|embeddedUnits|kit_embedded_stock)\b/;
const EMBEDDED_ALLOWED = new Set([
  "src/insights/kits.ts",      // computes them
  "src/insights/kitPlan.ts",   // reconciles and reports them
  "src/sync/schema.ts",        // defines the view
  "public/dashboard.js",       // displays them, labelled
]);

const embedded = [];
for (const file of [...walk("src"), ...walk("public")]) {
  if (!/\.(ts|js)$/.test(file)) continue;
  const rel = file.replace(/\\/g, "/");
  if (EMBEDDED_ALLOWED.has(rel)) continue;
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const t = line.trimStart();
    if (EMBEDDED.test(line) && !t.startsWith("//") && !t.startsWith("*")) {
      embedded.push(`${rel}:${i + 1}  ${t.slice(0, 100)}`);
    }
  });
}

if (embedded.length) {
  console.error("\nEmbedded kit quantities used outside the kit modules:\n");
  for (const o of embedded) console.error("  " + o);
  console.error(
    `\n${embedded.length} violation(s). Those units are already counted as kits — ` +
      "adding them to a stock total double-counts. Report them through kitPlan.ts.",
  );
  process.exit(1);
}
console.log("kit counting rule intact: embedded quantities stay inside the kit modules.");
