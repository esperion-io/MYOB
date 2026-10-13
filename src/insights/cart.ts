import { businessToday } from "./businessDate.js";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";
import { cartStateAll, cartStateOf, inTransaction, logChange } from "./changeLog.js";
import { supplierLeadTimes } from "./leadTimes.js";
import type { SupplierLead } from "./leadTimes.js";
import type { Gap } from "./projection.js";
import { suggestedMinimum } from "./minStock.js";
import {
  computedItems,
  leadSourceLabel,
  resolveWindow,
  snapshotState,
  suggestionInputs,
  suggestOrderQty,
  type DemandWindow,
  type ItemComputed,
} from "./queries.js";

/**
 * The purchasing cart (P5 + P6).
 *
 * Each item needing an order is listed ONCE, under its preferred supplier — the
 * one Allied mark on the item page. Only when no preferred supplier is set does
 * it fall back to MYOB's primary supplier, then to whoever has billed it most:
 * the same precedence as the effective supplier everywhere else on the
 * dashboard. Every other supplier on file stays one click away in the compare
 * drawer, to switch to or to split with.
 *
 * This replaces a fan-out that listed every item under every supplier it could
 * find — every Allied tag, MYOB's primary and the top biller — as equal,
 * undecided lines. It read is_preferred and never used it. After Allied's
 * September supplier sheet moved items to new factories, 100 of the 179 items
 * with a preferred supplier still sat under their old suppliers too, which is
 * what Allied reported as "preferred suppliers not pulling through".
 *
 * Decisions Allied have already made are never overridden. A supplier chosen in
 * the cart, a split, an edited quantity or a struck line all stand. Where one
 * disagrees with the preferred supplier it is kept and flagged, and Allied
 * either keep it or switch with one click. The default is derived on every
 * read, never stored, so changing the preferred supplier later moves the item
 * straight away.
 */

export type CartState = "suggested" | "edited" | "removed" | "selected" | "split";

/** One supplier an item could be ordered from. */
export interface SupplierOption {
  supplierUid: string;
  supplierName: string | null;
  region: string | null;
  /**
   * "allied" = recorded on the item page; "myob" = MYOB primary; "inferred" =
   * top biller; "picked" = no longer on file, but chosen for this item in the
   * cart earlier — kept so that choice is never dropped silently.
   */
  source: "allied" | "myob" | "inferred" | "picked";
  isPreferred: boolean;
}

export interface SavedDecision {
  qty: number | null;
  state: CartState;
  note: string | null;
  /** When it was saved (ms), so the most recent typed quantity wins. */
  updatedAt?: number | null;
}

/**
 * A saved cart decision that disagrees with the preferred supplier.
 *  - pick:    the item was chosen for another supplier
 *  - split:   a split that leaves the preferred supplier out
 *  - removed: the preferred supplier's line was struck earlier
 */
export type PickConflictKind = "pick" | "split" | "removed";

export interface PickConflict {
  kind: PickConflictKind;
  preferredSupplierUid: string;
  preferredSupplierName: string | null;
  /** Allied pressed "Keep" for this preferred supplier; shown quietly, not as a warning. */
  acknowledged: boolean;
}

export interface PlannedLine {
  option: SupplierOption;
  saved: SavedDecision | undefined;
  /**
   * A quantity Allied typed while the item sat under another supplier. A typed
   * quantity is a decision about how many, not who from, so it follows the item
   * to whichever supplier it is under now.
   */
  carried: { qty: number; fromSupplierUid: string } | null;
}

export interface ItemPlan {
  lines: PlannedLine[];
  /** Where the item goes with no cart decision: the preferred supplier, else the fallback. */
  defaultSupplierUid: string | null;
  preferred: SupplierOption | null;
  /** A supplier was chosen or a split recorded. */
  decided: boolean;
  conflict: PickConflict | null;
}

/** The placeholder bucket for an item with no supplier at all. */
export const NO_SUPPLIER: SupplierOption = {
  supplierUid: "none",
  supplierName: null,
  region: null,
  source: "inferred",
  isPreferred: false,
};

/*
 * Suppliers on file for an item, in the order it falls back through them. The
 * first three are the effective-supplier precedence used everywhere else on
 * the dashboard: Allied's preferred supplier, then MYOB's primary, then the top
 * biller. Other suppliers tagged on the item page come next — alternates Allied
 * recorded, offered to compare against, and the default only when nothing else
 * is known. Last, a supplier the item was chosen for in the cart that is no
 * longer on file at all: never a default, there only so the choice survives.
 */
export const SUPPLIER_ROLE = { preferred: 0, myob: 1, biller: 2, tag: 3, picked: 4 } as const;

export interface OnFileSupplier {
  supplierUid: string;
  supplierName: string | null;
  region: string | null;
  /** Lowest SUPPLIER_ROLE this supplier holds for the item. */
  role: number;
  /** Recorded on the item page, preferred or not. */
  tagged: boolean;
  isPreferred: boolean;
}

export function orderSupplierOptions(entries: OnFileSupplier[]): SupplierOption[] {
  const sourceOf = (e: OnFileSupplier): SupplierOption["source"] =>
    e.tagged
      ? "allied"
      : e.role === SUPPLIER_ROLE.myob
        ? "myob"
        : e.role === SUPPLIER_ROLE.biller
          ? "inferred"
          : "picked";
  return [...entries]
    .sort((a, b) => a.role - b.role || (a.supplierName ?? "").localeCompare(b.supplierName ?? ""))
    .map((e) => ({
      supplierUid: e.supplierUid,
      supplierName: e.supplierName,
      region: e.region,
      source: sourceOf(e),
      isPreferred: e.isPreferred,
    }));
}

/**
 * Which lines one item gets, from the suppliers it could come from (in
 * precedence order) and the decisions saved against them. Pure, so it can be
 * tested on its own.
 *
 * An item is listed once. Only a deliberate split puts it under more than one
 * supplier. Saved decisions are honoured: a supplier chosen in the cart stays
 * chosen, a struck line stays struck, a typed quantity stays typed. What
 * changed is the default — one line under the first supplier in precedence
 * instead of a line under every one of them.
 */
export function planItemLines(
  options: SupplierOption[],
  saved: Map<string, SavedDecision>,
  ackedPreferredUid: string | null = null,
): ItemPlan {
  const preferred = options.find((o) => o.isPreferred) ?? null;
  const conflictOf = (kind: PickConflictKind): PickConflict | null =>
    preferred
      ? {
          kind,
          preferredSupplierUid: preferred.supplierUid,
          preferredSupplierName: preferred.supplierName,
          acknowledged: ackedPreferredUid === preferred.supplierUid,
        }
      : null;
  const savedFor = (o: SupplierOption) => saved.get(o.supplierUid);

  /*
   * The quantity Allied typed for the item most recently, whichever supplier
   * it sat under at the time. A typed quantity is a decision about how many,
   * not who from, so it follows the item: change the preferred supplier and the
   * item moves, keeping the number — instead of sitting under both suppliers.
   * The newest one wins, so an older number never replaces a newer one; ties
   * (rows saved before times were compared) go by supplier precedence.
   */
  const lastTyped = (() => {
    const rank = (uid: string) => {
      const i = options.findIndex((o) => o.supplierUid === uid);
      return i < 0 ? options.length : i;
    };
    let best: { qty: number; supplierUid: string; at: number; rank: number } | null = null;
    for (const [uid, d] of saved) {
      if (uid === NO_SUPPLIER.supplierUid || d.state !== "edited" || d.qty == null) continue;
      const at = d.updatedAt ?? Number.NEGATIVE_INFINITY;
      const r = rank(uid);
      if (!best || at > best.at || (at === best.at && r < best.rank)) best = { qty: d.qty, supplierUid: uid, at, rank: r };
    }
    return best;
  })();
  const lineFor = (o: SupplierOption): PlannedLine => ({
    option: o,
    saved: savedFor(o),
    carried:
      lastTyped && lastTyped.supplierUid !== o.supplierUid
        ? { qty: lastTyped.qty, fromSupplierUid: lastTyped.supplierUid }
        : null,
  });

  // No supplier on file, or Allied have ruled there is none: keep the item
  // visible rather than dropping it — having none is itself the finding.
  if (!options.length) {
    const s = saved.get(NO_SUPPLIER.supplierUid);
    return {
      // Only a quantity typed on this line itself: one typed under a supplier
      // before Allied ruled there is none does not follow it here.
      lines: s?.state === "removed" ? [] : [{ option: NO_SUPPLIER, saved: s, carried: null }],
      defaultSupplierUid: null,
      preferred: null,
      decided: false,
      conflict: null,
    };
  }

  // A supplier chosen in the cart, or a deliberate split, is Allied's decision
  // and stands as made — even where it disagrees with the preferred supplier.
  const selected = options.find((o) => savedFor(o)?.state === "selected");
  const splits = options.filter((o) => savedFor(o)?.state === "split");
  if (selected || splits.length) {
    const chosen = [...(selected ? [selected] : []), ...splits.filter((o) => o !== selected)];
    const includesPreferred = preferred != null && chosen.some((o) => o === preferred);
    return {
      lines: chosen.map((o) => ({ option: o, saved: savedFor(o), carried: null })),
      defaultSupplierUid: options[0].supplierUid,
      preferred,
      decided: true,
      conflict: preferred && !includesPreferred ? conflictOf(selected ? "pick" : "split") : null,
    };
  }

  // Undecided: one line, under the first supplier in precedence that has not
  // been struck off. A line struck earlier stays struck; if that was the
  // preferred supplier's, the item moves to the next one and says why.
  const first = options[0];
  const live = options.find((o) => o.source !== "picked" && savedFor(o)?.state !== "removed") ?? null;
  return {
    lines: live ? [lineFor(live)] : [],
    defaultSupplierUid: first.supplierUid,
    preferred,
    decided: false,
    conflict: live && live !== first && first === preferred ? conflictOf("removed") : null,
  };
}

