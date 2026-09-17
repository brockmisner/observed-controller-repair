(function (root) {
  "use strict";
  function freshPoint(device, manual, now = Date.now()) {
    if (!device || !device.poweredOn || device.duoPlusStatus !== 1) return null;
    const trip = device.trip?.deviceId === device.id && device.trip?.imageId === device.imageId ? device.trip : null;
    const candidates = [
      manual?.deviceId === device.id && manual?.imageId === device.imageId ? manual.observation : null,
      device.playerVerification?.deviceId === device.id && device.playerVerification?.imageId === device.imageId ?
        device.playerVerification.outcome === "FAILED" ? { state: "UNKNOWN", checkedAt: device.playerVerification.checkedAt } : device.playerVerification.observation : null,
      trip?.phoneSync?.player?.phoneObservation,
      trip?.phoneSync?.gps?.observation,
    ].filter(fix => fix && Number.isFinite(Date.parse(fix.checkedAt)));
    candidates.sort((a, b) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt));
    const fix = candidates[0];
    if (!fix || fix.source !== "RUNTIME_COMMAND" || fix.state !== "OBSERVED" || !["gps", "fused"].includes(fix.provider)) return null;
    const point = fix.point;
    const sinceCheck = now - Date.parse(fix.checkedAt);
    if (!point || !Number.isFinite(point.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point.lng) || Math.abs(point.lng) > 180 ||
        !Number.isFinite(fix.ageMs) || fix.ageMs < 0 || sinceCheck < 0 || sinceCheck + fix.ageMs > 30000) return null;
    return { ...point, provider: fix.provider, mock: typeof fix.mock === "boolean" ? fix.mock : null,
      ageMs: fix.ageMs + sinceCheck, checkedAt: fix.checkedAt };
  }
  const api = { freshPoint };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ObservatoryPhoneReadback = api;
})(typeof window !== "undefined" ? window : this);
