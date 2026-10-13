/**
 * One on-order rule (1.2). Run with `npm test`.
 *
 * Before 1.2 five places read open purchase orders, each with its own copy of
 * "every line of every document MYOB calls Open, ordered minus received". That
 * copy counted MYOB's reversal documents, 194,147 phantom units on the 26 Aug
 * copy, and fixing four of the five would have left the fifth disagreeing with
 * the others on the same screen. From 1.2 every reader uses the fragments in
 * src/sync/openPo.ts. This scans src/ so a sixth reader, or a copy pasted back
 * in, fails the build instead of quietly reviving the phantom:
 *
 *   - any SQL that reads myob_purchase_orders and tests for status 'OPEN' must
 *     also use OPEN_PO_DOC (the one reader that lists every Open document, the
 *     Data & Sync list, does both on purpose: it shows which ones count);
 *   - the old line rule, GREATEST(COALESCE(l.qty ..., appears nowhere.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "src");
/** The rule's own definition tests status 'OPEN' by design. */
const DEFINITION = "src/sync/openPo.ts";

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) return tsFiles(full);
    return f.endsWith(".ts") ? [full] : [];
  });
}

/**
 * The parenthesised group around [lo, hi), or the template literal it sits in
 * when there is no enclosing group. Parentheses inside `${...}` are balanced,
 * so walking over an interpolation is safe; a backtick ends the walk.
 */
function enclosing(text: string, lo: number, hi: number): [number, number] {
  let start = 0;
  for (let i = lo - 1, depth = 0; i >= 0; i--) {
    const c = text[i];
    if (c === "`") { start = i + 1; break; }
    if (c === ")") depth++;
    else if (c === "(") {
      if (depth === 0) { start = i; break; }
      depth--;
    }
  }
  let end = text.length;
  for (let i = hi, depth = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "`") { end = i; break; }
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) { end = i + 1; break; }
      depth--;
    }
  }
  return [start, end];
}

/**
 * The query an 'OPEN' test belongs to: the nearest enclosing group that has a
 * FROM in it, so `(o.status = 'OPEN')` is judged by the query around it, not
 * by its own parentheses.
 */
function queryAround(text: string, at: number, len: number): string {
  let [lo, hi] = enclosing(text, at, at + len);
  while (!/\bFROM\b/i.test(text.slice(lo, hi)) && (lo > 0 || hi < text.length)) {
    const [nlo, nhi] = enclosing(text, lo, hi);
    if (nlo === lo && nhi === hi) break;
    [lo, hi] = [nlo, nhi];
  }
  return text.slice(lo, hi);
}

/** The query a phrase sits in; a phrase ending "(" names the group it opens. */
function queryAt(text: string, anchor: string): string {
  const at = text.indexOf(anchor);
  return anchor.endsWith("(")
    ? queryAround(text, at + anchor.length, 0)
    : queryAround(text, at, anchor.length);
}