/**
 * Everything that decides where an item goes, for a set of items: the
 * suppliers it could come from (in fallback order) and the decisions saved
 * against them. Shared by the Order list and by the actions that must agree
 * with what it shows (Put back, Use preferred, Choose).
 *
 * Suppliers on file are Allied's tags, MYOB's primary and whoever has billed
 * the item most, plus any supplier it was chosen or split to in the cart that
 * is no longer on file — so that choice is kept and flagged, never dropped.
 * All of them skip items Allied have ruled have no supplier, or a supplier
 * they removed would reappear as an option.
 */
export async function loadSourcing(db: Pick<PoolClient, "query">, uids: string[]) {
  const q = (sql: string) => db.query(sql, [uids]);
  // One after another: `db` may be a single transaction's client.
  const tagged = await q(
    `SELECT ps.item_uid, ps.supplier_uid, s.name AS supplier_name, m.region, ps.is_preferred
     FROM platform_item_suppliers ps
     JOIN myob_suppliers s ON s.uid = ps.supplier_uid
     LEFT JOIN platform_supplier_meta m ON m.supplier_uid = ps.supplier_uid
     WHERE ps.item_uid = ANY($1)
       AND NOT EXISTS (SELECT 1 FROM platform_item_no_supplier n WHERE n.item_uid = ps.item_uid)`,
  );
  const primaries = await q(
    `SELECT i.uid AS item_uid, i.primary_supplier_uid AS supplier_uid, s.name AS supplier_name, m.region
     FROM myob_items i
     JOIN myob_suppliers s ON s.uid = i.primary_supplier_uid
     LEFT JOIN platform_supplier_meta m ON m.supplier_uid = i.primary_supplier_uid
     WHERE i.uid = ANY($1) AND i.primary_supplier_uid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM platform_item_no_supplier n WHERE n.item_uid = i.uid)`,
  );
  const billed = await q(
    `SELECT DISTINCT ON (l.item_uid) l.item_uid, b.supplier_uid, s.name AS supplier_name, m.region
     FROM myob_purchase_bill_lines l
     JOIN myob_purchase_bills b ON b.uid = l.bill_uid
     JOIN myob_suppliers s ON s.uid = b.supplier_uid
     LEFT JOIN platform_supplier_meta m ON m.supplier_uid = b.supplier_uid
     WHERE l.item_uid = ANY($1) AND b.supplier_uid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM platform_item_no_supplier n WHERE n.item_uid = l.item_uid)
     GROUP BY l.item_uid, b.supplier_uid, s.name, m.region
     ORDER BY l.item_uid, SUM(COALESCE(l.total, 0)) DESC`,
  );
  const picked = await q(
    `SELECT c.item_uid, c.supplier_uid, s.name AS supplier_name, m.region
     FROM platform_purchase_cart c
     LEFT JOIN myob_suppliers s ON s.uid = c.supplier_uid
     LEFT JOIN platform_supplier_meta m ON m.supplier_uid = c.supplier_uid
     WHERE c.item_uid = ANY($1) AND c.state IN ('selected', 'split') AND c.supplier_uid <> 'none'
       AND NOT EXISTS (SELECT 1 FROM platform_item_no_supplier n WHERE n.item_uid = c.item_uid)`,
  );
  const cart = await q(`SELECT * FROM platform_purchase_cart WHERE item_uid = ANY($1)`);
  const acks = await q(`SELECT item_uid, preferred_supplier_uid FROM platform_cart_pick_ack WHERE item_uid = ANY($1)`);
  const offs = await q(`SELECT item_uid FROM platform_cart_item_off WHERE item_uid = ANY($1)`);
  const names = await db.query(`SELECT uid, name FROM myob_suppliers`);

  const savedByItem = new Map<string, Map<string, SavedDecision>>();
  for (const r of cart.rows) {
    const m = savedByItem.get(r.item_uid as string) ?? new Map<string, SavedDecision>();
    m.set(r.supplier_uid as string, {
      qty: r.qty as number | null,
      state: r.state as CartState,
      note: r.note as string | null,
      updatedAt: r.updated_at ? new Date(r.updated_at as string).getTime() : null,
    });
    savedByItem.set(r.item_uid as string, m);
  }
  const ackByItem = new Map(acks.rows.map((r) => [r.item_uid as string, r.preferred_supplier_uid as string]));

  const onFile = new Map<string, Map<string, OnFileSupplier>>();
  const note = (r: Record<string, unknown>, role: number, tagged: boolean, isPreferred: boolean) => {
    const itemUid = r.item_uid as string;
    const m = onFile.get(itemUid) ?? new Map<string, OnFileSupplier>();
    const uid = r.supplier_uid as string;
    const e = m.get(uid);
    if (e) {
      e.role = Math.min(e.role, role);
      e.tagged ||= tagged;
      e.isPreferred ||= isPreferred;
    } else {
      m.set(uid, {
        supplierUid: uid,
        supplierName: r.supplier_name as string | null,
        region: r.region as string | null,
        role,
        tagged,
        isPreferred,
      });
    }
    onFile.set(itemUid, m);
  };
  for (const r of tagged.rows)
    note(r, r.is_preferred ? SUPPLIER_ROLE.preferred : SUPPLIER_ROLE.tag, true, Boolean(r.is_preferred));
  for (const r of primaries.rows) note(r, SUPPLIER_ROLE.myob, false, false);
  for (const r of billed.rows) note(r, SUPPLIER_ROLE.biller, false, false);
  for (const r of picked.rows) note(r, SUPPLIER_ROLE.picked, false, false);

  return {
    optionsFor: (itemUid: string): SupplierOption[] =>
      orderSupplierOptions([...(onFile.get(itemUid)?.values() ?? [])]),
    savedFor: (itemUid: string) => savedByItem.get(itemUid) ?? new Map<string, SavedDecision>(),
    ackFor: (itemUid: string) => ackByItem.get(itemUid) ?? null,
    takenOff: new Set(offs.rows.map((r) => r.item_uid as string)),
    supplierName: new Map(names.rows.map((r) => [r.uid as string, r.name as string | null])),
  };
}

/*
 * The suppliers an item can be put with on the Order list (1.8): exactly the
 * options the Order list offers it — on file (Allied's tags, MYOB's primary,
 * the top biller) plus any supplier it was already chosen or split to here.
 * /cart/select and /cart/split check against this before writing anything.
 * They used to accept any uid at all, so a stale tab or a typo could put an
 * item with a supplier that is on file nowhere, where only "picked earlier"
 * would ever explain it. The compare drawer only ever offers these, so a tab
 * from before 1.8 never meets the check.
 */
export async function cartSupplierOptions(itemUid: string): Promise<SupplierOption[]> {
  await ensureInsightsSchema();
  return (await loadSourcing(getPool(), [itemUid])).optionsFor(itemUid);
}

const NOT_ON_FILE =
  "is not a supplier on file for this item. Add it on the item page first, then choose it here.";

/** Why /cart/select must refuse this supplier for an item with these options, or null. */
export function selectSupplierProblem(options: SupplierOption[], supplierUid: unknown): string | null {
  if (typeof supplierUid !== "string" || !supplierUid) return "supplierUid is required.";
  if (!options.length) return "This item has no supplier on file to choose. Add one on the item page first.";
  if (!options.some((o) => o.supplierUid === supplierUid)) return `That supplier ${NOT_ON_FILE}`;
  return null;
}

/**
 * Why /cart/split must refuse these parts, or null: at least two, each a
 * different supplier on file for the item, each with a quantity of zero or
 * more. A supplier twice would write one row and drop the other part's qty.
 */
export function splitPartsProblem(options: SupplierOption[], parts: unknown): string | null {
  if (!Array.isArray(parts) || parts.length < 2) return "A split needs at least two parts.";
  const seen = new Set<string>();
  for (const p of parts as unknown[]) {
    const { supplierUid, qty } = (p ?? {}) as { supplierUid?: unknown; qty?: unknown };
    if (typeof supplierUid !== "string" || !supplierUid) return "Every part of a split needs a supplierUid.";
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 0)
      return "Every part of a split needs a qty of zero or more.";
    if (seen.has(supplierUid)) return "A supplier can appear only once in a split.";
    seen.add(supplierUid);
    if (!options.some((o) => o.supplierUid === supplierUid)) return `A supplier in this split ${NOT_ON_FILE}`;
  }
  return null;
}

