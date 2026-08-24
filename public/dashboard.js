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
    long: "Units sold plus units used building other products, averaged per week over the period set at the top of the page (6 months by default) and up to the date set beside it. If an item did not move at all in that period but did earlier, we fall back to a longer period so it still gets a rate — those items are tagged \"slow mover\".",
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
    short: "Extra units this item would need if the packs that sold were rebuilt. Deliberately left out of every total.",
    long: "Packs and kits often sell out of finished stock built months ago. When a pack sells more than was built or bought in the same period, the shortfall came from that older stock — and replacing it would pull this component all over again. MYOB has recorded no movement for that, so the figure is an inference, shown on its own and never added to demand, cover, purchase suggestions or the risk score. Example: a pack sells 800, only 80 were built and none bought, so 720 packs were never replaced; at 2 of this item per pack, that is 1,440 units of demand nobody can see in the sales figures.",
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
  slow_mover: "This item has not sold or been used at all in the last 6 months, but it did earlier in the year — so its demand is worked out over the longer period instead, giving a slower rate.",
  understated_demand: "Packs holding this item sold without being rebuilt, so the demand and cover figures shown for it are lower than the real usage. Open the item to see which packs and how many units.",
  min_above_demand: "This item is both overstocked against demand and suggested for reorder, because the MYOB minimum level sits far above what demand justifies — worth reviewing the minimum itself.",
};

const FLAG_LABELS = {
  below_min: ["Below min", "fail"],
  negative_stock: ["Negative stock", "fail"],
  stock_no_cost: ["No cost", "warn"],
  inactive_with_stock: ["Inactive w/ stock", "warn"],
  no_supplier: ["No supplier", "warn"],
  slow_mover: ["Slow mover", "idle"],
  understated_demand: ["Demand understated", "brand"],
  min_above_demand: ["Min level above demand", "warn"],
};

/*
 * Facet menu values, fetched once. Declared here rather than beside
 * loadFacetMenus() at the foot of the file: `let` bindings are hoisted but not
 * initialised, and the menus load during the first render, so a late
 * declaration put this in the temporal dead zone and the menus silently came
 * back empty.
 */
let facetCache = null;

const invState = {
  q: "", filter: "all", region: "", sort: "risk", dir: "", page: 1,
  // Independent facets. Kept as separate fields, never combined into one
  // compound category — Allied already do that by hand in MYOB and the whole
  // point of P4 is to stop them having to.
  productType: "", productFinish: "", tag: "",
};

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
  ["understated", "Demand understated by packs"],
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
/**
 * Monthly demand bars, anchored to the selected as-at date rather than to
 * today. Anchored to today, a historical view drew empty months for time that
 * had not happened yet and cut off the months that actually held the data.
 */
function demandBarsHtml(monthlyDemand, barHeight = 100, monthCount = 12) {
  const months = [];
  const [ay, am] = windowState.asAt.split("-").map(Number);
  for (let m = monthCount - 1; m >= 0; m--) {
    const date = new Date(ay, am - 1, 1);
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
  invState.productType = p.get("productType") ?? "";
  invState.productFinish = p.get("productFinish") ?? "";
  invState.tag = p.get("tag") ?? "";
  invState.page = Number(p.get("page")) || 1;
}

function inventoryHash() {
  const p = new URLSearchParams();
  if (invState.q) p.set("q", invState.q);
  if (invState.filter && invState.filter !== "all") p.set("filter", invState.filter);
  if (invState.region) p.set("region", invState.region);
  if (invState.sort && invState.sort !== "risk") p.set("sort", invState.sort);
  if (invState.dir) p.set("dir", invState.dir);
  if (invState.productType) p.set("productType", invState.productType);
  if (invState.productFinish) p.set("productFinish", invState.productFinish);
  if (invState.tag) p.set("tag", invState.tag);
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
    counts: renderCounts,
    data: renderData,
  };
  const bar = document.getElementById("controls");
  if (bar) bar.hidden = !VIEWS_USING_WINDOW.has(view);
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


/* ================= P3: as-at date and rolling window =================
 *
 * Two controls, kept deliberately distinct. `asAt` selects a moment — what was
 * physically on the shelf that day. `windowMonths` selects a period — what sold
 * over it. The client's month-end process asks the first question; their demand
 * analysis asks the second. Presenting them as one date range produces figures
 * that reconcile to nothing.
 *
 * Default window is 6 months: Allied had been using 12, which flattens their
 * spiky demand profile.
 */
/*
 * Views whose figures answer to the two controls. The bar is shown on exactly
 * these — if a page reads the controls its readers must be able to see and
 * change them, and if it ignores them the bar must not imply otherwise.
 */
const VIEWS_USING_WINDOW = new Set([
  "overview",
  "inventory",
  "item",
  "purchasing",
  "products",
  "suppliers",
]);

/*
 * Dates here are calendar dates, not instants, so they must be formatted from
 * local parts. `toISOString()` converts to UTC first, which in New Zealand
 * (UTC+12/+13) rolls the date back a day — "last month end" came out as 30 July
 * instead of 31, and "today" would be yesterday for half of each morning.
 */
function isoLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function todayLocal() {
  return isoLocal(new Date());
}

function lastMonthEnd() {
  const d = new Date();
  return isoLocal(new Date(d.getFullYear(), d.getMonth(), 0));
}

/*
 * Resting state of the two controls: stock as at today, demand over the last
 * 6 months. Anything else is a deliberate choice by the reader, and every view
 * that obeys the controls says so on screen while it is in force.
 *
 * Must match DEFAULT_WINDOW_MONTHS in src/insights/queries.ts — the server
 * applies its own default to requests that omit the parameter, so a mismatch
 * would leave the bar claiming one period while the figures used another.
 */
const WINDOW_DEFAULTS = { windowMonths: 6 };

const windowState = {
  asAt: localStorage.getItem("afAsAt") || todayLocal(),
  windowMonths:
    Number(localStorage.getItem("afWindowMonths")) || WINDOW_DEFAULTS.windowMonths,
};

/** True when both controls sit at their defaults. */
function windowIsDefault() {
  return !isHistorical() && windowState.windowMonths === WINDOW_DEFAULTS.windowMonths;
}

/** Append the two controls to any endpoint that respects them. */
function withWindow(url) {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}asAt=${encodeURIComponent(windowState.asAt)}&windowMonths=${windowState.windowMonths}`;
}

/** True when the selected date is not today — used to warn on stale-looking views. */
function isHistorical() {
  return windowState.asAt !== todayLocal();
}

function windowLabel() {
  const m = windowState.windowMonths;
  return m === 12 ? "12 months" : `${m} months`;
}

function initWindowControls() {
  const bar = document.getElementById("controls");
  const asAt = document.getElementById("ctl-asat");
  const win = document.getElementById("ctl-window");
  const today = todayLocal();

  asAt.value = windowState.asAt;
  asAt.max = today;
  win.value = String(windowState.windowMonths);

  asAt.addEventListener("change", () => {
    windowState.asAt = asAt.value || today;
    localStorage.setItem("afAsAt", windowState.asAt);
    renderControlState();
    route();
  });
  win.addEventListener("change", () => {
    windowState.windowMonths = Number(win.value);
    localStorage.setItem("afWindowMonths", String(windowState.windowMonths));
    renderControlState();
    route();
  });
  document.getElementById("ctl-monthend").addEventListener("click", () => {
    asAt.value = lastMonthEnd();
    asAt.dispatchEvent(new Event("change"));
  });
  document.getElementById("ctl-reset").addEventListener("click", resetWindow);
  renderControlState();
  bar.hidden = false;
}

/** Put both controls back to today / 6 months and re-render. */
function resetWindow() {
  const today = todayLocal();
  const months = String(WINDOW_DEFAULTS.windowMonths);
  const asAt = document.getElementById("ctl-asat");
  const win = document.getElementById("ctl-window");
  if (asAt) asAt.value = today;
  if (win) win.value = months;
  windowState.asAt = today;
  windowState.windowMonths = WINDOW_DEFAULTS.windowMonths;
  localStorage.setItem("afAsAt", today);
  localStorage.setItem("afWindowMonths", months);
  renderControlState();
  route();
}

/**
 * The standing statement of what the controls are set to. Kept in the control
 * bar itself rather than in each page, so it is in the same place whichever
 * view is open, and always visible while a non-default setting is in force.
 */
function renderControlState() {
  const el = document.getElementById("ctl-state");
  if (!el) return;
  if (windowIsDefault()) {
    el.className = "controls-state";
    el.innerHTML = `<span class="badge idle">Default</span> Every figure on this page is stock
      <strong>as at today</strong> and sales over the <strong>last
      ${WINDOW_DEFAULTS.windowMonths} months</strong>.`;
    return;
  }
  el.className = "controls-state changed";
  el.innerHTML = `<span class="badge brand">Custom view</span> Every figure on this page &mdash; stock,
    demand, cover, buildability, suggestions &mdash; is
    <strong>as at ${dateFmt(windowState.asAt)}</strong> over the
    <strong>last ${windowLabel()}</strong>.
    <button class="linkish" id="ctl-state-reset" type="button">Back to today &middot;
    ${WINDOW_DEFAULTS.windowMonths} months</button>`;
  el.querySelector("#ctl-state-reset")?.addEventListener("click", resetWindow);
}

/** Banner shown on every view whose numbers are not "as at today". */
/** Download URL for the as-at position, carrying the access key like other exports. */
function exportPositionUrl() {
  const key = accessKey();
  return `/api/insights/positions.csv?asAt=${encodeURIComponent(windowState.asAt)}${
    key ? `&key=${encodeURIComponent(key)}` : ""
  }`;
}

/**
 * Shown only when the numbers need a caveat.
 *
 * On hand reconstructs cleanly from the ledger at any date. Committed does not:
 * MYOB records an order's status now, never when it changed, so for a date with
 * no stored snapshot we can only count orders still open today — which
 * understates what was actually committed back then. The warning appears on
 * exactly those dates and disappears once a snapshot covers them, so it will
 * stop showing on month-ends from the first full month onward.
 */
function historicalNotice(d) {
  if (!isHistorical()) return "";
  const committed = d && d.hasSnapshot === false
    ? ` <strong>Committed is understated for this date</strong> — it counts only orders still open today,
       because MYOB does not record when an order was fulfilled. Daily snapshots
       ${d.snapshotsFrom ? `began on ${dateFmt(d.snapshotsFrom)}` : "have not started yet"}; from then on
       committed is exact.`
    : "";
  // Provenance is only claimed where the caller knows it. A view that does not
  // report the snapshot flag says nothing rather than guessing.
  const source =
    d && typeof d.hasSnapshot === "boolean"
      ? `, ${d.hasSnapshot ? "from the snapshot stored that day" : "reconstructed from the anchored ledger"}`
      : "";
  return `<div class="notice warn">Showing the stock position <strong>as at ${dateFmt(windowState.asAt)}</strong>${source}.
    Sales and demand cover the ${windowLabel()} up to that date.
    Average cost is today's — MYOB exposes no cost history, so historical valuations are an approximation.${committed}</div>`;
}

