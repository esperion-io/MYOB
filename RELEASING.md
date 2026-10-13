# Releasing the Allied dashboard

How a change gets from a branch to Allied's screen, how to prove it moved only what it said, and how to take it back. The rules are §4 of `FEEDBACK-PLAN-2026-10-12.md`; this is the version to work from. Every shipped release gets a row in `FIX-PLAN.md` Part 5.

## What 1.0 put in place

- **The server says what it is running.** `/api/insights/sync/status` carries `release: { version, commit, bootedAt }`. `version` is `package.json`; `commit` is Render's `RENDER_GIT_COMMIT` (7 characters), or `local` anywhere else. `/api/health` is unchanged.
- **The tab says what it is running.** `UI_VERSION` and `RELEASES` sit at the top of `public/dashboard.js`. The sidebar footer reads "Version 1.0 · <commit> · What's new"; What's new opens the help drawer at the change log.
- **Stale tabs are told, and cannot write.** The 60-second status poll compares the server's version with `UI_VERSION`, and its commit with the first commit the tab saw. On any difference a banner asks for a reload; it never reloads by itself. While it is up the tab sends no writes. The server also refuses (409) any non-GET under `/api/insights` whose `x-ui-version` header is present and differs from its own version. Writes with no header (tabs older than 1.0) pass.
- **Change-log rows say which release wrote them.** `logChange` adds `release` and `commit` to `detail`.
- **The build checks the version.** `npm run build` runs `scripts/check-release.mjs` and `npm test` before `tsc`, so Render refuses to deploy a version mismatch or a failing test. `npm test` blanks `DATABASE_URL`, so neither Render's build nor a local run can reach a database from a test.
- **Golden diff.** `scripts/stage-check.mjs` captures everything the dashboard serves, GET only, and diffs two captures by record identity against the release's allow-list.

**The very first 1.0 deploy needs one manual reload of every open tab.** Tabs opened before 1.0 run JS with no banner logic, so they will not ask. Their writes still work, because they send no `x-ui-version`.

## What 1.1 added

- **On order vs MYOB, on Data & Sync.** `/divergence` gains `onOrder` (every item where our On order or the proposed rule differs from MYOB's `qty_on_order`), `openDocs` (every Open PO, counted or not, and why, with what it adds to On order today and what it would add under the proposed rule) and `positionParity` (today's position from `ownedPositions` against the `item_position` view; it must read 0). The proposed rule is `src/sync/openPo.ts`. In 1.1 nothing else reads it: no figure moves until Stage 2.
- **The end-of-sync check.** Each sync records `stats.on_order_below_myob`: item numbers whose On order reads below MYOB's, apart from `KNOWN_PRE_FLOOR` (AFLSA390/490). It runs in its own try/catch, so it can never fail a sync; a failure is recorded as `stats.on_order_below_myob_error`. The sync chip turns amber with "On order below MYOB on N items" when the newest successful run lists any, or "On order check did not run" when it carries the error, which Recent sync runs also shows.
- **Lead-time and minimum edits are logged.** Supplier meta, item lead times and minimums write a `platform_change_log` row (entities `supplier_meta`, `item_lead_time`, `min_stock`) with the rows before and after, in the same transaction as the edit. A bulk edit is one row with its items in `detail.items`. `supplier-rollback.mjs log` lists them; `undo` refuses them by design, and says to re-enter the "before" figure in the dashboard. `BACKUP_TABLES` / `TABLES` are unchanged.

## What 1.2 changed

