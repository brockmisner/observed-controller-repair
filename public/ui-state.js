(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ObservatoryStatus = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  const FRESH_MS = 15000;
  const DEFAULT_POWER_FRESH_MS = 75000;
  const PREVIEW_MS = 15 * 60 * 1000;

  function result(code, label, tone, reason, source, fresh) {
    return { code, label, tone, reason, source, fresh: fresh === true };
  }

  function now(context) {
    return context && context.nowMs !== undefined ? context.nowMs : Date.now();
  }

  function timestamp(value, current) {
    if (!Number.isFinite(current)) return null;
    if (typeof value === "string") {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
      const day = Date.parse(value.slice(0, 10) + "T00:00:00Z");
      if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23) return null;
      value = Date.parse(value);
    }
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= current ? value : null;
  }

  function recent(value, current, limit) {
    const time = timestamp(value, current);
    return time !== null && current - time <= (limit === undefined ? FRESH_MS : limit);
  }

  function powerMaxAgeMs(context) {
    const value = context && context.powerStatusMaxAgeMs;
    return Number.isInteger(value) && value >= 15000 && value <= 300000 ? value : DEFAULT_POWER_FRESH_MS;
  }

  function connection(context) {
    const current = now(context);
    if (!context || context.connected !== true) return result("disconnected", "Disconnected", "bad", "Live snapshots are unavailable; displayed values may be old.", "Browser snapshot connection");
    if (timestamp(context.snapshotAt, current) === null) return result("unknown", "Awaiting snapshot", "warn", "No valid successful snapshot time is available.", "Browser snapshot connection");
    if (!recent(context.snapshotAt, current)) return result("stale", "Snapshot stale", "warn", "The last successful snapshot is more than 15 seconds old.", "Browser snapshot connection");
    return result("connected", "Connected", "good", "A snapshot was received within 15 seconds; individual provider checks can still be older.", "Browser snapshot connection", true);
  }

  function power(device, context) {
    const current = now(context);
    const link = connection(context);
    const limit = powerMaxAgeMs(context);
    const seconds = limit / 1000;
    let state;
    if (!link.fresh) state = result("stale", "Power unconfirmed", "warn", link.reason, "Saved DuoPlus fleet poll");
    else if (!device || !recent(device.lastPowerSyncAt, current, limit)) state = result("stale", "Power unconfirmed", "warn", "The DuoPlus power check is missing, invalid, or more than " + seconds + " seconds old.", "DuoPlus fleet poll");
    else if (typeof device.poweredOn !== "boolean" || !Number.isInteger(device.duoPlusStatus)) state = result("unknown", "Power unknown", "warn", "The snapshot has no unambiguous provider power state.", "DuoPlus fleet poll");
    else if (device.poweredOn !== (device.duoPlusStatus === 1)) state = result("inconsistent", "Power unconfirmed", "warn", "The controller ON flag and provider status disagree.", "DuoPlus fleet poll");
    else if (device.duoPlusStatus === 1) state = result("on", "ON", "good", "DuoPlus reported status 1 within " + seconds + " seconds.", "DuoPlus fleet poll", true);
    else {
      // Provider meanings: https://help.duoplus.net/docs/cloud-phone-status
      const labels = { 0: "Unconfigured", 2: "OFF", 3: "Expired", 4: "Renewal needed", 10: "Powering on", 11: "Configuring", 12: "Configuration failed" };
      const label = labels[device.duoPlusStatus];
      state = result(label ? "not_on" : "unknown", label || "Power unknown", [3, 4, 12].includes(device.duoPlusStatus) ? "warn" : label ? "neutral" : "warn", "Last reported DuoPlus status: " + device.duoPlusStatus + ".", "DuoPlus fleet poll", Boolean(label));
      const lastSeenOn = timestamp(device.lastSeenOnAt, current);
      if (device.duoPlusStatus === 10 && lastSeenOn !== null && lastSeenOn <= timestamp(device.lastPowerSyncAt, current)) {
        state = result("not_on", "Provider transitioning", "neutral", "DuoPlus reports status 10; last confirmed ON " + new Date(lastSeenOn).toISOString() + ". This is not proof of reboot.", "DuoPlus fleet poll", true);
      }
    }
    state.isFreshOn = state.code === "on" && state.fresh;
    return state;
  }

  function isFreshOn(device, context) {
    return power(device, context).isFreshOn;
  }

  function activity(device, context) {
    const state = power(device, context);
    const trip = device && device.trip;
    if (!state.fresh || ![1, 10, 11].includes(device.duoPlusStatus) || !trip || typeof trip.id !== "string" || !trip.id ||
        device.activeTripId !== trip.id || trip.deviceId !== device.id) return state;
    if (trip.status === "PAUSED") return result("trip_paused", "Trip paused", trip.error ? "warn" : "neutral", trip.error || trip.pauseReason || "The driving trip is paused.", "Driving trip activity", true);
    if (trip.status !== "RUNNING" || device.active !== true || trip.error) return state;
    return result("driving", "Driving", "neutral", "This device has a running trip. DuoPlus status " + device.duoPlusStatus + "; this is trip activity, not an ON readiness claim.", "Driving trip activity", true);
  }

  function readiness(device, context) {
    const state = power(device, context);
    const code = device && device.duoPlusStatus;
    if (!Number.isInteger(code)) return state;
    if (!state.fresh) return { ...state, label: state.label + " (last status " + code + ")" };
    const label = { 1: "ON", 10: "Transitioning", 11: "Configuring" }[code] || state.label;
    return { ...state, label: label + " (" + code + ")", tone: code === 10 || code === 11 ? "warn" : state.tone };
  }

  function coordinates(lat, lng) {
    return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function mac(value) {
    if (typeof value !== "string" || !/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(value)) return null;
    const normalized = value.toLowerCase();
    return normalized !== "00:00:00:00:00:00" && normalized !== "ff:ff:ff:ff:ff:ff" ? normalized : null;
  }

  function apMac(value) {
    const normalized = mac(value);
    return normalized && (parseInt(normalized.slice(0, 2), 16) & 1) === 0 ? normalized : null;
  }

  function sameAnchor(profile, device) {
    return profile && profile.anchor && coordinates(profile.anchor.lat, profile.anchor.lng) && coordinates(device.anchorLat, device.anchorLng) && profile.anchor.lat === device.anchorLat && profile.anchor.lng === device.anchorLng;
  }

  function sameWifi(a, b) {
    return a && b && typeof a.name === "string" && a.name.length > 0 && a.name === b.name &&
      apMac(a.bssid) !== null && apMac(a.bssid) === apMac(b.bssid) && mac(a.mac) !== null && mac(a.mac) === mac(b.mac) &&
      a.status === 1 && b.status === 1 && mac(a.mac) !== mac(a.bssid);
  }

  function wifi(device, context) {
    const environment = device && device.environment;
    const profile = environment && environment.profile;
    const current = now(context);
    const link = connection(context);
    const source = "Saved environment profile";
    if (!profile || typeof environment.revision !== "string" || !environment.revision) return result("not_prepared", "Not prepared", "neutral", "No WiGLE environment preview is saved. Local Wi-Fi metadata is not readback evidence.", source);
    if (!sameAnchor(profile, device)) return result("anchor_changed", "Anchor changed", "warn", "This profile belongs to a different or invalid anchor; earlier acceptance does not verify this location.", source);
    if (profile.cell) return result("unsupported_profile", "Unsupported cell profile", "warn", "The saved cell mapping is unverified; this profile cannot be treated as ready.", source);
    const revision = environment.revision;
    const verification = environment.verification && environment.verification.revision === revision ? environment.verification :
      environment.acceptedVerification && environment.acceptedVerification.revision === revision ? environment.acceptedVerification : null;
    const accepted = timestamp(environment.acceptedAt, current);
    const prepared = timestamp(environment.preparedAt, current);
    const acceptedProfile = environment.acceptedProfile;
    const acceptanceMatches = accepted !== null && prepared !== null && accepted >= prepared && sameAnchor(acceptedProfile, device) && profile.wifi && acceptedProfile.wifi &&
      profile.wifi.ssid === acceptedProfile.wifi.ssid && apMac(profile.wifi.bssid) !== null && apMac(profile.wifi.bssid) === apMac(acceptedProfile.wifi.bssid) &&
      (environment.status === "ACCEPTED" || verification !== null);
    if (verification && verification.wifi && acceptanceMatches) {
      const check = verification.wifi;
      if (check.status === "PENDING") return result("pending", link.fresh ? "Readback pending" : "Last state: readback pending", "warn", "The API accepted this revision, but matching device readback has not been recorded.", "DuoPlus API acceptance");
      if (check.status === "MISMATCH") {
        const checked = timestamp(check.checkedAt, current);
        if (checked === null || checked < accepted) return result("invalid_readback", "Readback unconfirmed", "warn", "The mismatch record has no valid check time after API acceptance.", "Saved DuoPlus /info readback");
        return result("mismatch", "Readback mismatch", "bad", "The last device readback differed from the accepted request; this is not a verified profile.", "DuoPlus /info readback");
      }
      if (check.status === "UNAVAILABLE") return result("unavailable", "Readback unavailable", "warn", "The API accepted this revision, but its device settings could not be verified.", "DuoPlus API acceptance");
      if (check.status === "VERIFIED") {
        const checked = timestamp(check.checkedAt, current);
        if (checked === null || checked < accepted || !sameWifi(check.expected, check.observed) ||
            check.expected.name !== profile.wifi.ssid || mac(check.expected.bssid) !== mac(profile.wifi.bssid) ||
            (profile.deviceWifi && mac(profile.deviceWifi.mac) !== mac(check.expected.mac))) {
          return result("invalid_readback", "Readback unconfirmed", "warn", "The saved readback lacks matching values or a valid check time for this accepted profile.", "Saved DuoPlus /info readback");
        }
        if (link.fresh && isFreshOn(device, context) && recent(checked, current)) return result("verified", "Readback matched", "good", "Recent DuoPlus /info values matched the accepted Wi-Fi request. This does not verify connectivity or physical coverage.", "DuoPlus /info readback", true);
        return result("historical_match", "Last readback matched", "neutral", "A previous readback matched this profile; current device state, connectivity, and coverage are not confirmed.", "Saved DuoPlus /info readback");
      }
    }
    if (environment.status === "ACCEPTED") return acceptanceMatches ?
      result("accepted_unverified", "API accepted; unverified", "warn", "API acceptance alone does not establish matching device settings or a current connection.", "DuoPlus API acceptance") :
      result("acceptance_unconfirmed", "Acceptance unconfirmed", "warn", "No matching accepted profile with valid preparation and acceptance times is available.", source);
    if (environment.status === "APPLYING") return result("applying", link.fresh ? "Apply in progress" : "Last state: applying", "neutral", "No completed API acceptance and readback is available for this attempt.", source);
    if (environment.dispatchedAt) return result("dispatch_uncertain", "Sent; outcome unconfirmed", "warn", "This revision was dispatched, but no verified successful outcome is saved. It must not be resent automatically.", "Controller dispatch record");
    if (environment.status === "FAILED") return result("failed", "Apply needs review", "warn", "The saved environment operation failed or was invalidated.", source);
    if (!profile.wifi) return result("no_observation", "No Wi-Fi match", "warn", "No usable WiGLE observation was found for the saved anchor.", "WiGLE search");
    if (!recent(environment.preparedAt, current, PREVIEW_MS)) return result("preview_expired", "Preview expired", "warn", "The preview time is invalid or more than 15 minutes old.", source);
    if (profile.deviceWifi && (profile.deviceWifi.status !== 1 || !mac(profile.deviceWifi.mac))) return result("blocked", "Device Wi-Fi unavailable", "warn", "The preview did not report enabled Wi-Fi with a valid existing device MAC.", "Preview DuoPlus /info");
    return result("prepared", "Preview ready", "neutral", "Observed WiGLE data is prepared but has not been applied or verified for this revision.", "WiGLE search", link.fresh);
  }

  function location(device, context) {
    const source = "Controller coordinates; not GPS readback";
    if (!device || !coordinates(device.currentLat, device.currentLng)) return result("unknown", "Location unknown", "warn", "No valid controller position is available; zero coordinates are not substituted.", source);
    const fresh = connection(context).fresh && recent(device.lastTickAt, now(context));
    return result("controller_position", fresh ? "Controller position" : "Saved controller position", "neutral", "These are stored controller coordinates, not a measured device GPS fix. Accuracy, speed, and altitude metadata are not device readback.", source, fresh);
  }

  function metadata(value) {
    const present = (typeof value === "string" && value.trim() !== "") || (typeof value === "number" && Number.isFinite(value));
    return result(present ? "stored" : "unknown", present ? "Stored metadata" : "Unknown", "neutral", present ? "This value is stored by the controller; it has not been verified through current device readback." : "No supported device observation is available.", "Controller metadata");
  }

  function controller(device, context) {
    const source = "Controller execution; not phone location evidence";
    if (!device || !connection(context).fresh) return result("unknown", "Activity unconfirmed", "warn", "A fresh workspace snapshot is required.", source);
    const powerState = power(device, context);
    if (!powerState.isFreshOn) return result("waiting_power", "Waiting for phone", "neutral", powerState.reason, source);
    const trip = device.trip;
    const ownsTrip = trip && trip.id === device.activeTripId && trip.deviceId === device.id;
    if (ownsTrip && trip.status === "PAUSED") return result("paused", "Trip paused", trip.error ? "warn" : "neutral", trip.error || trip.pauseReason || "Paused by operator.", source, true);
    if (device.active !== true) return result("paused", "Paused", "neutral", "Movement is disabled for this device.", source, true);
    if (ownsTrip && ["RUNNING", "ARRIVING"].includes(trip.status) && (trip.pauseReason || trip.error)) return result("waiting", "Waiting for phone", "warn", trip.error || trip.pauseReason, source, true);
    if (device.phase === "STATIONARY" && !ownsTrip) return result("idle", "Idle · parked", "neutral", "No movement is scheduled. Stationary phones do not receive periodic GPS writes.", source, true);
    if (!recent(device.lastTickAt, now(context), 30000)) return result("stalled", "No recent movement", "warn", "Movement is enabled but no model update was recorded in the last 30 seconds. Check Driving and phone GPS.", source);
    return result("running", "Movement active", "neutral", "Recent controller progress was recorded. Check Android evidence to confirm phone location.", source, true);
  }

  function attention(device, context) {
    if (!device || device.active === false) return false;
    const state = power(device, context);
    const environment = wifi(device, context);
    const movement = controller(device, context);
    return movement.tone === "warn" || movement.tone === "bad" || state.tone === "warn" || state.tone === "bad" || environment.tone === "warn" || environment.tone === "bad" ||
      (state.isFreshOn && environment.code === "not_prepared") || device.proxyMismatch === true;
  }

  return Object.freeze({ connection, power, activity, controller, readiness, wifi, location, metadata, isFreshOn, attention, powerMaxAgeMs });
});
