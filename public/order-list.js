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