/* ---------- overview ---------- */

async function renderOverview() {
  main.innerHTML = '<p class="loading">Loading overview…</p>';
  const data = await fetchJson(withWindow("/api/insights/overview"));
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
    ${historicalNotice(data)}
    <div class="page-head">
      <div>
        <h1>Overview</h1>
        <p class="page-sub">Position facts from MYOB · analysis by this platform · target cover ${data.targetCoverWeeks} weeks</p>
      </div>
      <div class="head-actions">
        <a class="btn" id="export-position" href="${exportPositionUrl()}"
           title="Every stocked item as at the selected date, with the reference point each figure was measured from">
          Export stock position (${dateFmt(windowState.asAt)})
        </a>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><span class="k-label">SKUs</span><span class="k-value">${qty(k.totalSkus)}</span></div>
      <div class="kpi"><span class="k-label">Stock value</span><span class="k-value">${money(k.stockValue)}</span></div>
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
      <select id="inv-type" aria-label="Product type"><option value="">All product types</option></select>
      <select id="inv-finish" aria-label="Product finish"><option value="">All finishes</option></select>
      <select id="inv-tag" aria-label="Tag"><option value="">All tags</option></select>
    </div>
    <div id="inv-facet-note" class="hint" hidden></div>
    <div id="inv-table"><p class="loading">Loading items…</p></div>`;

  // Export what is on screen — the filtered view is the one they built.
  const head = main.querySelector(".page-head");
  if (head) {
    const actions = head.querySelector(".head-actions") ?? (() => {
      const el = document.createElement("div");
      el.className = "head-actions";
      head.appendChild(el);
      return el;
    })();
    const a = document.createElement("a");
    a.className = "btn";
    a.download = "";
    a.textContent = "Export this list";
    a.title = "Every item currently shown, with the filters applied";
    a.href = inventoryCsvUrl();
    actions.appendChild(a);
  }

  const q = document.getElementById("inv-q");
  const filter = document.getElementById("inv-filter");
  const region = document.getElementById("inv-region");
  filter.value = invState.filter;
  region.value = invState.region;
  loadFacetMenus();

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
  if (invState.productType) params.set("productType", invState.productType);
  if (invState.productFinish) params.set("productFinish", invState.productFinish);
  if (invState.tag) params.set("tag", invState.tag);
  const data = await fetchJson(withWindow(`/api/insights/items?${params}`));
  invItems = new Map(data.items.map((i) => [i.uid, i]));
  invTargetCover = data.targetCoverWeeks ?? null;
  invLastDir = data.dir ?? "desc";

  syncInventoryUrl();

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  container.innerHTML = `
    ${historicalNotice(data)}
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

/**
 * Scroll an element into view, smoothly where the browser honours it. Some
 * embedded webviews ignore `behavior: "smooth"` entirely, and a jump control
 * that silently does nothing is worse than an abrupt one — so if nothing has
 * moved shortly after, fall back to an instant jump.
 */
function scrollIntoViewSafely(el, block = "start") {
  if (!el) return;
  const before = window.scrollY;
  const offset = block === "center" ? window.innerHeight / 3 : 12;
  const target = Math.max(el.getBoundingClientRect().top + before - offset, 0);
  el.scrollIntoView({ behavior: "smooth", block });
  setTimeout(() => {
    const moved = Math.abs(window.scrollY - before) > 2;
    if (!moved && Math.abs(target - before) > 2) window.scrollTo(0, target);
  }, 300);
}

/* ---------- pack pull (inferred demand) ---------- */

/**
 * Everything the pack-pull explanation needs, derived once. The inventory
 * expand panel and the item page both render from this so the number, the
 * wording and the percentage can never disagree between the two views.
 */
function packPull(i) {
  const p = i.potential;
  if (!p || !(p.qtyWindow > 0)) return null;
  const measuredWeekly = i.demand.weekly || 0;
  return {
    units: p.qtyWindow,
    weekly: p.weekly,
    parentCount: p.parentCount,
    months: i.demand.windowMonths,
    measuredWeekly,
    // Null when the item has no measured demand at all — a percentage on top
    // of zero says nothing, and that case needs different words anyway.
    upliftPct: measuredWeekly > 0 ? Math.round((p.weekly / measuredWeekly) * 100) : null,
  };
}

/** The single plain-English sentence that explains the figure. */
function packPullSentence(pp) {
  const one = pp.parentCount === 1;
  const packs = `${pp.parentCount} pack${one ? "" : "s"}`;
  const them = one ? "it" : "them";
  if (pp.upliftPct == null)
    return `${packs} containing this item sold without being rebuilt. Replacing ${them} would need about
      <strong>${qty(pp.units)} units</strong> of this item &mdash; and because nothing else moved, its demand
      and cover currently read as if it were never used at all.`;
  // Past a few hundred percent the figure stops reading as a percentage and
  // starts reading as a typo, so say it as a multiple instead.
  const size =
    pp.upliftPct >= 300
      ? `<strong>${Math.round(pp.weekly / pp.measuredWeekly)}&times; the ${pp.measuredWeekly.toFixed(1)} a week
         measured here</strong>`
      : `roughly <strong>${pp.upliftPct}% on top</strong> of the ${pp.measuredWeekly.toFixed(1)} a week
         measured here`;
  return `${packs} containing this item sold without being rebuilt. Replacing ${them} would need about
    <strong>${qty(pp.units)} more units</strong> over the last ${pp.months} months
    (~${pp.weekly.toFixed(1)} a week) &mdash; ${size}.`;
}

/** Measured vs potential weekly demand, to size the gap at a glance. */
function packPullBar(pp) {
  const total = pp.measuredWeekly + pp.weekly;
  if (!(total > 0)) return "";
  const measuredPct = Math.round((pp.measuredWeekly / total) * 100);
  return `
    <div class="pp-bar" role="img"
         aria-label="Measured ${pp.measuredWeekly.toFixed(1)} per week, potential pack pull ${pp.weekly.toFixed(1)} per week">
      <span class="pp-seg measured" style="width:${measuredPct}%"></span>
      <span class="pp-seg potential" style="width:${100 - measuredPct}%"></span>
    </div>
    <p class="pp-legend">
      <span><i class="pp-key measured"></i>Measured demand ${pp.measuredWeekly.toFixed(1)}/wk</span>
      <span><i class="pp-key potential"></i>Potential pack pull +${pp.weekly.toFixed(1)}/wk</span>
    </p>`;
}

/**
 * The compact version for the inventory expand panel. A bare "+3,073" row read
 * as another demand figure staff should act on, which is the one thing this
 * number must never be taken for — so it is boxed, labelled as not counted,
 * and says in words what it would mean.
 */
function packPullCallout(i) {
  const pp = packPull(i);
  if (!pp) return "";
  return `
    <div class="pp-callout">
      <p class="pp-head">
        <span class="term" title="${esc(TERMS.potential.short)}">Potential pack pull</span>
        <span class="pp-figure">+${qty(pp.units)}</span>
        <span class="badge brand">Not counted above</span>
      </p>
      <p class="pp-body">${packPullSentence(pp)}</p>
      <p class="pp-body muted">Open the item to see which packs and the sold &minus; built &minus; bought working.</p>
    </div>`;
}

/**
 * The full explanation on the item page. Ordered the way a person asks the
 * question: what it means, how big it is next to real demand, then the
 * per-pack arithmetic. The column headings carry the operators (− − = ×) so
 * the table reads as the sum it is rather than six unrelated numbers.
 */
function packPullPanel(i, parents) {
  const pp = packPull(i);
  if (!pp) return "";
  const months = i.demand.windowMonths;
  return `
    <section class="panel" id="pack-pull">
      <h2>Demand hiding in packs <span class="badge brand">not counted anywhere else</span></h2>

      <div class="pp-callout lead">
        <p class="pp-head">
          <span class="pp-figure big">+${qty(pp.units)}</span>
          <span class="muted">units of potential pull over ${months} months</span>
        </p>
        <p class="pp-body">${packPullSentence(pp)}</p>
        ${packPullBar(pp)}
      </div>

      <p class="hint">MYOB never recorded these movements &mdash; the packs left the door out of stock built
      earlier &mdash; so this figure is worked out, not observed. It is shown on its own and is
      <strong>never</strong> added to weekly demand, cover, purchase suggestions or the risk score. Treat it as
      a prompt to check whether these packs are due to be rebuilt, not as stock to order.</p>

      <h3 class="sub-h">Where it comes from</h3>
      <p class="hint">For each pack: what sold, minus what was built, minus what was bought in, leaves the packs
      that were never replaced. Multiply by how many of this item each pack takes.</p>
      <div class="table-wrap"><table class="pp-table">
        <thead><tr>
          <th>Pack that sold</th>
          <th class="num" title="Units of the pack invoiced in the window">Sold ${months}m</th>
          <th class="num" title="Units of the pack made by MYOB build transactions in the window">&minus; Built</th>
          <th class="num" title="Units of the pack bought in ready-made from a supplier">&minus; Bought</th>
          <th class="num" title="Packs that sold but were never replaced — these came from stock built earlier">= Never replaced</th>
          <th class="num" title="How many of this item one pack takes">&times; Per pack</th>
          <th class="num" title="Units of this item that rebuilding those packs would pull">= Potential pull</th>
        </tr></thead>
        <tbody>
          ${parents
            .map(
              (p) => `<tr>
                <td>${itemLink(p.uid, p.number ?? "—")}<br /><span class="muted">${esc((p.name ?? "").slice(0, 40))}</span></td>
                <td class="num">${qty(p.sold_window)}</td>
                <td class="num">${qty(p.built_window)}</td>
                <td class="num">${qty(p.bought_window)}</td>
                <td class="num">${qty(p.unexplained_units)}</td>
                <td class="num">${qty(p.qty_per)}</td>
                <td class="num"><strong>+${qty(p.potential_qty)}</strong></td>
              </tr>`,
            )
            .join("")}
        </tbody>
        <tfoot><tr>
          <td colspan="6">Total potential pull</td>
          <td class="num"><strong>+${qty(pp.units)}</strong></td>
        </tr></tfoot>
      </table></div>
    </section>`;
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
    ${kvRow("On hand", `${qty(i.qtyOnHand)}${derivationNote(i)}`)}
    ${kvRow("Committed", `${qty(i.qtyCommitted)}${committedNote(i)}`)}
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
    ${kvRow(`Direct sales · last ${i.demand.windowMonths}m / ${i.demand.longMonths}m`, `${qty(i.demand.directWindow)} / ${qty(i.demand.directLong)}`)}
    ${kvRow(`Via builds · last ${i.demand.windowMonths}m / ${i.demand.longMonths}m`, `${qty(i.demand.componentWindow)} / ${qty(i.demand.componentLong)}`)}
    ${packPullCallout(i)}
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
      detail = await fetchJson(withWindow(`/api/insights/items/${encodeURIComponent(uid)}`));
      itemDetailCache.set(uid, detail);
    }
    const moves = (detail.movements || []).slice(0, 5);
    el.innerHTML = `
      <div class="expand-extra-grid">
        <div>
          <h3>Demand — ${detail.chartMonths ?? 12} months to ${dateFmt(windowState.asAt)}</h3>
          <div class="bars small">${demandBarsHtml(detail.monthlyDemand, 48, detail.chartMonths ?? 12)}</div>
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


/* ---------- derivation: show the working behind every position number ---------- */

const ANCHOR_LABEL = {
  opening_balance: "opening balance",
  myob_adjustment: "stocktake recorded in MYOB",
  manual: "count entered by Allied",
  csv_import: "count imported by Allied",
};

/**
 * How this on-hand figure was reached: the anchor it started from, and the
 * movements applied since. The client is auditing these numbers against their
 * own spreadsheets, so an unexplained figure is one they will not act on.
 */
function derivationNote(i) {
  if (!i.anchorDate) return "";
  const src = ANCHOR_LABEL[i.anchorSource] ?? i.anchorSource;
  const moves = i.movementsSinceAnchor ?? 0;
  const sign = moves > 0 ? "+" : "";
  const detail =
    `${qty(i.anchorQty)} at the ${src} on ${dateFmt(i.anchorDate)}` +
    (moves ? `, ${sign}${qty(moves)} from movements since` : ", no movements since");
  const diverged =
    i.divergence != null && Math.abs(i.divergence) > 0.001
      ? ` <span class="badge warn" title="MYOB says ${qty(i.myobOnHand)}">MYOB differs by ${qty(i.divergence)}</span>`
      : "";
  return ` <span class="muted" title="${esc(detail)}">·&nbsp;why?</span>${diverged}`;
}

/** Committed is our own sum of open sale orders, and it often beats MYOB's. */
function committedNote(i) {
  const mine = i.qtyCommitted ?? 0;
  const theirs = i.myobCommitted ?? 0;
  if (Math.abs(mine - theirs) < 0.001) return "";
  return ` <span class="badge warn" title="Counted from open sale orders. MYOB reports ${qty(theirs)}, which would read as ${theirs < mine ? "free-to-sell stock that is already promised" : "stock withheld that is actually available"}.">MYOB says ${qty(theirs)}</span>`;
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
  const d = await fetchJson(withWindow(`/api/insights/items/${encodeURIComponent(uid)}`));
  const i = d.item;
  const s = i.suggestion;

  main.innerHTML = `
    ${historicalNotice(d)}
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
        i.potential.qtyWindow > 0
          ? `<button type="button" class="fact src-inferred fact-link" data-scroll-to="pack-pull"
                title="${esc(TERMS.potential.short)}">
               <span class="f-label">Potential pack pull</span>
               <span class="f-value">+${qty(i.potential.qtyWindow)}</span>
               <span class="f-note">not in demand or cover &mdash; see why &darr;</span>
             </button>`
          : ""
      }
    </div>
    <p class="src-legend"><span class="sw myob"></span>MYOB fact &nbsp; <span class="sw platform"></span>Platform analysis
      ${i.potential.qtyWindow > 0 ? '&nbsp; <span class="sw inferred"></span>Inferred (not a MYOB movement)' : ""}
      (synced ${ago(i.syncedAt)}) · MYOB "Available" includes stock on order; free stock = on hand − committed</p>

    <div class="two-col" style="margin-top:1.1rem">
      <div>
        <section class="panel">
          <h2>Demand — ${d.chartMonths ?? 12} months to ${dateFmt(windowState.asAt)}</h2>
          <p class="hint">Dark = direct sales (invoice lines). Orange = consumed by builds of finished products. These are separate MYOB movements — never double counted.</p>
          <div class="bars">${demandBarsHtml(d.monthlyDemand, 100, d.chartMonths ?? 12)}</div>
          <p class="hint" style="margin-top:0.6rem">
            Last ${i.demand.windowMonths} months: ${qty(i.demand.directWindow)} direct + ${qty(i.demand.componentWindow)} via builds ·
            Last ${i.demand.longMonths} months: ${qty(i.demand.directLong)} direct + ${qty(i.demand.componentLong)} via builds ·
            rate basis: ${i.demand.basis}
          </p>
        </section>

        ${
          (d.potentialParents || []).length
            ? packPullPanel(i, d.potentialParents)
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

        <section class="panel" id="item-tags">
          <h2>Tags</h2>
          <p class="hint">Allied's own labels — "slow movers", "from China", "needs attention".
          Many per item, filterable from the Inventory page, and never written to MYOB.
          Tags are how a product gets reclassified without inventing a new item code.</p>
          <div id="item-tag-list"></div>
          <div class="form-row">
            <input type="text" id="item-tag-new" placeholder="Add a tag…" maxlength="60" />
            <button class="btn" id="item-tag-add" type="button">Add</button>
          </div>
        </section>

        <section class="panel" id="item-ledger">
          <h2>How this stock figure was reached</h2>
          <p class="loading">Loading the trail…</p>
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

  // Hash links would be swallowed by the router, so in-page jumps scroll by hand.
  main.querySelectorAll("[data-scroll-to]").forEach((el) =>
    el.addEventListener("click", () =>
      scrollIntoViewSafely(document.getElementById(el.dataset.scrollTo)),
    ),
  );

  renderItemTags(uid, d.item.tags ?? []);
  loadItemLedger(uid);
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
    ${historicalNotice()}
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

/**
 * Jump from an empty search straight into recording the missing recipe, with
 * the parent number already filled in so the only thing left to type is what
 * the item is made of.
 */
function startBomEntry(number) {
  const box = document.getElementById("bom-paste");
  if (!box) return;
  const starter = `${number}, COMPONENT-NUMBER, 1`;
  box.value = box.value.trim() ? `${box.value.replace(/\s+$/, "")}\n${starter}` : starter;
  document.getElementById("bom-commit").disabled = true;
  document.getElementById("bom-msg").textContent =
    `Replace COMPONENT-NUMBER with what ${number} is made of, one line per component, then check the rows.`;
  scrollIntoViewSafely(box, "center");
  box.focus();
  // Select the placeholder so typing the real component number replaces it.
  const at = box.value.lastIndexOf("COMPONENT-NUMBER");
  if (at >= 0) box.setSelectionRange(at, at + "COMPONENT-NUMBER".length);
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
    const data = await fetchJson(withWindow("/api/insights/bom/blindspots"));
    const w = data.window;
    hint.innerHTML = `${qty(data.total)} product(s) look assembled but have no known composition, so their
      components show no pack-driven pull and no buildability. Ranked by sales over the selected
      ${w.windowMonths}-month window — adding the top rows above closes the most valuable gaps first.
      <span class="muted">Heuristic: ${esc(data.heuristic)}</span>`;
    table.innerHTML = data.items.length
      ? `<div class="table-wrap"><table>
          <thead><tr><th>Product</th><th class="num">Sold ${w.windowMonths}m</th><th class="num">Sold ${w.longMonths}m</th><th class="num">Free stock</th></tr></thead>
          <tbody>${data.items
            .slice(0, 25)
            .map(
              (b) => `<tr class="rowlink" data-uid="${esc(b.uid)}">
                <td><strong>${esc(b.number ?? "—")}</strong><br /><span class="muted">${esc((b.name ?? "").slice(0, 60))}</span></td>
                <td class="num">${qty(b.sold_window)}</td>
                <td class="num">${qty(b.sold_long)}</td>
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

/**
 * What an empty products table means. This page lists only items with a known
 * composition (~500 of 3,100), so a search for a real item number comes back
 * empty and reads like a typo. Name the item, say why it is absent, and offer
 * the one action that fixes it.
 */
function productsEmptyState(data) {
  const q = prodState.q.trim();
  if (!q)
    return '<span class="muted">No assembled products observed yet. Relationships appear after builds sync, or add them manually below.</span>';

  const matches = data.noRecipeMatches ?? [];
  if (!matches.length)
    return `<span class="muted">No product matches &ldquo;${esc(q)}&rdquo;, and no inventory item matches it either &mdash; check the number.</span>`;

  return `
    <div class="empty-state">
      <p><strong>No recipe on file.</strong> This page lists only items with a known composition, so
      ${matches.length === 1 ? "this item does not appear" : "these items do not appear"} here even though
      ${matches.length === 1 ? "it exists" : "they exist"} in inventory.</p>
      <ul class="empty-matches">
        ${matches
          .map(
            (m) => `<li>
              <a href="#/item/${esc(m.uid)}"><strong>${esc(m.number ?? "—")}</strong></a>
              <span class="muted">${esc((m.name ?? "").slice(0, 60))}</span>
              ${m.is_active === false ? '<span class="badge idle">Inactive</span>' : ""}
              ${
                m.used_in_count > 0
                  ? `<span class="badge brand">Used as a component in ${qty(m.used_in_count)} product(s)</span>`
                  : '<span class="badge idle">Not used as a component either</span>'
              }
              <button class="btn small" data-add-bom="${esc(m.number ?? "")}">Add a recipe</button>
            </li>`,
          )
          .join("")}
      </ul>
      <p class="muted">A recipe is only needed if the item is <em>assembled</em>. A bought-in part with no
      components is correctly absent &mdash; its stock and demand still show on the Inventory page.</p>
    </div>`;
}

async function loadProductsTable() {
  const container = document.getElementById("prod-table");
  if (!container) return;
  container.innerHTML = '<p class="loading">Loading products…</p>';
  const params = new URLSearchParams({ q: prodState.q, page: String(prodState.page) });
  const data = await fetchJson(withWindow(`/api/insights/products?${params}`));
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  container.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Product</th><th class="num">Components</th><th class="num">Free stock</th>
        <th class="num">Sold ${data.window.windowMonths}m</th><th class="num">Buildable</th><th>Confidence</th>
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
                    <td class="num">${qty(p.sold_window)}</td>
                    <td class="num">${p.buildable == null ? "—" : qty(p.buildable)}</td>
                    <td>${
                      p.has_user_rows
                        ? '<span class="badge brand">Includes user rows</span>'
                        : `<span class="badge idle">Derived · ${Math.round((p.min_confidence ?? 0) * 100)}%+</span>`
                    }</td>
                  </tr>`,
                )
                .join("")
            : `<tr><td colspan="6">${productsEmptyState(data)}</td></tr>`
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
  container.querySelectorAll("[data-add-bom]").forEach((btn) =>
    btn.addEventListener("click", () => startBomEntry(btn.dataset.addBom)),
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
    ${historicalNotice()}
    <div class="page-head">
      <div>
        <h1>Suppliers</h1>
        <p class="page-sub">MYOB supplier facts with Allied-managed labels: region, lead time, notes.
        Labels live in this platform only — never written to MYOB — and drive the region split on
        Overview, Inventory and Purchasing.</p>
        <div class="head-actions">
        <a class="btn" href="${suppliersCsvUrl()}" download>Export suppliers</a>
      </div>
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
  const data = await fetchJson(withWindow(`/api/insights/suppliers?${params}`));

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
        <th class="num">Bought ${data.window.windowMonths}m</th><th class="num">Open PO value</th>
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
                    <td class="num">${money(s.purchase_value_window)}<br /><span class="muted">${qty(s.bills_window)} bill(s)</span></td>
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

/**
 * Items where the platform disagrees with MYOB, priced by what the gap is worth.
 * Committed and on-hand are separated because they diverge for different
 * reasons: committed the moment MYOB miscounts open orders, on hand only once a
 * real count lands or the movement ledger parts company with MYOB's.
 */
async function loadDivergence() {
  const el = document.getElementById("divergence-panel");
  if (!el) return;
  try {
    const d = await fetchJson("/api/insights/divergence");
    const body = el.querySelector(".loading");
    if (!d.items.length) {
      body.outerHTML = '<p class="muted">Nothing differs — every figure reconciles to MYOB today.</p>';
      return;
    }
    body.outerHTML = `
      <div class="kpis">
        <div class="kpi"><span class="k-label">Committed differs</span><span class="k-value">${qty(d.committedDiverging)}</span></div>
        <div class="kpi"><span class="k-label">Value at stake</span><span class="k-value">${money(d.committedValueAtRisk)}</span></div>
        <div class="kpi"><span class="k-label">On hand differs</span><span class="k-value">${qty(d.onHandDiverging)}</span></div>
        <div class="kpi"><span class="k-label">Stock value differs</span><span class="k-value">${qty(d.valueDiverging)}</span></div>
        <div class="kpi"><span class="k-label">Value difference</span><span class="k-value">${money(d.valueDifference)}</span></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Item</th><th class="num">Our committed</th><th class="num">MYOB</th>
          <th class="num">Our on hand</th><th class="num">MYOB</th>
          <th class="num">Our value</th><th class="num">MYOB</th><th>Anchored to</th></tr></thead>
        <tbody>${d.items.slice(0, 40).map((r) => `<tr>
          <td><strong>${esc(r.number ?? "—")}</strong><br /><span class="muted">${esc(r.name ?? "")}</span></td>
          <td class="num">${qty(r.committed)}</td>
          <td class="num ${Math.abs(r.committed_divergence ?? 0) > 0.001 ? "alert" : ""}">${qty(r.myob_committed)}</td>
          <td class="num">${qty(r.on_hand)}</td>
          <td class="num ${Math.abs(r.divergence ?? 0) > 0.001 ? "alert" : ""}">${qty(r.myob_on_hand)}</td>
          <td class="num">${money(r.our_stock_value)}</td>
          <td class="num ${Math.abs(r.value_divergence ?? 0) > 0.5 ? "alert" : ""}">${money(r.myob_stock_value)}</td>
          <td class="muted">${esc(ANCHOR_LABEL[r.anchor_source] ?? r.anchor_source ?? "—")}<br />${r.anchor_date ? dateFmt(r.anchor_date) : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      ${d.items.length > 40 ? `<p class="hint">Showing the 40 largest of ${qty(d.items.length)}.</p>` : ""}`;
  } catch (err) {
    const body = el.querySelector(".loading");
    if (body) body.outerHTML = `<p class="muted">Could not load divergence: ${esc(err.message)}</p>`;
  }
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
            <tr><td>Components whose demand is understated by packs sold but not rebuilt</td><td class="num">${qty(d.dataQuality.understatedDemand)}</td></tr>
          </tbody>
        </table></div>
      </section>
    </div>

    <section class="panel" id="divergence-panel">
      <h2>Where our figures differ from MYOB</h2>
      <p class="hint">On hand and committed are computed here from Allied's own documents —
      counts, bills, invoices, builds, adjustments and open sale orders — not read from MYOB.
      Anything listed below is a real disagreement worth understanding, not a rounding artefact.</p>
      <p class="loading">Loading divergence…</p>
    </section>

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
        <dt>Dates and time zone</dt>
        <dd>Every date shown — the as-at date, count dates, snapshot dates and the rolling window —
        is a <strong>New Zealand calendar date</strong>, matching MYOB and Allied's own month-end.
        The server and database run in UTC, which is 12–13 hours behind, so dates are converted
        rather than taken from the server clock. Without that conversion a position captured at
        6am on the 20th would have been filed under the 19th.</dd>
        <dt>Stock value</dt>
        <dd>Our on hand × the item's average cost from MYOB, which is Allied's standing valuation
        policy and what their month-end reporting uses. It is calculated here rather than read from
        MYOB's stored value, for two reasons: on hand is our figure, so reading MYOB's value would
        price our quantity at theirs; and MYOB's stored value is not always right — SW101616G4 holds
        180 units at $1.87 and is recorded as $3.36 instead of $336.00. Last buy price is never used.</dd>
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
        <dd>Weekly demand is units sold plus units used building other products, averaged per week over the
        period set at the top of the page — 6 months by default — ending on the date set beside it.
        Cover = free stock &divide; weekly demand: how many weeks the stock on the shelf would last.</dd>
        <dt>How we spot a slow mover</dt>
        <dd>An item is tagged <strong>slow mover</strong> when it has not sold or been used <em>at all</em> in
        the last 6 months, but it did move earlier in the year. Rather than show it as having no demand, we
        work its rate out over the longer period instead, which naturally gives a slower one.
        <br /><br />
        <strong>For example:</strong> 60 units went out over the past year, but nothing since February. Left on
        the 6-month view the item looks dead and would never be reordered. Spread over the year it comes out at
        roughly 1 a week — so 200 on the shelf reads as about 4 years of cover, which is the honest answer:
        it still sells, just slowly, and you are carrying far too much of it.
        <br /><br />
        This is what stops the two mistakes at either end — treating a quiet item as finished and letting it run
        out, or reordering it as if it were a fast seller. <strong>Dead stock</strong> is a slow mover that is
        also carrying excess. Both periods shift if you change the setting at the top of the page.</dd>
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
        <dt>Demand hiding in packs — "potential pack pull" (inferred, never in totals)</dt>
        <dd>A pack, kit or dressing set often sells out of finished stock built months ago. When one sells more
        in the window than was built or bought in the same window, the shortfall came from that older stock, and
        replacing it would pull its components all over again. MYOB has recorded no movement for that, so the
        platform works the figure out — <em>sold − built − bought = packs never replaced, × how many per
        pack</em> — reports it on its own, and never adds it to weekly demand, cover, purchasing suggestions or
        the risk score. Items tagged <strong>Demand understated</strong> are the ones where it matters: either
        nothing else moved at all, or the hidden pull would add at least a quarter again. The item page shows
        every pack behind the figure and the arithmetic for each. Coverage is limited to products whose
        composition is known, so it grows as BOM coverage improves.</dd>
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

  loadDivergence();
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

initWindowControls();
route();
pollSyncChip();
setInterval(pollSyncChip, 60_000);

/* ================= Stock counts (P1) =================
 *
 * One page for the three things Allied do with physical counts:
 *   1. confirm which MYOB adjustments were genuinely stocktakes,
 *   2. enter a count for a single item,
 *   3. paste a whole counting sheet in.
 *
 * A confirmed or entered count becomes the anchor the whole ledger hangs off,
 * so this page is where the platform's numbers stop simply agreeing with MYOB.
 */

const COUNT_SOURCE_LABEL = {
  opening_balance: "Opening balance",
  myob_adjustment: "Stocktake in MYOB",
  manual: "Entered by Allied",
  csv_import: "Imported by Allied",
};

async function renderCounts() {
  main.innerHTML = '<p class="loading">Loading stock counts…</p>';
  const d = await fetchJson("/api/insights/stocktakes");
  const cov = d.coverage ?? {};
  const anchored = Number(cov.anchored_items ?? 0);
  const total = Number(cov.inventoried_items ?? 0);
  const realCounts = d.candidates.filter((c) => c.confirmed === true).length;
  const pending = d.candidates.filter((c) => c.confirmed == null);

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1>Stock counts</h1>
        <p class="page-sub">A physical count is the reference point every stock figure is built from.
        Confirm the counts already in MYOB, or record one Allied has just done.</p>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><span class="k-label">Items anchored to a real count</span><span class="k-value">${qty(realCounts ? cov.drift?.counted_lines ?? 0 : 0)}</span></div>
      <div class="kpi"><span class="k-label">Still on the opening balance</span><span class="k-value">${qty(anchored - (cov.drift?.counted_lines ?? 0))}</span></div>
      <div class="kpi ${pending.length ? "warn" : ""}"><span class="k-label">Counts awaiting confirmation</span><span class="k-value">${qty(pending.length)}</span></div>
      <div class="kpi"><span class="k-label">Stocked items in total</span><span class="k-value">${qty(total)}</span></div>
    </div>

    <div class="two-col">
      <section class="panel">
        <h2>Record a count</h2>
        <p class="hint">Enter what was physically counted. From that moment the item's stock figure is
        driven by your count plus the movements since — not by MYOB.</p>
        <div class="count-form">
          <label>Item
            <input type="search" id="count-item" placeholder="Type an item number…" autocomplete="off" />
          </label>
          <div class="picker" id="count-item-list" hidden></div>
          <label>Counted quantity
            <input type="number" id="count-qty" step="any" min="0" placeholder="e.g. 1250" />
          </label>
          <label>Count date
            <input type="date" id="count-date" value="${todayLocal()}" />
          </label>
          <label>Note (optional)
            <input type="text" id="count-note" placeholder="Counted by…" />
          </label>
          <button class="btn primary" id="count-save" disabled>Record count</button>
          <p id="count-result" class="hint"></p>
        </div>
      </section>

      <section class="panel">
        <h2>Paste a counting sheet</h2>
        <p class="hint">One row per item: <code>item number, counted quantity</code>. Everything is checked
        before anything is saved, so a mistake halfway down cannot leave the ledger half-updated.</p>
        <textarea id="count-bulk" rows="8" placeholder="BN1675G, 420&#10;N12S16, 18449&#10;WR16503G, 31000"></textarea>
        <div class="form-row">
          <label>Count date <input type="date" id="count-bulk-date" value="${todayLocal()}" /></label>
          <button class="btn" id="count-bulk-check">Check</button>
          <button class="btn primary" id="count-bulk-save" disabled>Save counts</button>
        </div>
        <div id="count-bulk-result"></div>
      </section>
    </div>

    <section class="panel">
      <h2>Stocktakes found in MYOB</h2>
      <p class="hint">Detected by memo wording, which Allied write inconsistently — so these are
      <strong>suggestions, not conclusions</strong>. Confirm the ones that were genuine physical counts and
      they become anchors; reject the ones that were something else. "Corrected" is the net change the
      count made, after offsetting lines on the same item cancel out.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Memo</th><th class="num">Items</th><th class="num">Corrected</th>
          <th class="num">Value</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${d.candidates.map((c) => `<tr data-adj="${esc(c.adjustmentUid)}">
            <td>${dateFmt(c.date)}</td>
            <td>${esc((c.memo ?? "").replace(/\s+/g, " ").slice(0, 70))}
              ${c.strictMatch ? "" : '<br /><span class="badge idle" title="Matched only a loose keyword — check carefully">weak match</span>'}</td>
            <td class="num">${qty(c.itemCount)}${c.itemsNetZero ? `<br /><span class="muted" title="Lines that cancel out entirely">${c.itemsNetZero} net zero</span>` : ""}</td>
            <td class="num">${qty(Math.round(c.unitsCorrected))}</td>
            <td class="num">${money(c.valueCorrected)}</td>
            <td>${
              c.confirmed === true
                ? '<span class="badge ok">Confirmed</span>'
                : c.confirmed === false
                  ? '<span class="badge idle">Not a count</span>'
                  : '<span class="badge warn">Needs review</span>'
            }</td>
            <td class="nowrap">
              <button class="btn small st-yes" ${c.confirmed === true ? "disabled" : ""}>Was a count</button>
              <button class="btn small st-no" ${c.confirmed === false ? "disabled" : ""}>Wasn't</button>
            </td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </section>`;

  wireCountForm();
  wireBulkCounts();
  wireStocktakeButtons();
}

/** Single-item count entry, with a type-ahead so the item number is never guessed. */
function wireCountForm() {
  const input = document.getElementById("count-item");
  const list = document.getElementById("count-item-list");
  const save = document.getElementById("count-save");
  const result = document.getElementById("count-result");
  let chosen = null;

  const refresh = () => { save.disabled = !chosen || document.getElementById("count-qty").value === ""; };
  document.getElementById("count-qty").addEventListener("input", refresh);

  let timer;
  input.addEventListener("input", () => {
    chosen = null; refresh();
    clearTimeout(timer);
    const term = input.value.trim();
    if (term.length < 2) { list.hidden = true; return; }
    timer = setTimeout(async () => {
      try {
        const r = await fetchJson(`/api/insights/items?q=${encodeURIComponent(term)}&limit=8`);
        const rows = r.items ?? r.rows ?? [];
        list.hidden = false;
        list.innerHTML = rows.length
          ? rows.map((i) => `<button type="button" class="picker-row" data-uid="${esc(i.uid)}" data-num="${esc(i.number)}">
               <strong>${esc(i.number)}</strong> <span class="muted">${esc(i.name ?? "")}</span>
               <span class="muted"> · we hold ${qty(i.qtyOnHand)}</span></button>`).join("")
          : '<p class="muted picker-empty">No item matches that.</p>';
        list.querySelectorAll(".picker-row").forEach((b) =>
          b.addEventListener("click", () => {
            chosen = { uid: b.dataset.uid, number: b.dataset.num };
            input.value = b.dataset.num;
            list.hidden = true;
            refresh();
          }));
      } catch { list.hidden = true; }
    }, 200);
  });

  save.addEventListener("click", async () => {
    save.disabled = true;
    result.textContent = "Saving…";
    try {
      const r = await fetchJson("/api/insights/counts", {
        method: "POST",
        body: JSON.stringify({
          itemUid: chosen.uid,
          countedQty: Number(document.getElementById("count-qty").value),
          countDate: document.getElementById("count-date").value,
          note: document.getElementById("count-note").value || null,
          enteredBy: "dashboard",
        }),
      });
      result.innerHTML = r.drift == null
        ? `Count recorded for <strong>${esc(chosen.number)}</strong>.`
        : `Count recorded for <strong>${esc(chosen.number)}</strong>. It corrected our figure by
           <strong>${qty(r.drift)}</strong> — that is how far the books had drifted from the shelf.`;
    } catch (err) {
      result.textContent = `Could not save: ${err.message}`;
    }
    save.disabled = false;
  });
}

/** Bulk entry: validate first, save only once the user has seen the result. */
function wireBulkCounts() {
  const box = document.getElementById("count-bulk");
  const out = document.getElementById("count-bulk-result");
  const saveBtn = document.getElementById("count-bulk-save");

  const parse = () =>
    box.value.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
      const [num, q] = line.split(/[,\t]/).map((x) => (x ?? "").trim());
      return { itemNumber: num, countedQty: Number(q) };
    });

  const post = async (dryRun) =>
    fetchJson("/api/insights/counts/import", {
      method: "POST",
      body: JSON.stringify({
        rows: parse(),
        countDate: document.getElementById("count-bulk-date").value,
        enteredBy: "dashboard",
        dryRun,
      }),
    });

  const show = (r, saved) => {
    saveBtn.disabled = !r.accepted.length;
    out.innerHTML = `
      <p class="hint">${saved ? `Saved <strong>${qty(r.written)}</strong> count(s).` : `<strong>${qty(r.accepted.length)}</strong> row(s) ready, <strong>${qty(r.rejected.length)}</strong> rejected.`}</p>
      ${r.rejected.length ? `<div class="notice warn"><ul>${r.rejected.map((x) => `<li><strong>${esc(x.itemNumber || "(blank)")}</strong> — ${esc(x.reason)}</li>`).join("")}</ul></div>` : ""}
      ${saved && r.accepted.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Item</th><th class="num">Counted</th><th class="num">Corrected by</th></tr></thead>
        <tbody>${r.accepted.map((a) => `<tr><td>${esc(a.itemNumber)}</td><td class="num">${qty(a.countedQty)}</td>
          <td class="num">${a.drift == null ? "—" : qty(a.drift)}</td></tr>`).join("")}</tbody></table></div>` : ""}`;
  };

  document.getElementById("count-bulk-check").addEventListener("click", async () => {
    out.innerHTML = '<p class="loading">Checking…</p>';
    try { show(await post(true), false); } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  });
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    out.innerHTML = '<p class="loading">Saving…</p>';
    try { show(await post(false), true); } catch (e) { out.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  });
}

/** Confirm or reject a detected stocktake; the ledger re-anchors immediately. */
function wireStocktakeButtons() {
  document.querySelectorAll("tr[data-adj]").forEach((tr) => {
    const send = async (isStocktake) => {
      tr.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await fetchJson(`/api/insights/stocktakes/${encodeURIComponent(tr.dataset.adj)}/confirm`, {
          method: "POST",
          body: JSON.stringify({ isStocktake, confirmedBy: "dashboard" }),
        });
        renderCounts();
      } catch (err) {
        alert(err.message);
        tr.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    };
    tr.querySelector(".st-yes").addEventListener("click", () => send(true));
    tr.querySelector(".st-no").addEventListener("click", () => send(false));
  });
}

/* ---------- the audit trail behind one item's stock figure ---------- */

/**
 * The full working: the anchor this item's stock is measured from, then every
 * document since with a running balance. The client is auditing these figures
 * against their own spreadsheets, so this is the page that has to convince them
 * — a number they cannot trace is a number they will not act on.
 */
async function loadItemLedger(uid) {
  const panel = document.getElementById("item-ledger");
  if (!panel) return;
  try {
    const d = await fetchJson(`/api/insights/ledger/${encodeURIComponent(uid)}`);
    if (!d.anchor) {
      panel.innerHTML = `<h2>How this stock figure was reached</h2>
        <p class="muted">No reference point recorded for this item yet, so its figure cannot be traced.
        Record a count on the <a href="#/counts">Stock counts</a> page to anchor it.</p>`;
      return;
    }
    const src = COUNT_SOURCE_LABEL[d.anchor.source] ?? d.anchor.source;
    const agrees = d.myobOnHand != null && Math.abs((d.closing ?? 0) - d.myobOnHand) < 0.001;
    const rows = d.entries.slice(-40);

    panel.innerHTML = `
      <h2>How this stock figure was reached</h2>
      <p class="hint">Everything below is computed here from Allied's own documents. MYOB's own figure is
      shown only so any disagreement is visible.</p>

      <div class="ledger-head">
        <div><span class="k-label">Reference point</span>
          <span class="k-value">${qty(d.anchor.qty)}</span>
          <span class="muted">${esc(src)} · ${dateFmt(d.anchor.date)}</span></div>
        <div><span class="k-label">Movements since</span>
          <span class="k-value">${d.entries.length ? qty(d.entries.reduce((a, e) => a + e.qty, 0)) : "0"}</span>
          <span class="muted">${qty(d.entries.length)} document(s)</span></div>
        <div><span class="k-label">Our stock figure</span>
          <span class="k-value">${qty(d.closing)}</span>
          <span class="muted">${
            agrees
              ? "MYOB agrees"
              : `MYOB says ${qty(d.myobOnHand)} — a difference of ${qty((d.closing ?? 0) - (d.myobOnHand ?? 0))}`
          }</span></div>
      </div>
      ${
        d.anchor.drift != null && Math.abs(d.anchor.drift) > 0.001
          ? `<div class="notice warn">When this count was taken it corrected the books by
             <strong>${qty(d.anchor.drift)}</strong> — the stock on the shelf did not match what was recorded.</div>`
          : ""
      }

      ${
        rows.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Date</th><th>Movement</th><th>Reference</th><th class="num">Change</th><th class="num">Running total</th></tr></thead>
              <tbody>
                <tr class="ledger-anchor"><td>${dateFmt(d.anchor.date)}</td>
                  <td colspan="2"><strong>${esc(src)}</strong></td>
                  <td class="num">—</td><td class="num"><strong>${qty(d.anchor.qty)}</strong></td></tr>
                ${rows.map((e) => `<tr>
                  <td>${dateFmt(e.date)}</td>
                  <td>${esc(LEDGER_KIND_LABEL[e.kind] ?? e.kind)}</td>
                  <td class="muted">${esc(e.docNumber ?? "")}${e.party ? ` · ${esc(e.party)}` : ""}${
                    e.memo ? `<br /><span class="muted">${esc(String(e.memo).replace(/\s+/g, " ").slice(0, 60))}</span>` : ""
                  }</td>
                  <td class="num ${e.qty < 0 ? "alert" : ""}">${e.qty > 0 ? "+" : ""}${qty(e.qty)}</td>
                  <td class="num">${qty(e.balance)}</td>
                </tr>`).join("")}
              </tbody>
            </table></div>
            ${d.entries.length > rows.length ? `<p class="hint">Showing the most recent ${rows.length} of ${qty(d.entries.length)} movements.</p>` : ""}`
          : '<p class="muted">Nothing has moved since the reference point.</p>'
      }`;
  } catch (err) {
    panel.innerHTML = `<h2>How this stock figure was reached</h2>
      <p class="muted">Could not load the trail: ${esc(err.message)}</p>`;
  }
}

const LEDGER_KIND_LABEL = {
  bill: "Received (supplier bill)",
  invoice: "Shipped (sales invoice)",
  build: "Build",
  adjustment: "Adjustment",
};

/* ================= P4: independent facets and tags =================
 *
 * Product type and finish are two separate dimensions and are never combined
 * into one label. Allied currently stack them by hand into compound categories
 * like "bolt and nut stainless", purely to keep the list small enough to work
 * with — a workaround, not a requirement, and rebuilding it here would defeat
 * the point.
 *
 * Finish is commercial, not cosmetic: stainless is high value, bought from only
 * two suppliers and watched far more closely than galvanised, so isolating "all
 * stainless" or "stainless washers only" drives real purchasing decisions.
 *
 * Nothing is suppressed. The brief assumed only galvanised and stainless were
 * live; the data says otherwise (ZINC PLATED is on 381 items, 108 of them
 * holding stock), so the counts are shown and Allied decide what matters.
 */
async function loadFacetMenus() {
  const type = document.getElementById("inv-type");
  const finish = document.getElementById("inv-finish");
  const tag = document.getElementById("inv-tag");
  if (!type || !finish || !tag) return;
  try {
    facetCache = facetCache ?? (await fetchJson("/api/insights/facets"));
    const fill = (el, values, allLabel, prefix) => {
      el.innerHTML =
        `<option value="">${allLabel}</option>` +
        values
          .map(
            (v) =>
              `<option value="${esc(v.value)}">${prefix}${esc(v.value)} (${qty(v.items)})</option>`,
          )
          .join("");
    };
    fill(type, facetCache.productType, "All product types", "");
    fill(finish, facetCache.productFinish, "All finishes", "");
    fill(
      tag,
      facetCache.tags,
      facetCache.tags.length ? "All tags" : "No tags yet",
      "#",
    );
    type.value = invState.productType;
    finish.value = invState.productFinish;
    tag.value = invState.tag;

    const wire = (el, key) =>
      el.addEventListener("change", () => {
        invState[key] = el.value;
        invState.page = 1;
        syncInventoryUrl();
        loadInventoryTable();
        showFacetNote();
      });
    wire(type, "productType");
    wire(finish, "productFinish");
    wire(tag, "tag");
    showFacetNote();
  } catch (err) {
    // The table still works without facets, but a silent catch here hid a real
    // bug once already, so say what went wrong rather than quietly doing nothing.
    console.error("Facet menus failed to load:", err);
    const note = document.getElementById("inv-facet-note");
    if (note) {
      note.hidden = false;
      note.innerHTML = `<span class="muted">Filter menus unavailable: ${esc(err.message)}</span>`;
    }
  }
}

/** Spell out the active combination, so a two-facet filter is never ambiguous. */
function showFacetNote() {
  const el = document.getElementById("inv-facet-note");
  if (!el) return;
  const bits = [];
  if (invState.productFinish) bits.push(`<strong>${esc(invState.productFinish)}</strong>`);
  if (invState.productType) bits.push(`<strong>${esc(invState.productType)}</strong>`);
  if (invState.tag) bits.push(`tagged <strong>#${esc(invState.tag)}</strong>`);
  if (!bits.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `Showing ${bits.join(" · ")} —
    <button class="btn small" id="facet-clear" type="button">Clear facets</button>`;
  document.getElementById("facet-clear").addEventListener("click", () => {
    invState.productType = "";
    invState.productFinish = "";
    invState.tag = "";
    invState.page = 1;
    document.getElementById("inv-type").value = "";
    document.getElementById("inv-finish").value = "";
    document.getElementById("inv-tag").value = "";
    syncInventoryUrl();
    loadInventoryTable();
    showFacetNote();
  });
}

/** Tag chips with removal, plus the add box. Re-rendered in place after edits. */
function renderItemTags(uid, tags) {
  const list = document.getElementById("item-tag-list");
  const input = document.getElementById("item-tag-new");
  const add = document.getElementById("item-tag-add");
  if (!list || !input || !add) return;

  const draw = (current) => {
    list.innerHTML = current.length
      ? current
          .map(
            (t) =>
              `<span class="tag-chip"><a href="#/inventory?tag=${encodeURIComponent(t)}"
                 title="Show every item tagged #${esc(t)}">#${esc(t)}</a>
               <button class="tag-x" data-tag="${esc(t)}" title="Remove this tag" type="button">×</button></span>`,
          )
          .join("")
      : '<p class="muted">No tags yet.</p>';
    list.querySelectorAll(".tag-x").forEach((b) =>
      b.addEventListener("click", async () => {
        b.disabled = true;
        try {
          await fetchJson(
            `/api/insights/items/${encodeURIComponent(uid)}/tags?tag=${encodeURIComponent(b.dataset.tag)}`,
            { method: "DELETE" },
          );
          facetCache = null; // the tag menu counts have moved
          draw(current.filter((t) => t !== b.dataset.tag));
        } catch (err) {
          alert(err.message);
          b.disabled = false;
        }
      }),
    );
  };
  draw([...tags]);

  const submit = async () => {
    const value = input.value.trim();
    if (!value) return;
    add.disabled = true;
    try {
      const r = await fetchJson(`/api/insights/items/${encodeURIComponent(uid)}/tags`, {
        method: "POST",
        body: JSON.stringify({ tag: value }),
      });
      input.value = "";
      facetCache = null;
      const next = [...new Set([...tags, r.tag])].sort();
      tags = next;
      draw(next);
    } catch (err) {
      alert(err.message);
    }
    add.disabled = false;
  };
  add.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

/* ================= Purchasing cart (P5 + P6) =================
 *
 * Designed around how Allied actually buy. Their goal is not more dashboards —
 * it is less time crunching numbers and more time talking to suppliers. Several
 * are overseas with a language barrier and can only handle one issue per
 * conversation, so a padded or garbled order costs a full round trip.
 *
 * That shapes three decisions:
 *
 *  1. **The supplier bucket is the unit of work**, because one bucket becomes
 *     one email. Buckets are collapsed by default; you open the one you are
 *     about to contact and ignore the rest.
 *  2. **Decisions come before lists.** An item under several suppliers is not a
 *     row to scroll past, it is a choice to make, so the count sits at the top
 *     and can be worked through directly.
 *  3. **Compare without leaving.** Choosing a supplier means weighing lead time
 *     against cost against what is already on the water, so that comparison
 *     opens in place rather than sending someone to another page.
 */

let cartData = null;
const cartOpen = new Set();

async function renderPurchasing() {
  main.innerHTML = '<p class="loading">Building the order list…</p>';
  cartData = await fetchJson(withWindow("/api/insights/cart"));
  drawCart();
}

function cartExportUrl() {
  const key = accessKey();
  return `/api/insights/cart.csv?asAt=${encodeURIComponent(windowState.asAt)}&windowMonths=${windowState.windowMonths}${
    key ? `&key=${encodeURIComponent(key)}` : ""
  }`;
}

function drawCart() {
  const d = cartData;
  const undecided = d.unresolvedDuplicates;

  main.innerHTML = `
    ${historicalNotice(d)}
    <div class="page-head">
      <div>
        <h1>Purchasing</h1>
        <p class="page-sub">${qty(d.totalItems)} items need an order, ${qty(d.totalLines)} lines across
        ${qty(d.suppliers.length)} suppliers · estimated ${money(d.estimatedCost)} ·
        demand over the last ${windowLabel()}. Nothing is written to MYOB.</p>
      </div>
      <div class="head-actions">
        <button class="btn" id="cart-reset" type="button" title="Discard every edit, choice and split">Start again</button>
        <a class="btn primary" href="${cartExportUrl()}" download>Export order sheets</a>
      </div>
    </div>

    ${
      undecided
        ? `<div class="notice warn cart-decisions">
             <strong>${qty(undecided)} item${undecided === 1 ? "" : "s"} sit under more than one supplier</strong>
             with no choice recorded. Each is a sourcing decision — usually a smaller local order against a
             cheaper, slower one direct from the factory. Left undecided they can be ordered twice, so the
             export flags them.
             <button class="btn small" id="cart-decide" type="button">Work through them</button>
           </div>`
        : `<div class="notice ok">Every item has one supplier, or a deliberate split. Nothing can be ordered twice.</div>`
    }

    ${cartDecisionsMade(d)}

    <div class="cart-suppliers">
      ${d.suppliers.map(cartSupplierCard).join("")}
    </div>`;

  document.getElementById("cart-reset").addEventListener("click", async () => {
    if (!confirm("Discard every quantity edit, supplier choice and split? Allied data only — MYOB is untouched.")) return;
    await fetchJson("/api/insights/cart/reset", { method: "POST" });
    renderPurchasing();
  });
  const decide = document.getElementById("cart-decide");
  if (decide) decide.addEventListener("click", showCartDecisions);
  main.querySelectorAll(".cart-undo").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      await fetchJson("/api/insights/cart/undo", {
        method: "POST",
        body: JSON.stringify({ itemUid: b.dataset.item }),
      });
      cartData = await fetchJson(withWindow("/api/insights/cart"));
      drawCart();
    }),
  );
  wireCartCards();
}

/** One supplier, one conversation. Collapsed until you are working on it. */
function cartSupplierCard(g) {
  const open = cartOpen.has(g.supplierUid);
  const lead =
    g.leadTimeDays == null
      ? '<span class="muted" title="No purchase order has been matched to a bill for this supplier yet">lead time unknown</span>'
      : `<span title="Typical wait from purchase order to goods billed, measured from their own orders">~${g.leadTimeDays} day lead</span>`;
  const flagged = g.lines.filter((l) => l.supplierCount > 1 && l.state !== "selected" && l.state !== "split").length;

  return `
    <section class="panel cart-supplier ${open ? "is-open" : ""}" data-supplier="${esc(g.supplierUid)}">
      <button class="cart-head" type="button" data-toggle="${esc(g.supplierUid)}" aria-expanded="${open}">
        <span class="cart-head-main">
          <strong>${esc(g.supplierName)}</strong>
          ${g.region ? `<span class="chip">${esc(g.region)}</span>` : ""}
          <span class="muted">${lead}</span>
        </span>
        <span class="cart-head-stats">
          ${flagged ? `<span class="badge warn" title="${flagged} line(s) also sit under another supplier">${flagged} to decide</span>` : ""}
          <span>${qty(g.itemCount)} line${g.itemCount === 1 ? "" : "s"}</span>
          <strong>${money(g.estimatedCost)}</strong>
          <span class="cart-caret">${open ? "▾" : "▸"}</span>
        </span>
      </button>
      ${open ? cartLinesTable(g) : ""}
    </section>`;
}

function cartLinesTable(g) {
  return `
    <div class="table-wrap cart-lines">
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Order qty</th>
            <th class="num">Unit cost</th>
            <th class="num">Est cost</th>
            <th>Why this quantity</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${g.lines.map((l) => cartLineRow(g, l)).join("")}
        </tbody>
      </table>
    </div>`;
}

function cartLineRow(g, l) {
  const cost = l.lastCost ?? l.averageCost ?? 0;
  const undecided = l.supplierCount > 1 && l.state !== "selected" && l.state !== "split";
  const stateChip =
    l.state === "split"
      ? '<span class="badge ok" title="Deliberately ordered from more than one supplier">Split</span>'
      : l.state === "selected"
        ? '<span class="badge ok" title="Chosen supplier for this item">Chosen</span>'
        : l.state === "edited"
          ? '<span class="badge brand">Edited</span>'
          : "";

  /*
   * The badge must be obvious at a glance in every bucket, without hovering —
   * that is what stops the same item being ordered twice. Its wording follows
   * the state: "also under" describes a live duplicate, and saying that after
   * the choice has been made would keep raising an alarm that has been dealt
   * with.
   */
  const others = l.supplierCount - 1;
  const badgeText =
    l.state === "split"
      ? `split across ${l.supplierCount} suppliers`
      : l.state === "selected"
        ? `chosen over ${others} other${others === 1 ? "" : "s"}`
        : `also under ${others} other${others === 1 ? "" : "s"}`;
  const alsoUnder = l.supplierCount > 1
    ? `<button class="badge ${undecided ? "warn" : "idle"} cart-compare" type="button"
         data-item="${esc(l.itemUid)}" data-number="${esc(l.number ?? "")}"
         title="Compare all ${l.supplierCount} suppliers for this item">${badgeText}</button>`
    : "";

  return `
    <tr data-item="${esc(l.itemUid)}" data-supplier="${esc(g.supplierUid)}">
      <td>
        <a href="#/item/${esc(l.itemUid)}"><strong>${esc(l.number ?? "—")}</strong></a>
        ${stateChip} ${alsoUnder}
        <br /><span class="muted">${esc(l.name ?? "")}${l.productFinish ? ` · ${esc(l.productFinish)}` : ""}</span>
      </td>
      <td class="num">
        <input class="cart-qty" type="number" step="any" min="0" value="${l.qty}"
               aria-label="Order quantity for ${esc(l.number ?? "")}" />
        ${l.qty !== l.suggestedQty ? `<br /><span class="muted" title="The platform suggested ${qty(l.suggestedQty)}">was ${qty(l.suggestedQty)}</span>` : ""}
      </td>
      <td class="num">${cost ? price(cost) : "—"}<br />
        <span class="muted">${l.lastCost != null ? "last paid" : "average"}</span></td>
      <td class="num">${money(l.qty * cost)}</td>
      <td class="cart-why">${cartRationale(l)}</td>
      <td class="num"><button class="tag-x cart-remove" type="button" title="Remove this line from ${esc(g.supplierName)}">×</button></td>
    </tr>`;
}

/** The working behind the number, in the order someone actually checks it. */
function cartRationale(l) {
  const bits = [
    `<span title="Free stock today">${qty(l.freeStock)} free</span>`,
    l.minLevel ? `<span title="MYOB minimum level">min ${qty(l.minLevel)}</span>` : "",
    `<span title="Demand over the last ${l.rationale.demandWindowMonths} months">${l.weeklyDemand.toFixed(1)}/wk</span>`,
    l.coverWeeks != null ? `<span title="Weeks of cover at that rate">${l.coverWeeks.toFixed(1)}w cover</span>` : "",
    l.incomingQty ? `<span title="Already on order and not yet received">+${qty(l.incomingQty)} incoming</span>` : "",
    l.leadTimeDays != null
      ? `<span title="Median measured across ${l.leadTimeOrders} matched orders">${l.leadTimeDays}d lead</span>`
      : "",
  ].filter(Boolean);
  return `<span class="why-bits">${bits.join(" · ")}</span>`;
}

/** Expand/collapse, inline quantity edits, removals and the compare drawer. */
function wireCartCards() {
  main.querySelectorAll("[data-toggle]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const uid = btn.dataset.toggle;
      if (cartOpen.has(uid)) cartOpen.delete(uid);
      else cartOpen.add(uid);
      drawCart();
    }),
  );

  main.querySelectorAll("tr[data-item]").forEach((tr) => {
    const itemUid = tr.dataset.item;
    const supplierUid = tr.dataset.supplier;

    const qtyInput = tr.querySelector(".cart-qty");
    if (qtyInput) {
      // Save on blur rather than per keystroke: Allied are typing a considered
      // number, not searching, and a request per digit would fight them.
      qtyInput.addEventListener("blur", async () => {
        const value = Number(qtyInput.value);
        if (!Number.isFinite(value) || value < 0) return;
        await saveCartLine({ itemUid, supplierUid, qty: value, state: "edited" });
      });
      qtyInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") qtyInput.blur();
      });
    }

    const remove = tr.querySelector(".cart-remove");
    if (remove)
      remove.addEventListener("click", async () => {
        await saveCartLine({ itemUid, supplierUid, state: "removed" });
      });

    const compare = tr.querySelector(".cart-compare");
    if (compare)
      compare.addEventListener("click", () => {
        // Entering from a bucket queues the rest too, so a decision made here
        // can roll straight into the next one.
        if (!decisionQueue.includes(itemUid)) {
          decisionQueue = [itemUid, ...buildDecisionQueue().filter((u) => u !== itemUid)];
        }
        openSupplierCompare(itemUid, compare.dataset.number);
      });
  });
}

