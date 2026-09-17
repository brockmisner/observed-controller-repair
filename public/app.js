const state = {
  snapshot: null,
  selectedId: null,
  markers: new Map(),
  phoneMarkers: new Map(),
  circles: new Map(),
  trails: new Map(),
  routes: new Map(),
  anchors: new Map(),
  heat: new Map(),
  preview: null,
  ghost: null,
  walkDest: null,
  destMarker: null,
  playIndex: null,
  onOnly: true,
  showHistory: false,
  historyScope: null,
  historyCutoffs: new Map(),
  sat: false,
  authenticated: null,
  sessionVersion: 0,
  authMode: "login",
  signupsOpen: false,
  keysBusy: false,
  radiusDrafts: new Map(),
  environmentOperations: new Map(),
  detailFocus: new Map(),
  snapshotVersion: 0,
  snapshotAt: null,
  connectionError: "",
  inspectorTabs: new Map(),
  anchorDrafts: new Map(),
  controlOperations: new Map(),
  snapshotRequestId: 0,
  lastSnapshotResult: 0,
  initialFocus: false,
  mapFocus: null,
};

const savedView = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("obs-map") || "null");
    const point = coordinatePoint(saved?.lat, saved?.lng);
    return point && Number.isFinite(saved?.zoom) && saved.zoom >= 0 && saved.zoom <= 19 ? { ...point, zoom: saved.zoom } : null;
  } catch {
    return null;
  }
})();
const map = L.map("map", { zoomControl: true, attributionControl: true }).setView(
  savedView ? [savedView.lat, savedView.lng] : [28.0395, -81.9498],
  savedView?.zoom ?? 14,
);
const satLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
  attribution: "Tiles © Esri",
});
const labelLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19,
});
const streetLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  referrerPolicy: "strict-origin-when-cross-origin",
});
streetLayer.addTo(map);
const environmentExplorer = window.ObservatoryEnvironmentExplorer?.create({
  map, L, api, icon, operation: environmentOperation, powerReason: environmentPowerReason,
  prepare: requestSavedEnvironment, focusMap, mobileMap: () => setMobileView("map"),
});
const driving = window.ObservatoryDriving?.create({
  map, L, api, icon,
  providerReadiness: (device) => deviceStatus("readiness", device),
  mobileMap: () => setMobileView("map"),
  mobileDevice: () => setMobileView("device"),
  mapMode: (active) => document.body.classList.toggle("driving-active", active),
  onTrip: (trip) => {
    state.snapshotVersion += 1;
    const device = state.snapshot?.devices.find((item) => item.id === trip.deviceId);
    if (device) {
      device.trip = trip;
      if (["RUNNING", "PAUSED", "ARRIVING"].includes(trip.status)) device.activeTripId = trip.id;
      else if (device.activeTripId === trip.id) device.activeTripId = null;
    }
  },
});
const sites = window.ObservatorySites?.create({
  api, icon, openModal, closeModal,
  showDevices: () => setMobileView(document.body.dataset.view || "map"),
});
const warmup = window.ObservatoryWarmup?.create({ api, openModal, closeModal });
const rpaJobs = window.ObservatoryRpaJobs?.create({ api, openModal, closeModal,
  onResolved: () => { state.snapshotVersion += 1; void load().catch(() => {}); },
});
map.on("moveend", () => {
  const c = map.getCenter();
  localStorage.setItem("obs-map", JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom() }));
});

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function icon(name) {
  return window.obsIcon?.(name) || "";
}

function statusContext() {
  return { nowMs: Date.now(), snapshotAt: state.snapshotAt, connected: Boolean(state.snapshotAt && !state.connectionError), powerStatusMaxAgeMs: state.snapshot?.health?.powerStatusMaxAgeMs };
}

function deviceStatus(kind, device) {
  return window.ObservatoryStatus?.[kind]?.(device, statusContext()) || { code: "UNKNOWN", label: "Unknown", tone: "neutral", reason: "Status unavailable", source: "Unknown", fresh: false };
}

function statusHtml(status) {
  const tone = ["good", "warn", "bad", "neutral"].includes(status.tone) ? status.tone : "neutral";
  return `<span class="status-chip ${tone}" title="${escapeHtml(status.reason)}">${escapeHtml(status.label)}</span>`;
}

function renderConnection() {
  const box = $("connectionStatus");
  if (!box) return;
  const status = window.ObservatoryStatus?.connection?.(statusContext());
  box.className = `connection-status ${status?.tone || "neutral"}`;
  box.textContent = state.connectionError ? `Connection interrupted. Last update ${age(state.snapshotAt)}. ${state.connectionError}` : state.snapshotAt ? `${status?.label || "Connected"} · Updated ${age(state.snapshotAt)}` : "Loading workspace...";
  box.title = status?.reason || "";
}

function setMobileView(view) {
  if (!["fleet", "map", "device"].includes(view)) return;
  map.stop();
  document.body.dataset.view = view;
  document.querySelectorAll("[data-mobile-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.mobileView === view);
    button.setAttribute("aria-pressed", String(button.dataset.mobileView === view));
  });
  if (view === "map") setTimeout(() => {
    map.invalidateSize();
    driving?.resize();
    if (state.mapFocus) { map.setView([state.mapFocus.lat, state.mapFocus.lng], state.mapFocus.zoom, { animate: false }); state.mapFocus = null; }
  }, 0);
}

function focusMap(lat, lng, zoom) {
  if (!coordinatePoint(lat, lng) || !Number.isFinite(zoom)) return;
  const container = map.getContainer();
  if (!container.clientWidth || !container.clientHeight) { state.mapFocus = { lat, lng, zoom }; return; }
  state.mapFocus = null;
  map.invalidateSize();
  map.flyTo([lat, lng], zoom, { duration: 0.4 });
}

function formMessage(id, message = "", error = false) {
  const box = $(id);
  if (!box) return;
  box.textContent = message;
  box.hidden = !message;
  box.classList.toggle("error", error);
}

function openModal(id) {
  $(id).hidden = false;
  document.querySelector(".topbar").inert = true;
  document.querySelector(".shell").inert = true;
  if ($("sitesWorkspace")) $("sitesWorkspace").inert = true;
  if ($("warmupWorkspace")) $("warmupWorkspace").inert = true;
  document.querySelector(".workspace-nav")?.setAttribute("inert", "");
  document.querySelector(".capability-notice")?.setAttribute("inert", "");
  if ($("mobileNav")) $("mobileNav").inert = true;
  $(id).querySelector("input:not([disabled]), button:not([disabled])")?.focus();
}

function closeModal(id) {
  $(id).hidden = true;
  const modalOpen = Boolean(document.querySelector(".modal:not([hidden])"));
  document.querySelector(".topbar").inert = modalOpen;
  document.querySelector(".shell").inert = modalOpen;
  if ($("sitesWorkspace")) $("sitesWorkspace").inert = modalOpen;
  if ($("warmupWorkspace")) $("warmupWorkspace").inert = modalOpen;
  const workspaceNav = document.querySelector(".workspace-nav");
  if (workspaceNav) workspaceNav.inert = modalOpen;
  const capabilityNotice = document.querySelector(".capability-notice");
  if (capabilityNotice) capabilityNotice.inert = modalOpen;
  if ($("mobileNav")) $("mobileNav").inert = modalOpen;
}

function clearWorkspace() {
  sites?.clear();
  warmup?.clear();
  rpaJobs?.clear();
  environmentExplorer?.clear();
  driving?.clear();
  state.sessionVersion += 1;
  state.snapshotVersion += 1;
  state.radiusDrafts.clear();
  state.environmentOperations.clear();
  state.detailFocus.clear();
  state.inspectorTabs.clear();
  state.anchorDrafts.clear();
  state.controlOperations.clear();
  state.historyScope = null;
  state.historyCutoffs.clear();
  state.showHistory = false;
  state.snapshotAt = null;
  state.connectionError = "";
  state.initialFocus = false;
  state.mapFocus = null;
  state.snapshot = null;
  updateHistoryControls("");
  state.selectedId = null;
  state.walkDest = null;
  state.playIndex = null;
  for (const bucket of [state.markers, state.phoneMarkers, state.circles, state.trails, state.routes, state.anchors, state.heat]) {
    for (const layer of bucket.values()) map.removeLayer(layer);
    bucket.clear();
  }
  for (const key of ["preview", "ghost", "destMarker"]) {
    if (state[key]) map.removeLayer(state[key]);
    state[key] = null;
  }
  map.closePopup();
  for (const id of ["kpis", "keyTable", "rpaTable", "opsSession", "keysList", "wigleCredential"]) $(id).textContent = "";
  $("workspaceName").textContent = "Workspace";
  $("keysWorkspace").textContent = "";
  $("fleetList").innerHTML = '<div class="empty">Log in to your workspace.</div>';
  $("fleetFilter").value = "";
  if ($("fleetStatus")) $("fleetStatus").value = "all";
  $("addKeyForm").reset();
  $("wigleKeyForm").reset();
  setKeysBusy(false);
  $("btnSaveDuoKey").textContent = "Save DuoPlus key";
  formMessage("duoKeyMessage");
  formMessage("wigleKeyMessage");
  renderWigleCredential(null);
  $("registerForm").reset();
  $("wiglePreview").textContent = "";
  $("wiglePreview").hidden = true;
  document.title = "Observatory Controller";
  renderDetail();
  updateCompass(null);
  updateRadiusLegend();
  renderConnection();
}

function showLogin() {
  if (state.authenticated !== false) clearWorkspace();
  state.authenticated = false;
  closeModal("keysModal");
  closeModal("registerModal");
  if ($("diagnosticsModal")) closeModal("diagnosticsModal");
  if ($("loginModal").hidden) openModal("loginModal");
}

