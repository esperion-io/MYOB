/**
 * Records deleted in MYOB leave the mirror (1.16).
 *
 * Until 1.16 the sync only ever added and updated: it upserted what MYOB sent
 * and never asked what MYOB had stopped sending. A purchase order deleted in
 * MYOB therefore stayed here exactly as last seen, Open with nothing
 * received, and kept counting as stock on order forever. Allied found one:
 * Steel & Tube 00023248 (28 Sep 2026, 600 × BN12150LTG) was raised, the
 * supplier couldn't supply, and it was deleted in MYOB. MYOB's own on order
 * dropped by 600; ours didn't. Hobson 00023268 (1,050 BN12150LTG, 225
 * N24S16M, 20,000 WR16301.5S16) is the same. On 17 Oct 2026 NZ production
 * held 1,377 purchase orders where MYOB returned 1,375, 2,053 bills where it
 * returned 2,052, and 3,105 items where it returned 3,101. (26 Aug review
 * D11 named the gap; nothing closed it.)
 *
 * The fix rests on one fact about a fetch: when an entity is fetched without
 * a LastModified filter, MYOB has sent every record it holds from the sync
 * floor on, so a record we hold in that range that it did not send is gone
 * from MYOB (deleted, or moved out of the Item layout we read, which takes
 * its stock lines with it). Purchase orders, bills, builds and adjustments
 * are fetched that way on every sync, sale orders from 1.16 too, and sale
 * invoices on a full sync. An incremental (LastModified) fetch proves
 * nothing about absence and is never reconciled.
 *
 * Removal is deliberately slow and reversible:
 *   - a record must be missing from two complete fetches in a row (this one
 *     and the last successful sync that checked the entity), so a record that
 *     slipped between pages while MYOB was being edited is never removed:
 *     the next sync, six hours later, brings it back before it can go;
 *   - when more are missing than ABSENT_LIMIT allows, nothing is removed and
 *     the sync says so: a short answer from MYOB looks exactly like a mass
 *     deletion, and Allied do not delete hundreds of documents;
 *   - rows dated within a day of the floor are left alone, so a time zone
 *     can never put a record on the wrong side of it;
 *   - every removed header and its lines are copied to myob_removed_docs
 *     first, in the same transaction as the delete.
 * Items are checked and reported, never removed: platform tables (minimums,
 * suppliers, tags, the Order list) refer to them.
 *
 * Nothing else changes. Past daily snapshots keep what they recorded.
 */

/** How many absent records one sync may remove: at least `min`, or `share` of those checked. */
export const ABSENT_LIMIT = { min: 10, share: 0.02 } as const;

export interface ReconcileSpec {
  /** Header table, keyed by `uid`. */
  table: string;
  /** Line table and its column naming the header, when the entity has lines. */
  lineTable?: string;
  lineKey?: string;
  /** Rows carry a `date` and only those on or after the sync floor were fetched. */
  windowed: boolean;
  /** Remove confirmed absences (documents); false only reports them (items). */
  remove: boolean;
}

export interface RemovalPlan {
  /** Held here, inside the range MYOB was asked for, not sent by MYOB this time. */
  absent: string[];
  /** Absent this time and at the last complete check: removed now. */
  remove: string[];
  /** Why nothing was removed although records are absent, or null. */
  skipped: string | null;
  limit: number;
}

/**
 * What a complete fetch says to remove. Pure. `checked` are the uids held
 * in the fetched range, `seen` the uids MYOB sent, `previous` the uids absent
 * at the last complete check (null when there was none, or it was skipped).
 */
export function planRemoval(
  checked: readonly string[],
  seen: ReadonlySet<string>,
  previous: readonly string[] | null,
  remove: boolean,
): RemovalPlan {
  const absent = checked.filter((u) => !seen.has(u)).sort();
  const limit = Math.max(ABSENT_LIMIT.min, Math.ceil(checked.length * ABSENT_LIMIT.share));
  if (absent.length > limit) {
    return {
      absent,
      remove: [],
      skipped: `${absent.length} of ${checked.length} missing from MYOB's answer, more than the ${limit} one sync may remove; nothing removed`,
      limit,
    };
  }
  if (!remove) return { absent, remove: [], skipped: null, limit };
  const before = new Set(previous ?? []);
  return { absent, remove: absent.filter((u) => before.has(u)), skipped: null, limit };
}

/**
 * True when a fetch with this $filter returned every record MYOB holds in
 * the range asked for: no filter (items), or the sync floor's Date filter.
 * A LastModified filter returns only what changed, so absence means nothing.
 */
export function completeFetch(filter: string | undefined): boolean {
  return filter === undefined || filter.startsWith("Date ge ");
}

/** The reconcile block a sync run records under stats[entity].reconcile. */
export interface ReconcileStats {
  /** Rows held in the fetched range. */
  checked: number;
  /** Absent uids, kept for the next sync to confirm; left out when skipped. */
  absent?: string[];
  absentCount: number;
  /** Document numbers (item numbers for items) of the absent rows, for people. */
  absentNumbers: string[];
  removed: number;
  removedNumbers: string[];
  skipped?: string;
  /** SYNC_REMOVE_DELETED is off: listed, nothing removed, nothing left to confirm. */
  reportOnly?: boolean;
}

/**
 * The absent list a sync left for `entity`, from the newest successful run
 * that checked it. A skipped check leaves none, so it confirms nothing.
 */
export function previousAbsent(stats: unknown, entity: string): string[] | null {
  const block = (stats as Record<string, { reconcile?: ReconcileStats }> | null)?.[entity]?.reconcile;
  return Array.isArray(block?.absent) ? block.absent.map(String) : null;
}
