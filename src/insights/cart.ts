import { getPool } from "../db.js";
import { ensureInsightsSchema } from "../sync/schema.js";
import { computedItems, type DemandWindow, type ItemComputed } from "./queries.js";

/**
 * The purchasing cart (P5 + P6).
 *
 * The previous implementation bucketed each item under exactly one supplier —
 * the effective supplier, resolved as preferred, then MYOB primary, then
 * inferred from bills. One item, one bucket, by construction. That is the P6
 * defect: tagging a second supplier against an item changed nothing, so the
 * sourcing choice the tag was meant to expose stayed hidden.
 *
 * Here an item below its minimum appears under **every** supplier tagged
 * against it. That immediately creates the opposite risk — ordering the same
 * thing twice — so the guard rails are part of the same piece of work rather
 * than a follow-up: every multi-supplier line is flagged in every bucket,
 * choosing one supplier clears the others in a single action, a deliberate
 * split is explicit and visible, and the export refuses to stay quiet about an
 * unresolved duplicate.
 */

export type CartState = "suggested" | "edited" | "removed" | "selected" | "split";

export interface CartLine {
  itemUid: string;
  number: string | null;
  name: string | null;
  productFinish: string | null;
  supplierUid: string;
  supplierName: string;
  supplierRegion: string | null;
  /** Where this supplier came from: Allied's tag, MYOB's primary, or bills. */
  supplierSource: "allied" | "myob" | "inferred";
  /** Measured order-to-delivery, not a promise. Null when never measured. */
  leadTimeDays: number | null;
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
  /** How many suppliers this same item sits under, across the whole cart. */
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
    };
  }
  const uids = needing.map((i) => i.uid);

  // Every supplier option per item: Allied's tags first, then MYOB's primary,
  // then whoever has actually billed it. An item with no option at all still
  // needs to be visible, so it falls through to a "no supplier" bucket below.
  const [tagged, primaries, billed, leadTimes, lastCosts, cart] = await Promise.all([
    pool.query(
      `SELECT ps.item_uid, ps.supplier_uid, s.name AS supplier_name, m.region, ps.is_preferred
       FROM platform_item_suppliers ps
       JOIN myob_suppliers s ON s.uid = ps.supplier_uid
       LEFT JOIN platform_supplier_meta m ON m.supplier_uid = ps.supplier_uid
       WHERE ps.item_uid = ANY($1)`,
      [uids],
    ),
    pool.query(
      `SELECT i.uid AS item_uid, i.primary_supplier_uid AS supplier_uid,
              s.name AS supplier_name, m.region
       FROM myob_items i
       JOIN myob_suppliers s ON s.uid = i.primary_supplier_uid
       LEFT JOIN platform_supplier_meta m ON m.supplier_uid = i.primary_supplier_uid
       WHERE i.uid = ANY($1) AND i.primary_supplier_uid IS NOT NULL`,
      [uids],
    ),
    pool.query(
      `SELECT DISTINCT ON (l.item_uid) l.item_uid, b.supplier_uid,
              s.name AS supplier_name, m.region
       FROM myob_purchase_bill_lines l
       JOIN myob_purchase_bills b ON b.uid = l.bill_uid
       JOIN myob_suppliers s ON s.uid = b.supplier_uid
       LEFT JOIN platform_supplier_meta m ON m.supplier_uid = b.supplier_uid
       WHERE l.item_uid = ANY($1) AND b.supplier_uid IS NOT NULL
       GROUP BY l.item_uid, b.supplier_uid, s.name, m.region
       ORDER BY l.item_uid, SUM(COALESCE(l.total, 0)) DESC`,
      [uids],
    ),
    pool.query(`SELECT * FROM supplier_lead_time`),
    pool.query(
      `SELECT DISTINCT ON (l.item_uid, b.supplier_uid)
              l.item_uid, b.supplier_uid, l.unit_price, b.date::date::text AS last_bought
       FROM myob_purchase_bill_lines l
       JOIN myob_purchase_bills b ON b.uid = l.bill_uid
       WHERE l.item_uid = ANY($1) AND b.supplier_uid IS NOT NULL AND l.unit_price > 0
       ORDER BY l.item_uid, b.supplier_uid, b.date DESC`,
      [uids],
    ),
    pool.query(`SELECT * FROM platform_purchase_cart WHERE item_uid = ANY($1)`, [uids]),
  ]);

  const lead = new Map(
    leadTimes.rows.map((r) => [
      r.supplier_uid as string,
      {
        days: r.median_lead_days as number | null,
        orders: r.orders_measured as number,
        sameDayExcluded: r.same_day_excluded as number,
      },
    ]),
  );
  const lastCost = new Map(
    lastCosts.rows.map((r) => [
      `${r.item_uid}|${r.supplier_uid}`,
      Number(r.unit_price),
    ]),
  );
  const cartState = new Map(
    cart.rows.map((r) => [
      `${r.item_uid}|${r.supplier_uid}`,
      { qty: r.qty as number | null, state: r.state as CartState, note: r.note as string | null },
    ]),
  );

  type Option = {
    supplierUid: string;
    supplierName: string | null;
    region: string | null;
    source: "allied" | "myob" | "inferred";
  };
  const options = new Map<string, Option[]>();
  const push = (itemUid: string, o: Option) => {
    const list = options.get(itemUid) ?? [];
    if (!list.some((x) => x.supplierUid === o.supplierUid)) list.push(o);
    options.set(itemUid, list);
  };
  for (const r of tagged.rows)
    push(r.item_uid as string, {
      supplierUid: r.supplier_uid as string,
      supplierName: r.supplier_name as string | null,
      region: r.region as string | null,
      source: "allied",
    });
  for (const r of primaries.rows)
    push(r.item_uid as string, {
      supplierUid: r.supplier_uid as string,
      supplierName: r.supplier_name as string | null,
      region: r.region as string | null,
      source: "myob",
    });
  for (const r of billed.rows)
    push(r.item_uid as string, {
      supplierUid: r.supplier_uid as string,
      supplierName: r.supplier_name as string | null,
      region: r.region as string | null,
      source: "inferred",
    });

  const groups = new Map<string, CartSupplierGroup>();
  let unresolvedDuplicates = 0;
  let totalLines = 0;

  for (const item of needing) {
    const opts_ = options.get(item.uid) ?? [];
    // Keep an item with no supplier visible rather than dropping it — 341 of
    // them need an order and having none is itself the finding.
    const list: Option[] = opts_.length
      ? opts_
      : [{ supplierUid: "none", supplierName: null, region: null, source: "inferred" }];

    const selected = list.find(
      (o) => cartState.get(`${item.uid}|${o.supplierUid}`)?.state === "selected",
    );
    const splits = list.filter(
      (o) => cartState.get(`${item.uid}|${o.supplierUid}`)?.state === "split",
    );
    const decided = Boolean(selected) || splits.length > 0;
    if (list.length > 1 && !decided) unresolvedDuplicates += 1;

    for (const o of list) {
      const key = `${item.uid}|${o.supplierUid}`;
      const saved = cartState.get(key);
      // Choosing one supplier clears the item from the others in one action.
      if (selected && o.supplierUid !== selected.supplierUid && saved?.state !== "split") continue;
      /*
       * A deliberate split is also a decision about which suppliers are in play.
       * Without this, splitting 2,000 units across two suppliers left the item
       * sitting in its other buckets at the suggested quantity as well — 2,874
       * units in total, which is precisely the duplicate order the split exists
       * to make safe.
       */
      if (splits.length > 0 && saved?.state !== "split") continue;
      if (saved?.state === "removed") continue;

      const suggested = item.suggestion?.qty ?? 0;
      const qty = saved?.qty ?? suggested;
      const cost = lastCost.get(key) ?? item.averageCost ?? 0;
      const lt = lead.get(o.supplierUid);

      const line: CartLine = {
        itemUid: item.uid,
        number: item.number,
        name: item.name,
        productFinish: item.productFinish,
        supplierUid: o.supplierUid,
        supplierName: o.supplierName ?? "No known supplier",
        supplierRegion: o.region,
        supplierSource: o.source,
        leadTimeDays: lt?.days ?? null,
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
        state: saved?.state ?? "suggested",
        note: saved?.note ?? null,
        estCost: qty * cost,
        supplierCount: list.length,
        kitForm: item.kit?.form ?? null,
        kitDoubleOrder: item.kit?.doubleOrder ?? false,
        otherSuppliers: list
          .filter((x) => x.supplierUid !== o.supplierUid)
          .map((x) => ({ supplierUid: x.supplierUid, supplierName: x.supplierName })),
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
        leadTimeDays: lt?.days ?? null,
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
    estimatedCost: suppliers.reduce((a, g) => a + g.estimatedCost, 0),
    unresolvedDuplicates,
    decisions: [...decisions.values()],
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

/** Record a decision on one cart line. */
export async function setCartLine(params: {
  itemUid: string;
  supplierUid: string;
  qty?: number | null;
  state?: CartState;
  note?: string | null;
}): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(
    `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, qty, state, note, updated_by, updated_at)
     VALUES ($1, $2, $3, COALESCE($4, 'edited'), $5, 'dashboard', NOW())
     ON CONFLICT (item_uid, supplier_uid) DO UPDATE SET
       qty = COALESCE(EXCLUDED.qty, platform_purchase_cart.qty),
       state = COALESCE($4, platform_purchase_cart.state),
       note = COALESCE(EXCLUDED.note, platform_purchase_cart.note),
       updated_at = NOW()`,
    [params.itemUid, params.supplierUid, params.qty ?? null, params.state ?? null, params.note ?? null],
  );
}

/**
 * Choose one supplier for an item; every other option is dropped in the same
 * action, so nobody has to hunt through the cart deleting duplicates.
 */
export async function selectCartSupplier(itemUid: string, supplierUid: string): Promise<void> {
  await ensureInsightsSchema();
  const pool = getPool();
  await pool.query(
    `DELETE FROM platform_purchase_cart WHERE item_uid = $1 AND supplier_uid <> $2`,
    [itemUid, supplierUid],
  );
  await pool.query(
    `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, state, updated_by, updated_at)
     VALUES ($1, $2, 'selected', 'dashboard', NOW())
     ON CONFLICT (item_uid, supplier_uid) DO UPDATE SET state = 'selected', updated_at = NOW()`,
    [itemUid, supplierUid],
  );
}

/**
 * Deliberately order one item from several suppliers at once. Recorded as an
 * explicit split so it reads as a decision rather than an accidental duplicate.
 */
export async function splitCartItem(
  itemUid: string,
  parts: { supplierUid: string; qty: number }[],
): Promise<void> {
  await ensureInsightsSchema();
  const pool = getPool();
  const keep = parts.map((p) => p.supplierUid);
  await pool.query(
    `DELETE FROM platform_purchase_cart WHERE item_uid = $1 AND NOT (supplier_uid = ANY($2))`,
    [itemUid, keep],
  );
  for (const p of parts) {
    await pool.query(
      `INSERT INTO platform_purchase_cart (item_uid, supplier_uid, qty, state, updated_by, updated_at)
       VALUES ($1, $2, $3, 'split', 'dashboard', NOW())
       ON CONFLICT (item_uid, supplier_uid) DO UPDATE SET
         qty = EXCLUDED.qty, state = 'split', updated_at = NOW()`,
      [itemUid, p.supplierUid, p.qty],
    );
  }
}

/** Clear every decision, returning the cart to the platform's suggestions. */
export async function resetCart(): Promise<number> {
  await ensureInsightsSchema();
  const r = await getPool().query(`DELETE FROM platform_purchase_cart`);
  return r.rowCount ?? 0;
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
          undecided ? "CHECK — also under another supplier, no choice recorded" : "",
        ].join(","),
      );
    }
  }

  return {
    filename: `allied-purchase-order-${new Date().toISOString().slice(0, 10)}.csv`,
    csv: `﻿${lines.join("\r\n")}\r\n`,
    unresolvedDuplicates: cart.unresolvedDuplicates,
  };
}


/**
 * Reverse a decision, putting the item back under every supplier tagged against
 * it. Deleting the rows is enough: with no cart row the fan-out offers all the
 * options again, which is exactly the state before the choice was made.
 */
export async function undoCartDecision(itemUid: string): Promise<void> {
  await ensureInsightsSchema();
  await getPool().query(`DELETE FROM platform_purchase_cart WHERE item_uid = $1`, [itemUid]);
}
