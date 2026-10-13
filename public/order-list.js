/*
 * The Order list regrouped by item (1.5 groundwork; the By item view in 1.6
 * draws it).
 *
 * /cart serves lines grouped by supplier, because one supplier's lines become
 * one purchase order. Allied asked to see the same order one row per item.
 * The server stays the only source of numbers: this module only regroups the
 * lines /cart already sent, adding up quantity and cost per item, so the two
 * views can never disagree about what is being ordered.
 *
 * Kept apart from dashboard.js, like release-banner.js, because dashboard.js
 * reads `document` the moment it loads and so can't be imported by a test.
 * Nothing here touches the DOM; test/order-list.test.ts imports it directly.
 *
 * Since f2148b2 an item normally has one line, under its preferred supplier.
 * The one normal way it gets more is a split (FG250P 142/142), and a split's
 * parts are one order between them: the row carries their sum, as the 1.4
 * header does, and keeps the parts so the row can name them. A saved
 * quantity that keeps a second line is added the same way; it is what the
 * order sheets would send.
 *
 * Stock fields are the item's own and identical on every one of its lines,
 * so they are read from its first line. The four 1.5 fields (committed, cover
 * incl. on order, its below-lead-time flag and the risk score) are read with
 * `?? null`: a 1.5 tab on a 1.4 server gets "—", not a crash.
 *
 * CartLine.supplierCount is deliberately not used: the row counts its own
 * lines (lineCount), so nothing depends on that field's name.
 */

/** Lines of one cart, one row per item, in the order each item first appears. */
export function groupLinesByItem(cart) {
  const rows = new Map();
  for (const group of cart?.suppliers ?? []) {
    for (const line of group?.lines ?? []) {
      let row = rows.get(line.itemUid);
      if (!row) {
        row = {
          itemUid: line.itemUid,
          number: line.number ?? null,
          name: line.name ?? null,
          productFinish: line.productFinish ?? null,
          // Item-level stock, the same on every line of the item.
          onHand: line.onHand ?? null,
          qtyCommitted: line.qtyCommitted ?? null,
          freeStock: line.freeStock ?? null,
          incomingQty: line.incomingQty ?? null,
          minLevel: line.minLevel ?? null,
          weeklyDemand: line.weeklyDemand ?? null,
          coverWeeks: line.coverWeeks ?? null,
          coverWeeksInclOnOrder: line.coverWeeksInclOnOrder ?? null,
          coverBelowLeadTime: line.coverBelowLeadTime ?? null,
          riskScore: line.riskScore ?? null,
          suggestedQty: line.suggestedQty ?? null,
          averageCost: line.averageCost ?? null,
          // Sourcing context, also per item: every supplier on file (for the
          // compare drawer), the preferred one and any pick that disagrees.
          options: line.options ?? [],
          preferredSupplierUid: line.preferredSupplierUid ?? null,
          preferredSupplierName: line.preferredSupplierName ?? null,
          conflict: line.conflict ?? null,
          kitForm: line.kitForm ?? null,
          kitDoubleOrder: false,
          // Summed over the item's lines.
          qty: 0,
          estCost: 0,
          lineCount: 0,
          split: false,
          lines: [],
        };
        rows.set(line.itemUid, row);
      }
      row.qty += Number(line.qty) || 0;
      row.estCost += Number(line.estCost) || 0;
      row.lineCount += 1;
      if (line.state === "split") row.split = true;
      if (line.kitDoubleOrder) row.kitDoubleOrder = true;
      row.lines.push(line);
    }
  }
  return [...rows.values()];
}

/*
 * The By item view (1.6): the rows it draws, in the order it draws them, and
 * what each cell says. All of it is decided here, from the cart alone, so the
 * tests can pin it; dashboard.js only turns these models into HTML.
 */

/*
 * The columns, in order. Labels shared with Inventory are Inventory's, with
 * its glossary entry (`term`, a TERMS key) for the hover text; the rest carry
 * their own one-line tip. The drill-down panel spans exactly this many
 * columns, so a column added here can never leave it one short. `sort` (1.7)
 * is the PURCHASING_SORTS key a click on the header sorts by.
 */