/** One item's plan exactly as the Order list would show it. */
async function planFor(db: Pick<PoolClient, "query">, itemUid: string) {
  const s = await loadSourcing(db, [itemUid]);
  return {
    plan: planItemLines(s.optionsFor(itemUid), s.savedFor(itemUid), s.ackFor(itemUid)),
    takenOff: s.takenOff.has(itemUid),
  };
}

/** A line's copy of its item's gap (1.11): all of it but the weekly series. */
function lineGap(gap: Gap | null): Omit<Gap, "weeks"> | null {
  if (!gap) return null;
  const { weeks: _series, ...line } = gap;
  return line;
}

/** A lead time as one cart line or compare option shows it. */
export interface LineLead {
  days: number | null;
  setByAllied: boolean;
  orders: number;
  sameDayExcluded: number;
  /** "item": set on the item page; "supplier": on the Suppliers page; "measured": their orders' median. */
  source: "item" | "supplier" | "measured";
}

/*
 * The lead time shown against one supplier for one item (1.12). Allied
 * answered Q5 (12–14 Oct): the suggested qty should match whichever supplier
 * they pick. Q2b was not answered directly; our reading of that answer is
 * that a lead set on an item is for its usual supplier.
 *
 * Until 1.12 a lead Allied set on the item page applied under every supplier
 * the item was offered from, so N24S16M (107 days on the item, prod) read 107
 * under Tong Ming too, against Tong Ming's own 45. Now the item's figure
 * applies only under its usual (effective) supplier, the one computeItem
 * builds the suggestion on; any other supplier shows its own figure, Allied's
 * from the Suppliers page, else the measured median (leadTimes.ts), else none.
 *
 * An item with no usual supplier at all (none on file, or ruled none) keeps
 * its own lead on every line, as before: there is no supplier it is "not the
 * usual one" for, and its "No known supplier" line is the one the suggestion
 * is built for.
 *
 * From 1.13 the suggested quantity of a line under any other supplier is
 * rebuilt on this lead (supplierSuggestion); the usual supplier's line keeps
 * the item's own suggestion. ETAs never read it (incoming.ts uses the PO
 * supplier's lead).
 */
export function leadForSupplier(
  item: Pick<ItemComputed, "leadTimeItemDays" | "supplierUid">,
  supplierUid: string,
  supplierLead: Map<string, Pick<SupplierLead, "days" | "setByAllied" | "orders" | "sameDayExcluded">>,
): LineLead | undefined {
  const usual = item.supplierUid == null || supplierUid === item.supplierUid;
  if (item.leadTimeItemDays != null && usual)
    return { days: item.leadTimeItemDays, setByAllied: true, orders: 0, sameDayExcluded: 0, source: "item" };
  const s = supplierLead.get(supplierUid);
  if (!s) return undefined;
  return {
    days: s.days,
    setByAllied: s.setByAllied,
    orders: s.orders,
    sameDayExcluded: s.sameDayExcluded,
    source: s.setByAllied ? "supplier" : "measured",
  };
}

/**
 * What one line's suggested quantity is built on (1.13), carried on the
 * line as rationale.suggestionFor and read by Why this quantity and the
 * message after a supplier change.
 *
 *   usual      the item's usual (effective) supplier, or an item with none:
 *              the item's own suggestion, exactly as computeItem gave it
 *   rebuilt    another supplier: rebuilt on that supplier's own lead
 *   same_lead  another supplier whose lead equals the one the item's own
 *              suggestion is built on, so nothing to rebuild
 *   manual     a minimum typed by hand sets the lead-time stock, and it
 *              doesn't depend on any lead time
 *   no_lead    another supplier with no lead time known: the item's own
 *              suggestion stands, and the line says so
 *   no_window  a window minimum stored without the burn or lead it was set
 *              from: the item's own suggestion stands. writeWindowMinimum
 *              always stores both, so this is a guard, not a case seen
 */
export interface SuggestionFor {
  supplierUid: string;
  supplierName: string | null;
  basis: "usual" | "rebuilt" | "same_lead" | "manual" | "no_lead" | "no_window";
  /** The lead this line's suggestion is built on; null where none. */
  leadDays: number | null;
  /** Where that lead came from, as leadTimeSource. */
  leadSource: LineLead["source"] | null;
  /**
   * The item's own suggestion (its usual supplier's), the lead it is built
   * on (a window minimum's: the lead it was set from) and where that lead
   * came from, null where it can't be said (a minimum set from a lead that
   * is no longer the item's).
   */
  usualQty: number;
  usualSupplierName: string | null;
  usualLeadDays: number | null;
  usualLeadSource: LineLead["source"] | null;
}

/*
 * The suggested quantity for one item under one supplier (1.13). Allied
 * answered Q5 on 13 Oct: when they pick a different supplier, "yes it should
 * match with whatever supplier they pick". Until 1.13 every line carried the
 * item's own suggestion, built on its usual supplier's lead whoever the line
 * was with. Now a line under any other supplier is rebuilt on that
 * supplier's own lead (leadForSupplier: Allied's figure on the Suppliers
 * page, else the measured median), through the same suggestOrderQty
 * computeItem uses, with only the lead-time stock changed:
 *
 *   window minimum   the minimum this window would give at the chosen lead:
 *                    the stored monthly burn × lead ÷ 30.44, rounded up
 *                    (minStock.ts suggestedMinimum on the row's own
 *                    monthly_burn). The stored burn, not today's
 *                    consumption: at the lead it was set from it gives the
 *                    stored minimum back exactly (all 289 window minimums
 *                    in the f2148b2 prod capture, 14 Oct NZ), where
 *                    today's would drift, so the usual supplier's lead and
 *                    a pick at that same lead can never disagree
 *   hand-set minimum unchanged; a typed minimum has no lead time in it
 *   no minimum       weekly × the chosen lead ÷ 7
 *
 * then weekly × 8 + lead-time stock − free stock − on order, rounded up to
 * MYOB's reorder multiple as before. No MOQ or pack size is stored, and Allied
 * named none. Free stock, on order, demand and the minimum are the item's,
 * the same on every line. On the 26 Aug copy, N24S16M with a 6-month
 * minimum of 1,725 (490.67 a month, from its own 107 days) picked to Hobson
 * (24 days measured) gets 490.67 × 24 ÷ 30.44 = 387 of lead-time stock and
 * suggests 1,023 where Shandong Tengda's line suggests 2,361.
 *
 * The usual supplier's line keeps item.suggestion exactly, so everything
 * that never involved a pick reads as it did. A supplier with no known lead
 * keeps it too, and says so (no_lead), rather than inventing a zero wait.
 * Typed quantities never come here: the cart shows a typed or carried qty
 * over any suggestion, so only lines showing the suggestion move.
 */
export function supplierSuggestion(
  item: ItemComputed,
  supplierUid: string,
  supplierName: string | null,
  lead: LineLead | undefined,
): { qty: number; suggestion: ItemComputed["suggestion"]; suggestionFor: SuggestionFor } {
  const usualQty = item.suggestion?.qty ?? 0;
  const min = item.minStock;
  const usualLeadDays = min?.basis === "manual" ? null : min?.basis === "window" ? min.leadTimeDays : item.leadTimeDays;
  const usualLeadSource = usualLeadDays != null && usualLeadDays === item.leadTimeDays ? item.leadTimeSource : null;
  const leadDays = lead?.days ?? null;
  const usual = { usualQty, usualSupplierName: item.supplierName, usualLeadDays, usualLeadSource };
  const keep = (basis: SuggestionFor["basis"], days = usualLeadDays, source = usualLeadSource) => ({
    qty: usualQty,
    suggestion: item.suggestion,
    suggestionFor: {
      supplierUid,
      supplierName,
      basis,
      leadDays: days,
      leadSource: days == null ? null : source,
      ...usual,
    },
  });
  if (item.supplierUid == null || supplierUid === item.supplierUid) return keep("usual");
  if (min?.basis === "manual") return keep("manual", null, null);
  if (leadDays == null) return keep("no_lead", null, null);
  if (min && (min.monthlyBurn == null || min.leadTimeDays == null)) return keep("no_window");
  if (leadDays === usualLeadDays) return keep("same_lead", leadDays, lead?.source ?? null);

  const worked = suggestOrderQty({
    ...suggestionInputs(item),
    leadDays,
    leadSource: leadSourceLabel(lead?.source ?? null, lead?.orders ?? 0),
    // suggestedMinimum is null at a zero lead or burn: no lead-time stock.
    ...(min ? { minLeadStock: suggestedMinimum(min.monthlyBurn ?? 0, leadDays) ?? 0 } : {}),
  });
  return {
    qty: worked?.qty ?? 0,
    suggestion: worked,
    suggestionFor: {
      supplierUid,
      supplierName,
      basis: "rebuilt",
      leadDays,
      leadSource: lead?.source ?? null,
      ...usual,
    },
  };
}

