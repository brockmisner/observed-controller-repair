import type { Device } from "@prisma/client";
import { nextNavigationSample, decodeGooglePolyline } from "../geo/polyline.js";
import { nextStationarySample } from "../geo/randomWalk.js";
import type { LatLng, TransitMode } from "../types.js";

export function parsePolyline(raw: string | null): LatLng[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as Array<LatLng | [number, number]>;
    return parsed.map((p) => (Array.isArray(p) ? { lat: p[0], lng: p[1] } : p));
  }
  return decodeGooglePolyline(trimmed);
}

// A proposal is not a dispatch. Persist it only after the final send guards pass.
export function proposeDevice(device: Device, elapsedMs: number): Device {
  const elapsed = Math.max(0, elapsedMs);

  if (elapsed === 0) return { ...device, lastSpeedMps: 0 };

  if (device.phase === "NAVIGATING") {
    const points = parsePolyline(device.polylineJson);
    if (points.length < 2) {
      return { ...device, phase: "STATIONARY", transitMode: null };
    }
    const sample = nextNavigationSample({
      points,
      progressM: device.routeProgressM,
      elapsedMs: Math.min(elapsed, 8_000),
      transitMode: (device.transitMode as TransitMode) ?? "walk",
      groundElevationM: device.groundElevationM,
    });
    return {
        ...device,
        currentLat: sample.lat,
        currentLng: sample.lng,
        lastAltitudeM: sample.altitudeM,
        lastAccuracyM: sample.accuracyM,
        lastSpeedMps: sample.speedMps,
        lastBearing: sample.bearing,
        routeProgressM: sample.progressM,
        routeIndex: sample.routeIndex,
        phase: sample.arrived ? "STATIONARY" : "NAVIGATING",
        transitMode: sample.arrived ? null : device.transitMode,
    };
  }

  const sample = nextStationarySample({
    anchorLat: device.anchorLat,
    anchorLng: device.anchorLng,
    currentLat: device.currentLat,
    currentLng: device.currentLng,
    groundElevationM: device.groundElevationM,
    lastAltitudeM: device.lastAltitudeM,
    elapsedMs: elapsed,
    movementRadiusM: device.movementRadiusM,
  });
  return {
      ...device,
      currentLat: sample.lat,
      currentLng: sample.lng,
      lastAltitudeM: sample.altitudeM,
      lastAccuracyM: sample.accuracyM,
      lastSpeedMps: sample.speedMps,
      lastBearing: sample.bearing,
  };
}
