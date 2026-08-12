# Allied Inventory Intelligence — Trust & Value Plan

Status: Phase 1 shipped 12 Aug 2026. Phases are ordered by trust impact and are
each independently shippable. Everything stays read-only toward MYOB; all new
data lives in `platform_*` tables and is labelled as platform data in the UI.

---

## Phase 1 — Purchasing math: count incoming supply exactly once ✅ DONE

**Problem (verified against Allied's live file):** MYOB's `QuantityAvailable`
already includes on-order stock (`available = on hand − committed + on order`
for every item with an open PO). The platform subtracted open-PO incoming *as
well as* using `available`, so incoming was double-counted: suggestions ran
small, cover treated un-arrived stock as on the shelf, and "buildable now"
counted components still on the water. 48 demand-bearing items were affected;
14 had zero/negative physical stock while looking healthy.

**Fix shipped:**
- New platform figure **free stock = on hand − committed** (physical stock not
  promised to a customer).
- Cover, buildability, blocked-component constraints, and purchase suggestions
  now use free stock; open-PO incoming is subtracted once, in the suggestion.
- MYOB "Available" remains visible as a fact on the item page, with a note that
  it includes on-order stock.
- Inventory/Purchasing/Overview/Products tables, CSV export, suggestion
  rationale, and glossary all updated to say "Free stock".

---

## Phase 2 — Inventory rows expand in place (client request)

**Goal:** review many items quickly without leaving the Inventory table.

- Clicking a row (or a chevron) expands an inline detail panel under the row;
  clicking again collapses it. A clear "Open full item page →" link keeps the
  deep-dive path.
- **No new API needed for the core panel** — the items list API already returns
  everything per row: demand split (direct vs via-builds, 90d/365d), weekly
  rate + basis, cover, risk factor breakdown with points, suggestion + full
  rationale, supplier + supplier item number, costs, flags.
- Panel layout (three compact columns):
  1. **Position** — on hand, committed, free stock, incoming, min level,
     avg cost, stock value.
  2. **Demand & cover** — 90d/365d direct + component quantities, weekly rate,
     basis, cover vs target.
  3. **Why & action** — risk factors with points, purchase suggestion with
     rationale lines, supplier, flags.
- On expand, lazily fetch the existing `/api/insights/items/:uid` once (cached
  per row) to add the 12-month demand mini-chart and last 5 movements.
- Multiple rows may stay expanded; state resets on filter/page change.

**Acceptance:** a buyer can review 20 flagged items in one sitting without
navigating away; expanding a row never triggers more than one request.

## Phase 3 — Suppliers: regions (NZ vs China vs other) + a place to manage them

**Today there is no supplier surface** — suppliers sync as (uid, name, active)
and only appear as group labels on the Purchasing page. This phase adds one.

- **Sync enrichment (read-only):** store country/city and contact fields from
  `Contact/Supplier` (already fetched, just not persisted).
- **New table `platform_supplier_meta`** (platform data, never in MYOB):
  `supplier_uid, region, region_source ('auto'|'user'), lead_time_days, notes`.
  - Region auto-defaults from the MYOB address country ("New Zealand" → NZ,
    "China" → China, anything else → Overseas–other); Allied can override, and
    the UI always shows whether the label is auto or user-set.
- **Derived lead-time estimate** per supplier: median days from PO date to
  first bill date over the synced window, shown as "derived from N orders";
  a user-entered lead time overrides it.
- **New "Suppliers" page:**
  - Table: supplier, active, region chip (editable), items supplied (as
    primary), 365d purchase value, open-PO value, lead time (derived + user
    override), notes.
  - This is the management surface: edit region, lead time, notes inline.
- **Region visibility everywhere it matters:**
  - Region chip next to the supplier on item pages and Purchasing groups.
  - Overview panel: **stock value by supplier region** and **incoming
    (open-PO value) by region** — Allied's NZ vs China split at a glance.
  - Inventory filter "Region: NZ / China / Overseas–other / Unlabelled".
- Items with demand but no primary supplier stay flagged (already built) and
  now also appear as "unlabelled region" so the split is honest about gaps.

**Acceptance:** Allied can answer "what share of our stock value and incoming
supply comes from China vs NZ?" from the Overview, and correct any mislabelled
supplier themselves in under a minute.

## Phase 4 — Close the BOM coverage gap (207 parents known vs ~hundreds real)

Derived-from-builds finds only products actually built in MYOB. Pre-packed
overseas and NZ third-party-packed products never generate builds, so their
recipes are invisible (currently 557 relationships / 207 parents, 0 user rows).

- **Bulk relationship import:** paste or upload CSV
  (`parent number, component number, qty per`) with a validation preview
  (unknown item numbers, self-references, duplicates, non-positive qty) before
  committing. All rows stored as `source='user'`. This is onboarding +
  occasional maintenance, not a core workflow — MYOB stays the data source.
- **User overrides derived:** for the same parent+component pair, the user row
  supersedes the derived row in every calculation and list (single "effective
  BOM" rule); UI shows "user — overrides derived qty X" so nothing is hidden.
- **Blind-spot worklist:** "Sold products with no known composition" — sold
  items whose name/number suggests a pack/kit/set/dressing (heuristic, labelled
  as such) with zero BOM rows, sorted by 90d sales. Gives Allied a prioritised
  list to close coverage with the bulk import.
- **Coverage metric on Data & Sync:** relationships by source, parents covered,
  and the blind-spot count, so progress is measurable.

**Acceptance:** Allied can load their known ~1,000+ relationships in one
session, and the platform shows how much composition knowledge is still
missing rather than pretending completeness.

## Phase 5 — Honest demand for never-built parents

For parents that have a BOM but no builds in the window (typically third-party
or pre-packed products), component demand driven by parent sales is invisible.
Inferring it and adding it to totals would risk double counting (the stock
effect may already appear as adjustments), so:

- Compute **potential component demand** = Σ (parent 90d sales × qty per) over
  BOM parents with zero observed builds.
- Show it on the component item page and expanded row as a clearly separated,
  labelled figure ("potential — from sales of packs we never see built; not in
  totals"), never mixed into weekly demand, cover, or suggestions.
- Flag components where potential demand is large relative to measured demand,
  so buyers know the measured number understates reality.

**Acceptance:** no double counting anywhere, but a buyer looking at a washer
used in overseas-packed kits can see the kit-driven pull that MYOB movements
don't show.

## Phase 6 — Multi-level relationships and buildability

Dressing set → bolt pack → bolts is navigable today but not computed.

- Recursive BOM explosion over the effective BOM (depth cap 6, cycle guard).
- Item page: indented component **tree** instead of one level, and a transitive
  "used in N products (directly or via sub-assemblies)" count.
- **Two buildability answers,** both labelled: "buildable from stock as-is"
  (sub-assemblies only as currently on the shelf) and "buildable if
  sub-assemblies are built first" (explode to base components). Constraint item
  shown for each.
- Overview "components blocking assemblies" counts transitive blocked parents.

**Acceptance:** for a dressing set containing a bolt pack, Allied sees both the
pack-limited and bolts-limited answer and which base component binds first.

## Phase 7 — Attention extras: unusual movements & excess stock

- **Unusual adjustments panel (Overview):** largest inventory adjustments in
  the last 30 days by absolute value (qty × avg cost), linked to the item —
  covers the brief's "unusual movements / reconciliation problems" ask without
  building an anomaly engine.
- **Excess stock view:** Inventory filter + Overview KPI for items with cover
  above a threshold (default 26 weeks, configurable) and material value;
  "value tied up beyond target cover" total. Directly serves "reduce
  unnecessary stockholding".
- Small: clamp/flag interaction review for negative free stock (data-quality
  flag already exists; ensure suggestions don't inflate from bad negatives).

**Acceptance:** Overview surfaces the big write-offs/write-ups and the
overstocked value, each one click from its evidence.

---

## Deliberately not doing (unchanged from build decisions)

- MYOB write-back of any kind, automated purchasing, warehouse entry.
- Per-location stock split (not exposed by the item master) — remains a
  documented limitation.
- Forecast-grade demand modelling; rates + labelled uncertainty only.

## Suggested order & rough effort

| Phase | Value | Effort |
|---|---|---|
| 2 — Expandable rows | Client-requested UX, immediate | 0.5–1 day |
| 3 — Suppliers & regions | New visibility Allied asked for | 1–2 days |
| 4 — BOM bulk import + override | Doubles relationship coverage | 1–2 days |
| 7 — Adjustments + excess stock | Cheap trust wins | 0.5–1 day |
| 6 — Multi-level buildability | Depth, after coverage improves | 1–2 days |
| 5 — Potential component demand | After Phase 4 gives it data | 0.5 day |

Phases 4→6→5 build on each other (coverage → explosion → inference); 2, 3 and
7 are independent and can ship any time.
