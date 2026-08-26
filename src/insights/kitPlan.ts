import { config } from "../config.js";
import { loadKitGraph } from "./kits.js";
import {
  computedItems,
  kitRuleSummary,
  resolveWindow,
  type DemandWindow,
} from "./queries.js";

/**
 * The kit screens (P7).
 *
 * Two answers, both living inside pages that already exist: how many kits can
 * we field right now, and — for the items Allied genuinely buy complete — is it
 * cheaper to buy or to build.
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
    usedIn,
  };
}

/**
 * How many kits Allied can field, and how they are counted.
 *
 * The brief asks for stock levels of kits, of the components behind them, and
 * of the two together. That is this: complete kits on the shelf, plus what the
 * components allow on top, and the sum of the two.
 *
 * It does NOT add pack contents into component stock. A kit bought from a
 * supplier is never broken open, so its bolts cannot fill a loose bolt order.
 * Counting them in both places is the double-count the brief warns about, and
 * the arithmetic here simply never does it.
 */
export async function kitAvailability(opts?: Partial<DemandWindow>) {
  const win = resolveWindow(opts);
  const [items, graph, summary] = await Promise.all([
    computedItems(win),
    loadKitGraph(),
    kitRuleSummary(win),
  ]);

  const all = items
    .filter((i) => i.kit?.form)
    .map((i) => ({
      uid: i.uid,
      number: i.number,
      name: i.name,
      boughtFromSupplier: i.kit!.form === "buy_allowed",
      lastSupplier: i.kit!.lastSupplier,
      lastBought: graph.form.get(i.uid)?.lastBought ?? null,
      buyPrice: i.kit!.buyPrice,
      buildCost: i.kit!.buildCostComplete ? i.kit!.buildCost : null,
      kitsOnHand: i.kit!.kitsOnHand,
      buildableNow: i.kit!.buildableNow,
      totalAvailable: i.kit!.totalAvailable,
      buildPlanQty: i.kit!.buildPlanQty,
      doubleOrder: i.kit!.doubleOrder,
      stockValue: i.currentValue,
    }));

  /*
   * "Most kits available" is a leaderboard, so it drops the items with nothing
   * to show. The bought-complete list is a roster and must not, which is where
   * these two used to part company: the figure strip said 13 items are bought
   * complete and the table beneath it was headed 11, because two of them
   * happen to hold no stock and have no buildable parts today. A count and the
   * list it labels have to agree.
   */
  const rows = all
    .filter((r) => r.totalAvailable > 0 || r.buildPlanQty > 0)
    .sort((a, b) => b.totalAvailable - a.totalAvailable);

  const purchased = all
    .filter((r) => r.boughtFromSupplier)
    .sort((a, b) => (b.kitsOnHand ?? 0) - (a.kitsOnHand ?? 0));

  const round = (v: number) => Number(v.toFixed(2));
  const kitStockValue = items
    .filter((i) => i.kit?.form)
    .reduce((a, i) => a + (i.currentValue ?? 0), 0);

  return {
    asAt: win.asAt,
    summary,
    kitStockValue: round(kitStockValue),
    totalStockValue: round(items.reduce((a, i) => a + (i.currentValue ?? 0), 0)),
    purchasedCount: purchased.length,
    purchased,
    rows: rows.slice(0, 15),
    rowsTotal: rows.length,
  };
}
