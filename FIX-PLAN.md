# Allied Priority Fix Plan — v2

**Status:** P0 shipped 18 Aug 2026. P1 and P2 shipped 19 Aug 2026. P3–P6 proposed. Revised after client direction on stocktake-anchored stock maths.

**What changed in v2**

- **P1 is rewritten.** Stock on hand is now derived from a **stocktake-anchored ledger**, not from MYOB's `QuantityOnHand`. This is the client's explicit direction and the data supports it.
- **P3 is clarified** — yes, we start persisting data now, and the plan states exactly which dates will be exact, which reconstructed, and which unreliable.
- **Client answers folded in.** No finish suppression; bin location synced but hidden; suppliers tagged by Allied; the "open POs netted" item dropped.
- **P0 shipped 18 Aug** — the sync no longer serves stale quantities, and MYOB's Bill of Materials was verified as genuinely maintained and promoted to the primary recipe source.
- **P1 shipped 19 Aug** — on hand, committed, free, on order and available are all computed here from Allied's own documents; counts, divergence and the audit trail are on screen.
- **P2 shipped 19 Aug** — stock value is our on hand × average cost, which caught a MYOB valuation error of exactly 100×.

---

## Part 1 — MYOB API research findings

All findings verified against the live documentation **and** Allied's actual company file (3,100 items, 3,061 inventoried) on 17 Aug 2026. Counts are from the production database.

### 1.1 Item quantity and cost fields