export interface CartLine {
  itemUid: string;
  number: string | null;
  name: string | null;
  productFinish: string | null;
  supplierUid: string;
  supplierName: string;
  supplierRegion: string | null;
  /** Where this supplier came from: Allied's tag, MYOB's primary, or bills. */
  supplierSource: SupplierOption["source"];
  /** This line's supplier is the one Allied marked preferred on the item page. */
  isPreferred: boolean;
  /** The item's preferred supplier, whichever line this is. Null when none is set. */
  preferredSupplierUid: string | null;
  preferredSupplierName: string | null;
  /** A saved decision that disagrees with the preferred supplier, if any. */
  conflict: PickConflict | null;
  /**
   * Allied ruled on the item page that this item has no supplier (1.8), so
   * the Order list can say "No supplier (ruled)" rather than "No known
   * supplier", which reads as a gap still to fill.
   */
  supplierRuledNone: boolean;
  /** Every supplier on file for the item, for the compare drawer. */
  options: CartOption[];
  /**
   * Order-to-delivery in days for this line's supplier: Allied's figure on
   * the item where this is its usual supplier (1.12), else on the supplier,
   * else measured from their orders. Null when none of those exist.
   */
  leadTimeDays: number | null;
  /** True when the figure was set by Allied rather than measured. */
  leadTimeSetByAllied: boolean;
  leadTimeOrders: number;
  /** Same-day order/bill pairs ignored — see supplier_lead_time for why. */
  leadTimeSameDayExcluded: number;
  /**
   * Where leadTimeDays came from (1.12): "item" (set on the item page),
   * "supplier" (set on the Suppliers page) or "measured"; null with none.
   * Optional: a server before 1.12 sends none, and then the item's own lead
   * was every line's.
   */
  leadTimeSource?: LineLead["source"] | null;
  /** What this supplier last charged, and their average. */
  lastCost: number | null;
  averageCost: number | null;
  onHand: number | null;
  freeStock: number | null;
  incomingQty: number;
  minLevel: number | null;
  weeklyDemand: number;
  coverWeeks: number | null;
  /*
   * The rest of the item's position, as Inventory shows it (1.5), so the
   * by-item view (1.6) can show on hand, committed, free stock, on order and
   * both covers from the cart alone. Each is copied from the computed item
   * the line already reads, never recomputed here: committed is the item's
   * own, so on hand − committed is the line's free stock; cover incl. on
   * order is the 1 dp figure with its below-lead-time flag; the risk score is
   * Inventory's, which the by-item view sorts on first.
   */
  qtyCommitted: number | null;
  coverWeeksInclOnOrder: number | null;
  coverBelowLeadTime: boolean;
  riskScore: number;
  /*
   * The item's stock gap (1.11), for By item's "Gap before delivery" column
   * and sort. Read off the computed item, never worked out here: nothing in
   * the cart calculates from it, and the quantity, the supplier and the
   * order sheets are exactly as they were. Null at a past date, and absent
   * from a server before 1.11 (By item reads "—"). It leaves out the item
   * page's weekly series, which no line draws: on the 26 Aug copy it would
   * add 125 KB to the 133 lines' /cart (495 KB with the rest of the gap,
   * 422 KB before 1.11).
   */
  gap?: Omit<Gap, "weeks"> | null;
  /**
   * The suggestion for this line's supplier: the item's own on its usual
   * supplier's line, and from 1.13 rebuilt on the supplier's own lead on any
   * other (supplierSuggestion; rationale.suggestionFor says which).
   */
  suggestedQty: number;
  /** Allied's number when they have set one, otherwise the suggestion. */
  qty: number;
  /**
   * The quantity is one Allied typed (1.13): saved on this line, or carried
   * from another supplier. Such a quantity never follows a suggestion.
   * Optional: absent from a server before 1.13.
   */
  qtyTyped?: boolean;
  state: CartState;
  note: string | null;
  estCost: number;
  /** Supplier the quantity was typed under, when it followed the item here from there. */
  qtyCarriedFrom: string | null;
  /**
   * How many suppliers this same item sits under, across the whole cart: one,
   * unless Allied split it or a saved quantity keeps a second line.
   */
  supplierCount: number;
  /**
   * Kit context (P7), so a line can explain itself without a round trip: how
   * the item is sourced, anything a kit rule took off this quantity, and
   * whether the kit it belongs to is being ordered alongside it.
   */
  kitForm: string | null;
  kitDoubleOrder: boolean;
  otherSuppliers: { supplierUid: string; supplierName: string | null }[];
  rationale: LineRationale;
}

/**
 * The working behind a line's quantity: the suggestion's own rationale
 * (queries.ts suggestOrderQty) plus the cart's fields, and from 1.13
 * suggestionFor, what this line's suggestion is built on.
 */
export interface LineRationale {
  [key: string]: number | string | null | SuggestionFor | undefined;
  suggestionFor?: SuggestionFor;
}

/** One supplier in the compare drawer, priced and timed for this item. */
export interface CartOption extends SupplierOption {
  lastCost: number | null;
  leadTimeDays: number | null;
  leadTimeSetByAllied: boolean;
  leadTimeOrders: number;
  leadTimeSameDayExcluded: number;
  /** Where leadTimeDays came from, as on CartLine (1.12; absent before). */
  leadTimeSource?: LineLead["source"] | null;
  /** The decision saved against this supplier, if any. */
  state: CartState | null;
  /**
   * The quantity on this order from this supplier: the line's where the item
   * sits under it, else the saved quantity, else the item's own suggestion
   * (as before 1.13; the drawer shows it only for a supplier in the cart).
   */
  qty: number;
  /** The item currently sits under this supplier in the cart. */
  inCart: boolean;
  /*
   * This supplier's own suggestion (1.13), as its line would show it, so
   * Compare can set suppliers side by side on their own leads: the item's
   * own under its usual supplier, rebuilt on this supplier's lead under any
   * other. suggestedEstCost is that quantity at what the line would cost
   * (this supplier's last price, else the item's average), and
   * suggestionBasis is SuggestionFor's basis. Optional: absent before 1.13.
   */
  suggestedQty?: number;
  suggestedEstCost?: number;
  suggestionBasis?: SuggestionFor["basis"];
}

export interface CartSupplierGroup {
  supplierUid: string;
  supplierName: string;
  region: string | null;
  leadTimeDays: number | null;
  itemCount: number;
  estimatedCost: number;
  lines: CartLine[];
}