function fmt(n, digits = 2) {
  if ((typeof n !== "number" && typeof n !== "string") || (typeof n === "string" && !n.trim()) || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

function coordinatePoint(lat, lng) {
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

function age(iso) {
  if (iso === null || iso === undefined || iso === "") return "Unavailable";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "Unavailable";
  if (ms < 5000) return "just now";
  if (ms < 60000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`;
  return `${Math.round(ms / 3600000)}h ago`;
}

function daysLeft(end) {
  const ms = new Date(end).getTime() - Date.now();
  return Math.max(0, ms / 86400000);
}

async function api(path, opts = {}) {
  const sessionVersion = state.sessionVersion;
  const controller = !opts.signal && (!opts.method || opts.method === "GET") ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), 20_000) : null;
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      ...(controller ? { signal: controller.signal } : {}),
      ...opts,
    });
    const data = await res.json().catch((error) => { if (controller?.signal.aborted) throw error; return {}; });
    if (res.status === 401) {
      if (sessionVersion === state.sessionVersion) showLogin();
      throw new Error(data.error || "unauthorized");
    }
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  } catch (error) {
    if (controller?.signal.aborted) throw new Error("Read timed out after 20 seconds. Try Refresh.");
    throw error;
  } finally { if (timeout) clearTimeout(timeout); }
}

function deviceIcon(phase) {
  const color = "#087d69";
  return L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function discoveredOnDevices(snap) {
  return [...new Map((snap.discoveredDevices || [])
    .filter((device) => device.status === 1 && device.imageId)
    .map((device) => [device.imageId, device])).values()];
}

function confirmedOnDevices(snap) {
  const context = statusContext();
  const registered = new Map(snap.devices.filter((device) => device.imageId).map((device) => [device.imageId, device]));
  // Registered rows already preserve newer power checks when an older inventory request finishes later.
  const pending = discoveredOnDevices(snap).filter((device) => !registered.has(device.imageId)).map((device) => ({
    ...device, poweredOn: true, duoPlusStatus: device.status, lastPowerSyncAt: snap.health.lastFleetSyncAt,
  }));
  return [...registered.values(), ...pending].filter((device) => window.ObservatoryStatus?.isFreshOn?.(device, context));
}

function renderKpis(snap) {
  const qps = snap.health.qps || { qps: 0, cap: 1, hot: false, series: [] };
  const deadKeys = snap.keys.filter((k) => k.dead).length;
  $("kpis").innerHTML = `
    <div class="kpi"><span>Confirmed ON</span><b>${confirmedOnDevices(snap).length}</b></div>
    <div class="kpi"><span>Registered</span><b>${snap.devices.length}</b></div>
    <div class="kpi"><span>Send mode</span><b>${snap.health.dryRun ? "Dry run" : "Enabled"}</b></div>
    <div class="kpi"><span>WiGLE credentials</span><b>${snap.health.wigleConfigured ? "Configured" : "Missing"}</b></div>
  `;
  const configuredPoll = snap.health.nextFleetSyncMs;
  const pollMs = Number.isInteger(configuredPoll) && configuredPoll >= 1000 && configuredPoll <= 285000 ? configuredPoll : 60_000;
  if ($("fleetPollLabel")) $("fleetPollLabel").textContent = pollMs % 60_000 === 0 ? `${pollMs / 60_000}-minute power checks` : `${Math.round(pollMs / 1000)}-second power checks`;
}

function renderFleet(snap) {
  const focusedDevice = document.activeElement?.closest?.(".fleet-item[data-id]")?.dataset.id;
  const focusedRegistration = document.activeElement?.closest?.("[data-register-image]")?.dataset.registerImage;
  const q = $("fleetFilter").value.trim().toLowerCase();
  const filter = $("fleetStatus")?.value || "all";
  const registeredImages = new Set(snap.devices.map((device) => device.imageId));
  const importIssues = new Map((snap.inventoryImportIssues || []).map((issue) => [issue.imageId, issue]));
  const importIssueHtml = (imageId) => {
    const issue = importIssues.get(imageId);
    if (!issue) return "";
    const retry = new Date(issue.nextRetryAt);
    return `<small class="inventory-import-warning"><strong>Import needs attention</strong> · ${escapeHtml(issue.error)}<br>Next automatic attempt: ${escapeHtml(Number.isFinite(retry.getTime()) ? retry.toLocaleString() : "Not scheduled")}</small>`;
  };
  const inventory = snap.folderInventory;
  const folderSelect = $("fleetFolder");
  const selectedFolder = folderSelect?.value || "all";
  const members = new Map((inventory?.phones || []).map(p => [p.imageId, p]));
  const folderOptions = '<option value="all">All folders</option>' + (inventory?.folders || []).map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)} (${inventory.phones.filter(p => p.groups?.some(g => g.id === f.id)).length})</option>`).join("") + '<option value="ungrouped">Ungrouped</option><option value="unknown">Folder unknown</option>';
  if (folderSelect && folderSelect.innerHTML !== folderOptions) { folderSelect.innerHTML = folderOptions; folderSelect.value = selectedFolder; if (!folderSelect.value) folderSelect.value = "all"; }
  const folder = folderSelect?.value || "all";
  const inFolder = d => { const groups = members.get(d.imageId)?.groups; return folder === "all" || folder === "unknown" && groups == null || folder === "ungrouped" && Array.isArray(groups) && !groups.length || groups?.some(g => g.id === folder); };
  const folderLabel = d => { const groups = members.get(d.imageId)?.groups; return groups == null ? "Folder unknown" : groups.length ? groups.map(g => g.name).join(" · ") : "Ungrouped"; };
  if ($("fleetFolderSummary")) $("fleetFolderSummary").textContent = inventory ? `${inventory.folders.length} folders · ${inventory.phones.length} inventory phones · ${snap.devices.length} registered · Synced ${age(inventory.checkedAt)}` : "Waiting for DuoPlus folder sync";

  const syncedAt = new Date(snap.health.lastFleetSyncAt).getTime();
  const powerAgeLimit = window.ObservatoryStatus?.powerMaxAgeMs?.(statusContext()) || 75_000;
  const inventoryFresh = !state.connectionError && state.snapshotAt && Date.now() - state.snapshotAt <= 15_000 && Number.isFinite(syncedAt) && Date.now() >= syncedAt && Date.now() - syncedAt <= powerAgeLimit;
  const pendingHtml = (inventory?.phones || discoveredOnDevices(snap))
    .filter(inFolder)
    .filter((device) => !registeredImages.has(device.imageId))
    .filter((device) => filter !== "attention" || importIssues.has(device.imageId))
    .filter(device => filter !== "on" || inventoryFresh && device.status === 1)
    .filter((device) => !q || `${device.name || ""} ${device.imageId}`.toLowerCase().includes(q))
    .map((device) => `
      <div class="fleet-item">
        <div class="row">
          <strong>${escapeHtml(device.name || device.imageId)}</strong>
          <span class="status-chip neutral">${({1:"ON · Not registered",2:"OFF · Not registered",3:"Expired",4:"Renewal overdue"})[device.status] || "Inventory only"}</span>
        </div>
        <small>${escapeHtml(device.imageId)} · ${escapeHtml(folderLabel(device))}</small>
        ${importIssueHtml(device.imageId)}
        <div class="row">
          <small>Not registered with Observatory</small>
          ${device.status === 1 ? `<button type="button" class="btn ghost tiny" data-register-image="${escapeHtml(device.imageId)}" aria-label="Register ${escapeHtml(device.name || device.imageId)}">Register</button>` : ""}
        </div>
      </div>
    `)
    .join("");
  const html = snap.devices
    .filter(inFolder)
    .filter((d) => filter !== "pending")
    .filter((d) => filter !== "on" || window.ObservatoryStatus?.isFreshOn?.(d, statusContext()))
    .filter((d) => filter !== "attention" || importIssues.has(d.imageId) || window.ObservatoryStatus?.attention?.(d, statusContext()))
    .filter((d) => !q || `${d.name} ${d.imageId}`.toLowerCase().includes(q))
    .map((d) => `
      <button type="button" class="fleet-item ${state.selectedId === d.id ? "active" : ""}" data-id="${escapeHtml(d.id)}" aria-pressed="${state.selectedId === d.id}">
        <div class="row">
          <strong>${escapeHtml(d.name || d.imageId)}</strong>
          ${statusHtml(deviceStatus("activity", d))}
          ${d.active === false && deviceStatus("activity", d).code !== "trip_paused" ? '<span class="status-chip neutral">Paused</span>' : ""}
        </div>
        <small>${escapeHtml(d.imageId)} · ${escapeHtml(folderLabel(d))}</small>
        ${importIssueHtml(d.imageId)}
        <div class="fleet-subline">${statusHtml(deviceStatus("wifi", d))}<small>Checked ${age(d.lastPowerSyncAt)}</small></div>
      </button>
    `)
    .join("");
  $("fleetList").innerHTML = pendingHtml + html || `<div class="empty">${q ? "No devices match this filter." : "No devices found."}</div>`;
  if ($("fleetCount")) $("fleetCount").textContent = String($("fleetList").querySelectorAll(".fleet-item").length);
  if (focusedDevice) [...$("fleetList").querySelectorAll(".fleet-item[data-id]")].find((item) => item.dataset.id === focusedDevice)?.focus({ preventScroll: true });
  else if (focusedRegistration) [...$("fleetList").querySelectorAll("[data-register-image]")].find((item) => item.dataset.registerImage === focusedRegistration)?.focus({ preventScroll: true });
}

function renderKeys(snap) {
  $("keyTable").innerHTML = snap.keys.length ?
    `<div class="row"><b>key</b><b>ok</b><b>fail</b><b>state</b></div>` +
    snap.keys
      .map((k) => {
        const congested = k.congested === true || (k.congestedUntil && new Date(k.congestedUntil) > new Date());
        const label = k.dead ? "dead" : congested ? "429" : "ready";
        return `<div class="row"><span>${escapeHtml(k.label)}</span><span class="ok">${k.successCount ?? 0}</span><span>${k.failCount ?? 0}</span><span class="${k.dead ? "bad" : ""}">${label}</span></div>`;
      })
      .join("") : `<div class="empty">No DuoPlus keys connected.</div>`;
}

function renderRpa(snap) {
  $("rpaTable").innerHTML = snap.rpa.length ?
    `<div class="row"><b>task</b><b>device</b><b>status</b><b>when</b></div>` +
    snap.rpa
      .map((j) => `<div class="row"><span>${escapeHtml(j.name)}</span><span>${escapeHtml(j.deviceId.slice(0, 8))}</span><span>${escapeHtml(j.status)}</span><span>${age(j.createdAt)}</span></div>`)
      .join("") : `<div class="empty">No RPA jobs yet.</div>`;
}

function clusterHtml(raw) {
  if (!raw) return "";
  try {
    const cluster = JSON.parse(raw);
    const rows = (cluster.nearby || [])
      .map((n) => `<div>${escapeHtml(n.ssid)} <code>${escapeHtml(n.bssid)}</code> · ${Number(n.distanceM).toFixed(0)}m qos ${escapeHtml(n.qos)}</div>`)
      .join("");
    return `<div style="margin-top:6px">cluster${rows}</div>`;
  } catch {
    return "";
  }
}

function selectedDevice() {
  return state.snapshot?.devices.find((d) => d.id === state.selectedId) ?? null;
}

function heatStrip(ticks) {
  if (!ticks.length) return "";
  return ticks
    .map((t) => {
      const a = Number(t.accuracyM) || 8;
      const g = a <= 6 ? "#3ee0c5" : a <= 9 ? "#f0b429" : "#ff6b7a";
      return `<div class="heatcell" title="Model accuracy ${fmt(a, 1)} m ${age(t.createdAt)}" style="background:${g}"></div>`;
    })
    .join("");
}

function updateCompass(d) {
  const box = $("compass");
  if (!box || !d || !coordinatePoint(d.currentLat, d.currentLng) || !coordinatePoint(d.anchorLat, d.anchorLng)) {
    if (box) box.hidden = true;
    return;
  }
  box.hidden = false;
  const needle = $("needle");
  if (needle) needle.style.transform = `rotate(${Number(d.lastBearing) || 0}deg)`;
  const meters = haversineUi(d.anchorLat, d.anchorLng, d.currentLat, d.currentLng);
  $("pinMeters").textContent = `${fmt(meters, 1)} m`;
}

function haversineUi(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const toR = (n) => (n * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function setWalkDest(lat, lng) {
  state.walkDest = { lat, lng };
  if (!state.destMarker) {
    state.destMarker = L.circleMarker([lat, lng], {
      radius: 7,
      color: "#f0b429",
      weight: 2,
      fillColor: "#f0b429",
      fillOpacity: 0.9,
    }).addTo(map);
  } else {
    state.destMarker.setLatLng([lat, lng]);
  }
  state.destMarker.bindPopup("walk destination").openPopup();
  previewRoute();
  renderDetail();
}

async function previewRoute() {
  const d = selectedDevice();
  if (!d || !state.walkDest) return;
  try {
    const res = await api(
      `/api/route?oLat=${d.currentLat}&oLng=${d.currentLng}&dLat=${state.walkDest.lat}&dLng=${state.walkDest.lng}`,
    );
    const pts = (res.points || []).map((p) => [p.lat, p.lng]);
    if (state.preview) map.removeLayer(state.preview);
    if (pts.length >= 2) {
      state.preview = L.polyline(pts, { color: "#f0b429", weight: 3, dashArray: "6 6", opacity: 0.85 }).addTo(map);
    }
  } catch {
    /* keep pin only */
  }
}

function destFromAction(act, d) {
  const step = 0.00055;
  if (act === "navN") return { lat: d.currentLat + step, lng: d.currentLng };
  if (act === "navS") return { lat: d.currentLat - step, lng: d.currentLng };
  if (act === "navE") return { lat: d.currentLat, lng: d.currentLng + step };
  if (act === "navW") return { lat: d.currentLat, lng: d.currentLng - step };
  return state.walkDest;
}

map.on("click", (e) => {
  const device = selectedDevice();
  if (!device) return;
  if (state.inspectorTabs.get(device.id) === "driving") return;
  const draft = anchorDraft(device);
  if (draft.placing && !draft.saving) {
    draft.lat = String(e.latlng.lat);
    draft.lng = String(e.latlng.lng);
    draft.placing = false;
    draft.error = "";
    updateAnchorEditor(device);
    renderMap(state.snapshot);
    setMobileView("device");
  } else if (state.walkPlacing) {
    state.walkPlacing = false;
    setWalkDest(e.latlng.lat, e.latlng.lng);
    setMobileView("device");
  }
});

function renderDetail() {
  const d = selectedDevice();
  if (!d) {
    environmentExplorer?.update(null, false);
    driving?.update(null, false);
    $("detail").innerHTML = `<div class="empty">Select a device</div>`;
    delete $("detail").dataset.deviceId;
    return;
  }
  const detail = $("detail");
  const changedDevice = detail.dataset.deviceId !== d.id;
  if (changedDevice || !$("detailTelemetry")) {
    detail.dataset.deviceId = d.id;
    detail.innerHTML = `
      <div id="detailHeading"></div>
      <nav class="inspector-tabs" role="tablist" aria-label="Device views">
        ${[["overview", "Overview"], ["movement", "Movement"], ["driving", "Driving"], ["environment", "Environment"], ["history", "History"]].map(([value, label]) => `<button type="button" id="tab-${value}" role="tab" data-inspector-tab="${value}" aria-label="${label}" aria-controls="panel-${value}">${label}</button>`).join("")}
      </nav>
      <section id="panel-overview" class="inspector-panel" data-inspector-panel="overview" role="tabpanel" aria-labelledby="tab-overview"><div id="detailTelemetry"></div></section>
      <section id="panel-movement" class="inspector-panel" data-inspector-panel="movement" role="tabpanel" aria-labelledby="tab-movement" hidden>
      <form id="radiusForm" class="radius-editor">
        <label id="radiusLabel" for="radiusNumber">Movement radius</label>
        <input id="radiusSlider" type="range" min="1" max="100" step="1" aria-label="Movement radius slider" />
        <div class="radius-value"><input id="radiusNumber" type="number" min="1" max="100" step="1" required aria-labelledby="radiusLabel" aria-describedby="radiusFeedback" /><span>m</span></div>
        <button id="radiusSave" type="submit" class="btn tiny">${icon("save")}Save</button>
        <div id="radiusFeedback" class="radius-feedback" role="status" aria-live="polite"></div>
      </form>
      <form id="anchorForm" class="anchor-editor">
        <div class="section-heading span2"><h3>Anchor</h3><button id="anchorEdit" type="button" class="btn ghost tiny">${icon("map-pin")}Edit anchor</button></div>
        <label for="anchorLat">Latitude<input id="anchorLat" type="number" min="-90" max="90" step="any" required /></label><label for="anchorLng">Longitude<input id="anchorLng" type="number" min="-180" max="180" step="any" required /></label>
        <div class="anchor-actions"><button id="anchorPlace" type="button" class="btn ghost tiny">${icon("crosshair")}Place on map</button><button id="anchorCancel" type="button" class="btn ghost tiny">Cancel</button><button id="anchorSave" type="submit" class="btn tiny">${icon("save")}Save anchor</button></div>
        <div id="anchorFeedback" class="form-message" role="status" aria-live="polite"></div>
      </form>
      <div class="movement-actions"><button class="btn ghost" data-act="toggle" id="movementToggle"></button><button class="btn ghost" data-act="park">${icon("map-pin")}Stationary</button><button class="btn ghost" data-act="focus">${icon("locate-fixed")}Focus map</button></div>
      <div id="movementFeedback" class="form-message" role="status" aria-live="polite"></div>
      <details class="walking-tools"><summary>${icon("route")}Walking</summary><div class="meta" id="walkDestination"></div><div class="actions"><button class="btn ghost tiny" data-act="placeDestination">${icon("crosshair")}Choose destination</button><button class="btn tiny" data-act="nav">${icon("route")}Walk to destination</button></div></details>
      </section>
      <section id="panel-driving" class="inspector-panel" data-inspector-panel="driving" role="tabpanel" aria-labelledby="tab-driving" hidden>${driving?.markup() || ""}</section>
      <section id="panel-environment" class="inspector-panel" data-inspector-panel="environment" role="tabpanel" aria-labelledby="tab-environment" hidden>
      ${environmentExplorer?.markup() || ""}
      <section id="environmentSection" class="environment-section" aria-labelledby="environmentHeading">
        <div class="environment-heading"><h3 id="environmentHeading">WiGLE environment</h3><span id="environmentStatus" role="status" aria-live="polite"></span></div>
        <div class="environment-actions">
          <button id="environmentPreview" type="button" class="btn ghost tiny" data-environment-action="preview">Preview WiGLE environment</button>
          <button id="environmentMore" type="button" class="btn ghost tiny" data-environment-action="more" hidden>Load more Wi-Fi</button>
          <button id="environmentApply" type="button" class="btn tiny" data-environment-action="apply">Apply to ON device</button>
          <button id="environmentRecheck" type="button" class="btn ghost icon-button" data-environment-action="recheck" title="Recheck Wi-Fi readback without reapplying" aria-label="Recheck Wi-Fi readback without reapplying" hidden>${icon("refresh-cw")}</button>
        </div>
        <div id="environmentFeedback" class="environment-feedback" role="status" aria-live="polite"></div>
        <div id="environmentSearchProgress" class="meta" role="status" aria-live="polite"></div>
        <div id="environmentTimes"></div>
        <div id="environmentVerification" aria-label="Environment readback" aria-live="polite"></div>
        <div id="environmentProfile"></div>
        <div id="environmentWarnings"></div>
        <details id="environmentSaved" class="environment-saved">
          <summary id="environmentSavedSummary">Saved WiGLE data</summary>
          <div class="wigle-upload-toolbar"><button id="wigleUploadButton" type="button" class="btn ghost tiny">${icon("plus")}Upload JSON</button><span class="meta">Saved only; not applied</span></div>
          <input id="wigleUploadFile" type="file" accept=".json,application/json" aria-label="Upload WiGLE JSON" hidden />
          <div id="wigleUploadFeedback" class="form-message" role="status" aria-live="polite"></div>
          <div class="wigle-upload-toolbar" aria-label="Hooking downloads"><a class="btn ghost tiny" href="/downloads/hooking-probe-1.3.1-debug.apk" download>Hooking Android app</a><a class="btn ghost tiny" href="/downloads/hooking-source.zip" download>Scenario builder &amp; guide</a><a class="btn ghost tiny" href="/downloads/demo-scenario.json" download>Demo scenario</a><a class="btn ghost tiny" href="/downloads/validation.txt" target="_blank" rel="noopener">Validation report</a></div>
          <div id="wigleUploads" class="wigle-uploads" hidden>
            <label for="wigleUploadSelect">Saved datasets</label><select id="wigleUploadSelect"></select>
            <div id="wigleUploadMetadata"></div>
            <div id="wigleUploadDetailFeedback" class="form-message" role="status" aria-live="polite"></div>
            <div class="wigle-upload-toolbar"><button id="wigleUploadDownload" type="button" class="btn ghost tiny" disabled>Download for Hooking</button><span class="meta">All saved observations. Combine with your route to build a Hooking scenario.</span></div>
            <div id="wigleUploadFilters" class="wigle-upload-filters" hidden><label for="wigleUploadKind">Observations</label><select id="wigleUploadKind"><option value="ALL">All observations</option><option value="WIFI">Wi-Fi</option><option value="BLUETOOTH">Bluetooth</option><option value="CELL">Cells</option></select></div>
            <div id="wigleUploadRecords" role="region" aria-label="Uploaded WiGLE observations" tabindex="0"></div>
            <div id="wigleUploadPagination" class="wigle-upload-pagination" hidden><button id="wigleUploadPrevious" class="btn ghost icon-button" type="button" title="Previous observations" aria-label="Previous observations">${icon("arrow-left")}</button><span id="wigleUploadPage" class="meta" role="status"></span><button id="wigleUploadNext" class="btn ghost icon-button" type="button" title="Next observations" aria-label="Next observations">${icon("chevron-right")}</button></div>
          </div>
          <div id="environmentSavedData"></div>
        </details>
        <dl id="environmentCapabilities" class="environment-fields environment-capabilities" aria-label="Operational status">
          <dt>GPS metadata</dt><dd>Not documented by API</dd>
          <dt>Sensors</dt><dd>Not documented by API</dd>
          <dt>Network mode</dt><dd>Unknown; not changed</dd>
          <dt>Network / DNS</dt><dd>Not verified</dd>
          <dt>Cell injection</dt><dd>Disabled</dd>
          <dt>Bluetooth</dt><dd>Nearby observations only; identity unchanged</dd>
        </dl>
        <details id="environmentAccepted" hidden>
          <summary id="environmentAcceptedSummary">Last API-accepted profile</summary>
          <div id="environmentAcceptedVerification" aria-label="Last accepted environment readback"></div>
          <div id="environmentAcceptedProfile"></div>
        </details>
      </section>
      </section>
      <section id="panel-history" class="inspector-panel" data-inspector-panel="history" role="tabpanel" aria-labelledby="tab-history" hidden><div id="detailHistory"></div></section>
    `;
  }
  $("detailHeading").innerHTML = `
    <div class="section-heading inspector-title"><h2>${escapeHtml(d.name || d.imageId)}</h2>${statusHtml(deviceStatus("activity", d))}</div>
    <div class="meta">${escapeHtml(d.imageId)}</div>
  `;
  updateRadiusEditor(d);
  updateAnchorEditor(d);
  updateEnvironmentEditor(d);
  updateMovementControls(d);
  setInspectorTab(state.inspectorTabs.get(d.id) || "overview", false);
  if (changedDevice) {
    const focusId = state.detailFocus.get(d.id) || state.radiusDrafts.get(d.id)?.focusId;
    if (focusId && $(focusId)?.getClientRects().length) $(focusId).focus({ preventScroll: true });
  }
  const ticks = (state.snapshot.ticks[d.id] || []).slice().reverse();
  const spark = ticks.slice(-24);
  const ev = (state.snapshot.events || []).filter((e) => e.deviceId === d.id);
  const location = deviceStatus("location", d);
  const wifi = deviceStatus("wifi", d);
  const controller = deviceStatus("controller", d);
  const gpsTimelineOpen = !changedDevice && Boolean($("gpsRequestTimeline")?.open);
  $("detailTelemetry").innerHTML = `
    <div class="section-heading"><h3>Device status</h3><div class="environment-actions"><button type="button" class="btn ghost icon-button" id="checkPowerNow" aria-label="Check power now" title="Check power now">${icon("refresh-cw")}</button><button type="button" class="btn ghost icon-button" id="copyDeviceSnapshot" aria-label="Copy device snapshot" title="Copy device snapshot">${icon("copy")}</button></div></div><div id="powerCheckFeedback" class="form-message" role="status" aria-live="polite"></div><div id="overviewFeedback" class="form-message" role="status"></div>
    <dl class="environment-fields overview-fields"><dt>Power check</dt><dd>${age(d.lastPowerSyncAt)}</dd><dt>Wi-Fi</dt><dd>${statusHtml(wifi)}<span class="meta">${escapeHtml(wifi.reason)}</span></dd><dt>Controller</dt><dd>${statusHtml(controller)}<span class="meta">${escapeHtml(controller.reason)}</span></dd><dt>Movement</dt><dd>${escapeHtml(d.phase === "NAVIGATING" ? d.transitMode === "drive" ? "Driving" : "Walking" : d.phase === "STATIONARY" ? "Stationary" : d.phase || "Unknown")}</dd><dt>Radius</dt><dd>${fmt(movementRadius(d), 0)} m</dd></dl>
    <div class="section-heading"><h3>Android location check</h3><button type="button" class="btn ghost" id="checkPhoneLocation">Check phone GPS</button></div>
    <div id="phoneLocationFeedback" class="form-message" role="status" aria-live="polite"></div>
    <div class="meta">Reads Android's last location. Open Maps on the phone to request a fresh fix. This check does not move the phone.</div>
    ${d.playerVerificationSupported ? '<div class="section-heading"><h3>Installed player</h3><button type="button" class="btn ghost" id="verifyPlayer">Verify player APK</button></div><div id="playerVerificationFeedback" class="form-message" role="status" aria-live="polite"></div>' : ''}
    <div class="section-heading"><h3>Controller coordinates</h3>${statusHtml(location)}</div>
    <div class="metrics">
      <div class="metric"><span>Model latitude</span><b>${fmt(d.currentLat, 6)}</b></div>
      <div class="metric"><span>Model longitude</span><b>${fmt(d.currentLng, 6)}</b></div>
    </div>
    <div class="meta">${escapeHtml(location.reason)}</div>
    <dl class="environment-fields"><dt>Model updated</dt><dd>${age(d.lastTickAt)}</dd><dt>Campaign remaining</dt><dd>${daysLeft(d.campaignEnd).toFixed(1)} days</dd></dl>
    ${gpsEvidenceHtml(d)}
    <div class="section-heading"><h3>Legacy automation</h3><button type="button" class="btn ghost" id="manageRpaJobs">Review jobs</button></div>
    <div class="section-heading"><h3>Source boundaries</h3></div><dl class="environment-fields"><dt>WiGLE</dt><dd>Historical observations</dd><dt>SIM / cell / Bluetooth</dt><dd>Local metadata; not verified on device</dd><dt>Network / DNS</dt><dd>Not verified</dd></dl>
    <div class="section-heading"><h3>Device profile</h3></div><dl class="environment-fields"><dt>Proxy source</dt><dd>Stored proxy lookup; not measured device egress</dd><dt>Proxy IP</dt><dd>${escapeHtml(d.proxyIp || "Unknown")}</dd><dt>Proxy ISP</dt><dd>${escapeHtml(d.proxyIsp || "Unknown")}</dd><dt>Proxy ASN</dt><dd>${escapeHtml(d.proxyAsn || "Unknown")}</dd><dt>Proxy lookup time</dt><dd>Unavailable</dd><dt>SIM source</dt><dd>DuoPlus /info at preview</dd><dt>Preview MCC / MNC</dt><dd>${escapeHtml(d.environment?.profile?.sim?.mcc || "Unknown")} / ${escapeHtml(d.environment?.profile?.sim?.mnc || "Unknown")}</dd><dt>SIM preview time</dt><dd>${environmentTime(d.environment?.preparedAt)}</dd></dl>
  `;
  if ($("gpsRequestTimeline")) $("gpsRequestTimeline").open = gpsTimelineOpen;
  $("detailHistory").innerHTML = `
    <div class="section-heading"><h3>Model telemetry</h3></div><div class="metrics">
      <div class="metric"><span>Model speed</span><b>${fmt(d.lastSpeedMps, 3)} m/s</b></div>
      <div class="metric"><span>Model accuracy</span><b>${fmt(d.lastAccuracyM, 1)} m</b></div>
      <div class="metric"><span>Model bearing</span><b>${fmt(d.lastBearing, 1)}°</b></div>
      <div class="metric"><span>Model altitude</span><b>${fmt(d.lastAltitudeM, 1)} m</b></div>
    </div>
    <div class="play">
      <span class="meta">Model playback</span>
      <input id="playScrub" type="range" aria-label="Model history playback" min="0" max="${Math.max(ticks.length - 1, 0)}" value="${state.playIndex ?? Math.max(ticks.length - 1, 0)}" />
    </div>
    <div class="meta">Model accuracy · last ${spark.length} ticks</div>
    <div class="heatstrip" title="Model accuracy over time">${heatStrip(spark)}</div>
    <div class="meta">Model speed history</div>
    <svg viewBox="0 0 240 36" width="100%" height="36" aria-label="Model speed sparkline">
      ${sparkline(spark.map((t) => t.speedMps), 240, 36)}
    </svg>
    <table class="ticks">
      <caption>Model history</caption>
      <thead><tr><th>Time</th><th>Model speed</th><th>Model accuracy</th><th>Model bearing</th></tr></thead>
      <tbody>
        ${ticks.slice(-10).reverse().map((t) => `<tr><td>${age(t.createdAt)}</td><td>${fmt(t.speedMps, 2)}</td><td>${fmt(t.accuracyM, 1)}</td><td>${fmt(t.bearing, 0)}</td></tr>`).join("")}
      </tbody>
    </table>
    <div class="section-heading"><h3>Controller events</h3></div><div class="timeline">${ev.slice(-10).map((e) => `<div class="tl"><span>${age(e.createdAt)}</span><b>${escapeHtml(e.kind)}</b><span>${escapeHtml(e.detail)}</span></div>`).join("") || "<div class='meta'>No controller events.</div>"}</div>
  `;
  updateCopyStatus(d);
}

function updateCopyStatus(device) {
  if (!$("overviewFeedback")) return;
  const operation = movementOperation(device);
  $("copyDeviceSnapshot").disabled = Boolean(operation.copyPending);
  $("checkPowerNow").disabled = Boolean(operation.powerPending);
  $("checkPowerNow").setAttribute("aria-busy", String(Boolean(operation.powerPending)));
  $("checkPowerNow").innerHTML = icon(operation.powerPending ? "loader-circle" : "refresh-cw");
  if ($("verifyPlayer")) {
    $("verifyPlayer").disabled = Boolean(operation.playerPending);
    $("verifyPlayer").setAttribute("aria-busy", String(Boolean(operation.playerPending)));
    formMessage("playerVerificationFeedback", operation.playerPending ? "Reading installed APK and player status..." : operation.playerMessage || "No player verification performed in this session.", Boolean(operation.playerError));
  }
  $("checkPhoneLocation").disabled = Boolean(operation.gpsPending || device.activeTripId);
  $("checkPhoneLocation").setAttribute("aria-busy", String(Boolean(operation.gpsPending)));
  formMessage("phoneLocationFeedback", operation.gpsPending ? "Reading Android location..." :
    device.activeTripId ? "Use the Driving panel for this trip's phone readback." : operation.gpsMessage || "No check performed in this session.", Boolean(operation.gpsError));
  formMessage("powerCheckFeedback", operation.powerPending ? "Checking DuoPlus power status..." : operation.powerMessage || "", Boolean(operation.powerError));
  $("overviewFeedback").textContent = operation.copyMessage || "";
  $("overviewFeedback").hidden = !operation.copyMessage;
  $("overviewFeedback").classList.toggle("error", Boolean(operation.copyError));
}

async function checkPhoneLocation(device) {
  const operation = movementOperation(device);
  if (operation.gpsPending || device.activeTripId) return;
  const sessionVersion = state.sessionVersion;
  operation.gpsPending = true;
  operation.gpsMessage = "";
  operation.gpsError = false;
  updateCopyStatus(device);
  try {
    const result = await api(`/devices/${encodeURIComponent(device.id)}/location/check`, { method: "POST", body: JSON.stringify({}) });
    if (sessionVersion !== state.sessionVersion) return;
    const fix = result.observation;
    if (result.deviceId !== device.id || !fix || !["OBSERVED", "UNKNOWN"].includes(fix.state) || typeof fix.reason !== "string" ||
        !Number.isFinite(Date.parse(fix.checkedAt))) throw new Error("The phone returned an invalid location check.");
    operation.phoneReadback = { deviceId: device.id, imageId: device.imageId, observation: fix };
    operation.gpsError = fix.state !== "OBSERVED";
    operation.gpsMessage = `Checked ${new Date(fix.checkedAt).toLocaleString()}. ${fix.reason}`;
    if (fix.state === "OBSERVED" && fix.point) {
      operation.gpsMessage += ` ${fix.provider}: ${fmt(fix.point.lat, 6)}, ${fmt(fix.point.lng, 6)}; fix age ${fmt(fix.ageMs / 1000, 1)} s at check time.`;
    }
  } catch (error) {
    if (sessionVersion === state.sessionVersion) { operation.gpsMessage = error.message; operation.gpsError = true; }
  } finally {
    if (sessionVersion === state.sessionVersion) {
      operation.gpsPending = false;
      if (selectedDevice()?.id === device.id) renderDetail();
      if (state.snapshot) renderMap(state.snapshot);
    }
  }
}

async function verifyPlayer(device) {
  const operation = movementOperation(device);
  if (operation.playerPending) return;
  const sessionVersion = state.sessionVersion;
  operation.playerPending = true;
  operation.playerError = false;
  updateCopyStatus(device);
  try {
    const result = await api(`/devices/${encodeURIComponent(device.id)}/player/verify`, { method: "POST", body: JSON.stringify({}) });
    if (sessionVersion !== state.sessionVersion) return;
    if (result.deviceId !== device.id || result.imageId !== device.imageId || result.readOnly !== true || !result.player?.connected) throw new Error("Player inspection returned an invalid identity.");
    operation.phoneReadback = { deviceId: device.id, imageId: device.imageId, observation: result.observation };
    const installed = result.installed;
    operation.playerError = !installed || !installed.matchesUploadedApk;
    operation.playerMessage = `Checked ${new Date(result.checkedAt).toLocaleString()}. ` +
      (installed ? `${installed.packageName} ${installed.versionName}: ${installed.matchesUploadedApk ? "SHA-256 matches your uploaded APK" : "SHA-256 differs from your uploaded APK"}. ` : "Installed APK could not be identified. ") +
      `Player ${result.player.state}; cleanup ${result.player.cleanupOk ? "confirmed" : "unconfirmed"}. ` +
      `${result.observation?.reason || result.locationError || "Location unavailable."} Wi-Fi, cell and Bluetooth were not observed.`;
  } catch (error) {
    if (sessionVersion === state.sessionVersion) { operation.playerMessage = error.message; operation.playerError = true; operation.phoneReadback = null; }
  } finally {
    if (sessionVersion === state.sessionVersion) {
      operation.playerPending = false;
      if (selectedDevice()?.id === device.id) renderDetail();
      if (state.snapshot) renderMap(state.snapshot);
    }
  }
}

async function checkPowerNow(device) {
  const operation = movementOperation(device);
  if (operation.powerPending) return;
  const sessionVersion = state.sessionVersion;
  operation.powerPending = true;
  operation.powerMessage = "";
  operation.powerError = false;
  updateCopyStatus(device);
  try {
    const result = await api(`/devices/${encodeURIComponent(device.id)}/power/check`, { method: "POST", body: JSON.stringify({}) });
    if (sessionVersion !== state.sessionVersion) return;
    const checked = result.device;
    if (!checked || checked.id !== device.id || typeof checked.poweredOn !== "boolean" || !Number.isInteger(checked.duoPlusStatus) ||
        !checked.lastPowerSyncAt || !Number.isFinite(new Date(checked.lastPowerSyncAt).getTime())) throw new Error("DuoPlus returned an invalid power result.");
    state.snapshotVersion += 1;
    const current = state.snapshot?.devices.find((item) => item.id === device.id);
    if (current) {
      const savedTime = current.lastPowerSyncAt ? new Date(current.lastPowerSyncAt).getTime() : NaN;
      if (!Number.isFinite(savedTime) || new Date(checked.lastPowerSyncAt).getTime() >= savedTime) {
        for (const key of ["poweredOn", "duoPlusStatus", "lastPowerSyncAt", "lastSeenOnAt"]) current[key] = checked[key] ?? null;
      }
      operation.powerMessage = `Power checked. ${deviceStatus("power", current).label}.`;
    }
  } catch (error) {
    if (sessionVersion === state.sessionVersion) { operation.powerMessage = error.message; operation.powerError = true; }
  } finally {
    if (sessionVersion === state.sessionVersion) {
      operation.powerPending = false;
      if (selectedDevice()?.id === device.id) renderDetail();
      if (state.snapshot) { renderFleet(state.snapshot); renderMap(state.snapshot); }
    }
  }
}

function gpsEvidence(device) {
  const value = device?.locationTelemetry;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { request: null, acceptance: null, observation: null };
  const text = (value) => typeof value === "string" && value.trim() ? value : null;
  const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const coordinates = (lat, lng) => typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90 && typeof lng === "number" && Number.isFinite(lng) && Math.abs(lng) <= 180 ? { lat, lng } : null;
  const time = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
  const statuses = ["REQUESTED", "DISPATCHED", "API_ACCEPTED", "API_REJECTED", "UNCONFIRMED", "FAILED", "SKIPPED", "DRY_RUN"];
  const status = statuses.includes(value.status) ? value.status : "UNKNOWN";
  const request = {
    id: text(value.id), source: text(value.source), status,
    evidenceLevel: ["REQUESTED", "API_ACCEPTED", "ANDROID_OBSERVED"].includes(value.evidenceLevel) ? value.evidenceLevel : null,
    coordinates: coordinates(value.lat, value.lng),
    requestedAt: time(value.requestedAt), dispatchedAt: time(value.dispatchedAt),
    completedAt: time(value.completedAt), acceptedAt: time(value.acceptedAt), observedAt: time(value.observedAt),
    dispatchIntervalMs: number(value.dispatchIntervalMs), queueDelayMs: number(value.queueDelayMs), apiLatencyMs: number(value.apiLatencyMs),
    error: text(value.error),
  };
  const acceptance = {
    source: "Controller request lifecycle; not Android observation",
    requestId: request.id, status, accepted: status === "API_ACCEPTED" ? true : status === "API_REJECTED" ? false : null,
    dispatchedAt: request.dispatchedAt, acceptedAt: status === "API_ACCEPTED" ? request.acceptedAt : null,
    completedAt: request.completedAt, error: request.error,
  };
  const captured = value.androidObservation;
  const observation = captured && typeof captured === "object" && !Array.isArray(captured) ? {
    source: ["MANUAL_ADB", "DIAGNOSTIC_APK"].includes(captured.source) ? captured.source : "UNKNOWN",
    capturedAt: time(captured.capturedAt), coordinates: coordinates(captured.lat, captured.lng),
    fixElapsedRealtimeMs: number(captured.fixElapsedRealtimeMs), deviceElapsedRealtimeMs: number(captured.deviceElapsedRealtimeMs),
    fixAgeMs: number(captured.fixAgeMs), distanceFromRequestedM: number(captured.distanceFromRequestedM),
    horizontalAccuracyM: number(captured.horizontalAccuracyM),
    hasSpeed: typeof captured.hasSpeed === "boolean" ? captured.hasSpeed : null,
    speedMps: captured.hasSpeed === true ? number(captured.speedMps) : null,
    speedAccuracyMps: captured.hasSpeed === true ? number(captured.speedAccuracyMps) : null,
    correlation: captured.correlation === "TEMPORAL_ONLY" ? "TEMPORAL_ONLY" : null,
    scope: "Reported Android observation; correlation to this request is not established by timestamps alone",
  } : null;
  return { request, acceptance, observation };
}

function gpsEvidenceTime(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Not recorded";
  const date = new Date(value);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toLocaleString())}</time>`;
}

function gpsEvidenceHtml(device) {
  const { request, acceptance, observation } = gpsEvidence(device);
  const statuses = { REQUESTED: "Requested", DISPATCHED: "Dispatched; acceptance pending", API_ACCEPTED: "API accepted", API_REJECTED: "API rejected", UNCONFIRMED: "Outcome unconfirmed", FAILED: "Request failed", SKIPPED: "Skipped; not sent", DRY_RUN: "Dry run; not sent", UNKNOWN: "Unknown request state" };
  const point = (value) => value ? `${fmt(value.lat, 6)}, ${fmt(value.lng, 6)}` : "Not recorded";
  const elapsed = (value) => value === null ? "Not recorded" : `${fmt(value, 0)} ms`;
  const observedSource = observation?.source === "MANUAL_ADB" ? "Manual ADB capture" : observation?.source === "DIAGNOSTIC_APK" ? "Diagnostic APK capture" : "Unknown capture source";
  const observationTiming = observation ? `<dt>Fix age at capture</dt><dd>${elapsed(observation.fixAgeMs)}</dd><dt>Offset from request</dt><dd>${observation.distanceFromRequestedM === null ? "Not recorded" : `${fmt(observation.distanceFromRequestedM, 1)} m`}</dd><dt>Correlation</dt><dd>${observation.correlation === "TEMPORAL_ONLY" ? "Temporal only; causality not established" : "Not established"}</dd>` : "";
  const accepted = acceptance?.accepted === true ? `Accepted by API<span class="meta">${gpsEvidenceTime(acceptance.acceptedAt)}</span>` : acceptance?.accepted === false ? "Rejected by API" : "Not confirmed";
  return `<div class="section-heading"><h3>GPS evidence</h3></div><dl id="gpsEvidence" class="environment-fields"><dt>Latest request</dt><dd>${request ? escapeHtml(statuses[request.status]) : "Not recorded"}${request?.coordinates ? `<span class="meta">${point(request.coordinates)}</span>` : ""}</dd><dt>API acceptance</dt><dd>${accepted}</dd><dt>Android location</dt><dd>${observation ? point(observation.coordinates) : "Not observed"}${observation ? `<span class="meta">${escapeHtml(observedSource)}</span><span class="meta">Captured ${gpsEvidenceTime(observation.capturedAt)}</span>` : ""}</dd></dl>
    ${request ? `<details id="gpsRequestTimeline"><summary>Latest GPS request</summary><dl class="environment-fields"><dt>Request ID</dt><dd><code>${escapeHtml(request.id || "Unknown")}</code></dd><dt>Request source</dt><dd>${escapeHtml(request.source || "Unknown")}</dd><dt>Requested</dt><dd>${gpsEvidenceTime(request.requestedAt)}</dd><dt>Dispatched</dt><dd>${gpsEvidenceTime(request.dispatchedAt)}</dd><dt>API accepted</dt><dd>${acceptance.accepted === true ? gpsEvidenceTime(acceptance.acceptedAt) : "Not confirmed"}</dd><dt>Completed</dt><dd>${gpsEvidenceTime(request.completedAt)}</dd><dt>Dispatch interval</dt><dd>${elapsed(request.dispatchIntervalMs)}</dd><dt>Queue delay</dt><dd>${elapsed(request.queueDelayMs)}</dd><dt>API latency</dt><dd>${elapsed(request.apiLatencyMs)}</dd>${request.error ? `<dt>Request error</dt><dd>${escapeHtml(request.error)}</dd>` : ""}${observation ? `<dt>Fix elapsed time</dt><dd>${elapsed(observation.fixElapsedRealtimeMs)}</dd><dt>Device elapsed time</dt><dd>${elapsed(observation.deviceElapsedRealtimeMs)}</dd>${observationTiming}<dt>Horizontal accuracy</dt><dd>${observation.horizontalAccuracyM === null ? "Not recorded" : `${fmt(observation.horizontalAccuracyM, 1)} m`}</dd><dt>Reported speed</dt><dd>${observation.hasSpeed === false ? "Absent from fix" : observation.speedMps === null ? "Not recorded" : `${fmt(observation.speedMps, 2)} m/s`}</dd><dt>Speed accuracy</dt><dd>${observation.speedAccuracyMps === null ? "Not recorded" : `${fmt(observation.speedAccuracyMps, 2)} m/s`}</dd>` : ""}</dl></details>` : ""}
    <p class="meta">API acceptance is not Android location evidence. Capture timestamps alone do not establish request correlation.</p>`;
}

async function copyDeviceSnapshot(device) {
  const operation = movementOperation(device);
  if (operation.copyPending) return;
  const sessionVersion = state.sessionVersion;
  const environment = device.environment;
  const currentVerification = environment?.verification?.revision === environment?.revision ? environment?.verification : null;
  const wifiFields = (wifi) => wifi ? { name: wifi.name ?? null, bssid: wifi.bssid ?? null, mac: wifi.mac ?? null, status: wifi.status ?? null } : null;
  const gps = gpsEvidence(device);
  const payload = {
    device: { id: device.id, imageId: device.imageId, name: device.name },
    controller: { source: "Controller model; not measured device GPS", active: device.active, phase: device.phase, modelCoordinates: { lat: device.currentLat, lng: device.currentLng }, anchor: { lat: device.anchorLat, lng: device.anchorLng }, movementRadiusM: movementRadius(device), modelUpdatedAt: device.lastTickAt || null },
    gpsRequest: gps.request,
    gpsAcceptance: gps.acceptance,
    gpsReadback: gps.observation,
    power: { source: "DuoPlus status", status: device.duoPlusStatus, checkedAt: device.lastPowerSyncAt || null },
    wifi: { source: "DuoPlus /info readback; connection not verified", revision: environment?.revision || null, acceptedAt: environment?.acceptedAt || null, acceptedRevision: environment?.acceptedVerification?.revision || null, submitted: wifiFields(currentVerification?.wifi?.expected), readback: wifiFields(currentVerification?.wifi?.observed), checkedAt: currentVerification?.wifi?.checkedAt || null },
    proxy: { source: "Stored proxy lookup; not measured device egress", ip: device.proxyIp || null, isp: device.proxyIsp || null, asn: device.proxyAsn || null, checkedAt: null },
    networkCodes: { source: "DuoPlus /info at preview", mcc: environment?.profile?.sim?.mcc || null, mnc: environment?.profile?.sim?.mnc || null, preparedAt: environment?.preparedAt || null },
  };
  operation.copyPending = true;
  operation.copyMessage = "";
  operation.copyError = false;
  updateCopyStatus(device);
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    if (sessionVersion === state.sessionVersion) operation.copyMessage = "Device snapshot copied.";
  } catch {
    if (sessionVersion === state.sessionVersion) { operation.copyMessage = "Could not copy the device snapshot."; operation.copyError = true; }
  } finally {
    if (sessionVersion === state.sessionVersion) { operation.copyPending = false; if (selectedDevice()?.id === device.id) updateCopyStatus(device); }
  }
}

function setInspectorTab(tab, remember = true) {
  if (!["overview", "movement", "driving", "environment", "history"].includes(tab)) return;
  const device = selectedDevice();
  if (remember && device) state.inspectorTabs.set(device.id, tab);
  $("detail").querySelectorAll("[data-inspector-tab]").forEach((button) => {
    const selected = button.dataset.inspectorTab === tab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $("detail").querySelectorAll("[data-inspector-panel]").forEach((panel) => { panel.hidden = panel.dataset.inspectorPanel !== tab; });
  document.body.dataset.inspector = tab;
  if (remember && device && tab === "movement") { updateRadiusEditor(device); updateAnchorEditor(device); updateMovementControls(device); }
  if (remember && device && tab === "environment") updateEnvironmentEditor(device);
  environmentExplorer?.update(device, tab === "environment");
  driving?.update(device, tab === "driving");
}

function anchorDraft(device) {
  let draft = state.anchorDrafts.get(device.id);
  if (!draft) {
    draft = { lat: String(device.anchorLat), lng: String(device.anchorLng), editing: false, placing: false, saving: false, error: "", saved: "" };
    state.anchorDrafts.set(device.id, draft);
  }
  if (!draft.editing && !draft.saving) {
    draft.lat = String(device.anchorLat);
    draft.lng = String(device.anchorLng);
  }
  return draft;
}

function anchorPoint(draft) {
  if (!draft.lat.trim() || !draft.lng.trim()) return null;
  const lat = Number(draft.lat), lng = Number(draft.lng);
  return coordinatePoint(lat, lng);
}

function displayedAnchor(device) {
  const draft = state.anchorDrafts.get(device.id);
  return device.id === state.selectedId && draft?.editing && anchorPoint(draft) || { lat: device.anchorLat, lng: device.anchorLng };
}

function updateAnchorEditor(device) {
  if (!$("anchorForm") || $("detail").dataset.deviceId !== device.id) return;
  const draft = anchorDraft(device);
  const point = anchorPoint(draft);
  $("anchorLat").value = draft.lat;
  $("anchorLng").value = draft.lng;
  for (const id of ["anchorLat", "anchorLng", "anchorPlace", "anchorCancel"]) $(id).disabled = Boolean(device.activeTripId) || !draft.editing || draft.saving;
  $("anchorEdit").hidden = draft.editing;
  $("anchorEdit").disabled = Boolean(device.activeTripId);
  $("anchorSave").disabled = Boolean(device.activeTripId) || !draft.editing || draft.saving || !point;
  $("anchorSave").innerHTML = `${icon(draft.saving ? "loader-circle" : "save")}${draft.saving ? "Saving..." : "Save anchor"}`;
  $("anchorPlace").classList.toggle("active", draft.placing);
  $("anchorForm").setAttribute("aria-busy", String(draft.saving));
  $("anchorFeedback").textContent = device.activeTripId ? "Trip in progress. Manage the trip in Driving." : draft.error || (draft.saving ? "Saving anchor..." : draft.placing ? "Choose an anchor on the map." : draft.editing && !point ? "Enter valid latitude and longitude." : draft.editing ? "Unsaved anchor. A saved change requires a new environment preview." : draft.saved);
  $("anchorFeedback").classList.toggle("error", Boolean(draft.error || draft.editing && !point));
}

async function saveAnchor() {
  const device = selectedDevice();
  if (!device) return;
  const draft = anchorDraft(device);
  const point = anchorPoint(draft);
  if (device.activeTripId || !draft.editing || draft.saving || !point) return;
  const sessionVersion = state.sessionVersion;
  draft.saving = true;
  draft.placing = false;
  draft.error = "";
  updateAnchorEditor(device);
  renderMap(state.snapshot);
  try {
    const result = await api(`/devices/${encodeURIComponent(device.id)}/anchor`, { method: "POST", body: JSON.stringify(point) });
    if (sessionVersion !== state.sessionVersion) return;
    state.snapshotVersion += 1;
    const current = state.snapshot?.devices.find((item) => item.id === device.id);
    if (current && result.device) Object.assign(current, result.device);
    if (current && result.locationRequest) current.locationTelemetry = result.locationRequest;
    draft.editing = false;
    draft.saved = result.gpsUpdate?.message || "Anchor saved locally. Device GPS is not verified.";
  } catch (error) {
    if (sessionVersion === state.sessionVersion) { state.snapshotVersion += 1; draft.error = error.message; }
  } finally {
    if (sessionVersion === state.sessionVersion) {
      draft.saving = false;
      if (selectedDevice()?.id === device.id) renderDetail();
      if (state.snapshot) renderMap(state.snapshot);
    }
  }
}

function movementOperation(device) {
  let operation = state.controlOperations.get(device.id);
  if (!operation) { operation = { pending: false, error: "", saved: "" }; state.controlOperations.set(device.id, operation); }
  return operation;
}

function updateMovementControls(device) {
  if (!$("movementToggle")) return;
  const operation = movementOperation(device);
  $("movementToggle").innerHTML = `${icon(device.active ? "pause" : "play")}${device.active ? "Pause controller" : "Resume controller"}`;
  $("detail").querySelectorAll("[data-act]").forEach((button) => { button.disabled = operation.pending || Boolean(device.activeTripId && button.dataset.act !== "focus"); });
  $("movementFeedback").textContent = device.activeTripId ? "Trip in progress. Manage the trip in Driving." : operation.error || (operation.pending ? "Saving movement settings..." : operation.saved);
  $("movementFeedback").classList.toggle("error", Boolean(operation.error));
  $("walkDestination").textContent = state.walkDest ? `${fmt(state.walkDest.lat, 5)}, ${fmt(state.walkDest.lng, 5)}` : "No destination selected";
  $("detail").querySelector('[data-act="nav"]').disabled = operation.pending || Boolean(device.activeTripId) || !state.walkDest;
}

function environmentOperation(device) {
  let operation = state.environmentOperations.get(device.id);
  if (!operation) {
    operation = { pending: null, error: "", errorAction: null, errorRevision: null, errorAcceptedAt: null, acceptedOpen: false, savedOpen: true };
    state.environmentOperations.set(device.id, operation);
  }
  return operation;
}

function environmentPowerReason(device) {
  if (device.activeTripId) return "Trip in progress. Manage arrival Wi-Fi in Driving.";
  if (device.active === false) return "Device is paused. Resume controller before preview or apply.";
  const connection = window.ObservatoryStatus?.connection?.(statusContext());
  if (!connection?.fresh) return connection?.reason || "Waiting for a fresh workspace snapshot.";
  return "";
}

function environmentAnchorChanged(device) {
  const profile = device.environment?.profile;
  return Boolean(profile && (profile.anchor?.lat !== device.anchorLat || profile.anchor?.lng !== device.anchorLng));
}

function environmentWifiReason(profile) {
  if (!profile?.deviceWifi) return "";
  if (profile.deviceWifi.status !== 1) return "Wi-Fi must already be enabled on this device. Prepare a new environment after checking its settings.";
  if (typeof profile.deviceWifi.mac !== "string" || !profile.deviceWifi.mac.trim()) return "The device Wi-Fi MAC is unavailable. Prepare a new environment after checking its settings.";
  return "";
}

function environmentRevisionAccepted(environment) {
  return environment?.revision != null && environment.acceptedVerification?.revision === environment.revision;
}

function environmentTime(value, includeAge = false) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now()) return "Unavailable";
  const days = Math.floor(Math.max(0, Date.now() - date.getTime()) / 86_400_000);
  const elapsed = days ? `${days} ${days === 1 ? "day" : "days"} ago` : age(value);
  return `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toLocaleString())}</time>${includeAge ? ` (${elapsed})` : ""}`;
}

function environmentWifiFieldsHtml(wifi) {
  if (!wifi) return '<span class="meta">Unavailable</span>';
  const status = wifi.status === 1 ? "Enabled" : wifi.status === 2 ? "Disabled" : "Unavailable";
  return `<strong>${escapeHtml(wifi.name ?? "Unavailable")}</strong><span>BSSID <code>${escapeHtml(wifi.bssid ?? "Unavailable")}</code></span><span>Device MAC <code>${escapeHtml(wifi.mac ?? "Unavailable")}</code></span><span>Wi-Fi ${status}</span>`;
}

function environmentVerificationHtml(verification, validatedStatus) {
  if (!verification) return '<dl class="environment-fields environment-readback"><dt>Wi-Fi readback</dt><dd class="meta">Not checked for this preview</dd></dl>';
  const wifi = verification.wifi;
  const labels = { NOT_APPLIED: "Not applied", PENDING: "Pending", VERIFIED: "Recorded match; historical result, not revalidated", MISMATCH: "Recorded mismatch in DuoPlus /info", UNAVAILABLE: "Unavailable" };
  const checkedState = ["VERIFIED", "MISMATCH"].includes(wifi?.status) ? validatedStatus : null;
  const label = checkedState?.label || labels[wifi?.status] || "Unavailable";
  const tone = checkedState?.tone || (wifi?.status === "MISMATCH" ? "bad" : "");
  const fields = [["name", "SSID"], ["bssid", "AP BSSID"], ["mac", "Device MAC"], ["status", "Wi-Fi"]];
  const fieldValue = (data, key) => data?.[key] == null ? "Unavailable" : key === "status" ? data[key] === 1 ? "Enabled" : data[key] === 2 ? "Disabled" : "Unavailable" : String(data[key]);
  const comparison = wifi?.expected || wifi?.observed ? `<table class="verification-table"><thead><tr><th>Field</th><th>Submitted</th><th>DuoPlus /info</th></tr></thead><tbody>${fields.map(([key, title]) => {
    const expected = fieldValue(wifi.expected, key), observed = fieldValue(wifi.observed, key);
    const normalize = (value) => ["mac", "bssid"].includes(key) ? value.toLowerCase() : value;
    const mismatch = wifi.expected && wifi.observed && normalize(expected) !== normalize(observed);
    return `<tr class="${mismatch ? "mismatch" : ""}"><th scope="row">${title}</th><td data-label="Submitted">${escapeHtml(expected)}</td><td data-label="DuoPlus /info">${escapeHtml(observed)}</td></tr>`;
  }).join("")}</tbody></table>` : "";
  return `<dl class="environment-fields environment-readback">
    <dt>Wi-Fi readback</dt><dd class="${tone}">${label}</dd>
    <dt>Checked</dt><dd>${environmentTime(wifi?.checkedAt)}</dd>
    <dt>Readback source</dt><dd>DuoPlus /info<span class="meta">Connection not verified</span></dd>
    ${wifi?.error ? `<dt>Readback detail</dt><dd>${escapeHtml(wifi.error)}</dd>` : ""}
    <dt>Cell readback</dt><dd>${verification.cell?.status === "ACCEPTED_UNVERIFIED" ? "Accepted by API; not verified" : "Not applied"}</dd>
  </dl>${comparison}`;
}

function environmentProfileHtml(profile) {
  if (!profile) return '<div class="meta">No prepared environment.</div>';
  const wifi = profile.wifi;
  const cell = profile.cell;
  return `<dl class="environment-fields">
    ${profile.source?.type === "UPLOAD" ? `<dt>Profile source</dt><dd>${profile.source.queriedAt ? "Saved WiGLE query" : "Saved WiGLE upload"}<span>${escapeHtml(profile.source.filename)}</span></dd><dt>Source saved</dt><dd>${environmentTime(profile.source.importedAt)}</dd><dt>Original query</dt><dd>${profile.source.queriedAt ? environmentTime(profile.source.queriedAt) : "Unknown"}</dd>` : ""}
    <dt>Anchor</dt><dd>${fmt(profile.anchor?.lat, 5)}, ${fmt(profile.anchor?.lng, 5)}</dd>
    <dt>Network codes</dt><dd>MCC ${escapeHtml(profile.sim?.mcc)} · MNC ${escapeHtml(profile.sim?.mnc)}</dd>
    ${profile.deviceWifi ? `<dt>Device Wi-Fi</dt><dd>${profile.deviceWifi.status === 1 ? "Enabled" : profile.deviceWifi.status === 2 ? "Disabled" : "Unavailable"}</dd><dt>Device MAC</dt><dd><code>${escapeHtml(profile.deviceWifi.mac || "Unavailable")}</code>${profile.deviceWifi.mac ? '<span class="meta">Preserved when applying Wi-Fi</span>' : ""}</dd>` : ""}
    <dt>Wi-Fi</dt><dd>${wifi ? `<strong>${escapeHtml(wifi.ssid || "Hidden SSID")}</strong><span>BSSID <code>${escapeHtml(wifi.bssid)}</code></span><span>${fmt(wifi.lat, 5)}, ${fmt(wifi.lng, 5)} · ${fmt(wifi.distanceM, 0)} m · QoS ${escapeHtml(wifi.qos)}</span><span>Last seen ${environmentTime(wifi.lastSeen, true)}</span>${wifi.lastUpdated !== undefined ? `<span>Last updated ${environmentTime(wifi.lastUpdated, true)}</span>` : ""}` : '<span class="meta">Unavailable: no Wi-Fi match</span>'}</dd>
    <dt>Cell updates</dt><dd>${cell ? `<strong>${escapeHtml(cell.radio || "Unknown radio")}</strong> · MCC ${escapeHtml(cell.mcc)} · MNC ${escapeHtml(cell.mnc)}<span>LAC ${escapeHtml(cell.lac)} · CID ${escapeHtml(cell.cid)}</span><span>${fmt(cell.lat, 5)}, ${fmt(cell.lng, 5)} · ${fmt(cell.distanceM, 0)} m</span>` : `<span class="meta">${escapeHtml(profile.cellSupport?.message || "Unsupported: cell mapping is unverified. Existing cell settings are preserved.")}</span>`}</dd>
    <dt>Connection</dt><dd class="meta">${escapeHtml(profile.connection?.message || "Wi-Fi configuration only; connection and coverage have not been verified. Network mode is unknown and is preserved.")}</dd>
  </dl>`;
}

function savedWigleTimestamp(value) {
  if (typeof value !== "string") return null;
  const parts = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!parts || Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) return null;
  const calendar = new Date(`${parts[1]}T00:00:00Z`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== parts[1] || !Number.isFinite(timestamp) || timestamp > Date.now()) return null;
  return new Date(timestamp).toISOString();
}

function savedWigleData(device) {
  if (device.wifiClusterJson == null || device.wifiClusterJson === "") return null;
  let cluster;
  try {
    if (typeof device.wifiClusterJson !== "string" || device.wifiClusterJson.length > 1_000_000) throw new Error();
    cluster = JSON.parse(device.wifiClusterJson);
    if (!cluster || typeof cluster !== "object" || Array.isArray(cluster) || !Array.isArray(cluster.nearby) || cluster.nearby.length > 1000) throw new Error();
  } catch {
    return { error: "Saved WiGLE data could not be read." };
  }
  const networks = [], seen = new Set();
  let invalid = 0;
  for (const [index, row] of [cluster.primary, ...cluster.nearby].entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row) || typeof row.ssid !== "string" || row.ssid.length > 100 ||
        typeof row.bssid !== "string" || !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(row.bssid) ||
        !Number.isFinite(row.lat) || Math.abs(row.lat) > 90 || !Number.isFinite(row.lng) || Math.abs(row.lng) > 180 ||
        !Number.isFinite(row.distanceM) || row.distanceM < 0 || !Number.isFinite(row.qos) || row.qos < 0 || row.qos > 7) {
      invalid++;
      continue;
    }
    const bssid = row.bssid.toLowerCase();
    if (seen.has(bssid)) continue;
    seen.add(bssid);
    networks.push({ ...row, bssid, selected: index === 0, lastupdt: savedWigleTimestamp(row.lastupdt) });
  }
  return {
    networks, invalid,
    queriedAt: savedWigleTimestamp(cluster.queriedAt),
    radiusM: Number.isFinite(cluster.radiusM) && cluster.radiusM > 0 ? cluster.radiusM : null,
  };
}

function savedWigleHtml(saved) {
  if (!saved) return '<p class="meta">No saved WiGLE search results.</p>';
  if (saved.error) return `<p class="bad">${escapeHtml(saved.error)}</p>`;
  return `<p class="meta">Historical observations. Device state unverified.</p>
    <dl class="environment-fields"><dt>Original query</dt><dd>${environmentTime(saved.queriedAt)}</dd><dt>Saved search radius</dt><dd>${saved.radiusM === null ? "Unavailable" : `${fmt(saved.radiusM, 0)} m`}</dd></dl>
    ${saved.invalid ? `<p class="bad">${saved.invalid} invalid ${saved.invalid === 1 ? "record omitted" : "records omitted"}.</p>` : ""}
    ${saved.networks.length ? `<ul class="saved-wigle-networks">${saved.networks.map((wifi) => `<li>
      <div class="saved-wigle-heading"><strong>${escapeHtml(wifi.ssid || "Hidden SSID")}</strong>${wifi.selected ? '<span class="meta">Saved selection</span>' : ""}</div>
      <code>${escapeHtml(wifi.bssid)}</code>
      <dl class="environment-fields"><dt>At query</dt><dd>${fmt(wifi.distanceM, 1)} m &middot; QoS ${escapeHtml(wifi.qos)}</dd><dt>Coordinates</dt><dd>${fmt(wifi.lat, 6)}, ${fmt(wifi.lng, 6)}</dd><dt>Last updated</dt><dd>${environmentTime(wifi.lastupdt, true)}</dd></dl>
    </li>`).join("")}</ul>` : '<p class="meta">No valid access-point records available.</p>'}`;
}

function savedWigleSearches(device) {
  const archives = Array.isArray(device.wigleArchives) && device.wigleArchives.length <= 1000 ? device.wigleArchives : [];
  const searches = [];
  for (const archive of archives) {
    if (!archive || typeof archive !== "object" || Array.isArray(archive) || archive.source !== "LOCAL_IMPORT") continue;
    const saved = savedWigleData({ wifiClusterJson: archive.clusterJson });
    if (!saved || saved.error || !saved.networks.length) continue;
    searches.push({ label: "Imported local query", saved, importedAt: savedWigleTimestamp(archive.importedAt) });
  }
  if (!searches.length) return null;
  const existing = savedWigleData(device);
  if (existing) searches.unshift({ label: "Saved query", saved: existing, importedAt: null });
  return searches;
}

function savedWigleSearchesHtml(searches) {
  return searches.map((search) => `<section class="saved-wigle-query">
    <div class="saved-wigle-heading"><h4>${escapeHtml(search.label)}</h4>${search.saved.networks ? `<span class="meta">${search.saved.networks.length} ${search.saved.networks.length === 1 ? "AP" : "APs"}</span>` : ""}</div>
    ${search.importedAt ? `<p class="meta">Imported ${environmentTime(search.importedAt)}</p>` : ""}
    ${savedWigleHtml(search.saved)}
  </section>`).join("");
}

function wigleUploadOperation(device) {
  const environment = environmentOperation(device);
  if (!environment.upload) environment.upload = { pending: false, error: "", message: "", selectedId: "", details: new Map(), detailPending: "", detailError: "", kind: "ALL", page: 0 };
  return environment.upload;
}

function wigleUploadSummaries(device) {
  return Array.isArray(device.wigleUploads) ? device.wigleUploads.filter((upload) => upload && typeof upload.id === "string" && typeof upload.filename === "string") : [];
}

function wigleUploadPage(upload, kind, page) {
  const records = Array.isArray(upload?.data?.records) ? upload.data.records.filter((record) => record && ["WIFI", "CELL", "BLUETOOTH"].includes(record.kind) && (kind === "ALL" || record.kind === kind)) : [];
  const pages = Math.max(1, Math.ceil(records.length / 25));
  const current = Math.max(0, Math.min(Number.isInteger(page) ? page : 0, pages - 1));
  return { records: records.slice(current * 25, (current + 1) * 25), page: current, pages, total: records.length };
}

function wigleUploadMetadataHtml(upload) {
  if (!upload) return "";
  const count = (value) => Number.isInteger(value) && value >= 0 ? value : 0;
  const data = upload.data;
  const queriedAt = upload.queriedAt || data?.queriedAt;
  const source = upload.source === "WIGLE_QUERY" ? "WiGLE API query" : upload.source === "UPLOAD" ? "Manual JSON upload" : "Saved WiGLE dataset";
  return `<dl class="environment-fields wigle-upload-metadata"><dt>State</dt><dd>Saved observations; application tracked separately</dd><dt>Source</dt><dd>${source}</dd><dt>Dataset</dt><dd>${escapeHtml(upload.filename)}</dd><dt>Saved</dt><dd>${environmentTime(upload.importedAt)}</dd><dt>Original query</dt><dd>${queriedAt ? environmentTime(queriedAt) : "Unknown"}</dd><dt>Saved records</dt><dd>${count(upload.wifiCount)} Wi-Fi &middot; ${count(upload.bluetoothCount)} Bluetooth &middot; ${count(upload.cellCount)} cells</dd>${upload.rejectedCount ? `<dt>Rejected records</dt><dd>${count(upload.rejectedCount)}</dd>` : ""}${upload.duplicateCount ? `<dt>Duplicate records</dt><dd>${count(upload.duplicateCount)}</dd>` : ""}${data?.page ? `<dt>Source response</dt><dd>${data.page.resultCount == null ? "Unknown" : `${count(data.page.resultCount)} returned`}${data.page.totalResults == null ? "" : ` / ${count(data.page.totalResults)} total`}${data.page.hasCursor ? '<span class="meta">More results may be available; not downloaded</span>' : ""}</dd>` : ""}</dl>${Array.isArray(data?.warnings) && data.warnings.length ? `<ul class="environment-warnings">${data.warnings.slice(0, 10).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}`;
}

function wigleUploadDownloadData(upload) {
  if (upload?.data?.version !== 1 || !Array.isArray(upload.data.records)) throw new Error("Load a saved upload before downloading it.");
  const basename = String(upload.filename || "observations").replace(/\\/g, "/").split("/").pop();
  const stem = basename.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 100) || "observations";
  // Export the complete saved GET wrapper, never the filtered or paginated table.
  // The Hooking compiler accepts this shape and preserves survey dates/fields.
  return { filename: `${stem}-hooking-upload.json`, text: JSON.stringify({ upload }, null, 2) + "\n" };
}

function downloadWigleUpload(device) {
  if (selectedDevice()?.id !== device.id || $("detail").dataset.deviceId !== device.id) return;
  const operation = wigleUploadOperation(device);
  const upload = operation.details.get(operation.selectedId);
  if (!upload || upload.id !== operation.selectedId || !wigleUploadSummaries(device).some((item) => item.id === upload.id)) return;
  let objectUrl;
  let anchor;
  try {
    const download = wigleUploadDownloadData(upload);
    objectUrl = URL.createObjectURL(new Blob([download.text], { type: "application/json;charset=utf-8" }));
    anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = download.filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    operation.detailError = "";
  } catch (error) {
    operation.detailError = "Saved observations could not be downloaded. Try again.";
  } finally {
    anchor?.remove();
    // Allow the browser to start consuming the Blob before releasing it.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    updateWigleUploads(device);
  }
}

function wigleUploadRecordsHtml(records, device) {
  if (!records.length) return '<p class="meta">No observations in this view.</p>';
  return `<ul class="wigle-upload-records">${records.map((record) => {
    const wifi = record.kind === "WIFI";
    const bluetooth = record.kind === "BLUETOOTH";
    const title = wifi ? record.ssid || "Hidden SSID" : bluetooth ? record.bluetooth?.name || record.ssid || "Unnamed Bluetooth" : record.radio || "Cell observation";
    const coordinates = coordinatePoint(record.lat, record.lng);
    const anchor = coordinatePoint(device.anchorLat, device.anchorLng);
    const distance = coordinates && anchor ? haversineUi(anchor.lat, anchor.lng, coordinates.lat, coordinates.lng) : null;
    const qos = Number.isInteger(record.qos) && record.qos >= 0 && record.qos <= 7 ? record.qos : "Unavailable";
    return `<li><div class="saved-wigle-heading"><strong>${escapeHtml(title)}</strong><span class="meta">${wifi ? "Wi-Fi" : bluetooth ? "Bluetooth reference only" : "Cell reference only"}</span></div><span class="wigle-upload-identifier">${wifi ? "BSSID" : bluetooth ? "Observed address" : "Cell identifier"} <code>${escapeHtml(record.identifier)}</code></span><dl class="environment-fields"><dt>Coordinates</dt><dd>${coordinates ? `${fmt(coordinates.lat, 6)}, ${fmt(coordinates.lng, 6)}` : "Unavailable"}</dd><dt>From anchor</dt><dd>${distance === null ? "Unavailable" : `${fmt(distance, 1)} m`}</dd><dt>QoS</dt><dd>${qos}</dd>${record.channel == null ? "" : `<dt>Channel</dt><dd>${escapeHtml(record.channel)}</dd>`}${record.encryption ? `<dt>Encryption</dt><dd>${escapeHtml(record.encryption)}</dd>` : ""}${!wifi && record.ssid ? `<dt>Reported name</dt><dd>${escapeHtml(record.ssid)}</dd>` : ""}<dt>First seen</dt><dd>${environmentTime(record.firstSeen)}</dd><dt>Last seen</dt><dd>${environmentTime(record.lastSeen)}</dd><dt>Last updated</dt><dd>${environmentTime(record.lastUpdated)}</dd>${record.attributes ? `<dt>Attributes</dt><dd>${escapeHtml(record.attributes)}</dd>` : ""}</dl></li>`;
  }).join("")}</ul>`;
}

function updateWigleUploads(device) {
  if (!$("wigleUploads") || $("detail").dataset.deviceId !== device.id) return;
  const operation = wigleUploadOperation(device);
  const summaries = wigleUploadSummaries(device);
  const buttonHtml = `${icon(operation.pending ? "loader-circle" : "plus")}${operation.pending ? "Uploading..." : "Upload JSON"}`;
  if ($("wigleUploadButton").innerHTML !== buttonHtml) $("wigleUploadButton").innerHTML = buttonHtml;
  $("wigleUploadButton").disabled = operation.pending;
  $("wigleUploadFile").disabled = operation.pending;
  $("wigleUploadFile").dataset.deviceId = device.id;
  $("wigleUploadFeedback").textContent = operation.error || (operation.pending ? "Saving WiGLE file..." : operation.message);
  $("wigleUploadFeedback").classList.toggle("error", Boolean(operation.error));
  $("wigleUploads").hidden = !summaries.length;
  const options = '<option value="">Select an uploaded file</option>' + summaries.map((upload) => `<option value="${escapeHtml(upload.id)}">${escapeHtml(upload.filename)} (${Number.isInteger(upload.wifiCount) ? upload.wifiCount : 0} Wi-Fi, ${Number.isInteger(upload.bluetoothCount) ? upload.bluetoothCount : 0} Bluetooth, ${Number.isInteger(upload.cellCount) ? upload.cellCount : 0} cells)</option>`).join("");
  if ($("wigleUploadSelect").innerHTML !== options) $("wigleUploadSelect").innerHTML = options;
  $("wigleUploadSelect").value = operation.selectedId;
  const detail = operation.details.get(operation.selectedId);
  const summary = summaries.find((upload) => upload.id === operation.selectedId);
  $("wigleUploadDownload").disabled = !summary || !detail || detail.id !== operation.selectedId || detail.data?.version !== 1 || !Array.isArray(detail.data.records);
  const metadata = wigleUploadMetadataHtml(detail || summary);
  if ($("wigleUploadMetadata").innerHTML !== metadata) $("wigleUploadMetadata").innerHTML = metadata;
  $("wigleUploadDetailFeedback").textContent = operation.detailError || (operation.detailPending === operation.selectedId && operation.selectedId ? "Loading saved observations..." : "");
  $("wigleUploadDetailFeedback").classList.toggle("error", Boolean(operation.detailError));
  $("wigleUploadFilters").hidden = !detail;
  $("wigleUploadKind").value = operation.kind;
  const page = wigleUploadPage(detail, operation.kind, operation.page);
  operation.page = page.page;
  const records = detail ? wigleUploadRecordsHtml(page.records, device) : "";
  if ($("wigleUploadRecords").innerHTML !== records) $("wigleUploadRecords").innerHTML = records;
  $("wigleUploadPagination").hidden = !detail || page.pages <= 1;
  $("wigleUploadPage").textContent = page.total ? `${page.page * 25 + 1}-${Math.min((page.page + 1) * 25, page.total)} of ${page.total}` : "0 observations";
  $("wigleUploadPrevious").disabled = page.page === 0;
  $("wigleUploadNext").disabled = page.page >= page.pages - 1;
}

async function loadWigleUpload(device, uploadId) {
  const operation = wigleUploadOperation(device);
  operation.selectedId = uploadId;
  operation.kind = "ALL";
  operation.page = 0;
  operation.detailError = "";
  if (!uploadId || operation.details.has(uploadId)) { updateWigleUploads(device); return; }
  if (!wigleUploadSummaries(device).some((upload) => upload.id === uploadId)) return;
  const sessionVersion = state.sessionVersion;
  operation.detailPending = uploadId;
  updateWigleUploads(device);
  try {
    const result = await api(`/devices/${encodeURIComponent(device.id)}/wigle/uploads/${encodeURIComponent(uploadId)}`);
    if (sessionVersion !== state.sessionVersion) return;
    if (result.upload?.id !== uploadId || !Array.isArray(result.upload?.data?.records)) throw new Error("Saved observations could not be read.");
    operation.details.set(uploadId, result.upload);
  } catch (error) {
    if (sessionVersion === state.sessionVersion && operation.selectedId === uploadId) operation.detailError = error.message;
  } finally {
    if (sessionVersion === state.sessionVersion) {
      if (operation.detailPending === uploadId) operation.detailPending = "";
      const selected = selectedDevice();
      if (selected?.id === device.id) updateWigleUploads(selected);
    }
  }
}

async function uploadWigleFile(device, file) {
  const operation = wigleUploadOperation(device);
  if (!file || operation.pending) return;
  const sessionVersion = state.sessionVersion;
  operation.pending = true;
  operation.error = "";
  operation.message = "";
  updateWigleUploads(device);
  try {
    if (!Number.isFinite(file.size) || file.size <= 0 || file.size > 1_048_576) throw new Error("Choose a non-empty JSON file no larger than 1 MiB.");
    if (!/\.json$/i.test(file.name)) throw new Error("Choose a WiGLE .json file.");
    const content = await file.text();
    if (sessionVersion !== state.sessionVersion || selectedDevice()?.id !== device.id) return;
    let data;
    try { data = JSON.parse(content); } catch { throw new Error("This file is not valid JSON."); }
    const result = await api(`/devices/${encodeURIComponent(device.id)}/wigle/uploads`, { method: "POST", body: JSON.stringify({ filename: file.name, data }) });
    if (sessionVersion !== state.sessionVersion) return;
    if (!result.upload?.id) throw new Error("The server did not confirm the saved file.");
    state.snapshotVersion += 1;
    const current = state.snapshot?.devices.find((item) => item.id === device.id);
    if (current) current.wigleUploads = [result.upload, ...wigleUploadSummaries(current).filter((upload) => upload.id !== result.upload.id)];
    const upload = result.upload;
    operation.message = `${result.duplicate ? "Already saved" : "Saved"}: ${upload.wifiCount} Wi-Fi, ${upload.bluetoothCount || 0} Bluetooth, ${upload.cellCount} cells.${upload.rejectedCount ? ` ${upload.rejectedCount} rejected.` : ""}${upload.duplicateCount ? ` ${upload.duplicateCount} duplicate records omitted.` : ""} Not applied to the device.`;
    operation.selectedId = upload.id;
    operation.kind = "ALL";
    operation.page = 0;
    environmentOperation(device).savedOpen = true;
    if (current) await loadWigleUpload(current, upload.id);
  } catch (error) {
    if (sessionVersion === state.sessionVersion) { state.snapshotVersion += 1; operation.error = error.message; }
  } finally {
    if (sessionVersion === state.sessionVersion) {
      operation.pending = false;
      const selected = selectedDevice();
      if (selected?.id === device.id) { updateWigleUploads(selected); environmentExplorer?.update(selected, state.inspectorTabs.get(selected.id) === "environment"); }
    }
  }
}

function environmentRecheckRevision(environment) {
  const verification = environment?.acceptedVerification;
  return typeof verification?.revision === "string" && verification.wifi?.expected && environment?.acceptedAt ? verification.revision : null;
}

function environmentNoticesHtml(warnings) {
  const limits = warnings.filter((warning) => /^(?:Cell updates are unavailable:|Network mode is not available)/.test(warning));
  const notices = warnings.filter((warning) => !limits.includes(warning));
  return `${notices.length ? `<ul class="environment-warnings">${notices.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>` : ""}${limits.length ? `<details class="meta"><summary>Platform limits (${limits.length})</summary><ul>${limits.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>` : ""}`;
}

function updateEnvironmentEditor(device) {
  if (!$("environmentSection") || $("detail").dataset.deviceId !== device.id) return;
  const operation = environmentOperation(device);
  const environment = device.environment;
  if (operation.error && (operation.errorRevision !== (environment?.revision ?? null) ||
      (environment?.status === "ACCEPTED" && operation.errorAcceptedAt !== environment.acceptedAt))) operation.error = "";
  const busy = Boolean(operation.pending || environment?.status === "APPLYING");
  const powerReason = environmentPowerReason(device);
  const anchorChanged = environmentAnchorChanged(device);
  const hasMatches = Boolean(environment?.profile?.wifi);
  const hasUnverifiedCell = Boolean(environment?.profile?.cell);
  const wifiReason = environmentWifiReason(environment?.profile);
  const alreadyAccepted = environmentRevisionAccepted(environment);
  const acceptedReason = alreadyAccepted && ["PREPARED", "FAILED"].includes(environment.status) ? "DuoPlus already accepted this revision. Prepare a new environment before applying again." : "";
  const alreadySent = Boolean(environment?.dispatchedAt);
  const dispatchedReason = alreadySent && ["PREPARED", "FAILED"].includes(environment.status) ? "This revision was already sent to DuoPlus. Prepare a new environment before applying again." : "";
  const applicable = environment?.revision != null && ["PREPARED", "FAILED"].includes(environment.status) && Boolean(environment.profile?.wifi) && !hasUnverifiedCell && !anchorChanged && !wifiReason && !alreadyAccepted && !alreadySent;
  const labels = { PREPARED: "Prepared", APPLYING: "Applying", ACCEPTED: "Accepted by API", FAILED: "Failed" };
  const status = operation.pending === "recheck" ? "Checking readback..." : operation.pending === "apply" || environment?.status === "APPLYING" ? "Applying" : operation.pending === "more" ? "Loading more Wi-Fi..." : operation.pending === "preview" ? "Preparing..." : operation.error ? "Last attempt failed" : labels[environment?.status] || "No preview";
  $("environmentStatus").textContent = status;
  $("environmentStatus").classList.toggle("ok", status === "Accepted by API");
  $("environmentStatus").classList.toggle("bad", ["Failed", "Last attempt failed"].includes(status));
  $("environmentSection").setAttribute("aria-busy", String(busy));
  $("environmentPreview").disabled = busy || Boolean(powerReason);
  $("environmentPreview").textContent = operation.pending === "preview" ? "Preparing preview..." : "Preview WiGLE environment";
  const search = environment?.profile?.search;
  $("environmentMore").hidden = !search?.nextCursor || Boolean(environment?.profile?.source);
  $("environmentMore").disabled = busy || Boolean(powerReason) || anchorChanged || hasUnverifiedCell;
  $("environmentMore").textContent = operation.pending === "more" ? "Loading more Wi-Fi..." : operation.error && operation.errorAction === "more" ? "Retry loading more Wi-Fi" : "Load more Wi-Fi";
  $("environmentSearchProgress").textContent = search ? `${search.pagesLoaded} ${search.pagesLoaded === 1 ? "page" : "pages"} · ${search.observationsLoaded} observations retrieved for a ${search.radiusM} m search. ${search.nextCursor ? "More results available. Load more fetches one page (up to 100 observations) and keeps the best Wi-Fi match found so far. A new preview restarts the search." : search.stopReason === "REPEATED_CURSOR" ? "Search stopped because WiGLE repeated its cursor. Start a new preview to retry." : "WiGLE returned no further page. These historical observations do not establish current coverage."}` : environment?.profile && !environment.profile.source ? "Prepare a new preview to start a resumable Wi-Fi search." : "";
  $("environmentApply").disabled = busy || Boolean(powerReason) || !applicable;
  $("environmentApply").textContent = operation.pending === "apply" || environment?.status === "APPLYING" ? "Applying..." : "Apply to ON device";
  $("environmentRecheck").hidden = !environmentRecheckRevision(environment);
  $("environmentRecheck").disabled = busy;
  const attempt = operation.errorAction === "more" ? "load more" : ["preview", "apply", "recheck"].includes(operation.errorAction) ? operation.errorAction : "environment";
  const error = operation.error ? `Last ${attempt} attempt failed: ${operation.error}` : environment?.error || "";
  const pendingMessage = operation.pending === "recheck" ? "Reading DuoPlus Wi-Fi configuration; no update is being sent..." : operation.pending === "more" ? "Holding movement while checking DuoPlus and loading one more Wi-Fi page..." : operation.pending === "preview" ? "Holding movement while checking DuoPlus and preparing preview..." : operation.pending === "apply" ? "Holding movement while checking DuoPlus and applying..." : "";
  $("environmentFeedback").textContent = pendingMessage || (anchorChanged ? "The anchor changed. Prepare a new environment." : hasUnverifiedCell ? "Cell injection is disabled: carrier ownership and radio-field mapping have not been verified." : acceptedReason || dispatchedReason || error || powerReason || wifiReason || (environment?.profile && !hasMatches ? "No eligible Wi-Fi match found in the retrieved observations." : ""));
  $("environmentFeedback").classList.toggle("bad", !pendingMessage && Boolean(error || anchorChanged || hasUnverifiedCell || wifiReason));
  const acceptanceLabel = environment?.acceptedAt && !alreadyAccepted ? "Last API acceptance" : "Accepted by API";
  const times = environment ? `<dl class="environment-fields environment-times"><dt>Prepared</dt><dd>${environmentTime(environment.preparedAt)}</dd><dt>${acceptanceLabel}</dt><dd>${environment.acceptedAt ? environmentTime(environment.acceptedAt) : "Not accepted"}</dd></dl>` : "";
  if ($("environmentTimes").innerHTML !== times) $("environmentTimes").innerHTML = times;
  const currentVerification = environment?.verification && environment.verification.revision === environment.revision ? environment.verification : null;
  const verification = environmentVerificationHtml(currentVerification, deviceStatus("wifi", device));
  if ($("environmentVerification").innerHTML !== verification) $("environmentVerification").innerHTML = verification;
  const profile = environmentProfileHtml(environment?.profile);
  if ($("environmentProfile").innerHTML !== profile) $("environmentProfile").innerHTML = profile;
  const warnings = environment?.profile?.warnings || [];
  const warningHtml = environmentNoticesHtml(warnings);
  if ($("environmentWarnings").innerHTML !== warningHtml) $("environmentWarnings").innerHTML = warningHtml;
  const saved = savedWigleData(device);
  const searches = savedWigleSearches(device);
  const uploadCount = Array.isArray(device.wigleUploads) ? device.wigleUploads.length : 0;
  const savedSearchCount = searches?.length || (saved ? 1 : 0);
  $("environmentSavedSummary").textContent = uploadCount ? `Saved WiGLE data (${savedSearchCount ? `${savedSearchCount} ${savedSearchCount === 1 ? "search" : "searches"}, ` : ""}${uploadCount} ${uploadCount === 1 ? "dataset" : "datasets"})` : searches ? `Saved WiGLE data (${searches.length} ${searches.length === 1 ? "search" : "searches"})` : `Saved WiGLE data${saved?.networks ? ` (${saved.networks.length} ${saved.networks.length === 1 ? "AP" : "APs"})` : ""}`;
  $("environmentSaved").open = operation.savedOpen;
  const savedHtml = searches ? savedWigleSearchesHtml(searches) : saved ? savedWigleHtml(saved) : uploadCount ? "" : environment?.profile?.wifi ? '<p class="meta">Only the selected AP was saved with this older preview. Full search results are unavailable.</p>' : savedWigleHtml(null);
  if ($("environmentSavedData").innerHTML !== savedHtml) $("environmentSavedData").innerHTML = savedHtml;
  updateWigleUploads(device);
  const showAccepted = Boolean(environment?.acceptedProfile && environment.status !== "ACCEPTED");
  $("environmentAccepted").hidden = !showAccepted;
  $("environmentAccepted").open = operation.acceptedOpen;
  const accepted = showAccepted ? environmentProfileHtml(environment.acceptedProfile) : "";
  if ($("environmentAcceptedProfile").innerHTML !== accepted) $("environmentAcceptedProfile").innerHTML = accepted;
  const acceptedVerification = showAccepted && environment.acceptedVerification ? environmentVerificationHtml(environment.acceptedVerification) : "";
  if ($("environmentAcceptedVerification").innerHTML !== acceptedVerification) $("environmentAcceptedVerification").innerHTML = acceptedVerification;
}

async function requestSavedEnvironment(device, record) {
  if (selectedDevice()?.id !== device.id || record?.kind !== "WIFI" || record.eligible !== true || typeof record.uploadId !== "string" || !Number.isInteger(record.recordIndex)) return;
  await requestEnvironment("preview", record);
}

async function requestEnvironment(action, savedRecord = null) {
  const device = selectedDevice();
  if (!device || !["preview", "more", "apply", "recheck"].includes(action)) return;
  const operation = environmentOperation(device);
  if (operation.pending || device.environment?.status === "APPLYING" || (action !== "recheck" && environmentPowerReason(device))) {
    updateEnvironmentEditor(device);
    return;
  }
  const environment = device.environment;
  if (action === "recheck" && !environmentRecheckRevision(environment)) return;
  if (action === "more" && (!environment?.revision || !environment.profile?.search?.nextCursor || environment.profile?.source || environment.profile?.cell || environmentAnchorChanged(device))) return;
  if (action === "apply" && (!environment || environment.revision == null || !["PREPARED", "FAILED"].includes(environment.status) || !environment.profile?.wifi || environment.profile?.cell || environmentAnchorChanged(device) || environmentWifiReason(environment.profile) || environmentRevisionAccepted(environment) || environment.dispatchedAt)) {
    updateEnvironmentEditor(device);
    return;
  }
  const sessionVersion = state.sessionVersion;
  operation.pending = action;
  operation.error = "";
  updateEnvironmentEditor(device);
  environmentExplorer?.render();
  try {
    const endpoint = action === "preview" && savedRecord ? "preview-saved" : action;
    const body = action === "recheck" ? { revision: environmentRecheckRevision(environment) } : action === "apply" || action === "more" ? { revision: environment.revision } : savedRecord ? { uploadId: savedRecord.uploadId, recordIndex: savedRecord.recordIndex } : {};
    const result = await api(`/devices/${encodeURIComponent(device.id)}/environment/${endpoint}`, {
      method: "POST", body: JSON.stringify(body),
    });
    if (sessionVersion !== state.sessionVersion) return;
    state.snapshotVersion += 1;
    const current = state.snapshot?.devices.find((item) => item.id === device.id);
    if (current) {
      current.environment = result.environment;
      if (Array.isArray(result.wigleUploads)) current.wigleUploads = result.wigleUploads;
      renderFleet(state.snapshot);
    }
  } catch (error) {
    if (sessionVersion === state.sessionVersion) {
      state.snapshotVersion += 1;
      operation.error = error.message;
      operation.errorAction = action;
      operation.errorRevision = environment?.revision ?? null;
      operation.errorAcceptedAt = environment?.acceptedAt ?? null;
    }
  } finally {
    if (sessionVersion === state.sessionVersion) {
      operation.pending = null;
      const selected = selectedDevice();
      if (selected?.id === device.id) {
        updateEnvironmentEditor(selected);
        environmentExplorer?.update(selected, state.inspectorTabs.get(selected.id) === "environment");
        if (savedRecord) $("environmentSection")?.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    }
  }
}

function movementRadius(device, snap = state.snapshot) {
  const radius = Number(device?.movementRadiusM);
  if (Number.isInteger(radius) && radius >= 1 && radius <= 100) return radius;
  const fallback = Number(snap?.health.boundM);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 15;
}

function parseRadius(value) {
  if (!value.trim()) return null;
  const radius = Number(value);
  return Number.isInteger(radius) && radius >= 1 && radius <= 100 ? radius : null;
}

function radiusDraft(device) {
  let draft = state.radiusDrafts.get(device.id);
  if (!draft) {
    draft = { value: String(movementRadius(device)), dirty: false, saving: false, error: "", saved: "", focusId: null };
    state.radiusDrafts.set(device.id, draft);
  }
  if (!draft.dirty && !draft.saving) {
    const savedValue = String(movementRadius(device));
    if (draft.value !== savedValue) draft.saved = "";
    draft.value = savedValue;
  }
  return draft;
}

function updateRadiusEditor(device) {
  if (!$("radiusForm") || $("detail").dataset.deviceId !== device.id) return;
  const draft = radiusDraft(device);
  const parsed = parseRadius(draft.value);
  const number = $("radiusNumber");
  const slider = $("radiusSlider");
  if (number.value !== draft.value) number.value = draft.value;
  const sliderValue = String(parsed ?? Math.max(1, Math.min(100, movementRadius(device))));
  if (slider.value !== sliderValue) slider.value = sliderValue;
  slider.setAttribute("aria-valuetext", `${sliderValue} meters`);
  number.disabled = draft.saving || Boolean(device.activeTripId);
  slider.disabled = draft.saving || Boolean(device.activeTripId);
  $("radiusSave").disabled = draft.saving || Boolean(device.activeTripId) || parsed === null || parsed === movementRadius(device);
  $("radiusSave").textContent = draft.saving ? "Saving..." : "Save";
  $("radiusForm").setAttribute("aria-busy", String(draft.saving));
  const invalid = draft.dirty && parsed === null;
  number.setAttribute("aria-invalid", String(invalid));
  $("radiusFeedback").textContent = draft.error || (invalid ? "Enter a whole number from 1 to 100." : draft.saved);
  $("radiusFeedback").classList.toggle("bad", Boolean(draft.error || invalid));
  $("radiusFeedback").classList.toggle("ok", Boolean(draft.saved && !draft.error && !invalid));
}

function updateRadiusLegend() {
  const device = selectedDevice();
  $("radiusLegend").textContent = device ? `${movementRadius(device)} m radius` : "Movement radius";
}

async function saveRadius() {
  const device = selectedDevice();
  if (!device) return;
  const draft = radiusDraft(device);
  const radiusM = parseRadius(draft.value);
  if (draft.saving || radiusM === null || radiusM === movementRadius(device)) return;
  const sessionVersion = state.sessionVersion;
  draft.saving = true;
  draft.error = "";
  draft.saved = "";
  updateRadiusEditor(device);
  try {
    const result = await api(`/devices/${encodeURIComponent(device.id)}/radius`, {
      method: "POST", body: JSON.stringify({ radiusM }),
    });
    if (sessionVersion !== state.sessionVersion) return;
    // Ignore snapshots requested before the saved configuration was acknowledged.
    state.snapshotVersion += 1;
    const savedDevice = state.snapshot?.devices.find((item) => item.id === device.id);
    const savedRadius = movementRadius(result.device);
    if (savedDevice) savedDevice.movementRadiusM = savedRadius;
    draft.value = String(savedRadius);
    draft.dirty = false;
    draft.saved = `Saved ${savedRadius} m`;
    if (state.snapshot) renderMap(state.snapshot);
  } catch (error) {
    if (sessionVersion === state.sessionVersion) draft.error = error.message;
  } finally {
    if (sessionVersion === state.sessionVersion) {
      draft.saving = false;
      const selected = selectedDevice();
      if (selected?.id === device.id) updateRadiusEditor(selected);
    }
  }
}

function sparkline(values, width = 240, height = 48) {
  if (!values.length) return "";
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * width;
      const y = height - 4 - ((v - min) / span) * (height - 8);
      return `${x},${y}`;
    })
    .join(" ");
  const color = max >= 0.75 ? "#ff6b7a" : "#3ee0c5";
  return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}" />`;
}

function upsertLayer(mapRef, key, factory, next) {
  let layer = mapRef.get(key);
  if (!layer) {
    layer = factory();
    layer.addTo(map);
    mapRef.set(key, layer);
  }
  next(layer);
}

function historyPreferences(snap) {
  const scope = JSON.stringify([snap.user?.tenantId || snap.user?.tenantName || "local", snap.user?.userId || snap.user?.email || "local"]);
  if (scope === state.historyScope) return;
  state.historyScope = scope;
  state.showHistory = false;
  state.historyCutoffs.clear();
  try {
    const saved = JSON.parse(localStorage.getItem(`obs-history-v1:${scope}`) || "null");
    state.showHistory = saved?.show === true;
    for (const entry of (Array.isArray(saved?.cutoffs) ? saved.cutoffs : []).slice(0, 1000)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && Number.isSafeInteger(entry[1]) && entry[1] >= 0 && entry[1] <= 8640000000000000) {
        state.historyCutoffs.set(entry[0], entry[1]);
      }
    }
  } catch { /* Display controls still work when browser storage is unavailable. */ }
  updateHistoryControls();
}

