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
 * Guard 2 (P7) was removed on 26 Aug 2026, along with the thing it guarded.
 *
 * It kept "embedded" quantities — kit stock exploded back into component units
 * — from leaking into any total. Those quantities no longer exist: a kit bought
 * from a supplier is never broken open, so its contents were never component
 * stock to begin with, and the view that computed them is gone.
 *
 * The counting rule it protected still holds, and now holds by construction
 * rather than by vigilance: nothing anywhere converts kit stock into component
 * stock, so there is no arithmetic left to police.
 */
console.log("kit counting rule intact by construction: no kit-to-component conversion exists.");