Source: [Inventory/Item](https://developer.myob.com/api/myob-business-api/v2/inventory/item/)

| Field | MYOB's definition | Verified on Allied's file |
|---|---|---|
| `QuantityOnHand` | "Quantity of units held in inventory" | Physical stock. Excludes on-order. **We stop treating this as truth — see P1.** |
| `QuantityCommitted` | "Quantity held in pending sale invoices" | Actually open sale *orders*, despite the wording. |
| `QuantityOnOrder` | "Quantity held in pending purchase orders" | Open POs not yet billed. |
| `QuantityAvailable` | "Calculated quantity available for sale" | `= OnHand − Committed + OnOrder`, **3,061 of 3,061 items.** Never used in analysis. |
| `AverageCost` | "Average cost when quantity on hand is ≥ zero" | Current weighted average. No history exposed. |
| `CurrentValue` | "Dollar value of units held" | `= OnHand × AverageCost`, **3,058 of 3,061** (3 outliers to chase). |
| `BuyingDetails.LastPurchasePrice` | "Price per unit when last purchased" | The figure P2 says to stop using. |

### 1.2 Product type and finish — already in the file

`CustomList1`/`2`/`3` are populated on all 3,100 items and already inside the `raw` JSON we store. No new sync work to obtain them.

- **`CustomList1` "PRODUCT TYPE"** — NUTS AND BOLTS (1,412), SCREWS (369), HYDRO (344), WASHERS (277), THREADED ROD (169), INFRASTRUCTURE PRODUCTS (169), ANCHORS (82), GASKET (76), MISC (60), blank (53), SPIRAFIX (42), MARINA (20), RIVETS (19), NAIL (6), ANTI-TAMPER (2).
- **`CustomList2` "PRODUCT FINISH"** — GALVANIZED (1,251), STAINLESS STEEL (1,063), ZINC PLATED (381), blank (113), OTHER (91), RUBBER/PLASTIC (83), BLACK (57), BRASS (48), CHEMICAL (7), XYLAN1424 (3), ALLUMINUM (3).
- **`CustomList3` "BIN LOCATION"** — blank on 2,534; populated values are customer names (HYNDS 245, NORTHPOWER 214, CSP PACIFIC 54, SYMONITE 16).

### 1.3 Bill of Materials — a real endpoint exists

Source: [Bill of Materials](https://developer.myob.com/api/myob-business-api/v2/inventory/item/bill-materials/)

`GET /Inventory/Item/?$expand=BillOfMaterials` returns each item's real recipe — component `Item.UID`, `Item.Number`, `Quantity` per component — and explicitly covers **auto-build** items. This gives P1 its kit-component and auto-build verification sample, and largely retires the planned Phase 4 CSV bulk-import in `PLAN.md`: we pull the real BOM instead of asking Allied to hand-key ~1,000 relationships. Cost is one extra pass over ~8 pages of items.

### 1.4 Per-location stock is available

`LocationDetails` returns `{ Location: {UID, Identifier, Name}, QuantityOnHand }` per item. `PLAN.md` records per-location split as "not exposed by the item master — remains a documented limitation". That is wrong; it is exposed. Not scheduled here, but the note should be corrected.

### 1.5 Historical data — what the API will and will not give us

**There is no as-at inventory endpoint.** The [Report collection](https://developer.myob.com/api/myob-business-api/v2/report/) contains only Payroll Advice, Payroll Category Summary, Tax Code Summary, Transaction Coding Summary, Profit and Loss Summary, NZ GST and Balance Sheet Summary. No inventory report, no stock-on-hand-as-at, no per-item trial balance.

**The item master is present-tense only.** No history, no as-at parameter on any quantity or cost field.

**Transaction history is fully available by date range.** Every transactional endpoint accepts an OData `$filter` on `Date`. The store currently starts at 2025-08-07 only because `SYNC_WINDOW_DAYS` is 365 — **a self-imposed limit, not an API one.** This is what makes backdating possible.

**`GeneralLedger/JournalTransaction` is not a shortcut.** It covers Inventory journals and has a `UnitCount` field, but posts at account level, not item level. No per-SKU movement.

**Conclusion:** every historical stock figure has to be computed by us from a movement ledger. Part 2's P1 defines that ledger; P3 defines how far back it is trustworthy.

### 1.5b Which endpoint every figure comes from

The plan referred to "adjustments" and "movements" without naming endpoints. For
the avoidance of doubt, this is the complete set we sync and what each one feeds.

| MYOB endpoint | Stored as | What it feeds |
|---|---|---|
| `Inventory/Item` | `myob_items` | On hand, committed, on order, available, average cost, min level, product type/finish, per-location stock. Always fully refreshed. |
| `Inventory/Item?$expand=BillOfMaterials` | `myob_item_bom` | Product recipes, including auto-build/pre-packed kits. |
| **`Inventory/Adjustment`** | `myob_adjustments` | **Stock adjustments — and therefore every stocktake anchor in P1.** |
| `Inventory/Build` | `myob_builds` | Components consumed and finished goods produced. |
| `Purchase/Bill/Item` | `myob_purchase_bills` | Goods received (stock in). Supplier credits appear as negative lines. |
| `Purchase/Order/Item` | `myob_purchase_orders` | Incoming supply not yet received. Does **not** move stock. |
| `Sale/Invoice/Item` | `myob_sale_invoices` | Goods shipped (stock out). Customer credits are negative lines. |
| `Sale/Order/Item` | `myob_sale_orders` | Committed quantity. Does **not** move stock. |
| `Contact/Supplier` | `myob_suppliers` | Supplier names, addresses, region derivation. |
| `Inventory/Location` | `myob_locations` | Location names for the per-location split. |

**Stocktakes come from `Inventory/Adjustment`, not from sales.** A physical count
is entered in MYOB as an inventory adjustment, which is why P1's anchors are
detected by scanning adjustment memos. Sales invoices are one of the four
*movement* sources applied on top of an anchor, never the anchor itself.

The four endpoints that move stock, and so make up the movement ledger, are:
**`Purchase/Bill/Item` (+), `Sale/Invoice/Item` (−), `Inventory/Build` (±) and
`Inventory/Adjustment` (±).** Purchase orders and sale orders are excluded on
purpose — they represent intent, not movement, and counting them would
double-count stock that has not arrived or not shipped.

### 1.5c Correction — Allied DO set a primary supplier (2,008 items)

**Found 19 Aug 2026.** An earlier finding recorded in `PLAN.md` — "the MYOB
primary supplier field is unused on Allied's items (0 of 3,100 set)" — was
**wrong, and the cause was our own bug**. The sync read
`BuyingDetails.RestockingInformation.PrimarySupplier`; MYOB's key is `Supplier`.
Every item therefore stored null.

**2,008 of 3,101 items carry a MYOB-assigned supplier**, across 76 suppliers:
ANZOR FASTENERS (370 items), HANOVA INTERNATIONAL (239), MACSIM FASTENERS (182),
SHANGHAI SCREW-FAST (167), MILSONS (131), BREMICK NZ (68).

Supplier resolution is now **65.3% direct from MYOB** rather than inferred from
purchase-bill history for everything. The inference fallback stays for the
remaining 1,062 items, but it is no longer standing in for data that was there
all along. Fixed in `engine.ts`, backfilled from stored `raw` JSON, deployed.

`RestockingInformation.DefaultOrderQuantity` had the same problem under the name
`DefaultReorderQuantity` (5 items).

**Lesson worth keeping:** a field-name mismatch produces a plausible, uniform
answer — every item null — that reads as a finding about the client's data
rather than a bug in ours. Any "this field is never populated" conclusion should
be checked against the raw payload before it is written down.

### 1.6 Stocktakes in MYOB — how they actually appear

This is new research, driven by the client's direction. Two findings shape the whole design.

**Finding 1 — a MYOB adjustment records a delta, not a counted quantity.** Allied's own memos give it away: *"N8S16 COUNT QTY 66 … QTY 919 ADDED AT STOCK"*. The line quantity is `+919` (the correction), while the counted figure `66` survives only as free text. So a count adjustment never hands us an absolute number — the counted quantity has to be recovered as *the running balance immediately after the adjustment*.

**Finding 2 — stocktakes are rolling and partial, not company-wide, and are identified only by free-text memo.** Across the two-year window there are 1,314 adjustments; **51** have memos matching stocktake wording, covering 1–24 items each. A sample:

| Date | Memo | Lines |
|---|---|---|
| 2026-08-10 | Gasket Stock Count - GOD | 18 |
| 2026-06-24 | Gasket Stock Count with Phil - GOD | 24 |
| 2026-04-30 | Rolling Stocktake - GOD (×3) | 4, 4, 2 |
| 2026-04-30 | Black Gasket Stock Count - GOD | 16 |
| 2026-04-30 | Ridgetyte Stock Count - GOD | 10 |
| 2026-04-20 | Physical Stock Count w/ Paul - GOD | 8 |
| 2025-09-25 | OCT STOCK TAKE DK PC | 3 |

Wording is inconsistent — "Stock Count", "Stocktake", "STOCK TAKE", "COUNT QTY". A regex finds 51 with strict wording but 159 if you match "count" loosely, so **memo matching can propose candidates but must never silently define truth.** Allied confirms each one.

**Finding 3 — the ledger is sound, and it proves why anchoring is right.**

I tested reconstruction by anchoring on the 12 Aug full sync (3,047 items were accurate at that moment) and rolling movements backwards, bounded correctly at the snapshot date:

| As-at date | Items reconstructing negative | Worst |
|---|---|---|
| 2026-07-31 | 2 | −20 |
| 2026-06-30 | 2 | −5,080 |
| 2026-03-31 | 1 | −1 |
| 2025-12-31 | 2 | −27 |
| 2025-08-07 | 1 | −1 |

**Out of 3,047 items, at most 2 fail at any horizon.** Our movement model is essentially complete — bills, invoices, builds and adjustments account for virtually all stock movement across a full year.

And the one real failure is the whole argument for the client's model. **`SPWD20G`** (M20 double coil spring washer) holds 27,880 at the anchor but reconstructs to **−5,080** at 30 June. The intervening window contains a stock-count adjustment. Rolling *backwards through a count* is invalid, because the count absorbed accumulated drift that no document explains. Rolling *forwards from* a count is exactly right.

That is precisely the model Allied asked for, and it becomes a hard rule in the engine.

---

## Part 2 — The work

### P0 — Stock quantities are stale. Fix the sync first. ✅ SHIPPED 18 Aug 2026

**Not in the client's list. It invalidated everything downstream, so it went first.**

#### The defect

MYOB does **not** update `Item.LastModified` when a transaction changes an item's
quantity — it moves only when the item record itself is edited. The sync filtered
`LastModified gt <high-water mark>`, so **items whose stock moved were never
re-fetched.**

- 177 inventoried items had stock movement after 12 Aug. Only **14** had an
  updated item record. **163 carried stale quantities.**
- 2,978 of 3,061 inventoried items shared a `last_modified` of 6–7 May 2026 (a
  bulk edit). Their quantities had only ever been refreshed by a *full* sync.
- Every incremental run since 12 Aug fetched 2–13 items and **reported success**
  while the file drifted.
- `N12S16` (M12 HEX NUT SS 316) read `qty_on_hand = 299`. It actually held
  **18,449** — we were showing 1.6% of real stock on a high-value stainless line.

#### What shipped

1. **The `items` entity is always fully refreshed** (`alwaysFull`), never
   `LastModified`-filtered. ~3,100 rows / 8 pages, a few seconds. Transactional
   entities keep incremental filtering, where MYOB does maintain `LastModified`.
2. **`$expand=BillOfMaterials`** pulled in the same pass into `myob_item_bom`.
   Fail-soft: a 4xx on the expand retries without it and records `expandError`
   in the run stats, because stale quantities are the far worse failure.
3. **`CustomList1/2/3` and `LocationDetails`** promoted to real columns, with a
   one-time backfill from the `raw` JSON already held — so P4's data was usable
   before the next sync ran.
4. **Staleness guard.** `quantities_as_of` per item; Data & Sync shows a green
   line when every stocked item is current and a red banner naming the count when
   any are not, stated as a fault rather than a data condition. The baseline is
   the most recent item read, not the last successful run, so a sync that dies
   mid-flight cannot produce a false clean reading.
5. **History floor** pinned via `SYNC_SINCE` (2024-07-01) instead of a rolling
   window that creeps forward and drops the runway the P1 ledger needs.

#### Verification

| Acceptance criterion | Result |
|---|---|
| `N12S16` matches MYOB | ✅ 299 → **18,449** |
| 31 July reconstruction produces zero negatives | ⚠️ **26 → 2** |
| Data & Sync shows a per-entity freshness figure | ✅ |
| Stocktake anchor candidates available to P1 | ✅ 28 → **51** |
| Two consecutive incremental syncs leave zero stale items | ⏳ pending — needs two scheduled runs to elapse |

Completing the two-year backfill took the 31 July reconstruction from 26
negatives to **2**: `DSSS050NP` (−20, built but never invoiced in the window) and
`DS` "MISC. CODE" (−2, one of the dead codes the brief warns about). Both are left
to P1 — stocktake anchoring is designed to absorb exactly this, and chasing them
in P0 would have meant guessing at movements no document explains.

#### MYOB's Bill of Materials is real, and is now the primary recipe source

The client could not say whether Allied maintained it, so it was verified against
build transactions before being trusted:

- **489 of 496** cross-checkable parent+component pairs match the quantities
  actually consumed by builds **exactly**; 493 within 5%.
- The 3 disagreements favour MYOB. Two rest on a *single* observed build
  (`SBKIT16350G`), and the third is 0.875 = 7/8, consistent with the offcut
  builds visible in adjustment memos.
- It covers **299 extra live parents** — all active, led by `KITST1235S` (925
  sold), `KITST1050S` (750), `SBKIT16600G8` (600), `BP1675S16.3` (387). These are
  pre-packed kits and bolt packs that never produce a build, so build-derived
  BOMs were blind to them.
- Only 7 built parents lack a MYOB recipe.

`effective_bom` now resolves **user → myob → derived**. A hand-entered row is a
deliberate correction and must not be silently overwritten by a sync; MYOB's
stated recipe beats an inference drawn from builds. Coverage went from 558
relationships / 207 parents to **1,392 / 535**.

Per-pair precedence was checked for noise: 25 derived rows survive on 17 parents
that also have a MYOB recipe, and they are legitimate — `BP24100G` + `WR24503G`
at 8 per unit across 10 builds, and fractional cut-to-length rod lines such as
`SBKIT16510G` + `1THR16G` at 0.448. These are real consumption MYOB's nominal
recipe omits, so keeping them makes component demand more complete.

**Open question for Allied:** 250 of the 299 MYOB-only parents have not sold in
12 months. All are flagged active — worth confirming whether some are dormant kit
definitions.

#### Operational note

The local dev server runs under `tsx watch`, which restarts on any source edit
and **kills an in-flight sync** (this interrupted one run at the builds entity,
leaving adjustments a year short). Stop the watcher before running a full sync.

---

### P1 — Stocktake-anchored stock ledger ✅ SHIPPED 19 Aug 2026

**Client direction:** *"whenever there is a stock count and they have this in MYOB, that is the reference point. All future numbers should be sales, stock movements, new stock in, etc. adjusted based on that reference point, until the next time they do a stock take."*

This replaces the previous P1. We no longer read `QuantityOnHand` as truth; we compute it.

#### 2.1 The math

For item *i* and date *D*:

**Anchor.** `A(i,D) = (tₐ, qₐ)` — the most recent trusted physical count at or before *D*, where `tₐ` is the count date and `qₐ` the counted quantity. Anchor precedence:

| # | Source | Trust | How `qₐ` is obtained |
|---|---|---|---|
| 1 | `platform_stock_count` — Allied-entered count (UI or CSV) | Highest | Entered directly as an absolute |
| 2 | MYOB adjustment confirmed by Allied as a stocktake | High | Running balance immediately **after** that adjustment |
| 3 | No count on record | Low — labelled | Epoch baseline back-computed from the earliest reliable snapshot |

**Movement ledger.** `M(i, t₁, t₂]` = sum of stock-moving document lines dated in `(t₁, t₂]`:

```
M = + purchase bill lines        (goods received; supplier credits are negative → net out)
    − sale invoice lines         (goods shipped; customer credits are negative → add back)
    ± build lines                (positive = produced, negative = consumed)
    ± adjustment lines           EXCLUDING the anchor adjustment itself
```

The exclusion matters: the count adjustment is already baked into `qₐ`. Counting it again double-applies the correction.

**On hand.**

```
on_hand(i, D) = qₐ + M(i, tₐ, D]
```

**Committed** — derived independently, never taken from MYOB:

```
committed(i, D) = Σ qty on sale-order lines where
                    order.date ≤ D
                    AND the order was still open at D
                        (not yet invoiced, or its invoice is dated after D)
```

Committed is unaffected by the anchor — it is forward-looking demand, not stock history.

**Free stock and incoming:**

```
free(i, D)     = on_hand(i, D) − committed(i, D)
incoming(i, D) = Σ open PO line qty not yet billed at D
```

MYOB's `QuantityAvailable` stays visible as a labelled MYOB fact and is **never** used in analysis, because it includes on-order (verified 3,061/3,061).

**Divergence — the trust feature:**

```
divergence(i) = on_hand_ledger(i, today) − myob_qty_on_hand(i)
```

Ranked by `|divergence × average_cost|`.

#### 2.2 Hard rules, derived from the data

1. **Never roll the ledger backwards through a count.** For `D < tₐ`, fall back to the previous anchor. Proven by `SPWD20G` (§1.6).
2. **Adjustments are deltas, not counts.** Recovering `qₐ` from a MYOB count requires the running balance at that moment.
3. **Exclude the anchor adjustment** from the movement sum.
4. **Memo matching proposes, Allied confirms.** No regex silently defines an anchor.

#### 2.3 An honest word on "trusting us more than MYOB"

A complete ledger and MYOB compute on-hand the same way — by applying every transaction. So the ledger will usually **agree** with MYOB, and it should. Where it earns more trust than MYOB is in four specific places, and these are the deliverable:

1. **It is anchored to physical reality.** After each count, accumulated drift is wiped. MYOB carries error forward silently until someone notices.
2. **Every number shows its working** — anchor, anchor date, and every document since, as a drillable audit trail. MYOB shows a figure with no derivation.
3. **Divergence is detected and priced.** Where we disagree with MYOB we say so, quantify it in dollars, and show which documents explain the gap. This is what will actually catch the double debit/credit PO-receipt artefact the brief warns about.
4. **Allied's own counts can override MYOB entirely.** If they counted something and never entered it in MYOB, our number reflects reality and MYOB's does not.

We should set this expectation with the client directly: **the goal is not a different number, it is a number they can audit** — plus the ability to override MYOB with their own counts. Promising "different and better" would be dishonest; promising "auditable, anchored, and correctable" is exactly what we can deliver.

#### 2.4 Build

1. **`platform_stock_count`** table — `(item_uid, count_date, counted_qty, source, source_ref, entered_by, note)`. Sources: `myob_adjustment` | `manual` | `csv_import`.
2. **Stocktake detection.** Scan adjustment memos for count wording, present candidates on a **"Confirm stocktakes"** screen showing date, memo, affected items, adjustment delta, and the resulting post-adjustment balance. Allied confirms or rejects each. Surface the free-text counted quantities from the memo as a cross-check hint — displayed, never parsed as authoritative.
3. **Manual + CSV count entry**, so Allied can anchor items MYOB never had a count for. This is the path to genuinely beating MYOB.
4. **Ledger engine** implementing §2.1, materialised per item per day for query speed, rebuildable from scratch.
5. **Divergence panel** — every item where ledger ≠ MYOB, ranked by dollar impact, with the audit trail beside it.
6. **Audit trail UI** — click any on-hand figure to see: anchor (source, date, qty), then every document since with running balance.
7. **Coverage metric** — how many items are anchored to a real count vs a back-computed baseline, and how old each anchor is. This tells Allied where to count next, and is a genuinely useful output in its own right.

#### 2.5 Shipped — what is live

- **The ledger drives the product.** `queries.ts` reads no MYOB quantities;
  everything flows through the `item_position` view. A build-failing guard
  (`scripts/check-ledger-boundary.mjs`) stops anything reaching back to MYOB's
  raw figures — it caught a real leftover on its first run.
- **On hand, committed, free, on order and available are all computed here.**
  Committed already disagrees with MYOB on **27 items, $2,402 at stake**;
  `WR16503G` carries 5,000 units on open orders that MYOB reports as 0.
- **Stock counts page** — confirm detected stocktakes (54 candidates), enter a
  single count, or paste a counting sheet. Verified: confirming one gasket
  stocktake created 18 anchors, each carrying its drift.
- **Audit trail on every item** — the anchor, then every document since with a
  running balance, MYOB's figure beside it.
- **Divergence panel** on Data & Sync, priced by what the gap is worth.
- **Daily position snapshots**, immutable, written at the end of every sync.
- **`docs/myob-field-reference.md`** — the written derivation reference.

**One consequence worth knowing.** The conversion balance is dated at cutover
(18 Aug 2026), so it outranks every stocktake recorded before it. Confirming
historical stocktakes therefore improves *historical* answers and drift
insight, but does not move today's figure. Only counts taken from now on change
the current number — which is the intended behaviour, not a limitation to work
around.

#### Original acceptance criteria

- On hand, committed and free stock are each computed by us, each with a visible derivation.
- Every item shows its anchor, anchor date, anchor source, and days since.
- The divergence panel is empty, or every entry has a documented explanation.
- Reconciles against Allied's manual month-end analysis for a sampled set including: items with open POs (122 available), kit components, auto-built items, items with supplier credits (8 negative bill lines), and **at least one item covered by a recent rolling stocktake**.
- `SPWD20G` produces a correct on-hand figure from its post-count anchor.

---

### P2 — Value stock at average cost ✅ SHIPPED 19 Aug 2026

Depended on P0 and P1.

#### What the brief asked for, and what was actually there

The brief said to "remove the current derivation that infers stock value from
purchase orders and sales data". **No such derivation existed.** Valuation was
already reading MYOB's stored `CurrentValue` field. Worth recording so nobody
goes looking for code that was never written.

The real defect was subtler and only appeared once P1 landed: `CurrentValue` is
MYOB's *own* on hand × average cost. Reading it after P1 would have priced our
quantity at MYOB's — so a count entered by Allied would move the stock figure
but leave the money unchanged.

#### What shipped

- **Stock value = our on hand × `AverageCost`**, computed here, everywhere it
  appears: item view, expanded rows, inventory list, Overview total, region
  breakdown, excess-stock value and the purchasing export.
- MYOB's stored value is kept as a comparison column only and surfaced in the
  divergence panel, never used as an input.
- The purchasing CSV gains **Average cost** and **Stock value** columns.
- Last buy price remains unused, as Allied's policy requires.
- The Overview KPI, previously labelled "Stock value (MYOB)", now says
  "Stock value" because it is ours.

#### The three CurrentValue outliers, resolved

Two are rounding dust on zero-quantity items (`N30S16` at −$0.01, `FGHP` at
+$0.01). The third is a **real MYOB error**: `SW101616G4` holds 180 units at
$1.8667, which is $336.00, and MYOB records **$3.36** — out by exactly 100×.
Computing the value ourselves corrects it.

#### Verified

| Check | Result |
|---|---|
| `SW101616G4` valued correctly | ✅ $336.00 (MYOB stored $3.36) |
| Aggregate stock value | **$872,346.85** vs MYOB's stored $872,106.89 |
| Items whose value differs from MYOB | 4, totalling **$239.96** |
| Divergence panel covers value | ✅ alongside on hand and committed |

The $239.96 gap is the 100× error less accumulated per-item rounding in MYOB's
stored figures, which we avoid by computing at full precision.

**Still to do:** reconcile the aggregate against an average-cost valuation report
run out of MYOB by Allied. That is their check, not ours, and it is the same
month-end run that validates P1.

---

### P3 — Point-in-time date vs rolling window

Depends on P0 and P1. Hard external deadline: the August inventory run.

**Direct answer to the question asked: yes.** From the moment P3 ships we persist an immutable daily record, so any date from then on is an exact read rather than a reconstruction, and any window can be selected over it. Specifically, three things get stored:

1. **`platform_item_snapshot`** — `(as_at_date, item_uid, on_hand, committed, on_order, average_cost)`, written once per day per item and never mutated.
2. **The full movement ledger** from P1, retained permanently — this is what lets any historical date be recomputed and audited, not just read.
3. **`platform_stock_count`** — every anchor, permanently.

Together these mean the client can select any as-at date and any rolling window, and both stay auditable.

#### Confidence tiers — what is exact and what is not

| Tier | Date range | Basis | Label in UI |
|---|---|---|---|
| **Counted** | Any date after a confirmed stocktake for that item | Anchor + documents since | "Anchored to count of *dd mmm*" |
| **Snapshot** | From P3 go-live onward | Stored daily snapshot | "Snapshot" |
| **Reconstructed** | Before go-live, after the item's last anchor | Ledger rolled from anchor | "Reconstructed from *n* movements" |
| **Unreliable** | Before the item's earliest anchor | Back-computed baseline | "No count on record — indicative only" |

**31 July 2026 will always be reconstructed** — no snapshot existed. That is fine and it is accurate, but it must be labelled honestly for the August run.

#### Build

1. **Two visually and functionally distinct controls:** an **as-at date** (default: most recent month end) governing stock position, and a **rolling window** (default: **6 months**, down from 12) governing sales, consumption and demand.
2. All derived metrics — weekly demand, weeks of cover, below-minimum flags, purchasing suggestions — respect the selected window. Today it is hard-coded at 90/365 days throughout `queries.ts`; it becomes a parameter.
3. **Committed as-at.** Spike first: check whether `Sale/Invoice/Item` references the originating `Sale/Order`. If it does, an order was open on *D* when `order.date ≤ D < invoice.date` and committed reconstructs properly. If it does not, show as-at *on hand* only, state plainly that committed cannot be reconstructed before snapshots began, and **do not fabricate it**.
4. **Average cost as-at** uses today's average cost against historical quantity, explicitly labelled as an approximation. MYOB exposes no cost history.
5. **Validation control — spike done 21 Aug 2026. Result: blocked on a scope.**
   `Report/BalanceSheetSummary` and every `GeneralLedger/*` endpoint return
   **401** on the token we hold, while `Inventory/Item` returns 3,103 rows on
   that same token. It is a permission problem, not a parameter one: reports and
   the general ledger sit behind the **`sme-general-ledger`** scope, which this
   connection was never granted.

   Obtaining it needs `sme-general-ledger` added to `MYOB_SCOPES` **and Allied
   re-authorising**, since an existing token cannot gain scope. That is a client
   decision rather than a code change: it widens our access from inventory to
   their general ledger — a broader permission over their financial accounts
   than anything the platform holds today.

   Whether the report even accepts an as-at date remains unknown; the docs do
   not say and it cannot be tested until the scope exists.

   **Recommendation:** raise it with Allied only if they want an *automated*
   second opinion on historical valuations. Their own MYOB valuation report
   already provides the manual check, so this is a convenience, not a
   dependency.

#### Backdating — how far, and how

**Recommendation: pull transaction history back to 1 July 2024 (two years).**

Reasoning: it spans at least two of Allied's rolling stocktake cycles, so most items get a real anchor rather than a back-computed baseline; it comfortably covers the 6- and 12-month rolling windows; and it is bounded enough to backfill in one run. Going further adds little — anchors older than a cycle are superseded anyway.

Mechanically:

1. Raise `SYNC_WINDOW_DAYS` and run a **one-off deep sync** with `$filter Date ge datetime'2024-07-01'` across bills, invoices, sale orders, purchase orders, builds and adjustments. This is ordinary paging, just more pages — no special API access needed.
2. **Back-compute the epoch baseline** for each item: `epoch_qty = on_hand(12 Aug 2026 snapshot) − M(i, epoch, 12 Aug 2026]`. The 12 Aug full sync is the only point where MYOB quantities are known-good for all 3,047 items, so it is the pivot. Label the result "no count on record — indicative only".
3. **Run the ledger forward** from the epoch. Every confirmed stocktake re-anchors and wipes accumulated error, so early-period uncertainty does not propagate past the first count.
4. **Re-run the completeness check** (§1.6) over the deeper history. Any item reconstructing negative between two anchors indicates either a missing document type or an unconfirmed stocktake — both are findings worth chasing.

#### Not building

No prior-year or two-year comparison view. Declined by the client.

#### Done when

The client can pull the 31 July stock position beside a 6-month rolling consumption view, each figure labelled with its confidence tier, and it reconciles against their manual August month-end run.

---

### P4 — Independent facets plus free-text tags

Depends on P0, which persists the custom lists. **Simplified by client direction — no suppression work.**

1. `product_type` and `product_finish` as **independent** filterable, sortable columns from `CustomList1` and `CustomList2`. Never concatenated. No compound categories anywhere.
2. **Show every value that exists**, including ZINC PLATED, OTHER, BRASS and blank. Allied filters for themselves. No hardcoded allow-list, no hidden values — this also removes a standing maintenance burden.
3. Blank finish or type renders as an explicit "(not set)" facet so those 113 and 53 items stay reachable rather than vanishing from filters.
4. **Free-text tags** — new `platform_item_tags (item_uid, tag)`, many per item, user-created, filterable. This is also how "never require new item codes" is honoured: classification problems get solved with tags on the existing SKU.
5. **Bin location** (`CustomList3`) is synced and stored but **not surfaced anywhere yet**, per client direction. Available the moment they want it.
6. Filter state lives in the URL so a view like "stainless washers" is shareable.

**Done when** the client can reach "stainless washers" through two independent facets plus arbitrary tags, with every real value selectable.

---

### P5 + P6 — The purchasing cart. Build as one piece of work. 🔴 LARGEST ITEM

The brief separates these, but they are the same rebuild: P5's editable quantities need the same persistence P6's split-orders need. Doing them separately means building the cart twice.

#### Why the current design cannot be patched

`purchasing()` in `src/insights/queries.ts:1110` is a **stateless recomputation, not a cart**:

- Line 1121 buckets every item under exactly one key — `item.supplierName`, resolved as *preferred → MYOB primary → inferred from bills*. **One item, one bucket, by construction.** This is the P6 defect.
- The bucket key is the supplier **name**, not UID. Same-named suppliers silently merge; everything unresolved collapses into one "No known supplier" group.
- **There is no cart table anywhere.** Nothing is persisted, so there is nowhere to put an edited quantity, a removal, a supplier choice or a split. Every P5 and P6 requirement needs state that does not exist.
- `platform_item_suppliers` holds **exactly one row across the entire database** — the multi-supplier feature has never run against real data, which is consistent with the client reporting it broken.

#### Build

**Stage 1 — fan-out (fixes the P6 defect).** Group by supplier **UID**, and emit one line per (item × tagged supplier), so an item with three suppliers appears in all three buckets. Effective supplier becomes the *default selection*, not the only option. Adding or removing a supplier reflects immediately — the cart re-derives from `platform_item_suppliers` on read, with no recalculation to re-trigger.

**Stage 2 — a real cart.** New `platform_purchase_cart (item_uid, supplier_uid, qty, state, updated_at)` with `state` ∈ `suggested | edited | removed | selected | split`. Suggested quantities are computed as now but become editable; removals and choices persist across reloads.

**Stage 3 — double-order protection, all five guard rails.**
1. **Badge on every multi-supplier line, in every bucket** — "also under 2 other suppliers", visible without hovering.
2. **Linked view** — from any line, all suppliers for that item side by side with lead time, last/average cost, on-hand and incoming.
3. **Select-one** — pick a supplier, the item drops out of the other buckets in a single action.
4. **Explicit split** — deliberately keep an item across suppliers and split the quantity, shown as total plus per-supplier split so it reads as intentional.
5. **Pre-export check** — flag any item still under multiple suppliers with no explicit split.

**Stage 4 — export.** Real `.xlsx` per supplier, formatted to paste straight into an email. Reasoning columns travel with each line: consumption over the selected window, weeks of cover, supplier lead time, incoming PO quantity.

#### Not building

**No automatic sending of purchase order emails.** Rejected by the client as too risky. The endpoint is export and copy-paste.

#### Prerequisite — Allied tags their own items

Per client direction, Allied will tag multi-supplier items themselves rather than us seeding from purchase history. Two consequences to manage:

- **Stages 1–3 cannot be demonstrated until some items are tagged.** We should ask for a **small starter set — around 20 items with 2+ suppliers each, ideally including some stainless lines** — before the demo, so the guard rails can be shown working on real data.
- We will build a **throwaway seeded fixture** for our own testing so development is not blocked waiting on them. It never ships to production.

---

### Cross-cutting

- **Excel export** on every view touched: inventory, purchasing cart, supplier list. Move off hand-rolled CSV to a real `.xlsx` writer.
- **Show the working** everywhere a number is derived. P1's audit trail is the template.
- **Never require new item codes.** Tags and flags on existing SKUs only; P4 delivers the mechanism.
- **Validate against real MYOB data.** Force through every code path: double debit/credit on PO receipt, non-supplier contacts in the card file, open POs with no identifiable supplier, the 8 negative (credit) bill lines, and the `SPWD20G` count case.

---

## Part 2b — Backlog (raised, not scheduled)

### B1 — Let Allied choose what the average cost is based on

**Raised 19 Aug 2026 while researching P2. Deliberately not built — Allied's
direction was to leave average cost as it is for now.**

Today stock value is *our* on hand × **MYOB's** `AverageCost`. That field is a
moving weighted average with **no time window**: it spans the entire life of the
item's stock, re-weighted by quantity on every receipt. Allied cannot configure
how MYOB calculates it, and the API exposes no setting to change it — verified
against the v2 documentation.

The open question is whether Allied would rather value stock on a *recent* cost
— the last 6 or 12 months of buying — instead of a lifetime average that still
carries prices from years ago.

#### What the API makes possible

| Field | Writable? | Set on Allied's file |
|---|---|---|
| `AverageCost` | Read-only, MYOB-calculated | 1,000 of 1,006 stocked items |
| `BuyingDetails.StandardCost` | **Writable** — the one native lever | 163 items |
| `BuyingDetails.LastPurchasePrice` | Read-only | 2,125 items |
| Purchase bill `UnitPrice` | Already mirrored here, every line | 389 items bought in last 12m |

#### What each basis would value the stock at

Measured across the same items at the same moment:

| Basis | Total stock value |
|---|---|
| Our latest buy price | $861,063 |
| **MYOB average cost (current)** | **$861,742** |
| Our 6-month weighted average | $868,907 |
| Our 12-month weighted average | $876,174 |
| StandardCost where set, else average | $888,540 |
| MYOB last purchase price | $892,739 |

A spread of about **$31,700 (3.6%)** — material at month end, not enormous.

#### The constraint that shapes the design

**Coverage, not accuracy.** A rolling window can only price the items actually
bought inside it:

| Basis | Stocked items it can price |
|---|---|
| MYOB average cost | **1,000 of 1,006** |
| Our 12-month weighted average | 389 |
| Our 6-month weighted average | 276 |

So a rolling average can never *replace* MYOB's — 60–70% of stocked items would
fall back to it anyway. It can only sit on top as a preference.

#### Proposed shape, if it is ever picked up

A configurable cost basis with an explicit fallback chain, defaulting to today's
behaviour so nothing changes unless Allied ask for it:

1. Allied's own per-item override, if set
2. MYOB `StandardCost`, if set
3. Our rolling weighted average over a configurable window, where enough
   purchases exist
4. MYOB `AverageCost` — the backstop that always works

Each item would show which rule priced it, so a hybrid valuation stays auditable.
The UI would let Allied change the window and see the total move before
committing.

**Two caveats to put to the client first.** Any basis other than MYOB's average
**will not reconcile to their MYOB valuation report**, which is currently the
acceptance test for both P1 and P2. And a rolling average built from bill lines
cannot see freight or landed costs that MYOB folds into its own average.

---

## Part 3 — Sequencing

```
P0 sync + freshness ──> P1 stocktake-anchored ledger ──┬──> P2 valuation
   (blocker)              (the new core)               │
                                                       ├──> P3 as-at + windows  [Aug deadline]
                                                       │
                          P4 facets + tags ────────────┴──> P5+P6 cart rebuild
```

| # | Item | Size | Notes |
|---|---|---|---|
| P0 | Sync freshness + BOM + custom fields | S–M | ✅ Shipped 18 Aug 2026. |
| P1 | Stocktake-anchored ledger | **L** | ✅ Shipped 19 Aug 2026. Now the core of the product. |
| P2 | Average-cost valuation | S | ✅ Shipped 19 Aug 2026. Caught a 100× MYOB error. |
| P3 | As-at + rolling window + backfill | L | Snapshots, confidence tiers, 2-year backfill. |
| P4 | Facets + tags | S–M | Reduced — no suppression logic. |
| P5+P6 | Cart rebuild | XL | New persistence, fan-out, guard rails, xlsx. |

**Recommended order: P0 → P1 → P2 → P3 → P4 → P5+P6.** P0, P1 and P2 are shipped; P3 is next and carries the only hard external deadline.

P1 now sits directly behind P0 rather than beside P2, because on-hand is an input to valuation, cover, below-minimum flags and every purchasing suggestion. P2 follows immediately and is nearly free. P3 must not slip — it is the only item with a hard external deadline. The cart rebuild is the largest piece and should not start until the numbers beneath it are trusted, or it will be built twice.

**Note on P1's new size.** The rewrite moves roughly a week of work into the critical path. If the August run is at risk, the sequencing that protects it is P0 → P1 (ledger + anchors, no UI polish) → P3 (as-at + 6-month window), deferring P1's divergence panel and audit-trail UI to immediately after. The maths ships; the presentation follows.

---

## Part 4 — Client decisions (resolved)

| # | Question | Decision |
|---|---|---|
| 1 | Product finish suppression | **No suppression.** Show every value; Allied filters. Removes hardcoding and ongoing maintenance. |
| 2 | `CustomList3` bin location | **Sync and store, surface nowhere yet.** Ready when they want it. |
| 3 | How far to backdate | **1 July 2024 (two years)**, back-computed from the 12 Aug 2026 pivot, re-anchored at each confirmed stocktake. Detail in P3. |
| 4 | Multi-supplier tagging | **Allied tags their own.** We need ~20 tagged items before the P5/P6 demo; a throwaway fixture unblocks development meanwhile. |
| 5 | "Open POs sometimes netted" | **Dropped.** `QuantityAvailable = OnHand − Committed + OnOrder` for 3,061 of 3,061 items, no exceptions. No evidence of the reported inconsistency; it was P0 staleness. |

### Still open

1. **Confirming historical stocktakes.** Detection proposes candidates, but someone at Allied has to confirm which of the 28 memo matches were genuine counts — and whether any counts happened that never reached MYOB. This is the one input only they can supply, and P1's accuracy depends on it.
2. **`SPWD20G` and the second anomaly.** Two items fail the ledger completeness check. We will diagnose both during P1; if they turn out to be a document type we do not sync, that is a P0 addition.