/** Items needing an order, fanned out across every supplier tagged for them. */
export async function purchaseCart(opts?: Partial<DemandWindow>): Promise<{
  generatedAt: string;
  suppliers: CartSupplierGroup[];
  totalLines: number;
  totalItems: number;
  estimatedCost: number;
  /** Items sitting under more than one supplier with no decision made yet. */
  unresolvedDuplicates: number;
  /** What the kit rules (P7) kept out of this cart, and what still clashes. */
  kit: {
    buildPlans: number;
    buildPlanValue: number;
    doubleOrders: number;
  };
  /** Choices already made, so they can be reviewed and reversed. */
  decisions: {
    itemUid: string;
    number: string | null;
    name: string | null;
    kind: "selected" | "split";
    suppliers: { supplierUid: string; supplierName: string; qty: number }[];
  }[];
  /**
   * Saved decisions that disagree with the item's preferred supplier. They are
   * kept as made and listed here, so Allied can keep each one or switch.
   */
  /** Items needing an order that Allied took off this order, so they can be put back. */
  removedItems: { itemUid: string; number: string | null; name: string | null; how: "taken_off" | "struck" }[];
  pickConflicts: {
    itemUid: string;
    number: string | null;
    name: string | null;
    kind: PickConflictKind;
    acknowledged: boolean;
    keptSuppliers: { supplierUid: string; supplierName: string; qty: number }[];
    preferredSupplierUid: string;
    preferredSupplierName: string | null;
  }[];
  /*
   * Which as-at date and window this cart was built for, and whether that
   * date has a stored daily snapshot (1.5): the same three fields /items
   * returns, from the same snapshotState call, so Purchasing's past-date
   * notice can say where committed and on order came from, as Inventory's
   * does. They used to be missing, so at a past date the notice said nothing
   * about provenance and never named the date snapshots began (21 Aug, on
   * prod and on the 26 Aug local copy). Present on the empty cart too.
   */
  window: DemandWindow;
  hasSnapshot: boolean;
  snapshotsFrom: string | null;
}> {
  await ensureInsightsSchema();
  const pool = getPool();
  const win = resolveWindow(opts);
  // The resolved window keys the item cache exactly as `opts` would.
  const [items, snap] = await Promise.all([computedItems(win), snapshotState(win.asAt)]);

  /*
   * Items still needing a purchase order.
   *
   * Items Allied have never bought complete are excluded (P7). One still shows
   * as below its minimum, and before the kit rules that was enough to put it in
   * a purchase cart it does not belong in — BP1675S16 arrived as a NZ$34,692
   * line priced off MYOB's average_cost, which for a built item is the cost of
   * having built it, not a purchase price. The requirement is real and is not
   * lost: it appears on Products & BOM as a quantity to build.
   *
   * Still the item's own suggestion from 1.13: a saved pick of a slower
   * supplier doesn't bring in an item whose usual supplier's suggestion is 0
   * (RELEASING.md "What 1.13 changed"); that would be a further numbers change.
   */
  const needing = items.filter(
    (i) =>
      !(i.kit?.buildPlanQty ?? 0) &&
      (i.suggestion != null || i.flags.includes("below_min")),
  );
  if (!needing.length) {
    return {
      generatedAt: new Date().toISOString(),
      suppliers: [],
      totalLines: 0,
      totalItems: 0,
      estimatedCost: 0,
      unresolvedDuplicates: 0,
      kit: { buildPlans: 0, buildPlanValue: 0, doubleOrders: 0 },
      decisions: [],
      removedItems: [],
      pickConflicts: [],
      window: win,
      ...snap,
    };
  }
  const uids = needing.map((i) => i.uid);

  const [sourcing, supplierLead, lastCosts] = await Promise.all([
    loadSourcing(pool, uids),
    // Allied's figure on the supplier, else the measured median (leadTimes.ts,
    // shared with the expected dates of open purchase orders since 1.9).
    supplierLeadTimes(pool),
    pool.query(
      `SELECT DISTINCT ON (l.item_uid, b.supplier_uid)
              l.item_uid, b.supplier_uid, l.unit_price, b.date::date::text AS last_bought
       FROM myob_purchase_bill_lines l
       JOIN myob_purchase_bills b ON b.uid = l.bill_uid
       WHERE l.item_uid = ANY($1) AND b.supplier_uid IS NOT NULL AND l.unit_price > 0
       ORDER BY l.item_uid, b.supplier_uid, b.date DESC`,
      [uids],
    ),
  ]);
  const { optionsFor, savedFor, ackFor, takenOff, supplierName } = sourcing;

  // The lead each line and compare option shows (1.12: an item's own lead
  // only under its usual supplier; see leadForSupplier).
  const leadFor = (item: ItemComputed, supplierUid: string) => leadForSupplier(item, supplierUid, supplierLead);
  const lastCost = new Map(
    lastCosts.rows.map((r) => [
      `${r.item_uid}|${r.supplier_uid}`,
      Number(r.unit_price),
    ]),
  );
  const groups = new Map<string, CartSupplierGroup>();
  const pickConflicts: Awaited<ReturnType<typeof purchaseCart>>["pickConflicts"] = [];
  const removedItems: Awaited<ReturnType<typeof purchaseCart>>["removedItems"] = [];
  let unresolvedDuplicates = 0;
  let totalLines = 0;

  for (const item of needing) {
    // Taken off this order with ×: listed so it can be put back, and its saved
    // decisions are left exactly as they were for when it is.
    if (takenOff.has(item.uid)) {
      removedItems.push({ itemUid: item.uid, number: item.number, name: item.name, how: "taken_off" });
      continue;
    }
    const options = optionsFor(item.uid);
    const saved = savedFor(item.uid);
    const plan = planItemLines(options, saved, ackFor(item.uid));
    if (plan.lines.length > 1 && !plan.decided) unresolvedDuplicates += 1;
    // Every line struck one by one, before × took items off whole.
    if (!plan.lines.length)
      removedItems.push({ itemUid: item.uid, number: item.number, name: item.name, how: "struck" });

    const suggested = item.suggestion?.qty ?? 0;
    /*
     * Each supplier's own suggestion (1.13): the item's own under its usual
     * supplier, rebuilt on the supplier's lead under any other
     * (supplierSuggestion). Worked out once per supplier, so a line, its
     * compare option and the pick-conflict list never disagree.
     */
    const ownSuggestion = new Map<string, ReturnType<typeof supplierSuggestion>>();
    const suggestionFor = (o: SupplierOption) => {
      let s = ownSuggestion.get(o.supplierUid);
      if (!s) {
        s = supplierSuggestion(item, o.supplierUid, o.supplierName, leadFor(item, o.supplierUid));
        ownSuggestion.set(o.supplierUid, s);
      }
      return s;
    };
    const listed = new Set(plan.lines.map((l) => l.option.supplierUid));
    // What each listed line shows, so the compare drawer never disagrees with it.
    const shownQty = new Map(
      plan.lines.map((l) => [l.option.supplierUid, l.carried ? l.carried.qty : (l.saved?.qty ?? suggestionFor(l.option).qty)]),
    );
    const compare: CartOption[] = options.map((o) => {
      const s = saved.get(o.supplierUid);
      const lt = leadFor(item, o.supplierUid);
      const own = suggestionFor(o);
      return {
        ...o,
        lastCost: lastCost.get(`${item.uid}|${o.supplierUid}`) ?? null,
        leadTimeDays: lt?.days ?? null,
        leadTimeSetByAllied: lt?.setByAllied ?? false,
        leadTimeOrders: lt?.orders ?? 0,
        leadTimeSameDayExcluded: lt?.sameDayExcluded ?? 0,
        leadTimeSource: lt?.source ?? null,
        state: s?.state ?? null,
        qty: shownQty.get(o.supplierUid) ?? s?.qty ?? suggested,
        inCart: listed.has(o.supplierUid),
        suggestedQty: own.qty,
        suggestedEstCost: own.qty * (lastCost.get(`${item.uid}|${o.supplierUid}`) ?? item.averageCost ?? 0),
        suggestionBasis: own.suggestionFor.basis,
      };
    });

    for (const { option: o, saved: s, carried } of plan.lines) {
      const key = `${item.uid}|${o.supplierUid}`;
      const own = suggestionFor(o);
      // A newer quantity typed under another supplier beats an older one here.
      const qty = carried ? carried.qty : (s?.qty ?? own.qty);
      const cost = lastCost.get(key) ?? item.averageCost ?? 0;
      const lt = leadFor(item, o.supplierUid);
      // Built on this line's own supplier's lead (1.13), where it was rebuilt.
      const rebuilt = own.suggestionFor.basis === "rebuilt";

      const line: CartLine = {
        itemUid: item.uid,
        number: item.number,
        name: item.name,
        productFinish: item.productFinish,
        supplierUid: o.supplierUid,
        supplierName: o.supplierName ?? (o.supplierUid === "none" ? "No known supplier" : "Unknown supplier"),
        supplierRegion: o.region,
        supplierSource: o.source,
        isPreferred: o.isPreferred,
        preferredSupplierUid: plan.preferred?.supplierUid ?? null,
        preferredSupplierName: plan.preferred?.supplierName ?? null,
        conflict: plan.conflict,
        supplierRuledNone: item.supplierRuledNone,
        options: compare,
        leadTimeDays: lt?.days ?? null,
        leadTimeSetByAllied: lt?.setByAllied ?? false,
        leadTimeOrders: lt?.orders ?? 0,
        leadTimeSameDayExcluded: lt?.sameDayExcluded ?? 0,
        leadTimeSource: lt?.source ?? null,
        lastCost: lastCost.get(key) ?? null,
        averageCost: item.averageCost,
        onHand: item.qtyOnHand,
        freeStock: item.qtyFreeStock,
        incomingQty: item.incomingQty,
        minLevel: item.minLevel,
        weeklyDemand: item.demand.weekly,
        coverWeeks: item.coverWeeks,
        qtyCommitted: item.qtyCommitted,
        coverWeeksInclOnOrder: item.coverWeeksInclOnOrder,
        coverBelowLeadTime: item.coverBelowLeadTime,
        riskScore: item.risk.score,
        gap: lineGap((item as { gap?: Gap | null }).gap ?? null),
        suggestedQty: own.qty,
        qty,
        qtyTyped: carried != null || s?.qty != null,
        state: s?.state ?? (carried ? "edited" : "suggested"),
        note: s?.note ?? null,
        estCost: qty * cost,
        qtyCarriedFrom: carried ? (supplierName.get(carried.fromSupplierUid) ?? "another supplier") : null,
        supplierCount: plan.lines.length,
        kitForm: item.kit?.form ?? null,
        kitDoubleOrder: item.kit?.doubleOrder ?? false,
        otherSuppliers: plan.lines
          .filter((x) => x.option !== o)
          .map((x) => ({ supplierUid: x.option.supplierUid, supplierName: x.option.supplierName })),
        rationale: {
          ...(own.suggestion?.rationale ?? {}),
          weeklyDemand: item.demand.weekly,
          demandWindowMonths: item.demand.windowMonths,
          demandBasis: item.demand.basis,
          coverWeeks: item.coverWeeks,
          leadTimeDays: lt?.days ?? null,
          incoming: item.incomingQty,
          /*
           * The lead time the suggestion was actually built on (1.8), and
           * whose. The suggestion is the item's own (computeItem), built on
           * its effective supplier's lead whichever line it sits on, while
           * leadTimeDays above is this line's supplier's (kept for tabs
           * from before 1.8). They differ on a pick: N24S16M picked to Tong
           * Ming reads 42 days on its line but was built on Shandong
           * Tengda's 131. "Why this quantity" used to quote the line's and
           * so named a lead time it never used. leadStockBasis says what set
           * the lead-time stock: Allied's minimum from a window, a minimum
           * typed by hand, or the live lead time where none is applied; a
           * window minimum carries the window and the lead it was set from.
           * leadTimeUsedSource says where that lead came from: "item" when
           * Allied set one on the item page, which is not the effective
           * supplier's own figure (N24S16M carries 107 days on prod; Shandong
           * Tengda's own is 120, Allied's; measured 131), so the screens
           * don't credit it to the supplier.
           * From 1.12 the line's leadTimeDays is the item's lead only on the
           * usual supplier's line (leadForSupplier); the suggestion, and so
           * leadTimeDaysUsed, is still built on it whichever line it is.
           */
          /*
           * From 1.13 a line under another supplier is rebuilt on that
           * supplier's own lead (supplierSuggestion), and then these three
           * name it: the field still means "the lead the suggestion was built
           * on", and on such a line that is the line's. On the usual
           * supplier's line, and wherever the item's own suggestion stands
           * (a hand-set minimum, no lead known, the same lead), they are the
           * item's as before. The min* fields stay facts about the applied
           * minimum, whichever line. suggestionFor says which case this is
           * and what the item's own suggestion was; a tab from before 1.13
           * ignores it.
           */
          leadTimeDaysUsed: rebuilt ? own.suggestionFor.leadDays : item.leadTimeDays,
          leadTimeUsedFor: rebuilt ? o.supplierName : item.supplierName,
          leadTimeUsedSource: rebuilt ? own.suggestionFor.leadSource : item.leadTimeSource,
          leadStockBasis: item.minStock?.basis ?? "lead",
          minWindowMonths: item.minStock?.windowMonths ?? null,
          minLeadTimeDays: item.minStock?.leadTimeDays ?? null,
          suggestionFor: own.suggestionFor,
        },
      };

      const g: CartSupplierGroup = groups.get(o.supplierUid) ?? {
        supplierUid: o.supplierUid,
        supplierName: line.supplierName,
        region: o.region,
        // The card names the supplier's wait; an item-level figure shows on its line.
        leadTimeDays: supplierLead.get(o.supplierUid)?.days ?? null,
        itemCount: 0,
        estimatedCost: 0,
        lines: [] as CartLine[],
      };
      g.lines.push(line);
      g.itemCount += 1;
      g.estimatedCost += line.estCost;
      groups.set(o.supplierUid, g);
      totalLines += 1;
    }

    if (plan.conflict) {
      pickConflicts.push({
        itemUid: item.uid,
        number: item.number,
        name: item.name,
        kind: plan.conflict.kind,
        acknowledged: plan.conflict.acknowledged,
        keptSuppliers: plan.lines.map((l) => ({
          supplierUid: l.option.supplierUid,
          supplierName: l.option.supplierName ?? "Unknown supplier",
          qty: l.carried ? l.carried.qty : (l.saved?.qty ?? suggestionFor(l.option).qty),
        })),
        preferredSupplierUid: plan.conflict.preferredSupplierUid,
        preferredSupplierName: plan.conflict.preferredSupplierName,
      });
    }
  }

  const suppliers = [...groups.values()].sort(
    (a, b) => b.estimatedCost - a.estimatedCost,
  );
  for (const g of suppliers) g.lines.sort((a, b) => b.estCost - a.estCost);

  // Everything already decided, grouped per item, so the UI can show what was
  // chosen and offer to reverse it. A decision nobody can review or undo is one
  // people hesitate to make.
  const decisions = new Map<string, {
    itemUid: string; number: string | null; name: string | null;
    kind: "selected" | "split";
    suppliers: { supplierUid: string; supplierName: string; qty: number }[];
  }>();
  for (const g of suppliers)
    for (const l of g.lines) {
      if (l.state !== "selected" && l.state !== "split") continue;
      const e = decisions.get(l.itemUid) ?? {
        itemUid: l.itemUid,
        number: l.number,
        name: l.name,
        kind: l.state,
        suppliers: [],
      };
      e.kind = l.state;
      e.suppliers.push({
        supplierUid: g.supplierUid,
        supplierName: g.supplierName,
        qty: l.qty,
      });
      decisions.set(l.itemUid, e);
    }

  return {
    generatedAt: new Date().toISOString(),
    suppliers,
    totalLines,
    totalItems: needing.length,
    /*
     * The requirement, as a range — because it genuinely is one until the
     * sourcing decisions are made.
     *
     * Since the Order list follows the preferred supplier, an item normally has
     * one line and the two ends meet. The one normal way it gets more is a
     * split, and a split's lines are parts of one order, not alternatives, so
     * they are added up (1.4): FG250P split 142/142 between Skellerup and
     * Specialised Washers is both parts at each end, where it used to be one
     * part at each. The ends part only where lines really are alternatives —
     * two suppliers each carrying the FULL suggested quantity — and summing
     * those would answer "what if it were ordered from both" while reading as
     * "what we need to spend". It used to part on every item, when the list
     * put each one under every supplier it could find.
     *
     * On the live file that sum was NZ$826,199 against a real requirement of
     * NZ$427,255 to NZ$592,140. It was not a cautious estimate, it was
     * unreachable: NZ$234,000 above the worst case, because every dollar past
     * the dearest single choice comes from ordering the same item twice — the
     * exact mistake the page warns against.
     *
     * Counting each item once at its cheapest and dearest candidate gives the
     * two ends. The gap between them is what the outstanding decisions are
     * worth, which is a better reason to make them than a warning banner.
     *
     * Per-supplier subtotals are deliberately NOT de-duplicated: each is
     * correct for that supplier's own order sheet, and the export depends on it.
     */
    ...requirementRange(suppliers),
    unresolvedDuplicates,
    decisions: [...decisions.values()],
    removedItems,
    pickConflicts,
    window: win,
    ...snap,
    /*
     * What the kit rules kept out of this cart, reported rather than assumed.
     * A cart that quietly holds items back is worse than one that over-orders,
     * because nobody can tell it is doing it.
     */
    kit: {
      buildPlans: items.filter((i) => (i.kit?.buildPlanQty ?? 0) > 0).length,
      buildPlanValue: Number(
        items
          .filter((i) => (i.kit?.buildPlanQty ?? 0) > 0)
          .reduce((a, i) => a + (i.kit?.buildPlanQty ?? 0) * (i.averageCost ?? 0), 0)
          .toFixed(2),
      ),
      doubleOrders: kitDoubleOrderItems(suppliers),
    },
  };
}

