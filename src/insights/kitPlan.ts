import { config } from "../config.js";
import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";
import {
  loadKitGraph,
  type KitEvidence,
  type KitForm,
  type KitGraph,
} from "./kits.js";
import {
  computedItems,
  kitRuleSummary,
  resolveWindow,
  type DemandWindow,
  type ItemComputed,
} from "./queries.js";

/**
 * The kit screens (P7): the register, the confirmation queue, the build-versus-buy
 * comparison, and the double-counting reconciliation.
 *
 * Kept apart from kits.ts, which holds the rules. queries.ts applies the rules
 * on every computed set and must not drag the screens in with them; this module
 * sits above both and is imported only by the routes.
 */

export interface KitRow {
  uid: string;
  number: string | null;
  name: string | null;
  productFinish: string | null;
  form: KitForm;
  formConfirmed: boolean;
  proposedForm: KitForm;
  evidence: KitEvidence;
  componentCount: number;
  onHand: number | null;
  freeStock: number | null;
  /** What Allied's own documents say about how this item has been sourced. */
  boughtQty: number;
  boughtBills: number;
  lastBought: string | null;
  builtQty: number;
  builtLines: number;
  lastBuilt: string | null;
  /** Buy complete, at MYOB's average cost. */
  buyCost: number | null;
  /** Make it here, rolled up from component average costs. */
  buildCost: number | null;
  buildCostComplete: boolean;
  /** buildCost − buyCost. Negative means building is cheaper. */
  costDelta: number | null;
  buildableNow: number | null;
  weeklyDemand: number;
  coverWeeks: number | null;
  /** What this item still needs: an order if bought, a build sheet if made. */
  needQty: number;
  needKind: "buy" | "build" | null;
  /** Kit and component both being ordered — one requirement, two orders. */
  doubleOrder: boolean;
  stockValue: number | null;
  supplierName: string | null;
  leadTimeDays: number | null;
}

function toRow(item: ItemComputed, graph: KitGraph, leadTimes: Map<string, number>): KitRow | null {
  const form = graph.form.get(item.uid);
  if (!form) return null;
  const kit = item.kit;
  const buyCost = item.averageCost;
  const buildCost = kit?.buildCost ?? null;
  const needQty = kit?.buildPlanQty || item.suggestion?.qty || 0;
  return {
    uid: item.uid,
    number: item.number,
    name: item.name,
    productFinish: item.productFinish,
    form: form.form,
    formConfirmed: form.confirmed,
    proposedForm: form.proposedForm,
    evidence: form.evidence,
    componentCount: form.componentCount,
    onHand: item.qtyOnHand,
    freeStock: item.qtyFreeStock,
    boughtQty: form.boughtQty,
    boughtBills: form.boughtBills,
    lastBought: form.lastBought,
    builtQty: form.builtQty,
    builtLines: form.builtLines,
    lastBuilt: form.lastBuilt,
    buyCost,
    buildCost,
    buildCostComplete: kit?.buildCostComplete ?? false,
    costDelta:
      buyCost != null && buyCost > 0 && buildCost != null && kit?.buildCostComplete
        ? Number((buildCost - buyCost).toFixed(4))
        : null,
    buildableNow: kit?.buildableNow ?? null,
    weeklyDemand: item.demand.weekly,
    coverWeeks: item.coverWeeks,
    needQty,
    needKind: needQty <= 0 ? null : kit?.buildPlanQty ? "build" : "buy",
    doubleOrder: kit?.doubleOrder ?? false,
    stockValue: item.currentValue,
    supplierName: item.supplierName,
    leadTimeDays: item.supplierUid ? (leadTimes.get(item.supplierUid) ?? null) : null,
  };
}

async function leadTimeMap(): Promise<Map<string, number>> {
  const { rows } = await getPool().query(
    `SELECT supplier_uid, median_lead_days FROM supplier_lead_time WHERE median_lead_days IS NOT NULL`,
  );
  return new Map(rows.map((r) => [String(r.supplier_uid), Number(r.median_lead_days)]));
}

