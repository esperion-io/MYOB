import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";
import type { ItemComputed } from "./queries.js";

/**
 * Kits and components (P7).
 *
 * Allied buy some items as complete kits from a supplier and make others here
 * from a bolt, a nut and two washers. The two forms are one item, and the
 * question that matters is how many kits they can field.
 *
 * THE COUNTING RULE, which the whole module is built on: a kit bought from a
 * supplier is never broken open. It sells as the kit it was bought as. So its
 * contents are NOT component stock, are never added into a component's on-hand
 * figure, and a component's order is never reduced because parts are "inside"
 * a pack — they are not available. A kit is counted as a kit, a component as a
 * component, and nothing is counted across the two.
 *
 * WHAT THAT MAKES AVAILABLE, and it is the headline the product reports:
 *
 *     total kits available = kits on hand + kits buildable from components
 *
 * Kits on hand are consumed first. Whether the kit is sold on its own or used
 * inside a bigger assembly, the stock already sitting there satisfies the need
 * before anything is built, so only the shortfall pulls on components. That
 * falls out of the arithmetic rather than needing a rule: a kit's own free
 * stock reduces its own requirement before any build is planned.
 *
 * ONE RULE, and it exists because of a real defect: an item Allied have never
 * bought complete is not put on a purchase order. There is no price to put on
 * it. BP1675S16 sat in the cart at NZ$34,692 priced off MYOB's average_cost,
 * which for a built item is the cost of having built it, not a purchase price.
 * Those requirements are real and are reported as a quantity to build.
 *
 * PREBUILT KITS ARE DETECTED FROM PURCHASE HISTORY, never from a flag. MYOB's
 * "I buy this item" checkbox sits on 51 recipe parents with no purchase behind
 * it and is ignored outright. 13 items have genuinely been bought complete.
 */

/** Two states. The default is derived from bills; Allied may override it. */
export type KitForm = "made_here" | "buy_allowed";

export const KIT_FORMS: KitForm[] = ["made_here", "buy_allowed"];

export function isKitForm(v: unknown): v is KitForm {
  return typeof v === "string" && (KIT_FORMS as string[]).includes(v);
}