function saveHistoryPreferences() {
  if (!state.historyScope) return;
  try {
    localStorage.setItem(`obs-history-v1:${state.historyScope}`, JSON.stringify({
      show: state.showHistory, cutoffs: [...state.historyCutoffs].slice(-1000),
    }));
  } catch { /* Keep the current tab's preference even if persistence is blocked. */ }
}

function updateHistoryControls(message) {
  const toggle = $("showHistory");
  if (toggle) toggle.checked = state.showHistory;
  if ($("btnClearTrails")) $("btnClearTrails").disabled = !state.snapshot;
  if (message !== undefined && $("historyFeedback")) $("historyFeedback").textContent = message;
}

function clearMapTrails() {
  if (!state.snapshot) return;
  for (const device of state.snapshot.devices) {
    const latest = window.ObservatoryHistory?.latestTimestamp(state.snapshot.ticks[device.id] || []);
    if (Number.isFinite(latest)) state.historyCutoffs.set(device.id, Math.max(latest, state.historyCutoffs.get(device.id) || 0));
  }
  saveHistoryPreferences();
  renderMap(state.snapshot);
  updateHistoryControls("Trails cleared. New movement will appear when Show history is on. Saved history is kept.");
}

function renderMap(snap) {
  const seen = new Set();
  const selected = selectedDevice();
  updateCompass(selected);
  updateRadiusLegend();
  for (const d of snap.devices) {
    const isOn = window.ObservatoryStatus?.isFreshOn?.(d, statusContext()) || false;
    if (state.onOnly && !isOn && d.id !== state.selectedId) {
      for (const bucket of [state.markers, state.phoneMarkers, state.circles, state.trails, state.routes, state.anchors, state.heat]) {
        if (bucket.has(d.id)) {
          map.removeLayer(bucket.get(d.id));
          bucket.delete(d.id);
        }
      }
      continue;
    }
    const point = coordinatePoint(d.currentLat, d.currentLng);
    const candidateAnchor = displayedAnchor(d);
    const anchor = coordinatePoint(candidateAnchor.lat, candidateAnchor.lng);
    if (!point || !anchor) continue;
    seen.add(d.id);
    const prominent = isOn || d.id === state.selectedId;
    const phonePoint = window.ObservatoryPhoneReadback.freshPoint(d, state.controlOperations.get(d.id)?.phoneReadback);
    if (phonePoint) {
      upsertLayer(state.phoneMarkers, d.id,
        () => L.circleMarker([phonePoint.lat, phonePoint.lng], { radius: 10, color: "#8050c7", weight: 3, fillOpacity: 0.15 }),
        marker => {
          marker.setLatLng([phonePoint.lat, phonePoint.lng]);
          marker.bindPopup(`${escapeHtml(d.name || d.imageId)}<br/>Android readback (${escapeHtml(phonePoint.provider)})<br/>${fmt(phonePoint.lat, 6)}, ${fmt(phonePoint.lng, 6)}<br/>Mock: ${phonePoint.mock === null ? "unknown" : phonePoint.mock ? "yes" : "no"}<br/>Checked ${escapeHtml(new Date(phonePoint.checkedAt).toLocaleString())}`);
        });
    } else if (state.phoneMarkers.has(d.id)) {
      map.removeLayer(state.phoneMarkers.get(d.id)); state.phoneMarkers.delete(d.id);
    }
    upsertLayer(
      state.markers,
      d.id,
      () => L.marker([d.currentLat, d.currentLng], { icon: deviceIcon(d.phase) }),
      (m) => {
        m.setLatLng([d.currentLat, d.currentLng]);
        m.setIcon(
          prominent
            ? deviceIcon(d.phase)
            : L.divIcon({
                className: "",
                html: `<div style="width:7px;height:7px;border-radius:50%;background:#3a4a58;border:1px solid #071018"></div>`,
                iconSize: [7, 7],
                iconAnchor: [3, 3],
              }),
        );
        m.setOpacity(prominent ? 1 : 0.45);
        m.bindPopup(`${escapeHtml(d.name || d.imageId)}<br/>Controller coordinates<br/>${escapeHtml(deviceStatus("power", d).label)}`);
      },
    );
    upsertLayer(
      state.anchors,
      d.id,
      () =>
        L.marker([d.anchorLat, d.anchorLng], {
          draggable: false,
          icon: L.divIcon({
            className: "",
            html: `<div style="width:10px;height:10px;border-radius:50%;background:#406bc2;border:2px solid #fff"></div>`,
            iconSize: [10, 10],
            iconAnchor: [5, 5],
          }),
        }).on("drag", (ev) => {
          const draft = state.anchorDrafts.get(d.id);
          if (d.id !== state.selectedId || !draft?.editing || draft.saving) return;
          const c = state.circles.get(d.id);
          if (c) c.setLatLng(ev.latlng);
        }).on("dragend", (ev) => {
          const draft = state.anchorDrafts.get(d.id);
          if (d.id !== state.selectedId || !draft?.editing || draft.saving) return;
          const ll = ev.target.getLatLng();
          draft.lat = String(ll.lat);
          draft.lng = String(ll.lng);
          draft.placing = false;
          draft.error = "";
          updateAnchorEditor(d);
          renderMap(state.snapshot);
        }),
      (c) => {
        const draft = state.anchorDrafts.get(d.id);
        if (d.id === state.selectedId && draft?.editing && !draft.saving) c.dragging.enable();
        else c.dragging.disable();
        if (!c.dragging || !c.dragging._draggable || !c.dragging._draggable._moving) {
          c.setLatLng([anchor.lat, anchor.lng]);
        }
      },
    );
    upsertLayer(
      state.circles,
      d.id,
      () =>
        L.circle([d.anchorLat, d.anchorLng], {
          radius: movementRadius(d, snap),
          color: "#406bc2",
          weight: 2,
          fillColor: "#406bc2",
          fillOpacity: 0.08,
        }),
      (c) => {
        c.setLatLng([anchor.lat, anchor.lng]);
        c.setRadius(movementRadius(d, snap));
      },
    );

    const segments = state.showHistory ? window.ObservatoryHistory?.buildTrails(snap.ticks[d.id] || [], {
      clearBeforeMs: state.historyCutoffs.get(d.id),
    }).segments || [] : [];
    if (segments.length) {
      const layers = [
        { pts: segments, color: "#ffffff", weight: 5, opacity: 0.55 },
        { pts: segments, color: "#bc8420", weight: 3, opacity: 0.9 },
      ];
      upsertLayer(
        state.trails,
        d.id,
        () => L.layerGroup(layers.map((s) => L.polyline(s.pts, { color: s.color, weight: s.weight, opacity: s.opacity, lineJoin: "round", lineCap: "round" }))),
        (group) => {
          group.clearLayers();
          layers.forEach((s) =>
            group.addLayer(L.polyline(s.pts, { color: s.color, weight: s.weight, opacity: s.opacity, lineJoin: "round", lineCap: "round" })),
          );
        },
      );
    } else if (state.trails.has(d.id)) {
      map.removeLayer(state.trails.get(d.id));
      state.trails.delete(d.id);
    }

    if (d.phase === "NAVIGATING" && d.polylineJson) {
      try {
        const raw = JSON.parse(d.polylineJson);
        const points = Array.isArray(raw) ? raw.map((p) => coordinatePoint(Array.isArray(p) ? p[0] : p?.lat, Array.isArray(p) ? p[1] : p?.lng)) : [];
        if (points.length < 2 || points.some((point) => !point)) throw new Error("Route coordinates unavailable");
        const pts = points.map((point) => [point.lat, point.lng]);
        upsertLayer(
          state.routes,
          d.id,
          () => L.polyline(pts, { color: "#f0b429", weight: 3, dashArray: "6 6" }),
          (line) => line.setLatLngs(pts),
        );
      } catch {
        if (state.routes.has(d.id)) { map.removeLayer(state.routes.get(d.id)); state.routes.delete(d.id); }
      }
    } else if (state.routes.has(d.id)) {
      map.removeLayer(state.routes.get(d.id));
      state.routes.delete(d.id);
    }
  }

  for (const bucket of [state.markers, state.phoneMarkers, state.circles, state.trails, state.routes, state.anchors, state.heat]) {
    for (const [id, layer] of bucket) {
      if (!seen.has(id)) {
        map.removeLayer(layer);
        bucket.delete(id);
      }
    }
  }
}

