const actions = document.getElementById("actions");
const setupPanel = document.getElementById("setup-panel");
const probeBtn = document.getElementById("probe-btn");
const probeSummary = document.getElementById("probe-summary");
const probeGroups = document.getElementById("probe-groups");
const metaStatus = document.getElementById("meta-status");
const metaUser = document.getElementById("meta-user");
const metaCompany = document.getElementById("meta-company");
const metaExpiry = document.getElementById("meta-expiry");
const metaScopes = document.getElementById("meta-scopes");

const IDLE_GROUPS = ["Contact", "Sale", "Purchase", "Inventory"];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/* ---------- access key ----------
 *
 * The console talks to /auth and /api, which are now behind the same shared
 * key as the dashboard — they were open to the internet, including the logout
 * route that wipes the MYOB connection. The key is stored under the same name
 * the dashboard uses, so unlocking either one unlocks both.
 */
const KEY_STORAGE = "afDashboardKey";
let memoryKey = "";

function accessKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || memoryKey;
  } catch {
    return memoryKey;
  }
}

function saveKey(value) {
  memoryKey = value;
  try {
    localStorage.setItem(KEY_STORAGE, value);
  } catch {
    // Private browsing or blocked storage: memoryKey keeps this tab working.
  }
}

/** Append the key to a plain navigation, which cannot carry a header. */
function withKey(url) {
  const key = accessKey();
  if (!key) return url;
  return `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
}

function promptForKey(message) {
  const entered = window.prompt(
    message || "Dashboard access key required to manage the MYOB connection.",
  );
  if (entered && entered.trim()) {
    saveKey(entered.trim());
    return true;
  }
  return false;
}

async function fetchJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  const key = accessKey();
  if (key) headers["x-dashboard-key"] = key;
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Ask once, then retry; a second 401 is a wrong key, not a missing one.
    if (promptForKey()) return fetchJson(url, options);
    throw new Error("Dashboard access key required.");
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Unlock via /?key=XXXX, then strip it from the address bar so it is not left
// visible or bookmarked. Mirrors the dashboard's behaviour.
const urlKey = new URLSearchParams(location.search).get("key");
if (urlKey && urlKey.trim()) {
  saveKey(urlKey.trim());
  history.replaceState({}, "", location.pathname);
}

function renderActions(hasConnection) {
  actions.innerHTML = "";

  if (hasConnection) {
    const dash = document.createElement("a");
    dash.className = "btn primary";
    dash.href = "/dashboard";
    dash.textContent = "Open dashboard";
    actions.appendChild(dash);
  }

  const connect = document.createElement("a");
  connect.className = hasConnection ? "btn secondary" : "btn primary";
  connect.href = withKey("/auth/login");
  connect.textContent = hasConnection ? "Reconnect MYOB" : "Connect MYOB";
  actions.appendChild(connect);

  if (hasConnection) {
    const logout = document.createElement("button");
    logout.className = "btn ghost";
    logout.type = "button";
    logout.textContent = "Disconnect";
    logout.addEventListener("click", async () => {
      await fetchJson("/auth/logout", { method: "POST" });
      location.reload();
    });
    actions.appendChild(logout);
  }
}

function renderIdleGroups() {
  probeGroups.innerHTML = IDLE_GROUPS.map(
    (group) => `
      <article class="group">
        <div class="group-head">
          <span class="group-title">${group}</span>
          <span class="badge idle">Idle</span>
        </div>
        <p class="probe-summary">Awaiting Allied Fastenings authorisation.</p>
      </article>`,
  ).join("");
}

function formatScopes(scope) {
  if (!scope) return "—";
  return scope
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => `<code>${escapeHtml(s)}</code>`)
    .join(" ");
}

function renderProbe(report) {
  const { summary, groups, probedAt } = report;
  probeSummary.textContent = `${summary.okCount}/${summary.total} endpoints OK · probed ${new Date(
    probedAt,
  ).toLocaleString()}`;

  probeGroups.innerHTML = groups
    .map((group) => {
      const badge = group.ok
        ? `<span class="badge ok">${group.okCount}/${group.total} OK</span>`
        : `<span class="badge fail">${group.okCount}/${group.total} OK</span>`;

      const rows = group.endpoints
        .map((ep) => {
          const state = ep.ok
            ? `<span class="badge ok">OK</span>`
            : `<span class="badge fail">FAIL</span>`;
          return `
            <tr>
              <td class="path">/${escapeHtml(ep.path)}</td>
              <td>${state}</td>
              <td>${ep.status ?? "—"}</td>
              <td>${ep.latencyMs} ms</td>
              <td>${ep.count == null ? "—" : ep.count}</td>
              <td class="err">${ep.error ? escapeHtml(ep.error) : "—"}</td>
            </tr>`;
        })
        .join("");

      return `
        <article class="group">
          <div class="group-head">
            <span class="group-title">${escapeHtml(group.group)}</span>
            ${badge}
          </div>
          <table class="endpoint-table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>State</th>
                <th>HTTP</th>
                <th>Latency</th>
                <th>Count</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </article>`;
    })
    .join("");
}

async function runProbe() {
  probeBtn.disabled = true;
  probeSummary.textContent = "Probing MYOB endpoints…";
  try {
    const report = await fetchJson("/api/connection/probe");
    renderProbe(report);
  } catch (err) {
    probeSummary.textContent = err.message;
    renderIdleGroups();
  } finally {
    probeBtn.disabled = false;
  }
}

async function loadStatus() {
  const status = await fetchJson("/auth/status");

  if (!status.configured) {
    setupPanel.hidden = false;
    metaStatus.textContent = "Credentials missing";
    renderActions(false);
    probeBtn.disabled = true;
    renderIdleGroups();
    return;
  }

  setupPanel.hidden = true;
  const connections = status.connections || [];
  renderActions(connections.length > 0);

  if (!connections.length) {
    metaStatus.textContent = "Not connected";
    metaUser.textContent = "—";
    metaCompany.textContent = "—";
    metaExpiry.textContent = "—";
    metaScopes.textContent = "—";
    probeBtn.disabled = true;
    probeSummary.textContent =
      "Connect the Allied Fastenings company file to run probes.";
    renderIdleGroups();
    return;
  }

  // Single-customer mode: use the active/first connected file only.
  const active =
    connections.find((c) => c.businessId === status.activeBusinessId) ||
    connections[0];

  metaStatus.textContent = "Connected";
  metaUser.textContent = active.username || "—";
  metaCompany.textContent = active.displayName || active.businessId;
  metaExpiry.textContent = active.tokenExpiresAt
    ? new Date(active.tokenExpiresAt).toLocaleString()
    : "—";
  metaScopes.innerHTML = formatScopes(active.scope);

  probeBtn.disabled = false;
  await runProbe();
}

probeBtn.addEventListener("click", () => {
  runProbe();
});

if (new URLSearchParams(location.search).get("connected") === "1") {
  history.replaceState({}, "", "/");
}

renderIdleGroups();
loadStatus().catch((err) => {
  metaStatus.textContent = err.message;
});