/**
 * Each item counted once, at its cheapest and its dearest candidate supplier.
 * The parts of a split are one candidate between them, at their sum: the
 * split orders every part, so no choice is left that could make it cheaper.
 *
 * `estimatedCost` is kept alongside as the sum of every line — what the export
 * sheets add up to when nothing has been decided — so nothing that relied on it
 * breaks. It is simply no longer what the page leads with. Where every item
 * has one line or one split, the range is a single figure equal to it.
 */
export function requirementRange(
  suppliers: { lines: { itemUid: string; estCost: number; state: CartState }[] }[],
): { requirementLow: number; requirementHigh: number; estimatedCost: number } {
  const perItem = new Map<string, { split: number | null; others: number[] }>();
  let estimatedCost = 0;
  for (const group of suppliers) {
    for (const line of group.lines) {
      estimatedCost += line.estCost;
      const seen = perItem.get(line.itemUid) ?? { split: null, others: [] };
      if (line.state === "split") seen.split = (seen.split ?? 0) + line.estCost;
      else seen.others.push(line.estCost);
      perItem.set(line.itemUid, seen);
    }
  }
  let requirementLow = 0;
  let requirementHigh = 0;
  for (const { split, others } of perItem.values()) {
    const candidates = split == null ? others : [split, ...others];
    requirementLow += Math.min(...candidates);
    requirementHigh += Math.max(...candidates);
  }
  const round = (v: number): number => Number(v.toFixed(2));
  return {
    requirementLow: round(requirementLow),
    requirementHigh: round(requirementHigh),
    estimatedCost: round(estimatedCost),
  };
}

/**
 * How many items on the Order list are flagged as a kit ordered alongside
 * something it is made of. Items, not lines (1.4): a flagged kit split between
 * two suppliers is one kit with its parts on order, and counting its lines
 * made it two. The export's warning still counts lines, because it points at
 * the rows to look at.
 *
 * The flag sits on both sides of a clash (kits.ts), so a sub-assembly kit is
 * counted when its own parts are on the list and also when only the kit it
 * goes into is. That can make this count higher than Products & BOM's, which
 * counts the parent kits alone; the page note names both roles. On the 26 Aug
 * copy they agree: 3 and 3, all three top-level kits.
 */
export function kitDoubleOrderItems(
  suppliers: { lines: { itemUid: string; kitDoubleOrder: boolean }[] }[],
): number {
  const flagged = new Set<string>();
  for (const group of suppliers)
    for (const line of group.lines) if (line.kitDoubleOrder) flagged.add(line.itemUid);
  return flagged.size;
}

