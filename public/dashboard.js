/* Allied Fastenings — Inventory Intelligence (read-only MYOB). */

const main = document.getElementById("main");
const nav = document.getElementById("nav");
const syncDot = document.getElementById("sync-dot");
const syncChipText = document.getElementById("sync-chip-text");
const keyOverlay = document.getElementById("key-overlay");
const keyForm = document.getElementById("key-form");
const keyInput = document.getElementById("key-input");
const keyError = document.getElementById("key-error");

const FLAG_LABELS = {
  below_min: ["Below min", "fail"],
  negative_stock: ["Negative stock", "fail"],
  stock_no_cost: ["No cost", "warn"],
  inactive_with_stock: ["Inactive w/ stock", "warn"],
  no_supplier: ["No supplier", "warn"],
  slow_mover: ["Slow mover", "idle"],
};

const invState = { q: "", filter: "all", sort: "risk", page: 1 };
const prodState = { q: "", page: 1 };
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
      return `<span class="badge ${tone}">${esc(label)}</span>`;
    })
    .join("")}</span>`;
}

function coverFmt(cover, basis) {
  if (cover == null) return '<span class="muted">no demand</span>';
  const suffix = basis === "365d" ? " (365d rate)" : "";
  if (cover < 2) return `<span class="badge fail">${cover}w${suffix}</span>`;
  if (cover < 4) return `<span class="badge warn">${cover}w${suffix}</span>`;
  return `${cover}w${suffix}`;
}

/* ---------- data access ---------- */

function accessKey() {
  return localStorage.getItem("afDashboardKey") || "";
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
  localStorage.setItem("afDashboardKey", keyInput.value.trim());
  try {
    await fetchJson("/api/insights/sync/status");
    keyOverlay.hidden = true;
    keyError.hidden = true;
    route();
    pollSyncChip();
  } catch {
    keyError.hidden = false;
  }
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

function route() {
  const hash = location.hash.replace(/^#\//, "") || "overview";
  const [view, arg] = hash.split("/");
  for (const a of nav.querySelectorAll("a")) {
    a.classList.toggle("active", a.dataset.route === view);
  }
  const views = {
    overview: renderOverview,
    inventory: renderInventory,
    item: () => renderItem(arg),
    products: renderProducts,
    purchasing: renderPurchasing,
    data: renderData,
  };
  (views[view] || renderOverview)().catch((err) => {
    main.innerHTML = `<div class="notice fail">${esc(err.message)}</div>
      <p class="muted">If no data has been synced yet, open <a href="#/data">Data &amp; Sync</a> and run a full sync.</p>`;
  });
}

window.addEventListener("hashchange", route);

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
      <div class="kpi"><span class="k-label">Relationships</span><span class="k-value">${qty((rel.derived ?? 0) + (rel.user ?? 0))}</span></div>
    </div>

    <div class="two-col">
      <section class="panel">
        <h2>Needs attention</h2>
        <p class="hint">Ranked by risk: cover vs demand, MYOB minimums, dependency breadth, data quality. Click for evidence.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Risk</th><th>Item</th><th class="num">Avail</th><th>Cover</th><th>Why</th></tr></thead>
          <tbody>
            ${data.attention
              .map(
                (i) => `<tr class="rowlink" data-uid="${esc(i.uid)}">
                  <td>${riskPill(i.risk.score)}</td>
                  <td><strong>${esc(i.number ?? "—")}</strong><br /><span class="muted">${esc(i.name ?? "")}</span></td>
                  <td class="num">${qty(i.qtyAvailable)}</td>
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
        <p class="hint">Components with less stock than one build requires, ranked by how many finished products they block.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>Component</th><th class="num">Avail</th><th class="num">Blocks</th></tr></thead>
          <tbody>
            ${
              data.constraints.length
                ? data.constraints
                    .map(
                      (c) => `<tr class="rowlink" data-uid="${esc(c.uid)}">
                        <td><strong>${esc(c.number ?? "—")}</strong><br /><span class="muted">${esc(c.name ?? "")}</span></td>
                        <td class="num">${qty(c.qty_available)}</td>
                        <td class="num">${qty(c.blocked_parents)}</td>
                      </tr>`,
                    )
                    .join("")
                : '<tr><td colspan="3" class="muted">No blocked assemblies found.</td></tr>'
            }
          </tbody>
        </table></div>
      </section>
    </div>`;

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
    <div class="toolbar">
      <input type="search" id="inv-q" placeholder="Search number, name, supplier…" value="${esc(invState.q)}" />
      <select id="inv-filter">
        <option value="all">All items</option>
        <option value="attention">Needs attention</option>
        <option value="suggested">Suggested orders</option>
        <option value="below_min">Below min level</option>
        <option value="low_cover">Cover &lt; 4 weeks</option>
        <option value="components">Used in assemblies</option>
        <option value="parents">Assembled products</option>
        <option value="negative">Negative stock</option>
        <option value="no_supplier">No supplier set</option>
        <option value="inactive_stock">Inactive with stock</option>
      </select>
      <select id="inv-sort">
        <option value="risk">Sort: risk</option>
        <option value="cover">Sort: lowest cover</option>
        <option value="weekly">Sort: weekly demand</option>
        <option value="value">Sort: stock value</option>
        <option value="used_in">Sort: used in most products</option>
        <option value="number">Sort: item number</option>
        <option value="available">Sort: available</option>
      </select>
    </div>
    <div id="inv-table"><p class="loading">Loading items…</p></div>`;

  const q = document.getElementById("inv-q");
  const filter = document.getElementById("inv-filter");
  const sort = document.getElementById("inv-sort");
  filter.value = invState.filter;
  sort.value = invState.sort;

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
  sort.addEventListener("change", () => {
    invState.sort = sort.value;
    invState.page = 1;
    loadInventoryTable();
  });

  await loadInventoryTable();
}

