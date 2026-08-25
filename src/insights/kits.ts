import { config } from "../config.js";
import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";
import type { ItemComputed } from "./queries.js";

/**
 * Kits and components (P7).
 *
 * Allied hold the same physical thing in two forms. A bolt pack is either
 * bought complete from a specialist supplier, or made here from a bolt, a nut
 * and two washers. Their own file shows both routes running at once: BP1675G
 * was billed in container loads of 6,000-10,000 every few months and built
 * in-house in batches of 50-1,450 in the months between.
 *
 * TWO RULES, both derived from purchase bills and nothing else:
 *
 *  1. An item Allied have never bought complete is not put on a purchase
 *     order. Its shortfall is a build sheet. This is the rule that pays:
 *     212 lines worth NZ$48,383 left the cart, the largest being BP1675S16
 *     at NZ$34,692 against an item never once purchased.
 *
 *  2. Components already sitting inside packs on the shelf are not ordered
 *     again — capped at the part of demand that came through building, because
 *     a bolt sold loose over the counter cannot be picked out of a sealed pack.
 *
 * WHAT WAS DELIBERATELY REMOVED, because it cost more than it returned: a
 * third rule blocking a bought-complete kit's components (it moved one item,
 * NZ$455), and the graded-evidence model and confirmation queue that existed
 * only to make that third rule safe. MYOB's "I buy this item" checkbox is now
 * ignored outright — 51 recipe parents carry it with no purchase behind it,
 * and all 51 have no average cost, so honouring it only put zero-value noise
 * in the cart.
 *
 * WHAT THESE RULES NEVER DO is silently delete a number. Every unit withheld
 * is reported on the item as `kit.withheld`, with the reason and the kits
 * responsible, and is shown on the item page and in the cart.
 *
 * ON DOUBLE-COUNTING, once, because it governs everything: a unit is counted in
 * the form it is physically held in. `embeddedUnits` is a view of stock ALREADY
 * counted under the kit, never an addition to it, and no total sums the two.
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

export interface EmbeddedHolding {
  kitUid: string;
  number: string | null;
  units: number;
  /** 1 = directly inside that kit; 2 = inside a kit inside that kit. */
  depth: number;
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
  embedded: Map<string, Omit<EmbeddedHolding, "number">[]>;
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
 * Cached for the same 30 seconds as the computed item set: kit_embedded_stock
 * walks the recipe recursively over the anchored ledger and costs about a
 * second and a half, and every computedItems call needs it.
 */
export async function loadKitGraph(): Promise<KitGraph> {
  if (graphCache && Date.now() - graphCache.at < 30_000) return graphCache.graph;
  await ensureInsightsSchema();
  const pool = getPool();

  const [edges, forms, embedded, build] = await Promise.all([
    pool.query(`SELECT parent_uid, component_uid, qty_per FROM effective_bom WHERE qty_per > 0`),
    pool.query(
      `SELECT item_uid, form, derived_form, overridden, component_count,
              bought_qty, bought_bills, last_bought::date::text AS last_bought,
              built_qty, built_lines, last_built::date::text AS last_built,
              note, decided_by, decided_at::text AS decided_at
       FROM kit_form`,
    ),
    pool.query(`SELECT item_uid, kit_uid, units, depth FROM kit_embedded_stock WHERE units > 0`),
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
      builtQty: Number(r.built_qty ?? 0),
      builtLines: Number(r.built_lines ?? 0),
      lastBuilt: (r.last_built as string) ?? null,
      note: (r.note as string) ?? null,
      decidedBy: (r.decided_by as string) ?? null,
      decidedAt: (r.decided_at as string) ?? null,
    });
  }

  const embeddedMap = new Map<string, Omit<EmbeddedHolding, "number">[]>();
  for (const r of embedded.rows) {
    const uid = String(r.item_uid);
    const list = embeddedMap.get(uid) ?? [];
    list.push({ kitUid: String(r.kit_uid), units: Number(r.units), depth: Number(r.depth ?? 1) });
    embeddedMap.set(uid, list);
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

  const graph = { childrenOf, parentsOf, form, embedded: embeddedMap, buildOption };
  graphCache = { at: Date.now(), graph };
  return graph;
}

/** Why a suggested purchase quantity was held back. */
export type WithheldReason =
  /** Allied make this here, so its shortfall is a build sheet. */
  | "build_not_buy"
  /** The units are already on the shelf, inside packs. */
  | "in_pack_stock";

