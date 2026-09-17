(function (root) {
  "use strict";

  const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const point = (value) => value && Number.isFinite(value.lat) && Math.abs(value.lat) <= 90 && Number.isFinite(value.lng) && Math.abs(value.lng) <= 180 ? { lat: value.lat, lng: value.lng } : null;
  const coordinates = (value) => point(value) ? `${value.lat.toFixed(6)}, ${value.lng.toFixed(6)}` : "Not recorded";
  const duration = (ms) => Number.isFinite(ms) && ms >= 0 ? `${Math.ceil(ms / 60000)} min` : "Unknown";
  const distance = (meters) => !Number.isFinite(meters) || meters < 0 ? "Unknown" : meters >= 1609.344 ? `${(meters / 1609.344).toFixed(1)} mi` : meters > 0 && meters < 1 ? "<1 m" : `${Math.round(meters)} m`;
  function elapsed(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "Unknown";
    const seconds = Math.floor(ms / 1000);
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
  }
  const timestamp = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Not recorded";
  const statusName = (status) => ({ PREVIEW: "Preview", RUNNING: "Running", PAUSED: "Paused", ARRIVING: "Arriving", ARRIVED: "Arrived", CANCELLED: "Cancelled", FAILED: "Failed" })[status] || "No trip";
  const activeTrip = (trip) => ["RUNNING", "PAUSED", "ARRIVING"].includes(trip?.status);

  function destination(draft) {
    if (draft.destinationMode === "coordinates") {
      const result = draft.lat?.trim() && draft.lng?.trim() ? point({ lat: Number(draft.lat), lng: Number(draft.lng) }) : null;
      if (!result) throw new Error("Enter valid destination latitude and longitude.");
      return result;
    }
    if (!String(draft.address || "").trim()) throw new Error("Enter a destination address.");
    const selected = point(draft.addressSelection);
    if (!selected) throw new Error("Search for the address and select a destination result.");
    return selected;
  }

  function tripOptions(draft) {
    const number = (value, min, max, label) => {
      const parsed = typeof value === "string" && value.trim() ? Number(value) : NaN;
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new Error(`${label} must be between ${min} and ${max}.`);
      return parsed;
    };
    return {
      timeScale: number(draft.timeScale, 1, 2, "Time scale"),
      maxSpeedMps: number(draft.maxSpeedMph, 3, 89, "Modeled speed cap") * 0.44704,
      accelerationMps2: number(draft.accelerationMps2, 0.1, 5, "Acceleration"),
      decelerationMps2: number(draft.decelerationMps2, 0.1, 8, "Deceleration"),
    };
  }

  function origin(device) {
    return { coordinates: point({ lat: device?.currentLat, lng: device?.currentLng }), source: "Controller position" };
  }

  function evidence(trip) {
    const telemetry = trip?.latestRequested || trip?.locationTelemetry;
    const accepted = trip?.latestAccepted || (telemetry?.status === "API_ACCEPTED" ? telemetry : null);
    const observed = trip?.androidObservation || telemetry?.androidObservation;
    const readback = trip?.phoneSync?.gps?.observation;
    const runtimePoint = point(readback?.point);
    const useReadback = runtimePoint && (!point(observed) || Date.parse(readback.checkedAt) >= Date.parse(observed.capturedAt));
    return {
      requested: point(trip?.requestedCoordinates) || point(telemetry),
      accepted: trip?.playbackMode === "DEVICE_PLAYER" ? point({ lat: trip.acceptedLat, lng: trip.acceptedLng }) : point(trip?.acceptedCoordinates) || point(accepted),
      observed: useReadback ? runtimePoint : point(observed),
      requestedAt: telemetry?.requestedAt,
      acceptedAt: trip?.playbackMode === "DEVICE_PLAYER" ? trip.phoneSync?.player?.checkedAt : accepted?.acceptedAt,
      observedAt: useReadback ? readback.checkedAt : observed?.capturedAt,
      observedSource: useReadback ? `Runtime readback${readback.provider ? ` (${readback.provider})` : ""}` : ({ MANUAL_ADB: "Manual ADB", DIAGNOSTIC_APK: "Diagnostic APK" })[observed?.source] || "Android observation",
      observedAgeMs: useReadback ? readback.ageMs : observed?.fixAgeMs,
      observedAccuracyM: useReadback ? readback.accuracyMeters : observed?.horizontalAccuracyM,
    };
  }

  function markup(icon) {
    return `<div class="driving-heading"><div><span class="eyebrow">Road trip</span><h3>Driving</h3></div><button type="button" class="btn ghost icon-button" data-driving-action="fit" title="Fit route on map" aria-label="Fit route on map">${icon("crosshair")}</button></div>
      <div id="drivingConfig" class="form-message" role="status"></div>
      <button id="drivingConfigRetry" type="button" class="btn ghost tiny" data-driving-action="retry" hidden>${icon("refresh-cw")} Retry routing connection</button>
      <div class="driving-origin"><span class="driving-origin-dot"></span><div><strong>Origin</strong><span id="drivingOriginSource"></span><code id="drivingOrigin"></code></div></div>
      <form id="drivingForm" class="driving-form">
        <fieldset id="drivingInputs"><legend class="sr-only">Trip settings</legend>
          <label for="drivingDestinationMode">Destination</label><div class="driving-destination-row"><select id="drivingDestinationMode" aria-label="Destination input"><option value="address">Address</option><option value="coordinates">Coordinates</option></select><button type="button" class="btn ghost icon-button" data-driving-action="pick" title="Choose destination on map" aria-label="Choose destination on map">${icon("map-pin")}</button></div>
          <div id="drivingAddressField"><div class="driving-address-row"><label><span class="sr-only">Destination address</span><input id="drivingAddress" placeholder="Street address, city" autocomplete="off" maxlength="200" /></label><button id="drivingSearch" type="button" class="btn ghost icon-button" data-driving-action="search" title="Search destination address" aria-label="Search destination address">${icon("search")}</button></div><div id="drivingSearchFeedback" class="form-message" role="status"></div><div id="drivingAddressResults" class="driving-address-results"></div><div id="drivingSelectedAddress" class="meta"></div></div>
          <div id="drivingCoordinateFields" class="driving-grid" hidden><label>Latitude<input id="drivingLat" type="number" min="-90" max="90" step="any" /></label><label>Longitude<input id="drivingLng" type="number" min="-180" max="180" step="any" /></label></div>
          <div class="driving-grid driving-options"><label>Time scale<select id="drivingTimeScale"><option value="1">1x real time</option><option value="1.25">1.25x accelerated</option><option value="1.5">1.5x accelerated</option><option value="2">2x accelerated</option></select></label><label>Modeled speed cap<div class="driving-unit"><input id="drivingMaxSpeedMph" type="number" min="3" max="89" step="1" /><span>mph</span></div></label></div>
          <div id="drivingAccelerated" class="driving-caution" hidden>Accelerated simulation</div>
          <label class="driving-opt-in"><input id="drivingOpenMaps" type="checkbox" checked /> Open Maps on phone</label>
          <details class="driving-advanced"><summary>${icon("sliders-horizontal")} Advanced</summary><div class="driving-grid"><label>Acceleration (m/s²)<input id="drivingAccelerationMps2" type="number" min="0.1" max="5" step="0.1" /></label><label>Deceleration (m/s²)<input id="drivingDecelerationMps2" type="number" min="0.1" max="8" step="0.1" /></label></div><div class="driving-stops-heading"><span>Waypoint stops</span><button type="button" class="btn ghost icon-button" data-driving-action="add-stop" title="Add waypoint stop" aria-label="Add waypoint stop">${icon("plus")}</button></div><div id="drivingStops"></div></details>
        </fieldset>
        <button id="drivingPreview" type="submit" class="btn ghost driving-preview">${icon("route")} Preview route</button>
      </form>
      <div id="drivingFeedback" class="form-message" role="status" aria-live="polite"></div>
      <div id="drivingPhoneStatus" hidden><dl class="environment-fields"><dt>Maps on phone</dt><dd id="drivingMapsStatus" role="status"></dd><dt>Phone GPS</dt><dd id="drivingGpsStatus" role="status"></dd></dl></div>
      <div id="drivingProviderReadiness" class="meta" role="status" hidden></div>
      <div id="drivingTripError" class="form-message error" role="status" aria-live="polite" hidden></div>
      <div id="drivingActionBar" class="driving-actions" hidden><button id="drivingStart" type="button" class="btn" data-driving-action="start">${icon("play")} Drive</button><button id="drivingPause" type="button" class="btn ghost" data-driving-action="pause">${icon("pause")} Pause</button><button id="drivingResume" type="button" class="btn" data-driving-action="resume">${icon("play")} Resume</button><button id="drivingCancel" type="button" class="btn ghost" data-driving-action="cancel">${icon("x")} Cancel</button></div>
      <div id="drivingTripProgress" hidden><div class="driving-progress"><progress id="drivingProgress" max="100" value="0" aria-label="Trip progress"></progress><span id="drivingProgressLabel"></span></div><div id="drivingProgressAccepted" class="meta"></div></div>
      <label id="drivingAlternativeField" class="driving-alternative" hidden>Route<select id="drivingAlternative" aria-label="Choose route alternative"></select></label>
      <section id="drivingTrip" class="driving-trip" hidden><div id="drivingTripSummary"></div><button id="drivingAdopt" type="button" class="btn ghost driving-preview" data-driving-action="adopt-anchor">${icon("map-pin")} Adopt destination as anchor</button></section>
      <section id="drivingArrival" class="driving-arrival" hidden><div class="section-heading"><h3>Arrival Wi-Fi</h3><button id="drivingArrivalPreview" type="button" class="btn ghost icon-button" data-driving-action="arrival-preview" title="Preview destination Wi-Fi" aria-label="Preview destination Wi-Fi">${icon("search")}</button></div><div id="drivingArrivalStatus" class="meta"></div><label class="driving-opt-in"><input id="drivingArrivalEnabled" type="checkbox" /> Apply selected AP on arrival</label><select id="drivingArrivalSelection" aria-label="Arrival Wi-Fi access point"><option value="">Select an access point</option></select><div id="drivingArrivalInfo" class="meta"></div><div id="drivingArrivalFeedback" class="form-message" role="status"></div></section>
      <section id="drivingEvidence" class="driving-evidence" hidden><h3>Location evidence</h3><dl class="environment-fields"><dt>Latest request</dt><dd id="drivingRequested"></dd><dt id="drivingAcceptedLabel">API accepted</dt><dd id="drivingAccepted"></dd><dt>Android observed</dt><dd id="drivingObserved"></dd></dl></section>
      <details class="driving-automation"><summary>${icon("key-round")} Trip automation</summary><div class="driving-token-create"><label>Token label<input id="drivingTokenLabel" maxlength="80" placeholder="RPA trip trigger" autocomplete="off" /></label><button id="drivingTokenCreate" type="button" class="btn ghost" data-driving-action="token-create">${icon("plus")} Create token</button></div><div id="drivingTokenOnce" hidden><label>New device-scoped token<input id="drivingTokenSecret" type="password" readonly autocomplete="off" spellcheck="false" /></label><div class="actions"><button type="button" class="btn ghost icon-button" data-driving-action="token-copy" title="Copy new token" aria-label="Copy new token">${icon("copy")}</button><button type="button" class="btn ghost icon-button" data-driving-action="token-reveal" title="Show or hide token" aria-label="Show or hide token">${icon("eye")}</button><button type="button" class="btn ghost tiny" data-driving-action="token-dismiss">Done</button></div><div class="meta">Shown once. Scoped to this device.</div></div><div class="section-heading"><h3>Saved tokens</h3><button type="button" class="btn ghost icon-button" data-driving-action="token-list" title="Refresh trip tokens" aria-label="Refresh trip tokens">${icon("refresh-cw")}</button></div><div id="drivingTokenList"></div><div id="drivingTokenFeedback" class="form-message" role="status"></div></details>`;
  }

  function create(options) {
    const { api, icon, map, L } = options;
    const $ = (id) => document.getElementById(id);
    const drafts = new Map();
    let current = null;
    let active = false;
    let generation = 0;
    let config = null;
    let configPending = false;
    let configError = "";
    let mapSignature = "";
    let evidenceSignature = "";
    let mapDeviceId = "";
    const routeLayer = L.layerGroup();
    const evidenceLayer = L.layerGroup();

    function stateFor(device) {
      if (!drafts.has(device.id)) drafts.set(device.id, { destinationMode: "address", address: "", addressSelection: null, addressResults: [], searchPending: false, searchVersion: 0, searchError: "", lat: "", lng: "", timeScale: "1", maxSpeedMph: "55", accelerationMps2: "1.5", decelerationMps2: "2.5", openMaps: true, waypoints: [], version: 0, previewVersion: -1, trip: null, supersededRevisions: new Set(), pending: "", error: "", message: "", picking: false, arrival: null, arrivalPending: false, arrivalError: "", tokenPending: false, tokens: null, token: null, tokenError: "", tokenMessage: "" });
      return drafts.get(device.id);
    }
    function html(id, content) { if ($(id) && $(id).innerHTML !== content) $(id).innerHTML = content; }
    function text(id, value) { if ($(id)) $(id).textContent = value; }
    function field(id, value) { if ($(id) && $(id).value !== String(value ?? "")) $(id).value = value ?? ""; }
    function hidden(id, value) { if ($(id)) $(id).hidden = value; }
    function disabled(id, value) { if ($(id)) $(id).disabled = value; }
    function stillValid(device, value, stamp) { return generation === stamp && drafts.get(device.id) === value; }
    function renderIfCurrent(device) { if (device.id === current?.id) render(); }
    function staleTrip(value, trip) {
      if (value.supersededRevisions.has(`${trip.id}:${trip.revision}`)) return true;
      const previousTime = Date.parse(value.trip?.updatedAt);
      const nextTime = Date.parse(trip.updatedAt);
      return Number.isFinite(previousTime) && Number.isFinite(nextTime) && nextTime < previousTime;
    }
    function storeTrip(value, trip) {
      if (staleTrip(value, trip)) return false;
      if (value.trip && (value.trip.id !== trip.id || value.trip.revision !== trip.revision)) value.supersededRevisions.add(`${value.trip.id}:${value.trip.revision}`);
      value.trip = trip;
      return true;
    }
    function publish(device, value, trip) {
      if (!trip || trip.deviceId !== device.id) throw new Error("Trip response did not match the selected device.");
      if (storeTrip(value, trip)) options.onTrip?.(trip);
    }

    function setDraft(patch) {
      if (!current) return;
      const value = stateFor(current);
      if (activeTrip(value.trip) || value.pending || value.arrivalPending) return;
      if (Object.hasOwn(patch, "address")) { value.addressSelection = null; value.addressResults = []; value.searchVersion += 1; value.searchError = ""; }
      Object.assign(value, patch);
      value.version += 1;
      value.error = "";
      value.message = value.trip ? "Trip settings changed. Preview the route again before starting." : "";
      value.arrival = null;
      render();
    }

    async function loadConfig() {
      if (configPending || config || configError) return;
      const stamp = generation;
      configPending = true;
      render();
      try { const result = await api("/api/trips/config"); if (stamp === generation) config = result; }
      catch (error) { if (stamp === generation) configError = error.message; }
      finally { if (stamp === generation) { configPending = false; render(); } }
    }

    function clearMap() {
      routeLayer.clearLayers();
      map.removeLayer(routeLayer);
      mapSignature = "";
      evidenceLayer.clearLayers();
      map.removeLayer(evidenceLayer);
      evidenceSignature = "";
    }

    function fitMap() {
      if (!current || !active) return;
      const route = stateFor(current).trip?.route;
      const points = route?.provider === "OSRM" ? (route.points || []).filter(point) : [];
      map.invalidateSize();
      if (points.length) map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng])), { padding: [40, 64], maxZoom: 17, animate: false });
      else if (origin(current).coordinates) { const p = origin(current).coordinates; map.setView([p.lat, p.lng], 15, { animate: false }); }
    }

    function renderMap() {
      if (!active || !current) return;
      const value = stateFor(current);
      const route = value.trip?.route;
      const signature = JSON.stringify([current.id, value.trip?.id, route?.fetchedAt, route?.points, value.destinationMode, value.lat, value.lng, value.addressSelection]);
      if (signature !== mapSignature) {
        clearMap();
        mapSignature = signature;
        const hasRoute = route?.provider === "OSRM" && Array.isArray(route.points) && route.points.length > 1 && route.points.every(point);
        if (hasRoute) {
          L.polyline(route.points.map((p) => [p.lat, p.lng]), { color: "#b88628", weight: 6, opacity: 0.82, lineCap: "round", lineJoin: "round" }).addTo(routeLayer);
          if (point(route.origin)) L.circleMarker([route.origin.lat, route.origin.lng], { radius: 6, color: "#fff", weight: 2, fillColor: "#087d69", fillOpacity: 1 }).bindTooltip("Route origin").addTo(routeLayer);
        }
        let dest = point(route?.destination);
        try { if (!hasRoute) dest = destination(value); } catch { /* A destination is optional until the preview is requested. */ }
        if (dest) L.circleMarker([dest.lat, dest.lng], { radius: 9, color: "#8e651c", weight: 2, fillColor: "#fff7e5", fillOpacity: 1 }).bindTooltip("Driving destination").addTo(routeLayer);
        routeLayer.addTo(map);
        if (hasRoute) fitMap();
      }
      const data = evidence(value.trip);
      const nextEvidenceSignature = JSON.stringify([current.id, value.trip?.id, data]);
      if (nextEvidenceSignature !== evidenceSignature) {
        evidenceLayer.clearLayers();
        evidenceSignature = nextEvidenceSignature;
        if (data.accepted) L.circleMarker([data.accepted.lat, data.accepted.lng], { radius: 11, color: "#2463c6", weight: 3, fillOpacity: 0 }).bindTooltip(`API accepted GPS<br>${escape(coordinates(data.accepted))}<br>${escape(timestamp(data.acceptedAt))}`).addTo(evidenceLayer);
        if (data.observed) L.circleMarker([data.observed.lat, data.observed.lng], { radius: 6, color: "#fff", weight: 2, fillColor: "#087d69", fillOpacity: 1 }).bindTooltip(`Android observed GPS<br>${escape(coordinates(data.observed))}<br>${escape(data.observedSource)}<br>Checked ${escape(timestamp(data.observedAt))}`).addTo(evidenceLayer);
        evidenceLayer.addTo(map);
      }
      if (mapDeviceId !== current.id) { mapDeviceId = current.id; if (!route) fitMap(); }
    }

    function renderPhoneStatus(trip) {
      hidden("drivingPhoneStatus", !trip);
      const sync = trip?.phoneSync;
      const maps = sync?.maps;
      const gps = sync?.gps;
      const mapsLabel = !sync?.enabled ? "Not requested" : ({ PENDING: "Waiting to open Maps", OPENING: "Opening Maps", LAUNCH_ACCEPTED: "Maps launch accepted", FAILED: "Maps launch failed", UNKNOWN: "Maps launch unconfirmed" })[maps?.status] || "Maps launch unconfirmed";
      let gpsLabel = ({ PENDING: "Phone GPS check pending", MATCH: "Phone GPS matches checked request", WAITING: "Waiting for phone GPS match", UNAVAILABLE: "Phone GPS readback unavailable" })[gps?.status] || (sync?.enabled ? "Phone GPS check pending" : "Not requested");
      const player = sync?.player;
      if (player) gpsLabel = `DuoMove ${player.status?.state || "connecting"} · Applied ${player.status?.applied_seq ?? "—"} · Framework ${player.status?.framework_observed_seq ?? "—"} · Fused ${player.status?.fused_observed_seq ?? "—"} (player readback)`;
      for (const [id, label, state] of [["drivingMapsStatus", mapsLabel, maps], ["drivingGpsStatus", gpsLabel, gps]]) {
        html(id, `${escape(label)}${state?.reason ? `<span class="meta">${escape(state.reason)}</span>` : ""}${state?.checkedAt ? `<span class="meta">Checked ${escape(timestamp(state.checkedAt))}</span>` : ""}`);
        $(id)?.classList.toggle("error", state?.status === "FAILED");
        $(id)?.classList.toggle("warn", ["WAITING", "UNAVAILABLE", "UNKNOWN"].includes(state?.status));
      }
    }

    function renderArrival(value) {
      const trip = value.trip;
      const arrival = trip?.arrivalWifi;
      const editable = trip?.status === "PREVIEW" && !value.pending && value.previewVersion === value.version;
      const records = value.arrival?.records?.filter((record) => record.kind === "WIFI") || [];
      const selected = value.arrivalDraft?.selection || arrival?.selection;
      const selectedKey = selected ? `${selected.uploadId}:${selected.recordIndex}` : "";
      html("drivingArrivalSelection", '<option value="">Select an access point</option>' + records.map((record) => `<option value="${escape(`${record.uploadId}:${record.recordIndex}`)}"${record.eligible ? "" : " disabled"}>${escape(record.ssid || "Hidden SSID")} · ${Number.isFinite(record.distanceM) ? `${Math.round(record.distanceM)} m` : "Distance unknown"}${record.eligible ? "" : " · Unavailable"}</option>`).join(""));
      field("drivingArrivalSelection", selectedKey);
      if ($("drivingArrivalEnabled")) $("drivingArrivalEnabled").checked = Boolean(value.arrivalDraft?.enabled ?? arrival?.enabled);
      disabled("drivingArrivalEnabled", !editable || value.arrivalPending || !selectedKey);
      disabled("drivingArrivalSelection", !editable || value.arrivalPending || !records.length);
      disabled("drivingArrivalPreview", !editable || value.arrivalPending);
      const statuses = { PREPARED: "Scheduled for arrival", APPLYING: "Applying selected AP", API_ACCEPTED: "Accepted by API; readback pending", PROVIDER_MATCH: "DuoPlus /info matches the selected AP", MISMATCH: "Provider readback differs from selected AP", UNAVAILABLE: "Provider readback unavailable", FAILED: "Arrival Wi-Fi failed" };
      text("drivingArrivalStatus", arrival?.enabled ? statuses[arrival.status] || "Scheduled for arrival" : "Off. No Wi-Fi change scheduled.");
      const record = records.find((item) => `${item.uploadId}:${item.recordIndex}` === selectedKey);
      const info = record ? `${record.identifier || record.bssid || ""} · Historical observation · Last seen ${timestamp(record.lastSeen)}${record.qos == null ? "" : ` · QoS ${record.qos}`}` : value.arrival ? `${records.length} Wi-Fi observations at the destination. Historical data.` : "Destination observations have not been loaded.";
      text("drivingArrivalInfo", `${info}${arrival?.acceptedAt ? ` · API accepted ${timestamp(arrival.acceptedAt)}` : ""}${arrival?.readbackAt ? ` · Provider readback ${timestamp(arrival.readbackAt)}` : ""}`);
      text("drivingArrivalFeedback", value.arrivalPending ? "Loading arrival Wi-Fi..." : value.arrivalError || arrival?.error || (value.arrival?.warnings || []).join(" "));
    }

    function render() {
      hidden("drivingMapSurface", !active);
      if (!current) return;
      const value = stateFor(current);
      const trip = value.trip;
      const waiting = trip?.status === "RUNNING" && Boolean(trip.pauseReason) && !trip.error;
      const configured = config?.configured;
      const originPoint = point({ lat: trip?.originLat, lng: trip?.originLng }) || trip?.route?.origin || origin(current).coordinates;
      text("drivingOrigin", coordinates(originPoint));
      text("drivingOriginSource", "Controller position");
      text("drivingConfig", configError || (!config ? "Loading driving settings..." : !configured ? "Routing is unavailable." :
        current.imageId === config.playerImageId ? "Device-side 1 Hz playback · Estimated road timing · Synthetic location" : config.playbackMode === "REST_CHECKPOINTS" ? "Trip timing is an estimate. Playback waits for phone checks; continuous 1 Hz playback is not connected." : ""));
      hidden("drivingConfig", Boolean(configured && !configError && config.playbackMode !== "REST_CHECKPOINTS"));
      hidden("drivingConfigRetry", !configError && config?.configured !== false);
      disabled("drivingConfigRetry", configPending);
      text("drivingMapDevice", current.name || current.imageId);
      text("drivingMapStatus", value.picking ? "Choose the destination on the map" : waiting ? "Waiting for provider" : trip ? statusName(trip.status) : "Destination pending");
      text("drivingMapRoute", trip?.route ? `${(trip.route.distanceM / 1609.344).toFixed(1)} mi · ${duration(trip.route.durationMs)} estimated` : "");
      hidden("drivingMapLegend", !trip?.route);
      field("drivingDestinationMode", value.destinationMode);
      for (const key of ["address", "lat", "lng", "timeScale", "maxSpeedMph", "accelerationMps2", "decelerationMps2"]) field(`driving${key[0].toUpperCase()}${key.slice(1)}`, value[key]);
      hidden("drivingAddressField", value.destinationMode !== "address");
      hidden("drivingCoordinateFields", value.destinationMode !== "coordinates");
      hidden("drivingAccelerated", Number(value.timeScale) <= 1);
      if ($("drivingOpenMaps")) $("drivingOpenMaps").checked = value.openMaps;
      disabled("drivingSearch", Boolean(value.searchPending || value.pending || activeTrip(trip)));
      text("drivingSearchFeedback", value.searchPending ? "Searching addresses..." : value.searchError);
      html("drivingAddressResults", value.addressResults.map((result, index) => `<button type="button" data-driving-action="select-address" data-result-index="${index}">${icon("map-pin")}<span>${escape(result.label)}</span></button>`).join(""));
      text("drivingSelectedAddress", value.addressSelection ? `Selected: ${value.addressSelection.label || coordinates(value.addressSelection)}` : "");
      disabled("drivingInputs", Boolean(value.pending || value.arrivalPending || activeTrip(trip)));
      disabled("drivingPreview", !configured || Boolean(value.pending || value.arrivalPending || activeTrip(trip)));
      html("drivingStops", value.waypoints.map((_, index) => `<div class="driving-stop"><label>Latitude<input id="drivingStop${index}lat" data-driving-stop="${index}" data-stop-field="lat" type="number" step="any" min="-90" max="90" /></label><label>Longitude<input id="drivingStop${index}lng" data-driving-stop="${index}" data-stop-field="lng" type="number" step="any" min="-180" max="180" /></label><label>Stop (s)<input id="drivingStop${index}stopSeconds" data-driving-stop="${index}" data-stop-field="stopSeconds" type="number" min="0" max="3600" /></label><button type="button" class="btn ghost icon-button" data-driving-action="remove-stop" data-stop-index="${index}" title="Remove waypoint ${index + 1}" aria-label="Remove waypoint ${index + 1}">${icon("x")}</button></div>`).join(""));
      value.waypoints.forEach((stop, index) => { for (const key of ["lat", "lng", "stopSeconds"]) field(`drivingStop${index}${key}`, stop[key]); });
      text("drivingFeedback", value.pending ? `${value.pending === "preview" ? "Preparing route" : "Updating trip"}...` : value.error || value.message || (value.picking ? "Choose the destination on the map." : ""));
      $("drivingFeedback")?.classList.toggle("error", Boolean(value.error));
      hidden("drivingTrip", !trip);
      renderPhoneStatus(trip);
      const readiness = options.providerReadiness?.(current) || { label: "Readiness unknown", tone: "warn" };
      text("drivingProviderReadiness", `DuoPlus: ${readiness.label} · Checked ${timestamp(current.lastPowerSyncAt)}`);
      hidden("drivingProviderReadiness", !trip);
      $("drivingProviderReadiness")?.classList.toggle("warn", readiness.tone === "warn");
      $("drivingProviderReadiness")?.classList.toggle("error", readiness.tone === "bad");
      const expired = trip?.route?.expiresAt && Date.parse(trip.route.expiresAt) <= Date.now();
      const tripError = trip?.error || trip?.pauseReason || (expired && trip?.status === "PREVIEW" ? "Route preview expired. Preview again before starting." : "");
      text("drivingTripError", tripError ? `${trip.status === "PAUSED" ? "Paused: " : ""}${tripError}` : "");
      hidden("drivingTripError", !tripError);
      $("drivingTripError")?.classList.toggle("error", Boolean(tripError && !waiting));
      $("drivingTripError")?.classList.toggle("form-message", !waiting);
      $("drivingTripError")?.classList.toggle("meta", waiting);
      $("drivingTripError")?.classList.toggle("warn", waiting);
      hidden("drivingActionBar", !trip || ["ARRIVED", "CANCELLED", "FAILED"].includes(trip.status));
      hidden("drivingTripProgress", !trip);
      hidden("drivingArrival", !trip || trip.playbackMode === "DEVICE_PLAYER");
      hidden("drivingEvidence", !trip);
      hidden("drivingAlternativeField", !trip || (trip.alternatives || []).length < 2);
      if (trip) {
        html("drivingAlternative", (trip.alternatives || []).map((route, index) => `<option value="${index}">${escape(route.description || `Route ${index + 1}`)} · ${(route.distanceM / 1609.344).toFixed(1)} mi · ${duration(route.durationMs)}</option>`).join(""));
        field("drivingAlternative", trip.routeIndex || 0);
        disabled("drivingAlternative", trip.status !== "PREVIEW" || Boolean(value.pending || value.arrivalPending) || value.previewVersion !== value.version);
        const dirty = value.previewVersion !== value.version;
        const percent = trip.route?.distanceM > 0 ? Math.min(100, Math.max(0, (trip.progressM || 0) / trip.route.distanceM * 100)) : 0;
        const percentLabel = percent > 0 && percent < 0.1 ? "<0.1" : percent === 0 || percent === 100 ? String(percent) : Math.min(99.9, percent).toFixed(1);
        html("drivingTripSummary", `<div class="section-heading"><h3>${waiting ? "Waiting for provider" : statusName(trip.status)}</h3><span class="status-chip ${waiting ? "warn" : trip.status === "RUNNING" ? "good" : "neutral"}">${Number(trip.options?.timeScale || 1)}x ${Number(trip.options?.timeScale || 1) > 1 ? "accelerated" : "real time"}</span></div><div class="driving-route-metrics"><div><b>${Number.isFinite(trip.route?.distanceM) ? (trip.route.distanceM / 1609.344).toFixed(1) : "?"}</b><span>miles</span></div><div><b>${duration(trip.route?.durationMs)}</b><span>estimated ETA</span></div><div><b>${duration(trip.totalDurationMs)}</b><span>modeled trip</span></div></div><dl class="environment-fields"><dt>Destination</dt><dd>${escape(coordinates(trip.route?.destination))}</dd><dt>Traffic</dt><dd>Unavailable</dd><dt>Route fetched</dt><dd>${escape(timestamp(trip.route?.fetchedAt))}</dd><dt>Preview expires</dt><dd>${escape(timestamp(trip.route?.expiresAt))}</dd></dl>`);
        field("drivingProgress", percent);
        text("drivingProgressLabel", `${distance(trip.progressM || 0)} / ${distance(trip.route?.distanceM)} · ${percentLabel}%`);
        text("drivingAcceptedLabel", trip.playbackMode === "DEVICE_PLAYER" ? "Player applied" : "API accepted");
        const data = evidence(trip);
        text("drivingProgressAccepted", trip.playbackMode === "DEVICE_PLAYER" ? `Player checked: ${timestamp(trip.phoneSync?.player?.checkedAt)} · ${elapsed(trip.elapsedMs || 0)} played · Maps observation not verified` : `Last API accepted: ${timestamp(data.acceptedAt)} · ${elapsed(trip.elapsedMs || 0)} modeled`);
        for (const [name, statuses] of [["Start", ["PREVIEW"]], ["Pause", ["RUNNING"]], ["Resume", ["PAUSED"]], ["Cancel", ["PREVIEW", "RUNNING", "PAUSED", "ARRIVING"]], ["Adopt", ["ARRIVED"]]]) {
          hidden(`driving${name}`, !statuses.includes(trip.status) || name === "Adopt" && trip.playbackMode === "DEVICE_PLAYER");
          disabled(`driving${name}`, Boolean(value.pending || value.arrivalPending || (name === "Start" && (dirty || expired))));
        }
        renderArrival(value);
        for (const name of ["requested", "accepted", "observed"]) {
          const source = name === "observed" && data.observed ? `<span class="meta">${escape(data.observedSource)}${Number.isFinite(data.observedAgeMs) ? ` · Fix age at check ${escape(elapsed(data.observedAgeMs))}` : ""}${Number.isFinite(data.observedAccuracyM) ? ` · Accuracy ${escape(distance(data.observedAccuracyM))}` : ""}</span>` : "";
          html(`driving${name[0].toUpperCase()}${name.slice(1)}`, `${escape(data[name] ? coordinates(data[name]) : name === "observed" ? "Not observed" : "Not recorded")}<span class="meta">${escape(timestamp(data[`${name}At`]))}</span>${source}`);
        }
      }
      disabled("drivingTokenCreate", value.tokenPending || Boolean(value.token));
      hidden("drivingTokenOnce", !value.token);
      field("drivingTokenSecret", value.token?.token || "");
      text("drivingTokenFeedback", value.tokenError || value.tokenMessage || (value.tokenPending ? "Updating trip tokens..." : ""));
      html("drivingTokenList", value.tokens ? value.tokens.map((token) => `<div class="credential-row"><div class="credential-summary"><strong>${escape(token.label || "Trip trigger")}</strong><code>••••${escape(token.last4)}</code><span>Expires ${escape(timestamp(token.expiresAt))}</span></div><button type="button" class="btn ghost tiny" data-driving-action="token-revoke" data-token-id="${escape(token.id)}"${value.tokenPending ? " disabled" : ""}>Revoke</button></div>`).join("") || '<div class="meta">No saved trip tokens.</div>' : '<div class="meta">Token list has not been loaded.</div>');
      if (active) renderMap();
    }

    async function preview() {
      if (!current || !config?.configured) return;
      const device = current;
      const value = stateFor(device);
      if (value.pending || value.arrivalPending || activeTrip(value.trip)) return;
      const stamp = generation;
      const version = value.version;
      let body;
      try {
        const waypoints = value.waypoints.map((stop) => {
          const p = destination({ destinationMode: "coordinates", lat: String(stop.lat), lng: String(stop.lng) });
          const seconds = Number(stop.stopSeconds);
          if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) throw new Error("Waypoint stops must be between 0 and 3600 seconds.");
          return { ...p, stopSeconds: seconds };
        });
        body = { imageId: device.imageId, destination: destination(value), options: tripOptions(value), openMaps: value.openMaps, arrivalWifi: false, ...(waypoints.length ? { waypoints } : {}) };
      } catch (error) { value.error = error.message; render(); return; }
      value.pending = "preview"; value.error = ""; value.message = "";
      render();
      try {
        const result = await api("/api/trips", { method: "POST", body: JSON.stringify(body) });
        if (!stillValid(device, value, stamp) || value.version !== version) return;
        publish(device, value, result.trip);
        value.previewVersion = version;
        value.arrival = null;
      } catch (error) { if (stillValid(device, value, stamp)) value.error = error.message; }
      finally { if (stillValid(device, value, stamp)) { value.pending = ""; renderIfCurrent(device); } }
    }

    async function action(name) {
      if (!current) return;
      const device = current;
      const value = stateFor(device);
      const trip = value.trip;
      if (!trip || value.pending || value.arrivalPending || !["start", "pause", "resume", "cancel", "adopt-anchor"].includes(name)) return;
      if (name === "start" && (value.version !== value.previewVersion || trip.status !== "PREVIEW")) { value.error = "Preview the current trip settings before starting."; render(); return; }
      const allowed = { start: ["PREVIEW"], pause: ["RUNNING"], resume: ["PAUSED"], cancel: ["PREVIEW", "RUNNING", "PAUSED", "ARRIVING"], "adopt-anchor": ["ARRIVED"] };
      if (!allowed[name].includes(trip.status)) return;
      const stamp = generation;
      value.pending = name; value.error = ""; value.message = "";
      render();
      try {
        const result = await api(`/api/trips/${encodeURIComponent(trip.id)}/${name}`, { method: "POST", body: JSON.stringify({ revision: trip.revision, ...(name === "adopt-anchor" ? { resumeDrift: false } : {}) }) });
        if (!stillValid(device, value, stamp)) return;
        publish(device, value, result.trip);
        if (name === "adopt-anchor") value.message = "Destination adopted as anchor. Device remains stationary.";
      } catch (error) { if (stillValid(device, value, stamp)) value.error = error.message; }
      finally { if (stillValid(device, value, stamp)) { value.pending = ""; renderIfCurrent(device); } }
    }

    async function arrivalAction(selection, enabled) {
      if (!current) return;
      const device = current;
      const value = stateFor(device);
      const trip = value.trip;
      if (value.pending || value.arrivalPending || trip?.status !== "PREVIEW" || value.previewVersion !== value.version) return;
      const stamp = generation;
      value.arrivalDraft = typeof enabled === "boolean" ? { enabled, selection } : null;
      value.arrivalPending = true; value.arrivalError = ""; render();
      try {
        const isUpdate = typeof enabled === "boolean";
        const result = await api(`/api/trips/${encodeURIComponent(trip.id)}/environment`, isUpdate ? { method: "POST", body: JSON.stringify({ enabled, ...(selection ? { selection } : {}), revision: trip.revision }) } : undefined);
        if (!stillValid(device, value, stamp) || value.trip?.id !== trip.id) return;
        if (isUpdate) publish(device, value, result.trip); else value.arrival = result;
      } catch (error) { if (stillValid(device, value, stamp)) value.arrivalError = error.message; }
      finally { if (stillValid(device, value, stamp)) { value.arrivalPending = false; value.arrivalDraft = null; renderIfCurrent(device); } }
    }

    async function selectRoute(index) {
      if (!current) return;
      const device = current;
      const value = stateFor(device);
      const trip = value.trip;
      if (value.pending || value.arrivalPending || trip?.status !== "PREVIEW" || value.previewVersion !== value.version || !Number.isInteger(index) || !trip.alternatives?.[index]) return;
      const stamp = generation;
      value.pending = "route"; value.error = ""; render();
      try {
        const result = await api(`/api/trips/${encodeURIComponent(trip.id)}/route`, { method: "POST", body: JSON.stringify({ revision: trip.revision, index }) });
        if (!stillValid(device, value, stamp)) return;
        publish(device, value, result.trip);
        value.arrival = null;
      } catch (error) { if (stillValid(device, value, stamp)) value.error = error.message; }
      finally { if (stillValid(device, value, stamp)) { value.pending = ""; renderIfCurrent(device); } }
    }

    async function tokenAction(name, tokenId) {
      if (!current) return;
      const device = current;
      const value = stateFor(device);
      if (value.tokenPending) return;
      const stamp = generation;
      if (name === "token-dismiss") { value.token = null; $("drivingTokenSecret").type = "password"; render(); return; }
      if (name === "token-reveal") { $("drivingTokenSecret").type = $("drivingTokenSecret").type === "password" ? "text" : "password"; return; }
      if (name === "token-copy") {
        if (!value.token) return;
        try { await root.navigator.clipboard.writeText(value.token.token); if (stillValid(device, value, stamp)) value.tokenMessage = "Token copied."; }
        catch { if (stillValid(device, value, stamp)) value.tokenError = "Could not copy the token."; }
        renderIfCurrent(device); return;
      }
      if (name === "token-create" && value.token) return;
      value.tokenPending = true; value.tokenError = ""; value.tokenMessage = "";
      const label = $("drivingTokenLabel")?.value.trim() || "RPA trip trigger";
      render();
      try {
        const path = `/devices/${encodeURIComponent(device.id)}/trip-token`;
        const result = await api(name === "token-revoke" ? `${path}/${encodeURIComponent(tokenId)}` : path, name === "token-create" ? { method: "POST", body: JSON.stringify({ label }) } : name === "token-revoke" ? { method: "DELETE" } : undefined);
        if (!stillValid(device, value, stamp)) return;
        if (name === "token-create") { value.token = result; value.tokens = null; }
        else if (name === "token-revoke") { value.tokens = (value.tokens || []).filter((token) => token.id !== tokenId); if (value.token?.id === tokenId) value.token = null; }
        else value.tokens = result.tokens;
      } catch (error) { if (stillValid(device, value, stamp)) value.tokenError = error.message; }
      finally { if (stillValid(device, value, stamp)) { value.tokenPending = false; renderIfCurrent(device); } }
    }

    function update(device, isActive) {
      const wasActive = active;
      if (current?.id !== device?.id) {
        if (current) { const previous = stateFor(current); previous.picking = false; previous.token = null; }
        if ($("drivingTokenSecret")) $("drivingTokenSecret").type = "password";
        clearMap();
      }
      current = device;
      active = Boolean(isActive && device);
      options.mapMode?.(active);
      if (!device) { hidden("drivingMapSurface", true); return; }
      const value = stateFor(device);
      const trip = device.trip;
      if (trip && !value.pending && !value.arrivalPending && !staleTrip(value, trip) && (!value.trip || trip.id === value.trip.id || Date.parse(trip.createdAt) > Date.parse(value.trip.createdAt))) {
        if (!value.trip && value.version === 0) {
          const dest = point(trip.route?.destination);
          if (dest) Object.assign(value, { destinationMode: "coordinates", lat: String(dest.lat), lng: String(dest.lng) });
          value.openMaps = trip.phoneSync?.enabled === true;
          if (trip.options) Object.assign(value, { timeScale: String(trip.options.timeScale || 1), maxSpeedMph: String(Math.round((trip.options.maxSpeedMps || 24.5872) / 0.44704)), accelerationMps2: String(trip.options.accelerationMps2 || 1.5), decelerationMps2: String(trip.options.decelerationMps2 || 2.5) });
          value.previewVersion = value.version;
        }
        storeTrip(value, trip);
      }
      render();
      if (active) { loadConfig(); if (!wasActive) resize(); }
      else clearMap();
    }

    function resize() { if (active) map.invalidateSize(); }
    function clear() { generation += 1; drafts.clear(); current = null; active = false; config = null; configPending = false; configError = ""; clearMap(); options.mapMode?.(false); hidden("drivingMapSurface", true); field("drivingTokenSecret", ""); }

    async function searchAddress() {
      if (!current) return;
      const device = current;
      const value = stateFor(device);
      const query = value.address.trim();
      if (value.searchPending || value.pending || activeTrip(value.trip)) return;
      if (query.length < 3) { value.searchError = "Enter at least 3 characters to search."; render(); return; }
      const stamp = generation;
      const version = ++value.searchVersion;
      value.searchPending = true; value.searchError = ""; value.addressResults = []; render();
      try {
        const result = await api(`/api/trips/geocode?${new URLSearchParams({ q: query })}`);
        if (!stillValid(device, value, stamp) || value.searchVersion !== version) return;
        value.addressResults = (result.results || []).filter(point);
        if (!value.addressResults.length) value.searchError = "No addresses found. Refine the address or use coordinates.";
      } catch (error) { if (stillValid(device, value, stamp) && value.searchVersion === version) value.searchError = error.message; }
      finally { if (stillValid(device, value, stamp)) { value.searchPending = false; renderIfCurrent(device); } }
    }

    map.on("click", (event) => {
      if (!active || !current || !event.latlng) return;
      const value = stateFor(current);
      if (!value.picking || value.pending || activeTrip(value.trip)) return;
      value.picking = false;
      setDraft({ destinationMode: "coordinates", lat: event.latlng.lat.toFixed(6), lng: event.latlng.lng.toFixed(6) });
      options.mobileDevice?.();
    });

    document.addEventListener("submit", (event) => { if (event.target.id === "drivingForm") { event.preventDefault(); preview(); } });
    document.addEventListener("input", (event) => {
      const fields = { drivingAddress: "address", drivingLat: "lat", drivingLng: "lng", drivingTimeScale: "timeScale", drivingMaxSpeedMph: "maxSpeedMph", drivingAccelerationMps2: "accelerationMps2", drivingDecelerationMps2: "decelerationMps2", drivingDestinationMode: "destinationMode" };
      if (fields[event.target.id]) setDraft({ [fields[event.target.id]]: event.target.value });
      if (event.target.dataset?.drivingStop != null && current) {
        const value = stateFor(current);
        const index = Number(event.target.dataset.drivingStop);
        const key = event.target.dataset.stopField;
        if (value.waypoints[index] && ["lat", "lng", "stopSeconds"].includes(key)) {
          value.waypoints[index][key] = event.target.value;
          value.version += 1;
          value.message = "Trip settings changed. Preview the route again before starting.";
          disabled("drivingStart", true);
          text("drivingFeedback", value.message);
        }
      }
    });
    document.addEventListener("change", (event) => {
      if (event.target.id === "drivingOpenMaps") { setDraft({ openMaps: event.target.checked }); return; }
      if (event.target.id === "drivingAlternative") { selectRoute(Number(event.target.value)); return; }
      if (!current || !["drivingArrivalSelection", "drivingArrivalEnabled"].includes(event.target.id)) return;
      if (event.target.id === "drivingArrivalEnabled" && !event.target.checked) { arrivalAction(undefined, false); return; }
      const value = stateFor(current);
      const key = $("drivingArrivalSelection").value;
      const record = value.arrival?.records?.find((record) => `${record.uploadId}:${record.recordIndex}` === key && record.kind === "WIFI" && record.eligible === true);
      if (!record) return;
      arrivalAction({ uploadId: record.uploadId, recordIndex: record.recordIndex }, event.target.id === "drivingArrivalEnabled" ? event.target.checked : Boolean(value.trip?.arrivalWifi?.enabled));
    });
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-driving-action]");
      if (!button || !current || button.disabled) return;
      const name = button.dataset.drivingAction;
      const value = stateFor(current);
      if (name === "search") searchAddress();
      else if (name === "select-address") { const result = value.addressResults[Number(button.dataset.resultIndex)]; if (result) setDraft({ addressSelection: result, addressResults: [] }); }
      else if (name === "fit") { options.mobileMap?.(); resize(); fitMap(); }
      else if (name === "pick" && !value.pending && !activeTrip(value.trip)) { value.picking = true; options.mobileMap?.(); render(); }
      else if (name === "add-stop" && value.waypoints.length < 5) setDraft({ waypoints: [...value.waypoints, { lat: "", lng: "", stopSeconds: "0" }] });
      else if (name === "remove-stop") setDraft({ waypoints: value.waypoints.filter((_, index) => index !== Number(button.dataset.stopIndex)) });
      else if (name === "arrival-preview") arrivalAction();
      else if (name.startsWith("token-")) tokenAction(name, button.dataset.tokenId);
      else if (name === "retry") { config = null; configError = ""; loadConfig(); }
      else action(name);
    });
    return { markup: () => markup(icon), update, clear, resize, preview, action, setDraft, stateFor, searchAddress, selectRoute };
  }

  const exported = { create, destination, tripOptions, origin, evidence };
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  else root.ObservatoryDriving = exported;
})(typeof window !== "undefined" ? window : globalThis);
