# Allied feedback: staged rollout plan (final)

**Basis.**
- **Code:** the repo at HEAD `f2148b2`. `main` matches `origin/main`.
- **Local figures:** `allied_dev`, a copy taken on 26 Aug. I only ran read-only SELECTs.
- **Live figures:** the read-only production capture of 13 Oct NZ (sync run 268), saved in `scratchpad/eta/`.
- **Baselines:** every live figure drifts. Each stage takes a fresh baseline just before it deploys and checks against that, not against this document.

This version includes the three critic reviews. The ones I rejected are listed at the end.

**What changed from the merged draft:**
- **Version numbers follow ship order**, not stage numbers.
  - The reload banner compares the server's version with the version built into the tab's own JS.
  - The server refuses writes from a stale tab (409).
- **Rollback is strictly newest-first.** To remove an older stage, ship a new release that switches it off. Never revert an old commit.
- **Purchasing (#3, #4) ships before ETA and gaps (#2).** Gaps ship last, so their definition can change without touching anything else.
- **ETA is worked out per PO document:** the promised date, otherwise the PO date plus that supplier's lead time. A lead time set on an item never moves an ETA.
- **Gaps start from the run-out date.** An item that runs out while its PO is overdue, late or undated still counts as a gap, shown as "end unknown".
- **Q11 and Q21 no longer block anything.** Stage 8 keeps today's behaviour for a pick: it is kept and flagged, with Use preferred / Keep. Auto-acknowledging the pick would have broken the f2148b2 rule.
- **The applied minimum is built from the effective supplier's lead time.** The supplier-change wording and the quantity question (now Q5) now say so.
- **Stage 1 logs every edit to lead times and minimums**, because our questions invite Allied to change them.
- **Two stages are split:**
  - By item becomes groundwork (Stage 5, nothing visible) plus the view itself (Stage 6).
  - The old Stage 9 becomes a lead-time display stage (13, gated on Q2b) and a quantity stage (14, gated on Q5).
- **The daily PO record is its own optional release.** It is keyed per (PO, item), because one PO can carry the same item on two lines.
- **The Overview region table is now included:** it is the fifth place that reads open POs.
- **The question list is shorter:** 24 questions become 6 decisions, one MYOB tidy-up message and a list of stated defaults.

## Plan at a glance

| Stage | Planned version* | Answers | Numbers Allied see move? | Writes | Snapshot first | Rollback |
|---|---|---|---|---|---|---|
| 0 Release plumbing | 1.0 | "know if we need to roll back or change a certain version" | No | Version and commit stamped on change-log rows | No | Revert. The first deploy needs one manual reload |
| 1 Safety checks + rollback drill | 1.1 | Prerequisite for 2; makes lead-time answers traceable | No (new Data & Sync rows, sync-chip warning) | Change-log rows for lead-time and minimum edits | No | Revert |
| 2 On order matches MYOB | 1.2 | Prerequisite for #1–#3 | **Yes.** On order and Available on 6 items; suggestions on SPW12G and BN16110G; open-PO counts on Suppliers and Overview | No decision data | No | Revert. Days closed in the meantime keep the correct figure |
| 3 Cover excl. / incl. on order | 1.3 | #1 | No (new figure, relabels) | No | No | Revert |
| 4 Order list total for split items | 1.4 | Prerequisite for 6 | Header total and kit count, only where splits or double orders exist | No | No | Revert |
| 5 Purchasing groundwork | 1.5 | Prerequisite for 6 | No | Existing endpoints only | **Yes** | Revert |
| 6 Purchasing by item (default view) | 1.6 | #3 | No | Existing endpoints only | **Yes** | Revert; rows stay valid |
| 7 Purchasing sorting | 1.7 | #4 | No | No | No | Revert |
| 8 Choose the supplier on the row | 1.8 | #3 "select supplier" | No (only Allied's own picks) | Existing states; Undo keeps a typed qty | **Yes** | Revert; rows stay valid |
| 9 Incoming POs with expected dates | 1.9 | #2 part 1 | No | No | No | Revert |
| 10 Daily PO record (optional) | 1.10 | Records promised-date changes | No | System table `platform_po_daily` | No | Revert; the table stays and stops growing |
| 11 Stock gaps: server | 1.11 | #2 part 2 (groundwork) | No | No | No | Revert, or the switch-off constant |
| 12 Stock gaps: on screen | 1.12 | #2 part 2 | No (new figures) | No | No | Revert |
| 13 *(gated, Q2b)* Lead time per supplier in Purchasing | next free | Consistency | The lead time shown on non-default supplier options | No | No | Revert |
| 14 *(gated, Q5)* Suggested qty follows the chosen supplier | next free | Follow-on to #3 | **Yes.** Picked and split lines with no typed qty | No | No | Revert |
| 15 Inventory small fixes | next free (any evening after 3) | Defects | Overview "Cover < 2 weeks" list; "Used in" display | No | No | Revert |
| 16 Clean-up (optional, code only) | next free | None | Inventory tie order only | No | No | Revert |

\*A version number is assigned when the release ships (§4.1). This column assumes no follow-up release lands in between.

---

## 1. What I verified that decides feasibility

1. **Rule (b) plus a line clamp reproduces MYOB.**
   - Local on order goes from 1,052,943 to **858,796**, against MYOB's **858,820**.
   - Only AFLSA390 and AFLSA490 differ, by 12 each, on a PO older than the 1 Jul 2024 sync floor.
   - 1,163 of the 1,275 `ConvertedToBill` POs share their number with their bill. No number has two bills, and no bill is dated before its PO.
   - No open PO with total ≥ 0 has a negative or over-received line, so the clamp changes nothing on today's data.
   - The only Open POs with a same-number bill are the reversal artefacts 00019910, 00020624 (±) and 00022808 (±).
   - 00021049 is two POs ($211.83 and $96.95) billed together as 00021110 ($308.83). It is not a backorder.
2. **00019910 is billed in full but shows 3,420 units still to receive** (BN16110G 7,697 of 10,982 received; BP1690G 2,290 of 2,425). Live phantom on order totals **194,147 of 1,077,370**.
3. **Production `/items` has no MYOB on-order field.** The comparison therefore has to ship before the fix (Stage 1).
4. **Five places read open POs, not four:**
   - `item_position_at` (`schema.ts:587-595`);
   - `ownedPositions` (`ledger.ts:690-698`);
   - the item page PO rows (`queries.ts:1655-1662`);
   - the Suppliers open-PO lateral (`queries.ts:2014-2019`);
   - **the Overview region table** (`queries.ts:1319-1327`, rendered at `dashboard.js:1113-1114`).
5. **Live suggestion maths checks out** (`queries.ts:779-782`):
   - SPW12G goes from 3,004 to **3,564**.
   - BN16110G goes from none to **1,305**.
   - BP1675G stays at none.
6. **BN1665G.**
   - Hanova's lead is 120 days (set by Allied), so `cover_below_lead_time` fires: 14.0w against 17.1w.
   - PO 00023070 is estimated for 10 Dec.
   - Free stock (323, at 23.8 a day) runs out about 27 Oct: a **44-day gap, about 1,056 units short**.
   - With the measured 83 days the PO lands 3 Nov: a 7-day gap, about 177 short.
7. **The applied minimum depends on the supplier's lead time.**
   - A window minimum is monthly burn × lead days ÷ 30.44 (`minStock.ts:41-44`), using the effective supplier's lead (item, then supplier, then measured). BN1665G: 702.67 × 120 ÷ 30.44 = 2,771.
   - Minimums are either `window` or `manual` (`minStock.ts:46`). All 87 applied minimums in the top-200 capture are window-based.
   - An item lead-time edit re-derives window minimums (`minStock.ts:535-551`).
   - A supplier lead-time edit does not (`queries.ts:2384-2401` only clears the cache), so those minimums show as drift until someone presses Recalculate.
8. **Lead-time and minimum edits are neither logged nor backed up.**
   - `logChange` only knows the entities `item_supplier` and `cart` (`changeLog.ts:103`).
   - `supplier-rollback.mjs` `undo` refuses any other entity (`:608`), and `diff` filters by entity (`:301-313`). New entities are therefore safe to add.
9. **Item-level leads would split one PO into several dates.**
   - WR16503G and WR16301.5S16 carry an item lead of 107 days under Hanova (120); TB12125S16 carries 107 under Jiaxing (120).
   - A per-line rule would give 00023070 two arrival dates, 27 Nov and 10 Dec.
   - The cart applies an item lead under every supplier on purpose (`cart.ts:568-576`).
10. **One PO can carry the same item twice.** 00023096 has BN16525LTG on line 18 (1,500) and line 19 (1,000). The 26 Aug copy has 281 open document–item pairs, 149 of them counted.
11. **Code facts:**
    - `coverIncludingIncoming` is computed (`queries.ts:684-685`) but not returned (`:933`).
    - The sort key `available` means free stock (`:1066`).
    - The filter `switch` has no `default`; an unknown sort falls back to risk.
    - Only Inventory reads the query string in `route()` (`dashboard.js:676-680`).
    - An unknown Purchasing tab renders the Order list (`:4101-4109`).
    - `SORT_DEFAULT_DIR` is not exported (`queries.ts:1077`).
12. **Purchasing UI and the cart payload:**
    - The UI is built around the global `cartData`, re-fetched at `dashboard.js:4107, 4216, 4228, 4312, 4328, 4582, 4616, 5005`. `toggleExpandRow` reads `invItems` (`:1402`).
    - `totalItems = needing.length` (`cart.ts:753`). That is the items with lines plus `removedItems` (taken off or struck, `cart.ts:591-601`).
    - The empty-cart early return (`cart.ts:510-523`) carries no window fields.
    - `historicalNotice` also reads `snapshotsFrom` (`dashboard.js:953`).
13. **Use preferred and Keep need a preferred supplier.** Both throw when the item has none (`cart.ts:1061-1068`, `:1094-1100`).
14. **Undo drops a typed qty.** `select` carries the typed qty onto the `selected` row (`cart.ts:944-955`), and `undoCartDecision` deletes every row for the item (`cart.ts:1249-1254`).
15. **Validation gaps.** `/cart/select` doesn't check the supplier, and `/cart/split` checks only that there are at least 2 parts (`insights.ts:779-808`). The drawer only ever sends options.
16. **The change log can carry a version.** `platform_change_log.detail` is JSONB, and the rollback script reads only `items`, `inserted`, `scope` and `savedAs`.
17. **Boot and deploy mechanics:**
    - DDL runs one statement at a time, with no transaction, before `listen` (`schema.ts:1101-1110`, `index.ts:23-26`). A new function body is live as soon as a new instance boots, even if that deploy later fails.
    - A boot catch-up sync fires when the last success is at least 6 hours old (`schedule.ts:101-105`, `index.ts:101-109`), separately in each instance.
18. **Local safety:**
    - `SYNC_INTERVAL_HOURS=0` turns off both the scheduler and the boot catch-up.
    - The local `connections` table has 0 rows.
    - **`.env` holds the production `DATABASE_URL`, and dotenv loads it for every `tsx` run, including `npm test`.** An empty `DATABASE_URL=` takes precedence over dotenv and makes `getPool` throw (`config.ts:1,24`, `db.ts:13-18`).
19. **Tests can run in the build.** The pool is created lazily, and `tsx` and `typescript` are already installed for `tsc`.
20. **`item_position_at` can safely reference the bills table.** It is `LANGUAGE sql STABLE` with a fixed `RETURNS TABLE`, and the bills table is created first (`schema.ts:192` before `:521`).
21. **Closed days keep the phantom.** A closed day's stored `on_order` overrides the reconstruction.
22. **Measured supplier medians** (local `supplier_lead_time`): Hanova 83, Jiaxing 100, TANDL 117, Tong Ming 42, Hobson 24, Maptco 30, Steel & Tube 2, Specialised Washers 4, Cash Purchase 38. Every supplier with an open PO has either an Allied or a measured lead, so no live PO would show "No date".
23. **Where an ETA could be written.**
    - The synced PO header columns are uid, number, date, status, supplier, promised_date, total and last_modified (`engine.ts:476-486`). Comment, ShippingMethod and JournalMemo are not synced.
    - Of all synced line descriptions, 4 mention ETA, ETD, arrival or shipping, and none of those is on a real open PO.

## 2. Design decisions

| # | Question | Choice | Why |
|---|---|---|---|
| D1 | On-order rule | **(b) + line clamp + bill dated on or after the PO** | Reproduces MYOB to 24 units. A bill-aware per-item subtraction would misfire on a backorder just as (b) would. The Stage 1 check and the end-of-sync warning guard it. |
| D2 | When to deploy the MYOB comparison | **Stage 1, before the fix**, with a "Proposed rule" column and a list of documents | Production has no MYOB on-order field. This previews Stage 2 exactly on production. |
| D3 | Daily PO history | **Its own optional release (Stage 10)**, one row per (PO, item) | Promised dates are overwritten in MYOB and can't be recovered later. Keeping it apart keeps it out of the ETA stage's acceptance. |
| D4 | By-item data | **Regroup `/cart` in the browser** plus additive `CartLine` fields | The drawer, pick conflicts and every write path already read `cartData`. The server stays the only source of numbers. |
| D5 | By item as the default | **Yes, in Stage 6**, after the groundwork in Stage 5 | Allied asked for it, and By supplier stays one click away. |
| D6 | Small fixes | **Only the split total and kit count come before Purchasing (Stage 4).** The rest move to Stage 15 | Keeps Allied's requests off a path of defect fixes they didn't raise. |
| D7 | Quantity and lead time for a picked supplier | **Lead-time display gated on Q2b (Stage 13). Quantity gated on Q5 (Stage 14)** | The two are independent. A no to one must not freeze the other. |
| D8 | A fresh pick | **Flagged as today (Use preferred / Keep)** | This is the established f2148b2 rule. Auto-Keep only if Allied ask (Q4), as a follow-up. |
| D9 | Supplier dropdown | **Suppliers on file only**, plus "Add a supplier on the item page" | Leaves the inputs to `planItemLines` unchanged. |
| D10 | Overdue or late POs in the projection | **Left off the timeline. The item still counts as a gap, with "end unknown"** | Inventing an arrival date misleads, and dropping the item hides the worst cases. |
| D11 | Gap horizon | **26 weeks** | The projection runs to the later of the last dated delivery and the run-out date, capped there. |
| D12 | Does a lead-time answer block anything? | **No.** Every estimate and gap shows its basis and the measured alternative | Stage 9 already shows the same estimates; the gap is arithmetic on them. |
| D13 | Stale tabs | **A banner from the 60 s poll, plus a 409 from the server for any write whose `x-ui-version` differs** | The poll alone leaves up to 60 s of stale writes. |
| D14 | Snapshots | **Mandatory before 5, 6 and 8.** Plain copies of the lead-time and minimum tables before any lead-time question goes out | Those three stages touch decision-writing paths. The lead and minimum tables have no backup. |
| D15 | Deploy window | **18:00–23:15 NZDT, only after a successful 17:45 sync** | Otherwise a boot starts a catch-up sync. |
| D16 | Version scheme | **Ship order: 1.N.0.** 1.N.1 only for a fix to the newest release before anything else ships. `RELEASES` records which stage each version belongs to | The version shown never goes backwards, so "which version is live" is always clear. |
| D17 | Purchasing sorting helper | **Purchasing-only in Stage 7.** Inventory moves onto it in Stage 16 | Purchasing sorting can then never touch Inventory. |
| D18 | Purchasing default sort | **Risk, highest first** | Inventory's default. |
| D19 | Below-minimum items at qty 0 | **Shown**, labelled "covered by on order" | Both views list the same items. |
| D20 | Order sheet CSV | **Unchanged** | It feeds Allied's per-supplier PO workflow. |
| D21 | A `free` alias for the `available` key | **No.** Comment only | Two names for one key is a trap of its own. |
| D22 | Where the changelog lives | **`RELEASES` in `dashboard.js`** | It ships and reverts with the JS. |
| D23 | Track order | **Purchasing (5–8) before ETA and gaps (9–12)** | Purchasing is two of the four requests. Q1 and Q2 answers, and any promised dates Allied enter, have time to arrive. Gaps last means the definition most likely to change is the easiest to revert. The order can still be swapped, because versions follow ship order; the cross-links (drill-down incoming list, gap column) then move to whichever stage ships second. |
| D24 | Unit of an ETA | **The PO document.** Item leads never move an ETA | One document arrives once. Item leads stay a planning input. |
| D25 | Gap rule | **Run-out first.** Status never depends on whether an ETA exists | See Stage 11. |
| D26 | Removing an older stage | **A new release that switches it off**, never a revert of an old commit | `dashboard.js` has no type check, so out-of-order reverts fail silently in the browser. |

---

## 3. Stages

The standard rollback steps R1–R5 are in §4.9. Each stage lists only what differs from them.

### Stage 0: Release plumbing (1.0)

**Answers:** the developer's *"stage by stage so we can easily know if we need to roll back or change a certain version."*

**Why each piece is needed:**
- Nothing identifies the running code.
- A tab left open keeps its old JS through a deploy or rollback.
- `npm test` isn't in the build, there is no CI, and a local `npm test` reads the production `.env`.
- The boot backup ran once and has never been checked with `status`.
- Nothing stops a stale tab from writing.

**What Allied see:**
- **Sidebar footer** (`dashboard.html:34-42`): "Version 1.0 · a1b2c3d · What's new".
- **Help drawer** (`renderHelp`, `dashboard.js:533`): a "What's new" section at the top. Each version shows:
  - its date and which stage it belongs to;
  - what changed;
  - "Numbers that changed: …", with an example item;
  - how to check it.

  A withdrawn version stays listed, marked "withdrawn in 1.N".
- **Banner**, raised when the server's version differs from this tab's `UI_VERSION`. It never reloads the page by itself:
  - **server newer**, or a version this tab doesn't know: "The dashboard was updated to version 1.2. Reload to continue; changes can't be saved until you do. [Reload]";
  - **server older** (listed in this tab's `RELEASES`): "The dashboard was changed back to version 1.1. Reload.";
  - **server reports no `release`** after one was seen: "The dashboard was changed back to an earlier version. Reload.";
  - **same version, different commit** from the first poll (should not happen, since every push bumps the version): "updated".

**Backend:**
- `src/release.ts` provides:
  - `version`, from `package.json`;
  - `commit`, from `RENDER_GIT_COMMIT.slice(0,7)`, or `"local"`;
  - `bootedAt`.
- `/api/insights/sync/status` (`insights.ts:163`) gains `release`. `/api/health` is unchanged.
- **Write guard**, a middleware on non-GET `/api/insights/*`:
  - If `x-ui-version` is present and differs from `release.version`, it returns **409** with `{error:"The dashboard was updated to version X. Reload the page to continue."}`.
  - Requests without the header (tabs older than 1.0) pass.
  - Old JS already shows `data.error` (`dashboard.js:509-510`).
- `logChange` (`changeLog.ts:100-125`) merges `{release, commit}` into `detail` when `detail` is null or an object.

**Frontend:**
- `UI_VERSION` and `RELEASES` (entries `{version, date, stage, changes, numbers, check, withdrawn?}`).
- `pollSyncChip` (`:587`, every 60 s, `:3551`) compares `release.version` with `UI_VERSION` on every poll, and `release.commit` with the first commit it saw.
- `fetchJson` (`:498`) sends `x-ui-version` on every non-GET request, and refuses non-GET requests while the banner is up.

**Build and tooling:**
- `package.json` goes from `0.1.0` to `1.0.0`.
- `"test": "DATABASE_URL= tsx --test test/*.test.ts"`: neither the Render build nor a local run can then reach a database.
- `"build": "node scripts/check-ledger-boundary.mjs && node scripts/check-release.mjs && npm test && tsc"`.
- **`check-release.mjs`** checks that:
  - `package.json.version === UI_VERSION === RELEASES[0].version`;
  - `RELEASES` versions strictly decrease;
  - every entry has a stage label.

  Its `--pre-push` mode also checks that the version is greater than the newest git tag (Render's clone may have no tags).
- **`scripts/stage-check.mjs`** sends GET requests only. It reads the key from the environment and never prints it; `--base` takes local or prod.
  - **`capture <dir>`** saves:
    - `/items` (all pages), `/overview`, `/cart`, `cart.csv`, `items.csv`;
    - `/suppliers`, `/divergence`, `/kits/availability`, `/sync/status`;
    - `/items/:uid` for a watch-list: BN1665G, SPW12G, BP1675G, WSBT450G, WQ16806G, BN16110G, BP1690G, N16G8, N24S16M, TB12125S16, KITST1240S, KITST1230S, WR16503G, WR16301.5S16, plus one split item if any.
  - **`diff <before> <after> --allow scripts/expected/<version>.json`** fails on any change not allowlisted. It matches records by identity, not position:
    - items by `uid`; cart groups by `supplierUid`; lines by `itemUid`+`supplierUid`;
    - decisions, conflicts and removed items by `itemUid`; CSV rows by item + supplier;
    - it ignores `generatedAt`, `bootedAt` and sync timestamps.
  - Each later stage adds its own identity command.
- `RELEASING.md` holds §4.
- `FIX-PLAN.md` gains "Part 5 — Rollout" (version, stage, commit, deploy time UTC, snapshot, status), backfilled for 15 Sep, 19 Sep and 12 Oct.

**Ops** (done by Anthony; production isn't reachable from here):
1. From the Render shell, run `DATABASE_URL=<prod> node scripts/supplier-rollback.mjs status`. Record that `pre_preferred_fix` exists and its checksums hold.
2. **Local setup:**
   - Set `SYNC_INTERVAL_HOURS=0` in `.env.local`.
   - Rename or remove the `myob-dashboard` entry in `/Users/anthonyxiao/Dev/allied/.claude/launch.json`.
   - Before Stage 2, refresh `allied_dev` from a prod dump (current POs, cart decisions, the f2148b2 tables). Run `DELETE FROM connections` before the first `dev:local`.
3. **Before any lead-time question goes to Allied** (Q2, tidy-up list):
   - Run `CREATE TABLE bak_<yyyymmdd>_supplier_meta AS TABLE platform_supplier_meta`, and the same for `platform_item_lead_time` and `platform_min_stock`. These sit outside the backup registry, so `supplier-rollback status` is unaffected.
   - Take a `stage-check capture`.

**Does NOT change:** any number, page or endpoint, apart from the footer, help drawer, banner and the 409 for stale tabs. There is **no** per-release boot backup, because `takeBootBackup` exits the process on failure (`schema.ts:1189-1199`).

**Numbers:** none. **Writes:** `detail.release`/`commit` on future log rows. **Snapshot:** no.

**Rollback:** pure revert. The very first 1.0 deploy needs one manual reload, because old JS has no banner logic.

**Accept when:**
- On prod, `release.commit` equals `git rev-parse --short HEAD`, and the footer shows 1.0.
- A mismatched `UI_VERSION`, a wrongly ordered `RELEASES` or a failing test makes `npm run build` fail.
- A test that calls `getPool` fails under `npm test`, even with the local `.env` present.
- Two captures taken a minute apart diff to 0.
- Locally, bump the version in a scratch checkout and restart `dev:local`. An open tab shows the banner within 60 s, and a qty edit from it gets 409 and writes nothing. A POST without the header behaves as before.

**Depends on:** nothing. **Size:** M. **Allied decisions:** Q6, non-blocking.

---

### Stage 1: Safety checks and the rollback drill (1.1)

**Answers:** none directly. It does three things:
- previews Stage 2 on production before any number moves;
- makes lead-time and minimum edits traceable before we ask Allied about lead times;
- rehearses a real rollback.

**What Allied see (Data & Sync):**
- **"On order vs MYOB":** items where our On order differs from MYOB's. Columns: Item | Ours | MYOB | Proposed rule.
  - Expected: the 6 phantom items (Proposed = MYOB), plus AFLSA390/490 marked "known: PO older than the sync floor".
- **"Open purchase orders":** each Open document, with Counted yes/no and the reason (reversal of a billed PO · negative total · counted).
- **Sync chip:** turns amber with "On order below MYOB on N items — check again after the next sync". This happens when, at the end of a sync, any item other than AFLSA390/490 reads *below* MYOB, meaning incoming stock is hidden. One false reading is possible if a PO is received mid-sync.
- Minimum stock review and Suppliers look unchanged, but every edit is now recorded.

**Backend:**
- `src/sync/openPo.ts` holds the shared fragments, used in this stage only by the check:
  ```sql
  -- OPEN_PO_DOC(o): the document counts as stock on order
  UPPER(COALESCE(o.status,'')) = 'OPEN' AND COALESCE(o.total,0) >= 0
  AND NOT EXISTS (SELECT 1 FROM myob_purchase_bills b
                  WHERE b.number = o.number AND b.supplier_uid = o.supplier_uid
                    AND b.date::date >= o.date::date)
  -- OUTSTANDING(l): only lines with l.qty > 0
  l.qty - LEAST(GREATEST(COALESCE(l.received_qty,0),0), l.qty)
  ```
- `divergenceReport` (`ledger.ts:1037`) gains three additive fields. It reads `myob_items.qty_on_order` inside `ledger.ts`, which the boundary guard allows.
  - `onOrder {rows:[{number,name,ours,myob,proposed}], diverging}`;
  - `openDocs [{number, supplier, date, total, counted, reason}]`;
  - `positionParity {mismatches, sample}`: `ownedPositions(today)` against `item_position` on on hand, committed and on order.
- `engine.ts`, after `snapshotPositions` and in its own try/catch: `stats.on_order_below_myob = [item numbers]`. It excludes `KNOWN_PRE_FLOOR = ['AFLSA390','AFLSA490']`, a commented constant that the tidy-up answer decides. The chip reads the last run's stats from `/sync/status`.
- **Edit log.** The `logChange` entity type gains `supplier_meta`, `item_lead_time` and `min_stock`.
  - Each write and its before/after row go in one `inTransaction`.
  - The covered writes are:
    - supplier meta upsert (`queries.ts:2384`);
    - `setItemLeadTime`, `clearItemLeadTime`, `applyLeadTimeToView`, including every minimum that `refreshWindowMinimums` rewrites (`minStock.ts:535-604`);
    - `applyWindowMinimum`, `setManualMinimum`, `clearMinimum`, `applyWindowToView`, `recalculateWindowMinimums` (`minStock.ts:350-470`).
  - `supplier-rollback.mjs log` shows these rows. `undo` refuses them by design (`:608`).

**Ops: rollback drill.** This replaces the wording-only drill in the draft.
1. Deploy 1.1.
2. Render → Rollback to 1.0.
3. Confirm an open 1.1 tab shows "changed back to version 1.0" within 60 s, and that a qty edit from it gets 409 from the 1.0 server.
4. **Record whether Render turned auto-deploy off.**
5. Redeploy the 1.1 commit, and turn auto-deploy back on if needed. Confirm a 1.0 tab shows "updated to version 1.1".

**Does NOT change:** any figure on Inventory, Purchasing or Overview, or how any edit behaves (same validation, same result; only a log row is added).

**Numbers:** none. **Writes:** change-log rows for lead-time and minimum edits. **Snapshot:** no.

**Rollback:** pure revert. Edits made in the meantime keep their log rows, and old code ignores them.

**Accept when:**
- **On order vs MYOB on prod** lists exactly WSBT450G, WQ16806G, BP1675G, SPW12G, BN16110G and BP1690G (Proposed = MYOB), plus AFLSA390/490. Anything else stops Stage 2 until it is explained.
- **Open documents:** 12 counted (00022464, 00022886, 00023002, 00023049, 00023060, 00023070, 00023096, 00023248, 00023260, 00023267, 00023268, 00023309) and 6 not counted (00019910, 00020462, 00022808 ×2, 00020624 ×2). Re-derive on ship day.
- `positionParity` mismatches are 0 on prod and locally, and the chip is green.
- **Locally:** a lead-time edit, a window apply and a Recalculate each write log rows with before/after and `detail.release = 1.1.0`. `undo <id>` on one of them refuses.
- **Drill:** both banners appear within 60 s, the 409 fires, and the auto-deploy finding is written into `RELEASING.md`.

**Depends on:** 0. **Size:** M. **Allied decisions:** none.

---

### Stage 2: On order matches MYOB (1.2)

**Answers:** none directly. It is the prerequisite for #1 (*"cover that includes on order"*), #2 (*"gaps … incoming stock"*) and #3's "incoming / cover including incoming". Without it, WSBT450G would show 3,340 weeks of cover including on order.

**What Allied see (live, 13 Oct):**

| Item | On order | Available | Suggestion |
|---|---|---|---|
| WSBT450G | 112,897 → 0 | 115,237 → 2,340 | none |
| WQ16806G | 53,670 → 0 | 56,063 → 2,393 | none |
| BP1675G | 34,600 → 11,000 | 40,440 → 16,840 | none (its minimum of 6,648 is already covered) |
| SPW12G | 15,560 → 15,000 | 17,495 → 16,935 | **3,004 → 3,564** |
| BN16110G | 5,285 → 2,000 | 7,980 → 4,695 | **none → 1,305** (about NZ$673; already on the Order list at 0 as below minimum) |
| BP1690G | 3,135 → 3,000 | 3,775 → 3,640 | none |

- **Totals:** on order goes from **1,077,370 to 883,223**, and items with stock on order from 92 to 90.
- **Overview:** "Suggested orders" rises by 1. The region table's open-PO count falls by **6** (4 Hanova documents, 2 Steelgal); the value is unchanged.
- **Suppliers page:** open POs go Hanova 6 → 2 and Steelgal 2 → 0. Open value is unchanged (Hanova $178,019.91).
- **Order list:** the total rises for SPW12G and BN16110G, unless a qty has been typed (typed quantities are kept).
- **`kit_double_order`** may appear on SPW12G, on BN16110G, and on parent kits that also have a suggestion. In the local BOM, BN16110G sits in BP16110G and DSG100110P.
- **Item page PO rows:**
  - only POs with something still to arrive are shown;
  - "Qty" becomes **"Outstanding"**, with a total row "= On order";
  - reversal documents disappear (BP1675G shows one row, 00023060 for 11,000, instead of five);
  - the 20-row cap is removed.
- **Kit pages:** "buildable incl. incoming" may fall for the parents of BP1675G (19), BP1690G (15), WSBT450G (3) and BN16110G (2), using local BOM counts.
- **Data & Sync:** "On order vs MYOB" lists only AFLSA390/490.
- **At past dates,** the historical notice adds: "On order on days before 1.2 (released <date>) included MYOB reversal documents for six items; see What's new."

**Backend:** the Stage 1 fragments are wired into **five** places.
- `item_position_at` `our_on_order` (`schema.ts:587-595`): body only, with the same arguments and `RETURNS TABLE`.
- `ownedPositions` (`ledger.ts:690-698`).
- The `itemDetail` PO query (`queries.ts:1655-1662`):
  - adds `outstanding` and `po_uid`, and keeps `qty` and `received_qty` for old tabs;
  - keeps only rows with outstanding > 0;
  - removes `LIMIT 20`.
- The `suppliersList` open-PO lateral (`queries.ts:2014-2019`).
- **The `openPoRegions` query** (`queries.ts:1319-1327`).

Also:
- `test/open-po-rule.test.ts` scans `src/**/*.ts`. Every SQL that reads `myob_purchase_orders` with status `'OPEN'` must use `OPEN_PO_DOC`, and `GREATEST(COALESCE(l.qty` must not appear anywhere.
- Correct `docs/myob-field-reference.md:60-62` (ReceivedQuantity is not always 0).

**Frontend:**
- PO rows read `o.outstanding ?? o.qty` under "Outstanding".
- One line is added to `historicalNotice` (`:936`).

**Does NOT change:**
- on hand, committed, free stock, free-stock cover, risk;
- `cover_below_lead_time` (no flips; the lowest afterwards is SPW12G, 20.4w against 17.1w);
- minimums, lead times, cart decisions, closed daily rows.

**Writes:** no decision data. Today's daily row is rewritten by every sync, as usual. **Snapshot:** no.

**Rollback:**
- R1–R4. Boot re-runs the old function body, which is legal because the return type is identical.
- Days that closed while 1.2 was live keep the correct figure, so history becomes mixed. Say so in the note to Allied.
- **If the deploy fails after boot DDL,** the new body stays live under the old code. Follow "Failed deploy" in §4.9.
- This stage is never withdrawn out of order: MYOB's figure is the spec, so problems are fixed forward.

**Accept when:**
- **Allowlist.** Before deploy, generate `scripts/expected/1.2.0.json` by running `dev:local` on the refreshed copy, capturing before and after the change on the same data. Review that file; don't hand-write the list. It should cover:
  - the 6 items' `qtyOnOrder`, `incomingQty` and `qtyAvailable`;
  - the suggestions and `kit_double_order` flags that follow from them;
  - the `/cart` lines, group totals and header totals for those items, including BP1690G's below-minimum line;
  - Overview suggested count and region open-PO count;
  - Suppliers `open_po_count`;
  - `/divergence` `onOrder`;
  - the `/items/:uid` incoming arrays;
  - kit buildable-incl.-incoming;
  - the CSV cells for those items.
- **Local:**
  - `SUM(on_order)` equals Σ MYOB `qty_on_order` except AFLSA390/490 (26 Aug copy: 858,796 against 858,820);
  - `positionParity` is 0;
  - `npm test` passes.
- **Prod:**
  - the diff stays within the allowlist;
  - each item's new On order equals the Stage 1 "Proposed" figure captured that evening;
  - the `coverBelowLeadTime` count is unchanged;
  - `positionParity` is 0 and the chip is green.
- **Roll back immediately if any item other than AFLSA390/490 reads below MYOB.**
- Allied confirm two figures in MYOB: WSBT450G = 0 and BP1675G = 11,000.

**Depends on:** 1. **Size:** S code, M verification.

**Allied decisions:** none blocking, because MYOB's own figure is the spec. Send the table above as a heads-up before deploy. An explicit OK of 1.2 is needed before Stage 14, the next stage that moves suggestions.

---

### Stage 3: Cover excl. / incl. on order (1.3)

**Answers #1:** *"Can we include in the Cover number, cover that includes on order and cover that doesn't include on order."*

**What Allied see:**
- **Item page tiles:** "Cover" becomes two tiles.
  - **"Cover excl. on order":** 1.9w, with the note "323 free ÷ 166.4/wk".
  - **"Cover incl. on order":** 14.0w, with the note "2,323 ÷ 166.4/wk". It shows a red "below 17.1w lead time" when the flag is set, otherwise "lead time 17.1w".
- **Inventory table:**
  - "Cover" becomes **"Cover excl. on order"**, keeping its red (< 2w) and amber (< 4w) badges.
  - A new sortable **"Cover incl. on order"** column follows it. It sorts lowest first on the first click and is red only when below lead time.
  - "Incoming" is renamed **"On order"**. The sort key `incoming` is unchanged, and the glossary says "also called incoming".
- **Expand panel:**
  - "Cover excl. on order (target 8w)", plus a new row "Cover incl. on order (lead 17.1w)".
  - "MYOB available (incl. on order)" (`:1598`, a mislabel) becomes **"Available (free stock + on order)"**.
- **Tags:** the raw `cover_below_lead_time` chip becomes **"Below lead time"** (red), with the help text "Even counting everything on order, stock runs out before a new order could arrive." A new filter reads **"Below lead time (even with on order)"**.
- **Glossary:** both cover terms, with the note "Cover incl. on order counts everything on order as if it were already here; it says nothing about *when*." The weeks/months toggle covers both.
- **`items.csv`:** "Cover incl. on order (weeks)" is appended as the last column.

**Backend (`queries.ts`):**
- `coverWeeksInclOnOrder` is added to `ItemComputed` (`:493`) and the returned object (`:933`), rounded to 1 dp from `coverIncludingIncoming`. The flag keeps using the unrounded value.
- `SORT_VALUES.cover_incl`, with `SORT_DEFAULT_DIR` "asc" (`:1059-1083`), plus a comment that `available` means free stock.
- A `below_lead` filter.
- The CSV column is appended (`:3140-3148`).

**Frontend:**
- `TERMS` (`:17`), `FLAG_HELP`/`FLAG_LABELS` (`:116-140`), `INVENTORY_FILTERS`/`INVENTORY_SORTS` (`:169-205`).
- Headers and cells (`:1282-1296`, `:1312`), the tile (`:1859`), the expand rows (`:1598`, `:1620`).
- The expand row's colspan is computed from the header count (`:1406`). This fixes the 12-vs-13 bug for good.

**Does NOT change:** every existing value; "Reorder now", `low_cover`, risk, excess and the suggestion; the Overview tile (Stage 15); Purchasing.

**Numbers:** none moved. New figures after 1.2:
- BN1665G 1.9w / **14.0w (red)**;
- SPW12G 2.3w / 20.4w;
- WR16301.5S16 2.5w / 34.7w;
- WSBT450G 67.8w / 67.8w.

**Writes:** none.

**Rollback:** pure revert.
- New JS against the old API shows "—".
- `sort=cover_incl` falls back to risk.
- `filter=below_lead` lists everything until the banner forces a reload.

**Accept when** (`stage-check cover`, all 3,105 items, local and prod):
- With weekly > 0: |incl × weekly − max(Available, 0)| ≤ 0.05 × weekly.
- incl ≥ excl, and the two are equal when on order is 0.
- Weekly = 0 gives null for both.
- The `below_lead` count equals the `coverBelowLeadTime` count.
- `cover_incl` ascending is non-decreasing, with nulls last.
- The golden diff shows 0 existing fields changed, and every existing CSV column is byte-identical.
- The expand row spans the full table on every Inventory filter.

**Depends on:** 2. **Size:** S. **Allied decisions:** none (stated defaults, §5).

---

### Stage 4: Order list total for split items (1.4)

**Answers:** none. The By item view will lead with this header figure, so it must be right first.

**What Allied see / numbers:**
- **Order list header:** "$low–$high to order" now counts a split item in full. `requirementRange` (`cart.ts:812-845`) sums an item's lines when they are split parts. Since f2148b2 that is the only normal way an item gets more than one line. The header becomes one figure, equal to `estimatedCost`. For example, FG250P split 142/142 used to count one part at each end of the range.
- **Kit notice:** "N kits have both the kit and its parts on order" counts items, not lines (`cart.ts:797-800`).

**Does NOT change:** any line, qty, per-supplier subtotal, `estimatedCost`, CSV or suggestion.

**Writes:** none. **Rollback:** pure revert.

**Accept when:**
- Before shipping, count split decisions and kit double orders on prod. If there are none, the What's new entry says nothing will visibly change.
- Over splits: Δlow = Σ(sum − smallest part) and Δhigh = Σ(sum − largest part).
- `estimatedCost` and subtotals are identical.

**Depends on:** 3 (ship order only). **Size:** S. **Allied decisions:** none.

---

### Stage 5: Purchasing groundwork (1.5)

**Answers:** none. This stage contains the refactors Stage 6 needs, shipped on their own with no visible change, so a defect in them can't hide inside the new view.

**What Allied see:** nothing, except at a past as-at date: Purchasing's historical notice now says where committed and on order come from, as Inventory's does.

**Backend (additive only):**
- `CartLine` gains `qtyCommitted`, `coverWeeksInclOnOrder`, `riskScore` and `coverBelowLeadTime`, taken from the `ItemComputed` already in scope. `gap` is not added here; it comes in Stage 12.
- The `/cart` payload gains `window`, `hasSnapshot` and `snapshotsFrom`, from the same `snapshotState` call `/items` uses. They appear **on both the normal and the empty return** (`cart.ts:510-523`).
- `purchaseCart` grouping, lines and quantities are untouched.

**Frontend:**
- `reloadOrderList()` replaces the re-fetch at `dashboard.js:4216, 4228, 4312, 4328, 4582, 4616, 5005` and the initial load at `:4107`. It redraws whichever Order list view is active (only By supplier exists for now).
- `expandPanelHtml(item, ctx)` and `toggleExpandRow(lookup, colspan)` are parameterised, which removes the `invItems` coupling (`:1402`). Inventory passes `invItems` and its header count.
- New pure module `public/order-list.js` with `groupLinesByItem(cart)`, not yet used on screen:
  - rows sum line qty and `estCost`;
  - split parts are aggregated;
  - `options` are taken once per item;
  - it must not use the names the ledger guard bans.
- Tests:
  - `test/order-list.test.ts`: every line appears exactly once, sums match, splits aggregate.
  - `test/public-imports.test.ts`: every name `dashboard.js` imports from a `public/` module is exported by that module.

**Does NOT change:** By supplier, Inventory, any number, write semantics, cart state values or tables.

**Writes:** existing endpoints only. **Snapshot mandatory**, because every write handler is refactored: `node scripts/supplier-rollback.mjs snapshot pre_s5_<yyyymmdd> --apply --confirm <db>`, then `status`.

**Rollback:** R1–R5. Nothing needs restoring.

**Accept when:**
- The `/cart` golden diff shows only the additive fields.
- On the refreshed local copy, every By supplier action leaves the same rows and the same change-log entries as on 1.4:
  - edit qty, ×, Put back;
  - Use preferred, Keep;
  - Compare → Choose, Split;
  - Undo, Start again.
- The Inventory expand panel opens full-width on every filter.
- At a past date, Purchasing's notice names the snapshot start date (21 Aug on prod).
- All tests pass.

**Depends on:** 3 (expand panel), 4. **Size:** M. **Allied decisions:** none.

---

### Stage 6: Purchasing by item (1.6)

**Answers #3:** *"Can we change the view to be by item NOT by Supplier — it shows recommended order qty; drill down in item code; it shows current data on that item: on hand, committed, free stock, incoming, weekly demand, cover including incoming and cover not including incoming."* Choosing the supplier in the row comes in Stage 8; until then it is done in the existing Compare drawer.

**What Allied see:**
- **Purchasing opens on "Order list — by item".** Sub-tabs:
  - **By item** (`#/purchasing`);
  - **By supplier** (`#/purchasing/suppliers`, today's screen, unchanged);
  - Minimum stock review.
- **Header:** "N items to order · M taken off · $X estimated". N + M equals By supplier's "items need an order" (`totalItems`), and $X equals By supplier's total after Stage 4. Start again and **Export order sheets** are unchanged (the same per-supplier CSV). The kit and pick-conflict notices are as today.
- **One row per item.** Columns, using Inventory's labels, tooltips and formats:
  ▸ | Item | Supplier | Suggested | Order qty | On hand | Committed | Free stock | On order | Weekly demand | Cover excl. on order | Cover incl. on order | Lead time | Est. cost | ×
- **Supplier cell:**
  - "Hanova · preferred", "Jiaxing · MYOB primary", "· from bills", "· tagged";
  - a pick that disagrees: "Jiaxing · your pick (preferred: Hanova)", with the existing [Use preferred] [Keep];
  - "Split: Hanova 142 · Bremick 142";
  - a **Compare** link to the existing drawer.
- **Order qty:** editable and saved exactly as in By supplier, with an "Edited" marker. Split rows are read-only ("edit in Compare"). Below-minimum items covered by on order show 0, labelled "covered by on order".
- **×** takes an item off the order; Put back is in the Taken off list.
- **Order:** risk, highest first, then item number.
- **Drill-down** (item code or ▸) opens an inline panel with:
  - Inventory's expand panel;
  - "Why this quantity" (`cartRationale`, `:4511`);
  - suppliers on file (role, lead time, last cost);
  - "Open item page".

  Stages 9 and 12 add the incoming list and the gap sentence.
- At a past date, the historical notice appears (Stage 5 fields).

**Backend:** none.

**Frontend:**
- `renderPurchasing`: `suppliers` → `drawCart()`, `minimums` → unchanged, default → `drawOrderByItem()`. `purchasingTabs` (`:4111`) gets the new tabs.
- `reloadOrderList()` redraws the active view.
- Lines-per-item come from `groupLinesByItem`. `CartLine.supplierCount` is neither relied on nor renamed.

**Does NOT change:** By supplier, the `/cart` lines, `cart.csv`, any number, write semantics, cart state values or tables. There is **no inline editing** of minimum stock, lead time or supplier meta.

**Numbers:** none.

**Writes:** existing endpoints only (`/cart/line`, take-off, put-back, use-preferred, keep-pick, and select/split through the drawer). **Snapshot mandatory:** `pre_s6_<yyyymmdd>`, then `status`.

**Rollback:**
- R1–R5. On the old release, both new URLs open the old Order list.
- Rows written from By item are the same `edited` and `removed` rows and take-off markers By supplier writes.
- `undo <id>` handles any single bad write.
- To withdraw By item later without reverting: a release that makes By supplier the default again.

**Accept when:**
- **Local (refreshed copy):**
  - both views list the same (item, supplier, qty) set;
  - Σ qty and Σ est. cost are equal to the cent;
  - rows = distinct `itemUid` in `/cart` lines, and rows + `removedItems` = `totalItems`;
  - every row's stock fields equal `/items/:uid`, and committed = on hand − free;
  - a qty typed in By item shows in By supplier, with an `edit_line` entry carrying `detail.release = 1.6.0`;
  - `undo` restores it, and take-off and put-back round-trip;
  - on a checkout of `v1.5.0`, both new URLs open the Order list.
- **Prod (GET only):** `/cart` is unchanged. The BN1665G row reads suggested 1,779 · 333 · 10 · 323 · 2,000 · 166.4 · 1.9w · 14.0w · 120 d · Hanova (preferred). Re-derive on ship day.
- **Allied** edit one agreed item, check it in both views, then Undo it.

**Depends on:** 5. **Size:** M. **Allied decisions:** none (stated defaults, §5).

---

### Stage 7: Purchasing sorting (1.7)

**Answers #4:** *"Also would like the sorting functionality from the Inventory tab included on the purchasing tab."*

**What Allied see:**
- By item headers sort as Inventory's do:
  - click to sort, click again to flip, with ▲/▼ and a hover ↕;
  - empty values last in both directions;
  - a "Sorted by …" line.
- First-click direction:
  - Item, Supplier, On hand, Free stock and both covers: lowest or A first;
  - risk, quantities, cost, lead time, weekly demand and committed: highest first.
- The sort is kept in the address (`#/purchasing?sort=cover_incl&dir=asc`), so reload, bookmarks and back/forward keep it.

**Backend:** `SORT_DEFAULT_DIR` is exported (additive, `queries.ts:1077`).

**Frontend:**
- `order-list.js` gains `sortRows(rows, key, dir)`: nulls last, item-number tie-break.
- `PURCHASING_SORTS` uses Inventory's key names for shared columns: `risk`, `number`, `on_hand`, `committed`, `available` (free stock), `incoming`, `weekly`, `cover`, `cover_incl`. It adds `supplier`, `suggested`, `order_qty`, `est_cost` and `lead_time`. Stage 12 adds `gap`.
- `test/order-list.test.ts` asserts that shared keys start in the same direction as `SORT_DEFAULT_DIR`.
- `route()` (`:676`) parses the query string for `purchasing`.
- A new Purchasing-only `sortableHeader(state, …)`. Inventory's `sortTh` is **not** touched.
- Sorting is client-side, over the cart already loaded.

**Does NOT change:** Inventory sorting, the By supplier card order, the export line order, any number.

**Writes:** none. **Rollback:** pure revert; a `?sort=` bookmark then gives the default order.

**Accept when:**
- Every key works in both directions with nulls last.
- Every sort is a permutation (same count and totals).
- On the same set of items, shared keys order rows exactly as `/items?filter=suggested&sort=<key>` does, apart from ties.
- URL round-trip, reload and back/forward all keep the sort.
- The `/items` golden diff for every Inventory key, ascending and descending, is identical.

**Depends on:** 6. **Size:** M. **Allied decisions:** none.

---

### Stage 8: Choose the supplier on the row (1.8)

**Answers #3:** *"select supplier — preferred is the default but they want the option to change it."*

**What Allied see:**
- **The Supplier cell becomes a dropdown** of the suppliers on file.
  - Order: preferred, MYOB primary, top biller, other tagged, existing pick.
  - Each option reads like "Hanova — preferred · 120 d · $0.42 last".
  - It is pre-set to the supplier the item follows now.
- **Choosing another supplier** works exactly as Compare → Choose does today:
  - the line moves to that supplier, **for this order only**; the preferred supplier is unchanged;
  - the pick is **flagged**: "Jiaxing · your pick (preferred: Hanova) [Use preferred] [Keep]", and it is listed in the pick-conflict notice;
  - Lead time and Est. cost show the chosen supplier's figures;
  - By supplier and the export show the item under the new supplier.
- **Order qty does not change.** The toast says why, worded by the kind of minimum:
  - **Window minimum:** "Quantity stays 1,779. It is built from your minimum of 2,771, which was set from Hanova's 120-day lead time over 6 months of use. Changing the supplier here doesn't change it."
  - **Hand-set minimum:** "Quantity stays N. It is built from your minimum of M, which you set by hand."
  - **No minimum:** "Quantity stays N. It is built on Hanova's 120-day lead time, the item's usual supplier."
- **Choosing the preferred supplier again** equals Use preferred: the pick is cleared and a typed qty is kept.
- **Items with no preferred supplier** default to MYOB primary or top biller. Choosing it again records it as Chosen, exactly what Compare → Choose does today.
- **Special cases:**
  - split rows: "Split (2) — change in Compare";
  - a single supplier on file: that option plus "Add a supplier on the item page →";
  - ruled no supplier: "No supplier (ruled)", with no dropdown.
- **"Why this quantity"** names the lead time and minimum actually used. For example: "Built on Hanova's 120-day lead time (preferred). Jiaxing's is 120 days." or "Your minimum (2,771, from Hanova's 120 days) sets the lead-time stock."
- **Undo keeps a typed quantity:** undoing a pick no longer loses the number you typed.

**Backend:**
- **Validation commit** (`insights.ts:779-808`):
  - `/cart/select`: `supplierUid` must be one of the item's options (on file, or an existing pick), otherwise 400.
  - `/cart/split`: every part's supplier is an option, the suppliers are distinct, each qty is finite and ≥ 0, and there are at least 2 parts.
  - The drawer only ever sends options (`:4640`), so old tabs never hit a 400.
- **Undo** (`undoCartDecision`, `cart.ts:1249-1254`): inside the same `cartWrite`, it re-inserts the quantity on show (`typedQtyOnShow`) as an `edited` row under the default supplier. One `undo_decision` entry records it in its before/after. Splits carry no single quantity, as today.
- Additive rationale fields `leadTimeDaysUsed`, `leadTimeUsedFor` and `leadStockBasis` (`window`/`manual`/`lead`) (`cart.ts:671-679`). The existing `leadTimeDays` stays for old tabs.

**Frontend:**
- The dropdown posts `select`, or `use-preferred` when the preferred supplier is chosen again.
- The row is disabled while the request is in flight. A 400 shows a toast.

**Does NOT change:** the suggested qty (Stage 14), the preferred supplier (changed on the item page only), cart state values, tables, the drawer, By supplier, the export format, pick-flagging semantics.

**Numbers:** none on deploy.

**Writes:** `selected`, `use_preferred`, Keep acks and `edited` (on Undo), all existing states. **Snapshot mandatory:** `pre_s8_<yyyymmdd>`.

**Rollback:**
- R1–R5. Picks are ordinary `selected` rows, which the old release shows as flagged picks.
- To undo one pick: `undo <id>` (it also restores the rows `select` deleted).
- Wholesale, only if Allied ask: `diff --from pre_s8_…`, then `restore cart --from pre_s8_… --apply --confirm <db>`, dry run first. This also wipes every quantity typed since the snapshot.

**Accept when (local):**
- A dropdown pick shows under the new supplier in By supplier and in the export, flagged, with one `select_supplier` log entry. Keep acknowledges it.
- Changing the preferred supplier on the item page brings the flag back.
- Choosing preferred again is logged as `use_preferred` and keeps the typed qty.
- Undo of a pick that carried a typed qty leaves that qty on the default supplier.
- A no-preferred item re-chooses its default as Chosen.
- A made-up uid or bad split parts return 400 and write nothing. Compare → Choose and Split still return 200.
- Each toast matches the item's minimum kind (BN1665G window; one manual item; one item with no minimum).

**Prod:** after Allied's first picks, `log --limit 10` matches the rows.

**Depends on:** 6 (7 for column order only). **Size:** M. **Allied decisions:** Q4, non-blocking.

---

### Stage 9: Incoming POs with expected dates (1.9)

**Answers #2, part 1:** *"If an ETA date on the PO can Allied use that data pulled over to the dashboard…"*

> **Decision 12 Oct 2026:** Allied will enter ETAs as the PO's Promised Date in MYOB. Promised Date is therefore the primary ETA; the estimate below is only a labelled fallback for POs not yet dated, and the panel lists undated POs so Allied can fill them in.

The answer is yes. MYOB's PO header **Promised Date** is already synced (`engine.ts:476-486`); MYOB has no line-level date. Live, 2 of the 12 real open POs have one, about 6% of incoming units, so the rest get labelled estimates. If Q1 says Allied note ETAs in another field, a follow-up release syncs that field (§5).

**ETA rule, worked out once per PO document:**
1. **Promised:** `promised_date`, when it is on or after the PO date. An earlier date is ignored and labelled "Promised date earlier than PO date (ignored)".
2. **Estimated:** PO date + the **PO supplier's** lead time: Allied's figure if set, otherwise the measured median, otherwise none.
   - **A lead time set on an item is never used for an ETA.** One document arrives once.
   - The item lead stays a planning input for the suggestion, the minimum and the cart.
3. **Overdue / late:** the date has passed and something is still outstanding. Such lines are never placed in the past as if they had been received.

Reconciliation: dated + overdue/late + undated = On order, exactly.

**What Allied see:**
- **Item page panel "Incoming purchase orders"**, replacing the PO rows (sale orders stay):
  - Columns: **PO | Supplier | Raised | Outstanding | Expected | Basis | Status**.
  - Order: overdue/late first, then by date, then undated. Total row "= On order".
- **Basis:**
  - "Promised in MYOB · promised dates have run a median ~5 days late; 7 of 20 were over 2 weeks late"
  - "Estimate: raised 12 Aug + 120 days (Hanova lead set by Allied)"
  - "Estimate: raised + 2 days (Steel & Tube, measured over 5 orders)"
  - "No date: no lead time for <supplier>; set one under Suppliers" (no live PO today)
  - When Allied's lead differs from the measured median by more than 14 days, it adds "· measured 83 days would give ~3 Nov".
- **Status:**
  - "Due in 58 days"
  - **"Overdue 28 days: promised 15 Sep, nothing received"** (red)
  - **"Late against estimate by 13 days"** (amber)
- **On order tile note:** "next ~10 Dec (est.)", "next 1 Nov (promised)" or "1 PO overdue". The same note appears on the expand panel's On order row.
- **Purchasing drill-down:** gains the same incoming list.
- **Sale-order rows:** separate **Ordered** and **Promised** columns.
- **At a past date:** the panel is titled "Open purchase orders today", with the note "MYOB keeps no PO history; expected dates exist only for today".
- **Footnote:** "Enter a Promised Date on the PO in MYOB to replace an estimate (picked up within 6 hours)."

**Backend:**
- `src/insights/leadTimes.ts`: the supplier lead query moves out of `cart.ts:534-544` (a runtime SELECT; nothing depends on `supplier_lead_time`), and the cart imports it. `/cart` must stay byte-identical.
- `src/insights/incoming.ts`: `openPoSchedule(itemUids?)`, built on the Stage 1 fragments.
- `itemDetail` gains additive `incomingSchedule[]` and `incomingSummary{dated, overdue, late, undated, total}`. The existing `incoming` field is unchanged.

**Frontend:**
- `renderItem` (`:1821`, PO block around `:2091-2113`), `expandPanelHtml` and the Purchasing drill-down.
- Falls back to the 1.2 rows when `incomingSchedule` is missing.

**Does NOT change:** On order, cover, suggestions, flags, cart, daily rows. **No ETA feeds any calculation.**

**Known, labelled difference:** for a non-usual supplier, Purchasing shows the lead for a *new* order (today the item lead applies under every supplier, `cart.ts:568-576`), while the ETA uses the PO supplier's lead. What's new explains this. Stage 13 changes the Purchasing side only if Q2b says so.

**Writes:** none. **Rollback:** pure revert.

**Accept when** (`stage-check schedule`, local and prod):
- For every item with stock on order, Σ outstanding = `qtyOnOrder` exactly.
- Exactly the 12 real open POs appear, and none of 00020462, 00019910, 00022808 or 00020624.
- Expected values from the 13 Oct capture, using local measured medians (confirm on prod and re-derive on ship day):

| PO | Supplier | Expected |
|---|---|---|
| 00022886 | Tong Ming | Overdue 28 days (promised 15 Sep) |
| 00023060 | Hanova | Promised 1 Nov |
| 00023070 | Hanova | ~10 Dec on **every** line, WR16503G and WR16301.5S16 included (measured: ~3 Nov) |
| 00023096 | TANDL | ~24 Nov (measured 117 d: ~9 Dec) |
| 00023002 | Jiaxing | ~24 Nov on every line, TB12125S16 included (measured: ~4 Nov) |
| 00023049 | Jiaxing | ~4 Dec (measured: ~14 Nov) |
| 00023260 | Maptco | ~30 Oct |
| 00023268 / 00023267 | Hobson | ~31 Oct / ~1 Nov |
| 00023248 | Steel & Tube | est. 30 Sep: late by 13 days |
| 00023309 | Specialised Washers | est. 12 Oct: late by 1 day |
| 00022464 | Cash Purchase | est. 16 Apr: late by ~180 days |

- The `/cart` golden diff is identical.

**Depends on:** 2 (fragments), 5 (drill-down). **Size:** M.

**Allied decisions:** none blocking. Ship on the defaults, so Allied judge real estimates. Q1 and Q2 should already have been sent in week 1.

---

### Stage 10: Daily PO record (optional, 1.10)

**Answers:** none directly. It answers "how often do promised dates move, and by how much". MYOB overwrites `promised_date`, `status` and `received_qty` in place, so this can't be recovered later.

**Named use:** after 8 weeks, a one-off report on Promised Dates added, moved or slipped. That is evidence for Q1(b) and Q2(a), and later for expected dates at past dates.

**What Allied see:** nothing.

**Backend:**
- New table `platform_po_daily`, with primary key `(as_at_date, po_uid, item_uid)`. Columns:
  - `as_at_date`, `po_uid`, `item_uid`, `number`, `supplier_uid`, `status`, `counted`;
  - `line_count`;
  - `ordered` = SUM(qty) and `received` = SUM(clamped received);
  - `outstanding` = SUM of the per-line clamped outstanding;
  - `promised_date`, `po_date`.
- **It aggregates per (PO, item) before inserting.** 00023096 has BN16525LTG on two lines.
- Reversal documents are recorded with `counted = false`, so the rule can be audited later.
- It is written in `engine.ts` after `snapshotPositions`, in its own try/catch (`stats.po_daily` or `po_daily_error`). Today's rows are rewritten each sync with `DELETE … WHERE as_at_date = today` plus `INSERT` in one transaction. Closed days are never touched.
- Size: about 280 rows a day on the 26 Aug copy (149 counted).
- It is **not** added to `BACKUP_TABLES`, and has no views or foreign keys.

**Does NOT change:** anything Allied see. **Writes:** system data only. **Snapshot:** no.

**Rollback:** pure revert. The table stays and stops growing, leaving a gap in the record; the older release still boots.

**Accept when** (local, using a one-off `tsx` call, **never a MYOB sync**):
- Today's rows equal the open document–item pairs.
- Σ `outstanding` where `counted` equals `qtyOnOrder` per item.
- 00023096 BN16525LTG shows `ordered` 2,500 and `line_count` 2.
- A second run replaces today's rows and leaves yesterday's unchanged.
- A forced insert error writes `po_daily_error`, and the sync still succeeds.

**Depends on:** 9. **Size:** S. **Allied decisions:** none.

---

### Stage 11: Stock gaps, server only (1.11)

**Answers:** the groundwork for #2 part 2, *"…show what gaps might exist between current stock levels, current demand, and incoming stock."* It ships first with no screen, so its cost and safety can be measured on prod.

**Gap rule** (defaults for Q3):
- **P(d)** = free stock today + Σ outstanding on lines whose ETA is dated, in the future and ≤ d − (weekly ÷ 7) × d.
  - Weekly is the rate cover uses.
  - Committed stock, including future-dated sale orders, is reserved today, as free stock already does.
- **Overdue, late and undated lines are not counted.** An item whose incoming is all overdue, late or undated is projected on free stock alone, so it still shows its run-out.
- The projection runs to the later of the last dated delivery and the run-out date, capped at **26 weeks**.
- **The run-out** is the first day P < 0.
  - A **gap** is the run of days from there until a counted delivery brings P back to ≥ 0. Its end is that delivery's ETA.
  - If no counted delivery does so within the horizon, the gap's **end is unknown**. The reason is one of: overdue, late against estimate, no date, too small, after 26 weeks.
- **Reported:** start, end (or unknown), days, units short (the deepest shortfall, including today's), and the PO that ends it, with its basis.
- **The threshold is zero.** The minimum is drawn only as a reference line.
- **Statuses:**
  - `gap` (end known);
  - `gap_open` (end unknown, with its reason);
  - `covered`, plus `tight` when the next counted delivery lands less than 14 days before free stock would run out;
  - `nothing_on_order` (already covered by Reorder now);
  - `no_demand`;
  - `built_here`: a kit built in-house shows "Follows its components", because buildable stock is not additive. A purchased kit is treated like any item and never broken open.

**What Allied see:** nothing. What's new says "Groundwork for stock gaps; nothing on screen changes."

**Backend:**
- `src/insights/projection.ts`: a pure `projectItem()`.
- `test/projection.test.ts` cases:
  - BN1665G, SPW12G;
  - a gap between two arrivals; a delivery too small;
  - short now with only overdue incoming; late against estimate; undated;
  - zero demand; built here; already negative (N16G8);
  - an unclosed gap.
- `computedItems` (`queries.ts:983-1029`) runs **one** schedule query per cache build, **only when as-at is today**. It attaches `gap`, `gapStatus`, `nextDelivery` and `incomingOverdueQty`, which are null at past dates.
- **Fail-safe:** the schedule query and the projection run in a try/catch. On any error the gap fields are null and the error is logged once per cache build. **It never throws.** Every screen reads `computedItems`: cart, minimum review, kits, Overview.
- **Switch-off:** a `GAP_ENABLED` constant, so an out-of-order withdrawal is a one-line release.
- The server gets sort key `gap`, filters `gap` (`gap` + `gap_open`) and `incoming_overdue`, and an Overview count field.
- **No CSV columns yet.** Gap fields are not added to `flags`, so Tags, the CSV "Flags" column and risk stay unchanged.

**Does NOT change:** suggestions, risk, flags, either cover figure, Purchasing, any existing field.

**Writes:** none. **Rollback:** pure revert, or `GAP_ENABLED = false`.

**Accept when:**
- **`stage-check gap`** recomputes each projection from `/items/:uid` and matches the server field for field. It covers every item with stock on order (about 90 live) plus 50 sampled others.
- **Identities:** the first run-out with no counted delivery before it is about excl. cover × 7 (within 1 day), and every known gap end is one of the item's ETAs.
- **Expected values** from the 13 Oct capture, using Allied's leads and the per-document ETA. The dates will have moved by ship day (BN1665G's run-out will probably have passed), so re-derive them then:

| Item | Expected (13 Oct) | With measured leads |
|---|---|---|
| BN1665G | gap 27 Oct → 10 Dec, 44 d, ~1,056 short | 27 Oct → 3 Nov, ~177 |
| SPW12G | gap 30 Oct → 10 Dec, 41 d, ~4,929 short | 30 Oct → 3 Nov, ~550 |
| WR16503G | gap 26 Nov → 10 Dec, 14 d, ~5,961 short | covered |
| BN16150G | gap 4 Nov → 10 Dec, 36 d, ~1,266 short | covered |
| N16G8 | gap today → 24 Nov, ~7,724 short | today → 3 Nov |
| BN12150LTG | gap today → 24 Nov, ~4,103 short (00023248 late, off the timeline) | today → 9 Dec |
| N24S16M | gap 24 → 31 Oct, ~152 short | 24 → 25 Oct |
| TB12125S16 | gap 14 Oct → 24 Nov, ~32 short | 14 Oct → 4 Nov |
| WR16301.5S16 | covered, **tight** (runs out ~30 Oct, delivery est. 31 Oct) | same |
| BP1675G | covered (promised 1 Nov) | same |
| KITST1230S | gap_open from today (00022886 overdue) | same |
| KITST1240S | gap_open from ~29 Dec (00022886 overdue) | same |
| FG050NP | gap_open from today (00023309 late) | same |
| WSBT450G | nothing_on_order | same |

- **Latency:** `/items`, `/cart` and `/purchasing/minimums` each stay within +20%, measured over 3 calls before and after.
- **Fail-safe check:** locally, a forced exception in `projectItem` gives null gap fields and HTTP 200 on all three endpoints.
- The golden diff shows 0 existing fields changed.
- Record in the commit body the number of gap and gap_open items, and how many of them are *not* flagged below lead time. The 26 Aug prototype found 33 of 34.

**Depends on:** 9. **Size:** M. **Allied decisions:** Q3, non-blocking. Q2(a) is shown as the "with measured" alternative, not waited on.

---

### Stage 12: Stock gaps on screen (1.12)

**Answers #2:** *"…show what gaps might exist between current stock levels, current demand, and incoming stock."*

**What Allied see:**
- **Item tile "Stock gap":**
  - "27 Oct → 10 Dec" in red, with the note "~1,056 short · estimate";
  - "From today · end unknown (PO 00022886 overdue)";
  - otherwise "None before next delivery" (with "tight" when it applies), "Nothing on order", or "—" at a past date.
- **Panel "Stock outlook (today)"**, above Purchasing suggestion:
  - a weekly strip of projected free stock;
  - arrival markers: solid = promised, hollow = estimate; overdue and late POs are listed beside the strip, not placed on it;
  - the gap drawn as a red band.
- **BN1665G sentence:** "Free stock (323) runs out about 27 Oct at 166.4 a week. The next delivery, 2,000 on PO 00023070 (Hanova), is *estimated* for 10 Dec (raised 12 Aug + 120 days), about 6.3 weeks and ~1,056 units short. With Hanova's measured 83 days it would land ~3 Nov. Cover incl. on order (14.0w) counts that delivery as already here. An order placed with Hanova today would land about 10 Feb."
- **KITST1230S sentence:** "Free stock is already short by 425. The only PO, 6,000 on 00022886, is 28 days overdue and isn't counted, so the end of this gap is unknown."
- **Inventory:**
  - a **"Gap before delivery"** column after Cover incl., e.g. "6.3w from 27 Oct ~" or "from today, end unknown"; sort key `gap`, soonest first;
  - filters **"Runs out before next delivery"** (gap + gap_open) and **"Incoming overdue or late"**.
- **Overview:** a tile **"Runs out before next delivery: N"**, linking to the filter.
- **Purchasing By item:** a **"Gap before delivery"** column (sort key `gap`, added to `PURCHASING_SORTS`), plus the gap sentence in the drill-down. `CartLine` gains `gap` as an optional field: `(item as {gap?: Gap}).gap ?? null`.
- **`items.csv` appends:** Next delivery date, Next delivery qty, ETA basis, Gap start, Gap end, Gap days, Units short, Overdue qty.

**Backend:** the CSV columns; `CartLine.gap`.

**Frontend:** the tile, panel, columns, filters, Overview tile and Purchasing column. Missing fields render "—".

**Does NOT change:** suggestions, risk, flags, either cover figure, existing CSV columns.

**Numbers:** none existing. **Writes:** none.

**Rollback:** pure revert. A `filter=gap` bookmark lists everything on the old code.

**Accept when:**
- The golden diff shows 0 existing fields changed, and every existing CSV column is byte-identical.
- The Overview tile count equals the filter's total.
- The Purchasing `gap` sort orders rows exactly as `/items?filter=suggested&sort=gap` does, apart from ties.
- The Stage 11 identities still hold.

**Depends on:** 11, 7. **Size:** M. **Allied decisions:** Q3, non-blocking.

---

### Stage 13 (gated on Q2b): Lead time per supplier in Purchasing

**Ship only if Allied answer Q2(b) "only its usual supplier".** If they say "whichever supplier", today's behaviour is what they want and this stage never ships.

**What Allied see:**
- For an item with an item-level lead, the lead shown under any supplier *other than its usual one* becomes that supplier's own figure (Allied's, otherwise the measured median).
- This applies to the Order list Lead time column, the Compare drawer, the dropdown options, "Why this quantity" and the "fastest" badge.
- Example: N24S16M under Hobson changes from 107 days to 30.

**Backend:** `leadFor` (`cart.ts:568-576`) applies the item lead only under the effective supplier, using `leadTimes.ts` otherwise. Quantities are untouched, because they already use the effective supplier.

**Numbers:** displayed lead times only. **Before deploy,** list every line and option whose displayed lead changes (an item lead is set and the supplier is not the effective one), old → new, from the prod capture.

**Writes:** none. **Rollback:** pure revert.

**Accept when:**
- The changed displayed leads equal the predicted list exactly.
- `/cart` quantities, costs and totals are identical.

**Depends on:** 8, 9. **Size:** S.

---

### Stage 14 (gated on Q5): Suggested qty follows the chosen supplier

**Ship only if Allied answer yes to Q5.**

**What Allied see:**
- This applies to lines under a supplier other than the item's effective one (a pick or a split part) that have **no typed qty**.
- The suggested qty is rebuilt on the chosen supplier's lead time (as Q2b defines it):
  - **window minimum:** lead-time stock = monthly burn × chosen lead ÷ 30.44, using the same window;
  - **hand-set minimum:** unchanged;
  - **no minimum:** weekly × chosen lead ÷ 7.
- The suggestion is then weekly × 8 + lead-time stock − free − on order, rounded to the MYOB reorder multiple.
- "Why this quantity" matches.
- The Compare drawer shows each supplier's own suggested qty and est. cost.
- Worked example: N24S16M has a window minimum of 2,349 at 107 days. If Q2b is "usual supplier only", a Hobson pick at 30 days gives lead-time stock of 668 × 30 ÷ 30.44 = 659, and a suggestion of about 1,160 instead of 2,850 (before rounding).

**Backend:**
- Extract `queries.ts:777-822` into a pure `suggestOrderQty()`. `computeItem` must give identical output; tests cover BN1665G = 1,779, SPW12G = 3,564 and the MHS20EG example in the code comment.
- The cart calls it with the line supplier's lead and the item's minimum basis.
- Additive `CartOption.suggestedQty`.

**Numbers:** only lines that meet all four conditions:
- the supplier is not the effective one;
- no typed qty;
- the minimum is not hand-set;
- the lead time differs.

Typed quantities are never rewritten. **Before deploy,** list every affected line old → new from the prod capture and send it to Allied.

**Writes:** none. **Rollback:** pure revert.

**Accept when:**
- All 3,105 `computeItem` suggestions are identical before and after the extraction.
- Every line under the effective supplier has suggested = `item.suggestion.qty`.
- The changed lines equal the predicted list exactly.

**Depends on:** 8, plus 13 if it shipped. **Size:** S–M. **Blocking:** Q5, plus an explicit OK of 1.2 (Q6).

---

### Stage 15: Inventory small fixes (any free evening after Stage 3)

**Answers:** none. These are defects, moved off the Purchasing path. The stage takes the next free version number when it ships.

**What Allied see / numbers:**
- **Overview "Cover < 2 weeks" tile** opens a new `cover_lt2` filter that matches its count (`queries.ts:1271`), instead of `low_cover` (< 4 weeks). It clears any stale search, region and sort.
- **"Used in" column** shows the figure it sorts by, max(deep, direct) (`dashboard.js:1314` against `queries.ts:1072`).
- **Inventory "Export this list"** follows the current filter and sort; its link is refreshed on every table load (`:1172-1187`).
- **Inventory subtitle** (`:1142`) becomes "…platform figures built from MYOB transactions".

**Does NOT change:** any item figure, suggestion, CSV content or Purchasing.

**Writes:** none. **Rollback:** pure revert.

**Accept when:**
- The tile count equals the list total after the click.
- The "Used in" changes are limited to items inside sub-assemblies (list them from the local diff).
- The exported CSV matches the visible list.

**Depends on:** 3. **Size:** S. **Allied decisions:** none.

---

### Stage 16 (optional, code only): Clean-up

Ship at least two weeks after Stage 8 is accepted.
- Delete the dead decision queue and modal (`dashboard.js:4853-5049`), the "to decide" badge and the `kitWithheldQty` badge (`:4483-4485`).
- Keep the CSV "Also under" and CHECK columns (append-only rule).
- Move Inventory `sortTh`/`currentDir` (`:356`) and the drifted `minSortTh` (`:5349-5355`) onto the shared header helper, with an item-number tie-break. **Inventory row order changes only within ties.**

**Rollback:** pure revert.

**Accept when:**
- Both Order list views render identically.
- The `/items` golden diff is identical after normalising ties.

---

## 4. Cross-cutting rules (every stage)

1. **Unit of release and version numbers.**
   - **A release** is one stage or one follow-up: branch `stage/<n>-<slug>`, one to three commits, one version, tag `v<version>`, one `RELEASES` entry naming its stage, and one `FIX-PLAN.md` Part 5 row.
   - **Numbering:** the version is the next `1.N.0` **when it ships**, in ship order. `1.N.1` is used only for a fix to the newest release before anything else ships.
   - **Follow-ups:** a change to an older stage is a new `1.N.0`, labelled e.g. "Stage 9 follow-up: ETA wording". The version shown never goes backwards.
   - **Every push to `main` bumps the version.** Docs-only changes wait for the next release.
   - **Commit body:** the quoted request, what changes on screen, numbers changed (items and amounts), "Verified" with figures, and a **"Rollback:"** paragraph.
2. **Rollback order is strictly newest-first.**
   - Only the newest release is reverted.
   - To remove an older stage, ship a new release that switches it off, tested like any other: `GAP_ENABLED = false`, By supplier made the default again, a column hidden.
   - Never `git revert` an older stage's commits.
   - Stage 2 is never withdrawn; it is fixed forward.
3. **Database:**
   - Additive DDL only. **No new views or functions;** share SQL as TypeScript fragments (`openPo.ts`).
   - `item_position_at` may change its body only, never its arguments or `RETURNS TABLE`.
   - Never change the columns of `item_position`, `item_position_at`, `stock_movements` or `effective_bom`.
   - Nothing may depend on `supplier_lead_time` or `kit_*`.
   - Never rewrite closed `platform_daily_position` rows. Stage 2 is the only stage that changes what is written, and only from its ship day.
4. **API and open tabs:**
   - Additive fields and parameters only. Validation accepts everything an older UI sends, **except** that from 1.0 a non-GET whose `x-ui-version` differs gets 409 "reload".
   - New JS reads new fields with `?? null` and shows "—".
   - Sort, filter and route keys are only ever added, and each one degrades to an existing view on a checkout of the previous tag.
   - New frontend code never uses `qty_on_hand`, `qty_committed` or `qty_available`.
5. **Numbers versus UI.**
   - Number-moving releases (2, 4, 14, and 15 for the Overview list) add no screens beyond the line that explains the change. Each is announced with a before/after table **before** deploy.
   - UI releases carry golden-diff proof that no existing figure moved.
   - Every number is computed once on the server: `computeItem`, `openPo.ts`, `incoming.ts`, `projection.ts`, `suggestOrderQty`. The browser only formats, groups and sorts.
6. **One label per concept, on every tab:**
   - On hand, Committed, Free stock, On order (also called incoming), Available (free stock + on order), Weekly demand;
   - Cover excl. on order, Cover incl. on order, Gap before delivery;
   - Suggested, Order qty;
   - ETA states: Promised / Estimate (~date, with its basis) / Overdue / Late against estimate / No date.

   Free-stock cover remains the basis of every existing threshold, preset, risk point and the suggestion. Cover incl. on order is only ever compared with lead time.
7. **Today only.** PO schedules, expected dates, gaps and next delivery are null at past dates, and the UI says "today only".
8. **CSV.** Append columns only; never rename, reorder or add leading rows. `cart.csv` stays unchanged unless Allied ask.
9. **Deploy and rollback runbook.**
   - **Pre-flight:**
     - `/sync/status` must show that the 17:45 NZDT run finished with `success`. Otherwise every boot starts a catch-up sync, which can race MYOB's single-use refresh token across instances; skip that evening.
     - No other deploy is in progress, and the previous release has finished its soak.
   - **Window:** 18:00–23:15 NZDT. Never within 15 minutes of a sync (05:45, 11:45, 17:45, 23:45) and never across midnight NZ. Never two deploys within 15 minutes of each other.
   - **Deploy:**
     1. `capture`, then push.
     2. Wait for `/sync/status` `release.version` (about 8 min).
     3. `capture`, then `diff --allow`.
     4. Check `positionParity` = 0.
     5. Confirm What's new is live, then send the release note.
   - **Failed deploy** (only relevant to a release that changes a function body; in this plan, only Stage 2): the new body may now be live under the old code. Check `/divergence` `positionParity`. Before 23:45, restart or manually redeploy the live commit, so its boot re-creates its own body. Check parity again.
   - **Soak:** numbers releases need one business day plus the 23:45 closing sync before the next release. UI releases may follow the next evening.
   - **R1:** Render → previous deploy → Rollback (about 2 min). Boot re-creates the previous function body.
   - **R2:** apply the drill result. If Render disabled auto-deploy, leave it off until R3 is pushed, then turn it back on.
   - **R3:** in this order:
     1. `git revert --no-commit <release commits, newest first>`.
     2. Set the next version.
     3. Keep the withdrawn release's `RELEASES` entry, marked `withdrawn: "<new version>"`.
     4. Add the new entry ("1.N withdraws 1.M: what went back; numbers that went back").
     5. Commit and push.

     `main` then matches what is live, and the version doesn't go backwards.
   - **R4:** confirm `release.version`. Open tabs show the banner and get 409 until reloaded. Send Allied a one-line note.
   - **R5** (Stages 5, 6 and 8 only): `status`, then `diff --from pre_s<n>_…`. By default nothing is restored, because rows use existing states. Use `undo <id>` per item, and `restore` only on Allied's request, dry run first.
10. **Snapshots and data changes.**
    - **Snapshots:** mandatory before 5, 6 and 8: `snapshot pre_s<n>_<yyyymmdd> --apply --confirm <current_database()>`, then `status`. Never add tables to `BACKUP_TABLES`/`TABLES`; that marks every existing backup as broken (`supplier-rollback.mjs:157-163`).
    - **Lead-time and minimum tables:** take `bak_<yyyymmdd>_*` copies before sending lead-time questions (Stage 0, ops step 3) and before any bulk change.
    - **Applying an Allied answer that is data, not code** (for example, Hanova 120 → 90): it is not a release.
      1. Before: `capture` and `bak_` copies.
      2. Make the edit in the dashboard (logged from 1.1).
      3. A supplier-lead edit leaves window minimums as drift until "Recalculate" on the Minimum stock review, which is also logged. Run it, or tell Allied why not.
      4. After: `capture`, `diff`, a "data change" row in Part 5, and a note to Allied listing the items whose suggestion moved.
    - **Prod verification** is GET only. The first real writes are Allied's.
11. **Local safety.**
    - Use only `allied-local-db` (`npm run dev:local`, port 3111), with `SYNC_INTERVAL_HOURS=0`.
    - Never use the `myob-dashboard` config: its `.env` points at production Postgres.
    - Never press "Sync now" locally.
    - Every refreshed copy gets `DELETE FROM connections` before its first start.
    - `npm test` always runs with `DATABASE_URL=` (built into the script).
12. **Telling Allied.** Every release note quotes the version and its stage, in three parts: what you'll see, numbers that changed (with an example item), and how to check it. §7 maps any "change that" to a stage and version.

## 5. Questions for Allied

Send **Q1, Q2 and the MYOB tidy-up list this week**, because they take calendar time. Take the `bak_` copies first (Stage 0, ops step 3).

Put BN1665G and SPW12G in Q2 as worked examples. That doubles as an operational heads-up: on today's figures, both run out before PO 00023070 is estimated to land.

Send the 4 open questions from the 11 Oct preferred-supplier explainer separately; nothing waits on them.

**Decisions (six)**

| # | Affects | Question | Default if no answer |
|---|---|---|---|
| Q1 | Stage 9 | **ANSWERED 12 Oct 2026: Allied will enter the ETA as Promised Date on the PO in MYOB.** Still to confirm: (a) backfill the 10 open POs that have none (00023070 is the largest), and update the date when a supplier slips; (b) do lines on one PO ever arrive on different dates? | Promised Date is the primary ETA. A PO without one falls back to PO date + supplier lead, shown as "ETA missing — estimated" and listed so Allied can fill it in. One date per PO; raise split shipments as separate POs. |
| Q2 | Stages 9 and 11–12 show both figures; **(b) gates Stage 13** and shapes Stage 14 | **Lead times.** (a) Is Hanova's 120 days (Jiaxing 120, TANDL 102) the time until goods arrive, or a planning buffer? Measured history says Hanova 83, Jiaxing 100, TANDL 117. With 120, BN1665G is short 27 Oct–10 Dec (~1,056 units); with 83, 27 Oct–3 Nov (~177). (b) When you set a lead time on an item, does it apply whichever supplier it's ordered from (as today), or only its usual supplier? Example: N24S16M (item lead 107 days) under Hobson is planned at 107 days today, against Hobson's own 30. | (a) Use your figures; show the measured figure next to every estimate. (b) As today, under every supplier. Stage 13 ships only if you say "usual supplier only". |
| Q3 | Stages 11–12 (non-blocking) | **What counts as a gap.** (a) Free stock reaching zero, or falling below the minimum? (b) Overdue or late POs: left off the timeline, with the item shown as "runs out, end unknown"? (c) Reserve future-dated sale orders now (e.g. 00064178, 28,600 for 1 Dec)? (d) Should a gap add risk points or change the suggested qty? | (a) Zero, with the minimum drawn as a line. (b) Yes. (c) Now, as free stock already does. (d) No; revisit after two weeks of use. |
| Q4 | Stage 8 (non-blocking) | **Changing the supplier on the row.** This order only (preferred unchanged; the pick flagged with Use preferred / Keep, exactly as Compare → Choose works today), or a permanent change of preferred? Should a pick made there count as "Keep" automatically? | This order only, flagged as today. Permanent changes stay on the item page. Automatic Keep only if you ask, as a follow-up release. |
| Q5 | **Stage 14 (blocking)** | **Suggested qty for a different supplier.** When you order from a different supplier than usual, should the suggested qty be rebuilt on that supplier's lead time? Today it isn't. BN1665G's 1,779 comes from its minimum (2,771 = 6-month burn × Hanova's 120 days), whoever you order from. Rebuilt, the lead-time stock would be monthly burn × the chosen supplier's lead for items with a window minimum, unchanged for hand-set minimums, and weekly × lead for items with none (see the N24S16M example in Stage 14). Do any suppliers have MOQs or pack sizes? None are stored. | Not rebuilt until you say yes. No MOQ rounding. |
| Q6 | All (non-blocking) | **Sign-off.** Who signs off each version, and how quickly? | The buyer replies "OK 1.n". Silence after 2 business days means accepted. An explicit OK of 1.2 (On order) is needed before Stage 14, the next release that moves suggestions. |

**MYOB tidy-up (one message; nothing in the plan waits on it):**
- **Reversal documents.** Close (not delete) 00019910/00020462, 00022808 (both) and 00020624 (both). From 1.2 they are excluded by rule anyway. 00019910 is billed in full, yet MYOB shows 3,420 units still to receive on it (BN16110G, BP1690G).
- **Tong Ming 00022886:** promised 15 Sep, 28 days overdue, nothing received. Is it still coming? Please update its Promised Date.
- **Hobson 00023267/00023268:** identical lines a day apart. Is one a duplicate?
- **Cash Purchase 00022464** (9 Mar, 1-unit lines on 8 THR items): can it be closed?
- **Steel & Tube 00023248 (28 Sep) and Specialised Washers 00023309 (8 Oct):** nothing received yet, though these suppliers usually take 2 and 4 days. Are they still open?
- **Missing lead times:** please set them for Steel & Tube and Specialised Washers. Only measured figures exist.
- **AFLSA390/490:** MYOB shows 12 on order each, from a PO older than Jul 2024 that we don't sync. Is it real? If so, a small sync fix; if not, please close it.

**Stated defaults** (in the release notes; no reply needed, tell us if you disagree):
- **1.2:** daily records from 21 Aug to the 1.2 date keep the inflated On order for six items. History isn't rewritten, and the notice names those items.
- **Part-billed POs (backorders):** none in the synced history (00021049 is two POs billed together). The 1.1 sync warning would catch one.
- **1.3:**
  - the labels are "Cover excl. on order" and "Cover incl. on order";
  - the incl. figure turns red only below lead time;
  - free-stock cover keeps driving colours, risk, "Reorder now" and the Overview.
- **1.6:**
  - By item is the default, and By supplier stays permanently for raising POs;
  - same items as today, including below-minimum items at qty 0 ("covered by on order");
  - order-sheet export unchanged, with columns appended later only on request.
- **1.7:** default sort is risk, highest first. Inventory's filters and search aren't ported yet.
- **1.8:** the dropdown lists suppliers on file only; splits stay in Compare.
- **1.9–1.12:** expected dates and gaps are today-only. Recording starts in 1.10, so past dates become possible later.
- **Order of work:** Purchasing (1.5–1.8) before delivery dates and gaps (1.9–1.12). This gives Promised Dates time to be entered.

## 6. Pre-existing defects: where each one goes

| Defect | Where |
|---|---|
| Phantom incoming (≈190,727 from reversal and mirror documents, plus 3,420 on 00019910) | **Stage 2** (previewed in Stage 1) |
| The on-order rule duplicated and read in five places (`schema.ts:587-595`, `ledger.ts:690-698`, `queries.ts:1655-1662`, `:2014-2019`, `:1319-1327`) | **Stage 2:** one fragment plus a grep test |
| Supplier and Overview open-PO counts include reversal twins | **Stage 2** |
| Item page PO list: reversal documents, ordered instead of outstanding, 20-row cap | **Stage 2** |
| Stale `myob-field-reference.md:60-62` | **Stage 2** |
| Lead-time and minimum edits unlogged and unbacked | **Stage 1** (log) plus the Stage 0 `bak_` copies |
| A supplier-lead edit leaves window minimums as drift | No code change (existing and visible on the review); the §4.10 procedure says to Recalculate |
| Local `npm test` reads the production `.env` | **Stage 0** (`DATABASE_URL=` in the script) |
| Item page PO date unlabelled, no overdue state; sale-order date unlabelled | **Stage 9** |
| `coverIncludingIncoming` not returned; `cover_below_lead_time` unlabelled; "MYOB available (incl. on order)" mislabel; colspan 12 vs 13 | **Stage 3** |
| `requirementRange` undercounts splits; `kit.doubleOrders` counts lines | **Stage 4** |
| Expand panel bound to `invItems`; `CartLine` lacks committed and cover incl.; cart lacks as-at provenance (including `snapshotsFrom` and the empty return) | **Stage 5** |
| No sorting on the Order list | **Stage 7** |
| `/cart/select` and `/cart/split` unvalidated; supplier change only through the drawer; "Why this quantity" names a lead it didn't use; Undo drops a typed qty | **Stage 8** |
| Item lead applied under every supplier in the cart | Intended today. **Stage 13** only if Q2b says "usual supplier only" |
| Qty not rebuilt for a non-effective supplier | **Stage 14** (gated on Q5) |
| Overview tile vs filter; stale "Export this list"; "Used in" display vs sort; stale subtitle | **Stage 15** |
| Dead decision-queue code; "to decide" and `kitWithheldQty` badges; `sortTh` hard-wired to `invState`; drifted `minSortTh`; unstable Inventory ties | **Stage 16** |
| The `available` sort key means free stock | **Never rename** (bookmarks and old tabs use it). Comment added in Stage 3 |
| `CartLine.supplierCount` name collision | **Never rename.** By item computes lines-per-item itself |
| Open POs before the 2024-07-01 floor (AFLSA390/490) | Deferred: a known list in Stage 1; the tidy-up asks |
| Deleted POs and bills never reconciled | Deferred. Rule (b) now depends on bills, so the Stage 1 end-of-sync warning flags any item reading below MYOB |
| `supplier_lead_time` counts the ±00020624 pair twice (Steelgal) | Deferred: Steelgal has no open PO after Stage 2; the view is dropped and recreated each boot |
| Cart at a past as-at mixes today's decisions, costs and lead times; `lastCost` not bounded by as-at | Deferred: existing behaviour; the notice shows from Stage 5 |
| `myobCommitted` reads 0 against non-zero platform committed | Deferred: committed comes from open sale orders by rule |
| `changed_by` carries no person (shared key) | Deferred: needs user identity. Stage 0 stamps version and commit |
| `render.yaml` doesn't describe the live service | Documented in `RELEASING.md` (Stage 0) |
| Handbook (`info-pack.html`) out of date | Refresh after Stage 3 (cover) and Stage 8 (Purchasing) |

## 7. Where each visible change lives (for "change that")

| What Allied point at | Stage (planned version) | Main files |
|---|---|---|
| Footer version, reload banner, What's new, "reload" refusals | 0 (1.0) | `release.ts`, `insights.ts:163`, `changeLog.ts`, `dashboard.js`/`.html` |
| "On order vs MYOB", "Open purchase orders", amber "below MYOB" chip | 1 (1.1) | `openPo.ts`, `ledger.ts` (divergence), `engine.ts` |
| On order and Available, "Outstanding" PO rows, Suppliers and Overview open-PO counts | 2 (1.2) | `openPo.ts`, `schema.ts`, `ledger.ts`, `queries.ts` |
| Cover excl./incl. tiles and columns, "Below lead time" chip and filter, "On order" label | 3 (1.3) | `queries.ts`, `dashboard.js` |
| Order list header total with splits, kit count | 4 (1.4) | `cart.ts` |
| Purchasing past-date notice | 5 (1.5) | `cart.ts`, `dashboard.js` |
| By item tab, columns, drill-down, qty edit, × | 6 (1.6) | `order-list.js`, `dashboard.js` |
| Purchasing sort arrows and URL | 7 (1.7) | `order-list.js`, `dashboard.js`, `queries.ts` (export) |
| Supplier dropdown, "Your pick", toast and "Why this quantity" wording, Undo keeping qty | 8 (1.8) | `insights.ts` (validation), `cart.ts`, `dashboard.js` |
| Expected / Basis / Status, overdue and late badges, sale-order date columns | 9 (1.9) | `incoming.ts`, `leadTimes.ts`, `queries.ts`, `dashboard.js` |
| Daily PO record | 10 (1.10) | `engine.ts`, `schema.ts` |
| Gap tile, outlook panel, gap columns (Inventory and Purchasing), filters, Overview tile, CSV gap columns | 11–12 (1.11–1.12) | `projection.ts`, `queries.ts`, `cart.ts`, `dashboard.js` |
| Lead time shown under a non-usual supplier | 13 | `cart.ts` (`leadFor`) |
| Suggested qty for a picked supplier | 14 | `queries.ts` (`suggestOrderQty`), `cart.ts` |
| Overview "< 2 weeks" list, "Used in", export link, subtitle | 15 | `queries.ts`, `dashboard.js` |

**Cadence.** At one release every one to three business days, 1.0–1.8 (Purchasing done) take about three to four weeks, and 1.9–1.12 about two more. Stages 13 and 14 ship only on Allied's answers.

Source maps: `/private/tmp/claude-501/-Users-anthonyxiao-Dev-allied/29802abe-7a6a-445a-b85d-502409177b65/scratchpad/maps/`.
Live capture: `/private/tmp/claude-501/-Users-anthonyxiao-Dev-allied/29802abe-7a6a-445a-b85d-502409177b65/scratchpad/eta/`.
Gap re-derivation under the final rules: `FEEDBACK-PLAN-gap-check.py` in this folder (run it with `m` for measured leads; it reads the 13 Oct capture in the scratchpad, which is temporary).
Repo: `/Users/anthonyxiao/Dev/allied/MYOB`.

---

## Critic issues rejected

**Rejected:**
- **Ignore bills with a stale `synced_at` inside the on-order rule** (code-truth, deleted bills). It would tie a function body to sync bookkeeping, and a failed or partial bill fetch would bring the phantom back for that sync. I took the critic's alternative instead: the end-of-sync "below MYOB" warning in Stage 1.
- **Pre-flight "last sync less than one hour old"** (rollback-independence). As worded, it would close the deploy window at 18:45. The catch-up only fires when the last success is at least 6 hours old, so the real condition is that the 17:45 run succeeded.
- **"00021049 is consistent with a backorder"** (feedback-coverage, Q3). It is two POs ($211.83 and $96.95) billed together as 00021110 ($308.83). The active warning that critic asked for was adopted.
- **Keep a late-against-estimate line on the timeline at "today + N"** (feedback-coverage, optional part). That invents an arrival date. Such items count as gaps with "end unknown" instead.
- **Defer `platform_po_daily` entirely** (feedback-coverage). Rejected in part: MYOB overwrites promised dates, so the history can't be rebuilt later. It is kept as an optional separate release (Stage 10), with a named use and outside the ETA stage's acceptance. The primary-key fix was adopted.
- **A smoke test that imports `public/*.js`** (rollback-independence). Not possible as stated: `dashboard.js` reads `document` at load. It is replaced by a static check that every name `dashboard.js` imports from a public module is exported.

**Adopted, but in a different form:**
- **`x-ui-commit` header** (rollback-independence). Adopted using the version instead of the commit. The static JS has no build step to learn its commit, and every push now bumps the version.
- **"Bump the patch of the newest live line on every deploy"** (code-truth). Each release takes the next minor (`1.N.0`). A patch is used only for a fix to the newest release.

**Moot:** the out-of-order revert defects for Stages 4, 5 and 7 (code-truth, rollback-independence). Nothing is reverted out of order any more (§4.2).