export const BY_ITEM_COLUMNS = [
  { key: "caret", label: "", cls: "caret-h" },
  { key: "item", label: "Item", sort: "number" },
  { key: "supplier", label: "Supplier", term: "supplier_source", sort: "supplier" },
  { key: "suggested", label: "Suggested", cls: "num", sort: "suggested", tip: "What the dashboard suggests ordering: enough for the target cover plus the minimum stock (or the lead time), less free stock and on order." },
  { key: "order_qty", label: "Order qty", cls: "num", sort: "order_qty", tip: "What goes on the order sheet: the suggestion, unless you have typed a quantity." },
  { key: "on_hand", label: "On hand", cls: "num", sort: "on_hand" },
  { key: "committed", label: "Committed", term: "committed", cls: "num", sort: "committed" },
  { key: "free_stock", label: "Free stock", term: "free_stock", cls: "num", sort: "available" },
  { key: "on_order", label: "On order", term: "incoming", cls: "num", sort: "incoming" },
  { key: "weekly", label: "Weekly demand", term: "weekly_demand", cls: "num", sort: "weekly" },
  { key: "cover", label: "Cover excl. on order", term: "cover", sort: "cover" },
  { key: "cover_incl", label: "Cover incl. on order", term: "cover_incl", sort: "cover_incl" },
  { key: "lead_time", label: "Lead time", cls: "num", sort: "lead_time", tip: "Order to delivery for the supplier this item is ordered from: Allied's figure on the item, else on the supplier, else measured from their orders." },
  { key: "est_cost", label: "Est. cost", cls: "num", sort: "est_cost", tip: "Order qty × what this supplier last charged (average cost where they have never billed it). Split parts are added together." },
  { key: "remove", label: "" },
];

/*
 * Highest risk first, then item number: Inventory's default order (D18), so
 * the two lists open on the same items. A missing score (a 1.4 server sends
 * none) goes last rather than reading as zero. Numbers compare as the server
 * compares them for Inventory's Item sort (localeCompare).
 */
export function byRiskThenNumber(a, b) {
  const ra = a?.riskScore ?? null;
  const rb = b?.riskScore ?? null;
  if (ra !== rb) {
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  }
  return String(a?.number ?? "").localeCompare(String(b?.number ?? ""));
}

/** The By item rows: one per item, highest risk first, then item number. */
export function orderByItemRows(cart) {
  return groupLinesByItem(cart).sort(byRiskThenNumber);
}

/*
 * "N items to order · M taken off · $X estimated".
 *
 * Every item that needs an order is either a row here or in the Taken off
 * list (taken off with ×, or every line struck before × existed), so N + M is
 * By supplier's "items need an order" (totalItems). $X is the cart's own
 * estimatedCost, the sum of every line, which is what the order sheets add up
 * to and, from 1.4, By supplier's header figure whenever each item has one
 * supplier or one split. It is never re-added here; an old server without it
 * falls back to the rows' sum, which is the same lines.
 */
export function orderListSummary(cart, rows) {
  const list = rows ?? orderByItemRows(cart);
  return {
    toOrder: list.length,
    takenOff: cart?.removedItems?.length ?? 0,
    totalItems: cart?.totalItems ?? null,
    estimatedCost: cart?.estimatedCost ?? list.reduce((a, r) => a + (Number(r.estCost) || 0), 0),
  };
}

/*
 * Why a supplier is on file for an item, in the words the row uses. Preferred
 * (set on the item page) wins; otherwise where the supplier came from:
 * recorded on the item page but not preferred ("tagged"), MYOB's primary
 * supplier, the supplier who has billed it most ("from bills"), or one chosen
 * here earlier that is no longer on file. Takes a cart line (supplierSource)
 * or a compare option (source).
 */
const SUPPLIER_ROLE = {
  allied: "tagged",
  myob: "MYOB primary",
  inferred: "from bills",
  picked: "picked earlier",
};

