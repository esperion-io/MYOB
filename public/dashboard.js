/* Allied Fastenings — Inventory Intelligence (read-only MYOB). */

const main = document.getElementById("main");
const nav = document.getElementById("nav");
const syncDot = document.getElementById("sync-dot");
const syncChipText = document.getElementById("sync-chip-text");
const keyOverlay = document.getElementById("key-overlay");
const keyForm = document.getElementById("key-form");
const keyInput = document.getElementById("key-input");
const keyError = document.getElementById("key-error");

/**
 * One glossary for the whole app. `short` powers hover tooltips on columns and
 * tags; `long` fills the help drawer and the Data & Sync definitions list, so
 * the wording can never drift between them.
 */
const TERMS = {
  free_stock: {
    label: "Free stock",
    short: "On hand minus committed — physical stock not already promised to a customer.",
    long: "On hand − committed. This is what cover, buildability and purchase suggestions use, so stock promised to a customer is never counted as if it were spare.",
  },
  myob_available: {
    label: 'MYOB "Available"',
    short: "MYOB's own figure — it already includes stock on order, so it counts stock that hasn't arrived.",
    long: "MYOB's item-master availability = on hand − committed + on order. Because it counts stock still on the water, the platform shows it as a fact but never uses it in analysis.",
  },
  committed: {
    label: "Committed",
    short: "Stock already promised to customers on open sales orders.",
    long: "Quantity MYOB has reserved against open sales orders. Sorting by this shows what is most spoken for.",
  },
  incoming: {
    label: "Incoming",
    short: "Quantity still to arrive on open purchase orders.",
    long: "Outstanding quantity on open purchase orders (ordered − received). Subtracted once when suggesting an order.",
  },
  weekly_demand: {
    label: "Weekly demand",
    short: "Average units used per week — direct sales plus components consumed by builds.",
    long: "Trailing 90-day rate of direct sales plus components consumed by MYOB build transactions. If nothing moved in 90 days but did within the year, the 365-day rate is used and the item is tagged a slow mover.",
  },
  cover: {
    label: "Cover",
    short: "How many weeks the free stock lasts at the current demand rate.",
    long: "Free stock ÷ weekly demand. Under 2 weeks is shown red, under 4 amber. Blank means no demand was recorded, so cover cannot be calculated.",
  },
  risk: {
    label: "Risk score",
    short: "0–100 priority score. Click any item to see exactly which factors produced it.",
    long: "Adds points for low cover, being below the MYOB minimum, how many finished products depend on the item, data-quality problems and weekly consumption value. Every contributing factor and its points are listed on the item page.",
  },
  used_in: {
    label: "Used in",
    short: "How many finished products need this item, counting sub-assemblies.",
    long: "Counts products that depend on this item at any depth — a bolt inside a pack inside a dressing set counts for all of them.",
  },
  excess: {
    label: "Excess stock",
    short: "Value of stock beyond the excess threshold of cover, where it is material.",
    long: "Free stock beyond the excess threshold (default 26 weeks of cover) valued at average cost, counted only when the item has real demand and the excess is worth at least $250. The counterpart to shortage risk: stock Allied could stop reordering.",
  },
  potential: {
    label: "Potential pack pull",
    short: "Inferred component demand from packs sold but not rebuilt. Never included in the totals.",
    long: "When a pack or kit sells more units in 90 days than were built or bought, the difference came out of stock made earlier. Rebuilding it would pull these components, but MYOB has recorded no such movement — so it is reported separately and never added to demand, cover, suggestions or risk.",
  },
  supplier_source: {
    label: "Supplier source",
    short: "Whether the supplier was set by Allied, taken from MYOB, or inferred from purchase history.",
    long: "Allied-set (a preferred supplier recorded on the item) wins, then MYOB's primary supplier field, then the supplier who has billed the item most. Allied's file sets a MYOB primary on almost no items, so most are inferred until someone records one.",
  },
  region: {
    label: "Region",
    short: "Platform label for where a supplier is — auto from their MYOB address country, or set by Allied.",
    long: "NZ / Australia / China / Overseas — other. Derived automatically from the supplier's MYOB address country and overridable on the Suppliers page. Marked ·auto when it came from the address rather than a person.",
  },
  bom_source: {
    label: "Relationship source",
    short: "Whether a product's recipe was observed from MYOB builds or entered by Allied.",
    long: "Derived rows are observed from MYOB build transactions, with confidence growing as more builds agree. Allied-entered rows always win, and the derived quantity they override stays visible so disagreements are not hidden.",
  },
  buildable: {
    label: "Buildable now",
    short: "How many units could be made from free component stock.",
    long: "Two answers where a product contains sub-assemblies: from stock as it sits, and including building those sub-assemblies first. Both ignore incoming purchase orders.",
  },
};

const FLAG_HELP = {
  below_min: "Free stock is under the minimum level set in MYOB for this item.",
  negative_stock: "MYOB shows less than zero on hand — usually a sequencing or data-entry problem worth investigating.",
  stock_no_cost: "Stock is on hand but its average cost is zero, so any value or excess figure understates reality.",
  inactive_with_stock: "The item is marked inactive in MYOB but still holds stock.",
  no_supplier: "The item has demand but no supplier recorded, in MYOB or here, and none in purchase history.",
  slow_mover: "Nothing moved in the last 90 days, so the slower 365-day rate is used for demand and cover.",
  understated_demand: "Packs containing this item sold without being rebuilt, so its measured demand understates the real pull.",
  min_above_demand: "This item is both overstocked against demand and suggested for reorder, because the MYOB minimum level sits far above what demand justifies — worth reviewing the minimum itself.",
};

const FLAG_LABELS = {
  below_min: ["Below min", "fail"],
  negative_stock: ["Negative stock", "fail"],
  stock_no_cost: ["No cost", "warn"],
  inactive_with_stock: ["Inactive w/ stock", "warn"],
  no_supplier: ["No supplier", "warn"],
  slow_mover: ["Slow mover", "idle"],
  understated_demand: ["Pack pull not counted", "brand"],
  min_above_demand: ["Min level above demand", "warn"],
};

const invState = { q: "", filter: "all", region: "", sort: "risk", dir: "", page: 1 };

/** One-click answers to the questions staff actually ask. */
const INVENTORY_PRESETS = [
  { id: "attention", label: "Needs attention", state: { filter: "attention", sort: "risk", dir: "desc" } },
  { id: "reorder", label: "Reorder now", state: { filter: "suggested", sort: "cover", dir: "asc" } },
  { id: "slow", label: "Slow movers", state: { filter: "slow_mover", sort: "value", dir: "desc" } },
  { id: "dead", label: "Dead stock", state: { filter: "dead_stock", sort: "excess", dir: "desc" } },
  { id: "committed", label: "Most committed", state: { filter: "committed", sort: "committed", dir: "desc" } },
  { id: "china", label: "From China", state: { region: "China", sort: "value", dir: "desc" } },
];

const INVENTORY_FILTERS = [
  ["all", "All items"],
  ["attention", "Needs attention"],
  ["suggested", "Suggested orders"],
  ["below_min", "Below min level"],
  ["low_cover", "Cover under 4 weeks"],
  ["excess", "Excess stock"],
  ["slow_mover", "Slow movers"],
  ["dead_stock", "Dead stock (slow + excess)"],
  ["committed", "Has committed stock"],
  ["components", "Used in assemblies"],
  ["parents", "Assembled products"],
  ["understated", "Pack pull not counted"],
  ["min_above_demand", "Min level above demand"],
  ["negative", "Negative stock"],
  ["stock_no_cost", "Stock with no cost"],
  ["no_supplier", "No supplier set"],
  ["inactive_stock", "Inactive with stock"],
];

const INVENTORY_SORTS = [
  ["risk", "Risk"],
  ["cover", "Cover"],
  ["weekly", "Weekly demand"],
  ["committed", "Committed"],
  ["on_hand", "On hand"],
  ["available", "Free stock"],
  ["incoming", "Incoming"],
  ["value", "Stock value"],
  ["excess", "Excess value"],
  ["potential", "Potential pack pull"],
  ["used_in", "Used in most products"],
  ["number", "Item number"],
  ["name", "Item name"],
];
const prodState = { q: "", page: 1 };
const supState = { q: "" };

const REGION_TONE = { NZ: "ok", Australia: "warn", China: "brand" };

/** Supplier region chip. Region labels are platform data (auto from the MYOB
 * address country, or set by Allied staff), never MYOB fields. */
function regionChip(region, source) {
  if (!region) return "";
  const tone = REGION_TONE[region] ?? "idle";
  const title = source === "user" ? "Region set by Allied staff" : "Region derived from MYOB address country";
  const mark = source === "user" ? "" : " ·auto";
  return `<span class="badge ${tone}" title="${title}">${esc(region)}${mark}</span>`;
}
let syncPollTimer = null;

