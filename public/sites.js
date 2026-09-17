(() => {
  "use strict";

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const byId = (id) => document.getElementById(id);
  const dateText = (value) => {
    if (!value) return "Not reported";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not reported";
  };
  const localDate = (date) => {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  };
  const point = (site) => typeof site?.lat === "number" && typeof site?.lng === "number" && Number.isFinite(site.lat) && Number.isFinite(site.lng) && Math.abs(site.lat) <= 90 && Math.abs(site.lng) <= 180;
  const rankText = (result) => typeof result?.rank === "number" && Number.isFinite(result.rank) ? String(result.rank) : "Not reported";
  const powerText = (code) => ({ 0: "Unconfigured", 1: "ON", 2: "OFF", 3: "Expired", 4: "Renewal needed", 10: "Powering on", 11: "Configuring", 12: "Configuration failed" })[code] || "Not reported";
  const safeUrl = (value) => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; }
  };
  const jsonDetails = (label, value) => value == null ? "" : `<details class="site-json"><summary>${escape(label)}</summary><pre>${escape(JSON.stringify(value, null, 2))}</pre></details>`;
  const labels = {
    DRAFT: "Draft", PREPARED: "Prepared", APPLYING: "Applying", API_ACCEPTED: "API accepted", PROVIDER_MATCH: "Provider match",
    MISMATCH: "Mismatch", UNCONFIRMED: "Unconfirmed", BLOCKED: "Blocked", QUEUED: "Queued", PREFLIGHT: "Preflight",
    SUBMITTING: "Submitting", AWAITING_RESULT: "Awaiting result", COMPLETED: "Completed", CANCELLED: "Cancelled", TIMED_OUT: "Timed out",
  };
  const statusChip = (status) => {
    const tone = ["PROVIDER_MATCH", "COMPLETED"].includes(status) ? "good" : ["BLOCKED", "MISMATCH"].includes(status) ? "bad" : ["UNCONFIRMED", "TIMED_OUT", "AWAITING_RESULT"].includes(status) ? "warn" : "neutral";
    return `<span class="status-chip ${tone}">${escape(labels[status] || status || "Unknown")}</span>`;
  };
  const sourceText = (result) => {
    const source = String(result?.source || "").toLowerCase();
    if (source.includes("manual") || source.includes("import")) return "Manual import";
    if (source.includes("callback")) return "Authenticated callback";
    return result?.source || "Source not reported";
  };

  window.ObservatorySites = {
    create({ api, icon, openModal, closeModal, showDevices }) {
      const s = { readiness: null, sites: [], devices: [], jobs: [], results: [], selectedId: null, resultId: null, view: "sites", authenticated: false, version: 0, lastLoad: 0, loading: null, busy: false, active: true, keyword: "", resultApp: "", map: null, layer: null, fitted: false, inspectorSignature: "", settingsDirty: false, settingsDraft: null };
      let returnFocus = null;
      const disable = () => s.busy ? " disabled" : "";
      const currentSite = () => s.sites.find((site) => site.id === s.selectedId);
      const sitePath = (site, suffix = "") => `/api/sites/${encodeURIComponent(site.id)}${suffix}`;
      const siteJobs = (site) => s.jobs.filter((job) => job.siteId === site.id).sort((a, b) => new Date(b.scheduledAt) - new Date(a.scheduledAt));
      const message = (text = "", error = false) => {
        byId("sitesFeedback").textContent = text;
        byId("sitesFeedback").hidden = !text;
        byId("sitesFeedback").classList.toggle("error", error);
      };
      const modalMessage = (id, text = "") => {
        byId(id).textContent = text;
        byId(id).hidden = !text;
      };
      const matchingSites = () => {
        const query = byId("siteSearch").value.trim().toLowerCase();
        return s.sites.filter((site) => !query || [site.name, site.street, site.zip, site.device?.name, site.device?.imageId].join(" ").toLowerCase().includes(query));
      };
      const resultForSite = (id) => s.results.filter((result) => result.site?.id === id && result.keyword === s.keyword && result.app === s.resultApp).sort((a, b) => new Date(b.capturedAt) - new Date(a.capturedAt))[0];
      const iconButton = (action, name, text, extra = "") => `<button type="button" class="btn ghost" data-site-action="${action}"${extra}${disable()}>${icon(name)}${text}</button>`;

      function mountDialogs() {
        const modal = (id, title, body, submit) => `<div class="modal site-modal" id="${id}" role="dialog" aria-modal="true" aria-labelledby="${id}Title" hidden><form class="modal-card site-modal-card" id="${id}Form"><div class="modal-heading"><div><span class="eyebrow">Clients</span><h2 id="${id}Title">${title}</h2></div><button type="button" class="btn ghost icon-button" data-close-site-modal="${id}" title="Close dialog" aria-label="Close dialog">${icon("x")}</button></div>${body}<div class="form-message error" id="${id}Error" role="alert" hidden></div><div class="modal-actions"><button type="button" class="btn ghost" data-close-site-modal="${id}">Cancel</button><button type="submit" class="btn">${submit}</button></div></form></div>`;
        document.body.insertAdjacentHTML("beforeend", modal("siteCreateModal", "Add client", `
          <div class="grid2">
            <label class="span2">Client name<input name="name" required maxlength="120" autocomplete="off" /></label>
            <label class="span2">Existing device<select name="deviceId" required></select></label>
            <label>Latitude<input name="lat" type="number" step="any" min="-90" max="90" required /></label>
            <label>Longitude<input name="lng" type="number" step="any" min="-180" max="180" required /></label>
            <label class="span2">Street<input name="street" maxlength="250" autocomplete="street-address" /></label>
            <label>ZIP / postal code<input name="zip" maxlength="20" autocomplete="postal-code" /></label>
            <label>Elevation (m, optional)<input name="elevationM" type="number" step="any" min="-500" max="9000" /></label>
            <label>Proxy ID (optional)<input name="proxyId" maxlength="200" autocomplete="off" /></label>
            <label>Proxy IP<input name="proxyIp" required maxlength="100" spellcheck="false" autocomplete="off" /></label>
            <label>Timezone<input name="timezone" value="America/New_York" required maxlength="100" spellcheck="false" /></label>
            <label>Language<input name="language" value="en-US" required minlength="2" maxlength="40" spellcheck="false" /></label>
            <label class="span2">Automation template ID (optional)<input name="templateId" maxlength="200" autocomplete="off" /></label>
          </div><div class="site-profile-counts"><span>Motion <b>STILL</b></span><span>Jobs <b>Disabled</b></span></div>`, `${icon("plus")}Create client`));
        document.body.insertAdjacentHTML("beforeend", modal("siteScheduleModal", "Schedule job", `
          <p class="meta" id="siteScheduleName"></p><div class="grid2">
            <label class="span2">Keyword<input name="keyword" required maxlength="250" autocomplete="off" /></label>
            <label>App<select name="app"><option value="chrome">Chrome</option><option value="maps">Maps</option><option value="tracker">Tracker</option></select></label>
            <label>Motion<select name="motion"><option value="STILL">STILL</option><option value="FIDGET" disabled>FIDGET (unavailable)</option><option value="WALK" disabled>WALK (unavailable)</option></select></label>
            <label class="span2">Scheduled time (<span id="siteScheduleZone"></span>)<input name="scheduledAt" type="datetime-local" required /></label>
          </div><div class="site-profile-counts"><span>Client timezone <b id="siteScheduleTimezone"></b></span></div>`, `${icon("play")}Schedule job`));
        document.body.insertAdjacentHTML("beforeend", modal("siteImportModal", "Import result", `
          <p class="meta" id="siteImportName"></p><div class="grid2">
            <label>Reported rank (optional)<input name="rank" type="number" min="1" max="10000" step="1" /></label>
            <label>Captured time (<span id="siteImportZone"></span>)<input name="capturedAt" type="datetime-local" required /></label>
            <label class="span2">Evidence URL (HTTPS, optional)<input name="evidenceUrl" type="url" maxlength="2000" placeholder="https://" /></label>
            <label class="span2">Raw result JSON<textarea name="raw" required spellcheck="false" placeholder='{"keyword":"...","observations":[]}'></textarea></label>
          </div><div class="site-profile-counts"><span>Source <b>Manual import</b></span></div>`, `${icon("save")}Import result`));
        document.body.insertAdjacentHTML("beforeend", modal("siteResolveModal", "Resolve uncertain job", `<p class="meta" id="siteResolveName"></p><label class="site-check-label"><input name="remoteStopped" type="checkbox" required />I stopped or confirmed completion of the remote DuoPlus task</label>`, `${icon("check")}Resolve job`));
      }

      function setSection(section) {
        s.active = section === "sites";
        byId("sitesWorkspace").hidden = !s.active;
        byId("devicesWorkspace").hidden = section !== "devices";
        byId("warmupWorkspace").hidden = section !== "warmup";
        document.body.dataset.workspaceSection = section;
        byId("workspaceSectionLabel").textContent = s.active ? "Client operations" : section === "warmup" ? "Profile preparation" : "Device operations";
        document.querySelectorAll("[data-workspace-section]").forEach((button) => {
          const active = button.dataset.workspaceSection === section;
          button.classList.toggle("active", active);
          button.setAttribute("aria-pressed", String(active));
        });
        if (s.active) { ensureMap(); requestAnimationFrame(() => { s.map?.invalidateSize(); if (!s.fitted) fitMap(); }); reload().catch(() => {}); }
        else if (section === "devices") showDevices();
        document.dispatchEvent(new Event("workspacechange"));
      }

      function ensureMap() {
        if (s.map || !s.active) return;
        s.map = L.map("sitesMap", { zoomControl: true, attributionControl: true }).setView([28.0395, -81.9498], 12);
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', referrerPolicy: "strict-origin-when-cross-origin" }).addTo(s.map);
        s.layer = L.layerGroup().addTo(s.map);
      }

      function fitMap() {
        if (!s.map || !s.active) return;
        const sites = (s.view === "sites" ? matchingSites() : s.sites).filter(point);
        if (!sites.length) return;
        s.map.invalidateSize();
        s.map.fitBounds(sites.map((site) => [site.lat, site.lng]), { padding: [42, 42], maxZoom: 16, animate: false });
        s.fitted = true;
      }

      function renderMap() {
        ensureMap();
        if (!s.layer) return;
        s.layer.clearLayers();
        const comparable = Boolean(s.keyword && s.resultApp);
        document.querySelector(".sites-map-key").innerHTML = s.view === "results" ? `${!comparable ? "<strong>Choose keyword and app</strong>" : `<strong>${escape(s.keyword)} / ${escape(s.resultApp)}</strong>`}<span><i class="dot site-rank-dot"></i>Latest reported rank</span><span><i class="dot site-unreported-dot"></i>Not reported</span>` : '<span><i class="dot live"></i>Client</span>';
        const sites = s.view === "sites" ? matchingSites() : s.sites;
        for (const site of sites.filter(point)) {
          const result = s.view === "results" && comparable ? resultForSite(site.id) : null;
          let marker;
          if (s.view === "results") {
            const reported = rankText(result) !== "Not reported";
            marker = L.marker([site.lat, site.lng], { icon: L.divIcon({ className: "", html: `<div class="site-rank-marker${reported ? "" : " unreported"}">${reported ? escape(rankText(result)) : "?"}</div>`, iconSize: [36, 36], iconAnchor: [18, 18] }), title: `${site.name}: ${rankText(result)}` });
          } else marker = L.circleMarker([site.lat, site.lng], { radius: s.selectedId === site.id ? 9 : 7, color: "#ffffff", weight: 2, fillColor: s.selectedId === site.id ? "#406bc2" : "#087d69", fillOpacity: 1 });
          const popup = document.createElement("div");
          const name = document.createElement("strong"); name.textContent = site.name; popup.append(name);
          const status = document.createElement("div"); status.textContent = s.view === "results" ? `Rank: ${rankText(result)}` : labels[site.status] || site.status || "Unknown"; popup.append(status);
          if (result) { const source = document.createElement("div"); source.textContent = `${result.keyword || ""} | ${sourceText(result)}`; popup.append(source); }
          marker.bindPopup(popup).on("click", () => selectSite(site.id, result?.id, false)).addTo(s.layer);
        }
        if (!s.fitted) fitMap();
      }

      function renderRecords() {
        const enabled = s.sites.filter((site) => site.enabled).length;
        byId("sitesSummary").textContent = s.authenticated ? `${s.sites.length} clients / ${enabled} jobs enabled` : "Log in to your workspace";
        byId("siteCreate").disabled = !s.authenticated || s.busy;
        byId("sitesReload").disabled = !s.authenticated || s.busy || Boolean(s.loading);
        if (!s.authenticated) { byId("siteRecords").innerHTML = '<div class="empty">Log in to view clients.</div>'; return; }
        if (s.view === "sites") {
          const sites = matchingSites();
          byId("siteRecords").innerHTML = sites.length ? `<table class="site-table"><thead><tr><th scope="col">Client / device</th><th scope="col" class="site-status-col">Profile</th><th scope="col" class="site-enabled-col">Jobs</th></tr></thead><tbody>${sites.map((site) => `<tr class="${s.selectedId === site.id ? "selected" : ""}"><td><button type="button" class="site-row-title" data-select-site="${escape(site.id)}" aria-pressed="${s.selectedId === site.id}">${escape(site.name)}</button><small>${escape([site.street, site.zip].filter(Boolean).join(", ") || `${site.lat}, ${site.lng}`)}</small><small>${escape(site.device?.name || site.device?.imageId || "Device unavailable")}</small></td><td>${statusChip(site.status)}<small>${site.profileRevision ? `Revision ${escape(site.profileRevision)}` : "No prepared profile"}</small></td><td><label class="site-enabled-toggle" title="${site.enabled ? "Disable" : "Enable"} jobs for ${escape(site.name)}"><input type="checkbox" data-enable-site="${escape(site.id)}" aria-label="Enable jobs for ${escape(site.name)}"${site.enabled ? " checked" : ""}${disable()} /></label></td></tr>`).join("")}</tbody></table>` : `<div class="empty">${s.sites.length ? "No clients match this search." : "No clients yet."}</div>`;
        } else {
          byId("siteRecords").innerHTML = s.results.length ? `<table class="site-table"><thead><tr><th scope="col">Client / keyword</th><th scope="col" class="site-rank-col">Rank</th><th scope="col" class="site-source-col">Evidence source</th></tr></thead><tbody>${s.results.map((result) => `<tr class="${s.resultId === result.id ? "selected" : ""}"><td><button type="button" class="site-row-title" data-select-site="${escape(result.site?.id)}" data-select-result="${escape(result.id)}">${escape(result.site?.name || "Client unavailable")}</button><small>${escape(result.keyword || "Keyword not reported")}</small><small>${escape(result.app || "App not reported")}</small></td><td>${escape(rankText(result))}</td><td>${escape(sourceText(result))}<small>${escape(dateText(result.capturedAt))}</small></td></tr>`).join("")}</tbody></table>` : '<div class="empty">No results reported for this selection.</div>';
        }
      }

      function resultHtml(result) {
        const url = safeUrl(result.evidenceUrl);
        return `<div class="site-profile-counts"><span>Rank <b>${escape(rankText(result))}</b></span><span>Source <b>${escape(sourceText(result))}</b></span><span>Captured <b>${escape(dateText(result.capturedAt))}</b></span></div>${url ? `<a class="site-evidence-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${icon("arrow-up-right")}Open evidence</a>` : ""}${jsonDetails("Raw result", result.raw)}${jsonDetails("Provenance", result.provenance)}`;
      }

      function renderInspector(force = false) {
        const site = currentSite();
        if (!site) { byId("siteInspector").innerHTML = '<div class="empty">Select a client.</div>'; s.inspectorSignature = ""; return; }
        const jobs = siteJobs(site);
        const selectedResult = s.results.find((result) => result.id === s.resultId && result.site?.id === site.id);
        const signature = JSON.stringify([site, jobs, selectedResult, s.busy, s.readiness]);
        if (!force && (signature === s.inspectorSignature || s.settingsDirty)) return;
        const scroll = byId("siteInspector").scrollTop;
        s.inspectorSignature = signature;
        const profile = site.profile;
        const warnings = Array.isArray(profile?.warnings) ? profile.warnings : [];
        const canSchedule = site.enabled && s.readiness?.ready === true;
        const canApply = Boolean(profile && site.profileRevision && site.status === "PREPARED");
        const source = typeof profile?.source === "string" ? profile.source : profile?.source?.type;
        byId("siteInspector").innerHTML = `
          <div class="site-inspector-heading"><div><h3>${escape(site.name)}</h3><p class="meta">${escape([site.street, site.zip].filter(Boolean).join(", ") || "Address not supplied")}</p></div>${statusChip(site.status)}</div>
          <dl class="site-facts"><dt>Device</dt><dd>${escape(site.device?.name || site.device?.imageId || "Unavailable")}</dd><dt>Last provider power</dt><dd>${escape(powerText(site.device?.duoPlusStatus))}</dd><dt>Coordinates</dt><dd>${escape(site.lat)}, ${escape(site.lng)}</dd><dt>Proxy</dt><dd>${escape(site.proxyIp || "Not configured")}${site.proxyId ? ` / ${escape(site.proxyId)}` : ""}</dd><dt>Timezone / language</dt><dd>${escape(site.timezone)} / ${escape(site.lang)}</dd><dt>Elevation</dt><dd>${site.elevationM == null ? "Not supplied" : `${escape(site.elevationM)} m`}</dd><dt>Motion</dt><dd>${escape(site.motion || "STILL")}</dd></dl>
          <section class="site-section"><div class="site-section-heading"><h4>Environment profile</h4><span class="meta">${site.profileRevision ? `Revision ${escape(site.profileRevision)}` : "Not prepared"}</span></div>
            ${profile ? `<div class="site-profile-counts"><span>Wi-Fi <b>${escape(profile.records?.wifi ?? "Not reported")}</b></span><span>Cell <b>${escape(profile.records?.cell ?? "Not reported")}</b></span><span>Bluetooth <b>${escape(profile.records?.bluetooth ?? "Not reported")}</b></span></div><p class="site-inline-message">${escape(source === "SAVED_LIBRARY" ? "Saved library" : source || "Source not reported")} / ${escape(dateText(profile.checkedAt))}</p><dl class="site-facts"><dt>Selected Wi-Fi</dt><dd>${profile.wifi ? `${escape(profile.wifi.ssid)} / ${escape(profile.wifi.bssid)}` : "No eligible observation"}</dd><dt>Phone Wi-Fi MAC</dt><dd>${escape(profile.phoneWifiMac || "Not reported")}</dd><dt>Cell reference</dt><dd>${profile.cell ? `${escape(profile.cell.radio)} / MCC ${escape(profile.cell.mcc)} / MNC ${escape(profile.cell.mnc)}` : "Not available"}</dd></dl>` : ""}
            <div class="site-action-row">${iconButton("prepare", "eye", "Preview cached WiGLE")}${iconButton("refresh", "refresh-cw", "Refresh WiGLE library")}<button type="button" class="btn" data-site-action="apply"${s.busy || !canApply ? " disabled" : ""}>${icon("check-check")}Apply profile</button></div>
            ${["API_ACCEPTED", "UNCONFIRMED"].includes(site.status) ? '<p class="site-warning">Device settings are not yet confirmed by provider readback.</p>' : ""}
            ${site.lastError || site.error ? `<p class="site-warning">${escape(site.lastError || site.error)}</p>` : ""}
            ${warnings.map((warning) => `<p class="site-warning">${escape(typeof warning === "string" ? warning : JSON.stringify(warning))}</p>`).join("")}
            <label class="site-check-label"><input type="checkbox" data-site-weekly${site.weeklyRefresh ? " checked" : ""}${disable()} />Refresh WiGLE library weekly</label>
            ${jsonDetails("Prepared profile", profile)}
          </section>
          <section class="site-section"><div class="site-section-heading"><h4>Jobs</h4><button type="button" class="btn ghost" data-site-action="schedule"${s.busy || !canSchedule ? " disabled" : ""}>${icon("plus")}Schedule job</button></div>
            <label class="site-check-label"><input type="checkbox" data-enable-site="${escape(site.id)}"${site.enabled ? " checked" : ""}${disable()} />Jobs enabled</label>
            ${!site.templateId ? '<p class="site-warning">Automation template ID is not configured.</p>' : ""}
            ${jobs.length ? jobs.map((job) => {
              const result = job.result || s.results.find((item) => item.jobId === job.id);
              const cancel = job.status === "QUEUED";
              const canImport = ["AWAITING_RESULT", "UNCONFIRMED", "TIMED_OUT"].includes(job.status) && !result;
              const resolve = ["UNCONFIRMED", "TIMED_OUT"].includes(job.status);
              return `<article class="site-job"><div class="site-job-heading"><strong>${escape(job.keyword)}</strong>${statusChip(job.status)}</div><p class="meta">${escape(job.app)} / ${escape(job.motion || "STILL")} / ${escape(dateText(job.scheduledAt))}</p>${job.error ? `<p class="site-warning">${escape(job.error)}</p>` : ""}${result ? resultHtml(result) : '<p class="site-inline-message">Rank: Not reported</p>'}${jsonDetails("Preflight evidence", job.preflight)}<div class="site-action-row">${cancel ? iconButton("cancel", "x", "Cancel job", ` data-job-id="${escape(job.id)}"`) : ""}${canImport ? iconButton("import", "save", "Import result", ` data-job-id="${escape(job.id)}"`) : ""}${resolve ? iconButton("resolve", "check", "Resolve job", ` data-job-id="${escape(job.id)}"`) : ""}</div></article>`;
            }).join("") : '<p class="site-inline-message">No jobs scheduled.</p>'}
          </section>
          ${selectedResult ? `<section class="site-section"><div class="site-section-heading"><h4>Selected result</h4><span class="meta">${escape(selectedResult.keyword)}</span></div>${resultHtml(selectedResult)}</section>` : ""}
          <section class="site-section"><h4>Client settings</h4><form id="siteSettingsForm"><div class="site-settings-grid"><label class="span2">Client name<input name="name" value="${escape(site.name)}" maxlength="120" required /></label><label>Template ID<input name="templateId" value="${escape(site.templateId || "")}" maxlength="200" /></label><label>Elevation (m)<input name="elevationM" type="number" step="any" min="-500" max="9000" value="${escape(site.elevationM ?? "")}" /></label></div><div class="site-action-row"><button type="submit" class="btn ghost"${disable()}>${icon("save")}Save settings</button></div></form></section>`;
        if (s.settingsDraft) for (const [name, value] of Object.entries(s.settingsDraft)) byId("siteSettingsForm").elements[name].value = value;
        byId("siteInspector").scrollTop = scroll;
      }

      function render(force = false) {
        const warning = byId("sitesReadiness");
        warning.hidden = !s.authenticated || s.readiness?.ready === true;
        warning.textContent = s.readiness ? `Job scheduling unavailable. ${(s.readiness.issues || []).join(" ")}` : "Job scheduling readiness has not been confirmed. Reload clients to check configuration.";
        renderRecords(); renderMap(); renderInspector(force);
      }

      function selectSite(id, resultId = null, focus = true) {
        if (!s.sites.some((site) => site.id === id)) return;
        const changed = s.selectedId !== id;
        s.selectedId = id; s.resultId = resultId || null;
        if (changed) { s.settingsDirty = false; s.settingsDraft = null; s.inspectorSignature = ""; }
        render();
        const site = currentSite();
        if (focus && s.active && point(site)) s.map?.setView([site.lat, site.lng], Math.max(s.map.getZoom(), 14), { animate: false });
      }

      async function reload(force = false) {
        if (!s.authenticated || (!force && (document.hidden || !s.active || Date.now() - s.lastLoad < 10000))) return;
        if (s.loading) return s.loading;
        const version = s.version;
        const keyword = s.keyword;
        const resultApp = s.resultApp;
        const query = new URLSearchParams();
        if (keyword) query.set("keyword", keyword);
        if (resultApp) query.set("app", resultApp);
        const pending = (async () => {
          try {
            const [snapshot, results] = await Promise.all([api("/api/sites"), api(`/api/site-results${query.size ? `?${query}` : ""}`)]);
            if (version !== s.version || keyword !== s.keyword || resultApp !== s.resultApp) return;
            s.readiness = snapshot.readiness || null;
            s.sites = Array.isArray(snapshot.sites) ? snapshot.sites.map((site) => ({ ...site, status: site.profileStatus, lang: site.language, motion: site.state, lastError: site.profileError })) : [];
            s.devices = Array.isArray(snapshot.devices) ? snapshot.devices : [];
            s.jobs = Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
            s.results = Array.isArray(results.results) ? results.results : [];
            if (!s.sites.some((site) => site.id === s.selectedId)) { s.selectedId = s.sites[0]?.id || null; s.settingsDirty = false; s.settingsDraft = null; }
            s.lastLoad = Date.now();
            render();
            return true;
          } catch (error) {
            if (version === s.version) { message(`Client data could not be refreshed: ${error.message}`, true); s.lastLoad = Date.now(); }
            return false;
          } finally {
            if (version === s.version) { s.loading = null; byId("sitesReload").disabled = !s.authenticated || s.busy; }
          }
        })();
        s.loading = pending;
        byId("sitesReload").disabled = true;
        return pending;
      }

      async function run(path, method, body, success) {
        if (s.busy || !s.authenticated) return false;
        const version = s.version;
        s.busy = true; message(); render(true);
        try {
          const result = await api(path, { method, body: JSON.stringify(body || {}) });
          if (version !== s.version) return false;
          if (s.loading) await s.loading;
          const refreshed = await reload(true);
          if (version !== s.version) return false;
          message(`${success}${refreshed === false ? " Latest client status could not be loaded. Reload to check it." : ""}`);
          return result;
        } catch (error) {
          if (version === s.version) message(error.message, true);
          throw error;
        } finally {
          if (version === s.version) { s.busy = false; render(true); }
        }
      }

      function openSiteModal(id) {
        returnFocus = document.activeElement;
        modalMessage(`${id}Error`);
        openModal(id);
      }

      function closeSiteModal(id) {
        if (!byId(id) || byId(id).dataset.submitting === "true") return;
        closeModal(id);
        if (returnFocus?.isConnected) returnFocus.focus();
      }

      function openCreate() {
        if (!s.authenticated || s.busy) return;
        const form = byId("siteCreateModalForm"); form.reset();
        const used = new Set(s.sites.map((site) => site.deviceId || site.device?.id));
        const devices = s.devices.filter((device) => !used.has(device.id));
        form.elements.deviceId.innerHTML = `<option value="">${devices.length ? "Select a device" : "No unassigned devices"}</option>${devices.map((device) => `<option value="${escape(device.id)}">${escape(device.name || device.imageId || device.id)}</option>`).join("")}`;
        openSiteModal("siteCreateModal");
      }

      function openSchedule(site) {
        if (!s.readiness?.ready) { message("Job scheduling is unavailable until the configuration issues above are resolved.", true); return; }
        if (!site.enabled) return;
        const form = byId("siteScheduleModalForm"); form.reset();
        form.dataset.siteId = site.id;
        form.dataset.idempotencyKey = crypto.randomUUID();
        const now = new Date();
        form.elements.scheduledAt.min = localDate(now);
        form.elements.scheduledAt.value = localDate(new Date(now.getTime() + 5 * 60000));
        byId("siteScheduleName").textContent = site.name;
        byId("siteScheduleZone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
        byId("siteScheduleTimezone").textContent = site.timezone;
        openSiteModal("siteScheduleModal");
      }

      function openImport(job) {
        if (!job) return;
        const form = byId("siteImportModalForm"); form.reset();
        form.dataset.jobId = job.id;
        form.elements.capturedAt.value = localDate(new Date());
        byId("siteImportName").textContent = `${currentSite()?.name || "Client"} / ${job.keyword}`;
        byId("siteImportZone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
        openSiteModal("siteImportModal");
      }

      function openResolve(job) {
        if (!job) return;
        const form = byId("siteResolveModalForm"); form.reset();
        form.dataset.jobId = job.id;
        byId("siteResolveName").textContent = `${currentSite()?.name || "Client"} / ${job.keyword}`;
        openSiteModal("siteResolveModal");
      }

      async function submitModal(event, id, callback) {
        event.preventDefault();
        const form = event.target;
        if (!form.reportValidity() || byId(id).dataset.submitting === "true" || s.busy) return;
        const version = s.version;
        const data = new FormData(form);
        byId(id).dataset.submitting = "true";
        form.querySelectorAll("input, select, textarea, button").forEach((control) => { control.disabled = true; });
        modalMessage(`${id}Error`);
        try {
          const result = await callback(data, form);
          if (version !== s.version || result === false) return;
          byId(id).dataset.submitting = "false";
          closeSiteModal(id);
        } catch (error) {
          if (version === s.version) modalMessage(`${id}Error`, error.message);
        } finally {
          if (version === s.version) {
            byId(id).dataset.submitting = "false";
            form.querySelectorAll("input, select, textarea, button").forEach((control) => { control.disabled = false; });
          }
        }
      }

      mountDialogs();
      document.querySelectorAll("[data-workspace-section]").forEach((button) => button.addEventListener("click", () => setSection(button.dataset.workspaceSection)));
      byId("sitesReload").addEventListener("click", () => { message(); reload(true); });
      byId("siteCreate").addEventListener("click", openCreate);
      byId("sitesMapFit").addEventListener("click", fitMap);
      byId("siteSearch").addEventListener("input", () => { renderRecords(); renderMap(); });
      byId("siteResultFilter").addEventListener("submit", async (event) => {
        event.preventDefault();
        s.keyword = new FormData(event.target).get("keyword").trim();
        s.resultApp = new FormData(event.target).get("app");
        s.results = []; s.resultId = null;
        s.fitted = false;
        renderRecords(); renderMap();
        if (s.loading) await s.loading;
        await reload(true);
      });
      document.querySelectorAll("[data-site-view]").forEach((button) => button.addEventListener("click", () => {
        s.view = button.dataset.siteView;
        document.querySelectorAll("[data-site-view]").forEach((tab) => { tab.classList.toggle("active", tab.dataset.siteView === s.view); tab.setAttribute("aria-pressed", String(tab.dataset.siteView === s.view)); });
        byId("siteSearchLabel").hidden = s.view !== "sites";
        byId("siteResultFilter").hidden = s.view !== "results";
        renderRecords(); renderMap();
      }));
      byId("siteRecords").addEventListener("click", (event) => {
        const button = event.target.closest("[data-select-site]");
        if (button) selectSite(button.dataset.selectSite, button.dataset.selectResult);
      });
      byId("sitesWorkspace").addEventListener("change", async (event) => {
        const enable = event.target.closest("[data-enable-site]");
        const weekly = event.target.closest("[data-site-weekly]");
        const site = enable ? s.sites.find((item) => item.id === enable.dataset.enableSite) : weekly ? currentSite() : null;
        if (!site) return;
        const checked = event.target.checked;
        try { await run(sitePath(site), "PATCH", enable ? { enabled: checked } : { weeklyRefresh: checked }, enable ? `Jobs ${checked ? "enabled" : "disabled"} for ${site.name}.` : `Weekly WiGLE refresh ${checked ? "enabled" : "disabled"}.`); } catch { render(true); }
      });
      byId("siteInspector").addEventListener("input", (event) => {
        const form = event.target.closest("#siteSettingsForm");
        if (form) { s.settingsDirty = true; s.settingsDraft = Object.fromEntries(new FormData(form)); }
      });
      byId("siteInspector").addEventListener("submit", async (event) => {
        if (event.target.id !== "siteSettingsForm") return;
        event.preventDefault();
        if (!event.target.reportValidity() || s.busy) return;
        const data = new FormData(event.target);
        const site = currentSite();
        const body = { name: data.get("name").trim(), templateId: data.get("templateId").trim() || null, elevationM: data.get("elevationM") === "" ? null : Number(data.get("elevationM")) };
        try {
          const result = await run(sitePath(site), "PATCH", body, "Client settings saved.");
          if (result !== false) { s.settingsDirty = false; s.settingsDraft = null; renderInspector(true); }
        } catch { /* The draft remains available alongside the server error. */ }
      });
      byId("siteInspector").addEventListener("click", async (event) => {
        const button = event.target.closest("[data-site-action]");
        const site = currentSite();
        if (!button || !site || s.busy) return;
        const action = button.dataset.siteAction;
        if (action === "schedule") return openSchedule(site);
        if (action === "import") return openImport(s.jobs.find((job) => job.id === button.dataset.jobId));
        if (action === "resolve") return openResolve(s.jobs.find((job) => job.id === button.dataset.jobId));
        try {
          if (action === "prepare") await run(sitePath(site, "/prepare"), "POST", {}, "Cached WiGLE profile prepared. Review it before applying.");
          else if (action === "refresh") await run(sitePath(site, "/refresh"), "POST", {}, "WiGLE library refreshed. Preview cached WiGLE to prepare a new profile.");
          else if (action === "apply") await run(sitePath(site, "/apply"), "POST", { revision: site.profileRevision }, "Profile request completed. Provider verification is shown in the client status.");
          else if (action === "cancel") await run(`/api/site-jobs/${encodeURIComponent(button.dataset.jobId)}/cancel`, "POST", {}, "Job cancellation recorded.");
        } catch { /* The shared message retains the server error. */ }
      });
      document.querySelectorAll("[data-close-site-modal]").forEach((button) => button.addEventListener("click", () => closeSiteModal(button.dataset.closeSiteModal)));
      byId("siteCreateModalForm").elements.deviceId.addEventListener("change", (event) => {
        const device = s.devices.find((item) => item.id === event.target.value);
        if (!device) return;
        const form = byId("siteCreateModalForm");
        for (const [field, value] of Object.entries({ lat: device.anchorLat, lng: device.anchorLng, proxyIp: device.proxyIp, timezone: device.timezone, language: device.language })) {
          if (value !== null && value !== undefined && value !== "") form.elements[field].value = value;
        }
      });
      byId("siteCreateModalForm").addEventListener("submit", (event) => submitModal(event, "siteCreateModal", async (data) => {
        const body = Object.fromEntries(data);
        for (const key of ["lat", "lng"]) body[key] = Number(body[key]);
        body.elevationM = body.elevationM === "" ? null : Number(body.elevationM);
        for (const key of ["name", "deviceId", "street", "zip", "proxyIp", "timezone", "language"]) body[key] = body[key].trim();
        for (const key of ["proxyId", "templateId"]) body[key] = body[key].trim() || null;
        const result = await run("/api/sites", "POST", body, "Client created with jobs disabled.");
        const created = result?.site || result;
        if (created?.id) selectSite(created.id);
        return result;
      }));
      byId("siteScheduleModalForm").addEventListener("submit", (event) => submitModal(event, "siteScheduleModal", async (data, form) => {
        const date = new Date(data.get("scheduledAt"));
        if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now()) throw new Error("Choose a scheduled time in the future.");
        return run(`/api/sites/${encodeURIComponent(form.dataset.siteId)}/jobs`, "POST", { keyword: data.get("keyword").trim(), app: data.get("app"), motion: "STILL", scheduledAt: date.toISOString(), idempotencyKey: form.dataset.idempotencyKey }, "Job scheduled. Results remain unreported until evidence arrives.");
      }));
      byId("siteImportModalForm").addEventListener("submit", (event) => submitModal(event, "siteImportModal", async (data, form) => {
        let raw;
        try { raw = JSON.parse(data.get("raw")); } catch { throw new Error("Raw result must contain valid JSON."); }
        if (!raw || Array.isArray(raw) || typeof raw !== "object") throw new Error("Raw result must be a JSON object.");
        const url = data.get("evidenceUrl").trim();
        if (url && !safeUrl(url)) throw new Error("Evidence URL must use HTTPS without embedded credentials.");
        const captured = new Date(data.get("capturedAt"));
        if (!Number.isFinite(captured.getTime())) throw new Error("Choose a valid captured time.");
        return run(`/api/site-jobs/${encodeURIComponent(form.dataset.jobId)}/result`, "POST", { rank: data.get("rank") === "" ? null : Number(data.get("rank")), raw, ...(url ? { evidenceUrl: safeUrl(url) } : {}), capturedAt: captured.toISOString() }, "Result saved with manual import provenance.");
      }));
      byId("siteResolveModalForm").addEventListener("submit", (event) => submitModal(event, "siteResolveModal", async (data, form) => {
        if (data.get("remoteStopped") !== "on") throw new Error("Confirm the remote DuoPlus task has stopped or completed.");
        return run(`/api/site-jobs/${encodeURIComponent(form.dataset.jobId)}/resolve`, "POST", { remoteStopped: true }, "Uncertain job resolved.");
      }));
      window.addEventListener("resize", () => { if (s.active) s.map?.invalidateSize(); });
      setSection("warmup");

      return {
        update() { s.authenticated = true; byId("siteCreate").disabled = s.busy; reload(); },
        reload: () => reload(true),
        closeModal: closeSiteModal,
        clear() {
          s.version += 1; s.authenticated = false; s.loading = null; s.busy = false; s.lastLoad = 0;
          s.readiness = null; byId("sitesReadiness").hidden = true; s.sites = []; s.devices = []; s.jobs = []; s.results = []; s.selectedId = null; s.resultId = null; s.fitted = false; s.settingsDirty = false; s.settingsDraft = null; s.inspectorSignature = ""; s.keyword = ""; s.resultApp = "";
          byId("siteSearch").value = ""; byId("siteResultFilter").reset();
          byId("siteCreateModalForm").elements.deviceId.textContent = "";
          for (const id of ["siteScheduleName", "siteScheduleTimezone", "siteImportName", "siteResolveName"]) byId(id).textContent = "";
          s.map?.closePopup();
          for (const id of ["siteCreateModal", "siteScheduleModal", "siteImportModal", "siteResolveModal"]) {
            byId(id).dataset.submitting = "false"; byId(`${id}Form`).reset();
            byId(id).querySelectorAll("input, select, textarea, button").forEach((control) => { control.disabled = false; });
            closeModal(id);
          }
          message(); render(true);
        },
      };
    },
  };
})();
