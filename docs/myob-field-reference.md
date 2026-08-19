# MYOB inventory field reference

**Purpose.** The client's P1 asks for an auditable, field-by-field statement of
how MYOB derives every inventory quantity and value, so the next person does not
re-derive it from guesswork. Every claim below was checked against the live
documentation **and** verified against Allied's own company file (3,100 items,
3,061 inventoried). Where the two disagree, the file wins and the discrepancy is
stated.

Last verified: 19 August 2026.

---

## 1. Item master quantities and values

All fields below come from the item master:
**[`/Inventory/Item`](https://developer.myob.com/api/myob-business-api/v2/inventory/item/)**

| Field | MYOB's definition | Verified behaviour | Do we use it? |
|---|---|---|---|
| `QuantityOnHand` | "Quantity of units held in inventory" | Physical stock. Excludes on-order. | **No** — replaced by the platform ledger. Kept for comparison only. |
| `QuantityCommitted` | "Quantity of the item held in pending sale invoices" | Wording is wrong: it reflects open sale **orders**, not invoices. Disagrees with our own count on 19–25 items. | **No** — we sum open sale-order lines ourselves. |
| `QuantityOnOrder` | "Quantity of the item held in pending purchase orders" | Open POs not yet billed. | **No** — we sum unreceived PO lines ourselves. |
| `QuantityAvailable` | "Calculated quantity of the item available for sale" | `= OnHand − Committed + OnOrder`, on **3,061 of 3,061** items. It counts stock that has not arrived. | **Never.** Using it double-counts incoming supply. |
| `AverageCost` | "Item's average cost when the quantity on hand is ≥ zero" | Current weighted average. **No history is exposed.** | Yes — for valuation (P2). |
| `CurrentValue` | "Dollar value of units held in inventory" | `= OnHand × AverageCost` on **3,058 of 3,061**; 3 outliers unresolved. | Indirectly — we compute value from our own on-hand × average cost. |
| `BuyingDetails.LastPurchasePrice` | "Tax inclusive price per unit when last purchased" | Last invoice price, not an average. | **No** — P2 requires average cost. |
| `BuyingDetails.StandardCost` | "Standard purchase price for one buying unit" | Rarely maintained on Allied's file. | No. |
| `CustomList1` | User-defined list 1 | Labelled **PRODUCT TYPE** on Allied's file. | Yes (P4). |
| `CustomList2` | User-defined list 2 | Labelled **PRODUCT FINISH**. | Yes (P4). |
| `CustomList3` | User-defined list 3 | Labelled "BIN LOCATION" but holds **customer names** — consignment marker. | Stored, deliberately not surfaced. |
| `LocationDetails[]` | Per-location holdings | `{ Location, QuantityOnHand }`. 1,002 items across 1,152 location rows. | Stored; not yet surfaced. |
| `LastModified` | Record last-changed timestamp | **Does not move when a transaction changes a quantity.** Only when the item record itself is edited. | Used for sync, but never for the items entity — see §4. |

---

## 2. What actually moves stock

Four endpoints move inventory. Everything else is intent, not movement.

| Movement | Endpoint | Sign | Notes |
|---|---|---|---|
| Goods received | [`/Purchase/Bill/Item`](https://developer.myob.com/api/myob-business-api/v2/purchase/bill/item_bill/) | **+** | Supplier credits appear as **negative** lines on bills (8 such lines on Allied's file), so they net off automatically. |
| Goods shipped | [`/Sale/Invoice/Item`](https://developer.myob.com/api/myob-business-api/v2/sale/invoice/) | **−** | Customer credits are negative lines and add stock back. |
| Assembly | [`/Inventory/Build`](https://developer.myob.com/api/myob-business-api/v2/inventory/) | **±** | Positive lines are finished goods produced, negative lines components consumed, in one transaction. |
| Correction / count | [`/Inventory/Adjustment`](https://developer.myob.com/api/myob-business-api/v2/inventory/adjustment/) | **±** | Includes physical stocktakes — see §3. |

**Not movements.** `/Purchase/Order/Item` and `/Sale/Order/Item` represent
intent. Counting them as movement double-counts stock that has not arrived or
not shipped. They feed on-order and committed respectively, and nothing else.

**Auto-build.** Auto-built items do **not** generate `Inventory/Build`
transactions, so their composition is invisible to any BOM inferred from builds.
Their recipes come from
[`/Inventory/Item?$expand=BillOfMaterials`](https://developer.myob.com/api/myob-business-api/v2/inventory/item/bill-materials/),
which covers them explicitly. Verified: MYOB's BOM matches build-observed
quantities on **489 of 496** cross-checkable pairs, and adds 299 live parents
that builds never reveal.

**PO receipt.** Receipt is recorded by the *bill*, not the order. `ReceivedQuantity`
on PO lines is **0 on every line** in Allied's file, so it cannot be used to
detect receipt. Watch for the double debit/credit artefact described in §3.

---

## 3. Stocktakes, and the delta-not-count trap

A physical count is entered in MYOB as an **inventory adjustment**, never as a
sale. This matters because the adjustment stores **the correction, not the
counted quantity**. Allied's own memo makes it plain:

> `N8S16 COUNT QTY 66 … QTY 919 ADDED AT STOCK`

The line quantity is `+919`; the counted figure `66` survives only as free text.
So a counted quantity must be recovered as the running balance immediately
*after* the adjustment, never read directly.

**Offsetting pairs.** Counts frequently contain lines that cancel on the same
item — the `MHS16ES16` count posts `−6`, `−570`, `+570`, where the real
correction is 6 units. Summing absolute line values overstates drift across all
counts by **4.3×** ($36,563 gross against $8,960 net). Always net per item
before summing. This is the double debit/credit artefact the brief warns about.

**Detection is not identification.** Memo wording is inconsistent — "Stock
Count", "Stocktake", "STOCK TAKE", "COUNT QTY". A strict pattern finds 51
adjustments, a loose one 159. Detection may propose candidates; **a person must
confirm**. No regex defines an anchor.

**Never roll backwards through a count.** A count absorbs drift that no document
explains, so reconstructing back past one produces nonsense — `SPWD20G` holds
27,880 but reconstructs to −5,080 across its count. The ledger refuses to answer
for dates before an item's applicable count rather than return a wrong number.

**Dates carry no time.** 0 of 1,314 adjustments (and 0 invoices, bills or
builds) have a time component, so same-day ordering is unknowable. A count is
therefore treated as the last word on its date; movements apply from the day
after.

---

## 4. Sync semantics that are easy to get wrong

**`Item.LastModified` does not track quantity changes.** Of 177 items whose
stock moved after 12 Aug 2026, only **14** had a touched item record; 2,978 of
3,061 items still carried a `LastModified` from a bulk edit on 6–7 May. A
`LastModified`-filtered incremental sync therefore never re-fetches the items
whose stock actually moved, and reports success while serving month-old figures.
`N12S16` read 299 units against a real 18,449.

**The items entity is always fully refreshed** (~3,100 rows / 8 pages) and never
`LastModified`-filtered. Transactional entities keep incremental filtering,
where MYOB does maintain the field. `quantities_as_of` records when each row was
last read, and Data & Sync reports staleness as a fault.

**History depth.** Transaction endpoints accept an OData `$filter` on `Date`, so
any range can be pulled. Probed on the live file: invoices reach back to
**2011-12-12**, bills to **2021-07-05**, adjustments and builds only to
**2023-04-03**, and there is **no opening-stock entry anywhere**. A stock ledger
computed from zero would therefore silently omit years of receipts — which is
why the platform uses a conversion balance instead (§5).

**No historical inventory endpoint exists.** The
[Report collection](https://developer.myob.com/api/myob-business-api/v2/report/)
offers only payroll, tax, P&L, GST and balance-sheet reports. There is no
stock-on-hand-as-at and no per-item trial balance.
`GeneralLedger/JournalTransaction` covers inventory journals but posts at
account level, so it yields no per-SKU movement.

---

## 5. What the platform computes instead

| Figure | Source | Never |
|---|---|---|
| **On hand** | Last physical count (or the conversion balance), plus our own movement ledger since | `QuantityOnHand` |
| **Committed** | Our sum of open sale-order lines | `QuantityCommitted` |
| **On order** | Our sum of unreceived purchase-order lines | `QuantityOnOrder` |
| **Free stock** | Our on hand − our committed | — |
| **Available** | Our free stock + our on order, kept distinct from free stock | `QuantityAvailable` |
| **Stock value** | Our on hand × `AverageCost` | Any PO/sales-derived valuation |

MYOB's own figures are carried alongside as comparison columns so divergence is
shown and explained, never resolved silently. A build-failing guard
(`scripts/check-ledger-boundary.mjs`) prevents any file outside the sync, the
schema and the ledger from reading MYOB's raw quantities.
