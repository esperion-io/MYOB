import { config } from "../config.js";
import { loadKitGraph } from "./kits.js";
import {
  computedItems,
  kitRuleSummary,
  resolveWindow,
  type DemandWindow,
} from "./queries.js";

/**
 * The two kit screens that survived (P7).
 *
 * There was a third — a standalone register with a confirmation queue, eight
 * filters and a KPI row. It listed the same 513 items as Products & BOM, using
 * the same buildable-now formula, so it was removed and its two useful columns
 * folded into that page instead.
 *
 * What is left is the part neither page could provide on its own: the
 * reconciliation that proves nothing is double-counted, and the build-versus-buy
 * comparison for a single item.
 *
 * Kept apart from kits.ts, which holds the rules. queries.ts applies the rules
 * on every computed set and must not drag the screens in with them.
 */

export interface KitComponentLine {
  uid: string;
  number: string | null;
  name: string | null;
  qtyPer: number;
  freeStock: number | null;
  /** Still to arrive on open purchase orders. */
  incomingQty: number;
  averageCost: number | null;
  lineCost: number | null;
  /** Units needed to build the planned quantity, and what is missing. */
  needed: number;
  short: number;
  /** Short even after everything on order has landed. */
  shortAfterIncoming: number;
  /** This component is itself a kit, so the tree carries on below it. */
  isKit: boolean;
}

/**
 * Build versus buy for one item, with the numbers that actually decide it.
 *
 * Cost alone rarely settles it — the two routes land within a few percent of
 * each other and the cheaper one moves whenever a container lands. So the
 * answer leads with the constraint that usually decides it instead: how many
 * could be built today, and how many once stock already on the water arrives.
 */
export async function kitDetail(uid: string, opts?: Partial<DemandWindow>) {
  const win = resolveWindow(opts);
  const [items, graph] = await Promise.all([computedItems(win), loadKitGraph()]);
  const byUid = new Map(items.map((i) => [i.uid, i]));
  const item = byUid.get(uid);
  if (!item) return null;
  const form = graph.form.get(uid) ?? null;

  const planQty = item.kit?.buildPlanQty || item.suggestion?.qty || 0;
  const components: KitComponentLine[] = (graph.childrenOf.get(uid) ?? []).map((e) => {
    const c = byUid.get(e.componentUid);
    const free = c?.qtyFreeStock ?? null;
    const incoming = c?.incomingQty ?? 0;
    const needed = planQty * e.qtyPer;
    const onShelf = Math.max(free ?? 0, 0);
    return {
      uid: e.componentUid,
      number: c?.number ?? null,
      name: c?.name ?? null,
      qtyPer: e.qtyPer,
      freeStock: free,
      incomingQty: incoming,
      averageCost: c?.averageCost ?? null,
      lineCost: c?.averageCost != null ? Number((e.qtyPer * c.averageCost).toFixed(4)) : null,
      needed: Number(needed.toFixed(1)),
      short: Number(Math.max(needed - onShelf, 0).toFixed(1)),
      shortAfterIncoming: Number(Math.max(needed - onShelf - incoming, 0).toFixed(1)),
      isKit: graph.form.has(e.componentUid),
    };
  });
  components.sort((a, b) => (b.lineCost ?? 0) - (a.lineCost ?? 0));

  /*
   * How many could be built once stock already on the water lands.
   *
   * Without this the page reads as an argument for buying complete whenever the
   * shelf is bare, even when the parts are bought, paid for and in transit —
   * BP1675S16 showed 18 buildable against 30,000 bolts and 60,000 nuts on open
   * orders, which then landed. Buying the packs as well would have been buying
   * the same requirement a second time.
   */
  const buildableWithIncoming = components.length
    ? Math.max(
        Math.min(
          ...components.map((c) =>
            Math.floor((Math.max(c.freeStock ?? 0, 0) + c.incomingQty) / c.qtyPer),
          ),
        ),
        0,
      )
    : 0;

  /*
   * Where this item's own units sit inside other stock, and what depends on it.
   * A bolt pack is both a kit and a component — 56 items on Allied's file are
   * both — so the answer has to run in both directions.
   */
  const usedIn = (graph.parentsOf.get(uid) ?? []).map((e) => {
    const p = byUid.get(e.parentUid);
    return {
      uid: e.parentUid,
      number: p?.number ?? null,
      name: p?.name ?? null,
      qtyPer: e.qtyPer,
      freeStock: p?.qtyFreeStock ?? null,
      form: graph.form.get(e.parentUid)?.form ?? null,
    };
  });

  return {
    asAt: win.asAt,
    item: {
      uid: item.uid,
      number: item.number,
      name: item.name,
      onHand: item.qtyOnHand,
      freeStock: item.qtyFreeStock,
      incoming: item.incomingQty,
      averageCost: item.averageCost,
      minLevel: item.minLevel,
      flags: item.flags,
      suggestion: item.suggestion,
      kit: item.kit,
    },
    form,
    planQty,
    buildableWithIncoming,
    targetCoverWeeks: config.insights.targetCoverWeeks,
    components,
    heldIn: item.kit?.heldIn ?? [],
    usedIn,
  };
}

