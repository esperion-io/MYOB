import { config } from "../config.js";
import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";
import type { ItemComputed } from "./queries.js";

/**
 * Prebuilt kits and components (P7).
 *
 * Allied hold the same physical thing in two forms. A bolt pack is either
 * bought complete from a specialist supplier, or made here from a bolt, a nut
 * and two washers. Their own file shows both routes running at once: BP1675G
 * was billed in container loads of 6,000-10,000 in Aug 24, Nov, Mar, May and
 * Jul, and built in-house in batches of 50-1,450 in the months between.
 *
 * Until now the two forms were unrelated item codes, which is what produced
 * the three failures in the brief. This module is the rule layer that ties
 * them together. It is deliberately separate from the presentation layer
 * (kitPlan.ts) so that queries.ts can apply the rules without importing the
 * screens, and there is no cycle between the two.
 *
 * THE THREE RULES, and the reasoning behind each:
 *
 *  1. An ASSEMBLED kit is not bought. Its shortfall is a build plan, not a
 *     purchase line. BP1675S16 currently carries a 2,500-unit suggestion worth
 *     NZ$32,157 against an item Allied have never once purchased — that line is
 *     noise in a purchase cart and a real instruction on a build sheet.
 *
 *  2. A PREBUILT kit's components are not bought in order to build it. If the
 *     decision is to buy the pack complete, ordering the bolts to make it is
 *     ordering the same requirement twice.
 *
 *  3. Prebuilt stock is used before components are ordered. This is the
 *     brief's "prioritise prebuilt kit usage", and it is the case with money in
 *     it: 62 components hold NZ$39,051 of stock inside packs on the shelf while
 *     their own on-hand figure reads low.
 *
 * WHAT THESE RULES NEVER DO is silently delete a number. Every unit withheld is
 * reported on the item as `kit.withheld`, with the reason and the kits
 * responsible, and is shown in the cart and on the item page. The rule can be
 * argued with, which means it has to be visible.
 *
 * ON DOUBLE-COUNTING, once, because it governs everything below: a unit is
 * counted in the form it is physically held in. Four loose bolts are four
 * bolts; the same four inside a sealed pack are one pack, valued as a pack.
 * `embeddedUnits` is therefore a view of stock that is ALREADY counted under
 * the kit, never an addition to it, and no total in this product sums the two.
 * kitReconciliation() in kitPlan.ts proves that against the live file.
 */

export type KitForm = "prebuilt" | "assembled" | "hybrid" | "not_a_kit";

export const KIT_FORMS: KitForm[] = ["prebuilt", "assembled", "hybrid", "not_a_kit"];

export function isKitForm(v: unknown): v is KitForm {
  return typeof v === "string" && (KIT_FORMS as string[]).includes(v);
}

/** How strong the file's evidence is that an item is bought complete. */
export type KitEvidence = "purchased" | "on_order" | "flagged" | "none";

export interface KitFormRow {
  itemUid: string;
  form: KitForm;
  /** True once a person has decided. Until then `form` is only a proposal. */
  confirmed: boolean;
  proposedForm: KitForm;
  evidence: KitEvidence;
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
  embedded: Map<string, EmbeddedHolding[]>;
  buildOption: Map<string, KitBuildOption>;
}

let graphCache: { at: number; graph: KitGraph } | null = null;

/** Drop the cached graph after a decision changes what the rules would do. */
export function invalidateKitGraph(): void {
  graphCache = null;
}

/**
 * Everything the rules need, in four small queries.
 *
 * All of it is derived from views defined in the schema, so the recursion,
 * the cycle guard and the free-stock basis live in one place rather than being
 * restated here.
 */