- **On order follows `src/sync/openPo.ts`.** All five readers of open POs use its fragments: `item_position_at` (body only; same arguments and `RETURNS TABLE`), `ownedPositions`, the item page PO rows, the Suppliers open-PO lateral and the Overview region table. `test/open-po-rule.test.ts` fails the build if any SQL in `src/` tests status `'OPEN'` on `myob_purchase_orders` without `OPEN_PO_DOC`, or if `GREATEST(COALESCE(l.qty` comes back.
- **Additive fields.** `/items/:uid` `incoming[]` gains `outstanding` and `po_uid` (`qty` and `received_qty` stay for older tabs) and lists only lines with something to arrive, with no 20-row cap. `/divergence` `onOrder` gains `ruleLive: true`; `openDocs[].outstandingToday` now reads the rule (the document's `outstanding` when counted, else 0).
- **`stage-check` captures kit pages** (`kits/<number>.json`: every watched kit and every kit a watched item goes into), because buildable incl. incoming lives only there. Take both captures of a release with the same checkout of the script, or the kit files show as added.
- **`stage-check expect <before> <after>`** generates a numbers release's allow-list from two captures of the same data. Review it before committing; never hand-write it.

## What 1.3 added

- **Cover incl. on order.** `ItemComputed` gains `coverWeeksInclOnOrder`: Available (free stock + on order) ÷ weekly, to 1 dp, null exactly where `coverWeeks` is. It is the figure `cover_below_lead_time` was already computed from; the flag keeps reading the unrounded value. It reaches every response that carries a whole computed item: `/items`, `/items/:uid` `item`, and the Overview's `attention` list.
- **Additive keys.** `sort=cover_incl` (lowest first on the first click) and `filter=below_lead` (exactly the `coverBelowLeadTime` items). On a 1.2 server the sort falls back to risk and the filter lists everything; the 1.3 page follows the server's `sort` (arrow and summary say risk) and leaves Below lead time out of the summary when the items carry no `coverWeeksInclOnOrder`. The `available` sort key still means free stock; it is commented, never renamed.
- **`items.csv`** gains "Cover incl. on order (weeks)" as its last column. Every earlier column is byte-identical.
- **`stage-check cover <after> [--before <before>] [--base local|prod]`** checks the 1.3 identities on a capture: incl × weekly within 0.05 × weekly of max(Available, 0) (using the unrounded weekly, rebuilt from the demand fields, because `demand.weekly` is served to 3 dp), incl ≥ excl, equal with nothing on order, null with no demand, and the new CSV column against the items list. `--before` compares every existing CSV column byte for byte; `--base` fetches the `below_lead` and `cover_incl` lists (GET only) and checks the filter count and the sort order.
- **Stage 3 deploy:** as any UI release. Capture before and after, `diff --allow scripts/expected/1.3.0.json` (0 not allowed), then `cover ../captures/1.3.0-after --before ../captures/1.3.0-before --base prod` (all ok). Open BN1665G and the Inventory filter Below lead time (even with on order) in the browser; expand a row on that filter and on All items and check it spans the whole table.

## What 1.4 changed

- **The Order list header counts a split in full.** `requirementRange` (`cart.ts`, now exported and pure) takes an item's split parts as one candidate at their sum; any other line is a candidate of its own, and each end is still the cheapest and dearest candidate per item. With one line or one split per item, which is every item since f2148b2, the header is a single figure equal to `estimatedCost`. Lines, quantities, supplier subtotals, `estimatedCost`, suggestions and both CSVs are unchanged.
- **`kit.doubleOrders` counts items, not lines** (`kitDoubleOrderItems`), so a flagged kit split between two suppliers is one. `cart.csv`'s kit warning still counts rows, so the sheet is byte-identical; the page note now reads "N kits are on order together with their own parts, or with a kit they go into", because the flag sits on both sides of a clash and a sub-assembly kit can be counted for either role (Products & BOM counts parent kits only; on the 26 Aug copy both are 3).
- **`stage-check splits <after> [--before <before>]`** reads `cart.json`. On one capture it counts split items and flagged kit items and lines, and says how far each header end will move. With `--before` (1.3) on the same data it checks Δlow = Σ(sum − smallest part) and Δhigh = Σ(sum − largest part), `kit.doubleOrders` = flagged items, and that every line (walked from both captures, with `totalLines`, so a vanished $0 line fails), supplier subtotal and `estimatedCost` is unchanged.
- **Stage 4 deploy:** before shipping, run `splits ../captures/1.4.0-before` on the prod capture. If it finds no split items, the 1.4 What's new "no figure changes" wording stands. If it finds any, write the count and the header's before/after (the 1.3 range, and the single figure it will become: `estimatedCost`) into the entry, and send Allied that before/after table as a heads-up before the deploy evening (§4.5). Then deploy as usual: `diff --allow scripts/expected/1.4.0.json` (0 not allowed), then `splits ../captures/1.4.0-after --before ../captures/1.4.0-before` (all ok).

## What 1.5 changed

Groundwork for the by-item Order list (1.6), shipped on its own so a defect in it can't hide inside the new view. Nothing visible changes apart from Purchasing's past-date notice.

- **`/cart` gains seven additive fields.** Every line gains `qtyCommitted`, `coverWeeksInclOnOrder`, `coverBelowLeadTime` and `riskScore`, copied from the `ItemComputed` the line already reads (so on hand − committed = the line's free stock, and each equals `/items` for that item). The payload gains `window`, `hasSnapshot` and `snapshotsFrom` from the same `snapshotState` call `/items` uses (now exported from `queries.ts`), on the normal return and on the empty-cart early return. Grouping, lines, quantities, states, subtotals, the header range and `cart.csv` are untouched.
- **Purchasing's past-date notice** now gets the snapshot flag, so `historicalNotice` says what it says on Inventory: on a day with a stored snapshot, committed and on order come from it; before 21 Aug, they are understated and the notice names the start date.
- **One reload for the Order list.** `reloadOrderList()` in `dashboard.js` is the only place that fetches `/cart`: the first load and every write (qty edit, ×, Put back, Use preferred, Keep, Choose/Split via `afterCartDecision`, Undo; Start again goes through the first load). It redraws the active view through `drawOrderList()`, which is By supplier until 1.6. The requests each write sends are unchanged.
- **The expand panel no longer reads Inventory's globals.** `toggleExpandRow(tr, lookup, colspan, ctx)` and `expandPanelHtml(item, ctx)` take the rows, the column count and the target cover from the caller. Inventory passes `invItems`, its header count (14) and its target cover, which is what they read before.
- **`public/order-list.js`** exports `groupLinesByItem(cart)`: one row per item, qty and est. cost summed over its lines (a split's parts add up), options taken once, the item's stock fields carried, the 1.5 fields read with `?? null`. Not used on screen until 1.6. It is DOM-free, so `test/order-list.test.ts` imports it directly; `test/release.test.ts` now also checks that every `public/` module but the two page scripts loads without a DOM.
- **Stage 5 deploy:** see "Stage 5 deploy" below. The snapshot is mandatory, because every Order list write now goes through the new reload.

## What 1.6 changed

Allied's request #3: the Order list by item. Browser only; no server file changes, so every capture is identical apart from `release`.

- **Purchasing opens on By item** (`#/purchasing`). By supplier, unchanged, is `#/purchasing/suppliers`; Minimum stock review stays `#/purchasing/minimums`. Any other tab opens By item, as any other tab opened the Order list before; so on a rollback to 1.5, both new URLs open the old Order list.
- **One row per item**, drawn from `/cart` by `public/order-list.js` (`orderByItemRows`: `groupLinesByItem`, then risk highest first, then item number). The pure models for each cell (`supplierCell`, `qtyCell`, `rowLeadTimes`, `orderListSummary`, `BY_ITEM_COLUMNS`) live there and are tested in `test/order-list.test.ts`; `dashboard.js` only renders them.
- **Header:** "N items to order · M taken off · $X estimated". N + M = `totalItems`, and $X is `/cart`'s `estimatedCost`, never re-added in the browser.
- **Writes are By supplier's own.** The qty box uses the same `wireCartQtyInput` (POST `/cart/line` with the line's supplier, `edited` unless the line is Chosen or Split), × is `/cart/take-off`, Use preferred / Keep are the same buttons, and Compare is the same drawer. Split rows and two-supplier rows are read-only ("edit in Compare"). The header buttons, notices, Decided and Taken off lists are shared functions (`orderListActions`, `cartDuplicatesNotice`, `cartKitNotice`, `wireOrderListCommon`), moved out of `drawCart` unchanged.
- **Drill-down** (item code or ▸) fetches `/items/:uid` at the dates on screen, cached by URL and re-fetched if its stock no longer matches the row, and opens Inventory's expand panel through `toggleExpandRow` (colspan = `BY_ITEM_COLUMNS.length`, 15), with By item's own section (`ctx.extraHtml`: why this quantity, suppliers on file) and the detail it already holds (`ctx.detail`, so the chart isn't fetched twice). Inventory passes neither and is unchanged.
- **Stage 6 deploy:** see "Stage 6 deploy" below. The snapshot is mandatory: By item is a second place every Order list write can be made from.

## What 1.7 changed

Allied's request #4: "the sorting functionality from the Inventory tab" on Purchasing. Browser only, apart from one `export` (`SORT_DEFAULT_DIR`, `queries.ts`), so every capture is identical apart from `release`.

- **By item's headers sort as Inventory's do.** Click to sort, click again to flip, ▲/▼ on the column in use, a hover ↕, empty values last both ways, ties by item number. The first click is the column's own direction: lowest or A first for Item, Supplier, On hand, Free stock and both covers; highest first for the rest. The default is still risk, highest first, then item number (D18), exactly the 1.6 order; there is no Risk column, so the "Sorted by" line above the table says so and carries "back to highest risk first" once another sort is chosen.
- **`public/order-list.js`** adds `PURCHASING_SORTS` (Inventory's key names for the columns the two share: `risk`, `number`, `on_hand`, `committed`, `available` = free stock, `incoming`, `weekly`, `cover`, `cover_incl`; plus `supplier`, `suggested`, `order_qty`, `est_cost`, `lead_time`), `sortRows(rows, key, dir)`, and the address helpers `parseOrderSort` / `orderSortQuery` / `orderSortSummary`. `BY_ITEM_COLUMNS` entries carry their `sort` key. `test/order-list.test.ts` holds every shared key to `SORT_DEFAULT_DIR`, checks every key both ways (empty last, ties by number, a permutation with the same totals) and the address round trip. Supplier sorts on the name the cell leads with (a split's first part); Lead time on the row's longest known lead.
- **The sort is in the address:** `#/purchasing?sort=cover_incl&dir=asc`. `route()` reads it for By item only (`isOrderByItemRoute`; By supplier and the minimum stock review are untouched), on Inventory's rules: a query sets it, an unknown key gives the default, no query keeps the sort on screen. Each redraw writes it back with `replaceState`, so reload, bookmarks and back/forward keep it. The default writes nothing.
- **Purchasing-only header:** `sortableHeader(state, key, label, tip, cls)` in `dashboard.js` draws Inventory's markup and classes (`th.sortable`, `.sorted`, `.th-inner`, `.sort-arrow`) from the state it is given. Inventory's `sortTh` is not touched (Stage 16 moves Inventory onto the new helper). Sorting is client-side over `cartData`: a header click redraws without a fetch, a redraw after a write (`reloadOrderList`) keeps the order, and open drill-downs re-open under their own rows.
- **Width:** in `.obi-table` the arrow takes space only on the sorted column and the hover ↕ none, so the default table's narrowest width is 1.6's (1,072 px, measured in headless Chrome without the web fonts); a sorted single-word column adds about 10 px. At 1440 px the panel is 1,152 px and every sort fits with no scrollbar. At 1366 px the headers now carry the same narrower side padding as the cells, and every sort (default, Committed ▼, Weekly demand ▼, Suggested, Order qty, Lead time, On order, On hand, Cover) measured 0 px over the 1,078 px panel in the browser with the real fonts. Before that change, Committed ▼ and Weekly demand ▼ were 3 px over.
- **Stage 7 deploy:** as any UI release; no snapshot (Stage 7 writes nothing). Capture before and after, `diff --allow scripts/expected/1.7.0.json` (0 not allowed). In the browser (GET only): Purchasing opens in the 1.6 order; click Cover incl. on order (▲, lowest first), click again (▼), click Supplier (▲ A to Z, "No known supplier" last) and again (▼, still last), reload (kept), Back from another page (kept); Inventory sorts as before. Rollback is a pure revert: a `?sort=` bookmark then opens the default order.

## What 1.8 changed

Allied's request #3, second half: "select supplier — preferred is the default but I want the option to change it". The supplier is chosen on the By item row. No new endpoint, table or cart state; the writes are the ones Compare → Choose and Use preferred already make.

- **The Supplier cell is a dropdown** of the line's `options` (the compare drawer's list, in `/cart`'s order: preferred, MYOB primary, top biller, other tagged, picked earlier), each reading "NAME — role · N d · $X last" with missing parts left out, set to the supplier the item is under now. The pure model is `supplierSelect`, `supplierOptionLabel` and `supplierChangeRequest` in `public/order-list.js`. Choosing another supplier POSTs `/cart/select` (this order only; the preferred supplier is unchanged; the pick is flagged with Use preferred / Keep exactly as from Compare). Choosing the preferred supplier again POSTs `/cart/use-preferred` (pick cleared, typed qty kept). An item with no preferred supplier POSTs `/cart/select` whatever is chosen, its default included, so it is recorded as Chosen, as Compare does. Splits read "Split (n) — change in Compare"; two-line items keep 1.6's "decide in Compare"; one supplier on file adds "Add a supplier on the item page →" (`#/item/<uid>`); `supplierRuledNone` items read "No supplier (ruled)"; none on file, "No known supplier". The row is locked while the request is in flight; a 400 or 409 is shown with `alert()`, as every other Order list write does, and the row is redrawn from `cartData`.
- **A toast says why the quantity doesn't move** (`quantityStaysMessage`), worded by `rationale.leadStockBasis`: window minimum ("built from your minimum of M, which was set from S's L-day lead time over W months of use. Changing the supplier here doesn't change it."), hand-set ("… which you set by hand."), or none ("built on S's L-day lead time, the item's usual supplier."). `showToast` in `dashboard.js` is new: bottom right, one at a time, 20 s or until closed. Errors still use `alert()`.
- **`/cart` lines gain seven fields** (additive; `scripts/expected/1.8.0.json`): `supplierRuledNone`, and in `rationale` `leadTimeDaysUsed` / `leadTimeUsedFor` (the effective supplier's lead the suggestion was built on, and that supplier's name), `leadTimeUsedSource` (`item` / `supplier` / `measured`: an `item` lead is set on the item page and applies to every supplier, so the screens credit it to the item, not to the supplier), `leadStockBasis` (`window` / `manual` / `lead`), `minWindowMonths`, `minLeadTimeDays` (a window minimum's window and the lead it was set from). `rationale.leadTimeDays` still carries the line's own supplier's lead for tabs from before 1.8. "Why this quantity" (`cartRationale`, on both views, and the By item drill-down's `leadBasisSentence`) now names the lead actually used: on a pick, "built on SHANDONG TENGDA's 131d lead · this supplier 42d" where it used to say "42d lead". Where a minimum sets the lead-time stock, the bit names the minimum's lead ("min from …'s 120d lead") or, for a hand-set one, only this supplier's lead. The quantity message after a change says "the number you typed" for a typed qty, and explains only the suggestion beside it.
- **Validation (`insights.ts`):** `/cart/select` refuses (400) a supplier that is not one of the item's options: on file, or picked or split to earlier (`cartSupplierOptions`, which is `loadSourcing`'s own set). `/cart/split` refuses fewer than two parts, a supplier twice, a supplier not an option, or a qty that is not a finite number ≥ 0. Both are checked before anything is written. The pure checks are `selectSupplierProblem` / `splitPartsProblem` in `cart.ts`, tested in `test/cart-validate.test.ts`. The drawer only ever sends options, so a tab from before 1.8 never meets them.
- **Undo keeps a typed quantity** (`undoCartDecision`): inside the same `cartWrite`, the quantity on show (`typedQtyOnShow`) is re-inserted as an `edited` row under the item's default supplier (the first option once the picked rows are gone), so the one `undo_decision` entry carries it in its before and after. A split has no single quantity and keeps none, as before.
- **Width:** the dropdown fills the Supplier column down to 8rem (a fixed 9rem made the table 4 px over at 1366 px), the row's buttons read "Use preferred" / "Keep" (the cell already names the preferred supplier; "Use SHANDONG TENGDA" beside Keep took the column to 241 px and the table to 1,203 px whenever a pick was open, on 1.7 as well), and a split's two lead times may wrap. Measured in headless Chrome without the web fonts: 1,078 px in the 1,078 px panel at 1366 and 1,152 in 1,152 at 1440, with and without open picks, kept picks and a split.
- **Stage 8 deploy:** see "Stage 8 deploy" below. The snapshot is mandatory: the row is a new place a supplier pick can be made from.

## What 1.9 changed

Allied's request #2, part 1: "If an ETA date on the PO can Allied use that data pulled over to the dashboard". Allied decided on 12 Oct 2026 to enter ETAs as the PO's Promised Date in MYOB, which is already synced. No figure moves and no table, view or function is added.

- **The ETA rule** (`src/insights/incoming.ts`, `poEta`, pure), worked out once per PO document: the Promised Date when it is on or after the PO date (an earlier one is ignored and flagged `promisedIgnored`); otherwise the PO date + the PO's own supplier's lead (Allied's `platform_supplier_meta.lead_time_days`, else the measured median), labelled an estimate; otherwise no date. A passed date with stock outstanding is `overdue` (promised) or `late` (estimated) and keeps its date; it is never placed in the past as received or moved to today. An item's own lead time is never used: one PO arrives once. Where Allied's lead differs from the measured median by more than 14 days, the estimate carries the measured date too (`measuredDays`, `measuredEta`).
- **`src/insights/leadTimes.ts`** holds the per-supplier lead query, moved out of `cart.ts` unchanged and imported by both. It is a runtime SELECT over `supplier_lead_time`; nothing in the database depends on that view. `/cart` and `cart.csv` are byte-identical.
- **Additive fields.** `/items/:uid` gains `incomingSchedule[]` (`openPoSchedule`: one row per open PO line with something to arrive, from the `openPo.ts` fragments: `poUid`, `number`, `supplier`, `raised`, `ordered`, `received`, `outstanding`, `eta`, `etaBasis` `promised`/`estimated`/`none`, `status` `due`/`overdue`/`late`/`undated`, `daysToGo`/`daysLate`, `promisedIgnored`, and the lead inputs of the basis text), `incomingSummary` (units by status: `dated` + `overdue` + `late` + `undated` = `total` = On order; `next`; POs overdue, late and undated; `promisedHistory`) and `incomingScheduleDate`. `incoming` is unchanged. `/divergence` `openDocs[]` gains `expected` (the same per-document ETA; null when not counted or nothing to arrive). Today only: at a past as-at the schedule rows are facts only (no date or status) and `incomingSummary` is null, because MYOB keeps no PO history.
- **Screens.** The item page gets an **Incoming purchase orders** panel (PO | Supplier | Raised | Outstanding | Expected | Basis | Status, overdue and late first, total "= On order", the Promised Date history once under it, and the footnote "Enter a Promised Date on the PO in MYOB to replace an estimate (picked up within 6 hours)"), titled "Open purchase orders today" at a past date. Commitments & incoming keeps the sale orders, with Ordered and Promised columns. The On order tile and the expand panel's On order row say "next 1 Nov (promised)", "next ~10 Dec (est.)" or "1 PO overdue"; the expand panel (Inventory and Purchasing's drill-down) lists the POs. Data & Sync's Open purchase orders gains Expected / Basis / Status, the line "N of M open POs have no Promised Date — enter one in MYOB", a No Promised Date badge and a filter for them. Wording lives in `public/incoming.js` (DOM-free). Against a server before 1.9 every screen draws its 1.8 form.
- **No ETA feeds any calculation.** On order, cover, suggestions, flags, risk, minimums, the cart and the daily rows are untouched; `test/incoming.test.ts` checks that the calculating modules (cart, minimums, kits, kit plan, schema, sync engine) do not import `incoming.ts`, that `computeItem` never mentions the schedule, and that `ledger.ts` uses it only in `openPurchaseDocs` (Data & Sync's list), never in `ownedPositions` or `snapshotPositions`.
- **`stage-check schedule <after> [--base local|prod|URL]`** checks a capture: Σ schedule outstanding = `qtyOnOrder` per item, the summary adds up, the POs listed are exactly the counted open documents with stock to arrive and no reversal, one date per PO across every item, promised exactly when the Promised Date ≥ the PO date, estimate = PO date + lead, rows in order, and Data & Sync's date = the item pages'. `--base` fetches every item with stock on order (GET only; about 125 pages); without it only the watched pages are checked. It prints one line per PO.
- **Stage 9 deploy:** see "Stage 9 deploy" below.

## What 1.10 changed

Stage 11 of the plan, the groundwork for Allied's request #2 part 2 ("show what gaps might exist between current stock levels, current demand, and incoming stock"). It ships as 1.10 because versions follow ship order and Stage 10 (the daily PO record) has not shipped; the plan's heading says 1.11. Nothing on screen changes and no figure moves; no table, view or function is added.

- **The projection** (`src/insights/projection.ts`, `projectItem`, pure: no database, no clock, type-only imports). P(d) = free stock today + Σ outstanding on schedule lines that are dated, still to come (status `due`) and ≤ d − (weekly ÷ 7) × d, with weekly the unrounded rate free-stock cover uses (`weeklyRate`, rebuilt from `demand`'s sums). Committed is reserved today, as free stock already does. Overdue, late and undated lines are not counted. The horizon is the later of the last dated delivery and the day free stock alone runs out, capped at 26 weeks. The run-out is the first day P < 0; the gap ends on the counted delivery that brings P back to ≥ 0 (`end`, `endingPo` with its basis), else it is `gap_open` with `openReason` `overdue` | `late` | `no_date` | `after_26_weeks` | `too_small` (in that order of precedence). `unitsShort` is the deepest shortfall, today's included; an open gap's depth is unknown, so it carries today's shortfall when it starts today and null otherwise (Stage 12 shows it as blank, never as a total). Threshold zero; `minLevel` travels as a reference only. Statuses: `gap`, `gap_open`, `covered` (with `tight` when the next counted delivery lands under 14 days before free stock alone runs out), `nothing_on_order`, `no_demand` (no demand and free stock not negative; already-negative free stock is projected, a gap from today), `built_here` (a kit whose form is `made_here` and that has no PO open for the complete kit; a kit on a PO is being bought complete and is projected like any item, never broken open). No position (free stock null): no projection.
- **Attached in `computedItems`** (`attachGaps`), after the kit rules: one `openPoSchedule()` per cache build, started beside the item query and only when as-at is the business date. Every item gains `gap`, `gapStatus`, `nextDelivery` (soonest counted delivery: date, basis, largest PO that day, units that day, PO count) and `incomingOverdueQty` (units on lines overdue or late). All four are null at a past date.
- **Fail-safe.** The schedule query's failure is caught where it starts; the projection runs over the whole set before anything is assigned. On any error every item gets null gap fields, one line is logged for that cache build ("Stock gaps left blank for this build: …"), and nothing is thrown: the Order list, the minimum review, kits, the Overview and Inventory carry on as on 1.9.
- **Switch-off:** `GAP_ENABLED` in `queries.ts`. `false` runs no schedule query and leaves every field null. Withdrawing gaps after a later release has shipped is that one-line release, never a revert (§4.2): the constant, plus the version bump and its RELEASES entry as for any release. No test pins it to `true` (the off path is tested through `gapsRunFor(…, enabled)`), so `npm run build` passes with it `false`.
- **Server keys, nothing on screen:** sort `gap` (soonest run-out first, gap + gap_open only, the rest last; first click ascending), filters `gap` (gap + gap_open) and `incoming_overdue` (`incomingOverdueQty` > 0), and Overview `kpis.runsOutBeforeNextDelivery` (null when nothing was projected). `INVENTORY_FILTERS`, `INVENTORY_SORTS` and `PURCHASING_SORTS` do not offer them yet (Stage 12); on a 1.9 checkout the filters list everything and the sort falls back to risk.
- **Not touched:** no CSV column; gap fields are not in `flags`, so Tags, the CSV Flags column and risk are unchanged; suggestions, both covers, the cart and the daily rows read none of it. `test/incoming.test.ts` holds that: no file under `src/` but `queries.ts` and `projection.ts` mentions `projection.js` or a gap field; in `queries.ts` they appear only where it declares, attaches, sorts, filters and counts, and never in `computeItem` or `items.csv`; and `queries.ts` reads the schedule (`openPoSchedule`, `ScheduleRow`) only in `itemDetail` and the gap attachment.
- **`npx tsx scripts/stage-check.mjs gap <after> [--base local|prod|URL]`** recomputes each item's four fields from its `/items/:uid` (the item and its `incomingSchedule`) with the server's own `projectItem` and fails on any difference. With `--base` it fetches every item with stock on order plus 50 others spread through the list (GET only) and the `gap` / `incoming_overdue` / `sort=gap` lists. It checks the identities (first run-out with no counted delivery before it = free-stock cover × 7 within a day, on every item; every known gap end is one of the item's due ETAs) and the Overview count, and prints the counts by status, how many gap + gap_open items are not flagged below lead time, and one line per item that runs out. It runs under tsx (it imports the `.ts` module); every other command still runs under plain node.
- **Stage 11 deploy:** see "Stage 11 deploy" below.

## What 1.11 changed

Stage 12 of the plan: Allied's request #2 part 2 on screen, "show what gaps might exist between current stock levels, current demand, and incoming stock". It ships as 1.11 because versions follow ship order and Stage 10 (the daily PO record) has not shipped; the plan's heading says 1.12. No figure moves and nothing is written; no table, view or function is added.

- **Where the dates come from.** Allied decided on 12 Oct to enter ETAs as the PO's Promised Date in MYOB, so that is what a gap counts. A PO with none is counted on its labelled estimate (PO date + its supplier's lead, "ETA missing — estimated"), and every gap says which it ended on (tile note "promised" / "estimate", the sentence "is promised for" / "is estimated for … (raised 12 Aug + 120 days)"). Overdue and late POs are not counted as arriving: a gap waiting on one shows its start and "end unknown", and the PO is listed beside the outlook strip, never placed on it (D10).
- **Server (additive only).** `projection.ts` adds `gap.weeks`: the projection walked a week at a time to the horizon (`start`, `days`, `low`, `close`, `arrivals`), so the browser draws the server's series and never re-projects; inside the gap a day's low is taken before its delivery lands, so the lowest week is units short. `CartLine.gap` (optional) is the item's gap less `weeks` (it would add 125 KB to /cart on the copy). `items.csv` appends eight columns after Cover incl. on order (weeks): Next delivery date, Next delivery qty, ETA basis, Gap start, Gap end, Gap days, Units short, Overdue qty; all blank at a past date, the gap ones blank unless the item runs out before its next delivery (gap / gap_open), an open gap with its run-out day as Gap start, no Gap end or Gap days, and Units short blank when it starts after today (no known depth). `cart.csv` is unchanged (D20). `test/incoming.test.ts` lets the gap fields into exactly two new places: `gapCsvCells` in `queries.ts` and three lines of `cart.ts` (the type import, the `CartLine` field, the copy beside the risk score).
- **Words, in one DOM-free module.** `public/gaps.js` turns the server's fields into the tile, the cell, the sentence and the strip's model (`gapTile`, `gapCell`, `gapSentence`, `outlookModel`); `test/gaps.test.ts` pins each against gaps from the server's own `projectItem`. Missing fields (a server before 1.10) read "—"; null fields (a past date) read "—" / "today only".
- **Item page.** A Stock gap tile after the two covers ("27 Oct → 10 Dec", "~1,056 short · estimate"; "From today", "end unknown (PO 00022886 overdue)"; "None before next delivery" with "tight"; "Nothing on order"; "No demand"; "Follows its components"). A Stock outlook (today) panel above Purchasing suggestion: one bar per week (its lowest point; in a delivery week also the stock after it), the gap's weeks on a red band, arrivals as markers (solid promised, hollow estimate), the minimum as a dashed reference line, overdue / late / undated POs listed beside it, and the sentence. With a gap the strip is scaled to today's free stock (or the gap's depth if deeper), so the shortfall stays readable and a large delivery's bar is clipped, and the minimum is left off when it is above that scale; a series of one week (an open gap whose POs are all off the timeline) draws no strip, only the list and the sentence. The sentence opens with today's shortfall when stock is already short ("already short by 893") and gives the gap's depth later ("~3,504 units short"). At a past date the panel says it is today only.
- **Inventory.** Gap before delivery after Cover incl. on order ("6.3w from 27 Oct" over "~1,056 short", "from today" / "end unknown", "tight", "—" with what it is on hover), sort key `gap` (soonest first, "soonest first" in the summary line). Filters Runs out before next delivery (`gap`) and Incoming overdue or late (`incoming_overdue`), both empty at a past date, where the empty row says why. The expand panel shows the sentence. The Gap, Cover incl. and Weekly demand headings may now take two lines, so the table is no wider than on 1.10 (1,336 px against 1,354 for page 1 at 1440 px; it scrolled inside its panel before and still does).
- **Overview.** A tile Runs out before next delivery: N (`kpis.runsOutBeforeNextDelivery`), linking to the `gap` filter; no tile when the field is null (a past date) or missing.
- **Purchasing By item.** A sixteenth column, Gap before delivery (`PURCHASING_SORTS.gap`: the run-out day of gap / gap_open, soonest first, the rest last, as the server's `sort=gap`), and the sentence in the drill-down. To fit at 1366 px the By item cells' side padding went from 0.45rem to 0.35rem, the headings' letter-spacing from 0.08em to 0.03em, a sorted heading's arrow may drop under its label, and the item name under its number is a size smaller: narrowest table 1,074 px in the 1,078 px panel at 1366 (1.10: 1,068), exactly 1,152 at 1440, under the default, gap, supplier and cover sorts (headless Chrome, no web fonts, en-US currency "NZ$"; NZ locale's "$" is narrower).
- **`node scripts/stage-check.mjs screen <after> [--before <the 1.10 capture>] [--base local|prod|URL]`** checks the CSV columns (header, every cell = the items list's field, every earlier column byte-identical with `--before`), `cart.csv` byte-identical, every `/cart` line's gap = its item's less `weeks`, and with `--base` that By item's gap sort (order-list.js's own `sortRows`) orders the cart as `/items?filter=suggested&sort=gap` does apart from ties, and the Overview count = the `gap` filter's total. GET only.
- **Stage 12 deploy:** see "Stage 12 deploy" below.

## What 1.12 changed

Stage 13 of the plan, on Allied's answer to Q5 (12–14 Oct): "when they pick a different supplier, the suggested qty should match with whatever supplier they pick". Q2b (does an item lead apply under every supplier?) was not answered directly; our reading of the Q5 answer is that a lead time set on an item is for its usual supplier. This release does the lead-time half; the quantity follows in the next (Stage 14). It ships as 1.12 because versions follow ship order and Stage 10 (the daily PO record) is parked. Displayed lead times only: no quantity, cost, total, minimum, ETA or CSV moves, and nothing is written; no table, view or function is added.

- **The rule (`cart.ts` `leadForSupplier`, pure, tested).** A lead set on the item applies only under the item's usual (effective) supplier, the one `computeItem` builds the suggestion on. Any other supplier shows its own: Allied's figure from the Suppliers page, else the measured median (`leadTimes.ts`), else none. An item with no usual supplier at all (none on file, or ruled none) keeps its own lead on every line, as before. Before 1.12 the item's lead applied under every supplier (FEEDBACK-PLAN §1.9), so N24S16M read 107 under Tong Ming against Tong Ming's own 45 (13 Oct prod).
- **What moves.** Per line and per compare option, for an item with an item lead under a supplier other than its usual one: `leadTimeDays`, `leadTimeSetByAllied`, `leadTimeOrders`, `leadTimeSameDayExcluded`, and `rationale.leadTimeDays` (the line's own lead) with them. That is the Order list Lead time column (both views), the supplier dropdown's options, Compare (and so its "fastest" badge), the drill-down's suppliers on file, and Why this quantity. `rationale.leadTimeDaysUsed` (what the quantity is built on), `suggestedQty`, `qty`, `estCost`, the supplier cards' `leadTimeDays` (always the supplier's) and `cart.csv` do not move. ETAs never read it (`incoming.ts` uses the PO supplier's lead, unchanged since 1.9).
- **Additive field.** `leadTimeSource` on every `CartLine` and `CartOption`: `item` / `supplier` / `measured`, null with none. The browser uses it to tell a 1.12 server (per-supplier leads) from an older one (the item's lead on every line), so a new tab on an old server words things as before.
- **Words.** Why this quantity on a pick now gives the pick's own lead beside what the quantity is built on. Compare and the drill-down label an item lead "set on the item", a supplier's "set by Allied" (`order-list.js` `leadTimeNote`). The By item table gains no column and no wider cell, so it fits at 1366 / 1440 px exactly as on 1.11. The sentence has two forms (besides a hand-set minimum's "Your minimum (…, set by hand) …"), and on prod (13 Oct) the second never shows: every item with an item lead in the cart has a minimum (47 window, 1 by hand), N24S16M's a window one (2,349, 6 months, 107 d).
  - With a window minimum (N24S16M under Tong Ming): "Your minimum (2,349, from this item's own 107 days) sets the lead-time stock. TONG MING ENTERPRISES CO LTD's lead time is 45 days." (before: the first sentence alone). The toast after a dropdown change is 1.11's: "It is built from your minimum of 2,349, which was set from this item's own 107-day lead time over 6 months of use. Changing the supplier here doesn't change it." By supplier's working: "min from this item's own 107d lead · this supplier 45d lead".
  - With no minimum (the local copy, after setting an item lead): "Built on this item's own 107-day lead time (set on the item page). TONG MING ENTERPRISES CO LTD's is 45 days." (before: "…, whichever supplier it is ordered from."). The toast: "It is built on this item's own 107-day lead time, set on the item page. Changing the supplier here doesn't change it." By supplier's working: "built on this item's own 107d lead · this supplier 45d lead".
  - The drill-down's Stock gap sentence names the usual supplier with an item lead: "An order placed with SHANDONG TENGDA today would land about … (this item's own lead time, 107 days)." (before: "An order placed today …").
- **`node scripts/stage-check.mjs leads <capture> [--base local|prod|URL]`** predicts, from one 1.11 capture, every (item, supplier) whose shown lead 1.12 moves, old -> new: the list for Allied. Each supplier's own lead is read off the capture (an option of an item with no item lead, else Allied's figure in `suppliers.json`, else the measured median of an item it is the usual supplier of); `--base` also fetches `/suppliers.csv` (GET only), which names every supplier's measured median, so no row is left "not in capture". **`leads <before> <after>`** lists what did move and fails unless it equals the prediction from `<before>`, every predicted row's new figure is named (so on prod pass `--base prod` here too: `/suppliers.csv` names the measured leads the capture can't, GET only), each moved to the predicted figure (days, note, and for a measured one its order and same-day counts), a line moves with its own option and its Why this quantity lead, `leadTimeSource` is right on every line and option, every other `/cart` field is identical (every lead field too, outside the rows 1.12's rule covers), and `cart.csv` is byte-identical.
- **Stage 13 deploy:** see "Stage 13 deploy" below.

## What 1.13 changed

Stage 14 of the plan, on Allied's answer to Q5 (13 Oct): "when they pick a different supplier, should the suggested qty change? — yes it should match with whatever supplier they pick". It ships as 1.13 because versions follow ship order and Stage 10 is parked. **A numbers release**: Order list quantities move, on lines under a supplier other than the item's usual (effective) one that show the suggestion. Nothing is written; no table, view or function is added.

- **The arithmetic moved, unchanged (`queries.ts` `suggestOrderQty`, pure).** computeItem's suggestion block is now `suggestOrderQty(inputs)`: weekly × 8 + lead-time stock − free stock − on order, rounded up to MYOB's reorder multiple; the lead-time stock is the applied minimum, else weekly × lead weeks. computeItem calls it and keeps a qty of 0 as "no suggestion", as before. `demandRate` is the unrounded weekly rate both use, and `suggestionInputs(item)` reads computeItem's inputs back off a computed item. Proof on the 26 Aug copy: all 3,103 computed items JSON-identical (key order included) between the 1.12 tree and this one, on the copy as it is and with window, hand-set and item-lead data set up; `suggestOrderQty(suggestionInputs(item))` reproduces the suggestion exactly on every item except the 219 made-here kits whose suggestion the kit rule withholds into a build plan (none of which reach the cart): 2,884 = all 2,590 non-kit items + 294 kits. Tests pin BN1665G 1,779 and SPW12G 3,564 (prod 13 Oct inputs) and computeItem's MHS20EG case.
- **The rule (`cart.ts` `supplierSuggestion`, pure, tested).** A line under the usual supplier (or an item with none) keeps `item.suggestion` exactly. A line under any other supplier is rebuilt on that supplier's lead from 1.12's `leadForSupplier` (Allied's figure on the Suppliers page, else the measured median):
  - **window minimum:** lead-time stock = the stored monthly burn × lead ÷ 30.44, rounded up (`suggestedMinimum` on the row's own `monthly_burn`; it gives every stored minimum back exactly at the lead it was set from: 289 of 289 window minimums in the f2148b2 prod capture, 14 Oct NZ);
  - **hand-set minimum:** unchanged (basis `manual`);
  - **no minimum:** weekly × lead ÷ 7.
  A supplier with no known lead keeps the item's suggestion (`no_lead`), and so does one whose lead equals the one the item's own is built on (`same_lead`; for a window minimum, the lead it was set from). No MOQ or pack size rounding: none is stored and Allied named none.
- **Which items are listed is unchanged.** The Order list still lists an item when its own (usual supplier's) suggestion is above 0 or it is below its minimum (`purchaseCart`'s `needing` filter), and the rule applies only to those. An item whose usual-supplier suggestion is 0 but which has a saved pick of a slower supplier stays off the list, even though that supplier's rebuilt suggestion would be above 0. Intended for 1.13: bringing such items in would be a further numbers change, for the lead to decide with Allied.
- **Typed quantities never move.** The cart's qty precedence is unchanged (a carried qty, else the saved qty, else the suggestion), so a typed, carried or split-part qty stays; only its `suggestedQty` becomes that supplier's. Picking the usual supplier again (Use preferred) returns to `item.suggestion`. `estCost` follows qty, and with it the supplier subtotal, the header ends and `cart.csv` (Order qty, Est cost and the supplier's block heading).
- **Additive fields.** `CartLine.qtyTyped`; `rationale.suggestionFor` on every line (`supplierUid`, `supplierName`, `basis` usual / rebuilt / same_lead / manual / no_lead / no_window, `leadDays`, `leadSource`, and the item's own `usualQty`, `usualSupplierName`, `usualLeadDays`, `usualLeadSource`); `CartOption.suggestedQty`, `suggestedEstCost` and `suggestionBasis` (each supplier's own). On a rebuilt line `rationale.leadTimeDaysUsed` / `leadTimeUsedFor` / `leadTimeUsedSource` name the line's supplier (the field still means "the lead the suggestion was built on") and `leadStock`, `rawNeed`, `leadTimeWeeks`, `leadTimeSource` are the rebuild's; everywhere else they are the item's as before, and the `min*` fields stay facts about the applied minimum. The 1.13 JS reads the item's own back from `suggestionFor` wherever it names the item's suggestion or the minimum's lead (`order-list.js` `asUsual` / `minLeadOwner`: the min tooltip, a split row's Why this quantity). A 1.12 tab left open after the deploy pairs the three with `minLeadTimeDays` and can word a rebuilt window-minimum line wrongly ("from HOBSON's 107 days") until the reload banner brings it to 1.13; accepted, since the alternative (leaving the three as the item's) would make the same old tab call every rebuilt quantity the usual supplier's. `CartOption.qty` for a supplier not in the cart stays the item's own suggestion (the drawer shows it only in the cart).
- **Words.** By item's Suggested is the line's own (a split row's is the item's own, not the parts' sum). The message after a dropdown choice: "Quantity is now 1,023, rebuilt on HOBSON ENGINEERING Co. PTY.LTD's 24-day lead time (was 2,361 on this item's own 107 days)."; a typed qty "Quantity stays 600, the number you typed. The suggestion for HANOVA INTERNATIONAL LTD is 1,872."; a hand-set minimum "Quantity stays 9,259 — your hand-set minimum doesn't depend on lead time."; back to the usual supplier "Quantity is now 2,361, built on this item's own 107-day lead time (was 1,023 on …'s 24 days)." (local copy, Stage 14 test decisions). Why this quantity on a rebuilt line: "Rebuilt on HOBSON ENGINEERING Co. PTY.LTD's 24 days: your minimum (1,725, from this item's own 107 days) comes to 387 at that lead time, and that sets the lead-time stock. On this item's own 107 days it would be 2,361." By supplier's working: "min at this supplier's 24d lead: 387" / "built on this supplier's 42d lead". Compare's Est cost is each supplier at its own suggestion, "for N suggested" under it. A 1.13 tab on an older server (no `suggestionFor`) words everything as 1.12 did (`quantityStaysMessage`). By item gains no column and no wider cell.
- **`node scripts/stage-check.mjs qty <capture>`** predicts, from one 1.12 capture, every Order list line whose suggested or order quantity 1.13 moves, old -> new, with its basis, lead, and est. cost: the list for Allied. It re-derives the rule independently from the capture (unrounded weekly from the demand fields, the stored burn, each line's and option's shown lead). A Chosen line at its suggestion is read as not typed (a 1.12 capture can't say; 1.13 adds `qtyTyped`) and flagged. **`qty <before> <after>`** fails unless every line's suggested, qty and est. cost equal the prediction (so exactly the predicted lines moved), every usual-supplier line equals its item's suggestion, typed quantities stayed, `qtyTyped` and `suggestionFor.basis` are right on every line, every option's own suggestion equals the prediction, supplier subtotals and the header add up from the lines, every item's own suggestion is identical, every other `/cart` field is identical, and `cart.csv` moved only on predicted rows to the predicted Order qty and Est cost (block headings only for moved suppliers). Reads captures only; sends nothing.
- **Stage 14 deploy:** see "Stage 14 deploy" below.

## What 1.14 changed

Stage 15 of the plan: four defects on Inventory, moved off the Purchasing path (FEEDBACK-PLAN D6, §6). It ships as 1.14 because versions follow ship order and Stage 10 is parked. No served figure moves and nothing is written; what Allied see change is the Overview's Cover < 2 weeks list and the Used in cell, so it is announced with a before/after list like a numbers release (§4.5).

- **`cover_lt2` (`queries.ts`).** A new filter key, coverWeeks < 2 on the served (1 dp) cover excl. on order, through `coverUnderTwoWeeks`, the predicate the Overview's `coverUnder2w` now counts with too, so the tile and its list can't drift. Before, the tile opened `low_cover` (< 4 weeks): 322 items behind a tile reading 303 on the 26 Aug copy (as at 14 Oct). `low_cover` is unchanged. Inventory offers it as "Cover under 2 weeks", just above "Cover under 4 weeks". On a 1.13 server the key is unknown and lists everything. `/items` now also echoes the filter it applied (additive `filter`: the key, or "all" for none or an unknown one, as `sort` echoes the order), so a 1.14 tab on a 1.13 server, which sends no echo, drops the filter from the summary line whatever the sort, as it does for `below_lead` and the gap filters. (A guess from the page, as first built, missed a Cover-sorted list: its first 50 are all under 2 weeks even unfiltered.)
- **`filterItems` (`queries.ts`, pure, exported).** The filter `switch` moved out of `listItems` verbatim, so a test can hold a tile's count to the list it opens without a database. It still runs after the search, facets and region. Proof: 168 `listItems` responses (21 filters x 4 sorts x with / without a search and region) hash-identical between the 1.13 tree and this one on the copy.
- **Every Overview tile opens a fresh list (`public/inventory.js`, pure, tested).** `overviewTileState(filter)` is the tile's filter with everything else at its default (no search, region, product type, finish or tag; risk order; page 1), and `overviewTileHash` its address, `#/inventory?filter=<filter>`. The address always carries a query, so `route()` reads the whole view from it. Before, a tile set `invState.filter` alone and went to a bare `#/inventory`, which keeps whatever the last visit left: on the copy, Suggested orders (133) opened 36 after a search for "bolt" from China. All seven tiles (Below min stock, Cover < 2 weeks, Suggested orders, Runs out before next delivery, Negative stock, Assembled products, Excess stock value) go through it; their totals on the copy with nothing left over: 0, 303, 133, 45, 0, 513 and 190 items, each equal to its count. Inventory's own address builder moved there as `inventoryHashFor`, unchanged (tested against the 1.13 function). Presets, Clear and the Inventory nav link are unchanged (the nav link still keeps the view, on purpose).
- **Used in shows the figure it sorts by.** The cell is `usedInCount(item)` = max(`parentCountDeep`, `parentCount`), exactly `SORT_VALUES.used_in`; before, it showed `parentCount` (direct parents only) while sorting by the deep count. Its tooltip names both ("Used in 13 products, counting sub-assemblies: 2 directly, 11 more via sub-assemblies"). It moves on items inside a sub-assembly only: 79 of the 445 items with a parent on the copy (BN1665G 2 -> 13, N16S16M 18 -> 83, WR16301.5S16 11 -> 70). A server without `parentCountDeep` shows the direct count.
- **Inventory subtitle.** "Position quantities are MYOB facts" becomes "On hand, committed, free stock and on order are platform figures built from MYOB transactions", the wording the 26 Aug review (C1, C2) gave the item page and the Overview.
- **Export this list** follows the filter, sort, direction, search, region, facets and date: 1.3 made `loadInventoryTable` rebuild its link on every load. Checked, not changed; a test now pins it.
- **Stage 15 deploy:** see "Stage 15 deploy" below.

## The live service

The live service is **not** what `render.yaml` describes. `render.yaml` names `allied-myob-bridge` on the free plan with a partial env list; it is not applied to anything. The live service is:

- `srv-d9p9rnm417fc73dem690`, region Singapore, Starter plan;
- auto-deploys from `main`; expected to build with `npm install && npm run build` and start with `npm start` (that is what `render.yaml` says, so confirm it in the Render dashboard: see Before the first deploy, item 0);
- https://esperion-inventory-dashboard.onrender.com.

Its environment lives in the Render dashboard. Change it there, not in `render.yaml`.

## Before the first deploy (Anthony, on Render)

These cannot be done from a development machine: production Postgres and Render SSH are not reachable from it.

0. **Confirm the Build Command.** Render → the service → Settings: the Build Command must be `npm install && npm run build`. If it is anything else (e.g. `npm install && tsc`), `check-release` and `npm test` do not gate deploys, and the build guard above protects nothing. Record what it was in `FIX-PLAN.md` Part 5.
1. **Check the f2148b2 boot backup.** From the Render shell, run `DATABASE_URL=<prod> node scripts/supplier-rollback.mjs status`. Record in `FIX-PLAN.md` Part 5 that `pre_preferred_fix` exists and its row counts and checksums hold. It has never been checked.
2. **Local setup.**
   - Set `SYNC_INTERVAL_HOURS=0` in `.env.local`.
   - Rename or remove the `myob-dashboard` entry in `/Users/anthonyxiao/Dev/allied/.claude/launch.json`. It runs `npm run dev`, which loads `.env`, the production database.
   - Before Stage 2, refresh `allied_dev` from a prod dump: current POs, cart decisions and the f2148b2 tables. Run `DELETE FROM connections` on the copy before its first `npm run dev:local`.
3. **Before any lead-time question goes to Allied** (Q2 and the MYOB tidy-up list):
   - Copy the lead-time and minimum tables, which have no other backup:
     ```sql
     CREATE TABLE bak_<yyyymmdd>_supplier_meta  AS TABLE platform_supplier_meta;
     CREATE TABLE bak_<yyyymmdd>_item_lead_time AS TABLE platform_item_lead_time;
     CREATE TABLE bak_<yyyymmdd>_min_stock      AS TABLE platform_min_stock;
     ```
     They sit outside the backup registry, so `supplier-rollback status` is unaffected.
   - Take a `stage-check capture` against prod.

## Cutting a release

1. **Branch** `stage/<n>-<slug>` from `main`: one stage or one follow-up, one to three commits.
2. **Version.** Use the next `1.N.0` in ship order, not the stage number. Use `1.N.1` only for a fix to the newest release, before anything else ships. A change to an older stage is a new `1.N.0`, labelled e.g. "Stage 9 follow-up: ETA wording". Every push to `main` bumps the version. Docs-only changes wait for the next release.
3. **Set the version in three places**, which the build checks agree:
   - `package.json` `version`;
   - `UI_VERSION` in `public/dashboard.js`;
   - a new entry at the **top** of `RELEASES`: `{ version, date, stage, changes, numbers, check }`. Write it for Allied, in three parts: what you'll see, numbers that changed (with an example item, or "None"), and how to check it. Set `date` to the day it ships.
4. **Allow-list.** Write `scripts/expected/<version>.json`. List every path the release is meant to change, with a `why`. A UI release lists only what it adds. Paths look like `items[*].coverWeeks`, `suppliers[*].lines[*].qty` or `rows[*].Order qty` (CSV). `*` is one name, `[*]` is any one record, and a path covers everything beneath it.
5. **Check:**
   ```sh
   DATABASE_URL= npm run build
   node scripts/check-release.mjs --pre-push   # also: newer than the newest v* tag
   ```
6. **Commit body:**
   - the quoted request;
   - what changes on screen;
   - numbers changed (items and amounts);
   - "Verified" with figures;
   - a **"Rollback:"** paragraph.
7. **Deploy** (below). Then tag `v<version>` on the merged commit and push the tag. Add the Part 5 row.

## Deploy

**Pre-flight**
- `/sync/status` shows the 17:45 NZ run finished with `success`. Otherwise every boot starts a catch-up sync (the last success is 6+ hours old), which can race MYOB's single-use refresh token across instances. Skip that evening.
- No other deploy is in progress, and the previous release has finished its soak.
- Stages 5, 6 and 8 only: take the snapshot first (see "Snapshots and data changes").

**Window:** 18:00–23:15 NZ time.
- Never within 15 minutes of a sync (05:45, 11:45, 17:45, 23:45).
- Never across midnight NZ.
- Never two deploys within 15 minutes of each other.

**Steps**
1. Capture, then push:
   ```sh
   read -s DASHBOARD_KEY && export DASHBOARD_KEY   # typed, not echoed, not in shell history
   node scripts/stage-check.mjs capture ../captures/<version>-before --base prod
   git push origin main
   ```
2. Wait for `/sync/status` to report the new `release.version`. That takes about 8 minutes, and `npm test` now runs in the build.
3. Capture again and diff:
   ```sh
   node scripts/stage-check.mjs capture ../captures/<version>-after --base prod
   node scripts/stage-check.mjs diff ../captures/<version>-before ../captures/<version>-after --allow scripts/expected/<version>.json
   ```
   It exits non-zero on any change that is not allow-listed. It also notes allow-listed changes that did not appear; for a numbers release, that is as suspicious as an extra one.
4. Check that `/divergence` `positionParity` is 0.
5. Confirm What's new shows the release, then send the release note.
6. **1.0 only:** ask Allied to reload every dashboard tab that was open before the deploy, once. Those tabs run pre-1.0 JS: they show no banner and send no `x-ui-version`, so they keep saving and escape every later 409 until reloaded. The 1.0 note says so in its last bullet.

Keep captures outside the repo. They hold Allied's business data (`captures/` is git-ignored in case). The capture never contains the key: it is sent only as a header, and any response that echoed it is redacted and reported.

**Failed deploy.** This only matters for a release that changes a function body; in this plan that is only Stage 2. DDL runs before `listen`, so the new `item_position_at` body may be live under the old code.
1. Check `/divergence` `positionParity`.
2. Before 23:45, restart or manually redeploy the live commit, so its boot re-creates its own body.
3. Check parity again.

**Soak**
- A numbers release needs one business day plus the 23:45 closing sync before the next release.
- A UI release may be followed the next evening.

## Rollback

Rollback is **strictly newest-first.**
- Only the newest release is ever reverted.
- To remove an older stage, ship a new release that switches it off, tested like any other: `GAP_ENABLED = false`, By supplier made the default again, a column hidden.
- Never `git revert` an older stage's commits. `dashboard.js` has no type check, so an out-of-order revert fails silently in the browser.
- Stage 2 is never withdrawn; it is fixed forward.

**R1. Roll back on Render.** Render → the previous deploy → Rollback (about 2 minutes). Boot re-creates the previous function body.

**R2. Auto-deploy.** Apply the drill result. If Render disabled auto-deploy, leave it off until R3 is pushed, then turn it back on.
*Drill result (Stage 1 deploy, below): not yet run. Record here whether Render turned auto-deploy off after the rollback.*

**R3. Make `main` match what is live.** In this order:
1. `git revert --no-commit <release commits, newest first>`.
2. Set the next version, in all three places.
3. Keep the withdrawn release's `RELEASES` entry and mark it `withdrawn: "<new version>"`.
4. Add the new entry: "1.N withdraws 1.M: what went back; numbers that went back".
5. Commit and push.

`main` then matches what is live, and the version doesn't go backwards.

**R4. Confirm.** Check that `/sync/status` reports the new `release.version`. Open tabs show the banner and are refused (409) until they reload. Send Allied a one-line note.

**R5. Stages 5, 6 and 8 only.** Run `node scripts/supplier-rollback.mjs status`, then `diff --from pre_s<n>_…`. By default nothing is restored, because rows use existing states.
- Use `undo <id>` per item.
- Use `restore` only on Allied's request, dry run first.

## Stage 1 deploy: rollback drill

The 1.1 deploy is also the rehearsal of a real rollback, on a release that moves no figure and writes no decision data. Done by Anthony; nothing here can be done from a development machine. Allow about an hour inside one deploy window (18:00–23:15 NZ), and keep every deploy, rollback and redeploy at least 15 minutes from the last and from a sync.

Before you start:
- [ ] Pre-flight as for any deploy: the 17:45 NZ sync finished with `success`. A rollback and a redeploy are boots too, and each would start a catch-up sync otherwise.
- [ ] `read -s DASHBOARD_KEY && export DASHBOARD_KEY`, then `node scripts/stage-check.mjs capture ../captures/1.1.0-before --base prod`.

1. **Deploy 1.1.**
   - [ ] Push. Wait for `/sync/status` `release.version` = `1.1.0`, and note `release.commit`.
   - [ ] Capture `../captures/1.1.0-after` and `diff ../captures/1.1.0-before ../captures/1.1.0-after --allow scripts/expected/1.1.0.json`: 0 not allowed.
   - [ ] Data & Sync, **On order vs MYOB:** exactly WSBT450G, WQ16806G, BP1675G, SPW12G, BN16110G and BP1690G marked "Proposed = MYOB", plus AFLSA390/490 marked known. Anything else stops Stage 2 until it is explained. Write down each item's Proposed figure: Stage 2's acceptance checks against them.
   - [ ] **Open purchase orders:** re-derive the counted list on the day. The 13 Oct capture expects 12 counted and 6 not counted (00019910, 00020462, 00022808 ×2, 00020624 ×2).
   - [ ] **Position check** reads "agree on every item" (`positionParity.mismatches` = 0). The sync chip is unchanged from before the deploy: no 1.1 sync has run yet, so it cannot show the new check (step 6 does).
   - [ ] **Open purchase orders:** the "Adds to On order today" figures on the not-counted rows add up to the Ours − MYOB excess in the table above, AFLSA390/490 aside (194,147 on the 26 Aug copy: 190,727 on the negative 00022808 and 3,420 on 00019910).
   - [ ] Leave this tab open (**tab A**, on 1.1).
2. **Roll back to 1.0.** At least 15 minutes after step 1's deploy went live.
   - [ ] Render → the service → Events → the 1.0 deploy → Rollback. Wait for `/sync/status` `release.version` = `1.0.0`.
   - [ ] Within 60 s, tab A shows "The dashboard was changed back to version 1.0. Reload."
   - [ ] The 1.0 server refuses a 1.1 write (409). The plan asks for this from tab A with a qty edit, but tab A stops sending writes once its banner is up (`fetchJson` refuses before the request leaves), and a qty edit that got through would be a real cart write. So probe from a shell instead; this is a recorded deviation from the plan. The empty body means nothing can be written even if the guard let it through: The empty body means nothing can be written even if the guard let it through:
     ```sh
     curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "x-dashboard-key: $DASHBOARD_KEY" -H 'x-ui-version: 1.1.0' \
       -H 'content-type: application/json' -d '{}' https://esperion-inventory-dashboard.onrender.com/api/insights/cart/line
     ```
     Expect `409`. The same with `x-ui-version: 1.0.0` gives `400` (the route's own check on the empty body).
   - [ ] Reload a second tab so it runs 1.0 (**tab B**). Its footer reads Version 1.0.
3. **Record whether Render turned auto-deploy off.**
   - [ ] Render → Settings → Auto-Deploy: note On or Off, here under R2 and in `FIX-PLAN.md` Part 5.
4. **Redeploy 1.1.** At least 15 minutes after the rollback.
   - [ ] Render → Manual Deploy → the 1.1 commit noted in step 1 (or "Deploy latest commit" if `main` is still on it). Turn auto-deploy back on if step 3 found it off.
   - [ ] Wait for `/sync/status` `release.version` = `1.1.0` and the same `release.commit` as step 1.
   - [ ] Within 60 s, tab B shows "The dashboard was updated to version 1.1. Reload to continue…". The probe above with `x-ui-version: 1.0.0` now gives `409`.
   - [ ] Capture `../captures/1.1.0-redeploy` and diff it against `1.1.0-after` with no allow-list: no figure differs (only `release.bootedAt`, which the diff ignores).
5. **Write it down** (after step 6 as well).
   - [ ] `FIX-PLAN.md` Part 5: the 1.1.0 row (commit, deploy time UTC, status) and a line for the drill: both banners seen, the 409 seen, auto-deploy finding.
   - [ ] Replace the *Drill result* line under R2 with the finding.
6. **After the first sync on 1.1** (the next scheduled one, e.g. 23:45 NZ; never start one to test this).
   - [ ] `/sync/status` `recentRuns[0]` is `success`, its `stats.on_order_below_myob` is an array (expected `[]`), and it has no `on_order_below_myob_error`.
   - [ ] The sync chip reads "Data synced … ago", with no "below MYOB" or "check did not run" text.
   - [ ] Record the result in the 1.1.0 row of `FIX-PLAN.md` Part 5. Anything below MYOB, or the error, stops Stage 2 until it is explained.

## Stage 2 deploy: On order matches MYOB

The only release in the plan that changes a function body (`item_position_at`), so "Failed deploy" above applies. It is never withdrawn: MYOB's figure is the spec, so a problem is fixed forward.

Before the evening:
- [ ] Refresh the local copy from production, `DELETE FROM connections` on it, and regenerate the allow-list on it, same data both times:
  1. Check out the 1.1 commit in a separate worktree and start it on the copy (`npm run dev:local`; its boot puts the 1.1 body back). `node scripts/stage-check.mjs capture ../captures/1.2.0-local-before --base local`, using the 1.2 checkout's script.
  2. Stop it, start the 1.2 branch on the same copy, `capture ../captures/1.2.0-local-after --base local`.
  3. `node scripts/stage-check.mjs expect ../captures/1.2.0-local-before ../captures/1.2.0-local-after --stage "Stage 2: On order matches MYOB" > scripts/expected/1.2.0.json`. Read every entry. Expect the six items (WSBT450G, WQ16806G, BP1675G, SPW12G, BN16110G, BP1690G) and what follows from them, and nothing else. The committed file was generated on the 26 Aug copy, where no suggestion moves; on live data SPW12G and BN16110G suggestions, their cart lines and CSV cells, and the Overview suggested count also move.
  4. Leave the local copy on the 1.2 body.
- [ ] Re-derive the release note's figures from that evening's Stage 1 "Proposed rule" column, and set the 1.2.0 `RELEASES` date to the ship date (the past-date notice reads it).
- [ ] Send Allied the before/after table as a heads-up.

On the evening (pre-flight, window and steps as for any deploy):
- [ ] Capture before, push, wait for `release.version` = `1.2.0`, capture after, `diff --allow scripts/expected/1.2.0.json`: 0 not allowed, and no expected change missing.
- [ ] Each item's new On order equals the Stage 1 "Proposed rule" figure captured that evening. On order vs MYOB lists only AFLSA390/490.
- [ ] The `coverBelowLeadTime` count is unchanged (119 before and after on the 26 Aug copy).
- [ ] `positionParity` is 0.
- [ ] After the next sync, the chip is green. **Roll back immediately (R1) if any item other than AFLSA390/490 reads below MYOB.**
- [ ] Allied confirm in MYOB: WSBT450G = 0 and BP1675G = 11,000. Record it in Part 5.
- [ ] Rollback note for Allied, if ever needed: days that closed while 1.2 was live keep the corrected figure, so history becomes mixed.

## Stage 5 deploy: Purchasing groundwork

A UI release with no visible change apart from the past-date notice. It touches the path every Order list write takes, so the snapshot comes first (§4.10). Done by Anthony: production Postgres is reached only from the Render shell.

Before the evening:
- [ ] On the refreshed local copy (`npm run dev:local`), work through every By supplier action once on 1.4 and once on 1.5, same items, and compare `platform_purchase_cart`, `platform_cart_item_off`, `platform_cart_pick_ack` and the `platform_change_log` actions: edit a qty, ×, Put back, Use preferred, Keep, Compare → Choose, Split, Undo, Start again. They must match apart from `detail.release`. Put the copy back afterwards (`Start again`, then delete the test `cart` log rows).

On the evening (pre-flight and window as for any deploy):
1. [ ] **Snapshot**, from the Render shell, before pushing:
   ```sh
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs status        # note the database name it prints
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs snapshot pre_s5_<yyyymmdd> --apply --confirm <that database name>
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs status        # pre_s5_<yyyymmdd> listed, no PROBLEM lines
   ```
   Record the snapshot name and its row counts in the 1.5.0 row of `FIX-PLAN.md` Part 5. No snapshot, no deploy.
2. [ ] Capture before, push, wait for `release.version` = `1.5.0`, capture after, then `diff --allow scripts/expected/1.5.0.json`: 0 not allowed. Every expected entry should appear, apart from line fields when the cart is empty.
3. [ ] `positionParity` is 0.
4. [ ] In the browser: Purchasing looks as it did on 1.4 (same header, cards and totals). Pick a date between 21 Aug and yesterday: the notice says committed and on order come from the snapshot stored that day. Pick a date before 21 Aug: it says they are understated and that daily snapshots began on 21 Aug. On Inventory, expand a row on All items and on Below lead time (even with on order): the panel spans the whole table and quotes the target cover.
5. [ ] Send the release note: nothing changes on screen except the past-date note.

If rolled back (R1–R5): R5 is `status`, then `diff --from pre_s5_<yyyymmdd>`. Nothing needs restoring, because 1.5 writes only through the existing endpoints and states; `undo <id>` handles any single bad write.

## Stage 6 deploy: Purchasing by item

A UI release: By item becomes Purchasing's default view. No figure moves and no server file changes, but every Order list write can now be made from a second view, so the snapshot comes first (§4.10). Done by Anthony: production Postgres is reached only from the Render shell.

Before the evening, on the refreshed local copy (`npm run dev:local`):
- [ ] Both views list the same (item, supplier, qty) set; By item's "N items to order · M taken off" adds up to By supplier's "items need an order", and its "$X estimated" equals By supplier's total (they part only while an item sits under two suppliers undecided; the duplicates notice says so).
- [ ] Type a qty in By item: it shows on By supplier, marked Edited, with an `edit_line` change-log row carrying `detail.release = 1.6.0`. `supplier-rollback.mjs undo <id>` restores it. × then Put back round-trips. Use preferred / Keep and Compare → Choose / Split from By item behave as from By supplier. Put the copy back afterwards (`Start again`, then delete the test `cart` log rows).
- [ ] On a checkout of `v1.5.0`, `#/purchasing` and `#/purchasing/suppliers` both open the Order list.

On the evening (pre-flight and window as for any deploy):
1. [ ] **Snapshot**, from the Render shell, before pushing:
   ```sh
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs status        # note the database name it prints
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs snapshot pre_s6_<yyyymmdd> --apply --confirm <that database name>
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs status        # pre_s6_<yyyymmdd> listed, no PROBLEM lines
   ```
   Record the snapshot name and its row counts in the 1.6.0 row of `FIX-PLAN.md` Part 5. No snapshot, no deploy.
2. [ ] Re-derive the BN1665G row in the 1.6.0 `RELEASES` `check` from that evening's before-capture (`items.json`/`cart.json`): suggested, on hand, committed, free stock, on order, weekly, both covers, lead time, supplier. Set `date`.
3. [ ] Capture before, push, wait for `release.version` = `1.6.0`, capture after, then `diff --allow scripts/expected/1.6.0.json`: 0 not allowed. `/cart` and `cart.csv` must be identical.
4. [ ] `positionParity` is 0.
5. [ ] In the browser (GET only, no edits on prod): Purchasing opens on By item; the header's two counts add up to By supplier's "items need an order" and the totals agree; BN1665G's row matches step 2; ▸ on it opens the panel with why this quantity and its suppliers on file; By supplier looks exactly as on 1.5.
6. [ ] Send the release note. Ask Allied to edit one agreed item in By item and check it on By supplier, then tell us which item. Put it back with `supplier-rollback.mjs log`, then `undo <id>` on that `edit_line` (dry run, then `--apply --confirm <db>`). Not by typing the suggested quantity back: that saves a lasting `edited` row fixed at that day's suggestion, and the UI has no Undo for a qty edit.

If rolled back (R1–R5): both new URLs open the 1.5 Order list. R5 is `status`, then `diff --from pre_s6_<yyyymmdd>`. Nothing needs restoring: rows written from By item are the same `edited` and `removed` rows and take-off markers By supplier writes, and `undo <id>` handles any single bad write. To withdraw By item later without a revert, ship a release that makes By supplier the default again (`orderListView`'s default and `renderPurchasing`'s mapping).

## Stage 8 deploy: Choose the supplier on the row

A UI release with additive `/cart` fields and stricter validation on two writes. No figure moves. Allied's picks become one click on every row, so the snapshot comes first (§4.10). Done by Anthony: production Postgres is reached only from the Render shell.

Before the evening, on the refreshed local copy (`npm run dev:local`):
- [ ] In By item, choose another supplier for one item: it moves to that supplier on By supplier and in `cart.csv` (Chosen supplier, CHECK — preferred supplier is …), flagged on the row and in "Earlier picks", with one `select_supplier` log row carrying `detail.release = 1.8.0`. Keep clears the flag. Changing the preferred supplier on the item page brings it back. Type a qty, then choose the preferred supplier again in the dropdown: one `use_preferred` row, the qty kept. Pick again, Undo: the typed qty stays, Edited, under the default supplier. An item with no preferred supplier: choose its default again, it reads Chosen. The toast reads right for a window minimum, a hand-set one and none, says "the number you typed" for a typed qty, and, for an item with its own lead time set on the item page, names that lead and no supplier. Put the copy back afterwards (`Start again`, then delete the test `cart` log rows, and clear any test minimums).
- [ ] A made-up supplier uid on `/cart/select`, and a split with one part, a repeated supplier or a negative qty, are refused 400 with nothing written. Compare → Choose and Split still work.
- [ ] Fifteen columns fit at 1366 px and 1440 px with an open pick on screen.
- [ ] A keyboard pass in Chrome on Windows (what Allied use): Tab onto a Supplier dropdown and press ↓. On Windows that changes a closed dropdown at once; it must ask "Order … for this order only?" first, and Cancel must leave the row and the change log untouched. Choosing with the mouse asks nothing.

On the evening (pre-flight and window as for any deploy):
1. [ ] **Snapshot**, from the Render shell, before pushing:
   ```sh
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs status        # note the database name it prints
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs snapshot pre_s8_<yyyymmdd> --apply --confirm <that database name>
   DATABASE_URL=<prod> node scripts/supplier-rollback.mjs status        # pre_s8_<yyyymmdd> listed, no PROBLEM lines
   ```
   Record the snapshot name and its row counts in the 1.8.0 row of `FIX-PLAN.md` Part 5. No snapshot, no deploy.
2. [ ] Re-derive BN1665G's figures in the 1.8.0 `RELEASES` entry (suggested, minimum, its window and lead, Hanova's last cost) from that evening's before-capture (`cart.json`: the line's `minLevel` and `rationale`). Set `date`.
3. [ ] Capture before, push, wait for `release.version` = `1.8.0`, capture after, then `diff --allow scripts/expected/1.8.0.json`: 0 not allowed. `cart.csv` must be identical.
4. [ ] `positionParity` is 0.
5. [ ] In the browser (GET only, no picks on prod): every By item row with suppliers on file shows the dropdown on its current supplier; BN1665G's drill-down says "Your minimum (2,771, from HANOVA INTERNATIONAL LTD's 120 days) sets the lead-time stock." (or that evening's figures); By supplier looks exactly as on 1.7.
6. [ ] Send the release note. After Allied's first picks: `supplier-rollback.mjs log --limit 10` matches the rows they describe.
7. [ ] Follow-up, not part of the deploy: the handbook (`info-pack.html`) is refreshed after Stage 3 (cover) and Stage 8 (Purchasing), FEEDBACK-PLAN §6. Both are still pending; note in the 1.8.0 row when done.

If rolled back (R1–R5): picks made from the row are ordinary `selected` rows, which 1.7 shows as flagged picks, and an Undo's `edited` row is an ordinary typed qty. R5 is `status`, then `diff --from pre_s8_<yyyymmdd>`. Nothing is restored by default.
- **One bad pick:** `supplier-rollback.mjs log --item <N>`, then `undo <id>` on that `select_supplier` (dry run, then `--apply --confirm <db>`). It puts back the rows the pick deleted, the typed qty included.
- **Wholesale, only if Allied ask:** `diff --from pre_s8_<yyyymmdd>`, then `restore cart --from pre_s8_<yyyymmdd>` as a dry run, then `--apply --confirm <db>`. This also wipes every quantity typed since the snapshot, so say so to Allied first.

## Stage 9 deploy: Incoming POs with expected dates

A UI release with additive fields. No figure moves and nothing is written, so no snapshot (§4.10). Rollback is a pure revert: a 1.8 page ignores the new fields.

Before the evening, on the refreshed local copy (`npm run dev:local`):
- [ ] `stage-check capture` before (1.8 checkout) and after, `diff --allow scripts/expected/1.9.0.json`: 0 not allowed, `cart.json`/`cart.csv`/`items.json` unchanged. `stage-check schedule <after> --base local`: all ok.
- [ ] The browser checks in the 1.9.0 `RELEASES` `check`, on the copy's figures.

On the evening (pre-flight and window as for any deploy):
1. [ ] Capture before. **Re-derive the expected values table** from it, with that evening's live leads (Allied's figures apply on prod; the copy has none). The before-capture comes from 1.8, which serves no schedule, so work the rule by hand: each counted PO from `divergence.json` `openDocs` (number, supplier, `date`, `promisedDate`), its supplier's lead (Allied's figure is `lead_time_days` in `suppliers.json`; the measured median is not in that file, so take it from the "Lead time (days)" column of `GET /api/insights/suppliers.csv`; `promised_days` in `suppliers.json` is Promised Date minus PO date, not a lead, and must not be used), then the Promised Date if it is on or after the PO date, else PO date + lead, and overdue or late against that evening's NZ date. As at the 13 Oct capture, with prod's leads:

   | PO | Supplier | Expected |
   |---|---|---|
   | 00022886 | Tong Ming | Overdue 28 days (promised 15 Sep) |
   | 00023060 | Hanova | Promised 1 Nov |
   | 00023070 | Hanova | ~10 Dec on every line, WR16503G and WR16301.5S16 included (measured: ~3 Nov) |
   | 00023096 | TANDL | ~24 Nov (measured 117 d: ~9 Dec) |
   | 00023002 | Jiaxing | ~24 Nov on every line, TB12125S16 included (measured: ~4 Nov) |
   | 00023049 | Jiaxing | ~4 Dec (measured: ~14 Nov) |
   | 00023260 | Maptco | ~30 Oct |
   | 00023268 / 00023267 | Hobson | ~31 Oct / ~1 Nov |
   | 00023248 | Steel & Tube | est. 30 Sep: late by 13 days |
   | 00023309 | Specialised Washers | est. 12 Oct: late by 1 day |
   | 00022464 | Cash Purchase | est. 16 Apr: late by ~180 days |

   Any PO Allied have dated since reads its Promised Date instead. Update the 1.9.0 `RELEASES` `changes` and `check` (BP1675G's PO and its days to go, Tong Ming's days overdue, the "13 of 16" count, the Promised Date history) to match, and set `date`.
2. [ ] Push, wait for `release.version` = `1.9.0`, capture after, `diff --allow scripts/expected/1.9.0.json`: 0 not allowed. `cart.json` (apart from `generatedAt`) and `cart.csv` identical.
3. [ ] `stage-check schedule ../captures/1.9.0-after --base prod`: all ok, exactly the counted open POs listed (none of 00020462, 00019910, 00022808, 00020624), and each line of its table agrees with step 1's.
4. [ ] `positionParity` is 0.
5. [ ] In the browser (GET only): BN1665G's panel reads 00023070 ~10 Dec, "ETA missing — estimated: raised 12 Aug + 120 days (HANOVA INTERNATIONAL LTD lead set by Allied) · measured 83 days would give ~3 Nov"; Data & Sync lists the POs with no Promised Date; a past date shows "Open purchase orders today" with no dates.
6. [ ] Send the release note. After Allied enter their first Promised Dates: the next sync's capture shows those POs as `promised`, and the "N of M" count falls.

## Stage 11 deploy: Stock gaps, server only

Groundwork with additive fields only. No figure moves, nothing is written, nothing on screen changes, so no snapshot (§4.10). Rollback is a pure revert while 1.10 is the newest release; after that, a release setting `GAP_ENABLED = false` (with its version and RELEASES entry; `npm run build` passes with the switch off).

Before the evening, on the refreshed local copy (`npm run dev:local`):
- [ ] `stage-check capture` before (1.9 checkout) and after, `diff --allow scripts/expected/1.10.0.json`: 0 not allowed; `items.csv`, `cart.csv`, `suppliers.json`, `divergence.json` and the kit pages byte-identical, `cart.json` apart from `generatedAt`.
- [ ] `npx tsx scripts/stage-check.mjs gap <after> --base local`: all ok. Note the counts.
- [ ] Fail-safe, on a scratch copy of the tree (never the repo): make `projectItem` throw. `/items`, `/cart`, `/min-stock`, `/overview` and an item page answer 200 with every gap field null, `filter=gap` lists nothing, `runsOutBeforeNextDelivery` is null, and one "Stock gaps left blank for this build" line is logged per cache build.

On the evening (pre-flight and window as for any deploy):
1. [ ] **Latency before**, on 1.9: each of `/items`, `/cart` and `/min-stock` (the Minimum stock review behind `#/purchasing/minimums`) 3 times, 35 s apart so each call rebuilds the 30-second item cache. GET only, the key in the header:
   ```sh
   for p in "/items?pageSize=50" /cart /min-stock; do for k in 1 2 3; do
     curl -s -o /dev/null -H "x-dashboard-key: $DASHBOARD_KEY" -w "$p %{http_code} %{time_total}\n" "https://esperion-inventory-dashboard.onrender.com/api/insights$p"; sleep 35
   done; done
   ```
2. [ ] Capture before. **Re-derive the plan's expected-values table** (FEEDBACK-PLAN Stage 11) from the 1.9 capture: for each item there, free stock and weekly from `items.json`, its POs' expected dates from its item page (`incomingSchedule`, with that evening's Promised Dates and Allied's leads). The run-outs move every day and BN1665G's has probably passed.
3. [ ] Push, wait for `release.version` = `1.10.0`, capture after, `diff --allow scripts/expected/1.10.0.json`: 0 not allowed.
4. [ ] `npx tsx scripts/stage-check.mjs gap ../captures/1.10.0-after --base prod`: all ok, and its lines agree with step 2. Record the gap and gap_open counts and how many are not flagged below lead time (the 26 Aug prototype: 33 of 34; the 26 Aug copy under 1.10: 44 of 46) for the Part 5 row and the commit body.
5. [ ] **Latency after:** step 1 again on 1.10. Each endpoint's median within +20% of its median before. Over that, set `GAP_ENABLED = false` in a 1.10.1 (or revert, while 1.10 is newest) and look at the schedule query.
6. [ ] **Fail-safe live:** `/overview` `kpis.runsOutBeforeNextDelivery` is a number, not null, and the Render log for the deploy has no "Stock gaps left blank for this build" line. Either would mean the fail-safe fired: the screens are fine, but find out why before Stage 12.
7. [ ] `positionParity` is 0. Send the release note (What's new says only "Groundwork for stock gaps; nothing on screen changes.").

If rolled back: nothing to restore. A 1.9 page and server ignore the new fields; a `filter=gap` URL lists everything on 1.9.

## Stage 12 deploy: Stock gaps on screen

A UI release with additive fields. No figure moves and nothing is written, so no snapshot (§4.10). Rollback is a pure revert while 1.11 is the newest release (a `filter=gap` bookmark then lists the gap items on 1.10, which still knows the key); after that, a release hiding the column, tile and panel, or `GAP_ENABLED = false`, which every 1.11 screen already reads as "—".

Before the evening, on the refreshed local copy (`npm run dev:local`):
- [ ] `stage-check capture` before (1.10 checkout) and after, `diff --allow scripts/expected/1.11.0.json`: 0 not allowed, no existing value changed.
- [ ] `node scripts/stage-check.mjs screen <after> --before <before> --base local` and `npx tsx scripts/stage-check.mjs gap <after> --base local`: all ok.
- [ ] Browser at 1366 and 1440 px: Purchasing By item has no sideways scroll under any sort; the item page checks in the 1.11.0 `RELEASES` `check`, on the copy's figures.

On the evening (pre-flight and window as for any deploy):
1. [ ] Capture before. **Re-derive the expected gap table on prod** from it: `npx tsx scripts/stage-check.mjs gap ../captures/1.11.0-before --base prod` prints one line per item that runs out before its next delivery (start, end or "end unknown" with its reason, days, units short, the PO that ends it with its basis). Run-outs move every day, BN1665G's has probably passed, and Allied are entering Promised Dates, so the 13 Oct table in FEEDBACK-PLAN Stage 11 is out of date by then. Pick the two items the release note quotes from that list (one gap with a known end, one "end unknown"), and update the 1.11.0 `RELEASES` `changes` and `check` (their dates, units short, PO numbers, the Overview count) to match; set `date`.
2. [ ] Push, wait for `release.version` = `1.11.0`, capture after, `diff --allow scripts/expected/1.11.0.json`: 0 not allowed.
3. [ ] `node scripts/stage-check.mjs screen ../captures/1.11.0-after --before ../captures/1.11.0-before --base prod`: all ok (existing CSV columns and `cart.csv` byte-identical; the Purchasing sort = `filter=suggested&sort=gap`; the Overview tile = the filter's total). `npx tsx scripts/stage-check.mjs gap ../captures/1.11.0-after --base prod`: all ok, and its lines agree with step 1's.
4. [ ] `positionParity` is 0.
5. [ ] In the browser (GET only): the two items from step 1 read as the release note says (tile, outlook sentence, Inventory cell); the Overview tile opens Inventory on Runs out before next delivery with the same count; By item sorted by Gap before delivery opens on the soonest run-outs and has no sideways scroll on a 1366 px laptop; a past date shows "—" and "today only".
6. [ ] Send the release note.

If rolled back: nothing to restore. A 1.10 page ignores `gap.weeks` and `CartLine.gap`; `items.csv` loses its last eight columns.

## Stage 13 deploy: Lead time per supplier in Purchasing

A UI release with displayed lead times moving and one additive field. No quantity moves and nothing is written, so no snapshot (§4.10). Rollback is a pure revert while 1.12 is the newest release: a 1.11 server puts the item's lead back on every line, and a 1.12 tab on it reads `leadTimeSource` as absent and words everything as 1.11 did.

Before the evening, on the refreshed local copy (`npm run dev:local`):
- [ ] `stage-check capture` before (1.11 checkout) and after, `diff --allow scripts/expected/1.12.0.json`: 0 not allowed. The copy has no item leads, so only `release` and `leadTimeSource` appear; to see leads move, set one or two on an item page first (logged; clear them afterwards).
- [ ] `node scripts/stage-check.mjs leads <before> <after>`: all ok.

On the evening (pre-flight and window as for any deploy):
1. [ ] Capture before. **Produce the list for Allied:** `DASHBOARD_KEY=… node scripts/stage-check.mjs leads ../captures/1.12.0-before --base prod` prints one line per (item, supplier) whose lead 1.12 moves, old -> new, and where it shows (line = the Order list row, option = Compare / dropdown). It must end "ok" (every supplier named); keep the output for the release note. The 13 Oct capture had 52 such rows (mostly items carrying 107 days on the item, shown under Tong Ming, Anzor, Bremick, Milsons, Inox-Mare and Screw-Fast). Check the example the 1.12.0 `RELEASES` entry names (N24S16M under Tong Ming, 107 -> 45 set by Allied, from the 13 Oct capture) is still on the list with those figures; if not, replace it in `changes` and `check` with a row that is, and check the Why this quantity form `changes` quotes against that item's minimum on prod (a window minimum gives "Your minimum (…, from this item's own … days) sets the lead-time stock.", no minimum "Built on this item's own …-day lead time …"; `leads` does not print it). (The plan's example, N24S16M under Hobson 107 -> 30, is not one: Hobson is not on file for N24S16M in that capture.) Set `date`.
2. [ ] Push, wait for `release.version` = `1.12.0`, capture after, `diff --allow scripts/expected/1.12.0.json`: 0 not allowed.
3. [ ] `DASHBOARD_KEY=… node scripts/stage-check.mjs leads ../captures/1.12.0-before ../captures/1.12.0-after --base prod`: all ok (with `--base` the Tong Hwei-style rows are checked too), and its rows equal step 1's.
4. [ ] `positionParity` is 0.
5. [ ] In the browser (GET only: open Compare and the dropdown, choose nothing; N24S16M's Shandong line is a saved choice that a round trip would delete): the item named in the release note reads the new figure under that supplier in Compare and its usual supplier still reads the item's figure, "set on the item"; its drill-down's Why this quantity opens with the first sentence `changes` quotes (the second, the other supplier's lead, shows only on a line with that supplier, which this check does not create); By item fits a 1366 px laptop with no sideways scroll.
6. [ ] Send the release note with step 1's list.

If rolled back: nothing to restore.

## Stage 14 deploy: Suggested qty follows the chosen supplier

A numbers release (§4.5): announce the before/after list to Allied **before** the deploy, then one business day plus the 23:45 closing sync of soak. Nothing is written, so no snapshot. Rollback is a pure revert while 1.13 is the newest release: a 1.12 server serves the item's own suggestion on every line again, so the lines move back to their 1.12 quantities (typed quantities never moved), and a 1.13 tab on it reads no `suggestionFor` and words everything as 1.12.

Before the evening, on the refreshed local copy (`npm run dev:local`):
- [ ] `stage-check capture` before (1.12 checkout) and after, `diff --allow scripts/expected/1.13.0.json`: 0 not allowed. The copy has no picks, so only additions appear; to see quantities move, pick a supplier on two or three rows (one with a window minimum, one without), type a qty on another and pick it too (logged; Undo or Use preferred afterwards, or restore the copy).
- [ ] `node scripts/stage-check.mjs qty <before> <after>`: all ok.

On the evening, or the day before (pre-flight and window as for any deploy):
1. [ ] Capture prod before (a 1.12 capture: `qty` reads the lead each line shows, which is 1.12's per-supplier lead). **Produce the list for Allied:** `node scripts/stage-check.mjs qty ../captures/1.13.0-before` prints one line per Order list line whose suggested or order qty moves, old -> new, with the minimum basis, the usual and the chosen lead, and the est. cost. Lines marked "Chosen at its suggestion" are read as showing the suggestion; if Allied say one was typed, its qty will stay (the after check names it). **Send the list to Allied before deploying** and wait for their OK (Q6: an explicit OK of 1.2 is also needed before this release). The f2148b2 prod capture (14 Oct NZ) had five lines under a supplier other than the usual one (FG150P, FG100P and FG250P's split part with Specialised Washers, TB12135S16 and item 11 with Jiaxing), but it predates 1.12's per-supplier leads, so it can't stand in for the list. Re-derive the `RELEASES` example (N24S16M → Hobson, from the local copy) from a line on the list, with its Why this quantity form, and set `date`.
2. [ ] Push, wait for `release.version` = `1.13.0`, capture after, `diff --allow scripts/expected/1.13.0.json`: 0 not allowed.
3. [ ] `node scripts/stage-check.mjs qty ../captures/1.13.0-before ../captures/1.13.0-after`: all ok, and its rows equal step 1's (a line Allied changed in between shows up here: re-run step 1 on a fresh capture if so).
4. [ ] `positionParity` is 0.
5. [ ] In the browser (GET only: open Compare, choose nothing): a line from the list reads its new Suggested and Order qty on By item and By supplier, and its Why this quantity opens "Rebuilt on …"; Compare shows each supplier's own "for N suggested" under Est cost, the usual supplier's equal to the item's suggestion on Inventory; the Order list total equals the header the after capture shows; By item fits a 1366 px laptop with no sideways scroll.
6. [ ] Send the release note.

If rolled back: nothing to restore; tell Allied the listed lines are back at their 1.12 quantities.

## Stage 15 deploy: Inventory small fixes

A UI release whose golden diff is the release block and the new `filter` echo on `/items` (items.json `filter`: absent -> "all"), but Allied see two things read differently (the Cover < 2 weeks list, the Used in cell), so the list goes to them before the deploy (§4.5). Nothing is written, so no snapshot. Rollback is a pure revert while 1.14 is the newest release: the tile opens `low_cover` again and Used in shows direct parents.

Before the evening, on the refreshed local copy (`npm run dev:local`):
- [ ] `stage-check capture` before (1.13 checkout) and after, `diff --allow scripts/expected/1.14.0.json`: 0 not allowed (release, items.json `filter`).

On the evening, or the day before (pre-flight and window as for any deploy):
1. [ ] Capture prod before. **Produce the list for Allied** from it (reads the capture only):
   ```sh
   node -e 'const d=require("../captures/1.14.0-before/items.json"),o=require("../captures/1.14.0-before/overview.json");const lt=(w)=>d.items.filter(i=>i.coverWeeks!=null&&i.coverWeeks<w).length;console.log("Cover < 2 weeks tile",o.kpis.coverUnder2w,"| list it opened (under 4 weeks)",lt(4),"| list from 1.14",lt(2));for(const i of d.items)if((i.parentCountDeep??0)>(i.parentCount??0))console.log(i.number,"Used in",i.parentCount,"->",i.parentCountDeep)'
   ```
   The tile and "list from 1.14" must be equal. Re-derive the `RELEASES` examples (BN1665G 2 -> 13, the 303 / 322) from it and set `date`. Send the list.
2. [ ] Push, wait for `release.version` = `1.14.0`, capture after, `diff --allow scripts/expected/1.14.0.json`: 0 not allowed.
3. [ ] `positionParity` is 0.
4. [ ] In the browser (GET only): on Inventory, search for something, pick a region and a sort; go to the Overview and click each tile in turn. Each opens with an empty search, All regions, All product types / finishes / tags, the tile's filter and Risk order, and the count above the list equals the tile (Excess stock value: the item count, not the dollars). Sort Inventory by Used in: the numbers run highest first, and BN1665G's tooltip reads "2 directly, 11 more via sub-assemblies" (or the prod figures). Export this list after changing the filter and sort: the CSV has the list's rows, in its order.
5. [ ] Send the release note.

If rolled back: nothing to restore.

## Snapshots and data changes

- **Snapshots** are mandatory before Stages 5, 6 and 8:
  ```sh
  node scripts/supplier-rollback.mjs snapshot pre_s<n>_<yyyymmdd> --apply --confirm <current_database()>
  node scripts/supplier-rollback.mjs status
  ```
  Never add tables to `BACKUP_TABLES` / `TABLES`: that marks every existing backup as broken.
- **Lead-time and minimum tables:** take `bak_<yyyymmdd>_*` copies (above) before sending lead-time questions and before any bulk change.
- **An Allied answer that is data, not code** (e.g. Hanova 120 → 90 days) is not a release:
  1. Before: `capture` and `bak_` copies.
  2. Make the edit in the dashboard. Edits are logged from 1.1.
  3. A supplier-lead edit leaves window minimums as drift until "Recalculate" on the Minimum stock review, which is also logged. Run it, or tell Allied why not.
  4. After: `capture`, `diff`, a "data change" row in Part 5, and a note to Allied listing the items whose suggestion moved.
- **Production verification is GET only.** The first real writes are Allied's.

## Rules every release keeps

- **Database:**
  - Additive DDL only.
  - No new views or functions; share SQL as TypeScript fragments.
  - `item_position_at` may change its body only, never its arguments or `RETURNS TABLE`.
  - Never change the columns of `item_position`, `item_position_at`, `stock_movements` or `effective_bom`.
  - Nothing may depend on `supplier_lead_time` or `kit_*`.
  - Never rewrite closed `platform_daily_position` rows.
- **API and open tabs:**
  - Additive fields and parameters only. Validation accepts everything an older UI sends, except the 1.0 version check.
  - New JS reads new fields with `?? null` and shows "—".
  - Sort, filter and route keys are only ever added.
  - Frontend code never uses `qty_on_hand`, `qty_committed` or `qty_available` (the build checks).
- **Numbers versus UI:**
  - A number-moving release adds no screens beyond the line that explains the change, and is announced with a before/after table before deploy.
  - A UI release carries golden-diff proof that no existing figure moved.
  - Every number is computed once, on the server.
- **Labels and dates.** One label per concept on every tab (§4.6 of the plan). Schedules, expected dates and gaps are today-only.
- **CSV.** Append columns only; never rename, reorder or add leading rows. `cart.csv` stays unchanged unless Allied ask.
- **Local safety:**
  - Use only `npm run dev:local` (port 3111, refuses a non-localhost database) with `SYNC_INTERVAL_HOURS=0`.
  - Never use the `myob-dashboard` launch config, and never press "Sync now" locally.
  - Every refreshed copy gets `DELETE FROM connections` before its first start.
  - `npm test` always runs with `DATABASE_URL=`. It is built into the script; keep it there.
- **Telling Allied.** Every release note quotes the version and its stage, in three parts: what you'll see, numbers that changed (with an example item), and how to check it. It is the same text as the `RELEASES` entry.
