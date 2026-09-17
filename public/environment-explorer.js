(function (root) {
  "use strict";

  const kinds = {
    WIFI: { label: "Wi-Fi", icon: "wifi", color: "#087d79" },
    BLUETOOTH: { label: "Bluetooth", icon: "bluetooth", color: "#7851ac" },
    CELL: { label: "Cells", icon: "radio", color: "#b77412" },
  };
  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const keyOf = (record) => `${record.uploadId}:${record.recordIndex}`;
  const titleOf = (record) => record.kind === "WIFI" ? record.ssid || "Hidden SSID" : record.kind === "BLUETOOTH" ? record.bluetooth?.name || record.ssid || "Unnamed Bluetooth" : record.radio || "Cell observation";
  const validPoint = (record) => Number.isFinite(record.lat) && Math.abs(record.lat) <= 90 && Number.isFinite(record.lng) && Math.abs(record.lng) <= 180;
  const distance = (value) => Number.isFinite(value) ? value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${Math.round(value)} m` : "Unknown";
  const timestamp = (value) => { const time = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(time) && time <= Date.now() ? time : 0; };
  const date = (value) => timestamp(value) ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Unknown";
  const freshness = (record, now = Date.now()) => {
    const observed = timestamp(record.lastSeen);
    if (!observed) return { label: "Date unknown", tone: "neutral" };
    return now - observed > 730 * 86_400_000 ? { label: "Older observation", tone: "warn" } : { label: "Historical", tone: "neutral" };
  };

  function filterRecords(records, { kind = "ALL", search = "", sort = "recommended" } = {}) {
    const query = search.trim().toLocaleLowerCase();
    const result = records.filter((record) => kinds[record.kind] && (kind === "ALL" || record.kind === kind) && (!query || [titleOf(record), record.identifier, record.filename, record.radio, record.attributes].some((value) => String(value ?? "").toLocaleLowerCase().includes(query))));
    const nearest = (a, b) => (Number.isFinite(a.distanceM) ? a.distanceM : Infinity) - (Number.isFinite(b.distanceM) ? b.distanceM : Infinity);
    result.sort((a, b) => {
      if (sort === "freshness") return timestamp(b.lastSeen) - timestamp(a.lastSeen) || nearest(a, b) || keyOf(a).localeCompare(keyOf(b));
      if (sort === "qos") return (b.qos ?? -1) - (a.qos ?? -1) || nearest(a, b) || keyOf(a).localeCompare(keyOf(b));
      if (sort === "recommended") return Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || Number(Boolean(b.eligible)) - Number(Boolean(a.eligible)) || nearest(a, b) || keyOf(a).localeCompare(keyOf(b));
      return nearest(a, b) || keyOf(a).localeCompare(keyOf(b));
    });
    return result;
  }

  function cacheKey(device) {
    return JSON.stringify([device.id, device.anchorLat, device.anchorLng, (device.wigleUploads || []).map((upload) => [upload.id, upload.importedAt]).sort((a, b) => a[0].localeCompare(b[0]))]);
  }

  function markup(icon) {
    return `<section id="environmentExplorer" class="environment-explorer" aria-labelledby="explorerHeading">
      <div class="explorer-heading"><div><span class="eyebrow">Saved observations</span><h3 id="explorerHeading">Local environment</h3></div><div class="explorer-tools"><button type="button" class="btn ghost icon-button" id="explorerUpload" title="Upload WiGLE JSON" aria-label="Upload WiGLE JSON">${icon("plus")}</button><button type="button" class="btn ghost icon-button" id="explorerFit" title="Fit observations on map" aria-label="Fit observations on map">${icon("crosshair")}</button></div></div>
      <div id="explorerCounts" class="explorer-counts"></div>
      <div id="explorerFilters" class="explorer-filters" role="group" aria-label="Observation type"><button type="button" data-explorer-kind="ALL" aria-pressed="true">All</button>${Object.entries(kinds).map(([kind, value]) => `<button type="button" data-explorer-kind="${kind}" aria-pressed="false">${icon(value.icon)}${value.label}</button>`).join("")}</div>
      <div class="explorer-search-row"><label class="search-field">${icon("search")}<input id="explorerSearch" placeholder="SSID, identifier or source" aria-label="Search saved observations" autocomplete="off" /></label><label><span class="sr-only">Sort observations</span><select id="explorerSort" aria-label="Sort observations"><option value="recommended">Recommended</option><option value="nearest">Nearest</option><option value="freshness">Last seen</option><option value="qos">QoS</option></select></label></div>
      <div class="explorer-feedback-row"><div id="explorerFeedback" class="form-message" role="status" aria-live="polite"></div><button type="button" id="explorerRetry" class="btn ghost icon-button" title="Retry loading saved observations" aria-label="Retry loading saved observations" hidden>${icon("refresh-cw")}</button></div>
      <div class="explorer-list-heading"><span id="explorerResultCount">0 observations</span><span>From anchor</span></div><div id="explorerRecords" class="explorer-records" role="region" aria-label="Local environment observations" tabindex="0"></div>
      <div id="explorerPagination" class="explorer-pagination" hidden><button type="button" class="btn ghost icon-button" id="explorerPrevious" aria-label="Previous observations" title="Previous observations">${icon("arrow-left")}</button><span id="explorerPage"></span><button type="button" class="btn ghost icon-button" id="explorerNext" aria-label="Next observations" title="Next observations">${icon("chevron-right")}</button></div>
      <div id="explorerSelection" class="explorer-selection"></div><div id="explorerWarnings"></div>
    </section>`;
  }

  function create(options) {
    const { map, L, api, icon } = options;
    const $ = (id) => document.getElementById(id);
    const cache = new Map();
    let generation = 0;
    let active = false;
    let current = null;
    let mapSignature = "";
    let layer = L.layerGroup();
    const renderer = L.canvas({ pane: "observations", padding: 0.3 });
    const pane = map.getPane("observations") || map.createPane("observations");
    pane.style.zIndex = "420";
    let currentState;

    function dataState(device) {
      let value = cache.get(device.id);
      const key = cacheKey(device);
      if (!value || value.key !== key) {
        value = { key, data: null, loading: false, error: "", kind: value?.kind || "ALL", search: value?.search || "", sort: value?.sort || "recommended", selected: "", page: 0 };
        cache.set(device.id, value);
      }
      return value;
    }

    function html(id, value) { const element = $(id); if (element && element.innerHTML !== value) element.innerHTML = value; }
    function picked(value) { return value.data?.records.find((record) => keyOf(record) === value.selected) || null; }
    function visible(value) { return filterRecords(value.data?.records || [], value); }
    function preparedAp(value) {
      const profile = current?.environment?.profile;
      const wifi = profile?.wifi;
      if (!value || !profile?.anchor || !wifi || !validPoint(profile.anchor) || !validPoint(wifi) ||
          profile.anchor.lat !== current.anchorLat || profile.anchor.lng !== current.anchorLng ||
          typeof wifi.ssid !== "string" || !wifi.ssid.trim() || typeof wifi.bssid !== "string" ||
          !/^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(wifi.bssid) || wifi.bssid === "00:00:00:00:00:00" ||
          (parseInt(wifi.bssid.slice(0, 2), 16) & 1) !== 0 || !["ALL", "WIFI"].includes(value.kind)) return null;
      if ((value.data?.records || []).some((record) => record.kind === "WIFI" &&
          String(record.identifier).toLowerCase() === wifi.bssid.toLowerCase())) return null;
      const query = value.search.trim().toLocaleLowerCase();
      return !query || [wifi.ssid, wifi.bssid, "Prepared AP"].some((text) => text.toLocaleLowerCase().includes(query)) ? wifi : null;
    }

    function mapRender(value) {
      const panel = $("explorerMapPanel");
      const prepared = preparedAp(value);
      if (!active || !current || (!value?.data && !prepared)) {
        layer.clearLayers(); mapSignature = "";
        if (panel) panel.hidden = true;
        return;
      }
      const records = visible(value);
      const signature = JSON.stringify([value.key, value.kind, value.search, value.selected, prepared]);
      if (signature !== mapSignature) {
        layer.clearLayers();
        layer.addTo(map);
        for (const record of records) {
          if (!validPoint(record)) continue;
          const selected = keyOf(record) === value.selected;
          const marker = L.circleMarker([record.lat, record.lng], { renderer, pane: "observations", radius: selected ? 9 : 5, color: selected ? "#202b26" : "#ffffff", weight: selected ? 2.5 : 1.3, fillColor: kinds[record.kind].color, fillOpacity: selected ? 1 : 0.78, bubblingMouseEvents: false });
          marker.bindTooltip(`<strong>${escape(titleOf(record))}</strong><br>${escape(kinds[record.kind].label)} &middot; ${escape(distance(record.distanceM))}`, { direction: "top", className: "explorer-tooltip" });
          marker.on("click", () => { value.selected = keyOf(record); const index = visible(value).findIndex((item) => keyOf(item) === value.selected); value.page = Math.floor(Math.max(0, index) / 25); render(); });
          marker.addTo(layer);
        }
        if (prepared) {
          const marker = L.circleMarker([prepared.lat, prepared.lng], { renderer, pane: "observations", radius: 9,
            color: kinds.WIFI.color, weight: 2, dashArray: "4 3", fillColor: kinds.WIFI.color, fillOpacity: 0.15, bubblingMouseEvents: false });
          marker.bindTooltip(`<strong>Prepared AP: ${escape(prepared.ssid)}</strong><br>${escape(prepared.bssid)}<br>Prepared profile; not Android-observed`, { direction: "top", className: "explorer-tooltip" });
          marker.addTo(layer);
        }
        mapSignature = signature;
      }
      if (panel) {
        panel.hidden = false;
        const selected = picked(value);
        html("explorerMapSummary", `<strong>${escape(selected ? titleOf(selected) : current.name || current.imageId)}</strong><span>${selected ? `${escape(kinds[selected.kind].label)} &middot; ${escape(distance(selected.distanceM))} from anchor` : `${records.length} saved observations${prepared ? " + 1 prepared AP" : ""}`}</span>`);
        html("explorerMapKinds", Object.entries(kinds).map(([kind, label]) => `<span><i style="background:${label.color}"></i>${label.label} <b>${records.filter((record) => record.kind === kind).length}</b></span>`).join("") + (prepared ? '<span>Prepared AP <b>1</b></span>' : ""));
      }
    }

    function render() {
      if (!current || !active || !$("environmentExplorer")) { mapRender(null); return; }
      const value = dataState(current);
      currentState = value;
      const records = value.data?.records || [];
      const summaries = value.data?.sources || current.wigleUploads || [];
      html("explorerCounts", Object.entries(kinds).map(([kind, item]) => {
        const count = value.data ? records.filter((record) => record.kind === kind).length : summaries.reduce((total, source) => total + Number(source[kind === "WIFI" ? "wifiCount" : kind === "CELL" ? "cellCount" : "bluetoothCount"] || 0), 0);
        return `<div data-kind="${kind}"><span>${icon(item.icon)}${item.label}</span><strong>${count.toLocaleString()}</strong><small>${kind === "WIFI" ? "Wi-Fi observations" : "Reference only"}</small></div>`;
      }).join(""));
      document.querySelectorAll("[data-explorer-kind]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.explorerKind === value.kind)));
      if ($("explorerSearch").value !== value.search) $("explorerSearch").value = value.search;
      $("explorerSort").value = value.sort;
      const filtered = visible(value);
      const prepared = preparedAp(value);
      const pages = Math.max(1, Math.ceil(filtered.length / 25));
      value.page = Math.min(Math.max(0, value.page), pages - 1);
      const page = filtered.slice(value.page * 25, value.page * 25 + 25);
      $("explorerResultCount").textContent = `${filtered.length.toLocaleString()} ${filtered.length === 1 ? "observation" : "observations"}`;
      $("explorerFeedback").textContent = value.error || (value.loading ? "Loading saved observations..." : !summaries.length ? "No uploaded observations for this device." : "");
      $("explorerFeedback").classList.toggle("error", Boolean(value.error));
      $("explorerFeedback").hidden = !$("explorerFeedback").textContent;
      $("explorerRetry").hidden = !value.error;
      $("explorerFit").disabled = !filtered.some(validPoint) && !prepared;
      if ($("explorerMapFit")) $("explorerMapFit").disabled = $("explorerFit").disabled;
      html("explorerRecords", page.map((record) => {
        const type = kinds[record.kind];
        return `<button type="button" class="explorer-record" data-explorer-record="${escape(keyOf(record))}" data-kind="${record.kind}" aria-pressed="${keyOf(record) === value.selected}"><span class="explorer-record-icon">${icon(type.icon)}</span><span class="explorer-record-main"><strong>${escape(titleOf(record))}</strong><code>${escape(record.identifier)}</code><small>${record.recommended ? '<span class="explorer-recommended">Recommended</span>' : escape(date(record.lastSeen))}${record.kind === "WIFI" && !record.eligible ? " &middot; Reference only" : ""}</small></span><span class="explorer-record-distance">${escape(distance(record.distanceM))}<small>QoS ${record.qos == null ? "?" : escape(record.qos)}/7</small></span></button>`;
      }).join("") || (!value.loading ? '<div class="explorer-empty">No matching observations</div>' : ""));
      $("explorerPagination").hidden = pages <= 1;
      $("explorerPage").textContent = `${value.page * 25 + 1}-${Math.min((value.page + 1) * 25, filtered.length)} of ${filtered.length}`;
      $("explorerPrevious").disabled = value.page === 0;
      $("explorerNext").disabled = value.page >= pages - 1;
      const selected = picked(value);
      const operation = options.operation(current);
      const blockReason = options.powerReason(current);
      if (selected) {
        const age = freshness(selected);
        const canPrepare = selected.kind === "WIFI" && selected.eligible === true;
        const metadata = [
          ["First seen", date(selected.firstSeen)],
          ...(selected.wifiType ? [["Wi-Fi type", selected.wifiType]] : []),
          ...(selected.bluetooth?.manufacturerId != null ? [["Manufacturer ID", selected.bluetooth.manufacturerId]] : []),
          ...(selected.bluetooth?.deviceClass != null ? [["Device class", selected.bluetooth.deviceClass]] : []),
          ...(Array.isArray(selected.bluetooth?.capabilities) && selected.bluetooth.capabilities.length ? [["Capabilities", selected.bluetooth.capabilities.join(", ")]] : []),
        ].map(([name, value]) => `<dt>${escape(name)}</dt><dd>${escape(value)}</dd>`).join("");
        html("explorerSelection", `<div class="explorer-selection-heading"><span class="explorer-kind" data-kind="${selected.kind}">${icon(kinds[selected.kind].icon)}${kinds[selected.kind].label}</span><span class="status-chip ${age.tone}">${age.label}</span></div><h4>${escape(titleOf(selected))}</h4><code>${escape(selected.identifier)}</code><dl class="environment-fields"><dt>From anchor</dt><dd>${escape(distance(selected.distanceM))}</dd><dt>Coordinates</dt><dd>${validPoint(selected) ? `${selected.lat.toFixed(6)}, ${selected.lng.toFixed(6)}` : "Unavailable"}</dd><dt>Observation QoS</dt><dd>${selected.qos == null ? "Unknown" : `${escape(selected.qos)} / 7`}</dd><dt>Last seen</dt><dd>${escape(date(selected.lastSeen))}</dd><dt>Last updated</dt><dd>${escape(date(selected.lastUpdated))}</dd>${metadata}${selected.channel != null ? `<dt>Channel</dt><dd>${escape(selected.channel)}</dd>` : ""}${selected.frequencyMHz != null ? `<dt>Frequency</dt><dd>${escape(selected.frequencyMHz)} MHz</dd>` : ""}${selected.encryption ? `<dt>Encryption</dt><dd>${escape(selected.encryption)}</dd>` : ""}${selected.attributes ? `<dt>Attributes</dt><dd>${escape(selected.attributes)}</dd>` : ""}<dt>Source file</dt><dd>${escape(selected.filename)}</dd><dt>Imported</dt><dd>${escape(date(selected.importedAt))}</dd></dl><div class="explorer-selection-actions"><button type="button" class="btn ghost icon-button" id="explorerLocate" title="Locate observation on map" aria-label="Locate observation on map" ${validPoint(selected) ? "" : "disabled"}>${icon("map-pin")}</button><button type="button" class="btn" id="explorerPrepare" ${!canPrepare || operation.pending || current.environment?.status === "APPLYING" || blockReason ? "disabled" : ""}>${icon("layers")}${operation.pending === "preview" ? "Preparing..." : "Prepare from saved"}</button></div><p class="explorer-boundary ${!canPrepare ? "warn" : ""}">${escape(!canPrepare ? selected.ineligibleReason || "Reference only; not applied to device identity." : blockReason || "Wi-Fi profile only. Proxy, SIM and movement remain unchanged.")}</p>`);
      } else html("explorerSelection", "");
      const warnings = Array.isArray(value.data?.warnings) ? value.data.warnings : [];
      html("explorerWarnings", warnings.length ? `<details class="explorer-source-warnings"><summary>${warnings.length} source ${warnings.length === 1 ? "notice" : "notices"}</summary><ul class="environment-warnings">${warnings.map((warning) => `<li>${escape(warning)}</li>`).join("")}</ul></details>` : "");
      mapRender(value);
    }

    async function load(device, value) {
      if (value.loading || value.data || value.error) return;
      if (!(device.wigleUploads || []).length) { value.data = { records: [], sources: [], warnings: [] }; render(); return; }
      const version = generation;
      value.loading = true;
      render();
      try {
        const data = await api(`/devices/${encodeURIComponent(device.id)}/wigle/explorer`);
        if (version !== generation || cache.get(device.id) !== value) return;
        if (!Array.isArray(data?.records) || data.records.length > 5000) throw new Error("Saved observations could not be loaded.");
        value.data = { ...data, records: data.records.filter((record) => kinds[record.kind] && typeof record.uploadId === "string" && Number.isInteger(record.recordIndex)) };
        const initial = value.data.records.find((record) => record.recommended) || filterRecords(value.data.records)[0];
        value.selected = initial ? keyOf(initial) : "";
      } catch (error) { if (version === generation && cache.get(device.id) === value) value.error = error.message; }
      finally { if (version === generation) { value.loading = false; if (current?.id === device.id && cache.get(device.id) === value) render(); } }
    }

    function update(device, isActive) {
      current = device;
      active = Boolean(isActive && device);
      if (!active) { mapRender(null); return; }
      const value = dataState(device);
      render();
      void load(device, value);
    }

    function fit(switchView = true) {
      if (!active || !currentState) return;
      const records = visible(currentState).filter(validPoint);
      const prepared = preparedAp(currentState);
      if (prepared) records.push(prepared);
      if (!records.length) return;
      const deviceId = current.id;
      const version = generation;
      const expectedState = currentState;
      if (switchView) options.mobileMap();
      const points = records.map((record) => [record.lat, record.lng]);
      if (Number.isFinite(current.anchorLat) && Number.isFinite(current.anchorLng)) points.push([current.anchorLat, current.anchorLng]);
      setTimeout(() => { if (active && current?.id === deviceId && generation === version && currentState === expectedState) { map.invalidateSize(); map.fitBounds(L.latLngBounds(points), { paddingTopLeft: [45, 145], paddingBottomRight: [45, 105], maxZoom: 18, animate: false }); } }, 0);
    }

    document.addEventListener("input", (event) => {
      if (event.target.id !== "explorerSearch" || !active || !currentState) return;
      currentState.search = event.target.value; currentState.page = 0;
      const filtered = visible(currentState);
      if (!filtered.some((record) => keyOf(record) === currentState.selected)) currentState.selected = filtered[0] ? keyOf(filtered[0]) : "";
      render();
    });
    document.addEventListener("change", (event) => {
      if (event.target.id !== "explorerSort" || !active || !currentState) return;
      currentState.sort = event.target.value; currentState.page = 0; render();
    });
    document.addEventListener("click", (event) => {
      if (!active || !current || !currentState) return;
      const button = event.target.closest("button");
      if (!button || button.disabled) return;
      if (button.dataset.explorerKind) { currentState.kind = button.dataset.explorerKind; currentState.page = 0; const visibleRecords = visible(currentState); if (!visibleRecords.some((record) => keyOf(record) === currentState.selected)) currentState.selected = visibleRecords[0] ? keyOf(visibleRecords[0]) : ""; render(); }
      else if (button.dataset.explorerRecord) { currentState.selected = button.dataset.explorerRecord; render(); const record = picked(currentState); if (record && validPoint(record)) options.focusMap(record.lat, record.lng, Math.max(16, map.getZoom())); }
      else if (["explorerFit", "explorerMapFit"].includes(button.id)) fit();
      else if (button.id === "explorerLocate") { const record = picked(currentState); if (record && validPoint(record)) { options.mobileMap(); options.focusMap(record.lat, record.lng, 18); } }
      else if (button.id === "explorerUpload") $("wigleUploadFile")?.click();
      else if (button.id === "explorerRetry") { currentState.error = ""; void load(current, currentState); }
      else if (button.id === "explorerPrepare") { const record = picked(currentState); if (record?.kind === "WIFI" && record.eligible === true) void options.prepare(current, record); }
      else if (["explorerPrevious", "explorerNext"].includes(button.id)) { currentState.page += button.id === "explorerPrevious" ? -1 : 1; render(); $("explorerRecords")?.scrollTo({ top: 0 }); }
    });
    return { update, render, clear() { generation += 1; cache.clear(); current = null; currentState = null; active = false; mapRender(null); }, markup: () => markup(icon) };
  }

  const exports = { kinds, keyOf, titleOf, distance, freshness, validPoint, filterRecords, cacheKey, create };
  if (typeof module !== "undefined" && module.exports) module.exports = exports;
  else root.ObservatoryEnvironmentExplorer = exports;
})(typeof window !== "undefined" ? window : globalThis);