const load = window.ObservatoryPolling.singleFlight(loadSnapshot, () => `${state.sessionVersion}:${state.snapshotVersion}`);

async function loadSnapshot() {
  if (state.authenticated === false) return;
  const sessionVersion = state.sessionVersion;
  const snapshotVersion = state.snapshotVersion;
  const requestId = ++state.snapshotRequestId;
  let snap;
  try { snap = await api("/api/snapshot"); }
  catch (error) {
    if (sessionVersion !== state.sessionVersion || state.authenticated === false || requestId < state.lastSnapshotResult) return;
    state.lastSnapshotResult = requestId;
    state.connectionError = error.message;
    renderConnection();
    if (state.snapshot) { renderFleet(state.snapshot); renderDetail(); renderMap(state.snapshot); }
    else $("fleetList").textContent = "Workspace data unavailable. Try Refresh.";
    return;
  }
  if (sessionVersion !== state.sessionVersion || snapshotVersion !== state.snapshotVersion || requestId < state.lastSnapshotResult) return;
  state.lastSnapshotResult = requestId;
  state.authenticated = true;
  state.snapshotAt = Date.now();
  state.connectionError = "";
  state.staleRendered = false;
  state.snapshot = snap;
  historyPreferences(snap);
  updateHistoryControls();
  sites?.update();
  warmup?.update();
  $("workspaceName").textContent = snap.user?.tenantName || "Workspace";
  $("btnLogout").hidden = !snap.user;
  if (!snap.devices.some((device) => device.id === state.selectedId)) state.selectedId = snap.devices[0]?.id || null;
  renderConnection();
  renderKpis(snap);
  renderFleet(snap);
  renderKeys(snap);
  renderRpa(snap);
  renderOps(snap);
  renderDetail();
  renderMap(snap);
  if (!state.initialFocus && selectedDevice()) { const device = selectedDevice(); state.initialFocus = true; focusMap(device.currentLat, device.currentLng, 17); }
  setTimeout(() => map.invalidateSize(), 80);
}