export async function loadKitGraph(): Promise<KitGraph> {
  /*
   * Cached for the same 30 seconds as the computed item set.
   *
   * kit_embedded_stock walks the recipe recursively over the anchored ledger,
   * which costs about a second and a half. Every computedItems call needs the
   * graph, and the Kits page asks three endpoints at once, so uncached this ran
   * four times per page load and dominated the response — a nine-second page
   * built almost entirely out of recomputing the same immutable answer.
   */
  if (graphCache && Date.now() - graphCache.at < 30_000) return graphCache.graph;
  await ensureInsightsSchema();
  const pool = getPool();

  const [edges, forms, embedded, build] = await Promise.all([
    pool.query(`SELECT parent_uid, component_uid, qty_per FROM effective_bom WHERE qty_per > 0`),
    pool.query(
      `SELECT item_uid, form, confirmed, proposed_form, evidence, component_count,
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
      form: (r.form as KitForm) ?? "assembled",
      confirmed: Boolean(r.confirmed),
      proposedForm: (r.proposed_form as KitForm) ?? "assembled",
      evidence: (r.evidence as KitEvidence) ?? "none",
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

  const embeddedMap = new Map<string, EmbeddedHolding[]>();
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
  /** The kit is made here, so its shortfall is a build plan, not an order. */
  | "build_not_buy"
  /** The parent is bought complete, so its components are not bought to build it. */
  | "parent_bought_prebuilt"
  /** The units are already on the shelf, inside packs. */
  | "in_prebuilt_stock";

export interface KitFacts {
  /** Set when the item has a recipe of its own. */
  form: KitForm | null;
  formConfirmed: boolean;
  proposedForm: KitForm | null;
  evidence: KitEvidence | null;
  /** Units of this item sitting inside kit stock. Already valued as kits. */
  embeddedUnits: number;
  embeddedValue: number;
  heldIn: { kitUid: string; number: string | null; units: number; depth: number }[];
  /** What this item costs to make from components, at average cost. */
  buildCost: number | null;
  /** Null when the roll-up has uncosted components and cannot be trusted. */
  buildCostComplete: boolean;
  /** How many could be made today, limited by the scarcest component. */
  buildableNow: number | null;
  /** Units held back from the purchase suggestion, and why. */
  withheld: {
    qty: number;
    reason: WithheldReason;
    /** The kits the rule acted on, for the explanation on screen. */
    kitUids: string[];
  } | null;
  /** Quantity this item still needs, once the kit rules have had their say. */
  buildPlanQty: number;
  /** This kit and one of its components are both still being ordered. */
  doubleOrder: boolean;
}

export interface KitRuleSummary {
  kitsWithRecipe: number;
  kitsConfirmed: number;
  /** Kits whose purchase suggestion became a build plan. */
  buildPlans: number;
  buildPlanUnits: number;
  /** Component lines reduced, and by how much money. */
  linesReduced: number;
  unitsWithheld: number;
  valueWithheld: number;
  /** Kit + component both still ordered — needs a person. */
  doubleOrders: number;
  /** Component stock that is physically present but held inside kits. */
  componentsWithEmbedded: number;
  embeddedValue: number;
}

/**
 * A summary describing no rules at all.
 *
 * Lives here rather than at the call site so the field names stay inside the
 * kit modules — the boundary check in scripts/check-ledger-boundary.mjs keeps
 * embedded quantities from leaking into code that might add them to a total,
 * and an inline zeroed literal elsewhere would trip it for no good reason.
 */
export const EMPTY_KIT_SUMMARY: KitRuleSummary = {
  kitsWithRecipe: 0,
  kitsConfirmed: 0,
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
 * Apply the three kit rules to a fully computed item set, in place.
 *
 * Runs after every item has its own suggestion, because the rules are about the
 * relationship between two items and cannot be decided row by row. Returns a
 * summary so the caller can report what the rules did rather than leaving the
 * change invisible.
 */
/**
 * Whether a proposed form is strong enough to change a number on its own.
 *
 * The product's standing rule is that detection proposes and Allied confirm,
 * and this is where it would have been quietly broken. Two of the four evidence
 * grades are conclusions, and two are not:
 *
 *   confirmed  — a person decided. Always acts.
 *   purchased  — the item is on a purchase bill. It has genuinely been bought
 *                complete, so "bought prebuilt" is a fact about the file.
 *   none       — no purchase signal anywhere across two years. Proposing
 *                "made here, not bought" from a complete absence of purchase
 *                records is safe, and it is where the value is: 443 items.
 *   flagged /  — MYOB's "I buy this item" checkbox, or an order never billed.
 *   on_order     Intent, not history. Left visible in the queue and acted on
 *                only once confirmed. Without this gate a checkbox on
 *                KITST1040S alone withheld 1,539 stainless nuts from a real
 *                order, which is precisely the kind of silent, unearned
 *                conclusion the stocktake work refused to make.
 */
function ruleApplies(row: KitFormRow): boolean {
  if (row.form === "not_a_kit") return false;
  return row.confirmed || row.evidence === "purchased" || row.evidence === "none";
}

export function applyKitRules(items: ItemComputed[], graph: KitGraph): KitRuleSummary {
  const byUid = new Map(items.map((i) => [i.uid, i]));
  const targetCover = config.insights.targetCoverWeeks;

  /*
   * Pass 1 — how much kit stock is genuinely spare.
   *
   * Kit stock that the kit's own demand needs cannot also cover its components:
   * 340 packs earmarked for pack customers are not 1,360 spare bolts. Spare is
   * therefore free stock beyond the kit's own cover target and minimum level —
   * the same target the kit's own suggestion is measured against, so the two
   * numbers cannot contradict each other.
   *
   * Every form counts here, not only the bought ones. Whether a pack was
   * purchased complete or assembled last Tuesday, the components are physically
   * inside it, and that is the only thing this pass is measuring.
   */
  const spare = new Map<string, number>();
  for (const [uid, row] of graph.form) {
    if (!ruleApplies(row)) continue;
    const kit = byUid.get(uid);
    if (!kit) continue;
    const free = Math.max(kit.qtyFreeStock ?? 0, 0);
    const ownNeed = kit.demand.weekly * targetCover + Math.max(kit.minLevel ?? 0, 0);
    const s = free - ownNeed;
    if (s > 0) spare.set(uid, s);
  }

  /*
   * Pass 2 — what each component can draw on.
   *
   * `offset` is real stock in packs; `prebuiltParents` is the stronger case,
   * where Allied have decided the parent is bought complete so its components
   * are not bought to build it at all, stock or no stock.
   */
  const offset = new Map<string, { units: number; kits: Set<string> }>();
  const prebuiltParents = new Map<string, Set<string>>();
  for (const [parentUid, edges] of graph.childrenOf) {
    const row = graph.form.get(parentUid);
    if (!row || !ruleApplies(row)) continue;
    const spareUnits = spare.get(parentUid) ?? 0;
    for (const edge of edges) {
      if (row.form === "prebuilt") {
        const set = prebuiltParents.get(edge.componentUid) ?? new Set<string>();
        set.add(parentUid);
        prebuiltParents.set(edge.componentUid, set);
      }
      if (spareUnits > 0) {
        const acc = offset.get(edge.componentUid) ?? { units: 0, kits: new Set<string>() };
        acc.units += spareUnits * edge.qtyPer;
        acc.kits.add(parentUid);
        offset.set(edge.componentUid, acc);
      }
    }
  }

  const summary: KitRuleSummary = {
    kitsWithRecipe: graph.form.size,
    kitsConfirmed: [...graph.form.values()].filter((f) => f.confirmed).length,
    buildPlans: 0,
    buildPlanUnits: 0,
    linesReduced: 0,
    unitsWithheld: 0,
    valueWithheld: 0,
    doubleOrders: 0,
    componentsWithEmbedded: 0,
    embeddedValue: 0,
  };

  // Pass 3 — attach the facts, and let the rules act on each suggestion.
  for (const item of items) {
    const row = graph.form.get(item.uid);
    const holdings = graph.embedded.get(item.uid) ?? [];
    const build = graph.buildOption.get(item.uid);
    const off = offset.get(item.uid);
    const prebuilt = prebuiltParents.get(item.uid);
    if (!row && !holdings.length && !off && !prebuilt) continue;

    const embeddedUnits = holdings.reduce((s, h) => s + h.units, 0);
    const embeddedValue = embeddedUnits * (item.averageCost ?? 0);
    if (embeddedUnits > 0) {
      summary.componentsWithEmbedded += 1;
      summary.embeddedValue += embeddedValue;
    }

    const facts: KitFacts = {
      form: row?.form ?? null,
      formConfirmed: row?.confirmed ?? false,
      proposedForm: row?.proposedForm ?? null,
      evidence: row?.evidence ?? null,
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
      buildCost:
        build && build.componentCount > 0 ? round(build.componentCost, 4) : null,
      buildCostComplete: build ? build.costedComponents === build.componentCount : false,
      buildableNow: build ? Math.max(build.buildableNow, 0) : null,
      withheld: null,
      buildPlanQty: 0,
      doubleOrder: false,
    };

    /*
     * Rule 1 — an assembled kit is not bought.
     *
     * The requirement is real; the route is wrong. The quantity moves to
     * buildPlanQty and off the purchase cart, which is where the Kits page
     * picks it up as a build sheet.
     */
    if (
      row &&
      row.form === "assembled" &&
      ruleApplies(row) &&
      item.suggestion &&
      item.suggestion.qty > 0
    ) {
      facts.withheld = {
        qty: item.suggestion.qty,
        reason: "build_not_buy",
        kitUids: [item.uid],
      };
      facts.buildPlanQty = item.suggestion.qty;
      summary.buildPlans += 1;
      summary.buildPlanUnits += item.suggestion.qty;
      summary.unitsWithheld += item.suggestion.qty;
      summary.valueWithheld += item.suggestion.qty * (item.averageCost ?? 0);
      item.suggestion = null;
      item.flags.push("build_not_buy");
    } else if (item.suggestion && item.suggestion.qty > 0 && (off || prebuilt)) {
      /*
       * Rules 2 and 3 — a component's order is reduced by the part of its
       * demand that came through building a kit.
       *
       * Only that part. A bolt sold loose over the counter cannot be picked out
       * of a sealed pack, so direct sales demand is never offset, and the
       * split between the two is already measured: comp_window is consumption
       * by builds, direct_window is invoiced sales.
       *
       * The cap is the demand-driven part of the suggestion, not the whole of
       * it. Where a suggestion is really MYOB's minimum level talking, the
       * minimum survives the rule — over-ordering is the complaint in the
       * brief, but a stockout is the worse of the two failures, and an
       * inflated minimum is already flagged separately as min_above_demand.
       */
      const measured = item.demand.componentWindow + item.demand.directWindow;
      const buildShare = measured > 0 ? item.demand.componentWindow / measured : 0;
      if (buildShare > 0) {
        const demandDriven = item.demand.weekly * targetCover;
        const cap = Math.min(item.suggestion.qty, demandDriven * buildShare);
        const available = prebuilt ? cap : Math.min(off?.units ?? 0, cap);
        const withheldQty = Math.min(cap, available);
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
            reason: prebuilt ? "parent_bought_prebuilt" : "in_prebuilt_stock",
            kitUids: [...(prebuilt ?? off?.kits ?? [])],
          };
          summary.linesReduced += 1;
          summary.unitsWithheld += actuallyWithheld;
          summary.valueWithheld += actuallyWithheld * (item.averageCost ?? 0);
          item.flags.push("kit_covered");
          if (rounded <= 0) {
            item.suggestion = null;
          } else {
            item.suggestion = {
              qty: rounded,
              rationale: {
                ...item.suggestion.rationale,
                kitWithheld: round(actuallyWithheld, 1),
                kitWithheldReason: facts.withheld.reason,
                beforeKitRules: item.suggestion.qty,
              },
            };
          }
        }
      }
    }

    item.kit = facts;
  }

  /*
   * Pass 4 — the double order.
   *
   * A hybrid kit can legitimately be bought complete while its components are
   * also bought, because both routes are live. That is exactly why it needs a
   * person: the two orders may be one requirement counted twice. Flagged on
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
 * Record Allied's decision about how an item is sourced.
 *
 * This single field is also the conversion mechanism the brief asks for: an
 * item moves between kit and component tracking by changing its form, and every
 * figure downstream — suggestions, the cart, embedded stock, the build sheet —
 * recomputes from it. There is no migration and nothing to reconcile.
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

/** Drop a decision, so the item falls back to the proposed form. */
export async function clearKitForm(itemUid: string): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(`DELETE FROM platform_kit_policy WHERE item_uid = $1`, [itemUid]);
  invalidateKitGraph();
}