export function supplierRole(o) {
  if (!o) return null;
  if (o.isPreferred) return "preferred";
  return SUPPLIER_ROLE[o.supplierSource ?? o.source] ?? null;
}

/*
 * What the Supplier cell says.
 *
 *   single    "Hanova · preferred", "Jiaxing · MYOB primary", "· from bills", "· tagged"
 *   conflict  an earlier pick that disagrees with the preferred supplier and
 *             has not been settled: "Jiaxing · your pick (preferred: Hanova)",
 *             with Use preferred / Keep (f2148b2: a pick is never overridden)
 *   kept      the same pick, kept on purpose with Keep
 *
 *   Both carry `struck`: conflict kind "removed" is not a pick at all. The
 *   preferred line was struck before × existed and the item fell through to
 *   the next supplier, so the cell must not say "your pick" (By supplier's
 *   chip says "preferred is Hanova" for the same line).
 *
 *   split     "Split: Hanova 142 · Bremick 142", parts in /cart's order. A
 *             split with one part left (By supplier's × strikes one part while
 *             two or more remain) is still a split, with one part.
 *   several   two lines that are not a split (a saved qty kept a second
 *             supplier): both named, decided in Compare
 *   unknown   no supplier on file at all
 *
 * A split that leaves the preferred supplier out carries its open conflict,
 * so the row still offers Use preferred / Keep.
 */
export function supplierCell(row) {
  const lines = row?.lines ?? [];
  const c = row?.conflict ?? null;
  const open = c && !c.acknowledged ? c : null;
  if (lines.length > 1 || (row.split && lines.length === 1)) {
    return {
      kind: row.split ? "split" : "several",
      parts: lines.map((l) => ({ supplierUid: l.supplierUid, name: l.supplierName ?? null, qty: l.qty })),
      conflict: open && !lines.some((l) => l.isPreferred) ? open : null,
    };
  }
  const l = lines[0];
  if (!l) return { kind: "unknown", name: null };
  if (l.supplierUid === "none") return { kind: "unknown", name: l.supplierName ?? null };
  if (c && !l.isPreferred) {
    return {
      kind: c.acknowledged ? "kept" : "conflict",
      name: l.supplierName ?? null,
      preferredName: c.preferredSupplierName ?? null,
      struck: c.kind === "removed",
      conflict: c,
    };
  }
  return { kind: "single", name: l.supplierName ?? null, role: supplierRole(l) };
}

/*
 * What the Order qty cell does.
 *
 * One line: an input, saved exactly as By supplier saves it (POST /cart/line
 * with that line's supplier, as an edit unless the line is a Chosen supplier
 * or a split part, which keep their state). Several lines: read-only, because
 * a typed total can't say which supplier it is for; the parts are changed in
 * Compare. A split down to one part stays read-only too: it is still a split,
 * and its parts are Compare's to change.
 *
 * "Covered by on order": the item is below its minimum, so it is listed (D19:
 * both views list the same items), but free stock plus what is already on
 * order meets the target, so the suggestion is 0. The label goes with the 0;
 * once a quantity is typed the Edited marker says what happened instead.
 */
export function qtyCell(row) {
  const lines = row?.lines ?? [];
  const covered = (Number(row?.suggestedQty) || 0) === 0 && (Number(row?.incomingQty) || 0) > 0;
  if (lines.length !== 1 || row?.split) {
    return { editable: false, qty: row?.qty ?? 0, why: row?.split ? "split" : "several", coveredByOnOrder: false };
  }
  const l = lines[0];
  return {
    editable: true,
    qty: l.qty,
    supplierUid: l.supplierUid,
    state: l.state ?? null,
    decided: l.state === "selected" || l.state === "split",
    edited: l.state === "edited",
    carriedFrom: l.qtyCarriedFrom ?? null,
    coveredByOnOrder: covered && Number(l.qty) === 0,
  };
}

/*
 * The Lead time cell: each line's lead (the item's own figure if Allied set
 * one, else that line's supplier's), once per distinct figure, in line order.
 * A split between a 120-day and a 30-day supplier shows both; a line with no
 * figure at all shows as null ("unknown").
 */
