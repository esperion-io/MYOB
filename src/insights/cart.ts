import { businessToday } from "./businessDate.js";
import type { PoolClient } from "pg";
import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";
import { cartStateAll, cartStateOf, inTransaction, logChange } from "./changeLog.js";
import { computedItems, type DemandWindow, type ItemComputed } from "./queries.js";

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

/** One item's plan exactly as the Order list would show it. */
async function planFor(db: Pick<PoolClient, "query">, itemUid: string) {
  const s = await loadSourcing(db, [itemUid]);
  return {
    plan: planItemLines(s.optionsFor(itemUid), s.savedFor(itemUid), s.ackFor(itemUid)),
    takenOff: s.takenOff.has(itemUid),
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
  /** Every supplier on file for the item, for the compare drawer. */
  options: CartOption[];
  /**
   * Order-to-delivery in days: Allied's figure on the item, else on the
   * supplier, else measured from their orders. Null when none of those exist.
   */
  leadTimeDays: number | null;
  /** True when the figure was set by Allied rather than measured. */
  leadTimeSetByAllied: boolean;
  leadTimeOrders: number;
  /** Same-day order/bill pairs ignored — see supplier_lead_time for why. */
  leadTimeSameDayExcluded: number;
  /** What this supplier last charged, and their average. */
  lastCost: number | null;
  averageCost: number | null;
  onHand: number | null;
  freeStock: number | null;
  incomingQty: number;
  minLevel: number | null;
  weeklyDemand: number;
  coverWeeks: number | null;
  suggestedQty: number;
  /** Allied's number when they have set one, otherwise the suggestion. */
  qty: number;
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
  rationale: Record<string, number | string | null>;
}

/** One supplier in the compare drawer, priced and timed for this item. */
export interface CartOption extends SupplierOption {
  lastCost: number | null;
  leadTimeDays: number | null;
  leadTimeSetByAllied: boolean;
  leadTimeOrders: number;
  leadTimeSameDayExcluded: number;
  /** The decision saved against this supplier, if any. */
  state: CartState | null;
  /** The saved quantity, else the suggestion. */
  qty: number;
  /** The item currently sits under this supplier in the cart. */
  inCart: boolean;
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
}> {
  await ensureInsightsSchema();
  const pool = getPool();
  const items = await computedItems(opts);

  /*
   * Items still needing a purchase order.
   *
   * Items Allied have never bought complete are excluded (P7). One still shows
   * as below its minimum, and before the kit rules that was enough to put it in
   * a purchase cart it does not belong in — BP1675S16 arrived as a NZ$34,692
   * line priced off MYOB's average_cost, which for a built item is the cost of
   * having built it, not a purchase price. The requirement is real and is not
   * lost: it appears on Products & BOM as a quantity to build.
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
    };
  }
  const uids = needing.map((i) => i.uid);

  const [sourcing, leadTimes, lastCosts] = await Promise.all([
    loadSourcing(pool, uids),
    /*
     * Allied's figure on the supplier wins over the measured one, the same
     * precedence the item set uses. The cart used to show the measured median
     * here even after Allied had overridden it on the Suppliers page, so the
     * card could name one wait while the order quantity was built on another.
     */
    pool.query(
      `SELECT s.uid AS supplier_uid,
              COALESCE(m.lead_time_days, l.median_lead_days)::float8 AS days,
              (m.lead_time_days IS NOT NULL) AS set_by_allied,
              COALESCE(l.orders_measured, 0)::int AS orders_measured,
              COALESCE(l.same_day_excluded, 0)::int AS same_day_excluded
       FROM myob_suppliers s
       LEFT JOIN supplier_lead_time l ON l.supplier_uid = s.uid
       LEFT JOIN platform_supplier_meta m ON m.supplier_uid = s.uid
       WHERE m.lead_time_days IS NOT NULL OR l.median_lead_days IS NOT NULL`,
    ),
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

  const supplierLead = new Map(
    leadTimes.rows.map((r) => [
      r.supplier_uid as string,
      {
        days: r.days as number | null,
        setByAllied: r.set_by_allied as boolean,
        orders: r.orders_measured as number,
        sameDayExcluded: r.same_day_excluded as number,
      },
    ]),
  );
  /*
   * A lead time Allied set on the item itself applies under every supplier it
   * is offered from: it is a statement about how long this item takes, not
   * about who it comes from. Otherwise the supplier's figure applies.
   */
  const leadFor = (item: ItemComputed, supplierUid: string) =>
    item.leadTimeItemDays != null
      ? { days: item.leadTimeItemDays, setByAllied: true, orders: 0, sameDayExcluded: 0 }
      : supplierLead.get(supplierUid);
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
    const listed = new Set(plan.lines.map((l) => l.option.supplierUid));
    // What each listed line shows, so the compare drawer never disagrees with it.
    const shownQty = new Map(
      plan.lines.map((l) => [l.option.supplierUid, l.carried ? l.carried.qty : (l.saved?.qty ?? suggested)]),
    );
    const compare: CartOption[] = options.map((o) => {
      const s = saved.get(o.supplierUid);
      const lt = leadFor(item, o.supplierUid);
      return {
        ...o,
        lastCost: lastCost.get(`${item.uid}|${o.supplierUid}`) ?? null,
        leadTimeDays: lt?.days ?? null,
        leadTimeSetByAllied: lt?.setByAllied ?? false,
        leadTimeOrders: lt?.orders ?? 0,
        leadTimeSameDayExcluded: lt?.sameDayExcluded ?? 0,
        state: s?.state ?? null,
        qty: shownQty.get(o.supplierUid) ?? s?.qty ?? suggested,
        inCart: listed.has(o.supplierUid),
      };
    });

    for (const { option: o, saved: s, carried } of plan.lines) {
      const key = `${item.uid}|${o.supplierUid}`;
      // A newer quantity typed under another supplier beats an older one here.
      const qty = carried ? carried.qty : (s?.qty ?? suggested);
      const cost = lastCost.get(key) ?? item.averageCost ?? 0;
      const lt = leadFor(item, o.supplierUid);

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
        options: compare,
        leadTimeDays: lt?.days ?? null,
        leadTimeSetByAllied: lt?.setByAllied ?? false,
        leadTimeOrders: lt?.orders ?? 0,
        leadTimeSameDayExcluded: lt?.sameDayExcluded ?? 0,
        lastCost: lastCost.get(key) ?? null,
        averageCost: item.averageCost,
        onHand: item.qtyOnHand,
        freeStock: item.qtyFreeStock,
        incomingQty: item.incomingQty,
        minLevel: item.minLevel,
        weeklyDemand: item.demand.weekly,
        coverWeeks: item.coverWeeks,
        suggestedQty: suggested,
        qty,
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
          ...(item.suggestion?.rationale ?? {}),
          weeklyDemand: item.demand.weekly,
          demandWindowMonths: item.demand.windowMonths,
          demandBasis: item.demand.basis,
          coverWeeks: item.coverWeeks,
          leadTimeDays: lt?.days ?? null,
          incoming: item.incomingQty,
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
          qty: l.carried ? l.carried.qty : (l.saved?.qty ?? suggested),
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
     * one line and the two ends meet. They part only where an item still sits
     * under two suppliers — a saved quantity kept beside the default line — and
     * each of those lines carries the FULL suggested quantity, so summing lines
     * answers "what if it were ordered from both" while reading as "what we
     * need to spend". It used to part on every item, when the list put each
     * one under every supplier it could find.
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
      doubleOrders: suppliers.reduce(
        (a, g) => a + g.lines.filter((l) => l.kitDoubleOrder).length,
        0,
      ),
    },
  };
}

