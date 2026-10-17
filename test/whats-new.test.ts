/**
 * What's new, made for reading (1.17).
 *
 * Allied asked for What's new to be easier to read and understand. Each
 * release now leads with a plain headline, a short summary and whether any
 * figure changed, grouped by the day it shipped, with the full notes folded
 * away. These pin:
 *   - every release carries the headline, summary and figures flag, within
 *     the limits, and none leaks an internal word Allied wouldn't use;
 *   - the grouping, day labels and New marks;
 *   - the release check refuses an entry without them.
 * No DOM: whats-new.js is pure; dashboard.js is read from source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// @ts-ignore — plain browser module, no types
import * as wn from "../public/whats-new.js";
import { readDashboardRelease, releaseProblems, SUMMARY_MAX, TITLE_MAX } from "../scripts/check-release.mjs";

const ROOT = join(import.meta.dirname, "..");
const dashboard = readFileSync(join(ROOT, "public/dashboard.js"), "utf8");
const { releases } = readDashboardRelease(dashboard);

test("every release leads with a plain headline, a short summary and whether figures changed", () => {
  assert.ok(releases.length >= 18);
  for (const r of releases) {
    const at = `${r.version}`;
    assert.ok(r.title && r.title.length <= TITLE_MAX, `${at} title`);
    assert.ok(r.summary && r.summary.length <= SUMMARY_MAX, `${at} summary`);
    assert.equal(typeof r.numbersChanged, "boolean", `${at} numbersChanged`);
    if (r.numbersChanged) assert.ok(r.numbersShort, `${at} numbersShort`);
    // The words Allied read first carry no internal language.
    for (const text of [r.title, r.summary, r.numbersShort ?? ""]) {
      assert.doesNotMatch(text, /\b(stage \d|server|endpoint|API|UID|allow-list|golden|capture|sync floor)\b/i, `${at}: "${text}"`);
    }
    assert.doesNotMatch(r.title, /\b1\.\d+\b/, `${at} title names a version`);
  }
});

test("releases group by the day they shipped, newest first, with a day name", () => {
  const days = wn.releaseDays(releases);
  assert.equal(days.reduce((n: number, d: { releases: unknown[] }) => n + d.releases.length, 0), releases.length);
  for (let i = 1; i < days.length; i++) assert.ok(days[i - 1].date > days[i].date);
  assert.equal(wn.dayLabel("2026-10-18"), "Sunday 18 October 2026");
  assert.equal(wn.dayLabel("2026-10-14"), "Wednesday 14 October 2026");
  assert.equal(wn.dayLabel("not a date"), "not a date");
});

test("New marks what this browser hasn't seen; a first look marks only the newest day", () => {
  const list = [
    { version: "1.17.0", date: "2026-10-19" },
    { version: "1.16.0", date: "2026-10-18" },
    { version: "1.15.0", date: "2026-10-18" },
    { version: "1.10.0", date: "2026-10-14" },
    { version: "1.9.0", date: "2026-10-14" },
  ];
  assert.deepEqual([...wn.newVersions(list, null)], ["1.17.0"]);
  assert.deepEqual([...wn.newVersions(list, "1.15.0")], ["1.17.0", "1.16.0"]);
  assert.deepEqual([...wn.newVersions(list, "1.9.0")], ["1.17.0", "1.16.0", "1.15.0", "1.10.0"], "1.10 is newer than 1.9");
  assert.deepEqual([...wn.newVersions(list, "1.17.0")], []);
  assert.equal(wn.hasUnseen(list, null), true);
  assert.equal(wn.hasUnseen(list, "1.16.0"), true);
  assert.equal(wn.hasUnseen(list, "1.17.0"), false);
  assert.equal(wn.hasUnseen([], null), false);
});

test("headline, figures line and the fallbacks", () => {
  assert.equal(wn.releaseTitle({ title: "Purchasing: filters" }), "Purchasing: filters");
  assert.equal(wn.releaseTitle({ stage: "Stage 17: Purchasing by item filters" }), "Purchasing by item filters");
  assert.deepEqual(wn.figuresLine({ numbersChanged: false }), { tone: "ok", label: "No figures change", text: "" });
  assert.deepEqual(wn.figuresLine({ numbersChanged: true, numbersShort: "On order drops on 3 items." }), {
    tone: "warn",
    label: "Figures change",
    text: "On order drops on 3 items.",
  });
  assert.equal(wn.figuresLine({}), null);
});

test("the release check refuses an entry without its headline, summary or figures flag", () => {
  const base = { version: "1.1.0", date: "2026-10-13", stage: "Stage 1: x", title: "T", summary: "S", numbersChanged: false };
  const ok = releaseProblems({ pkgVersion: "1.1.0", uiVersion: "1.1.0", releases: [base] });
  assert.deepEqual(ok, []);
  const bad = (over: Record<string, unknown>) =>
    releaseProblems({ pkgVersion: "1.1.0", uiVersion: "1.1.0", releases: [{ ...base, ...over }] }).join("\n");
  assert.match(bad({ title: "" }), /has no title/);
  assert.match(bad({ title: "x".repeat(TITLE_MAX + 1) }), /title is \d+ characters/);
  assert.match(bad({ summary: undefined }), /has no summary/);
  assert.match(bad({ summary: "x".repeat(SUMMARY_MAX + 1) }), /summary is \d+ characters/);
  assert.match(bad({ numbersChanged: "no" }), /has no numbersChanged/);
  assert.match(bad({ numbersChanged: true }), /changes figures but has no numbersShort/);
});

test("dashboard.js draws What's new from whats-new.js and marks it seen on opening", () => {
  assert.match(dashboard, /import \{ figuresLine, hasUnseen, newVersions, releaseDays, releaseTitle \} from "\.\/whats-new\.js";/);
  assert.match(dashboard, /whatsNewHtml\(newVersions\(RELEASES, whatsNewSeen\(\)\)\)/);
  // Browser storage is read and written inside try/catch.
  assert.match(dashboard, /function whatsNewSeen\(\) \{\n  try \{\n    return localStorage\.getItem\(WHATS_NEW_SEEN\);/);
  assert.match(dashboard, /function markWhatsNewSeen\(\) \{\n  try \{\n    localStorage\.setItem\(WHATS_NEW_SEEN/);
  const open = dashboard.slice(dashboard.indexOf("function openWhatsNew("), dashboard.indexOf("function openWhatsNew(") + 400);
  assert.match(open, /markWhatsNewSeen\(\);/);
  // The full notes are still all there, folded away.
  const card = dashboard.slice(dashboard.indexOf("function releaseEntryHtml("), dashboard.indexOf("function whatsNewHtml("));
  for (const part of ["r.changes", "r.numbers", "r.check", "r.stage", "<details"]) assert.ok(card.includes(part), part);
});