export interface KitRegisterParams extends Partial<DemandWindow> {
  q?: string;
  /** 'prebuilt' | 'assembled' | 'hybrid' | 'not_a_kit' | 'unconfirmed' | 'double_order' | 'needs_action' */
  filter?: string;
  sort?: string;
  dir?: string;
}

/**
 * Every item that exists in two forms, with both routes priced side by side.
 *
 * This is the answer to "clear distinction between prebuilt kits and
 * components": one register, one form per item, and the two costs next to each
 * other so the distinction is a decision rather than a label.
 */
export async function kitRegister(params: KitRegisterParams = {}) {
  const win = resolveWindow(params);
  const [items, graph, leads, summary] = await Promise.all([
    computedItems(win),
    loadKitGraph(),
    leadTimeMap(),
    kitRuleSummary(win),
  ]);

  let rows = items
    .map((i) => toRow(i, graph, leads))
    .filter((r): r is KitRow => r !== null);

  const q = params.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) =>
        (r.number ?? "").toLowerCase().includes(q) ||
        (r.name ?? "").toLowerCase().includes(q),
    );
  }
  switch (params.filter) {
    case "prebuilt":
    case "assembled":
    case "hybrid":
    case "not_a_kit":
      rows = rows.filter((r) => r.form === params.filter);
      break;
    case "unconfirmed":
      rows = rows.filter((r) => !r.formConfirmed);
      break;
    case "double_order":
      rows = rows.filter((r) => r.doubleOrder);
      break;
    case "needs_action":
      rows = rows.filter((r) => r.needQty > 0);
      break;
    default:
      break;
  }

  const sortValue: Record<string, (r: KitRow) => number | string | null> = {
    number: (r) => r.number ?? "",
    name: (r) => r.name ?? "",
    on_hand: (r) => r.onHand,
    value: (r) => r.stockValue,
    need: (r) => (r.needQty > 0 ? r.needQty * (r.buyCost ?? 0) : null),
    delta: (r) => r.costDelta,
    buildable: (r) => r.buildableNow,
    cover: (r) => r.coverWeeks,
  };
  const sortKey = params.sort && sortValue[params.sort] ? params.sort : "need";
  const dir = params.dir === "asc" ? 1 : -1;
  const pick = sortValue[sortKey];
  rows.sort((a, b) => {
    const x = pick(a);
    const y = pick(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1; // nulls last, whichever way the column is sorted
    if (y == null) return -1;
    return typeof x === "string" || typeof y === "string"
      ? String(x).localeCompare(String(y)) * dir
      : (Number(x) - Number(y)) * dir;
  });

  return {
    asAt: win.asAt,
    windowMonths: win.windowMonths,
    total: rows.length,
    rows,
    summary,
    counts: {
      prebuilt: rows.filter((r) => r.form === "prebuilt").length,
      assembled: rows.filter((r) => r.form === "assembled").length,
      hybrid: rows.filter((r) => r.form === "hybrid").length,
      notAKit: rows.filter((r) => r.form === "not_a_kit").length,
      unconfirmed: rows.filter((r) => !r.formConfirmed).length,
    },
  };
}

/**
 * The proposals that still need a person, ranked by what they are worth.
 *
 * Only the ones where confirming actually changes something: a checkbox in MYOB
 * says an item is bought complete, and until Allied agree the platform declines
 * to act on it. The queue states plainly what confirming would do — the same
 * shape as the stocktake confirmation screen, which Allied already use.
 */