function renderOps(snap) {
  const box = $("opsSession");
  if (!box) return;
  const qps = snap.health.qps || { qps: 0, hot: false, series: [] };
  box.innerHTML = `
    <div>Recorded offline time today <b>${fmt(snap.health.darkHoursToday || 0, 1)} h</b></div>
    <div>Recent API requests / second <b>${fmt(qps.qps, 2)}</b></div>
    <svg viewBox="0 0 160 28" width="100%" height="28">${sparkline(qps.series || [], 160, 28)}</svg>
    <div>Last fleet check <b>${age(snap.health.lastFleetSyncAt)}</b></div>
    <div>Last registered ON <b>${snap.health.poweredOn ?? 0}</b> · registered <b>${snap.devices.length}</b></div>
    ${(snap.inventoryImportIssues || []).length ? `<details><summary>${snap.inventoryImportIssues.length} inventory imports need attention</summary>${snap.inventoryImportIssues.map((issue) => `<p><strong>${escapeHtml(issue.imageId)}</strong> · ${escapeHtml(issue.error)}<br>Attempts: ${escapeHtml(issue.attempts)} · Next retry: ${escapeHtml(new Date(issue.nextRetryAt).toLocaleString())}</p>`).join("")}</details>` : ""}
  `;
}

$("fleetList").addEventListener("click", (e) => {
  const registerButton = e.target.closest("[data-register-image]");
  if (registerButton) {
    const device = discoveredOnDevices(state.snapshot).find((device) => device.imageId === registerButton.dataset.registerImage);
    if (device) openRegistration(device);
    return;
  }
  const item = e.target.closest(".fleet-item[data-id]");
  if (!item) return;
  const previous = selectedDevice();
  if (previous) anchorDraft(previous).placing = false;
  state.walkPlacing = false;
  state.playIndex = null;
  if (state.ghost) { map.removeLayer(state.ghost); state.ghost = null; }
  state.selectedId = item.dataset.id;
  renderFleet(state.snapshot);
  renderDetail();
  updateRadiusLegend();
  renderMap(state.snapshot);
  setMobileView("device");
  const d = selectedDevice();
  if (d) focusMap(d.currentLat, d.currentLng, Math.max(map.getZoom(), 17));
});