export function rowLeadTimes(row) {
  const seen = new Map();
  for (const l of row?.lines ?? []) {
    const days = l.leadTimeDays ?? null;
    if (!seen.has(days))
      seen.set(days, { days, setByAllied: !!l.leadTimeSetByAllied, orders: l.leadTimeOrders ?? 0 });
  }
  return [...seen.values()];
}

/*
 * Sorting By item (1.7): Allied asked for "the sorting functionality from
 * the Inventory tab" on Purchasing. So a header sorts as Inventory's does:
 * click to sort, click again to flip, empty values last whichever way.
 *
 * Columns the two lists share use Inventory's key, and start in Inventory's
 * direction (SORT_DEFAULT_DIR in src/insights/queries.ts; a test holds them
 * together), so `available` is free stock here too and a key in a link means
 * the same on both tabs. Inventory sorts on the server, a page at a time;
 * this list is one cart already in the browser, so it is sorted here, from
 * the same figures the row shows. Ties go by item number, lowest first,
 * whichever the direction, so a redraw after a write never shuffles them.
 *
 *   dir    the first click's direction: lowest or A first for Item,
 *          Supplier, On hand, Free stock and both covers; highest first for
 *          risk, the quantities, cost, lead time, weekly demand and committed
 *   text   compared as words (localeCompare, as the server compares item
 *          numbers), not as numbers
 *   value  null where the cell is empty: "no demand" covers, no known
 *          supplier, no lead time. Those go last both ways, so "lowest first"
 *          never opens on items with nothing to compare.
 *
 * There is no Risk column (Allied's fifteen columns fill a laptop), so
 * `risk` is reached as the default, or from a link; the line above the table
 * says so.
 */
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export const PURCHASING_SORTS = {
  risk: { label: "Risk", dir: "desc", value: (r) => num(r.riskScore) },
  number: { label: "Item number", dir: "asc", text: true, value: (r) => r.number || null },
  // The name the Supplier cell leads with: the one supplier, or a split's
  // first part. An item with no supplier on file has nothing to compare.
  supplier: {
    label: "Supplier",
    dir: "asc",
    text: true,
    value: (r) => {
      const m = supplierCell(r);
      if (m.kind === "unknown") return null;
      return (m.parts ? m.parts[0]?.name : m.name) || null;
    },
  },
  suggested: { label: "Suggested", dir: "desc", value: (r) => num(r.suggestedQty) },
  order_qty: { label: "Order qty", dir: "desc", value: (r) => num(r.qty) },
  on_hand: { label: "On hand", dir: "asc", value: (r) => num(r.onHand) },
  committed: { label: "Committed", dir: "desc", value: (r) => num(r.qtyCommitted) },
  available: { label: "Free stock", dir: "asc", value: (r) => num(r.freeStock) },
  incoming: { label: "On order", dir: "desc", value: (r) => num(r.incomingQty) },
  weekly: { label: "Weekly demand", dir: "desc", value: (r) => num(r.weeklyDemand) },
  cover: { label: "Cover excl. on order", dir: "asc", value: (r) => num(r.coverWeeks) },
  cover_incl: { label: "Cover incl. on order", dir: "asc", value: (r) => num(r.coverWeeksInclOnOrder) },
  // A split between a 120-day and a 30-day supplier is complete when the
  // slower part lands, so the row sorts on its longest known lead.
  lead_time: {
    label: "Lead time",
    dir: "desc",
    value: (r) => {
      const days = rowLeadTimes(r).map((t) => num(t.days)).filter((d) => d != null);
      return days.length ? Math.max(...days) : null;
    },
  },
  est_cost: { label: "Est. cost", dir: "desc", value: (r) => num(r.estCost) },
};

export const ORDER_SORT_DEFAULT = { sort: "risk", dir: "desc" };

/** The direction actually in force: the one asked for, else the key's first-click direction. */
export function sortDirection(key, dir) {
  if (dir === "asc" || dir === "desc") return dir;
  return (PURCHASING_SORTS[key] ?? PURCHASING_SORTS.risk).dir;
}