/**
 * The proof that nothing is counted twice.
 *
 * The brief asks for both visibility of component stock held inside kits and a
 * guarantee the two are not double-counted, which sound contradictory until the
 * counting rule is stated: a unit is counted in the form it is physically held
 * in, and embedded quantities are a view of stock already valued under the kit.
 *
 * So this returns three numbers and the arithmetic between them. `stockValue`
 * is what the platform reports and is unchanged by this whole feature.
 * `embeddedValue` is the same stock seen through the component's eyes.
 * `ifBothWereCounted` is what a spreadsheet adding them would say — the
 * overstatement Allied are being protected from, in dollars.
 */
export async function kitReconciliation(opts?: Partial<DemandWindow>) {
  const win = resolveWindow(opts);
  const [items, graph, summary] = await Promise.all([
    computedItems(win),
    loadKitGraph(),
    kitRuleSummary(win),
  ]);

  let stockValue = 0;
  let kitStockValue = 0;
  let embeddedValue = 0;
  let embeddedUnits = 0;
  const rows: {
    uid: string;
    number: string | null;
    name: string | null;
    loose: number | null;
    embedded: number;
    embeddedValue: number;
    heldIn: string[];
  }[] = [];

  for (const item of items) {
    stockValue += item.currentValue ?? 0;
    if (graph.form.has(item.uid)) kitStockValue += item.currentValue ?? 0;
    const e = item.kit?.embeddedUnits ?? 0;
    if (e <= 0) continue;
    embeddedUnits += e;
    embeddedValue += item.kit?.embeddedValue ?? 0;
    rows.push({
      uid: item.uid,
      number: item.number,
      name: item.name,
      loose: item.qtyOnHand,
      embedded: e,
      embeddedValue: item.kit?.embeddedValue ?? 0,
      heldIn: (item.kit?.heldIn ?? []).slice(0, 4).map((h) => h.number ?? h.kitUid),
    });
  }
  rows.sort((a, b) => b.embeddedValue - a.embeddedValue);

  const round = (v: number) => Number(v.toFixed(2));
  return {
    asAt: win.asAt,
    stockValue: round(stockValue),
    kitStockValue: round(kitStockValue),
    embeddedValue: round(embeddedValue),
    embeddedUnits: Number(embeddedUnits.toFixed(1)),
    componentsWithEmbedded: rows.length,
    ifBothWereCounted: round(stockValue + embeddedValue),
    overstatementPct: stockValue > 0 ? round((embeddedValue / stockValue) * 100) : 0,
    summary,
    rows: rows.slice(0, 15),
  };
}