/* ---------- helpers ---------- */

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function qty(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function money(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return Number(v).toLocaleString(undefined, {
    style: "currency",
    currency: "NZD",
    maximumFractionDigits: 0,
  });
}

/** Unit prices need cents (and sub-cent for fasteners) — money() rounds to
 * whole dollars, which makes $0.35 and $1.22 both unreadable. */
function price(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return n.toLocaleString(undefined, {
    style: "currency",
    currency: "NZD",
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2,
  });
}

function dateFmt(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function ago(v) {
  if (!v) return "never";
  const mins = Math.round((Date.now() - new Date(v).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function riskPill(score) {
  const cls = score >= 50 ? "risk-high" : score >= 25 ? "risk-med" : "risk-low";
  return `<span class="risk-pill ${cls}">${score}</span>`;
}

function flagChips(flags) {
  if (!flags?.length) return "";
  return `<span class="chips">${flags
    .map((f) => {
      const [label, tone] = FLAG_LABELS[f] ?? [f, "idle"];
      const help = FLAG_HELP[f];
      return `<span class="badge ${tone}${help ? " has-help" : ""}"${
        help ? ` title="${esc(help)}"` : ""
      }>${esc(label)}</span>`;
    })
    .join("")}</span>`;
}

/** Column header carrying its definition on hover. */
function th(termKey, label, cls = "") {
  const t = TERMS[termKey];
  if (!t) return `<th class="${cls}">${esc(label ?? termKey)}</th>`;
  return `<th class="${cls}"><span class="term" title="${esc(t.short)}">${esc(label ?? t.label)}</span></th>`;
}

/**
 * Sortable column header. Clicking sorts by that column; clicking the column
 * already in use flips the direction. The definition stays available on hover.
 */
function sortTh(sortKey, termKey, label, cls = "") {
  const t = TERMS[termKey];
  const active = invState.sort === sortKey;
  const dir = active ? currentDir() : null;
  const arrow = active ? (dir === "asc" ? "▲" : "▼") : "";
  const tip = `${t ? `${t.short} · ` : ""}Click to sort${
    active ? (dir === "asc" ? " highest first" : " lowest first") : ""
  }`;
  return `<th class="${cls} sortable${active ? " sorted" : ""}"
    data-sort="${sortKey}" title="${esc(tip)}"
    aria-sort="${active ? (dir === "asc" ? "ascending" : "descending") : "none"}"
    ><span class="th-inner">${esc(label ?? t?.label ?? sortKey)}<span class="sort-arrow">${arrow}</span></span></th>`;
}

function coverFmt(cover, basis) {
  if (cover == null) return '<span class="muted">no demand</span>';
  const suffix = basis === "365d" ? " (365d rate)" : "";
  if (cover < 2) return `<span class="badge fail">${cover}w${suffix}</span>`;
  if (cover < 4) return `<span class="badge warn">${cover}w${suffix}</span>`;
  return `${cover}w${suffix}`;
}

const MOVEMENT_KIND = {
  sale: ["Sale", "fail"],
  purchase: ["Purchase", "ok"],
  build: ["Build", "brand"],
  adjustment: ["Adjustment", "warn"],
};

/** 12 trailing months of direct + component demand as stacked bar columns. */
function demandBarsHtml(monthlyDemand, barHeight = 100) {
  const months = [];
  for (let m = 11; m >= 0; m--) {
    const date = new Date();
    date.setMonth(date.getMonth() - m, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const row = (monthlyDemand || []).find((r) => String(r.month).slice(0, 7) === key);
    months.push({
      label: date.toLocaleDateString(undefined, { month: "narrow" }),
      direct: Number(row?.direct ?? 0),
      component: Number(row?.component ?? 0),
    });
  }
  const max = Math.max(1, ...months.map((m) => m.direct + m.component));
  return months
    .map((m) => {
      const dh = Math.round((m.direct / max) * barHeight);
      const ch = Math.round((m.component / max) * barHeight);
      return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end">
        <div class="bar-col" title="Direct ${m.direct.toFixed(0)} · Component ${m.component.toFixed(0)}">
          <div class="seg-comp" style="height:${ch}px"></div>
          <div class="seg-direct" style="height:${dh}px"></div>
        </div>
        <div class="bar-label">${m.label}</div>
      </div>`;
    })
    .join("");
}

/* ---------- data access ---------- */

let memoryKey = "";

function accessKey() {
  try {
    return localStorage.getItem("afDashboardKey") || memoryKey;
  } catch {
    return memoryKey;
  }
}

function saveKey(value) {
  memoryKey = value;
  try {
    localStorage.setItem("afDashboardKey", value);
  } catch {
    // Private browsing / blocked storage: memoryKey keeps the session working.
  }
}

async function fetchJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const key = accessKey();
  if (key) headers["x-dashboard-key"] = key;
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    keyOverlay.hidden = false;
    keyInput.focus();
    throw new Error("Dashboard access key required.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  saveKey(keyInput.value.trim());
  try {
    await fetchJson("/api/insights/sync/status");
    keyOverlay.hidden = true;
    keyError.hidden = true;
    route();
    pollSyncChip();
  } catch (err) {
    keyError.textContent = `Not accepted: ${err.message}`;
    keyError.hidden = false;
  }
});

/* ---------- help drawer ---------- */

const helpDrawer = document.getElementById("help-drawer");

function renderHelp() {
  const body = document.getElementById("help-body");
  if (!body || body.dataset.filled) return;
  body.innerHTML = `
    <dl class="glossary">
      ${Object.values(TERMS)
        .map((t) => `<dt>${esc(t.label)}</dt><dd>${esc(t.long)}</dd>`)
        .join("")}
    </dl>
    <h3 class="sub-h">Tags you'll see on items</h3>
    <dl class="glossary">
      ${Object.entries(FLAG_HELP)
        .map(
          ([key, help]) =>
            `<dt><span class="badge ${(FLAG_LABELS[key] ?? ["", "idle"])[1]}">${esc(
              (FLAG_LABELS[key] ?? [key])[0],
            )}</span></dt><dd>${esc(help)}</dd>`,
        )
        .join("")}
    </dl>
    <p class="drawer-note">Hover any column heading or tag for the same explanation without opening this panel.</p>`;
  body.dataset.filled = "1";
}

document.getElementById("help-open")?.addEventListener("click", () => {
  renderHelp();
  helpDrawer.hidden = false;
});
document.getElementById("help-close")?.addEventListener("click", () => {
  helpDrawer.hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && helpDrawer && !helpDrawer.hidden) helpDrawer.hidden = true;
});

/* ---------- sync chip ---------- */

async function pollSyncChip() {
  try {
    const status = await fetchJson("/api/insights/sync/status");
    const newest = (status.entities || [])
      .map((e) => e.last_synced_at)
      .filter(Boolean)
      .sort()
      .pop();
    if (status.running) {
      syncDot.className = "dot busy";
      syncChipText.textContent = "Sync running…";
      clearTimeout(syncPollTimer);
      syncPollTimer = setTimeout(pollSyncChip, 4000);
    } else if (!newest) {
      syncDot.className = "dot warn";
      syncChipText.textContent = "No data synced yet";
    } else {
      const hours = (Date.now() - new Date(newest).getTime()) / 3600000;
      syncDot.className = hours > 26 ? "dot warn" : "dot ok";
      syncChipText.textContent = `Data synced ${ago(newest)}`;
    }
  } catch {
    syncDot.className = "dot warn";
    syncChipText.textContent = "Data status unavailable";
  }
}

async function startSync(mode, button) {
  if (button) button.disabled = true;
  try {
    await fetchJson("/api/insights/sync/run", {
      method: "POST",
      body: JSON.stringify({ mode }),
    });
    pollSyncChip();
    setTimeout(() => {
      if (location.hash.includes("data")) route();
    }, 1500);
  } catch (err) {
    alert(err.message);
  } finally {
    if (button) button.disabled = false;
  }
}

/* ---------- router ---------- */

let suppressRoute = false;

/** Inventory view state lives in the URL so a list can be bookmarked or sent
 * to a colleague and open exactly as it was. */
function applyInventoryQuery(queryString) {
  const p = new URLSearchParams(queryString);
  if (!queryString) return;
  invState.q = p.get("q") ?? "";
  invState.filter = p.get("filter") ?? "all";
  invState.region = p.get("region") ?? "";
  invState.sort = p.get("sort") ?? "risk";
  invState.dir = p.get("dir") ?? "";
  invState.page = Number(p.get("page")) || 1;
}

function inventoryHash() {
  const p = new URLSearchParams();
  if (invState.q) p.set("q", invState.q);
  if (invState.filter && invState.filter !== "all") p.set("filter", invState.filter);
  if (invState.region) p.set("region", invState.region);
  if (invState.sort && invState.sort !== "risk") p.set("sort", invState.sort);
  if (invState.dir) p.set("dir", invState.dir);
  if (invState.page > 1) p.set("page", String(invState.page));
  const qs = p.toString();
  return `#/inventory${qs ? `?${qs}` : ""}`;
}

/** Update the address bar without re-rendering the whole page. */
function syncInventoryUrl() {
  const next = inventoryHash();
  if (location.hash === next) return;
  suppressRoute = true;
  history.replaceState({}, "", next);
  setTimeout(() => (suppressRoute = false), 0);
}

function route() {
  const raw = location.hash.replace(/^#\//, "") || "overview";
  const [path, query] = raw.split("?");
  const [view, arg] = path.split("/");
  if (view === "inventory") applyInventoryQuery(query);
  for (const a of nav.querySelectorAll("a")) {
    a.classList.toggle("active", a.dataset.route === view);
  }
  const views = {
    overview: renderOverview,
    inventory: renderInventory,
    item: () => renderItem(arg),
    products: renderProducts,
    suppliers: renderSuppliers,
    purchasing: renderPurchasing,
    data: renderData,
  };
  (views[view] || renderOverview)().catch((err) => {
    main.innerHTML = `<div class="notice fail">${esc(err.message)}</div>
      <p class="muted">If no data has been synced yet, open <a href="#/data">Data &amp; Sync</a> and run a full sync.</p>`;
  });
}

window.addEventListener("hashchange", () => {
  if (suppressRoute) return;
  route();
});

function itemLink(uid, label) {
  return `<a href="#/item/${esc(uid)}">${esc(label)}</a>`;
}

/* ---------- overview ---------- */

async function renderOverview() {
  main.innerHTML = '<p class="loading">Loading overview…</p>';
  const data = await fetchJson("/api/insights/overview");
  const k = data.kpis;

  if (!k.totalSkus) {
    main.innerHTML = `
      <div class="page-head"><div><h1>Overview</h1></div></div>
      <div class="notice warn">No MYOB data synced yet. Run the first full sync to load Allied's
      items, sales, purchases, builds and adjustments into the dashboard database.</div>
      <button class="btn primary" id="first-sync">Run first full sync</button>`;
    document.getElementById("first-sync").addEventListener("click", (e) =>
      startSync("full", e.currentTarget),
    );
    return;
  }

  const rel = Object.fromEntries((data.relationships || []).map((r) => [r.source, r.count]));

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Overview</h1>
        <p class="page-sub">Position facts from MYOB · analysis by this platform · target cover ${data.targetCoverWeeks} weeks</p>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><span class="k-label">SKUs</span><span class="k-value">${qty(k.totalSkus)}</span></div>
      <div class="kpi"><span class="k-label">Stock value (MYOB)</span><span class="k-value">${money(k.stockValue)}</span></div>
      <div class="kpi link ${k.belowMin ? "alert" : ""}" data-filter="below_min"><span class="k-label">Below min level</span><span class="k-value">${qty(k.belowMin)}</span></div>
      <div class="kpi link ${k.coverUnder2w ? "warn" : ""}" data-filter="low_cover"><span class="k-label">Cover &lt; 2 weeks</span><span class="k-value">${qty(k.coverUnder2w)}</span></div>
      <div class="kpi link" data-filter="suggested"><span class="k-label">Suggested orders</span><span class="k-value">${qty(k.suggestedOrders)}</span></div>
      <div class="kpi link ${k.negativeStock ? "alert" : ""}" data-filter="negative"><span class="k-label">Negative stock</span><span class="k-value">${qty(k.negativeStock)}</span></div>
      <div class="kpi link" data-filter="parents"><span class="k-label">Assembled products</span><span class="k-value">${qty(k.trackedParents)}</span></div>
      <div class="kpi link" data-filter="excess" title="Stock beyond ${data.excessCoverWeeks} weeks of cover, where it is worth something"><span class="k-label">Excess stock value</span><span class="k-value">${money(k.excessValue)}</span></div>
      <div class="kpi"><span class="k-label">Relationships</span><span class="k-value">${qty(Object.values(rel).reduce((a, b) => a + b, 0))}</span></div>
    </div>

    <div class="two-col">
      <section class="panel">
        <h2>Needs attention</h2>
        <p class="hint">Ranked by risk: cover vs demand, MYOB minimums, dependency breadth, data quality. Click for evidence.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Risk</th><th>Item</th><th class="num">Free stock</th><th>Cover</th><th>Why</th></tr></thead>
          <tbody>
            ${data.attention
              .map(
                (i) => `<tr class="rowlink" data-uid="${esc(i.uid)}">
                  <td>${riskPill(i.risk.score)}</td>
                  <td><strong>${esc(i.number ?? "—")}</strong><br /><span class="muted">${esc(i.name ?? "")}</span></td>
                  <td class="num">${qty(i.qtyFreeStock)}</td>
                  <td>${coverFmt(i.coverWeeks, i.demand.basis)}</td>
                  <td>${flagChips(i.flags)}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table></div>
      </section>

      <section class="panel">
        <h2>Components blocking assemblies</h2>
        <p class="hint">Components with less free stock (on hand − committed) than one build requires, ranked by how many
        finished products they block — counting products that depend on them through sub-assemblies too.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Component</th><th class="num">Free stock</th><th class="num">Blocks</th></tr></thead>
          <tbody>
            ${
              data.constraints.length
                ? data.constraints
                    .map(
                      (c) => `<tr class="rowlink" data-uid="${esc(c.uid)}">
                        <td><strong>${esc(c.number ?? "—")}</strong><br /><span class="muted">${esc(c.name ?? "")}</span></td>
                        <td class="num">${qty(c.stock_free)}</td>
                        <td class="num">${qty(c.blocked_parents)}${c.max_depth > 1 ? '<br /><span class="muted" style="font-size:0.62rem">incl. via sub-assy</span>' : ""}</td>
                      </tr>`,
                    )
                    .join("")
                : '<tr><td colspan="3" class="muted">No blocked assemblies found.</td></tr>'
            }
          </tbody>
        </table></div>
      </section>
    </div>

    <section class="panel">
      <h2>Largest stock adjustments — last 30 days</h2>
      <p class="hint">Write-offs, stocktake corrections and reversals ranked by value. These are MYOB movements that
      change stock without a sale, purchase or build, so they are worth a second look when a number looks wrong.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Item</th><th>Doc</th><th>Date</th><th class="num">Qty ±</th><th class="num">Value</th><th>Memo</th></tr></thead>
        <tbody>
          ${
            (data.adjustments || []).length
              ? data.adjustments
                  .map(
                    (a) => `<tr class="rowlink" data-uid="${esc(a.uid)}">
                      <td><strong>${esc(a.item_number ?? "—")}</strong><br /><span class="muted">${esc((a.item_name ?? "").slice(0, 40))}</span></td>
                      <td>${esc(a.number ?? "—")}</td>
                      <td>${dateFmt(a.date)}</td>
                      <td class="num ${a.qty < 0 ? "neg" : ""}">${a.qty > 0 ? "+" : ""}${qty(a.qty)}</td>
                      <td class="num">${money(a.value)}</td>
                      <td class="muted">${esc((a.line_memo ?? a.doc_memo ?? "").slice(0, 40))}</td>
                    </tr>`,
                  )
                  .join("")
              : '<tr><td colspan="6" class="muted">No stock adjustments in the last 30 days.</td></tr>'
          }
        </tbody>
      </table></div>
    </section>

    <section class="panel">
      <h2>Supply by supplier region</h2>
      <p class="hint">Region labels are platform data: auto from the supplier's MYOB address country, or set by
      Allied on the <a href="#/suppliers">Suppliers</a> page. Stock value groups items by supplier
      (MYOB primary where set, otherwise inferred from purchase history); incoming groups open purchase
      orders by the ordering supplier.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Region</th><th class="num">SKUs</th><th class="num">Stock value</th><th class="num">% of value</th><th class="num">Open PO value</th><th class="num">Open POs</th></tr></thead>
        <tbody>
          ${(() => {
            const totalValue = (data.regions || []).reduce((s, r) => s + r.stockValue, 0) || 1;
            return (data.regions || [])
              .map(
                (r) => `<tr>
                  <td><span class="badge ${REGION_TONE[r.region] ?? "idle"}">${esc(r.region)}</span></td>
                  <td class="num">${qty(r.skus)}</td>
                  <td class="num">${money(r.stockValue)}</td>
                  <td class="num">${((r.stockValue / totalValue) * 100).toFixed(1)}%</td>
                  <td class="num">${money(r.openPoValue)}</td>
                  <td class="num">${qty(r.openPoOrders)}</td>
                </tr>`,
              )
              .join("");
          })()}
        </tbody>
      </table></div>
    </section>`;

  main.querySelectorAll("tr.rowlink").forEach((tr) =>
    tr.addEventListener("click", () => (location.hash = `#/item/${tr.dataset.uid}`)),
  );
  main.querySelectorAll(".kpi.link").forEach((el) =>
    el.addEventListener("click", () => {
      invState.filter = el.dataset.filter;
      invState.page = 1;
      location.hash = "#/inventory";
    }),
  );
}

/* ---------- inventory ---------- */

async function renderInventory() {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Inventory</h1>
        <p class="page-sub">All synced SKUs with demand, cover and risk. Position quantities are MYOB facts.</p>
      </div>
    </div>
    <div class="presets">
      <span class="presets-label">Quick views</span>
      ${INVENTORY_PRESETS.map(
        (p) => `<button class="chip-btn" data-preset="${p.id}">${esc(p.label)}</button>`,
      ).join("")}
      <button class="chip-btn clear" id="inv-clear">Clear</button>
    </div>
    <div class="toolbar">
      <input type="search" id="inv-q" placeholder="Search number, name, supplier…" value="${esc(invState.q)}" />
      <select id="inv-filter" aria-label="Filter">
        ${INVENTORY_FILTERS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}
      </select>
      <select id="inv-region" aria-label="Supplier region">
        <option value="">All regions</option>
        <option value="NZ">Region: NZ</option>
        <option value="Australia">Region: Australia</option>
        <option value="China">Region: China</option>
        <option value="Overseas — other">Region: Overseas — other</option>
        <option value="none">Region: unlabelled</option>
      </select>
    </div>
    <div id="inv-table"><p class="loading">Loading items…</p></div>`;

  const q = document.getElementById("inv-q");
  const filter = document.getElementById("inv-filter");
  const region = document.getElementById("inv-region");
  filter.value = invState.filter;
  region.value = invState.region;

  main.querySelectorAll("[data-preset]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const preset = INVENTORY_PRESETS.find((p) => p.id === btn.dataset.preset);
      if (!preset) return;
      // A preset sets only what it names; anything else returns to default.
      Object.assign(invState, { q: "", filter: "all", region: "", sort: "risk", dir: "", page: 1 }, preset.state);
      renderInventory();
    }),
  );
  document.getElementById("inv-clear").addEventListener("click", () => {
    Object.assign(invState, { q: "", filter: "all", region: "", sort: "risk", dir: "", page: 1 });
    renderInventory();
  });
  let debounce;
  q.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      invState.q = q.value;
      invState.page = 1;
      loadInventoryTable();
    }, 300);
  });
  filter.addEventListener("change", () => {
    invState.filter = filter.value;
    invState.page = 1;
    loadInventoryTable();
  });
  region.addEventListener("change", () => {
    invState.region = region.value;
    invState.page = 1;
    loadInventoryTable();
  });
  await loadInventoryTable();
}

/** Items on the current inventory page, for instant row expansion. */
let invItems = new Map();
let invTargetCover = null;
let invLastDir = "desc";
const itemDetailCache = new Map();

function currentDir() {
  return invState.dir || invLastDir;
}

/** Plain-English description of the list currently on screen. */
function activeViewSummary(total) {
  const bits = [];
  const filterLabel = INVENTORY_FILTERS.find(([v]) => v === invState.filter)?.[1];
  if (invState.filter && invState.filter !== "all" && filterLabel) bits.push(filterLabel.toLowerCase());
  if (invState.region)
    bits.push(invState.region === "none" ? "unlabelled region" : `from ${invState.region}`);
  if (invState.q) bits.push(`matching “${invState.q}”`);
  const sortLabel = INVENTORY_SORTS.find(([v]) => v === invState.sort)?.[1] ?? "risk";
  const dirWord = currentDir() === "asc" ? "lowest first" : "highest first";
  return `${qty(total)} ${bits.length ? bits.join(", ") : "items"} · sorted by ${sortLabel.toLowerCase()}, ${dirWord}`;
}

async function loadInventoryTable() {
  const container = document.getElementById("inv-table");
  if (!container) return;
  container.innerHTML = '<p class="loading">Loading items…</p>';
  const params = new URLSearchParams({
    q: invState.q,
    filter: invState.filter,
    region: invState.region,
    sort: invState.sort,
    page: String(invState.page),
  });
  if (invState.dir) params.set("dir", invState.dir);
  const data = await fetchJson(`/api/insights/items?${params}`);
  invItems = new Map(data.items.map((i) => [i.uid, i]));
  invTargetCover = data.targetCoverWeeks ?? null;
  invLastDir = data.dir ?? "desc";

  syncInventoryUrl();

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  container.innerHTML = `
    <p class="view-summary">${esc(activeViewSummary(data.total))}</p>
    <div class="table-wrap"><table>
      <thead><tr>
        <th class="caret-h"></th>
        ${sortTh("risk", "risk", "Risk")}
        ${sortTh("number", null, "Item")}
        ${sortTh("on_hand", null, "On hand", "num")}
        ${sortTh("committed", "committed", "Committed", "num")}
        ${sortTh("available", "free_stock", "Free stock", "num")}
        ${sortTh("incoming", "incoming", "Incoming", "num")}
        ${sortTh("weekly", "weekly_demand", "Weekly demand", "num")}
        ${sortTh("cover", "cover", "Cover")}
        ${sortTh("value", null, "Stock value", "num")}
        ${sortTh("used_in", "used_in", "Used in", "num")}
        <th>Tags</th>
      </tr></thead>
      <tbody>
        ${
          data.items.length
            ? data.items
                .map(
                  (i) => `<tr class="rowlink inv-row" data-uid="${esc(i.uid)}">
                    <td class="caret">▸</td>
                    <td>${riskPill(i.risk.score)}</td>
                    <td><a href="#/item/${esc(i.uid)}"><strong>${esc(i.number ?? "—")}</strong></a><br /><span class="muted">${esc((i.name ?? "").slice(0, 60))}</span></td>
                    <td class="num">${qty(i.qtyOnHand)}</td>
                    <td class="num">${qty(i.qtyCommitted)}</td>
                    <td class="num"><strong>${qty(i.qtyFreeStock)}</strong></td>
                    <td class="num">${qty(i.incomingQty)}</td>
                    <td class="num">${i.demand.weekly ? i.demand.weekly.toFixed(1) : "—"}</td>
                    <td>${coverFmt(i.coverWeeks, i.demand.basis)}</td>
                    <td class="num">${money(i.currentValue)}</td>
                    <td class="num">${i.parentCount || "—"}</td>
                    <td>${flagChips(i.flags)}</td>
                  </tr>`,
                )
                .join("")
            : `<tr><td colspan="12" class="muted">No items match this view. <button class="linkish" id="inv-empty-clear">Clear filters</button></td></tr>`
        }
      </tbody>
    </table></div>
    <div class="pager">
      <button class="btn small" id="prev" ${data.page <= 1 ? "disabled" : ""}>&larr; Prev</button>
      <span>Page ${data.page} of ${pages} · ${qty(data.total)} items · click a row to expand</span>
      <button class="btn small" id="next" ${data.page >= pages ? "disabled" : ""}>Next &rarr;</button>
    </div>`;

  container.querySelector("#inv-empty-clear")?.addEventListener("click", () => {
    Object.assign(invState, { q: "", filter: "all", region: "", sort: "risk", dir: "", page: 1 });
    renderInventory();
  });

  // Click a column to sort by it; click the active column to flip direction.
  container.querySelectorAll("th.sortable").forEach((header) =>
    header.addEventListener("click", () => {
      const key = header.dataset.sort;
      if (invState.sort === key) {
        invState.dir = currentDir() === "desc" ? "asc" : "desc";
      } else {
        invState.sort = key;
        invState.dir = ""; // start in this column's most useful direction
      }
      invState.page = 1;
      loadInventoryTable();
    }),
  );

  container.querySelectorAll("tr.inv-row").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // item-number link still navigates
      toggleExpandRow(tr);
    }),
  );
  container.querySelector("#prev")?.addEventListener("click", () => {
    invState.page -= 1;
    loadInventoryTable();
  });
  container.querySelector("#next")?.addEventListener("click", () => {
    invState.page += 1;
    loadInventoryTable();
  });
}

function toggleExpandRow(tr) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains("expand-row")) {
    next.remove();
    tr.classList.remove("expanded");
    tr.querySelector(".caret").textContent = "▸";
    return;
  }
  const item = invItems.get(tr.dataset.uid);
  if (!item) return;
  tr.insertAdjacentHTML(
    "afterend",
    `<tr class="expand-row"><td colspan="12">${expandPanelHtml(item)}</td></tr>`,
  );
  tr.classList.add("expanded");
  tr.querySelector(".caret").textContent = "▾";
  loadExpandExtras(item.uid, tr.nextElementSibling.querySelector(".expand-extra"));
}

function kvRow(label, value, cls = "") {
  return `<div class="kv ${cls}"><span>${label}</span><span>${value}</span></div>`;
}

/** Inline detail panel, rendered instantly from the items-list payload. */
function expandPanelHtml(i) {
  const s = i.suggestion;
  const stockValue =
    i.currentValue != null
      ? i.currentValue
      : i.averageCost != null && i.qtyOnHand != null
        ? i.averageCost * i.qtyOnHand
        : null;

  const position = `
    <h3>Position</h3>
    ${kvRow("On hand", qty(i.qtyOnHand))}
    ${kvRow("Committed", qty(i.qtyCommitted))}
    ${kvRow("Free stock (on hand − committed)", `<strong>${qty(i.qtyFreeStock)}</strong>`)}
    ${kvRow("Incoming (open POs)", qty(i.incomingQty))}
    ${kvRow("MYOB available (incl. on order)", qty(i.qtyAvailable), "muted-row")}
    ${kvRow("Min level", qty(i.minLevel))}
    ${kvRow("Avg cost", money(i.averageCost))}
    ${kvRow("Stock value", money(stockValue))}
    ${
      i.excess
        ? kvRow(
            "Excess beyond target cover",
            `<span class="potential-val">${qty(i.excess.units)} units · ${money(i.excess.value)}</span>`,
          )
        : ""
    }`;

  const demand = `
    <h3>Demand &amp; cover</h3>
    ${kvRow("Weekly demand", `${i.demand.weekly ? i.demand.weekly.toFixed(1) : "0"} <span class="muted">(${i.demand.basis === "none" ? "no activity" : i.demand.basis + " basis"})</span>`)}
    ${kvRow(`Cover${invTargetCover ? ` (target ${invTargetCover}w)` : ""}`, coverFmt(i.coverWeeks, i.demand.basis))}
    ${kvRow("Direct sales 90d / 365d", `${qty(i.demand.direct90)} / ${qty(i.demand.direct365)}`)}
    ${kvRow("Via builds 90d / 365d", `${qty(i.demand.component90)} / ${qty(i.demand.component365)}`)}
    ${
      i.potential.qty90 > 0
        ? kvRow(
            `Potential from packs 90d <span class="muted">(not in totals)</span>`,
            `<span class="potential-val" title="Packs/kits that sold more than were built or bought in 90 days, × qty per. Inferred, not a MYOB movement.">+${qty(i.potential.qty90)} <span class="muted">· ${i.potential.parentCount} product(s)</span></span>`,
          )
        : ""
    }
    ${kvRow(
      "Used in finished products",
      i.parentCountDeep > i.parentCount
        ? `${i.parentCountDeep} <span class="muted">(${i.parentCount} direct + via sub-assemblies)</span>`
        : i.parentCount || "—",
    )}
    ${kvRow("Components (if assembled)", i.componentCount || "—")}`;

  const action = `
    <h3>Why &amp; action</h3>
    <p class="expand-risk">${riskPill(i.risk.score)} ${flagChips(i.flags)}</p>
    ${
      i.risk.factors.length
        ? `<ul class="expand-factors">${i.risk.factors
            .map((f) => `<li>${esc(f.label)} <span class="muted">(+${f.points})</span></li>`)
            .join("")}</ul>`
        : '<p class="muted">No risk factors triggered.</p>'
    }
    ${
      s
        ? `<div class="explain">
            <strong>Suggest ordering ~${qty(s.qty)} units.</strong>
            <ul>
              <li>${s.rationale.weeklyDemand}/wk × ${s.rationale.targetCoverWeeks}w target + min ${qty(s.rationale.minLevel)}</li>
              <li>less free stock ${qty(s.rationale.freeStock)} and incoming ${qty(s.rationale.incoming)}</li>
              ${s.rationale.reorderMultiple ? `<li>rounded to reorder multiple of ${qty(s.rationale.reorderMultiple)}</li>` : ""}
            </ul>
          </div>`
        : ""
    }
    ${kvRow(
      "Supplier",
      `${regionChip(i.supplierRegion, i.supplierRegionSource)} ${esc(i.supplierName ?? "—")}
       ${supplierSourceBadge(i.supplierSource)}${
         i.supplierCount > 1
           ? ` <span class="muted">+${i.supplierCount - 1} alternate</span>`
           : ""
       }`,
    )}
    ${i.supplierItemNumber ? kvRow("Supplier item no", esc(i.supplierItemNumber)) : ""}`;

  return `
    <div class="expand-panel">
      <div class="expand-grid">
        <div>${position}</div>
        <div>${demand}</div>
        <div>${action}</div>
      </div>
      <div class="expand-extra"><p class="loading">Loading 12-month demand and recent movements…</p></div>
      <p class="expand-foot"><a href="#/item/${esc(i.uid)}">Open full item page &rarr;</a></p>
    </div>`;
}

/** Lazily add the demand chart + latest movements from the item detail API. */
async function loadExpandExtras(uid, el) {
  if (!el) return;
  try {
    let detail = itemDetailCache.get(uid);
    if (!detail) {
      detail = await fetchJson(`/api/insights/items/${encodeURIComponent(uid)}`);
      itemDetailCache.set(uid, detail);
    }
    const moves = (detail.movements || []).slice(0, 5);
    el.innerHTML = `
      <div class="expand-extra-grid">
        <div>
          <h3>Demand — last 12 months</h3>
          <div class="bars small">${demandBarsHtml(detail.monthlyDemand, 48)}</div>
        </div>
        <div>
          <h3>Latest movements (MYOB evidence)</h3>
          ${
            moves.length
              ? `<div class="table-wrap"><table>
                  <tbody>${moves
                    .map((m) => {
                      const [label, tone] = MOVEMENT_KIND[m.kind] ?? [m.kind, "idle"];
                      return `<tr>
                        <td><span class="badge ${tone}">${esc(label)}</span></td>
                        <td>${esc(m.doc ?? "—")}</td>
                        <td>${dateFmt(m.date)}</td>
                        <td class="num">${m.delta > 0 ? "+" : ""}${qty(m.delta)}</td>
                        <td class="muted">${esc((m.counterparty ?? m.description ?? "").slice(0, 40))}</td>
                      </tr>`;
                    })
                    .join("")}</tbody>
                </table></div>`
              : '<p class="muted">No movements in the synced window.</p>'
          }
        </div>
      </div>`;
  } catch (err) {
    el.innerHTML = `<p class="muted">Could not load activity: ${esc(err.message)}</p>`;
  }
}

/* ---------- item detail ---------- */

function sourceBadge(source, confidence, buildCount, shadowedQty, shadowedBuilds) {
  if (source === "user") {
    // A user row supersedes any derived observation for the same pair. Show
    // the disagreement rather than hiding it.
    const note =
      shadowedQty != null
        ? `<br /><span class="muted" title="MYOB builds observed a different quantity">overrides derived ${qty(shadowedQty)}${
            shadowedBuilds ? ` (${shadowedBuilds} build${shadowedBuilds === 1 ? "" : "s"})` : ""
          }</span>`
        : "";
    return `<span class="badge brand">Allied-entered</span>${note}`;
  }
  if (source === "myob") {
    // MYOB's own Bill of Materials — the product's stated recipe, and the only
    // source that covers pre-packed kits, which never produce a build.
    return `<span class="badge ok" title="MYOB's own Bill of Materials for this product">MYOB recipe</span>`;
  }
  const pct = Math.round((confidence ?? 0) * 100);
  return `<span class="badge idle" title="Derived from ${buildCount} MYOB build transaction(s)">Derived · ${pct}%</span>`;
}

/** Buildability: from stock as it sits, and including building sub-assemblies. */
function buildabilityHtml(b) {
  if (!b) return "";
  const line = (label, r, note) => {
    if (!r) return "";
    const constraint = r.constraint
      ? ` — first limited by ${itemLink(r.constraint.uid, r.constraint.number ?? "—")}`
      : "";
    return `<li><strong>${label}: ${qty(r.maxUnits)} unit(s)</strong>${constraint}<br /><span class="muted">${note}</span></li>`;
  };
  if (!b.multiLevel) {
    return `<p class="hint">Buildable now from free component stock:
      <strong>${b.asIs == null ? "unknown" : qty(b.asIs.maxUnits)} unit(s)</strong>${
        b.asIs?.constraint
          ? ` — first limited by ${itemLink(b.asIs.constraint.uid, b.asIs.constraint.number ?? "—")}`
          : ""
      }</p>`;
  }
  const unlocked = (b.withSubBuilds?.maxUnits ?? 0) - (b.asIs?.maxUnits ?? 0);
  return `<div class="explain">
      <strong>Buildable now — two answers, because this product contains sub-assemblies:</strong>
      <ul>
        ${line("From stock as it sits", b.asIs, "Counts sub-assemblies only as finished units already on the shelf.")}
        ${line("Including building sub-assemblies first", b.withSubBuilds, "Adds what each sub-assembly could be made from, using its own components.")}
      </ul>
      ${
        unlocked > 0
          ? `Doing the sub-assembly work first unlocks <strong>${qty(unlocked)} more unit(s)</strong>.`
          : "Building sub-assemblies first would not unlock any more units."
      }
      <br /><span class="muted">Both use free stock (on hand − committed) and ignore incoming purchase orders.
      Where two branches need the same base part, the second figure counts it for each branch, so treat it as an upper bound.</span>
    </div>`;
}

async function renderItem(uid) {
  main.innerHTML = '<p class="loading">Loading item…</p>';
  const d = await fetchJson(`/api/insights/items/${encodeURIComponent(uid)}`);
  const i = d.item;
  const s = i.suggestion;

  main.innerHTML = `
    <div class="item-head">
      <p class="crumbs"><a href="#/inventory">&larr; Inventory</a></p>
      <h1 class="item-title">${esc(i.number ?? "—")} · ${esc(i.name ?? "")}</h1>
      <p class="page-sub">${esc(i.description ?? "")}</p>
      <p class="page-sub">
        ${riskPill(i.risk.score)} ${flagChips(i.flags)}
        ${i.isActive === false ? '<span class="badge warn">Inactive in MYOB</span>' : ""}
      </p>
    </div>

    <div class="fact-grid">
      <div class="fact src-myob"><span class="f-label">On hand</span><span class="f-value">${qty(i.qtyOnHand)}</span></div>
      <div class="fact src-myob"><span class="f-label">Committed</span><span class="f-value">${qty(i.qtyCommitted)}</span></div>
      <div class="fact src-myob"><span class="f-label">On order</span><span class="f-value">${qty(i.qtyOnOrder)}</span></div>
      <div class="fact src-myob"><span class="f-label">Available</span><span class="f-value">${qty(i.qtyAvailable)}</span></div>
      <div class="fact src-myob"><span class="f-label">Min level</span><span class="f-value">${qty(i.minLevel)}</span></div>
      <div class="fact src-myob"><span class="f-label">Avg cost</span><span class="f-value">${money(i.averageCost)}</span></div>
      <div class="fact src-platform"><span class="f-label">Free stock</span><span class="f-value">${qty(i.qtyFreeStock)}</span></div>
      <div class="fact src-platform"><span class="f-label">Weekly demand</span><span class="f-value">${i.demand.weekly ? i.demand.weekly.toFixed(1) : "0"}</span></div>
      <div class="fact src-platform"><span class="f-label">Cover</span><span class="f-value">${i.coverWeeks == null ? "—" : `${i.coverWeeks}w`}</span></div>
      <div class="fact src-platform"><span class="f-label">Open PO incoming</span><span class="f-value">${qty(i.incomingQty)}</span></div>
      <div class="fact src-platform" title="${i.parentCountDeep > i.parentCount ? `${i.parentCount} directly, ${i.parentCountDeep - i.parentCount} more via sub-assemblies` : "Direct parents"}"><span class="f-label">Used in products</span><span class="f-value">${i.parentCountDeep || i.parentCount}${i.parentCountDeep > i.parentCount ? `<span class="muted" style="font-size:0.7rem"> (${i.parentCount} direct)</span>` : ""}</span></div>
      ${
        i.potential.qty90 > 0
          ? `<div class="fact src-inferred"><span class="f-label">Potential pack pull 90d</span><span class="f-value">+${qty(i.potential.qty90)}</span></div>`
          : ""
      }
    </div>
    <p class="src-legend"><span class="sw myob"></span>MYOB fact &nbsp; <span class="sw platform"></span>Platform analysis
      ${i.potential.qty90 > 0 ? '&nbsp; <span class="sw inferred"></span>Inferred (not a MYOB movement)' : ""}
      (synced ${ago(i.syncedAt)}) · MYOB "Available" includes stock on order; free stock = on hand − committed</p>

    <div class="two-col" style="margin-top:1.1rem">
      <div>
        <section class="panel">
          <h2>Demand — last 12 months</h2>
          <p class="hint">Dark = direct sales (invoice lines). Orange = consumed by builds of finished products. These are separate MYOB movements — never double counted.</p>
          <div class="bars">${demandBarsHtml(d.monthlyDemand)}</div>
          <p class="hint" style="margin-top:0.6rem">
            90-day: ${qty(i.demand.direct90)} direct + ${qty(i.demand.component90)} via builds ·
            365-day: ${qty(i.demand.direct365)} direct + ${qty(i.demand.component365)} via builds ·
            rate basis: ${i.demand.basis}
          </p>
        </section>

        ${
          (d.potentialParents || []).length
            ? `<section class="panel">
                <h2>Potential demand from packs <span class="badge brand">not counted in totals</span></h2>
                <p class="hint">These finished products sold more units in the last 90 days than were built or bought
                in the same period — the difference came out of stock made earlier. If Allied rebuilds them, this
                component gets pulled by the quantities below. MYOB has not recorded these movements, so this is an
                inference: it is shown separately and never added to weekly demand, cover, suggestions or risk.</p>
                <div class="table-wrap"><table>
                  <thead><tr><th>Finished product</th><th class="num">Sold 90d</th><th class="num">Built</th>
                  <th class="num">Bought</th><th class="num">Unexplained</th><th class="num">Qty per</th>
                  <th class="num">Potential pull</th></tr></thead>
                  <tbody>
                    ${d.potentialParents
                      .map(
                        (p) => `<tr>
                          <td>${itemLink(p.uid, p.number ?? "—")}<br /><span class="muted">${esc((p.name ?? "").slice(0, 40))}</span></td>
                          <td class="num">${qty(p.sold_90)}</td>
                          <td class="num">${qty(p.built_90)}</td>
                          <td class="num">${qty(p.bought_90)}</td>
                          <td class="num">${qty(p.unexplained_units)}</td>
                          <td class="num">${qty(p.qty_per)}</td>
                          <td class="num"><strong>+${qty(p.potential_qty)}</strong></td>
                        </tr>`,
                      )
                      .join("")}
                  </tbody>
                </table></div>
                <p class="hint" style="margin-top:0.6rem">Total potential pull:
                <strong>+${qty(i.potential.qty90)}</strong> over 90 days (~${i.potential.weekly.toFixed(1)}/week)
                versus measured weekly demand of ${i.demand.weekly.toFixed(1)}.</p>
              </section>`
            : ""
        }

        <section class="panel">
          <h2>Recent movements (MYOB evidence)</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Type</th><th>Doc</th><th>Date</th><th class="num">Qty ±</th><th>With / memo</th></tr></thead>
            <tbody>
              ${
                d.movements.length
                  ? d.movements
                      .map((m) => {
                        const [label, tone] = MOVEMENT_KIND[m.kind] ?? [m.kind, "idle"];
                        return `<tr>
                          <td><span class="badge ${tone}">${esc(label)}</span></td>
                          <td>${esc(m.doc ?? "—")}</td>
                          <td>${dateFmt(m.date)}</td>
                          <td class="num">${m.delta > 0 ? "+" : ""}${qty(m.delta)}</td>
                          <td class="muted">${esc(m.counterparty ?? m.description ?? "")}</td>
                        </tr>`;
                      })
                      .join("")
                  : '<tr><td colspan="5" class="muted">No movements in the synced window.</td></tr>'
              }
            </tbody>
          </table></div>
        </section>

        <section class="panel">
          <h2>Purchase history</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Supplier</th><th class="num">Qty</th><th class="num">Unit cost</th></tr></thead>
            <tbody>
              ${
                d.purchases.length
                  ? d.purchases
                      .map(
                        (p) => `<tr><td>${dateFmt(p.date)}</td><td>${esc(p.supplier_name ?? "—")}</td>
                        <td class="num">${qty(p.qty)}</td><td class="num">${price(p.unit_price)}</td></tr>`,
                      )
                      .join("")
                  : '<tr><td colspan="4" class="muted">No bills for this item in the synced window.</td></tr>'
              }
            </tbody>
          </table></div>
        </section>
      </div>

      <div>
        ${
          s
            ? `<section class="panel">
                <h2>Purchasing suggestion</h2>
                <div class="explain">
                  <strong>Order ~${qty(s.qty)} units.</strong>
                  <ul>
                    <li>Weekly demand ${s.rationale.weeklyDemand} (${s.rationale.demandBasis} basis)</li>
                    <li>Target cover ${s.rationale.targetCoverWeeks} weeks + min level ${qty(s.rationale.minLevel)}</li>
                    <li>Less free stock ${qty(s.rationale.freeStock)} and incoming ${qty(s.rationale.incoming)}</li>
                    ${s.rationale.reorderMultiple ? `<li>Rounded to MYOB reorder multiple of ${qty(s.rationale.reorderMultiple)}</li>` : ""}
                  </ul>
                  ${
                    i.excess
                      ? `<p style="margin:0.5rem 0 0"><strong>Note:</strong> this item also holds
                         ${money(i.excess.value)} of stock beyond target cover. The order is suggested only because
                         MYOB's minimum level (${qty(i.minLevel)}) sits well above what demand justifies
                         (${i.demand.weekly.toFixed(1)}/week, ${i.coverWeeks}w cover) — worth reviewing the minimum
                         itself before ordering.</p>`
                      : ""
                  }
                  Decision support only — nothing is sent to MYOB.
                </div>
              </section>`
            : ""
        }

        <section class="panel">
          <h2>Why this risk score</h2>
          ${
            i.risk.factors.length
              ? `<ul style="margin:0;padding-left:1.1rem">${i.risk.factors
                  .map((f) => `<li>${esc(f.label)} <span class="muted">(+${f.points})</span></li>`)
                  .join("")}</ul>`
              : '<p class="muted">No risk factors triggered.</p>'
          }
        </section>

        <section class="panel">
          <h2>Components (this product uses)</h2>
          ${
            d.components.length
              ? `${buildabilityHtml(d.buildability)}
                <div class="table-wrap"><table>
                <thead><tr><th>Component</th><th class="num">Qty per</th><th class="num">Free stock</th><th class="num">Builds</th><th>Source</th></tr></thead>
                <tbody>${d.components
                  .map(
                    (c) => `<tr>
                      <td>${itemLink(c.uid, `${c.number ?? "—"}`)}<br /><span class="muted">${esc((c.name ?? "").slice(0, 40))}</span></td>
                      <td class="num">${qty(c.qty_per)}</td>
                      <td class="num">${qty(c.stock_free)}</td>
                      <td class="num">${c.qty_per > 0 ? qty(Math.floor(Math.max(c.stock_free ?? 0, 0) / c.qty_per)) : "—"}</td>
                      <td>${sourceBadge(c.source, c.confidence, c.build_count, c.shadowed_derived_qty, c.shadowed_build_count)}</td>
                    </tr>`,
                  )
                  .join("")}</tbody>
              </table></div>
              ${
                d.buildability?.multiLevel
                  ? `<h3 class="sub-h">Full structure (${d.buildability.maxDepth} levels)</h3>
                     <p class="hint">Quantities are per one ${esc(i.number ?? "unit")}, multiplied down through each level.</p>
                     <div class="table-wrap"><table>
                       <thead><tr><th>Component</th><th class="num">Qty per parent</th><th class="num">Qty per ${esc(i.number ?? "unit")}</th><th class="num">Free stock</th></tr></thead>
                       <tbody>${d.componentTree
                         .map(
                           (t) => `<tr>
                             <td style="padding-left:${0.5 + (t.depth - 1) * 1.1}rem">
                               ${t.depth > 1 ? '<span class="muted">└ </span>' : ""}${itemLink(t.component_uid, t.number ?? "—")}
                               ${t.has_children ? '<span class="badge idle">sub-assembly</span>' : ""}
                               <br /><span class="muted" style="padding-left:${t.depth > 1 ? 1 : 0}rem">${esc((t.name ?? "").slice(0, 38))}</span>
                             </td>
                             <td class="num">${qty(t.qty_per)}</td>
                             <td class="num"><strong>${qty(t.qty_total)}</strong></td>
                             <td class="num">${qty(t.stock_free)}</td>
                           </tr>`,
                         )
                         .join("")}</tbody>
                     </table></div>`
                  : ""
              }`
              : '<p class="muted">No component relationships observed for this item.</p>'
          }
        </section>

        <section class="panel">
          <h2>Used in (finished products)</h2>
          ${
            d.whereUsed.length
              ? `<div class="table-wrap"><table>
                <thead><tr><th>Product</th><th class="num">Qty per</th><th class="num">Product free stock</th><th>Source</th></tr></thead>
                <tbody>${d.whereUsed
                  .map(
                    (p) => `<tr>
                      <td>${itemLink(p.uid, `${p.number ?? "—"}`)}<br /><span class="muted">${esc((p.name ?? "").slice(0, 40))}</span>
                        ${p.used_higher ? '<br /><span class="badge idle">also a component</span>' : ""}</td>
                      <td class="num">${qty(p.qty_per)}</td>
                      <td class="num">${qty(p.stock_free)}</td>
                      <td>${sourceBadge(p.source, p.confidence, p.build_count)}</td>
                    </tr>`,
                  )
                  .join("")}</tbody>
              </table></div>`
              : '<p class="muted">Not used in any tracked finished product.</p>'
          }
        </section>

        <section class="panel" id="item-suppliers">
          <h2>Suppliers for this product</h2>
          <p class="loading">Loading suppliers…</p>
        </section>

        <section class="panel">
          <h2>Commitments &amp; incoming</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Type</th><th>Doc</th><th>Date</th><th class="num">Qty</th><th>With</th></tr></thead>
            <tbody>
              ${d.commitments
                .map(
                  (c) => `<tr><td><span class="badge fail">SO open</span></td><td>${esc(c.number ?? "—")}</td>
                  <td>${dateFmt(c.promised_date ?? c.date)}</td><td class="num">${qty(c.qty)}</td>
                  <td class="muted">${esc(c.customer_name ?? "")}</td></tr>`,
                )
                .join("")}
              ${d.incoming
                .map(
                  (o) => `<tr><td><span class="badge ok">PO open</span></td><td>${esc(o.number ?? "—")}</td>
                  <td>${dateFmt(o.promised_date ?? o.date)}</td><td class="num">${qty(o.qty)}</td>
                  <td class="muted">${esc(o.supplier_name ?? "")}</td></tr>`,
                )
                .join("")}
              ${
                !d.commitments.length && !d.incoming.length
                  ? '<tr><td colspan="5" class="muted">No open sales orders or purchase orders.</td></tr>'
                  : ""
              }
            </tbody>
          </table></div>
        </section>
      </div>
    </div>`;

  loadItemSuppliers(uid);
}

/* ---------- item suppliers (view / edit, multiple per product) ---------- */

function supplierSourceBadge(source) {
  if (source === "allied") return '<span class="badge brand">Allied-set</span>';
  if (source === "myob") return '<span class="badge idle">MYOB primary</span>';
  if (source === "inferred")
    return '<span class="badge warn" title="No supplier recorded — taken from who has billed this item most">Inferred from purchases</span>';
  return '<span class="badge fail">None</span>';
}

async function loadItemSuppliers(uid) {
  const panel = document.getElementById("item-suppliers");
  if (!panel) return;
  try {
    const d = await fetchJson(`/api/insights/items/${encodeURIComponent(uid)}/suppliers`);
    const canAdd = d.history.filter((h) => !h.already_assigned);

    panel.innerHTML = `
      <h2>Suppliers for this product</h2>
      <p class="hint">Allied's own supplier list for this item — stored in this platform, never written to MYOB.
      A product can have several suppliers; the one marked <strong>preferred</strong> is used for purchasing
      grouping, region reporting and lead times.</p>

      ${
        d.assigned.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Supplier</th><th>Region</th><th>Their item no</th><th>Preferred</th><th></th></tr></thead>
              <tbody>${d.assigned
                .map(
                  (a) => `<tr data-supplier="${esc(a.supplier_uid)}">
                    <td><strong>${esc(a.supplier_name ?? "—")}</strong>
                      ${a.is_active === false ? '<span class="badge warn">Inactive</span>' : ""}
                      ${a.notes ? `<br /><span class="muted">${esc(a.notes)}</span>` : ""}</td>
                    <td>${regionChip(a.region, a.region_source) || '<span class="muted">—</span>'}</td>
                    <td><input class="isup-ref" type="text" placeholder="—" value="${esc(a.supplier_item_number ?? "")}" /></td>
                    <td>${
                      a.is_preferred
                        ? '<span class="badge ok">Preferred</span>'
                        : '<button class="btn small isup-prefer">Make preferred</button>'
                    }</td>
                    <td><button class="btn small isup-remove" title="Remove this supplier from the item">Remove</button></td>
                  </tr>`,
                )
                .join("")}</tbody>
            </table></div>`
          : `<p class="muted">No suppliers recorded yet. ${
              d.item.primary_supplier_name
                ? `MYOB names <strong>${esc(d.item.primary_supplier_name)}</strong> as primary.`
                : "MYOB has no primary supplier for this item."
            }</p>`
      }

      <h3 class="sub-h">Add a supplier</h3>
      <div class="toolbar">
        <input type="search" id="isup-search" placeholder="Type to find a supplier…" autocomplete="off" />
        <label class="isup-check"><input type="checkbox" id="isup-preferred" /> add as preferred</label>
        <span class="muted" id="isup-msg"></span>
      </div>
      <div class="picker" id="isup-list"><p class="loading">Loading suppliers…</p></div>

      ${
        canAdd.length
          ? `<h3 class="sub-h">Suppliers who have actually billed this item</h3>
             <p class="hint">From MYOB purchase history — evidence of who really supplies it. Add with one click.</p>
             <div class="table-wrap"><table>
               <thead><tr><th>Supplier</th><th>Region</th><th class="num">Bills</th><th class="num">Qty</th><th class="num">Last price</th><th>Last bill</th><th></th></tr></thead>
               <tbody>${canAdd
                 .map(
                   (h) => `<tr>
                     <td>${esc(h.supplier_name ?? "—")}</td>
                     <td>${regionChip(h.region, h.region_source) || '<span class="muted">—</span>'}</td>
                     <td class="num">${qty(h.bills)}</td>
                     <td class="num">${qty(h.qty)}</td>
                     <td class="num">${price(h.last_unit_price)}</td>
                     <td>${dateFmt(h.last_date)}</td>
                     <td><button class="btn small isup-quick" data-supplier="${esc(h.supplier_uid)}">Add</button></td>
                   </tr>`,
                 )
                 .join("")}</tbody>
             </table></div>`
          : ""
      }`;

    wireItemSupplierPanel(uid, panel);
  } catch (err) {
    panel.innerHTML = `<h2>Suppliers for this product</h2>
      <p class="muted">Could not load suppliers: ${esc(err.message)}</p>`;
  }
}

function wireItemSupplierPanel(uid, panel) {
  const base = `/api/insights/items/${encodeURIComponent(uid)}/suppliers`;
  const msg = panel.querySelector("#isup-msg");
  const save = async (body) => {
    await fetchJson(base, { method: "POST", body: JSON.stringify(body) });
    await loadItemSuppliers(uid);
  };

  panel.querySelectorAll("tr[data-supplier]").forEach((tr) => {
    const supplierUid = tr.dataset.supplier;
    tr.querySelector(".isup-prefer")?.addEventListener("click", () =>
      save({ supplierUid, isPreferred: true }).catch((e) => alert(e.message)),
    );
    tr.querySelector(".isup-ref")?.addEventListener("change", (e) =>
      save({ supplierUid, supplierItemNumber: e.target.value }).catch((e2) => alert(e2.message)),
    );
    tr.querySelector(".isup-remove")?.addEventListener("click", async () => {
      if (!confirm("Remove this supplier from the product? Allied data only — MYOB is untouched.")) return;
      try {
        await fetchJson(`${base}?supplierUid=${encodeURIComponent(supplierUid)}`, { method: "DELETE" });
        await loadItemSuppliers(uid);
      } catch (e) {
        alert(e.message);
      }
    });
  });

  panel.querySelectorAll(".isup-quick").forEach((btn) =>
    btn.addEventListener("click", () =>
      save({ supplierUid: btn.dataset.supplier }).catch((e) => alert(e.message)),
    ),
  );

  wireSupplierPicker(panel, (supplierUid) =>
    save({ supplierUid, isPreferred: panel.querySelector("#isup-preferred").checked }).catch(
      (e) => (msg.textContent = e.message),
    ),
  );
}

/**
 * Type-ahead supplier picker. The full list is fetched once and filtered in
 * the browser as the user types; an empty box lists every supplier, so it
 * works as a browse-and-click as well as a search.
 */
let supplierCache = null;

async function wireSupplierPicker(panel, onPick) {
  const search = panel.querySelector("#isup-search");
  const list = panel.querySelector("#isup-list");
  if (!search || !list) return;

  const render = (term) => {
    const q = term.trim().toLowerCase();
    const rows = (supplierCache ?? []).filter((s) =>
      !q ? true : `${s.name ?? ""} ${s.display_id ?? ""} ${s.region ?? ""}`.toLowerCase().includes(q),
    );
    list.innerHTML = rows.length
      ? rows
          .map(
            (s) => `<button class="picker-row" data-uid="${esc(s.uid)}">
              <span class="picker-name">${esc(s.name ?? "—")}${
                s.is_active === false ? ' <span class="badge warn">Inactive</span>' : ""
              }</span>
              <span class="picker-meta">${
                s.region ? esc(s.region) : '<span class="muted">no region</span>'
              }</span>
            </button>`,
          )
          .join("")
      : `<p class="muted picker-empty">No supplier matches “${esc(term)}”.</p>`;
    list.querySelectorAll(".picker-row").forEach((btn) =>
      btn.addEventListener("click", () => onPick(btn.dataset.uid)),
    );
  };

  try {
    if (!supplierCache) {
      const r = await fetchJson("/api/insights/supplier-options");
      supplierCache = r.suppliers;
    }
    render(search.value);
    search.addEventListener("input", () => render(search.value));
  } catch (err) {
    list.innerHTML = `<p class="muted">Could not load suppliers: ${esc(err.message)}</p>`;
  }
}

/* ---------- products & BOM ---------- */

async function renderProducts() {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Products &amp; BOM</h1>
        <p class="page-sub">Finished products and their observed composition. Relationships are derived from MYOB build
        transactions (with confidence) or entered by Allied staff — the source is always shown.</p>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="prod-q" placeholder="Search products…" value="${esc(prodState.q)}" />
    </div>
    <div id="prod-table"><p class="loading">Loading products…</p></div>

    <section class="panel">
      <h2>Add relationships (Allied-defined)</h2>
      <p class="hint">Stored in this platform only — <strong>never written to MYOB</strong>. Paste rows from a
      spreadsheet as <code>parent number, component number, qty per parent</code> (one per line; tabs or commas).
      Nothing is saved until you review the check below and confirm.</p>
      <textarea id="bom-paste" rows="5" placeholder="BP1665S16, B1665S16, 1&#10;BP1665S16, N16S16, 1&#10;BP1665S16, WR16506G, 2"></textarea>
      <div class="toolbar" style="margin-top:0.6rem">
        <button class="btn" id="bom-check">Check rows</button>
        <button class="btn primary" id="bom-commit" disabled>Confirm import</button>
        <span class="muted" id="bom-msg"></span>
      </div>
      <div id="bom-preview"></div>
    </section>

    <section class="panel">
      <h2>Products with no known composition <span class="badge idle">blind spot</span></h2>
      <p class="hint" id="blind-hint">Loading…</p>
      <div id="blind-table"></div>
    </section>`;

  const q = document.getElementById("prod-q");
  let debounce;
  q.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      prodState.q = q.value;
      prodState.page = 1;
      loadProductsTable();
    }, 300);
  });

  document.getElementById("bom-check").addEventListener("click", () => runBomImport(false));
  document.getElementById("bom-commit").addEventListener("click", () => runBomImport(true));
  document.getElementById("bom-paste").addEventListener("input", () => {
    // Any edit invalidates the previous check.
    document.getElementById("bom-commit").disabled = true;
  });

  await Promise.all([loadProductsTable(), loadBlindspots()]);
}

/** parent, component, qty — one per line, comma or tab separated. */
function parseBomPaste(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^(parent|#)/i.test(line))
    .map((line) => {
      const parts = line.split(/[\t,;]+/).map((p) => p.trim());
      return { parent: parts[0] ?? "", component: parts[1] ?? "", qtyPer: Number(parts[2]) };
    });
}

async function runBomImport(commit) {
  const msg = document.getElementById("bom-msg");
  const preview = document.getElementById("bom-preview");
  const commitBtn = document.getElementById("bom-commit");
  const rows = parseBomPaste(document.getElementById("bom-paste").value);
  msg.textContent = "";

  if (!rows.length) {
    preview.innerHTML = '<p class="muted">Nothing to check — paste some rows first.</p>';
    return;
  }
  if (commit && !confirm(`Save ${rows.length} relationship row(s) to the Allied platform? MYOB is not touched.`))
    return;

  try {
    const result = await fetchJson("/api/insights/bom/import", {
      method: "POST",
      body: JSON.stringify({ rows, commit }),
    });

    const actionLabel = { new: "New", update: "Update", override_derived: "Overrides derived" };
    preview.innerHTML = `
      <div class="table-wrap"><table>
        <thead><tr><th>#</th><th>Parent</th><th>Component</th><th class="num">Qty per</th><th>Result</th></tr></thead>
        <tbody>
          ${result.rows
            .map(
              (r) => `<tr>
                <td class="muted">${r.idx + 1}</td>
                <td>${esc(r.parent)}${r.parentName ? `<br /><span class="muted">${esc(r.parentName.slice(0, 32))}</span>` : ""}</td>
                <td>${esc(r.component)}${r.componentName ? `<br /><span class="muted">${esc(r.componentName.slice(0, 32))}</span>` : ""}</td>
                <td class="num">${Number.isFinite(r.qtyPer) ? qty(r.qtyPer) : "—"}</td>
                <td>${
                  r.status === "ok"
                    ? `<span class="badge ${r.action === "override_derived" ? "warn" : "ok"}">${actionLabel[r.action] ?? "OK"}</span> <span class="muted">${esc(r.detail)}</span>`
                    : `<span class="badge fail">Rejected</span> <span class="muted">${esc(r.detail)}</span>`
                }</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table></div>`;

    if (commit) {
      msg.textContent = `Saved ${result.applied} row(s). ${result.errorCount} rejected.`;
      commitBtn.disabled = true;
      await Promise.all([loadProductsTable(), loadBlindspots()]);
    } else {
      msg.textContent = `${result.okCount} row(s) ready, ${result.errorCount} rejected. Nothing saved yet.`;
      commitBtn.disabled = result.okCount === 0;
    }
  } catch (err) {
    msg.textContent = err.message;
    commitBtn.disabled = true;
  }
}

async function loadBlindspots() {
  const hint = document.getElementById("blind-hint");
  const table = document.getElementById("blind-table");
  if (!hint || !table) return;
  try {
    const data = await fetchJson("/api/insights/bom/blindspots");
    hint.innerHTML = `${qty(data.total)} product(s) look assembled but have no known composition, so their
      components show no pack-driven pull and no buildability. Ranked by 90-day sales — adding the top rows
      above closes the most valuable gaps first. <span class="muted">Heuristic: ${esc(data.heuristic)}</span>`;
    table.innerHTML = data.items.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Product</th><th class="num">Sold 90d</th><th class="num">Sold 365d</th><th class="num">Free stock</th></tr></thead>
          <tbody>${data.items
            .slice(0, 25)
            .map(
              (b) => `<tr class="rowlink" data-uid="${esc(b.uid)}">
                <td><strong>${esc(b.number ?? "—")}</strong><br /><span class="muted">${esc((b.name ?? "").slice(0, 60))}</span></td>
                <td class="num">${qty(b.sold_90)}</td>
                <td class="num">${qty(b.sold_365)}</td>
                <td class="num">${qty(b.stock_free)}</td>
              </tr>`,
            )
            .join("")}</tbody>
        </table></div>`
      : '<p class="muted">No obvious gaps — every product that looks assembled has a known composition.</p>';
    table.querySelectorAll("tr.rowlink").forEach((tr) =>
      tr.addEventListener("click", () => (location.hash = `#/item/${tr.dataset.uid}`)),
    );
  } catch (err) {
    hint.textContent = `Could not load blind spots: ${err.message}`;
  }
}

async function loadProductsTable() {
  const container = document.getElementById("prod-table");
  if (!container) return;
  container.innerHTML = '<p class="loading">Loading products…</p>';
  const params = new URLSearchParams({ q: prodState.q, page: String(prodState.page) });
  const data = await fetchJson(`/api/insights/products?${params}`);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  container.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Product</th><th class="num">Components</th><th class="num">Free stock</th>
        <th class="num">Sold 90d</th><th class="num">Buildable now</th><th>Confidence</th>
      </tr></thead>
      <tbody>
        ${
          data.parents.length
            ? data.parents
                .map(
                  (p) => `<tr class="rowlink" data-uid="${esc(p.parent_uid)}">
                    <td><strong>${esc(p.number ?? "—")}</strong><br /><span class="muted">${esc((p.name ?? "").slice(0, 60))}</span></td>
                    <td class="num">${qty(p.component_count)}</td>
                    <td class="num">${qty(p.stock_free)}</td>
                    <td class="num">${qty(p.sold_90)}</td>
                    <td class="num">${p.buildable == null ? "—" : qty(p.buildable)}</td>
                    <td>${
                      p.has_user_rows
                        ? '<span class="badge brand">Includes user rows</span>'
                        : `<span class="badge idle">Derived · ${Math.round((p.min_confidence ?? 0) * 100)}%+</span>`
                    }</td>
                  </tr>`,
                )
                .join("")
            : '<tr><td colspan="6" class="muted">No assembled products observed yet. Relationships appear after builds sync, or add them manually below.</td></tr>'
        }
      </tbody>
    </table></div>
    <div class="pager">
      <button class="btn small" id="prod-prev" ${data.page <= 1 ? "disabled" : ""}>&larr; Prev</button>
      <span>Page ${data.page} of ${pages} · ${qty(data.total)} products</span>
      <button class="btn small" id="prod-next" ${data.page >= pages ? "disabled" : ""}>Next &rarr;</button>
    </div>`;

  container.querySelectorAll("tr.rowlink").forEach((tr) =>
    tr.addEventListener("click", () => (location.hash = `#/item/${tr.dataset.uid}`)),
  );
  container.querySelector("#prod-prev")?.addEventListener("click", () => {
    prodState.page -= 1;
    loadProductsTable();
  });
  container.querySelector("#prod-next")?.addEventListener("click", () => {
    prodState.page += 1;
    loadProductsTable();
  });
}

/* ---------- suppliers ---------- */

async function renderSuppliers() {
  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Suppliers</h1>
        <p class="page-sub">MYOB supplier facts with Allied-managed labels: region, lead time, notes.
        Labels live in this platform only — never written to MYOB — and drive the region split on
        Overview, Inventory and Purchasing.</p>
      </div>
    </div>
    <div class="toolbar">
      <input type="search" id="sup-q" placeholder="Search name, city, country, region…" value="${esc(supState.q)}" />
    </div>
    <div id="sup-table"><p class="loading">Loading suppliers…</p></div>`;

  const q = document.getElementById("sup-q");
  let debounce;
  q.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      supState.q = q.value;
      loadSuppliersTable();
    }, 300);
  });

  await loadSuppliersTable();
}

async function saveSupplierMeta(uid, patch, statusEl) {
  try {
    await fetchJson("/api/insights/suppliers/meta", {
      method: "POST",
      body: JSON.stringify({ supplierUid: uid, ...patch }),
    });
    if (statusEl) {
      statusEl.textContent = "saved";
      setTimeout(() => (statusEl.textContent = ""), 1500);
    }
  } catch (err) {
    alert(`Could not save: ${err.message}`);
  }
}

async function loadSuppliersTable() {
  const container = document.getElementById("sup-table");
  if (!container) return;
  container.innerHTML = '<p class="loading">Loading suppliers…</p>';
  const params = new URLSearchParams({ q: supState.q });
  const data = await fetchJson(`/api/insights/suppliers?${params}`);

  const regionOptions = (s) =>
    [
      `<option value="">Auto: ${esc(autoLabel(s))}</option>`,
      ...data.regions.map(
        (r) => `<option value="${esc(r)}" ${s.region_override === r ? "selected" : ""}>${esc(r)}</option>`,
      ),
    ].join("");

  function autoLabel(s) {
    return s.auto_region ? `${s.auto_region}${s.country ? ` (${s.country})` : ""}` : "unlabelled";
  }

  container.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Supplier</th><th>Region (Allied label)</th><th class="num">Items</th>
        <th class="num">Bought 365d</th><th class="num">Open PO value</th>
        <th>Lead time</th><th>Notes</th><th></th>
      </tr></thead>
      <tbody>
        ${
          data.suppliers.length
            ? data.suppliers
                .map(
                  (s) => `<tr data-uid="${esc(s.uid)}">
                    <td>
                      <strong>${esc(s.name ?? "—")}</strong>
                      ${s.is_active === false ? '<span class="badge warn">Inactive</span>' : ""}
                      <br /><span class="muted">${esc([s.city, s.country].filter(Boolean).join(", ") || "No address country in MYOB")}</span>
                    </td>
                    <td>
                      ${regionChip(s.region, s.region_source)}
                      <select class="sup-region">${regionOptions(s)}</select>
                    </td>
                    <td class="num" title="Items supplied: MYOB primary supplier or inferred from purchase history${s.primary_items ? ` (${s.primary_items} set as MYOB primary)` : ""}">${qty(s.supplied_items)}</td>
                    <td class="num">${money(s.purchase_value_365)}<br /><span class="muted">${qty(s.bills_365)} bill(s)</span></td>
                    <td class="num">${money(s.open_po_value)}<br /><span class="muted">${qty(s.open_po_count)} open</span></td>
                    <td>
                      <input class="sup-lead" type="number" min="1" max="365" step="1"
                        placeholder="${s.promised_days != null ? `~${Math.round(s.promised_days)}d promised` : "—"}"
                        value="${s.lead_time_days ?? ""}" title="Allied-set lead time in days${
                          s.promised_days != null
                            ? `. Placeholder = median promised lead from ${s.lead_po_count} PO(s)`
                            : ""
                        }" />
                    </td>
                    <td><input class="sup-notes" type="text" maxlength="500" placeholder="Notes…" value="${esc(s.notes ?? "")}" /></td>
                    <td class="muted sup-status"></td>
                  </tr>`,
                )
                .join("")
            : '<tr><td colspan="8" class="muted">No suppliers synced yet.</td></tr>'
        }
      </tbody>
    </table></div>
    <p class="hint">${qty(data.total)} suppliers · region auto-labels come from the MYOB address country — pick a region to
    override, or "Auto" to fall back. Lead time placeholder shows the median promised lead from MYOB purchase orders;
    typing a value records Allied's own figure.</p>`;

  container.querySelectorAll("tr[data-uid]").forEach((tr) => {
    const uid = tr.dataset.uid;
    const status = tr.querySelector(".sup-status");
    tr.querySelector(".sup-region")?.addEventListener("change", async (e) => {
      await saveSupplierMeta(uid, { region: e.target.value }, status);
      loadSuppliersTable();
    });
    tr.querySelector(".sup-lead")?.addEventListener("change", (e) => {
      const v = e.target.value.trim();
      saveSupplierMeta(uid, { leadTimeDays: v === "" ? null : Number(v) }, status);
    });
    tr.querySelector(".sup-notes")?.addEventListener("change", (e) => {
      saveSupplierMeta(uid, { notes: e.target.value }, status);
    });
  });
}

/* ---------- purchasing ---------- */

async function renderPurchasing() {
  main.innerHTML = '<p class="loading">Building purchasing view…</p>';
  const data = await fetchJson("/api/insights/purchasing");
  const csvUrl = `/api/insights/purchasing.csv${accessKey() ? `?key=${encodeURIComponent(accessKey())}` : ""}`;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Purchasing</h1>
        <p class="page-sub">${qty(data.totalItems)} items suggested or below minimum · target cover ${data.targetCoverWeeks} weeks ·
        grouped by supplier (MYOB primary where set, otherwise inferred from purchase history).
        Suggestions are decision support — nothing is written to MYOB.</p>
      </div>
      <div class="head-actions">
        <a class="btn primary" href="${csvUrl}" download>Export CSV</a>
      </div>
    </div>
    ${
      data.suppliers.length
        ? data.suppliers
            .map(
              (g) => `<section class="panel">
              <h2>${esc(g.supplier)} ${regionChip(g.region, g.regionSource)} <span class="muted" style="text-transform:none;font-weight:500">· ${qty(g.itemCount)} item(s) · est ${money(g.estimatedCost)}</span></h2>
              <div class="table-wrap"><table>
                <thead><tr>
                  <th>Risk</th><th>Item</th><th class="num">Free stock</th><th class="num">Incoming</th>
                  <th class="num">Weekly</th><th>Cover</th><th class="num">Suggested qty</th><th class="num">Est cost</th><th>Flags</th>
                </tr></thead>
                <tbody>${g.items
                  .map(
                    (i) => `<tr class="rowlink" data-uid="${esc(i.uid)}">
                      <td>${riskPill(i.risk.score)}</td>
                      <td><strong>${esc(i.number ?? "—")}</strong><br /><span class="muted">${esc((i.name ?? "").slice(0, 50))}</span>
                        ${i.supplierItemNumber ? `<br /><span class="muted">Supplier ref: ${esc(i.supplierItemNumber)}</span>` : ""}</td>
                      <td class="num">${qty(i.qtyFreeStock)}</td>
                      <td class="num">${qty(i.incomingQty)}</td>
                      <td class="num">${i.demand.weekly ? i.demand.weekly.toFixed(1) : "—"}</td>
                      <td>${coverFmt(i.coverWeeks, i.demand.basis)}</td>
                      <td class="num"><strong>${qty(i.suggestion?.qty ?? 0)}</strong></td>
                      <td class="num">${money((i.suggestion?.qty ?? 0) * (i.averageCost ?? 0))}</td>
                      <td>${flagChips(i.flags)}</td>
                    </tr>`,
                  )
                  .join("")}</tbody>
              </table></div>
            </section>`,
            )
            .join("")
        : '<div class="notice">Nothing currently needs ordering against the target cover. Adjust TARGET_COVER_WEEKS to tune sensitivity.</div>'
    }`;

  main.querySelectorAll("tr.rowlink").forEach((tr) =>
    tr.addEventListener("click", () => (location.hash = `#/item/${tr.dataset.uid}`)),
  );
}

/* ---------- data & sync ---------- */

/*
 * Quantity freshness. MYOB does not bump Item.LastModified when stock moves, so
 * an item that was not re-fetched is silently serving wrong quantities rather
 * than merely lagging. The items entity is always fully refreshed now, so any
 * stale item is a sync bug and must be impossible to miss.
 */
function freshnessNotice(f) {
  if (!f) return "";
  const stale = Number(f.stale_items ?? 0);
  const asOf = f.oldest_quantities_as_of;
  if (stale > 0) {
    return `<div class="notice fail">
      <strong>${qty(stale)} of ${qty(f.inventoried_items)} stocked items did not refresh in the last sync.</strong>
      Their on-hand, committed and available figures are stale, and everything derived from them
      (cover, valuation, purchasing suggestions) is wrong for those items.
      This is a sync fault, not a data condition — run a full sync, and if it persists it needs investigating.
      ${asOf ? `Oldest quantities were read ${ago(asOf)}.` : ""}
    </div>`;
  }
  return `<div class="notice ok">Stock quantities are current — all ${qty(f.inventoried_items)} stocked items
    were re-read from MYOB in the last sync${f.newest_quantities_as_of ? ` (${ago(f.newest_quantities_as_of)})` : ""}.</div>`;
}

async function renderData() {
  main.innerHTML = '<p class="loading">Loading data status…</p>';
  const d = await fetchJson("/api/insights/data");
  const syncStatus = await fetchJson("/api/insights/sync/status");

  const entityLabel = {
    items: "Inventory items",
    locations: "Locations",
    suppliers: "Suppliers",
    sale_invoices: "Sales invoices (item lines)",
    sale_orders: "Sales orders",
    purchase_bills: "Purchase bills",
    purchase_orders: "Purchase orders",
    builds: "Inventory builds",
    adjustments: "Inventory adjustments",
  };

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Data &amp; Sync</h1>
        <p class="page-sub">What has been mirrored from MYOB, how fresh it is, and where the evidence is weak.</p>
      </div>
      <div class="head-actions">
        <button class="btn" id="sync-inc" ${syncStatus.running ? "disabled" : ""}>Incremental sync</button>
        <button class="btn primary" id="sync-full" ${syncStatus.running ? "disabled" : ""}>Full sync</button>
      </div>
    </div>

    ${syncStatus.running ? '<div class="notice warn">A sync is currently running — data below refreshes as it completes.</div>' : ""}
    ${freshnessNotice(d.freshness)}

    <div class="two-col">
      <section class="panel">
        <h2>Synced entities</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Entity</th><th class="num">Rows</th><th>Last synced</th></tr></thead>
          <tbody>
            ${(d.entities || [])
              .map(
                (e) => `<tr>
                  <td>${esc(entityLabel[e.entity] ?? e.entity)}</td>
                  <td class="num">${qty(e.row_count)}</td>
                  <td>${e.last_synced_at ? `${ago(e.last_synced_at)}` : '<span class="badge warn">never</span>'}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table></div>
        <p class="hint" style="margin-top:0.6rem">Transaction history from ${esc(d.settings.syncSince ?? `${d.settings.syncWindowDays} days ago`)} ·
        stock quantities re-read in full every sync, never filtered by MYOB's LastModified.</p>
        <p class="hint">Recipes in use: <strong>${qty(d.counts?.bom_effective)}</strong> across
        ${qty(d.counts?.bom_parents)} products. Where each came from, after Allied-entered beats
        MYOB beats derived — on file: MYOB ${qty(d.counts?.bom_myob)} · derived from builds
        ${qty(d.counts?.bom_derived)} · Allied-entered ${qty(d.counts?.bom_user)}.</p>
      </section>

      <section class="panel">
        <h2>Data quality flags</h2>
        <div class="table-wrap"><table>
          <tbody>
            <tr><td>Negative stock (needs investigation in MYOB)</td><td class="num">${qty(d.dataQuality.negativeStock)}</td></tr>
            <tr><td>Stock on hand with zero average cost</td><td class="num">${qty(d.dataQuality.stockNoCost)}</td></tr>
            <tr><td>Inactive items still holding stock</td><td class="num">${qty(d.dataQuality.inactiveWithStock)}</td></tr>
            <tr><td>Items with demand but no known supplier (no MYOB primary, no purchase history)</td><td class="num">${qty(d.dataQuality.demandNoSupplier)}</td></tr>
            <tr><td>Components whose measured demand understates pack-driven pull</td><td class="num">${qty(d.dataQuality.understatedDemand)}</td></tr>
          </tbody>
        </table></div>
      </section>
    </div>

    <section class="panel">
      <h2>Recent sync runs</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Started</th><th>Mode</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>
          ${
            (d.recentRuns || []).length
              ? d.recentRuns
                  .map(
                    (r) => `<tr>
                      <td>${dateFmt(r.started_at)} ${new Date(r.started_at).toLocaleTimeString()}</td>
                      <td>${esc(r.mode)}</td>
                      <td><span class="badge ${r.status === "success" ? "ok" : r.status === "running" ? "brand" : "fail"}">${esc(r.status)}</span></td>
                      <td class="muted">${esc(r.error ?? summariseStats(r.stats))}</td>
                    </tr>`,
                  )
                  .join("")
              : '<tr><td colspan="4" class="muted">No syncs yet — run the first full sync above.</td></tr>'
          }
        </tbody>
      </table></div>
    </section>

    <section class="panel">
      <h2>Definitions &amp; known limitations</h2>
      <dl class="glossary">
        <dt>Position quantities (on hand, committed, on order, available)</dt>
        <dd>Taken directly from the MYOB item master and never recalculated by this platform.
        Every stocked item is re-read from MYOB on every sync: MYOB does not update an item's
        LastModified when stock moves, so fetching only "changed" items would quietly serve
        month-old quantities. Note: MYOB's "available" includes stock on order (verified against
        Allied's file: available = on hand − committed + on order), so it counts stock that has
        not arrived yet.</dd>
        <dt>Free stock</dt>
        <dd>On hand − committed: physical stock not promised to a customer. This is what cover,
        buildability and purchasing suggestions use, so incoming purchase orders are only ever
        counted once (as "incoming").</dd>
        <dt>Direct demand</dt>
        <dd>Item-layout sales invoice lines. Credit notes have negative quantities and reduce demand automatically.</dd>
        <dt>Component consumption</dt>
        <dd>Negative lines on MYOB Inventory Build transactions — stock used to assemble finished products.
        Separate movements from sales, so combining them does not double count.</dd>
        <dt>Weekly demand / cover</dt>
        <dd>Trailing 90-day rate; items with no 90-day activity fall back to the 365-day rate and are flagged "slow mover".
        Cover = free stock ÷ weekly demand.</dd>
        <dt>Product recipes</dt>
        <dd>MYOB's own Bill of Materials is read directly from the item master and covers auto-build products,
        which never appear as build transactions. Recipes are also derived from MYOB build transactions with a
        single finished item, with confidence growing as more builds corroborate them; anything MYOB does not
        record can still be entered by hand.</dd>
        <dt>Purchasing suggestions</dt>
        <dd>Weekly demand × target cover + minimum level − free stock − incoming, rounded to the MYOB reorder multiple.
        Advisory only.</dd>
        <dt>Excess stock</dt>
        <dd>Free stock beyond the excess threshold (default 26 weeks of cover), valued at average cost and only
        counted when the item has real demand and the excess is worth at least $250 — so a slow mover with a
        handful of cheap washers doesn't drown out genuine overstock. It is the counterpart to shortage risk:
        stock Allied could stop reordering.</dd>
        <dt>"Min level above demand"</dt>
        <dd>An item can be flagged as excess (demand-based) and still suggest an order, because the suggestion
        respects MYOB's minimum level. When both happen, the minimum is far above what demand justifies. Both
        numbers are correct and neither is suppressed — the disagreement is shown so Allied can review the
        minimum level itself, which is usually the real cause of the overstock.</dd>
        <dt>Stock adjustments</dt>
        <dd>MYOB inventory adjustments change stock without a sale, purchase or build (write-offs, stocktake
        corrections, reversals). They are never treated as demand; the Overview lists the largest of the last
        30 days by value so unusual movements get investigated rather than silently absorbed.</dd>
        <dt>Potential demand from packs (inferred — never in totals)</dt>
        <dd>When a pack, kit or dressing set sells more units in 90 days than were built or bought in the same
        period, the difference came out of finished stock made earlier. Rebuilding those units would pull its
        components, but MYOB has recorded no such movement — so the platform reports that pull separately as
        "potential" and never adds it to weekly demand, cover, purchasing suggestions or the risk score.
        Components flagged "Pack pull not counted" either have no measured demand at all or would gain at least
        a quarter again; the item page lists the exact products and arithmetic behind the figure. Coverage is
        limited to products whose composition is known, so it grows as BOM coverage improves.</dd>
        <dt>Suppliers, regions &amp; lead times</dt>
        <dd>A product can have several suppliers. Allied records them on the item page — one marked
        <strong>preferred</strong> — and that preferred supplier is what purchasing grouping, region reporting
        and lead times use. Where Allied has set nothing, the platform falls back to MYOB's primary supplier
        field and then, since Allied's file rarely sets one, to the dominant supplier inferred from
        purchase-bill history. Every view labels which of the three applied (Allied-set / MYOB primary /
        inferred), and supplier records are platform data — MYOB is never written to.
        Region labels are platform data: derived automatically from the supplier's MYOB address country
        (NZ / Australia / China / Overseas — other) and overridable on the Suppliers page. Lead times shown as
        "promised" are the median of MYOB purchase-order date → promised date; Allied-entered lead times are
        platform data and take precedence.</dd>
        <dt>Known limitations</dt>
        <dd>Transactional history is limited to the sync window (${d.settings.syncWindowDays} days). Per-location stock split is not
        exposed by the item master. Documents deleted in MYOB after syncing are only removed by a full sync. Supplier lead
        times are not yet estimated — purchase history is shown for human judgement. Service-layout invoices carry no
        item lines and therefore no item demand.</dd>
      </dl>
    </section>`;

  document.getElementById("sync-inc").addEventListener("click", (e) =>
    startSync("incremental", e.currentTarget),
  );
  document.getElementById("sync-full").addEventListener("click", (e) => {
    if (confirm("Run a full sync? This re-reads the whole history window from MYOB and can take several minutes."))
      startSync("full", e.currentTarget);
  });
}

function summariseStats(stats) {
  if (!stats || typeof stats !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(stats)) {
    if (v && typeof v === "object" && "fetched" in v) parts.push(`${k}: ${v.fetched}`);
  }
  return parts.join(" · ");
}

/* ---------- boot ---------- */

// Allow unlocking via URL: /dashboard?key=XXXX (key is stored, then removed
// from the address bar so it isn't left visible or bookmarked by accident).
const urlKey = new URLSearchParams(location.search).get("key");
if (urlKey) {
  saveKey(urlKey.trim());
  history.replaceState({}, "", location.pathname + location.hash);
}

route();
pollSyncChip();
setInterval(pollSyncChip, 60_000);