const byNumber = (a, b) => String(a?.number ?? "").localeCompare(String(b?.number ?? ""));

/**
 * The rows in a new array, sorted by `key` (a PURCHASING_SORTS key; anything
 * else sorts by risk), `dir` "asc" or "desc" (anything else: the key's own
 * direction). Empty values last both ways; ties by item number. The rows
 * themselves are not touched, so the count and every total stay as they were.
 */
export function sortRows(rows, key, dir) {
  const s = PURCHASING_SORTS[key] ?? PURCHASING_SORTS.risk;
  const d = sortDirection(PURCHASING_SORTS[key] ? key : "risk", dir);
  const values = new Map((rows ?? []).map((r) => [r, s.value(r)]));
  return [...(rows ?? [])].sort((a, b) => {
    const va = values.get(a);
    const vb = values.get(b);
    if (va == null || vb == null) {
      if (va == null && vb == null) return byNumber(a, b);
      return va == null ? 1 : -1;
    }
    const c = s.text ? String(va).localeCompare(String(vb)) : va - vb;
    if (c !== 0) return d === "asc" ? c : -c;
    return byNumber(a, b);
  });
}

/*
 * The sort lives in the address (#/purchasing?sort=cover_incl&dir=asc), so
 * reload, a bookmark and back/forward all open the list as it was. A key
 * this version doesn't know, from a later version's link or a typo, opens
 * the default order rather than an error; a direction other than asc/desc
 * means the key's own. The default writes nothing, so #/purchasing stays
 * the plain address. The same rules as Inventory's address.
 */
export function parseOrderSort(query) {
  const p = new URLSearchParams(query ?? "");
  const sort = p.get("sort");
  if (!sort || !Object.prototype.hasOwnProperty.call(PURCHASING_SORTS, sort)) return { sort: "risk", dir: "" };
  const dir = p.get("dir");
  return { sort, dir: dir === "asc" || dir === "desc" ? dir : "" };
}

export function orderSortQuery(state) {
  const p = new URLSearchParams();
  const sort = state?.sort && Object.prototype.hasOwnProperty.call(PURCHASING_SORTS, state.sort) ? state.sort : "risk";
  const dir = sortDirection(sort, state?.dir);
  if (sort === ORDER_SORT_DEFAULT.sort && dir === ORDER_SORT_DEFAULT.dir) return "";
  p.set("sort", sort);
  p.set("dir", dir);
  return p.toString();
}

/** "sorted by cover incl. on order, lowest first", for the line above the table. */
export function orderSortSummary(state) {
  const key = state?.sort && Object.prototype.hasOwnProperty.call(PURCHASING_SORTS, state.sort) ? state.sort : "risk";
  const s = PURCHASING_SORTS[key];
  const d = sortDirection(key, state?.dir);
  const word = s.text ? (d === "asc" ? "A to Z" : "Z to A") : d === "asc" ? "lowest first" : "highest first";
  return `sorted by ${s.label.toLowerCase()}, ${word}`;
}

/*
 * Choosing the supplier on the row (1.8). Allied asked to "select supplier —
 * preferred is the default but I want the option to change it". The Supplier
 * cell becomes a dropdown of the suppliers on file, which is exactly the
 * compare drawer's list (the line's `options`, already in the server's order:
 * preferred, MYOB primary, top biller, other tagged, picked earlier), set to
 * the supplier the item is ordered from now. Choosing one sends what Compare
 * → Choose sends, so the pick is the same row, flagged the same way, with the
 * same Use preferred / Keep. Only suppliers on file are offered (D9): adding
 * one is the item page's job, which keeps the Order list's inputs unchanged.
 *
 *   select   one line under a known supplier: the dropdown. `single` when
 *            only one supplier is on file, so the cell can point at the item
 *            page instead of offering a choice of one.
 *   split    a split (or a split down to one part): its parts are changed in
 *            Compare, where the quantities are, never from a dropdown.
 *   several  two lines that are not a split: decided in Compare, as in 1.6.
 *   ruled    Allied ruled on the item page that it has no supplier.
 *   unknown  no supplier on file at all.
 */
