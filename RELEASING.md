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