async function saveCartLine(body) {
  try {
    await fetchJson("/api/insights/cart/line", { method: "POST", body: JSON.stringify(body) });
    cartData = await fetchJson(withWindow("/api/insights/cart"));
    drawCart();
  } catch (err) {
    alert(err.message);
  }
}

/**
 * Every supplier for one item, side by side.
 *
 * This is the decision the brief describes: the same product is often available
 * as a smaller, dearer order from a local warehouse or a larger, cheaper one
 * direct from the factory, and that trade-off can only be judged with lead time,
 * cost, current stock and incoming supply on screen together.
 */
let decisionQueue = [];

function openSupplierCompare(itemUid, number) {
  const rows = [];
  for (const g of cartData.suppliers)
    for (const l of g.lines) if (l.itemUid === itemUid) rows.push({ g, l });
  if (!rows.length) return;

  const first = rows[0].l;
  /*
   * Badge a winner only when there is exactly one. Three suppliers all marked
   * "fastest" at one day tells the reader nothing and makes the badge look
   * decorative; where several tie, the numbers speak for themselves.
   */
  const uniqueBest = (values) => {
    const clean = values.filter((v) => v != null && Number.isFinite(v));
    if (clean.length < 2) return null;
    const best = Math.min(...clean);
    return clean.filter((v) => v === best).length === 1 ? best : null;
  };
  const cheapest = uniqueBest(rows.map((r) => r.l.lastCost ?? r.l.averageCost ?? null));
  const fastest = uniqueBest(rows.map((r) => r.l.leadTimeDays));

  const body = `
    <div class="compare-head">
      <div>
        <h2>${esc(number || first.number || "Item")}</h2>
        <p class="muted">${esc(first.name ?? "")}</p>
      </div>
      <div class="compare-stock">
        <span><strong>${qty(first.freeStock)}</strong> free stock</span>
        <span><strong>${qty(first.incomingQty)}</strong> incoming</span>
        <span><strong>${first.weeklyDemand.toFixed(1)}</strong>/week</span>
        ${first.coverWeeks != null ? `<span><strong>${first.coverWeeks.toFixed(1)}</strong> weeks cover</span>` : ""}
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr><th>Supplier</th><th class="num">Unit cost</th><th class="num">Lead time</th>
          <th class="num">Suggested qty</th><th class="num">Est cost</th><th></th></tr></thead>
        <tbody>
          ${rows
            .map(({ g, l }) => {
              const cost = l.lastCost ?? l.averageCost ?? 0;
              const isCheapest = cheapest != null && cost === cheapest;
              const isFastest = fastest != null && l.leadTimeDays === fastest;
              return `<tr>
                <td><strong>${esc(g.supplierName)}</strong>
                  ${g.region ? `<span class="chip">${esc(g.region)}</span>` : ""}
                  ${l.state === "split" ? '<span class="badge ok">In the split</span>' : ""}
                  <br /><span class="muted">${
                    l.supplierSource === "allied" ? "Tagged by Allied"
                    : l.supplierSource === "myob" ? "MYOB primary supplier"
                    : "Inferred from purchase history"
                  }</span></td>
                <td class="num">${cost ? price(cost) : "—"} ${isCheapest ? '<span class="badge ok">cheapest</span>' : ""}</td>
                <td class="num">${
                  l.leadTimeDays == null
                    ? '<span class="muted">unknown</span>'
                    : `${l.leadTimeDays} ${l.leadTimeDays === 1 ? "day" : "days"} ${isFastest ? '<span class="badge ok">fastest</span>' : ""}
                       <br /><span class="muted" title="Same-day order/bill pairs are ignored — they record paperwork, not a wait">from ${l.leadTimeOrders} order${l.leadTimeOrders === 1 ? "" : "s"}${
                         l.leadTimeSameDayExcluded ? `, ${l.leadTimeSameDayExcluded} same-day ignored` : ""
                       }</span>`
                }</td>
                <td class="num"><input class="cmp-qty" type="number" step="any" min="0" value="${l.qty}"
                     data-supplier="${esc(g.supplierUid)}" aria-label="Quantity from ${esc(g.supplierName)}" /></td>
                <td class="num">${money(l.qty * cost)}</td>
                <td><button class="btn small cmp-choose" data-supplier="${esc(g.supplierUid)}" type="button"
                      title="Order the whole quantity from ${esc(g.supplierName)} and drop the others">Choose</button></td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>

    <div class="compare-actions">
      <p class="hint">Choosing one supplier removes this item from the others in a single action.
      To buy from more than one on purpose, set the quantities above and record it as a split — the
      order sheets will show it as intentional rather than a duplicate.</p>
      <!-- Splitting by hand across several boxes is exactly where a quantity
           goes missing or gets counted twice, so the arithmetic is done here
           and shown live rather than left to the person typing. -->
      <div class="split-tally" id="split-tally"></div>
      <button class="btn" id="cmp-split" type="button">Record as a deliberate split</button>
    </div>`;

  // Position in the queue, so working through many decisions is one pass
  // rather than open-decide-close repeated dozens of times.
  const pos = decisionQueue.indexOf(itemUid);
  const nav =
    pos >= 0 && decisionQueue.length > 1
      ? `<div class="compare-nav">
           <span class="muted">Decision ${pos + 1} of ${decisionQueue.length}</span>
           <span>
             <button class="btn small" id="cmp-skip" type="button"
               ${pos === decisionQueue.length - 1 ? "disabled" : ""}>Skip for now</button>
           </span>
         </div>`
      : "";

  openDrawer(`Suppliers for ${number || ""}`, nav + body);

  // Live tally: what was suggested, what has been allocated, and the gap.
  const suggested = first.suggestedQty;
  const tally = () => {
    const el = document.getElementById("split-tally");
    if (!el) return;
    const parts = [...document.querySelectorAll(".cmp-qty")]
      .map((i) => ({ supplierUid: i.dataset.supplier, qty: Number(i.value) || 0 }))
      .filter((p) => p.qty > 0);
    const allocated = parts.reduce((a, p) => a + p.qty, 0);
    const diff = allocated - suggested;
    const state = parts.length < 2 ? "idle" : Math.abs(diff) < 0.001 ? "ok" : "warn";
    el.className = `split-tally is-${state}`;
    el.innerHTML =
      parts.length < 2
        ? `<span class="muted">Set a quantity against at least two suppliers to split.
             Suggested total is <strong>${qty(suggested)}</strong>.</span>`
        : `<span>Suggested <strong>${qty(suggested)}</strong></span>
           <span>Allocated <strong>${qty(allocated)}</strong> across ${parts.length} suppliers</span>
           <span class="split-diff">${
             Math.abs(diff) < 0.001
               ? "adds up exactly"
               : diff > 0
                 ? `<strong>${qty(diff)} more</strong> than suggested`
                 : `<strong>${qty(-diff)} short</strong> of the suggestion`
           }</span>`;
  };
  document.querySelectorAll(".cmp-qty").forEach((i) => {
    i.addEventListener("input", tally);
    i.addEventListener("change", tally);
  });
  tally();

  const skip = document.getElementById("cmp-skip");
  if (skip)
    skip.addEventListener("click", () => {
      const next = decisionQueue[pos + 1];
      if (next) openSupplierCompare(next, null);
    });

  document.querySelectorAll(".cmp-choose").forEach((b) =>
    b.addEventListener("click", async () => {
      b.disabled = true;
      await fetchJson("/api/insights/cart/select", {
        method: "POST",
        body: JSON.stringify({ itemUid, supplierUid: b.dataset.supplier }),
      });
      await afterCartDecision(itemUid);
    }),
  );

  document.getElementById("cmp-split").addEventListener("click", async () => {
    const parts = [...document.querySelectorAll(".cmp-qty")]
      .map((i) => ({ supplierUid: i.dataset.supplier, qty: Number(i.value) }))
      .filter((p) => p.qty > 0);
    if (parts.length < 2) {
      alert("A split needs a quantity against at least two suppliers.");
      return;
    }
    const allocated = parts.reduce((a, p) => a + p.qty, 0);
    const diff = allocated - suggested;
    // A mismatch can be deliberate — a minimum order quantity, or topping up
    // beyond the suggestion — so this confirms rather than blocks.
    if (Math.abs(diff) > 0.001) {
      const ok = confirm(
        `This split comes to ${qty(allocated)}, which is ${
          diff > 0 ? `${qty(diff)} more than` : `${qty(-diff)} short of`
        } the suggested ${qty(suggested)}.\n\nRecord it anyway?`,
      );
      if (!ok) return;
    }
    await fetchJson("/api/insights/cart/split", {
      method: "POST",
      body: JSON.stringify({ itemUid, parts }),
    });
    await afterCartDecision(itemUid);
  });
}

/**
 * The undecided items, as a modal.
 *
 * This began as a panel folded into the purchasing page and was too easy to
 * miss — it looked like one more section among the supplier buckets, when it is
 * the thing that has to happen before any order goes out. A modal states that:
 * it interrupts, it is the only thing on screen, and it does not close until
 * dismissed.
 *
 * It also paginates. The first version showed the 40 largest with no way to
 * reach the rest, which quietly hid 172 of 212 decisions.
 */
let decisionPage = 1;
const DECISIONS_PER_PAGE = 25;

function showCartDecisions() {
  decisionPage = 1;
  drawDecisionModal();
}

function decisionRows() {
  const byItem = new Map();
  for (const g of cartData.suppliers)
    for (const l of g.lines) {
      if (l.supplierCount < 2 || l.state === "selected" || l.state === "split") continue;
      const e = byItem.get(l.itemUid) ?? { line: l, value: 0, suppliers: [] };
      e.value += l.qty * (l.lastCost ?? l.averageCost ?? 0);
      e.suppliers.push(g.supplierName);
      byItem.set(l.itemUid, e);
    }
  return [...byItem.entries()].sort((a, b) => b[1].value - a[1].value);
}

function drawDecisionModal() {
  const list = decisionRows();
  decisionQueue = list.map(([uid]) => uid);

  if (!list.length) {
    openModal(
      "Decisions to make",
      '<div class="notice ok">Every item has one supplier or a deliberate split. Nothing can be ordered twice.</div>',
    );
    return;
  }

  const pages = Math.max(1, Math.ceil(list.length / DECISIONS_PER_PAGE));
  decisionPage = Math.min(Math.max(decisionPage, 1), pages);
  const from = (decisionPage - 1) * DECISIONS_PER_PAGE;
  const slice = list.slice(from, from + DECISIONS_PER_PAGE);
  const totalAtStake = list.reduce((a, [, e]) => a + e.value, 0);

  openModal(
    `${qty(list.length)} sourcing decision${list.length === 1 ? "" : "s"}`,
    `<p class="hint">Each of these is available from more than one supplier. Until one is chosen —
     or a split recorded — it can be ordered twice. Ranked by what is at stake, so the costly
     mistakes are settled first. <strong>${money(totalAtStake)}</strong> in total.</p>
     <div class="table-wrap"><table>
       <thead><tr><th>Item</th><th>Available from</th><th class="num">At stake</th><th></th></tr></thead>
       <tbody>
         ${slice
           .map(
             ([uid, e]) => `<tr>
               <td><strong>${esc(e.line.number ?? "—")}</strong><br />
                 <span class="muted">${esc(e.line.name ?? "")}</span></td>
               <td class="muted">${e.suppliers.map((x) => esc(x)).join(" · ")}</td>
               <td class="num">${money(e.value)}</td>
               <td><button class="btn small dec-open" data-item="${esc(uid)}"
                     data-number="${esc(e.line.number ?? "")}" type="button">Compare</button></td>
             </tr>`,
           )
           .join("")}
       </tbody>
     </table></div>
     <div class="modal-pager">
       <button class="btn small" id="dec-prev" type="button" ${decisionPage === 1 ? "disabled" : ""}>Previous</button>
       <span class="muted">${from + 1}–${Math.min(from + DECISIONS_PER_PAGE, list.length)} of ${qty(list.length)}</span>
       <button class="btn small" id="dec-next" type="button" ${decisionPage === pages ? "disabled" : ""}>Next</button>
     </div>`,
  );

  document.querySelectorAll(".dec-open").forEach((b) =>
    b.addEventListener("click", () => {
      closeModal();
      openSupplierCompare(b.dataset.item, b.dataset.number);
    }),
  );
  document.getElementById("dec-prev")?.addEventListener("click", () => {
    decisionPage -= 1;
    drawDecisionModal();
  });
  document.getElementById("dec-next")?.addEventListener("click", () => {
    decisionPage += 1;
    drawDecisionModal();
  });
}

/* ---------- reusable side drawer ---------- */

function openDrawer(title, html) {
  const d = document.getElementById("side-drawer");
  document.getElementById("side-drawer-title").textContent = title;
  document.getElementById("side-drawer-body").innerHTML = html;
  d.hidden = false;
  document.body.classList.add("drawer-open");
  document.getElementById("side-drawer-close").focus();
}

function closeDrawer() {
  const d = document.getElementById("side-drawer");
  if (!d) return;
  d.hidden = true;
  document.body.classList.remove("drawer-open");
}

document.getElementById("side-drawer-close")?.addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

/**
 * What has already been decided, and how to take it back.
 *
 * People hesitate over a decision they cannot review or reverse, and choosing a
 * supplier removes the item from other buckets — so without this, the only
 * evidence of the choice is an item that has quietly disappeared from
 * everywhere else.
 */
function cartDecisionsMade(d) {
  if (!d.decisions.length) return "";
  return `
    <section class="panel cart-decided">
      <h2>Decided — ${qty(d.decisions.length)} item${d.decisions.length === 1 ? "" : "s"}</h2>
      <p class="hint">These are settled and will export cleanly. Undo puts an item back
      under every supplier it is available from.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Item</th><th>Decision</th><th class="num">Qty</th><th></th></tr></thead>
        <tbody>
          ${d.decisions
            .map(
              (x) => `<tr>
                <td><strong>${esc(x.number ?? "—")}</strong><br />
                  <span class="muted">${esc(x.name ?? "")}</span></td>
                <td>${
                  x.kind === "split"
                    ? `<span class="badge ok">Split</span> ${x.suppliers
                        .map((s) => `${esc(s.supplierName)} <span class="muted">(${qty(s.qty)})</span>`)
                        .join(" + ")}`
                    : `<span class="badge ok">Chosen</span> ${esc(x.suppliers[0]?.supplierName ?? "")}`
                }</td>
                <td class="num">${qty(x.suppliers.reduce((a, s) => a + s.qty, 0))}</td>
                <td><button class="btn small cart-undo" data-item="${esc(x.itemUid)}" type="button">Undo</button></td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table></div>
    </section>`;
}

/**
 * Refresh, then move straight to the next undecided item.
 *
 * Working through 200 sourcing decisions should be one pass, not two hundred
 * rounds of open, decide, close, scroll, find the next one. The drawer only
 * closes when the queue runs out.
 */
async function afterCartDecision(itemUid) {
  cartData = await fetchJson(withWindow("/api/insights/cart"));
  const at = decisionQueue.indexOf(itemUid);
  decisionQueue = decisionQueue.filter((u) => u !== itemUid);
  drawCart();

  const next = decisionQueue[at] ?? decisionQueue[0];
  if (next) {
    openSupplierCompare(next, null);
    return;
  }
  // Queue exhausted. Say so plainly rather than just closing, so finishing a
  // run of decisions feels finished.
  closeDrawer();
  if (cartData.unresolvedDuplicates === 0) {
    openModal(
      "All decided",
      `<div class="notice ok">Every sourcing decision is made. The order sheets will export
       with no duplicate warnings.</div>
       <p class="hint">Any of these can still be changed — the Decided list on the purchasing
       page has an Undo against each one.</p>`,
    );
  }
}

/** Undecided items, highest value at stake first. */
function buildDecisionQueue() {
  const byItem = new Map();
  for (const g of cartData.suppliers)
    for (const l of g.lines) {
      if (l.supplierCount < 2 || l.state === "selected" || l.state === "split") continue;
      const v = (byItem.get(l.itemUid) ?? 0) + l.qty * (l.lastCost ?? l.averageCost ?? 0);
      byItem.set(l.itemUid, v);
    }
  return [...byItem.entries()].sort((a, b) => b[1] - a[1]).map(([uid]) => uid);
}

/** Inventory export carries the same filters as the view on screen. */
function inventoryCsvUrl() {
  const p = new URLSearchParams({
    q: invState.q,
    filter: invState.filter,
    region: invState.region,
    sort: invState.sort,
    asAt: windowState.asAt,
    windowMonths: String(windowState.windowMonths),
  });
  if (invState.dir) p.set("dir", invState.dir);
  if (invState.productType) p.set("productType", invState.productType);
  if (invState.productFinish) p.set("productFinish", invState.productFinish);
  if (invState.tag) p.set("tag", invState.tag);
  const key = accessKey();
  if (key) p.set("key", key);
  return `/api/insights/items.csv?${p}`;
}

function suppliersCsvUrl() {
  const key = accessKey();
  return `/api/insights/suppliers.csv${key ? `?key=${encodeURIComponent(key)}` : ""}`;
}

/* ---------- modal ---------- */

function openModal(title, html) {
  const b = document.getElementById("modal-backdrop");
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-body").innerHTML = html;
  b.hidden = false;
  document.body.classList.add("modal-open");
  document.getElementById("modal-close").focus();
}

function closeModal() {
  const b = document.getElementById("modal-backdrop");
  if (!b) return;
  b.hidden = true;
  document.body.classList.remove("modal-open");
}

document.getElementById("modal-close")?.addEventListener("click", closeModal);
document.getElementById("modal-backdrop")?.addEventListener("click", (e) => {
  // Click the backdrop to dismiss, but not a click inside the dialog itself.
  if (e.target.id === "modal-backdrop") closeModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});