export function supplierSelect(row) {
  const cell = supplierCell(row);
  if (cell.kind === "split") return { kind: "split", count: cell.parts.length, cell };
  if (cell.kind === "several") return { kind: "several", cell };
  const l = row?.lines?.[0];
  if (cell.kind === "unknown" || !l) return { kind: l?.supplierRuledNone ? "ruled" : "unknown", cell };
  const options = [...(row.options ?? [])];
  // The line's own supplier is always among its options; if a server ever
  // sent one that wasn't, the dropdown still shows where the item is now.
  if (!options.some((o) => o.supplierUid === l.supplierUid))
    options.unshift({ supplierUid: l.supplierUid, supplierName: l.supplierName, isPreferred: !!l.isPreferred, source: l.supplierSource, leadTimeDays: l.leadTimeDays, lastCost: l.lastCost });
  return {
    kind: "select",
    cell,
    current: l.supplierUid,
    preferredUid: row.preferredSupplierUid ?? null,
    single: options.length === 1,
    options: options.map((o) => ({
      supplierUid: o.supplierUid,
      name: o.supplierName ?? null,
      role: supplierRole(o),
      leadTimeDays: o.leadTimeDays ?? null,
      lastCost: o.lastCost ?? null,
      selected: o.supplierUid === l.supplierUid,
    })),
  };
}

/*
 * What an option reads: "Hanova — preferred · 120 d · $0.42 last". A part
 * that is missing (no lead time known, never billed) is left out rather than
 * shown as "—", so the closed dropdown stays short. `price` formats the last
 * cost; dashboard.js passes its own, a test passes a fixed one.
 */
export function supplierOptionLabel(o, price = (v) => `$${Number(v).toFixed(2)}`) {
  const bits = [
    o.role,
    o.leadTimeDays != null ? `${Number(o.leadTimeDays).toLocaleString()} d` : null,
    o.lastCost != null ? `${price(o.lastCost)} last` : null,
  ].filter(Boolean);
  return `${o.name ?? "—"}${bits.length ? ` — ${bits.join(" · ")}` : ""}`;
}

/*
 * The request a choice in the dropdown sends, or null when nothing changes.
 *
 *   the preferred supplier again   use-preferred: the pick is cleared and a
 *                                  typed quantity comes with it, exactly as
 *                                  the Use preferred button does
 *   any other supplier             select, as Compare → Choose: this order
 *                                  only, the preferred supplier unchanged,
 *                                  the pick flagged with Use preferred / Keep
 *   no preferred supplier at all   select, whichever is chosen, including the
 *                                  default again: it is recorded as Chosen,
 *                                  as Compare → Choose records it
 */
export function supplierChangeRequest(row, supplierUid) {
  const m = supplierSelect(row);
  if (m.kind !== "select" || !supplierUid || supplierUid === m.current) return null;
  if (!m.options.some((o) => o.supplierUid === supplierUid)) return null;
  if (m.preferredUid && supplierUid === m.preferredUid)
    return { endpoint: "use-preferred", body: { itemUid: row.itemUid } };
  return { endpoint: "select", body: { itemUid: row.itemUid, supplierUid } };
}

/*
 * Why the quantity does not move when the supplier does (1.8). The
 * suggestion is the item's own, built on its usual (effective) supplier's
 * lead time whichever supplier the line is on (whether it should follow the
 * chosen supplier is Allied's question Q5, Stage 14). So the message names
 * what the quantity IS built on, by the kind of minimum, from the rationale
 * fields /cart carries from 1.8:
 *
 *   window  "Quantity stays 1,779. It is built from your minimum of 2,771,
 *           which was set from Hanova's 120-day lead time over 6 months of
 *           use. Changing the supplier here doesn't change it."
 *   manual  "… built from your minimum of M, which you set by hand."
 *   lead    "… built on Hanova's 120-day lead time, the item's usual supplier."
 *
 * A window minimum quotes the lead it was set from (it is not re-derived
 * when a supplier's lead changes; the minimum review shows that drift). A
 * server before 1.8 sends none of these fields: then just the first sentence.
 * A typed quantity stays because it was typed, not because of any minimum:
 * "Quantity stays 3,000, the number you typed. … The suggestion (2,760) is
 * built on …". Without that, the 3,000 Allied typed on N24S16M read as if
 * Shandong Tengda's lead had produced it.
 */