$("fleetFilter").addEventListener("input", () => {
  if (state.snapshot) renderFleet(state.snapshot);
});
$("fleetFolder")?.addEventListener("change", () => { if (state.snapshot) renderFleet(state.snapshot); });
$("fleetStatus")?.addEventListener("change", () => { if (state.snapshot) renderFleet(state.snapshot); });
$("mobileNav")?.addEventListener("click", (e) => { const button = e.target.closest("[data-mobile-view]"); if (button) setMobileView(button.dataset.mobileView); });

$("detail").addEventListener("click", (event) => {
  if (event.target.closest("#manageRpaJobs")) void rpaJobs?.open(selectedDevice());
});

$("detail").addEventListener("input", (e) => {
  if (["anchorLat", "anchorLng"].includes(e.target.id)) {
    const device = selectedDevice();
    if (!device) return;
    const draft = anchorDraft(device);
    if (!draft.editing || draft.saving) return;
    draft[e.target.id === "anchorLat" ? "lat" : "lng"] = e.target.value;
    draft.error = "";
    updateAnchorEditor(device);
    renderMap(state.snapshot);
    return;
  }
  if (e.target.id === "radiusNumber" || e.target.id === "radiusSlider") {
    const device = selectedDevice();
    if (!device) return;
    const draft = radiusDraft(device);
    if (draft.saving) return;
    draft.value = e.target.value;
    draft.dirty = true;
    draft.error = "";
    draft.saved = "";
    updateRadiusEditor(device);
    return;
  }
  if (e.target.id !== "playScrub") return;
  const d = selectedDevice();
  if (!d) return;
  const ticks = (state.snapshot.ticks[d.id] || []).slice().reverse();
  const tick = ticks[Number(e.target.value)];
  if (!tick || !coordinatePoint(tick.lat, tick.lng)) {
    if (state.ghost) { map.removeLayer(state.ghost); state.ghost = null; }
    return;
  }
  state.playIndex = Number(e.target.value);
  if (!state.ghost) {
    state.ghost = L.circleMarker([tick.lat, tick.lng], { radius: 8, color: "#fff", weight: 2, fillColor: "#f0b429", fillOpacity: 1 }).addTo(map);
  } else {
    state.ghost.setLatLng([tick.lat, tick.lng]);
  }
});