export async function kitQueue(opts?: Partial<DemandWindow>) {
  const win = resolveWindow(opts);
  const [items, graph, leads] = await Promise.all([
    computedItems(win),
    loadKitGraph(),
    leadTimeMap(),
  ]);
  const byUid = new Map(items.map((i) => [i.uid, i]));

  const pending = items
    .map((i) => toRow(i, graph, leads))
    .filter((r): r is KitRow => r !== null)
    .filter((r) => !r.formConfirmed && (r.evidence === "flagged" || r.evidence === "on_order"))
    .map((r) => {
      /*
       * What confirming would withhold. The rules are gated on weak evidence,
       * so this is a preview of a change that has deliberately not happened
       * yet — the reason to spend thirty seconds on the row.
       */
      const edges = graph.childrenOf.get(r.uid) ?? [];
      let componentSpend = 0;
      const components: { number: string | null; qty: number; value: number }[] = [];
      for (const e of edges) {
        const c = byUid.get(e.componentUid);
        if (!c?.suggestion) continue;
        const value = c.suggestion.qty * (c.averageCost ?? 0);
        componentSpend += value;
        components.push({
          number: c.number,
          qty: c.suggestion.qty,
          value: Number(value.toFixed(2)),
        });
      }
      return {
        ...r,
        atStake: Number(componentSpend.toFixed(2)),
        components: components.sort((a, b) => b.value - a.value).slice(0, 6),
      };
    })
    .sort((a, b) => b.atStake - a.atStake);

  return { asAt: win.asAt, total: pending.length, rows: pending };
}

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
 * On Allied's file the two routes land within a few percent of each other and
 * the sign flips by finish — galvanised BP1675G is $2.10 bought and $1.86
 * built, stainless BP1675S16 is $12.86 bought and $13.31 built. So cost alone
 * rarely settles it, and the screen leads instead with the constraint that
 * usually does: how many can be built today.
 */
export async function kitDetail(uid: string, opts?: Partial<DemandWindow>) {
  const win = resolveWindow(opts);
  const [items, graph, leads] = await Promise.all([
    computedItems(win),
    loadKitGraph(),
    leadTimeMap(),
  ]);
  const byUid = new Map(items.map((i) => [i.uid, i]));
  const item = byUid.get(uid);
  if (!item) return null;
  const row = toRow(item, graph, leads);

  const planQty = row?.needQty ?? 0;
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
   * Without this the page reads as an argument for buying prebuilt whenever
   * the shelf is bare, even when the parts are bought and paid for and in
   * transit — BP1675S16 shows 18 buildable today against 30,000 B1675S16 and
   * 60,000 N16S16M on open purchase orders. Buying the pack as well would be
   * buying the same requirement a second time, which is the exact failure this
   * whole feature exists to stop.
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
   * Where this item's own units are sitting inside other stock, and which
   * products depend on it. A bolt pack is both a kit and a component — 56 items
   * on Allied's file are both — so the page has to answer in both directions.
   */
  const heldIn = (item.kit?.heldIn ?? []).map((h) => ({
    ...h,
    number: byUid.get(h.kitUid)?.number ?? null,
    name: byUid.get(h.kitUid)?.name ?? null,
  }));
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
      committed: item.qtyCommitted,
      incoming: item.incomingQty,
      averageCost: item.averageCost,
      stockValue: item.currentValue,
      weeklyDemand: item.demand.weekly,
      coverWeeks: item.coverWeeks,
      minLevel: item.minLevel,
      flags: item.flags,
      suggestion: item.suggestion,
      kit: item.kit,
    },
    kit: row,
    planQty,
    buildableWithIncoming,
    targetCoverWeeks: config.insights.targetCoverWeeks,
    components,
    heldIn,
    usedIn,
  };
}

/**
 * The proof that nothing is counted twice.
 *
 * The brief asks for both visibility of component stock held inside kits and a
 * guarantee that the two are not double-counted, which sound contradictory
 * until the counting rule is stated: a unit is counted in the form it is
 * physically held in, and embedded quantities are a view of stock already
 * valued under the kit.
 *
 * So this returns three numbers and the arithmetic between them. `stockValue`
 * is what the platform reports and is unchanged by this whole feature.
 * `embeddedValue` is the same stock seen through the component's eyes.
 * `ifBothWereCounted` is what a spreadsheet that added them would say — the
 * overstatement Allied are being protected from, in dollars.
 */
