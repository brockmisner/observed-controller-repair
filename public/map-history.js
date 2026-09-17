(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ObservatoryHistory = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";

  // Display continuity limits, not a physical model or proof of a recorded journey.
  // Normal controller ticks are 5–10 seconds apart. A gap over one minute ends a
  // trail. An edge must be <=1 km and <=80 m/s, with a 50 m minimum allowance for
  // short-interval position noise. When both samples report speed, use the lower
  // ceiling of 80 m/s and (2 * max reported speed + 5 m/s) to catch local resets.
  const thresholds = Object.freeze({
    maxGapMs: 60000,
    maxEdgeM: 1000,
    maxSpeedMps: 80,
    minimumAllowanceM: 50,
    reportedSpeedMultiplier: 2,
    reportedSpeedAllowanceMps: 5,
  });

  function timestamp(value) {
    if (typeof value === "string") {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
      const calendarDay = Date.parse(value.slice(0, 10) + "T00:00:00Z");
      if (!Number.isFinite(calendarDay) || new Date(calendarDay).toISOString().slice(0, 10) !== value.slice(0, 10)
          || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
      value = Date.parse(value);
    }
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : null;
  }

  function latestTimestamp(ticks) {
    let latest = null;
    if (!Array.isArray(ticks)) return latest;
    for (const tick of ticks) {
      const time = timestamp(tick && tick.createdAt);
      if (time !== null && (latest === null || time > latest)) latest = time;
    }
    return latest;
  }

  function coordinate(value, limit) {
    return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
  }

  function longitude(value) { return value === 180 ? -180 : value; }
  function speed(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
  function distanceM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (((b.lng - a.lng + 540) % 360) - 180) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
  }

  /**
   * Accepts TelemetryTick rows in either endpoint's order, without mutating them.
   * Returns only observed coordinates; segments have at least two points and are
   * ready for Leaflet polylines. Unconnected points remain in `points`.
   *
   * Clear uses an inclusive server-timestamp cutoff: pass latestTimestamp(rows),
   * persisted per device/workspace/user, as clearBeforeMs. Ticks at or before that
   * boundary stay hidden after refresh/reconnect. No browser wall clock is used.
   * Clearing affects presentation only; no telemetry is deleted. A missing latest
   * timestamp is null, so the caller should preserve its existing cutoff.
   *
   * Invalid coordinates and conflicting same-time samples are barriers. Identical
   * duplicates collapse deterministically. Without a usable timestamp, a row cannot
   * be placed in the chronology: the batch returns points but no connecting lines.
   * Date-line crossings split instead of inventing intermediate boundary points.
   */
  function buildTrails(ticks, options) {
    const requested = options && options.clearBeforeMs;
    const cutoff = requested === undefined || requested === null ? null : timestamp(requested);
    if (requested !== undefined && requested !== null && cutoff === null) throw new TypeError("clearBeforeMs must be a valid timestamp");
    const result = { segments: [], points: [], breaks: [], latestTimestampMs: latestTimestamp(ticks), clearBeforeMs: cutoff };
    if (!Array.isArray(ticks)) return result;

    const ordered = [];
    let unordered = false;
    for (const tick of ticks) {
      const timeMs = timestamp(tick && tick.createdAt);
      if (timeMs === null) {
        unordered = true;
        result.breaks.push({ reason: "invalid_timestamp", timeMs: null });
      } else if (cutoff === null || timeMs > cutoff) ordered.push({ tick, timeMs });
    }
    ordered.sort((a, b) => a.timeMs - b.timeMs);
    let segment = [], previous = null;
    function finish() {
      if (!unordered && segment.length >= 2) result.segments.push(segment);
      segment = []; previous = null;
    }
    function boundary(reason, timeMs) {
      result.breaks.push({ reason, timeMs }); finish();
    }

    for (let index = 0; index < ordered.length;) {
      let end = index + 1;
      const timeMs = ordered[index].timeMs;
      while (end < ordered.length && ordered[end].timeMs === timeMs) end++;
      const group = ordered.slice(index, end).map((entry) => entry.tick); index = end;
      if (group.some((tick) => !coordinate(tick.lat, 90) || !coordinate(tick.lng, 180))) {
        boundary("invalid_coordinates", timeMs); continue;
      }
      const first = group[0], lng = longitude(first.lng);
      const deviceIds = Array.from(new Set(group.map((tick) => tick.deviceId).filter((id) => typeof id === "string" && id.length > 0)));
      if (deviceIds.length > 1 || group.some((tick) => tick.lat !== first.lat || longitude(tick.lng) !== lng)) {
        boundary("duplicate_timestamp", timeMs); continue;
      }
      const ids = group.map((tick) => tick.id).filter((id) => typeof id === "string").sort();
      const speeds = group.map((tick) => speed(tick.speedMps));
      const point = {
        lat: first.lat, lng, timeMs, id: ids[0] || null, deviceId: deviceIds[0] || null,
        speedMps: speeds.some((value) => value === null) ? null : Math.max(...speeds),
      };
      if (previous) {
        const elapsed = timeMs - previous.timeMs;
        const distance = distanceM(previous, point);
        let ceiling = thresholds.maxSpeedMps;
        if (previous.speedMps !== null && point.speedMps !== null)
          ceiling = Math.min(ceiling, Math.max(previous.speedMps, point.speedMps) * thresholds.reportedSpeedMultiplier + thresholds.reportedSpeedAllowanceMps);
        const allowance = Math.min(thresholds.maxEdgeM, Math.max(thresholds.minimumAllowanceM, ceiling * elapsed / 1000));
        if (previous.deviceId && point.deviceId && previous.deviceId !== point.deviceId) boundary("device_change", timeMs);
        else if (elapsed > thresholds.maxGapMs) boundary("gap", timeMs);
        else if (distance > allowance) boundary("jump", timeMs);
        else if (Math.abs(point.lng - previous.lng) > 180) boundary("date_line", timeMs);
      }
      result.points.push(point); segment.push([point.lat, point.lng]); previous = point;
    }
    finish();
    return result;
  }

  return Object.freeze({ buildTrails, latestTimestamp, thresholds });
});