/*
 * Every cart write below runs in a transaction that records the item's saved
 * decisions before and after (platform_change_log) — rows, "Keep" and
 * taken-off alike — so a choice Allied made can always be put back, including
 * after "Start again", which clears them all.
 *
 * The "keep my earlier pick" acknowledgement belongs to the decision it was
 * given for, so anything that replaces that decision clears it.
 */
const clearPickAck = (db: PoolClient, itemUid: string | null) =>
  itemUid
    ? db.query(`DELETE FROM platform_cart_pick_ack WHERE item_uid = $1`, [itemUid])
    : db.query(`DELETE FROM platform_cart_pick_ack`);

async function cartWrite(
  itemUid: string,
  action: string,
  detail: unknown,
  fn: (client: PoolClient) => Promise<void>,
): Promise<void> {
  await ensureInsightsSchema();
  await inTransaction(getPool(), async (client) => {
    const before = await cartStateOf(client, itemUid);
    await fn(client);
    await logChange(client, {
      entity: "cart",
      itemUid,
      action,
      before,
      after: await cartStateOf(client, itemUid),
      detail,
    });
  });
}

/** Record a decision on one cart line. */
export async function setCartLine(params: {
  itemUid: string;
  supplierUid: string;
  qty?: number | null;
  state?: CartState;
  note?: string | null;
}): Promise<void> {
  if (params.qty != null && (!Number.isFinite(params.qty) || params.qty < 0))
    throw new Error("Quantity must be a number of zero or more.");
  await cartWrite(params.itemUid, params.state === "removed" ? "remove_line" : "edit_line", params, async (client) => {
    /*
     * Striking the last remaining part of a split takes the item off whole,
     * leaving that part as it was. Striking it on its own would drop the item
     * back to its default supplier — one that was never in the split — at the
     * full suggested quantity.
     */
    if (params.state === "removed") {
      const splits = (
        await client.query(
          `SELECT supplier_uid FROM platform_purchase_cart WHERE item_uid = $1 AND state = 'split'`,
          [params.itemUid],
        )
      ).rows as { supplier_uid: string }[];
      if (splits.length === 1 && splits[0].supplier_uid === params.supplierUid) {
        await client.query(
          `INSERT INTO platform_cart_item_off (item_uid, taken_off_at, updated_by)
           VALUES ($1, NOW(), 'dashboard') ON CONFLICT (item_uid) DO NOTHING`,
          [params.itemUid],
        );
        return;
      }
    }
    /*
     * A quantity never undoes a choice. With no state the line keeps its own;
     * and "edited" is not allowed to overwrite Chosen or Split either, because
     * a dashboard left open from before this release still sends it on every
     * quantity box it leaves.
     */
    await client.query(
      `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, qty, state, note, updated_by, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, 'edited'), $5, 'dashboard', NOW())
       ON CONFLICT (item_uid, supplier_uid) DO UPDATE SET
         qty = COALESCE(EXCLUDED.qty, platform_purchase_cart.qty),
         state = CASE
           WHEN $4 = 'edited' AND platform_purchase_cart.state IN ('selected', 'split')
             THEN platform_purchase_cart.state
           ELSE COALESCE($4, platform_purchase_cart.state)
         END,
         note = COALESCE(EXCLUDED.note, platform_purchase_cart.note),
         updated_at = NOW()`,
      [params.itemUid, params.supplierUid, params.qty ?? null, params.state ?? null, params.note ?? null],
    );
    // Striking a line changes the decision; a quantity or note does not.
    if (params.state === "removed") await clearPickAck(client, params.itemUid);
  });
}

/**
 * Choose one supplier for an item; every other option is dropped in the same
 * action, so nobody has to hunt through the cart deleting duplicates.
 */
export async function selectCartSupplier(itemUid: string, supplierUid: string): Promise<void> {
  await cartWrite(itemUid, "select_supplier", { supplierUid }, async (client) => {
    // The quantity Allied see is the one that goes with the choice — never an
    // older number left on the chosen supplier's row and not on screen.
    const { plan } = await planFor(client, itemUid);
    const keepQty = typedQtyOnShow(plan);
    await client.query(
      `DELETE FROM platform_purchase_cart WHERE item_uid = $1 AND supplier_uid <> $2`,
      [itemUid, supplierUid],
    );
    await client.query(
      `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, qty, state, updated_by, updated_at)
       VALUES ($1, $2, $3, 'selected', 'dashboard', NOW())
       ON CONFLICT (item_uid, supplier_uid) DO UPDATE SET qty = $3, state = 'selected', updated_at = NOW()`,
      [itemUid, supplierUid, keepQty],
    );
    await clearPickAck(client, itemUid);
  });
}

/**
 * The quantity Allied typed that the item shows now, or null when it shows
 * the suggestion. A split has no single quantity, so none is carried from it.
 */
function typedQtyOnShow(plan: ItemPlan): number | null {
  if (plan.lines.length !== 1) return null;
  const [l] = plan.lines;
  if (l.carried) return l.carried.qty;
  if (l.saved && l.saved.state !== "split" && l.saved.state !== "removed") return l.saved.qty ?? null;
  return null;
}

/**
 * Deliberately order one item from several suppliers at once. Recorded as an
 * explicit split so it reads as a decision rather than an accidental duplicate.
 */
export async function splitCartItem(
  itemUid: string,
  parts: { supplierUid: string; qty: number }[],
): Promise<void> {
  const keep = parts.map((p) => p.supplierUid);
  await cartWrite(itemUid, "split", { parts }, async (client) => {
    await client.query(
      `DELETE FROM platform_purchase_cart WHERE item_uid = $1 AND NOT (supplier_uid = ANY($2))`,
      [itemUid, keep],
    );
    for (const p of parts) {
      await client.query(
        `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, qty, state, updated_by, updated_at)
         VALUES ($1, $2, $3, 'split', 'dashboard', NOW())
         ON CONFLICT (item_uid, supplier_uid) DO UPDATE SET
           qty = EXCLUDED.qty, state = 'split', updated_at = NOW()`,
        [itemUid, p.supplierUid, p.qty],
      );
    }
    await clearPickAck(client, itemUid);
  });
}

/**
 * Clear every decision, returning the cart to the platform's suggestions.
 * Everything cleared is logged first, so even this can be undone.
 */
export async function resetCart(): Promise<number> {
  await ensureInsightsSchema();
  return inTransaction(getPool(), async (client) => {
    const before = await cartStateAll(client);
    const r = await client.query(`DELETE FROM platform_purchase_cart`);
    await client.query(`DELETE FROM platform_cart_item_off`);
    await clearPickAck(client, null);
    await logChange(client, {
      entity: "cart",
      itemUid: null,
      action: "reset_cart",
      before,
      after: { rows: [], acks: [], takenOff: [] },
    });
    return r.rowCount ?? 0;
  });
}

/**
 * Take an item off this order. One marker for the item, not a strike against
 * each supplier: it stays off whatever suppliers are on file later, and its
 * saved decisions — a chosen supplier, a typed quantity — are left untouched
 * for when it is put back.
 */
export async function takeCartItemOff(itemUid: string): Promise<void> {
  await cartWrite(itemUid, "take_off", null, async (client) => {
    await client.query(
      `INSERT INTO platform_cart_item_off (item_uid, taken_off_at, updated_by)
       VALUES ($1, NOW(), 'dashboard') ON CONFLICT (item_uid) DO NOTHING`,
      [itemUid],
    );
  });
}

/**
 * Put an item back on this order exactly as it was before it came off. Lines
 * struck one at a time by an earlier release are cleared too, since that was
 * how an item used to be taken off.
 */
export async function putCartItemBack(itemUid: string): Promise<void> {
  await cartWrite(itemUid, "put_back", null, async (client) => {
    const off = await client.query(`DELETE FROM platform_cart_item_off WHERE item_uid = $1`, [itemUid]);
    if (off.rowCount) return;
    // No marker: only an item the Order list shows as struck line by line is
    // cleared. Anything else — a repeat click from a stale tab — changes
    // nothing, so a deliberate strike on one supplier is never lost.
    const { plan } = await planFor(client, itemUid);
    if (plan.lines.length) return;
    await client.query(`DELETE FROM platform_purchase_cart WHERE item_uid = $1 AND state = 'removed'`, [itemUid]);
  });
}

/**
 * "Use preferred" for an earlier pick, split or strike that disagrees with the
 * preferred supplier: the item goes to its preferred supplier. A quantity
 * Allied typed against the earlier pick comes with it, so switching supplier
 * does not also throw away the number they chose.
 */