/** Every 'OPEN' status test whose query reads myob_purchase_orders without OPEN_PO_DOC. */
function openPoViolations(text: string): number[] {
  const lines: number[] = [];
  for (const m of text.matchAll(/'open'/gi)) {
    const q = queryAround(text, m.index!, m[0].length);
    if (/\bmyob_purchase_orders\b/.test(q) && !/\bOPEN_PO_DOC\(/.test(q)) {
      lines.push(text.slice(0, m.index!).split("\n").length);
    }
  }
  return lines;
}

const OLD_LINE_RULE = /GREATEST\(\s*COALESCE\(\s*l\.qty/i;

test("open-po rule: the scanner catches the pre-1.2 readers and passes their 1.2 form", () => {
  // The itemDetail query and the Suppliers lateral as they were in 1.1.
  const itemPage = `pool.query(
    \`SELECT o.number, l.qty::float8 AS qty
     FROM myob_purchase_order_lines l JOIN myob_purchase_orders o ON o.uid = l.order_uid
     WHERE l.item_uid = $1 AND UPPER(COALESCE(o.status,'')) = 'OPEN'
     ORDER BY o.date DESC LIMIT 20\`)`;
  const lateral = `\`SELECT s.uid FROM myob_suppliers s
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS open_count FROM myob_purchase_orders o
      WHERE o.supplier_uid = s.uid AND (o.status = 'Open')
    ) po ON TRUE\``;
  assert.deepEqual(openPoViolations(itemPage), [4]);
  assert.deepEqual(openPoViolations(lateral), [4]);

  const fixed = itemPage.replace(`UPPER(COALESCE(o.status,'')) = 'OPEN'`, '${OPEN_PO_DOC("o")}');
  assert.deepEqual(openPoViolations(fixed), []);
  // A sale-order CTE beside a purchase-order one is judged on its own query.
  const twoCtes = `\`WITH c AS (
       SELECT 1 FROM myob_sale_order_lines l JOIN myob_sale_orders o ON o.uid = l.order_uid
       WHERE UPPER(COALESCE(o.status, '')) = 'OPEN'
     ), p AS (
       SELECT 1 FROM myob_purchase_order_lines l JOIN myob_purchase_orders o ON o.uid = l.order_uid
       WHERE \${OPEN_PO_DOC("o")}
     ) SELECT 1\``;
  assert.deepEqual(openPoViolations(twoCtes), []);
  assert.ok(OLD_LINE_RULE.test("SUM(GREATEST(COALESCE(l.qty,0) - COALESCE(l.received_qty,0), 0))"));
});

test("open-po rule: every SQL in src/ reading Open purchase orders uses OPEN_PO_DOC", () => {
  const bad: string[] = [];
  for (const file of tsFiles(SRC)) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === DEFINITION) continue;
    for (const line of openPoViolations(readFileSync(file, "utf8"))) bad.push(`${rel}:${line}`);
  }
  assert.deepEqual(bad, [], `Open purchase orders read without OPEN_PO_DOC (src/sync/openPo.ts) at:\n  ${bad.join("\n  ")}`);
});

test("open-po rule: the old line rule GREATEST(COALESCE(l.qty appears nowhere in src/", () => {
  const bad = tsFiles(SRC)
    .filter((f) => OLD_LINE_RULE.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(bad, [], `Use OUTSTANDING(l) from src/sync/openPo.ts instead, in: ${bad.join(", ")}`);
});

/*
 * The five readers the plan names, found by a phrase in each query. If one of
 * these anchors moves, update it here; the point is that none of the five can
 * drop the rule without this failing.
 */
const READERS: [file: string, anchor: string, what: string][] = [
  ["src/sync/schema.ts", "our_on_order AS (", "item_position_at on_order"],
  ["src/insights/ledger.ts", "our_on_order AS (", "ownedPositions on_order"],
  ["src/insights/queries.ts", "AS po_uid", "item page PO rows"],
  ["src/insights/queries.ts", "AS open_count", "Suppliers open POs"],
  ["src/insights/queries.ts", "COUNT(*)::int AS orders", "Overview open POs by region"],
];

test("open-po rule: the five open-PO readers each use OPEN_PO_DOC", () => {
  for (const [file, anchor, what] of READERS) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const at = text.indexOf(anchor);
    assert.ok(at >= 0, `${what}: anchor "${anchor}" not found in ${file}`);
    assert.equal(text.indexOf(anchor, at + 1), -1, `${what}: anchor "${anchor}" is not unique in ${file}`);
    const q = queryAt(text, anchor);
    assert.match(q, /myob_purchase_orders/, `${what}: anchor is not in the PO query`);
    assert.match(q, /OPEN_PO_DOC\("o"\)/, `${what}: does not use OPEN_PO_DOC`);
  }
  // On order itself also clamps each line the same way in both copies.
  for (const file of ["src/sync/schema.ts", "src/insights/ledger.ts"]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const q = queryAt(text, "our_on_order AS (");
    assert.match(q, /OUTSTANDING\("l"\)/, `${file}: on order does not use OUTSTANDING`);
    assert.match(q, /OUTSTANDING_LINE\("l"\)/, `${file}: on order does not use OUTSTANDING_LINE`);
  }
});