$("detail").addEventListener("focusin", (e) => {
  if (!["radiusNumber", "radiusSlider", "anchorLat", "anchorLng", "anchorSave", "environmentPreview", "environmentMore", "environmentApply", "environmentAcceptedSummary", "environmentSavedSummary", "wigleUploadButton", "wigleUploadDownload", "wigleUploadSelect", "wigleUploadKind", "wigleUploadPrevious", "wigleUploadNext"].includes(e.target.id)) return;
  const device = selectedDevice();
  if (!device) return;
  state.detailFocus.set(device.id, e.target.id);
  if (e.target.id === "radiusNumber" || e.target.id === "radiusSlider") radiusDraft(device).focusId = e.target.id;
});

$("detail").addEventListener("toggle", (e) => {
  if (!["environmentAccepted", "environmentSaved"].includes(e.target.id)) return;
  const device = selectedDevice();
  if (device && e.target.isConnected) environmentOperation(device)[e.target.id === "environmentSaved" ? "savedOpen" : "acceptedOpen"] = e.target.open;
}, true);

$("detail").addEventListener("change", (e) => {
  const device = selectedDevice();
  if (!device) return;
  if (e.target.id === "wigleUploadFile") {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (e.target.dataset.deviceId === device.id && file) void uploadWigleFile(device, file);
  } else if (e.target.id === "wigleUploadSelect") {
    void loadWigleUpload(device, e.target.value);
  } else if (e.target.id === "wigleUploadKind") {
    const operation = wigleUploadOperation(device);
    operation.kind = ["WIFI", "CELL", "BLUETOOTH"].includes(e.target.value) ? e.target.value : "ALL";
    operation.page = 0;
    updateWigleUploads(device);
  }
});

$("detail").addEventListener("submit", (e) => {
  if (!["radiusForm", "anchorForm"].includes(e.target.id)) return;
  e.preventDefault();
  if (e.target.id === "radiusForm") void saveRadius();
  else void saveAnchor();
});