export async function usePreferredSupplier(itemUid: string): Promise<void> {
  await ensureInsightsSchema();
  const pool = getPool();
  const pref = await pool.query(
    `SELECT supplier_uid FROM platform_item_suppliers WHERE item_uid = $1 AND is_preferred`,
    [itemUid],
  );
  if (!pref.rows.length) throw new Error("This item has no preferred supplier.");
  const preferredUid = pref.rows[0].supplier_uid as string;
  await cartWrite(itemUid, "use_preferred", { preferredSupplierUid: preferredUid }, async (client) => {
    const { plan } = await planFor(client, itemUid);
    const carry = typedQtyOnShow(plan);
    // Only what makes up the disagreement goes: the pick or split, and a strike
    // on the preferred supplier. Strikes on other suppliers stay as they are.
    await client.query(
      `DELETE FROM platform_purchase_cart
       WHERE item_uid = $1 AND (state IN ('selected', 'split') OR (supplier_uid = $2 AND state = 'removed'))`,
      [itemUid, preferredUid],
    );
    if (carry != null)
      await client.query(
        `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, qty, state, updated_by, updated_at)
         VALUES ($1, $2, $3, 'edited', 'dashboard', NOW())
         ON CONFLICT (item_uid, supplier_uid) DO UPDATE SET qty = $3, state = 'edited', updated_at = NOW()`,
        [itemUid, preferredUid, carry],
      );
    await clearPickAck(client, itemUid);
  });
}

/**
 * Keep an earlier pick that disagrees with the item's preferred supplier, and
 * stop warning about it. Tied to the preferred supplier as it stands now: if
 * Allied change the preferred supplier again, the warning comes back.
 */
export async function keepCartPick(itemUid: string): Promise<void> {
  await ensureInsightsSchema();
  const pref = await getPool().query(
    `SELECT supplier_uid FROM platform_item_suppliers WHERE item_uid = $1 AND is_preferred`,
    [itemUid],
  );
  if (!pref.rows.length) throw new Error("This item has no preferred supplier to compare against.");
  const preferredUid = pref.rows[0].supplier_uid as string;
  await cartWrite(itemUid, "keep_pick", { preferredSupplierUid: preferredUid }, async (client) => {
    await client.query(
      `INSERT INTO platform_cart_pick_ack (item_uid, preferred_supplier_uid, acked_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (item_uid) DO UPDATE SET
         preferred_supplier_uid = EXCLUDED.preferred_supplier_uid, acked_at = NOW()`,
      [itemUid, preferredUid],
    );
  });
}

/**
 * The cart as a spreadsheet, one block per supplier, formatted to paste
 * straight into an email.
 *
 * Several of Allied's suppliers are overseas with a language barrier, so they
 * can raise only one issue per conversation — a padded or garbled order costs a
 * full round trip. The reasoning travels with each line so the number can be
 * defended without a second email.
 *
 * The pre-export check is the last guard rail: an item still sitting under more
 * than one supplier with no decision recorded is flagged in the file itself, so
 * a duplicate order cannot leave the building quietly.
 *
 * Deliberately not emailed. Allied rejected automatic sending as too risky; the
 * endpoint is export and copy-paste, and it stops there.
 */
export async function cartExport(opts?: Partial<DemandWindow>): Promise<{
  filename: string;
  csv: string;
  unresolvedDuplicates: number;
}> {
  const cart = await purchaseCart(opts);
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = typeof v === "number" ? String(Number(v.toFixed(4))) : String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };

  const lines: string[] = [];
  // Rows, not items: the sheet says how many rows carry Kit CHECK, and it is
  // unchanged by 1.4 counting items for the page.
  const kitClashLines = cart.suppliers.reduce((a, g) => a + g.lines.filter((l) => l.kitDoubleOrder).length, 0);
  if (kitClashLines > 0) {
    lines.push(
      esc(
        `WARNING: ${kitClashLines} line(s) order a kit and something it is made of at the same time. Review the rows marked in "Kit CHECK" before ordering.`,
      ),
    );
    lines.push("");
  }
  if (cart.kit.buildPlans > 0) {
    lines.push(
      esc(
        `NOTE: ${cart.kit.buildPlans} item(s) worth ${cart.kit.buildPlanValue.toFixed(2)} are made in-house and are on the build sheet, not this order.`,
      ),
    );
    lines.push("");
  }
  if (cart.unresolvedDuplicates > 0) {
    lines.push(
      esc(
        `WARNING: ${cart.unresolvedDuplicates} item(s) appear under more than one supplier with no choice recorded. Review the rows marked CHECK before ordering.`,
      ),
    );
    lines.push("");
  }
  const openConflicts = cart.pickConflicts.filter((c) => !c.acknowledged).length;
  if (openConflicts > 0) {
    lines.push(
      esc(
        `WARNING: ${openConflicts} item(s) are on this order from a supplier picked earlier, not their preferred supplier. Review the rows marked CHECK before ordering.`,
      ),
    );
    lines.push("");
  }

  const header = [
    "Supplier", "Region", "Lead time (days)", "Item number", "Item name",
    "Finish", "Order qty", "Unit cost", "Est cost",
    "On hand", "Free stock", "Incoming", "Min level",
    "Weekly demand", "Demand window", "Cover (weeks)",
    "Line status", "Also under", "Kit form", "Kit CHECK", "CHECK",
  ];

  for (const g of cart.suppliers) {
    lines.push("");
    lines.push(
      esc(
        `${g.supplierName}${g.region ? ` (${g.region})` : ""}${
          g.leadTimeDays != null ? ` — typical lead time ${g.leadTimeDays} days` : ""
        } — ${g.itemCount} line(s), estimated ${g.estimatedCost.toFixed(2)}`,
      ),
    );
    lines.push(header.join(","));
    for (const l of g.lines) {
      const undecided = l.supplierCount > 1 && l.state !== "selected" && l.state !== "split";
      lines.push(
        [
          esc(g.supplierName), esc(g.region), esc(g.leadTimeDays),
          esc(l.number), esc(l.name), esc(l.productFinish),
          esc(l.qty), esc(l.lastCost ?? l.averageCost), esc(l.estCost),
          esc(l.onHand), esc(l.freeStock), esc(l.incomingQty), esc(l.minLevel),
          esc(l.weeklyDemand), esc(`${l.rationale.demandWindowMonths} months`),
          esc(l.coverWeeks),
          esc(l.state === "split" ? "Deliberate split" : l.state === "selected" ? "Chosen supplier" : l.state === "edited" ? "Quantity edited" : "Suggested"),
          esc(l.otherSuppliers.map((o) => o.supplierName).join(" / ")),
          esc(l.kitForm ?? ""),
          /*
           * A second, different duplicate. "Also under" catches the same order
           * placed with two suppliers; this catches the same requirement bought
           * in two forms — the pack and the parts that make it. Both leave the
           * building in this file, so both are flagged in it.
           */
          l.kitDoubleOrder
            ? "CHECK — this item and something it is made of are both on this order"
            : "",
          esc(
            [
              undecided ? "CHECK — also under another supplier, no choice recorded" : "",
              l.conflict && !l.conflict.acknowledged
                ? `CHECK — preferred supplier is ${l.conflict.preferredSupplierName ?? "another supplier"}; an earlier pick was kept`
                : "",
            ]
              .filter(Boolean)
              .join(" / "),
          ),
        ].join(","),
      );
    }
  }

  return {
    // businessToday(), not toISOString(): Allied are in New Zealand, the server
    // is in UTC, and for half of each NZ day toISOString() names yesterday. The
    // P3 timezone sweep covered export filenames and this one was missed.
    filename: `allied-purchase-order-${businessToday()}.csv`,
    csv: `﻿${lines.join("\r\n")}\r\n`,
    unresolvedDuplicates: cart.unresolvedDuplicates,
  };
}


/**
 * Reverse a decision, putting the item back under its default supplier — the
 * preferred one, else the fallback. Deleting the rows is enough: with no cart
 * row the item defaults again, exactly as before the choice was made.
 *
 * Except for a quantity Allied typed (1.8). Choose carries the number on show
 * onto the chosen row, so deleting every row used to throw that number away
 * and the item fell back to the suggestion: undo a pick of 3,000 and the
 * order quietly went back to 2,760. The number on show now goes with the item
 * to its default supplier as a typed quantity, in the same transaction, so
 * the one undo_decision entry records it in its before and after. A split has
 * no single number (typedQtyOnShow), so undoing one keeps nothing, as before.
 */
export async function undoCartDecision(itemUid: string): Promise<void> {
  await cartWrite(itemUid, "undo_decision", null, async (client) => {
    const { plan } = await planFor(client, itemUid);
    const keepQty = typedQtyOnShow(plan);
    await client.query(`DELETE FROM platform_purchase_cart WHERE item_uid = $1`, [itemUid]);
    await clearPickAck(client, itemUid);
    if (keepQty == null) return;
    // Read again with the rows gone: a supplier on file only because it was
    // picked has dropped out, so the first option is the default the item
    // now goes to. None on file (or ruled none): its No known supplier line.
    const home = (await loadSourcing(client, [itemUid])).optionsFor(itemUid)[0]?.supplierUid ?? NO_SUPPLIER.supplierUid;
    await client.query(
      `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, qty, state, updated_by, updated_at)
       VALUES ($1, $2, $3, 'edited', 'dashboard', NOW())`,
      [itemUid, home, keepQty],
    );
  });
}