export interface KitFormRow {
  itemUid: string;
  form: KitForm;
  /** What the purchase bills say, before any override. */
  derivedForm: KitForm;
  /** True when Allied have set this by hand. */
  overridden: boolean;
  componentCount: number;
  boughtQty: number;
  boughtBills: number;
  lastBought: string | null;
  /** Weighted average actually paid, and who last supplied it. Null if never bought. */
  buyPrice: number | null;
  lastSupplier: string | null;
  builtQty: number;
  builtLines: number;
  lastBuilt: string | null;
  note: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

export interface KitEdge {
  parentUid: string;
  componentUid: string;
  qtyPer: number;
}

export interface KitBuildOption {
  componentCount: number;
  costedComponents: number;
  componentCost: number;
  buildableNow: number;
  componentsOutOfStock: number;
}

export interface KitGraph {
  childrenOf: Map<string, KitEdge[]>;
  parentsOf: Map<string, KitEdge[]>;
  form: Map<string, KitFormRow>;
  buildOption: Map<string, KitBuildOption>;
}

let graphCache: { at: number; graph: KitGraph } | null = null;

/** Drop the cached graph after an override changes what the rules would do. */
export function invalidateKitGraph(): void {
  graphCache = null;
}

/**
 * Everything the rules need, in four small queries.
 *
 * Cached for the same 30 seconds as the computed item set — every
 * computedItems call needs it, and the Products page asks twice over.
 */
export async function loadKitGraph(): Promise<KitGraph> {
  if (graphCache && Date.now() - graphCache.at < 30_000) return graphCache.graph;
  await ensureInsightsSchema();
  const pool = getPool();

  const [edges, forms, build] = await Promise.all([
    pool.query(`SELECT parent_uid, component_uid, qty_per FROM effective_bom WHERE qty_per > 0`),
    pool.query(
      `SELECT item_uid, form, derived_form, overridden, component_count,
              bought_qty, bought_bills, last_bought::date::text AS last_bought,
              buy_price, last_supplier,
              built_qty, built_lines, last_built::date::text AS last_built,
              note, decided_by, decided_at::text AS decided_at
       FROM kit_form`,
    ),
    pool.query(
      `SELECT item_uid, component_count, costed_components, component_cost,
              buildable_now, components_out_of_stock
       FROM kit_build_option`,
    ),
  ]);

  const childrenOf = new Map<string, KitEdge[]>();
  const parentsOf = new Map<string, KitEdge[]>();
  for (const r of edges.rows) {
    const edge: KitEdge = {
      parentUid: String(r.parent_uid),
      componentUid: String(r.component_uid),
      qtyPer: Number(r.qty_per),
    };
    const kids = childrenOf.get(edge.parentUid) ?? [];
    kids.push(edge);
    childrenOf.set(edge.parentUid, kids);
    const owners = parentsOf.get(edge.componentUid) ?? [];
    owners.push(edge);
    parentsOf.set(edge.componentUid, owners);
  }

  const form = new Map<string, KitFormRow>();
  for (const r of forms.rows) {
    form.set(String(r.item_uid), {
      itemUid: String(r.item_uid),
      form: (r.form as KitForm) ?? "made_here",
      derivedForm: (r.derived_form as KitForm) ?? "made_here",
      overridden: Boolean(r.overridden),
      componentCount: Number(r.component_count ?? 0),
      boughtQty: Number(r.bought_qty ?? 0),
      boughtBills: Number(r.bought_bills ?? 0),
      lastBought: (r.last_bought as string) ?? null,
      buyPrice: r.buy_price == null ? null : Number(r.buy_price),
      lastSupplier: (r.last_supplier as string) ?? null,
      builtQty: Number(r.built_qty ?? 0),
      builtLines: Number(r.built_lines ?? 0),
      lastBuilt: (r.last_built as string) ?? null,
      note: (r.note as string) ?? null,
      decidedBy: (r.decided_by as string) ?? null,
      decidedAt: (r.decided_at as string) ?? null,
    });
  }

  const buildOption = new Map<string, KitBuildOption>();
  for (const r of build.rows) {
    buildOption.set(String(r.item_uid), {
      componentCount: Number(r.component_count ?? 0),
      costedComponents: Number(r.costed_components ?? 0),
      componentCost: Number(r.component_cost ?? 0),
      buildableNow: Number(r.buildable_now ?? 0),
      componentsOutOfStock: Number(r.components_out_of_stock ?? 0),
    });
  }

  const graph = { childrenOf, parentsOf, form, buildOption };
  graphCache = { at: Date.now(), graph };
  return graph;
}

/** Why a suggested purchase quantity was held back. */
export type WithheldReason = "never_bought";

export interface KitFacts {
  /** Set when the item has a recipe of its own. */
  form: KitForm | null;
  derivedForm: KitForm | null;
  /** True when Allied set the form by hand rather than taking the default. */
  overridden: boolean;
  /** Complete kits already on the shelf, bought or previously built. */
  kitsOnHand: number;
  /** How many more could be made today, limited by the scarcest component. */
  buildableNow: number;
  /** kitsOnHand + buildableNow — what Allied could actually field. */
  totalAvailable: number;
  /** What one costs to make from components, at average cost. */
  buildCost: number | null;
  /** False when the roll-up has uncosted components and cannot be trusted. */
  buildCostComplete: boolean;
  /**
   * What Allied have actually paid per unit, weighted across every bill, and
   * who last supplied it. Null on the 500 items never bought complete — there
   * is no purchase price for something never purchased, and inventing one from
   * average_cost is what put a NZ$34,692 phantom line in the cart.
   */
  buyPrice: number | null;
  lastSupplier: string | null;
  /** Units held back from the purchase suggestion, and why. */
  withheld: { qty: number; reason: WithheldReason } | null;
  /** Quantity this item needs, as something to build rather than order. */
  buildPlanQty: number;
  /** This kit and one of its components are both being ordered. */
  doubleOrder: boolean;
}

export interface KitRuleSummary {
  kitsWithRecipe: number;
  /** Items Allied have genuinely bought complete, detected from bills. */
  boughtFromSupplier: number;
  madeHere: number;
  /**
   * Complete kits sitting on the shelf, summed across every kit item.
   *
   * This one is additive because each is a distinct physical unit. Buildable
   * deliberately is NOT summed here: four of Allied's kits are made from the
   * same ST1240S16 and N12S16 pool and each reports 15,492 buildable, but the
   * parts only stretch to 15,492 in total across all four. Adding them would be
   * precisely the double-count this feature exists to prevent, so the buildable
   * figure is only ever reported per item.
   */
  kitsOnHand: number;
  /** Kit products that can be built at all from parts on hand right now. */
  kitsWithBuildable: number;
  /** Requirements reported as something to build rather than order. */
  buildPlans: number;
  buildPlanUnits: number;
  /** Kit + component both being ordered — needs a person. */
  doubleOrders: number;
}

export const EMPTY_KIT_SUMMARY: KitRuleSummary = {
  kitsWithRecipe: 0,
  boughtFromSupplier: 0,
  madeHere: 0,
  kitsOnHand: 0,
  kitsWithBuildable: 0,
  buildPlans: 0,
  buildPlanUnits: 0,
  doubleOrders: 0,
};

const round = (v: number, dp = 2): number => Number(v.toFixed(dp));

/**
 * Attach kit facts to a fully computed item set, in place.
 *
 * Runs after every item has its own suggestion, because availability and the
 * double-order check are relationships between two items and cannot be decided
 * row by row. Returns a summary so the caller can report what happened rather
 * than leaving it invisible.
 */
export function applyKitRules(items: ItemComputed[], graph: KitGraph): KitRuleSummary {
  const byUid = new Map(items.map((i) => [i.uid, i]));
  const summary: KitRuleSummary = { ...EMPTY_KIT_SUMMARY, kitsWithRecipe: graph.form.size };

  for (const item of items) {
    const row = graph.form.get(item.uid);
    if (!row) continue;
    const build = graph.buildOption.get(item.uid);

    /*
     * Availability, which is the whole point of the feature.
     *
     * Kits on hand are complete kits — bought from a supplier or built here
     * earlier, it makes no difference once they are on the shelf. Buildable is
     * what the scarcest component allows on top of that. Their sum is what
     * Allied can actually field, and it is the number the brief asks for.
     */
    const kitsOnHand = Math.max(item.qtyFreeStock ?? 0, 0);
    const buildableNow = Math.max(build?.buildableNow ?? 0, 0);

    const facts: KitFacts = {
      form: row.form,
      derivedForm: row.derivedForm,
      overridden: row.overridden,
      kitsOnHand: round(kitsOnHand, 1),
      buildableNow: round(buildableNow, 1),
      totalAvailable: round(kitsOnHand + buildableNow, 1),
      buildCost: build && build.componentCount > 0 ? round(build.componentCost, 4) : null,
      buildCostComplete: build ? build.costedComponents === build.componentCount : false,
      buyPrice: row.buyPrice,
      lastSupplier: row.lastSupplier,
      withheld: null,
      buildPlanQty: 0,
      doubleOrder: false,
    };

    if (row.form === "made_here") summary.madeHere += 1;
    else summary.boughtFromSupplier += 1;
    summary.kitsOnHand += kitsOnHand;
    if (buildableNow > 0) summary.kitsWithBuildable += 1;

    /*
     * The one rule: something never bought complete is not put on a purchase
     * order, because there is no price to put on it. The requirement is real
     * and survives as a quantity to build.
     */
    if (row.form === "made_here" && item.suggestion && item.suggestion.qty > 0) {
      facts.withheld = { qty: item.suggestion.qty, reason: "never_bought" };
      facts.buildPlanQty = item.suggestion.qty;
      summary.buildPlans += 1;
      summary.buildPlanUnits += item.suggestion.qty;
      item.suggestion = null;
    }

    item.kit = facts;
  }

  summary.kitsOnHand = round(summary.kitsOnHand, 1);
  summary.buildPlanUnits = round(summary.buildPlanUnits, 1);

  /*
   * The double order.
   *
   * A kit Allied genuinely buy can be ordered while its components are also
   * ordered, and that is sometimes right — but it is also how one requirement
   * gets bought twice, in two forms. Flagged on both sides so it is visible
   * from whichever line they are looking at.
   */
  for (const [parentUid, edges] of graph.childrenOf) {
    const kit = byUid.get(parentUid);
    if (!kit?.suggestion || !kit.kit) continue;
    const clashing = edges
      .map((e) => byUid.get(e.componentUid))
      .filter((c): c is ItemComputed => Boolean(c?.suggestion));
    if (!clashing.length) continue;
    kit.kit.doubleOrder = true;
    kit.flags.push("kit_double_order");
    summary.doubleOrders += 1;
    for (const c of clashing) {
      if (c.kit) c.kit.doubleOrder = true;
      if (!c.flags.includes("kit_double_order")) c.flags.push("kit_double_order");
    }
  }

  return summary;
}

/**
 * Record Allied's override of what the purchase bills imply.
 *
 * This is the conversion mechanism the brief asks for: an item moves between
 * kit and component tracking by changing this one field, and every figure
 * downstream recomputes from it.
 */
export async function setKitForm(params: {
  itemUid: string;
  form: KitForm;
  note?: string | null;
  decidedBy?: string | null;
}): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(
    `INSERT INTO platform_kit_policy (item_uid, form, note, decided_by, decided_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (item_uid) DO UPDATE
       SET form = EXCLUDED.form, note = EXCLUDED.note,
           decided_by = EXCLUDED.decided_by, decided_at = NOW()`,
    [params.itemUid, params.form, params.note ?? null, params.decidedBy ?? null],
  );
  invalidateKitGraph();
}

/** Drop the override, so the item falls back to what its bills say. */
export async function clearKitForm(itemUid: string): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(`DELETE FROM platform_kit_policy WHERE item_uid = $1`, [itemUid]);
  invalidateKitGraph();
}
