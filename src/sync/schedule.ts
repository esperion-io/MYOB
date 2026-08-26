import { config } from "../config.js";
import { businessDateOf } from "../insights/businessDate.js";

/**
 * When the sync runs, decided by Allied's clock rather than by ours.
 *
 * THE PROBLEM THIS REPLACES. The old scheduler was a plain
 * `setInterval(6 hours)` anchored to process start, so the times drifted with
 * every deploy: 03:37/09:37/15:37/21:37 NZ one week, 04:58/10:58/16:58/22:58
 * the next. That matters more than untidiness, because a daily position row
 * freezes in whatever state the LAST sync of its New Zealand day left it in.
 * Which sync that was, and therefore how much of the trading day the permanent
 * record captured, was decided by when someone happened to press deploy.
 *
 * So the schedule is now anchored to a fixed close time and counted backwards
 * in interval steps. With the defaults (23:45 close, 6 hours) that is
 * 23:45, 17:45, 11:45 and 05:45 New Zealand time, every day, regardless of
 * when the process started. The 23:45 run is the one that closes the day, and
 * it sits after Allied have stopped entering work.
 *
 * DST is handled by construction: each next run is resolved against the real
 * NZ wall clock rather than by adding fixed milliseconds, so the close time
 * stays at 23:45 local through both transitions.
 */

/** Minutes past NZ midnight for the run that closes each day. */
function closeMinutes(): number {
  const raw = config.insights.syncCloseTime;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return 23 * 60 + 45;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return 23 * 60 + 45;
  return h * 60 + min;
}

/** Wall-clock minutes past midnight, in the business timezone. */
export function businessMinutesOf(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: config.insights.businessTimeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // en-GB renders midnight as 24:00 in some ICU versions.
  return (hour % 24) * 60 + minute;
}

/**
 * Milliseconds until the next scheduled run.
 *
 * Walks forward a minute at a time from `from` — cheap, since the search is
 * bounded by one interval — and stops at the first minute that sits on the
 * schedule. Doing it against the local wall clock is what makes it correct
 * across a DST change, where a day is 23 or 25 hours long.
 */
export function msUntilNextRun(from: Date = new Date()): number {
  const stepMinutes = Math.max(1, Math.round(config.insights.syncIntervalHours * 60));
  const close = closeMinutes();
  const onSchedule = (minutes: number): boolean => {
    // Distance back to the close time, wrapped into a positive day.
    const delta = (close - minutes + 24 * 60) % (24 * 60);
    return delta % stepMinutes === 0;
  };

  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  for (let i = 1; i <= 24 * 60 + stepMinutes; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (onSchedule(businessMinutesOf(candidate))) {
      return candidate.getTime() - from.getTime();
    }
  }
  // Unreachable with a sane interval; fall back rather than stalling forever.
  return stepMinutes * 60_000;
}

/** The scheduled times, for logging so the operator can see the plan. */
export function scheduleDescription(): string {
  const stepMinutes = Math.max(1, Math.round(config.insights.syncIntervalHours * 60));
  const close = closeMinutes();
  const times: string[] = [];
  for (let m = close; times.length < Math.floor((24 * 60) / stepMinutes); m -= stepMinutes) {
    const wrapped = ((m % (24 * 60)) + 24 * 60) % (24 * 60);
    times.push(
      `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`,
    );
  }
  return `${times.reverse().join(", ")} ${config.insights.businessTimeZone}`;
}

/**
 * Whether enough time has passed since the last sync to justify one at boot.
 *
 * A deploy used to reset the interval and leave the data untouched for a full
 * six hours, because nothing ran at startup. This closes that window without
 * making every restart trigger a redundant full pull.
 */
export function shouldSyncOnBoot(lastSyncedAt: Date | null): boolean {
  if (!lastSyncedAt) return true;
  const stepMs = config.insights.syncIntervalHours * 60 * 60 * 1000;
  return Date.now() - lastSyncedAt.getTime() >= stepMs;
}

/** The business date an instant belongs to — re-exported for the scheduler. */
export { businessDateOf };
