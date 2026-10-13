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
