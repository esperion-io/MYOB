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
