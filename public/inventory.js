/*
 * Inventory's address and its "Used in" cell (1.14).
 *
 * Kept apart from dashboard.js, like order-list.js and gaps.js, so
 * test/inventory-link.test.ts can import it: nothing here touches the DOM.
 *
 * An Overview tile opens Inventory on one filter, and its number is the
 * length of that list only if nothing else narrows it. Before 1.14 a tile
 * set the filter and kept whatever search, region, facet and sort the last
 * visit to Inventory left behind, so on the 26 Aug copy "Suggested orders"
 * read 133 and, after a search for "bolt" from China, opened a list of 36.
 * A tile now opens a fresh view: its filter and nothing else, in the
 * default order, written into the address so Back, a reload and a bookmark
 * all show the same list.
 */

/**
 * Inventory with nothing chosen: what an Overview tile starts from. Clear and
 * the quick views still build their own and keep a type, finish or tag.
 */
export const INVENTORY_DEFAULTS = Object.freeze({
  q: "", filter: "all", region: "", sort: "risk", dir: "", page: 1,
  productType: "", productFinish: "", tag: "",
});

/** The Inventory address for a view state; a default is left out of it. */
export function inventoryHashFor(state) {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.filter && state.filter !== "all") p.set("filter", state.filter);
  if (state.region) p.set("region", state.region);
  if (state.sort && state.sort !== "risk") p.set("sort", state.sort);
  if (state.dir) p.set("dir", state.dir);
  if (state.productType) p.set("productType", state.productType);
  if (state.productFinish) p.set("productFinish", state.productFinish);
  if (state.tag) p.set("tag", state.tag);
  if (state.page > 1) p.set("page", String(state.page));
  const qs = p.toString();
  return `#/inventory${qs ? `?${qs}` : ""}`;
}

/**
 * The view an Overview tile opens: its filter, everything else at its
 * default. The address it gives always carries the filter, so the route
 * reads the whole view from it and nothing left in the tab survives.
 */
export function overviewTileState(filter) {
  return { ...INVENTORY_DEFAULTS, filter: filter || "all" };
}

export function overviewTileHash(filter) {
  return inventoryHashFor(overviewTileState(filter));
}

/*
 * "Used in" (1.14): the figure the column sorts by (queries.ts SORT_VALUES
 * used_in), every product the item ends up in through any number of
 * sub-assemblies. The cell used to show only the direct parents, so on the
 * 26 Aug copy a sort by Used in put N16S16M, showing 18 (83 in all), above
 * WR20393G, showing 20 (57 in all). 79 items there sit inside a
 * sub-assembly and show a bigger number from 1.14; the other 366 with a
 * parent are unchanged. A server without parentCountDeep shows the direct
 * count, as before.
 */
export function usedInCount(item) {
  return Math.max(item?.parentCountDeep ?? 0, item?.parentCount ?? 0);
}

export function usedInTitle(item) {
  const all = usedInCount(item);
  const direct = item?.parentCount ?? 0;
  if (!all) return "Not used in any product";
  const products = `${all} product${all === 1 ? "" : "s"}`;
  return all > direct
    ? `Used in ${products}, counting sub-assemblies: ${direct} directly, ${all - direct} more via sub-assemblies`
    : `Used in ${products}, counting sub-assemblies (all directly)`;
}