/**
 * Each item counted once, at its cheapest and its dearest candidate supplier.
 *
 * `estimatedCost` is kept alongside as the sum of every line — what the export
 * sheets add up to when nothing has been decided — so nothing that relied on it
 * breaks. It is simply no longer what the page leads with.
 */
function requirementRange(
  suppliers: { lines: { itemUid: string; estCost: number }[] }[],
): { requirementLow: number; requirementHigh: number; estimatedCost: number } {
  const perItem = new Map<string, { low: number; high: number }>();
  let estimatedCost = 0;
  for (const group of suppliers) {
    for (const line of group.lines) {
      estimatedCost += line.estCost;
      const seen = perItem.get(line.itemUid);
      if (!seen) {
        perItem.set(line.itemUid, { low: line.estCost, high: line.estCost });
        continue;
      }
      seen.low = Math.min(seen.low, line.estCost);
      seen.high = Math.max(seen.high, line.estCost);
    }
  }
  let requirementLow = 0;
  let requirementHigh = 0;
  for (const { low, high } of perItem.values()) {
    requirementLow += low;
    requirementHigh += high;
  }
  const round = (v: number): number => Number(v.toFixed(2));
  return {
    requirementLow: round(requirementLow),
    requirementHigh: round(requirementHigh),
    estimatedCost: round(estimatedCost),
  };
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
  if (cart.kit.doubleOrders > 0) {
    lines.push(
      esc(
        `WARNING: ${cart.kit.doubleOrders} line(s) order a kit and something it is made of at the same time. Review the rows marked in "Kit CHECK" before ordering.`,
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
 */
export async function undoCartDecision(itemUid: string): Promise<void> {
  await cartWrite(itemUid, "undo_decision", null, async (client) => {
    await client.query(`DELETE FROM platform_purchase_cart WHERE item_uid = $1`, [itemUid]);
    await clearPickAck(client, itemUid);
  });
}