export interface KitFacts {
  /** Set when the item has a recipe of its own. */
  form: KitForm | null;
  derivedForm: KitForm | null;
  /** True when Allied set the form by hand rather than taking the default. */
  overridden: boolean;
  /** Units of this item sitting inside kit stock. Already valued as kits. */
  embeddedUnits: number;
  embeddedValue: number;
  heldIn: EmbeddedHolding[];
  /** What this item costs to make from components, at average cost. */
  buildCost: number | null;
  /** False when the roll-up has uncosted components and cannot be trusted. */
  buildCostComplete: boolean;
  /** How many could be made today, limited by the scarcest component. */
  buildableNow: number | null;
  /** Units held back from the purchase suggestion, and why. */
  withheld: { qty: number; reason: WithheldReason; kitUids: string[] } | null;
  /** Quantity this item still needs on a build sheet rather than an order. */
  buildPlanQty: number;
  /** This kit and one of its components are both still being ordered. */
  doubleOrder: boolean;
}

export interface KitRuleSummary {
  kitsWithRecipe: number;
  madeHere: number;
  buyAllowed: number;
  /** Purchase lines that became build sheets. */
  buildPlans: number;
  buildPlanUnits: number;
  /** Component lines reduced by pack stock, and by how much money. */
  linesReduced: number;
  unitsWithheld: number;
  valueWithheld: number;
  /** Kit + component both still ordered — needs a person. */
  doubleOrders: number;
  componentsWithEmbedded: number;
  embeddedValue: number;
}

export const EMPTY_KIT_SUMMARY: KitRuleSummary = {
  kitsWithRecipe: 0,
  madeHere: 0,
  buyAllowed: 0,
  buildPlans: 0,
  buildPlanUnits: 0,
  linesReduced: 0,
  unitsWithheld: 0,
  valueWithheld: 0,
  doubleOrders: 0,
  componentsWithEmbedded: 0,
  embeddedValue: 0,
};

const round = (v: number, dp = 2): number => Number(v.toFixed(dp));

/**
 * Apply the two kit rules to a fully computed item set, in place.
 *
 * Runs after every item has its own suggestion, because the rules are about the
 * relationship between two items and cannot be decided row by row. Returns a
 * summary so the caller can report what the rules did rather than leaving the
 * change invisible.
 */