/*
 * leadStockBasis is one of three (cart.ts): a minimum set from a consumption
 * window, a minimum typed by hand ("manual"), or none, the live lead time
 * ("lead"). The first is told apart by elimination: test/order-list.test.ts
 * keeps this module free of the browser's global names, that word included.
 */
const minFromWindow = (r) => r.leadStockBasis !== "manual" && r.leadStockBasis !== "lead";

/*
 * Whose lead time a figure is, as a possessive, or null where it can't be
 * said (1.8 review). Where Allied set a lead on the item itself
 * (leadTimeUsedSource "item": N24S16M carries 107 days on prod while
 * Shandong Tengda's own is 131) the suggestion is built on that, whichever
 * supplier the line is on, so crediting it to the usual supplier would be
 * false. A window minimum quotes the lead it was set from; platform_min_stock
 * keeps no supplier, so on an item lead it is "this item's own" only where
 * it is still the item's figure, and unattributed otherwise. A server before
 * the review sends no leadTimeUsedSource: the usual supplier, as before.
 */
export function leadOwner(r, days = r?.leadTimeDaysUsed) {
  if (r?.leadTimeUsedSource === "item")
    return days != null && Number(days) === Number(r.leadTimeDaysUsed) ? "this item's own" : null;
  return r?.leadTimeUsedFor ? `${r.leadTimeUsedFor}'s` : null;
}

/*
 * Whether the row's quantity is one Allied typed rather than the suggestion
 * (1.8 review): an Edited line, a quantity carried from another supplier, or
 * a Chosen line whose quantity is not the suggestion (a pick keeps a typed
 * qty). Then the quantity stays because it was typed, and the minimum or
 * lead only explains the suggestion beside it.
 */
function typedQty(row) {
  const l = row?.lines?.[0];
  if (!l) return false;
  if (l.state === "edited" || l.qtyCarriedFrom) return true;
  return row.suggestedQty != null && Number(row.qty) !== Number(row.suggestedQty);
}

export function quantityStaysMessage(row, qty = (v) => Number(v).toLocaleString()) {
  const l = row?.lines?.[0];
  const r = l?.rationale ?? {};
  const typed = typedQty(row);
  const head = typed
    ? `Quantity stays ${qty(row?.qty ?? 0)}, the number you typed. Changing the supplier here doesn't change it.`
    : `Quantity stays ${qty(row?.qty ?? 0)}.`;
  if (!("leadStockBasis" in r)) return head;
  // "It", or for a typed quantity the suggestion it replaced.
  const it = typed ? `The suggestion (${qty(row.suggestedQty ?? 0)})` : "It";
  const min = qty(l.minLevel ?? r.minLevel ?? 0);
  if (r.leadStockBasis === "manual") return `${head} ${it} is built from your minimum of ${min}, which you set by hand.`;
  if (minFromWindow(r)) {
    const days = r.minLeadTimeDays ?? r.leadTimeDaysUsed;
    const owner = leadOwner(r, days);
    const lead = days != null ? `${owner ?? "a"} ${qty(days)}-day lead time` : `${owner ?? "the"} lead time then in force`;
    const over = r.minWindowMonths != null ? ` over ${r.minWindowMonths} months of use` : "";
    const tail = typed ? "" : " Changing the supplier here doesn't change it.";
    return `${head} ${it} is built from your minimum of ${min}, which was set from ${lead}${over}.${tail}`;
  }
  const who = r.leadTimeUsedFor ?? "the usual supplier";
  if (r.leadTimeDaysUsed == null)
    return `${head} No lead time is known for ${who}, the item's usual supplier, so ${typed ? "the suggestion" : "it"} is built on cover alone.`;
  if (r.leadTimeUsedSource === "item")
    return `${head} ${it} is built on this item's own ${qty(r.leadTimeDaysUsed)}-day lead time, set on the item page, whichever supplier it is ordered from.`;
  return `${head} ${it} is built on ${who}'s ${qty(r.leadTimeDaysUsed)}-day lead time, the item's usual supplier.`;
}