$("detail").addEventListener("click", async (e) => {
  if (e.target.closest("#wigleUploadButton")) { $("wigleUploadFile")?.click(); return; }
  const uploadDownload = e.target.closest("#wigleUploadDownload");
  if (uploadDownload) {
    const device = selectedDevice();
    if (device && !uploadDownload.disabled) downloadWigleUpload(device);
    return;
  }
  const uploadPage = e.target.closest("#wigleUploadPrevious, #wigleUploadNext");
  if (uploadPage) {
    const device = selectedDevice();
    if (device && !uploadPage.disabled) {
      const operation = wigleUploadOperation(device);
      operation.page += uploadPage.id === "wigleUploadPrevious" ? -1 : 1;
      updateWigleUploads(device);
      $("wigleUploadRecords")?.scrollTo({ top: 0 });
    }
    return;
  }
  if (e.target.closest("#copyDeviceSnapshot")) { const device = selectedDevice(); if (device) await copyDeviceSnapshot(device); return; }
  if (e.target.closest("#checkPowerNow")) { const device = selectedDevice(); if (device) await checkPowerNow(device); return; }
  if (e.target.closest("#verifyPlayer")) { const device = selectedDevice(); if (device) await verifyPlayer(device); return; }
  if (e.target.closest("#checkPhoneLocation")) { const device = selectedDevice(); if (device) await checkPhoneLocation(device); return; }
  const tab = e.target.closest("[data-inspector-tab]");
  if (tab) { setInspectorTab(tab.dataset.inspectorTab); return; }
  const anchorButton = e.target.closest("#anchorEdit, #anchorPlace, #anchorCancel");
  if (anchorButton) {
    const device = selectedDevice();
    if (!device) return;
    const draft = anchorDraft(device);
    if (draft.saving) return;
    if (anchorButton.id === "anchorCancel") { draft.editing = false; draft.placing = false; draft.error = ""; draft.saved = ""; }
    else {
      draft.editing = true;
      draft.error = "";
      draft.saved = "";
      if (anchorButton.id === "anchorPlace") { draft.placing = true; state.walkPlacing = false; setMobileView("map"); }
    }
    updateAnchorEditor(device);
    renderMap(state.snapshot);
    return;
  }
  const environmentButton = e.target.closest("[data-environment-action]");
  if (environmentButton) {
    await requestEnvironment(environmentButton.dataset.environmentAction);
    return;
  }
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const d = selectedDevice();
  if (!d) return;
  const operation = movementOperation(d);
  if (operation.pending) return;
  const action = btn.dataset.act;
  if (action === "focus") { setMobileView("map"); focusMap(d.currentLat, d.currentLng, 18); return; }
  if (action === "placeDestination") { state.walkPlacing = true; anchorDraft(d).placing = false; setMobileView("map"); return; }
  if (!["park", "toggle", "nav"].includes(action)) return;
  if (action === "nav" && !state.walkDest) return;
  const sessionVersion = state.sessionVersion;
  operation.pending = true;
  operation.error = "";
  operation.saved = "";
  updateMovementControls(d);
  try {
    const path = action === "park" ? "stationary" : action === "toggle" ? "active" : "navigate";
    const body = action === "park" ? {} : action === "toggle" ? { active: !d.active } : { destLat: state.walkDest.lat, destLng: state.walkDest.lng, transitMode: "walk", polyline: [{ lat: d.currentLat, lng: d.currentLng }, state.walkDest] };
    const result = await api(`/devices/${encodeURIComponent(d.id)}/${path}`, { method: "POST", body: JSON.stringify(body) });
    if (sessionVersion !== state.sessionVersion) return;
    state.snapshotVersion += 1;
    const current = state.snapshot?.devices.find((device) => device.id === d.id);
    if (current && result.device) Object.assign(current, result.device);
    operation.saved = "Movement settings saved.";
  } catch (err) {
    if (sessionVersion === state.sessionVersion) operation.error = err.message;
  } finally {
    if (sessionVersion === state.sessionVersion) {
      operation.pending = false;
      if (selectedDevice()?.id === d.id) renderDetail();
    }
  }
});

function setKeysBusy(busy) {
  state.keysBusy = busy;
  $("keysModal").querySelectorAll("input, button:not(#btnCloseKeys)").forEach((control) => { control.disabled = busy; });
}

function renderDuoCredentials(keys) {
  $("keysList").innerHTML = keys.map((key) => {
    const congested = key.congested || (key.congestedUntil && new Date(key.congestedUntil) > new Date());
    const status = key.dead ? "Rejected" : congested ? "Rate limited" : "Connected";
    return `<div class="credential-row">
      <div class="credential-summary"><strong>${escapeHtml(key.label)}</strong><span>Key ending ${escapeHtml(key.last4)}</span></div>
      <span class="${key.dead ? "bad" : "ok"}">${status}</span>
      <button type="button" class="btn ghost tiny" data-delete-key="${escapeHtml(key.id)}" aria-label="Remove DuoPlus key ${escapeHtml(key.label)}">Remove</button>
    </div>`;
  }).join("") || '<div class="credential-empty">No DuoPlus keys connected.</div>';
}

function renderWigleCredential(credential) {
  $("wigleStatus").textContent = credential ? "Connected" : "Not connected";
  $("wigleStatus").classList.toggle("ok", Boolean(credential));
  $("btnSaveWigleKey").textContent = credential ? "Replace WiGLE credentials" : "Save WiGLE credentials";
  $("wigleCredential").innerHTML = credential ? `<div class="credential-row">
    <div class="credential-summary"><strong>${escapeHtml(credential.apiName)}</strong><span>Token ending ${escapeHtml(credential.last4)}</span></div>
    <span>Validated ${age(credential.lastValidatedAt)}</span>
    <button type="button" class="btn ghost tiny" id="btnDeleteWigle">Remove</button>
  </div>` : '<div class="credential-empty">No WiGLE credentials connected.</div>';
}

async function refreshCredentials() {
  const sessionVersion = state.sessionVersion;
  const results = await Promise.allSettled([api("/api/keys"), api("/api/wigle")]);
  if (sessionVersion !== state.sessionVersion) return;
  if (results[0].status === "fulfilled") renderDuoCredentials(results[0].value.keys);
  else {
    $("keysList").textContent = "";
    formMessage("duoKeyMessage", results[0].reason.message, true);
  }
  if (results[1].status === "fulfilled") renderWigleCredential(results[1].value.credential);
  else {
    $("wigleCredential").textContent = "";
    $("wigleStatus").textContent = "Unavailable";
    formMessage("wigleKeyMessage", results[1].reason.message, true);
  }
  return { duo: results[0].status === "fulfilled", wigle: results[1].status === "fulfilled" };
}

async function openKeys() {
  const sessionVersion = state.sessionVersion;
  $("keysWorkspace").textContent = `${state.snapshot?.user?.tenantName || "Workspace"} · Credentials stored encrypted`;
  formMessage("duoKeyMessage");
  formMessage("wigleKeyMessage");
  $("keysList").textContent = "Loading keys...";
  $("wigleCredential").textContent = "Loading credentials...";
  setKeysBusy(true);
  openModal("keysModal");
  try {
    await refreshCredentials();
  } finally {
    if (sessionVersion === state.sessionVersion) {
      setKeysBusy(false);
      if (!$("keysModal").hidden) $("addKeyForm").elements.key.focus();
    }
  }
}

function closeKeys() {
  $("addKeyForm").reset();
  $("wigleKeyForm").reset();
  closeModal("keysModal");
  $("btnKeys").focus();
}

$("btnKeys").addEventListener("click", openKeys);
$("btnCloseKeys").addEventListener("click", closeKeys);
$("addKeyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.keysBusy) return;
  const fd = new FormData(e.target);
  const sessionVersion = state.sessionVersion;
  setKeysBusy(true);
  $("btnSaveDuoKey").textContent = "Validating...";
  formMessage("duoKeyMessage");
  try {
    await api("/api/keys", { method: "POST", body: JSON.stringify({ key: fd.get("key").trim(), label: fd.get("label").trim() }) });
    if (sessionVersion !== state.sessionVersion) return;
    e.target.reset();
    const refreshed = await refreshCredentials();
    if (sessionVersion !== state.sessionVersion) return;
    if (refreshed?.duo) formMessage("duoKeyMessage", "DuoPlus key connected.");
    await load();
  } catch (err) {
    if (sessionVersion === state.sessionVersion) formMessage("duoKeyMessage", err.message, true);
  } finally {
    if (sessionVersion === state.sessionVersion) {
      $("btnSaveDuoKey").textContent = "Save DuoPlus key";
      setKeysBusy(false);
    }
  }
});

$("wigleKeyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.keysBusy) return;
  const fd = new FormData(e.target);
  const sessionVersion = state.sessionVersion;
  const buttonLabel = $("btnSaveWigleKey").textContent;
  setKeysBusy(true);
  $("btnSaveWigleKey").textContent = "Validating...";
  formMessage("wigleKeyMessage");
  try {
    const result = await api("/api/wigle", {
      method: "POST",
      body: JSON.stringify({ apiName: fd.get("apiName").trim(), apiToken: fd.get("apiToken").trim() }),
    });
    if (sessionVersion !== state.sessionVersion) return;
    e.target.reset();
    renderWigleCredential(result.credential);
    formMessage("wigleKeyMessage", "WiGLE credentials connected.");
    await load();
  } catch (err) {
    if (sessionVersion === state.sessionVersion) {
      $("btnSaveWigleKey").textContent = buttonLabel;
      formMessage("wigleKeyMessage", err.message, true);
    }
  } finally {
    if (sessionVersion === state.sessionVersion) setKeysBusy(false);
  }
});

$("keysModal").addEventListener("click", async (e) => {
  const button = e.target.closest("[data-delete-key], #btnDeleteWigle");
  if (!button || state.keysBusy) return;
  const wigle = button.id === "btnDeleteWigle";
  const messageId = wigle ? "wigleKeyMessage" : "duoKeyMessage";
  const sessionVersion = state.sessionVersion;
  setKeysBusy(true);
  formMessage(messageId);
  try {
    await api(wigle ? "/api/wigle" : `/api/keys/${encodeURIComponent(button.dataset.deleteKey)}`, { method: "DELETE" });
    if (sessionVersion !== state.sessionVersion) return;
    if (wigle) $("wigleKeyForm").reset();
    const refreshed = await refreshCredentials();
    if (sessionVersion !== state.sessionVersion) return;
    if (refreshed?.[wigle ? "wigle" : "duo"]) formMessage(messageId, wigle ? "WiGLE credentials removed." : "DuoPlus key removed.");
    await load();
  } catch (err) {
    if (sessionVersion === state.sessionVersion) formMessage(messageId, err.message, true);
  } finally {
    if (sessionVersion === state.sessionVersion) setKeysBusy(false);
  }
});

function setAuthMode(mode) {
  state.authMode = mode === "signup" && state.signupsOpen ? "signup" : "login";
  const signup = state.authMode === "signup";
  $("loginTitle").textContent = signup ? "Create a workspace" : "Workspace login";
  $("btnLoginSubmit").textContent = signup ? "Create workspace" : "Log in";
  $("workspaceField").hidden = !signup;
  const password = $("loginForm").elements.password;
  password.minLength = signup ? 12 : 1;
  password.autocomplete = signup ? "new-password" : "current-password";
  password.placeholder = signup ? "At least 12 characters" : "";
  for (const [id, active] of [["btnLoginMode", !signup], ["btnSignupMode", signup]]) {
    $(id).classList.toggle("active", active);
    $(id).setAttribute("aria-pressed", String(active));
  }
  formMessage("loginError");
}

$("btnLoginMode").addEventListener("click", () => setAuthMode("login"));
$("btnSignupMode").addEventListener("click", () => setAuthMode("signup"));

$("btnLogout").addEventListener("click", async () => {
  $("btnLogout").disabled = true;
  try {
    await api("/auth/logout", { method: "POST", body: "{}" });
    $("loginForm").reset();
    setAuthMode("login");
    showLogin();
  } catch (err) {
    if ($("connectionStatus")) { $("connectionStatus").textContent = `Sign out failed: ${err.message}`; $("connectionStatus").className = "connection-status bad"; }
  } finally {
    $("btnLogout").disabled = false;
  }
});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!e.target.reportValidity()) return;
  const fd = new FormData(e.target);
  const signup = state.authMode === "signup";
  e.target.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
  $("btnLoginSubmit").textContent = signup ? "Creating workspace..." : "Logging in...";
  formMessage("loginError");
  try {
    await api(signup ? "/auth/register" : "/auth/login", {
      method: "POST", body: JSON.stringify({
        email: fd.get("email").trim(),
        password: fd.get("password"),
        ...(signup ? { workspace: fd.get("workspace").trim() } : {}),
      }),
    });
    clearWorkspace();
    state.authenticated = true;
    e.target.reset();
    closeModal("loginModal");
    await load();
    if (state.authenticated && (signup || !state.snapshot?.keys.length)) await openKeys();
  } catch (err) {
    if ($("loginModal").hidden) openModal("loginModal");
    formMessage("loginError", err.message, true);
  } finally {
    e.target.querySelectorAll("input, button").forEach((control) => { control.disabled = false; });
    $("btnLoginSubmit").textContent = signup ? "Create workspace" : "Log in";
  }
});

$("btnRefresh").addEventListener("click", async () => {
  $("btnRefresh").disabled = true;
  try { await load(); if (!$("sitesWorkspace").hidden) await sites?.reload(); if (!$("warmupWorkspace").hidden) await warmup?.reload(); } finally { $("btnRefresh").disabled = false; }
});
$("btnDiagnostics")?.addEventListener("click", () => { openModal("diagnosticsModal"); void load().catch(() => {}); });
$("btnCloseDiagnostics")?.addEventListener("click", () => { closeModal("diagnosticsModal"); $("btnDiagnostics")?.focus(); });
function openRegistration(discoveredDevice) {
  const form = $("registerForm");
  if (discoveredDevice) {
    form.reset();
    form.elements.imageId.value = discoveredDevice.imageId;
    form.elements.name.value = discoveredDevice.name || "";
  }
  if (form.elements.lookupWigle) form.elements.lookupWigle.checked = false;
  $("wiglePreview").hidden = true;
  formMessage("registerFeedback");
  openModal("registerModal");
  if (discoveredDevice) form.elements.anchorLat.focus();
}
$("btnRegister").addEventListener("click", () => openRegistration());
$("btnCancelReg").addEventListener("click", () => {
  closeModal("registerModal");
  $("btnRegister").focus();
});

$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!e.target.reportValidity() || e.target.dataset.saving === "true") return;
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  body.anchorLat = Number(body.anchorLat);
  body.anchorLng = Number(body.anchorLng);
  body.groundElevationM = Number(body.groundElevationM);
  body.campaignDays = Number(body.campaignDays);
  body.lookupWigle = fd.get("lookupWigle") === "on";
  if (!body.wifiSsid) delete body.wifiSsid;
  if (!body.wifiBssid) delete body.wifiBssid;
  const sessionVersion = state.sessionVersion;
  e.target.dataset.saving = "true";
  e.target.querySelector('button[type="submit"]').disabled = true;
  formMessage("registerFeedback", "Registering device...");
  try {
    const res = await api("/devices", { method: "POST", body: JSON.stringify(body) });
    if (sessionVersion !== state.sessionVersion) return;
    state.snapshotVersion += 1;
    closeModal("registerModal");
    state.selectedId = res.device.id;
    state.inspectorTabs.set(res.device.id, "overview");
    await load();
    setMobileView("device");
    focusMap(res.device.anchorLat, res.device.anchorLng, 17);
  } catch (err) {
    if (sessionVersion === state.sessionVersion) formMessage("registerFeedback", err.message, true);
  } finally {
    e.target.dataset.saving = "false";
    e.target.querySelector('button[type="submit"]').disabled = false;
  }
});

$("btnTiles")?.addEventListener("click", () => {
  state.sat = !state.sat;
  if (state.sat) {
    map.removeLayer(streetLayer);
    satLayer.addTo(map);
    labelLayer.addTo(map);
    $("btnTiles").textContent = "Satellite";
    $("btnTiles").classList.add("on");
  } else {
    map.removeLayer(satLayer);
    map.removeLayer(labelLayer);
    streetLayer.addTo(map);
    $("btnTiles").textContent = "Streets";
    $("btnTiles").classList.remove("on");
  }
});
$("onOnly")?.addEventListener("change", (e) => {
  state.onOnly = e.target.checked;
  if (state.snapshot) renderMap(state.snapshot);
});
$("showHistory")?.addEventListener("change", (e) => {
  state.showHistory = e.target.checked;
  saveHistoryPreferences();
  if (state.snapshot) renderMap(state.snapshot);
  updateHistoryControls(state.showHistory ? "Model history shown. Gaps and position jumps stay disconnected." : "Model history hidden.");
});
$("btnClearTrails")?.addEventListener("click", clearMapTrails);

window.addEventListener("resize", () => { map.stop(); map.invalidateSize(); });
document.addEventListener("keydown", (e) => {
  const tab = e.target.closest?.("[data-inspector-tab]");
  if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    e.preventDefault();
    const tabs = [...$("detail").querySelectorAll("[data-inspector-tab]")];
    const current = tabs.indexOf(tab);
    const index = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (current + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    setInspectorTab(tabs[index].dataset.inspectorTab);
    tabs[index].focus();
    return;
  }
  const modal = document.querySelector(".modal:not([hidden])");
  if (!modal) return;
  if (e.key === "Escape" && modal.id !== "loginModal") {
    if (modal.id === "keysModal") closeKeys();
    else if (modal.id === "diagnosticsModal") $("btnCloseDiagnostics").click();
    else if (modal.classList.contains("site-modal")) sites?.closeModal(modal.id);
    else if (modal.id === "rpaJobsModal") rpaJobs?.close();
    else if (modal.classList.contains("wu-modal")) modal.querySelector("[data-wu-close]")?.click();
    else $("btnCancelReg").click();
    return;
  }
  if (e.key !== "Tab") return;
  const controls = [...modal.querySelectorAll("input, select, textarea, button")].filter((control) => !control.disabled && control.getClientRects().length);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first?.focus();
  }
});
api("/auth/config").then((config) => {
  state.signupsOpen = Boolean(config.signupsOpen);
  $("btnSignupMode").hidden = !state.signupsOpen;
}).catch(() => {});
load().catch((err) => {
  if (state.authenticated !== false) $("fleetList").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
});
function refreshVisibleWorkspace() {
  if (document.hidden || state.authenticated === false) return;
  if (window.ObservatoryPolling.snapshotNeeded({ hidden: document.hidden, authenticated: state.authenticated,
    hasSnapshot: Boolean(state.snapshot), section: document.body.dataset.workspaceSection,
    diagnosticsOpen: !$("diagnosticsModal").hidden })) {
    void load().catch(() => {});
  } else {
    sites?.update();
    warmup?.update();
  }
}
setInterval(refreshVisibleWorkspace, 2500);
document.addEventListener("visibilitychange", refreshVisibleWorkspace);
document.addEventListener("workspacechange", refreshVisibleWorkspace);
setInterval(() => {
  renderConnection();
  for (const [id, marker] of state.phoneMarkers) {
    const device = state.snapshot?.devices.find(d => d.id === id);
    if (!window.ObservatoryPhoneReadback.freshPoint(device, state.controlOperations.get(id)?.phoneReadback)) {
      map.removeLayer(marker); state.phoneMarkers.delete(id);
    }
  }
  if (state.snapshot && state.snapshotAt && Date.now() - state.snapshotAt > 15_000 && !state.staleRendered) {
    state.staleRendered = true;
    renderFleet(state.snapshot);
    renderDetail();
    renderMap(state.snapshot);
  }
}, 1000);
setMobileView(document.body.dataset.view || "fleet");