export async function kitReconciliation(opts?: Partial<DemandWindow>) {
  await ensureInsightsSchema();
  const win = resolveWindow(opts);
  const items = await computedItems(win);
  const graph = await loadKitGraph();

  let stockValue = 0;
  let kitStockValue = 0;
  let embeddedValue = 0;
  let looseComponentValue = 0;
  let componentsWithEmbedded = 0;
  let embeddedUnits = 0;
  const worst: { number: string | null; name: string | null; loose: number | null; embedded: number; embeddedValue: number; heldIn: string[] }[] = [];

  for (const item of items) {
    stockValue += item.currentValue ?? 0;
    if (graph.form.has(item.uid)) kitStockValue += item.currentValue ?? 0;
    const e = item.kit?.embeddedUnits ?? 0;
    if (e > 0) {
      componentsWithEmbedded += 1;
      embeddedUnits += e;
      embeddedValue += item.kit?.embeddedValue ?? 0;
      looseComponentValue += item.currentValue ?? 0;
      worst.push({
        number: item.number,
        name: item.name,
        loose: item.qtyOnHand,
        embedded: e,
        embeddedValue: item.kit?.embeddedValue ?? 0,
        heldIn: (item.kit?.heldIn ?? [])
          .slice(0, 4)
          .map((h) => items.find((i) => i.uid === h.kitUid)?.number ?? h.kitUid),
      });
    }
  }
  worst.sort((a, b) => b.embeddedValue - a.embeddedValue);

  const round = (v: number) => Number(v.toFixed(2));
  return {
    asAt: win.asAt,
    stockValue: round(stockValue),
    kitStockValue: round(kitStockValue),
    embeddedValue: round(embeddedValue),
    embeddedUnits: Number(embeddedUnits.toFixed(1)),
    looseComponentValue: round(looseComponentValue),
    componentsWithEmbedded,
    ifBothWereCounted: round(stockValue + embeddedValue),
    overstatementPct: stockValue > 0 ? round((embeddedValue / stockValue) * 100) : 0,
    rows: worst.slice(0, 25),
  };
}

/** CSV of the register, for the month-end pack. */
export async function kitRegisterCsv(params: KitRegisterParams = {}): Promise<string> {
  const { rows } = await kitRegister(params);
  const header = [
    "Item", "Name", "Form", "Confirmed", "Evidence", "Components",
    "On hand", "Free", "Stock value", "Buy each", "Build each", "Build - buy",
    "Buildable now", "Weekly demand", "Cover weeks", "Need qty", "Need kind",
    "Double order", "Supplier", "Lead days", "Bought qty", "Built qty",
  ];
  const cell = (v: unknown) => {
    // Money and costs carry full float noise otherwise — 4167.612 and
    // -92.30000000000001 in a column someone is going to reconcile by hand.
    const s =
      v == null ? "" : typeof v === "number" ? String(Number(v.toFixed(4))) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.number, r.name, r.form, r.formConfirmed ? "yes" : "proposed", r.evidence,
      r.componentCount, r.onHand, r.freeStock,
      r.stockValue == null ? "" : Number(r.stockValue.toFixed(2)),
      r.buyCost == null ? "" : Number(r.buyCost.toFixed(4)),
      r.buildCostComplete && r.buildCost != null ? Number(r.buildCost.toFixed(4)) : "",
      r.costDelta, r.buildableNow,
      r.weeklyDemand?.toFixed(2), r.coverWeeks?.toFixed(1), r.needQty || "",
      r.needKind ?? "", r.doubleOrder ? "yes" : "", r.supplierName, r.leadTimeDays,
      r.boughtQty, r.builtQty,
    ]
      .map(cell)
      .join(","),
  );
  // BOM so Excel opens it directly, matching the cart and position exports.
  return "﻿" + [header.join(","), ...lines].join("\r\n");
}
