/*
 * What's new, made for reading (1.17).
 *
 * Allied asked for What's new to be easier to read. Before 1.17 it was every
 * release's full notes in one column: 17 releases, about 6,000 words, each
 * headed by its internal stage label. Each release now carries a plain
 * headline (`title`), a one- or two-sentence `summary`, and whether any
 * figure moved (`numbersChanged`, with `numbersShort`); the full notes fold
 * away beneath. Releases are grouped by the day they shipped, and the ones
 * shipped since this browser last opened What's new are marked New.
 *
 * DOM-free, like order-list.js, so test/whats-new.test.ts can import it;
 * dashboard.js turns these models into HTML.
 */
import { compareVersions } from "./release-banner.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Sunday 18 October 2026" for a yyyy-mm-dd date, the same in every time zone. */
export function dayLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? "");
  if (!m) return date ?? "";
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return `${DAYS[weekday]} ${d} ${MONTHS[mo - 1]} ${y}`;
}

/** The releases grouped by the day they shipped, newest day first, in the order given within a day. */
export function releaseDays(releases) {
  const days = [];
  for (const r of releases ?? []) {
    const last = days[days.length - 1];
    if (last && last.date === r.date) last.releases.push(r);
    else days.push({ date: r.date, label: dayLabel(r.date), releases: [r] });
  }
  return days;
}

/** The headline: the release's own, else its stage without the "Stage N:" reference. */
export function releaseTitle(r) {
  if (r?.title) return r.title;
  return String(r?.stage ?? `Version ${r?.version ?? ""}`).replace(/^Stage \d+:\s*/, "");
}

/** The one line on figures: did any number Allied see move, and the gist. */
export function figuresLine(r) {
  if (r?.numbersChanged === true) return { tone: "warn", label: "Figures change", text: r.numbersShort ?? r.numbers ?? "" };
  if (r?.numbersChanged === false) return { tone: "ok", label: "No figures change", text: "" };
  return null;
}

/*
 * Which releases are New to this browser: those newer than the last version
 * it showed What's new for. A browser that has never opened it marks the
 * newest day's releases only, so the first look isn't seventeen New badges.
 */
export function newVersions(releases, seenVersion) {
  const list = releases ?? [];
  if (!list.length) return new Set();
  if (!seenVersion) return new Set(list.filter((r) => r.date === list[0].date).map((r) => r.version));
  return new Set(list.filter((r) => compareVersions(r.version, seenVersion) > 0).map((r) => r.version));
}

/** True when the newest release is one this browser hasn't shown What's new for. */
export function hasUnseen(releases, seenVersion) {
  const newest = releases?.[0]?.version;
  if (!newest) return false;
  return !seenVersion || compareVersions(newest, seenVersion) > 0;
}