export function applyKitRules(items: ItemComputed[], graph: KitGraph): KitRuleSummary {
  const byUid = new Map(items.map((i) => [i.uid, i]));
  const targetCover = config.insights.targetCoverWeeks;

  /*
   * Pass 1 — how much kit stock is genuinely spare.
   *
   * Kit stock the kit's own demand needs cannot also cover its components: 340
   * packs earmarked for pack customers are not 1,360 spare bolts. Spare is free
   * stock beyond the kit's own cover target and minimum level — the same target
   * its own suggestion is measured against, so the two cannot contradict.
   *
   * Every form counts here. Whether a pack was purchased complete or assembled
   * last Tuesday, the components are physically inside it, and that is the only
   * thing this pass measures.
   */
  const spare = new Map<string, number>();
  for (const [uid] of graph.form) {
    const kit = byUid.get(uid);
    if (!kit) continue;
    const free = Math.max(kit.qtyFreeStock ?? 0, 0);
    const ownNeed = kit.demand.weekly * targetCover + Math.max(kit.minLevel ?? 0, 0);
    if (free - ownNeed > 0) spare.set(uid, free - ownNeed);
  }

  // Pass 2 — what each component can draw on, and from which packs.
  const offset = new Map<string, { units: number; kits: Set<string> }>();
  for (const [parentUid, edges] of graph.childrenOf) {
    const spareUnits = spare.get(parentUid) ?? 0;
    if (spareUnits <= 0) continue;
    for (const edge of edges) {
      const acc = offset.get(edge.componentUid) ?? { units: 0, kits: new Set<string>() };
      acc.units += spareUnits * edge.qtyPer;
      acc.kits.add(parentUid);
      offset.set(edge.componentUid, acc);
    }
  }

  const summary: KitRuleSummary = { ...EMPTY_KIT_SUMMARY, kitsWithRecipe: graph.form.size };
  for (const f of graph.form.values()) {
    if (f.form === "made_here") summary.madeHere += 1;
    else summary.buyAllowed += 1;
  }

  // Pass 3 — attach the facts, and let the rules act on each suggestion.
  for (const item of items) {
    const row = graph.form.get(item.uid);
    const holdings = graph.embedded.get(item.uid) ?? [];
    const build = graph.buildOption.get(item.uid);
    const off = offset.get(item.uid);
    if (!row && !holdings.length && !off) continue;

    const embeddedUnits = holdings.reduce((s, h) => s + h.units, 0);
    const embeddedValue = embeddedUnits * (item.averageCost ?? 0);
    if (embeddedUnits > 0) {
      summary.componentsWithEmbedded += 1;
      summary.embeddedValue += embeddedValue;
    }

    const facts: KitFacts = {
      form: row?.form ?? null,
      derivedForm: row?.derivedForm ?? null,
      overridden: row?.overridden ?? false,
      embeddedUnits: round(embeddedUnits, 1),
      embeddedValue: round(embeddedValue),
      // The item number travels with the uid: every screen showing this list
      // needs a label, and a bare uid is unreadable.
      heldIn: holdings
        .slice()
        .sort((a, b) => b.units - a.units)
        .map((h) => ({
          kitUid: h.kitUid,
          number: byUid.get(h.kitUid)?.number ?? null,
          units: round(h.units, 1),
          depth: h.depth,
        })),
      buildCost: build && build.componentCount > 0 ? round(build.componentCost, 4) : null,
      buildCostComplete: build ? build.costedComponents === build.componentCount : false,
      buildableNow: build ? Math.max(build.buildableNow, 0) : null,
      withheld: null,
      buildPlanQty: 0,
      doubleOrder: false,
    };

    /*
     * Rule 1 — an item Allied have never bought complete is not bought now.
     *
     * The requirement is real; the route is wrong. The quantity moves to
     * buildPlanQty and off the purchase cart, where Products & BOM picks it up.
     */
    if (row?.form === "made_here" && item.suggestion && item.suggestion.qty > 0) {
      facts.withheld = { qty: item.suggestion.qty, reason: "build_not_buy", kitUids: [item.uid] };
      facts.buildPlanQty = item.suggestion.qty;
      summary.buildPlans += 1;
      summary.buildPlanUnits += item.suggestion.qty;
      summary.unitsWithheld += item.suggestion.qty;
      summary.valueWithheld += item.suggestion.qty * (item.averageCost ?? 0);
      item.suggestion = null;
      item.flags.push("build_not_buy");
    } else if (item.suggestion && item.suggestion.qty > 0 && off) {
      /*
       * Rule 2 — a component's order is reduced by what is already in packs.
       *
       * Only the part of its demand that came through building. A bolt sold
       * loose over the counter cannot be picked out of a sealed pack, and the
       * split is already measured: comp_window is consumption by builds,
       * direct_window is invoiced sales.
       *
       * The cap is the demand-driven part of the suggestion, not the whole of
       * it. Where a suggestion is really MYOB's minimum level talking, the
       * minimum survives — over-ordering is the complaint in the brief, but a
       * stockout is the worse of the two failures.
       */
      const measured = item.demand.componentWindow + item.demand.directWindow;
      const buildShare = measured > 0 ? item.demand.componentWindow / measured : 0;
      if (buildShare > 0) {
        const cap = Math.min(item.suggestion.qty, item.demand.weekly * targetCover * buildShare);
        const withheldQty = Math.min(cap, off.units);
        if (withheldQty >= 1) {
          const multiple = item.suggestion.rationale.reorderMultiple;
          const remaining = Math.max(item.suggestion.qty - withheldQty, 0);
          const rounded =
            typeof multiple === "number" && multiple > 0
              ? Math.ceil(remaining / multiple) * multiple
              : Math.ceil(remaining);
          const actuallyWithheld = item.suggestion.qty - rounded;
          facts.withheld = {
            qty: round(actuallyWithheld, 1),
            reason: "in_pack_stock",
            kitUids: [...off.kits],
          };
          summary.linesReduced += 1;
          summary.unitsWithheld += actuallyWithheld;
          summary.valueWithheld += actuallyWithheld * (item.averageCost ?? 0);
          item.flags.push("kit_covered");
          item.suggestion =
            rounded <= 0
              ? null
              : {
                  qty: rounded,
                  rationale: {
                    ...item.suggestion.rationale,
                    kitWithheld: round(actuallyWithheld, 1),
                    beforeKitRules: item.suggestion.qty,
                  },
                };
        }
      }
    }

    item.kit = facts;
  }

  /*
   * Pass 4 — the double order.
   *
   * An item Allied buy complete can legitimately be bought while its components
   * are also bought, because both routes are live. That is exactly why it needs
   * a person: the two orders may be one requirement counted twice. Flagged on
   * both sides so it is visible from whichever line Allied are looking at.
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

  summary.unitsWithheld = round(summary.unitsWithheld, 1);
  summary.valueWithheld = round(summary.valueWithheld);
  summary.embeddedValue = round(summary.embeddedValue);
  summary.buildPlanUnits = round(summary.buildPlanUnits, 1);
  return summary;
}

/**
 * Record Allied's override of what the purchase bills imply.
 *
 * This is also the conversion mechanism the brief asks for: an item moves
 * between kit and component tracking by changing this one field, and every
 * figure downstream recomputes from it. There is nothing to migrate.
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