async function loadInventoryTable() {
  const container = document.getElementById("inv-table");
  if (!container) return;
  container.innerHTML = '<p class="loading">Loading items…</p>';
  const params = new URLSearchParams({
    q: invState.q,
    filter: invState.filter,
    sort: invState.sort,
    page: String(invState.page),
  });
  const data = await fetchJson(`/api/insights/items?${params}`);

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  container.innerHTML = `
    <div class="table-wrap"><table>
      <thead><tr>
        <th>Risk</th><th>Item</th><th class="num">On hand</th><th class="num">Committed</th>
        <th class="num">Incoming</th><th class="num">Available</th><th class="num">Weekly demand</th>
        <th>Cover</th><th class="num">Used in</th><th>Flags</th>
      </tr></thead>
      <tbody>
        ${
          data.items.length
            ? data.items
                .map(
                  (i) => `<tr class="rowlink" data-uid="${esc(i.uid)}">
                    <td>${riskPill(i.risk.score)}</td>
                    <td><strong>${esc(i.number ?? "—")}</strong><br /><span class="muted">${esc((i.name ?? "").slice(0, 60))}</span></td>
                    <td class="num">${qty(i.qtyOnHand)}</td>
                    <td class="num">${qty(i.qtyCommitted)}</td>
                    <td class="num">${qty(i.incomingQty)}</td>
                    <td class="num"><strong>${qty(i.qtyAvailable)}</strong></td>
                    <td class="num">${i.demand.weekly ? i.demand.weekly.toFixed(1) : "—"}</td>
                    <td>${coverFmt(i.coverWeeks, i.demand.basis)}</td>
                    <td class="num">${i.parentCount || "—"}</td>
                    <td>${flagChips(i.flags)}</td>
                  </tr>`,
                )
                .join("")
            : '<tr><td colspan="10" class="muted">No items match.</td></tr>'
        }
      </tbody>
    </table></div>
    <div class="pager">
      <button class="btn small" id="prev" ${data.page <= 1 ? "disabled" : ""}>&larr; Prev</button>
      <span>Page ${data.page} of ${pages} · ${qty(data.total)} items</span>
      <button class="btn small" id="next" ${data.page >= pages ? "disabled" : ""}>Next &rarr;</button>
    </div>`;

  container.querySelectorAll("tr.rowlink").forEach((tr) =>
    tr.addEventListener("click", () => (location.hash = `#/item/${tr.dataset.uid}`)),
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

/* ---------- item detail ---------- */

function sourceBadge(source, confidence, buildCount) {
  if (source === "user") return '<span class="badge brand">User-defined</span>';
  const pct = Math.round((confidence ?? 0) * 100);
  return `<span class="badge idle" title="Derived from ${buildCount} MYOB build transaction(s)">Derived · ${pct}%</span>`;
}

async function renderItem(uid) {
  main.innerHTML = '<p class="loading">Loading item…</p>';
  const d = await fetchJson(`/api/insights/items/${encodeURIComponent(uid)}`);
  const i = d.item;
  const s = i.suggestion;

  const months = [];
  for (let m = 11; m >= 0; m--) {
    const date = new Date();
    date.setMonth(date.getMonth() - m, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const row = (d.monthlyDemand || []).find((r) => String(r.month).slice(0, 7) === key);
    months.push({
      label: date.toLocaleDateString(undefined, { month: "narrow" }),
      direct: Number(row?.direct ?? 0),
      component: Number(row?.component ?? 0),
    });
  }
  const maxMonth = Math.max(1, ...months.map((m) => m.direct + m.component));

  const movementKind = {
    sale: ["Sale", "fail"],
    purchase: ["Purchase", "ok"],
    build: ["Build", "brand"],
    adjustment: ["Adjustment", "warn"],
  };

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
      <div class="fact src-platform"><span class="f-label">Weekly demand</span><span class="f-value">${i.demand.weekly ? i.demand.weekly.toFixed(1) : "0"}</span></div>
      <div class="fact src-platform"><span class="f-label">Cover</span><span class="f-value">${i.coverWeeks == null ? "—" : `${i.coverWeeks}w`}</span></div>
      <div class="fact src-platform"><span class="f-label">Open PO incoming</span><span class="f-value">${qty(i.incomingQty)}</span></div>
      <div class="fact src-platform"><span class="f-label">Used in products</span><span class="f-value">${i.parentCount}</span></div>
    </div>
    <p class="src-legend"><span class="sw myob"></span>MYOB fact &nbsp; <span class="sw platform"></span>Platform analysis (synced ${ago(i.syncedAt)})</p>

    <div class="two-col" style="margin-top:1.1rem">
      <div>
        <section class="panel">
          <h2>Demand — last 12 months</h2>
          <p class="hint">Dark = direct sales (invoice lines). Orange = consumed by builds of finished products. These are separate MYOB movements — never double counted.</p>
          <div class="bars">
            ${months
              .map((m) => {
                const dh = Math.round((m.direct / maxMonth) * 100);
                const ch = Math.round((m.component / maxMonth) * 100);
                return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end">
                  <div class="bar-col" title="Direct ${m.direct.toFixed(0)} · Component ${m.component.toFixed(0)}">
                    <div class="seg-comp" style="height:${ch}px"></div>
                    <div class="seg-direct" style="height:${dh}px"></div>
                  </div>
                  <div class="bar-label">${m.label}</div>
                </div>`;
              })
              .join("")}
          </div>
          <p class="hint" style="margin-top:0.6rem">
            90-day: ${qty(i.demand.direct90)} direct + ${qty(i.demand.component90)} via builds ·
            365-day: ${qty(i.demand.direct365)} direct + ${qty(i.demand.component365)} via builds ·
            rate basis: ${i.demand.basis}
          </p>
        </section>

        <section class="panel">
          <h2>Recent movements (MYOB evidence)</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Type</th><th>Doc</th><th>Date</th><th class="num">Qty ±</th><th>With / memo</th></tr></thead>
            <tbody>
              ${
                d.movements.length
                  ? d.movements
                      .map((m) => {
                        const [label, tone] = movementKind[m.kind] ?? [m.kind, "idle"];
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
                        <td class="num">${qty(p.qty)}</td><td class="num">${money(p.unit_price)}</td></tr>`,
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
                    <li>Less available ${qty(s.rationale.available)} and incoming ${qty(s.rationale.incoming)}</li>
                    ${s.rationale.reorderMultiple ? `<li>Rounded to MYOB reorder multiple of ${qty(s.rationale.reorderMultiple)}</li>` : ""}
                  </ul>
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
              ? `${
                  d.buildability
                    ? `<p class="hint">Buildable now from component stock: <strong>${
                        d.buildability.maxUnits == null ? "unknown" : qty(d.buildability.maxUnits)
                      } unit(s)</strong>${
                        d.buildability.constraint
                          ? ` — constrained by ${esc(d.buildability.constraint.number ?? "")}`
                          : ""
                      }</p>`
                    : ""
                }
                <div class="table-wrap"><table>
                <thead><tr><th>Component</th><th class="num">Qty per</th><th class="num">Avail</th><th class="num">Builds</th><th>Source</th></tr></thead>
                <tbody>${d.components
                  .map(
                    (c) => `<tr>
                      <td>${itemLink(c.uid, `${c.number ?? "—"}`)}<br /><span class="muted">${esc((c.name ?? "").slice(0, 40))}</span></td>
                      <td class="num">${qty(c.qty_per)}</td>
                      <td class="num">${qty(c.qty_available)}</td>
                      <td class="num">${c.qty_per > 0 ? qty(Math.floor(Math.max(c.qty_available ?? 0, 0) / c.qty_per)) : "—"}</td>
                      <td>${sourceBadge(c.source, c.confidence, c.build_count)}</td>
                    </tr>`,
                  )
                  .join("")}</tbody>
              </table></div>`
              : '<p class="muted">No component relationships observed for this item.</p>'
          }
        </section>

        <section class="panel">
          <h2>Used in (finished products)</h2>
          ${
            d.whereUsed.length
              ? `<div class="table-wrap"><table>
                <thead><tr><th>Product</th><th class="num">Qty per</th><th class="num">Product avail</th><th>Source</th></tr></thead>
                <tbody>${d.whereUsed
                  .map(
                    (p) => `<tr>
                      <td>${itemLink(p.uid, `${p.number ?? "—"}`)}<br /><span class="muted">${esc((p.name ?? "").slice(0, 40))}</span>
                        ${p.used_higher ? '<br /><span class="badge idle">also a component</span>' : ""}</td>
                      <td class="num">${qty(p.qty_per)}</td>
                      <td class="num">${qty(p.qty_available)}</td>
                      <td>${sourceBadge(p.source, p.confidence, p.build_count)}</td>
                    </tr>`,
                  )
                  .join("")}</tbody>
              </table></div>`
              : '<p class="muted">Not used in any tracked finished product.</p>'
          }
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
      <h2>Add a relationship (Allied-defined)</h2>
      <p class="hint">Stored in this platform only — never written to MYOB. Use MYOB item numbers.</p>
      <div class="toolbar">
        <input type="text" id="bom-parent" placeholder="Parent item number" />
        <input type="text" id="bom-component" placeholder="Component item number" />
        <input type="number" id="bom-qty" placeholder="Qty per unit" min="0" step="any" style="width:110px" />
        <button class="btn primary" id="bom-add">Add</button>
      </div>
      <p class="muted" id="bom-msg"></p>
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

  document.getElementById("bom-add").addEventListener("click", async () => {
    const msg = document.getElementById("bom-msg");
    msg.textContent = "";
    try {
      const parentNumber = document.getElementById("bom-parent").value.trim();
      const componentNumber = document.getElementById("bom-component").value.trim();
      const qtyPer = Number(document.getElementById("bom-qty").value);
      const [parent, component] = await Promise.all([
        fetchJson(`/api/insights/items?q=${encodeURIComponent(parentNumber)}&pageSize=10`),
        fetchJson(`/api/insights/items?q=${encodeURIComponent(componentNumber)}&pageSize=10`),
      ]);
      const p = parent.items.find((x) => x.number === parentNumber) ?? parent.items[0];
      const c = component.items.find((x) => x.number === componentNumber) ?? component.items[0];
      if (!p || !c) throw new Error("Item numbers not found in synced data.");
      await fetchJson("/api/insights/bom", {
        method: "POST",
        body: JSON.stringify({ parentUid: p.uid, componentUid: c.uid, qtyPer }),
      });
      msg.textContent = `Added: ${p.number} uses ${qty(qtyPer)} × ${c.number}.`;
      loadProductsTable();
    } catch (err) {
      msg.textContent = err.message;
    }
  });

  await loadProductsTable();
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
        <th>Product</th><th class="num">Components</th><th class="num">Avail</th>
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
                    <td class="num">${qty(p.qty_available)}</td>
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
        grouped by MYOB primary supplier. Suggestions are decision support — nothing is written to MYOB.</p>
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
              <h2>${esc(g.supplier)} <span class="muted" style="text-transform:none;font-weight:500">· ${qty(g.itemCount)} item(s) · est ${money(g.estimatedCost)}</span></h2>
              <div class="table-wrap"><table>
                <thead><tr>
                  <th>Risk</th><th>Item</th><th class="num">Avail</th><th class="num">Incoming</th>
                  <th class="num">Weekly</th><th>Cover</th><th class="num">Suggested qty</th><th class="num">Est cost</th><th>Flags</th>
                </tr></thead>
                <tbody>${g.items
                  .map(
                    (i) => `<tr class="rowlink" data-uid="${esc(i.uid)}">
                      <td>${riskPill(i.risk.score)}</td>
                      <td><strong>${esc(i.number ?? "—")}</strong><br /><span class="muted">${esc((i.name ?? "").slice(0, 50))}</span>
                        ${i.supplierItemNumber ? `<br /><span class="muted">Supplier ref: ${esc(i.supplierItemNumber)}</span>` : ""}</td>
                      <td class="num">${qty(i.qtyAvailable)}</td>
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
        <p class="hint" style="margin-top:0.6rem">Transactional history window: ${d.settings.syncWindowDays} days ·
        relationships derived: ${qty(d.counts?.bom_derived)} · user-defined: ${qty(d.counts?.bom_user)}</p>
      </section>

      <section class="panel">
        <h2>Data quality flags</h2>
        <div class="table-wrap"><table>
          <tbody>
            <tr><td>Negative stock (needs investigation in MYOB)</td><td class="num">${qty(d.dataQuality.negativeStock)}</td></tr>
            <tr><td>Stock on hand with zero average cost</td><td class="num">${qty(d.dataQuality.stockNoCost)}</td></tr>
            <tr><td>Inactive items still holding stock</td><td class="num">${qty(d.dataQuality.inactiveWithStock)}</td></tr>
            <tr><td>Items with demand but no primary supplier</td><td class="num">${qty(d.dataQuality.demandNoSupplier)}</td></tr>
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
        <dd>Taken directly from the MYOB item master and never recalculated by this platform.</dd>
        <dt>Direct demand</dt>
        <dd>Item-layout sales invoice lines. Credit notes have negative quantities and reduce demand automatically.</dd>
        <dt>Component consumption</dt>
        <dd>Negative lines on MYOB Inventory Build transactions — stock used to assemble finished products.
        Separate movements from sales, so combining them does not double count.</dd>
        <dt>Weekly demand / cover</dt>
        <dd>Trailing 90-day rate; items with no 90-day activity fall back to the 365-day rate and are flagged "slow mover".
        Cover = available ÷ weekly demand.</dd>
        <dt>Derived relationships</dt>
        <dd>Observed from MYOB build transactions with a single finished item. Confidence grows with corroborating builds.
        MYOB's API does not expose Auto-Build definitions, so unobserved recipes must be added manually.</dd>
        <dt>Purchasing suggestions</dt>
        <dd>Weekly demand × target cover + minimum level − available − incoming, rounded to the MYOB reorder multiple.
        Advisory only.</dd>
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

route();
pollSyncChip();
setInterval(pollSyncChip, 60_000);