/*
 * "Why this quantity", the lead-time sentence (1.8): the lead time and the
 * minimum the suggestion was actually built on, then this line's supplier's
 * own lead where the line is with someone else. Before 1.8 the drill-down
 * quoted only the line's lead, so a pick of Tong Ming (42 days) read as if
 * the quantity were built on 42 days when it was built on Shandong Tengda's
 * 131. Null for a server before 1.8, which sends no basis. `compare` false
 * leaves the line's own lead out, for a split, whose parts each show theirs.
 * An item lead is every line's lead, so there is nothing to compare.
 *
 *   "Built on Hanova's 120-day lead time (preferred). Jiaxing's is 120 days."
 *   "Your minimum (2,771, from Hanova's 120 days) sets the lead-time stock."
 *   "Built on this item's own 107-day lead time (set on the item page), whichever supplier it is ordered from."
 */
export function leadBasisSentence(line, options = [], qty = (v) => Number(v).toLocaleString(), compare = true) {
  const r = line?.rationale ?? {};
  if (!("leadStockBasis" in r)) return null;
  const who = r.leadTimeUsedFor ?? null;
  const used = r.leadTimeDaysUsed ?? null;
  const itemLead = r.leadTimeUsedSource === "item";
  const min = qty(line.minLevel ?? r.minLevel ?? 0);
  const daysText = (d) => `${qty(d)} ${Number(d) === 1 ? "day" : "days"}`;
  let s;
  if (minFromWindow(r)) {
    const days = r.minLeadTimeDays ?? used;
    const owner = leadOwner(r, days);
    const from = days != null ? `${owner ? `${owner} ` : ""}${daysText(days)}` : owner ? `${owner} lead time` : "a lead time";
    s = `Your minimum (${min}, from ${from}) sets the lead-time stock.`;
  } else if (r.leadStockBasis === "manual") {
    s = `Your minimum (${min}, set by hand) sets the lead-time stock.`;
  } else if (used == null) {
    s = who ? `No lead time is known for ${who}, so no lead-time stock is added.` : "No supplier is known, so no lead-time stock is added.";
  } else if (itemLead) {
    s = `Built on this item's own ${qty(used)}-day lead time (set on the item page), whichever supplier it is ordered from.`;
  } else {
    const role = supplierRole((options ?? []).find((o) => o.supplierName === who));
    s = `Built on ${who ? `${who}'s` : "the usual supplier's"} ${qty(used)}-day lead time${role ? ` (${role})` : ""}.`;
  }
  const mine = line.supplierName;
  if (compare && !itemLead && who && mine && line.supplierUid !== "none" && mine !== who) {
    const d = line.leadTimeDays;
    const lead = r.leadStockBasis === "lead" ? "" : " lead time";
    s += d != null ? ` ${mine}'s${lead} is ${daysText(d)}.` : ` ${mine}'s${lead} is not known.`;
  }
  return s;
}

/*
 * The first sentence of the message after a choice in the dropdown: what
 * happened, for this order only. The quantity sentence follows it.
 */
export function supplierChangedMessage(row, endpoint) {
  const l = row?.lines?.[0];
  const name = l?.supplierName ?? "the chosen supplier";
  const number = row?.number ?? "This item";
  if (endpoint === "use-preferred") return `${number} is back with its preferred supplier, ${name}.`;
  if (row?.preferredSupplierName && !l?.isPreferred)
    return `${number} is now ordered from ${name}, for this order only. Its preferred supplier is still ${row.preferredSupplierName}; change that on the item page.`;
  return `${number} is now ordered from ${name}, for this order only.`;
}
