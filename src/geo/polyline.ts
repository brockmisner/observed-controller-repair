import { config } from "../config.js";
import type { LatLng, PhysicsSample, TransitMode } from "../types.js";
import {
  bearingDegrees,
  clamp,
  haversineMeters,
  offsetMeters,
  rand,
} from "./haversine.js";

export function decodeGooglePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

export function segmentLengths(points: LatLng[]): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    lengths.push(haversineMeters(a.lat, a.lng, b.lat, b.lng));
  }
  return lengths;
}

export function interpolateAlong(
  points: LatLng[],
  progressM: number,
): { point: LatLng; index: number; bearing: number; remainingM: number } | null {
  if (points.length < 2) return null;
  const lengths = segmentLengths(points);
  const total = lengths.reduce((s, n) => s + n, 0);
  if (progressM >= total) {
    const last = points[points.length - 1]!;
    const prev = points[points.length - 2]!;
    return {
      point: last,
      index: points.length - 2,
      bearing: bearingDegrees(prev.lat, prev.lng, last.lat, last.lng),
      remainingM: 0,
    };
  }

  let walked = 0;
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (walked + len >= progressM) {
      const t = len === 0 ? 0 : (progressM - walked) / len;
      const a = points[i]!;
      const b = points[i + 1]!;
      return {
        point: {
          lat: a.lat + (b.lat - a.lat) * t,
          lng: a.lng + (b.lng - a.lng) * t,
        },
        index: i,
        bearing: bearingDegrees(a.lat, a.lng, b.lat, b.lng),
        remainingM: total - progressM,
      };
    }
    walked += len;
  }
  return null;
}

export function nextNavigationSample(input: {
  points: LatLng[];
  progressM: number;
  elapsedMs: number;
  transitMode: TransitMode;
  groundElevationM: number;
}): PhysicsSample & { progressM: number; arrived: boolean; routeIndex: number } {
  const targetSpeed =
    input.transitMode === "walk"
      ? config.walkSpeedMps * rand(0.9, 1.1)
      : rand(config.driveMinMps, config.driveMaxMps) * rand(0.9, 1.1);

  const dtSec = Math.min(Math.max(input.elapsedMs, 1_000), 8_000) / 1000;
  const stepM = targetSpeed * dtSec;
  const nextProgress = input.progressM + stepM;
  const interp = interpolateAlong(input.points, nextProgress);

  if (!interp) {
    const last = input.points[input.points.length - 1] ?? { lat: 0, lng: 0 };
    return {
      lat: last.lat,
      lng: last.lng,
      altitudeM: input.groundElevationM + 1.5,
      accuracyM: rand(3, 6),
      speedMps: 0.1,
      bearing: 0,
      elapsedMs: input.elapsedMs,
      progressM: nextProgress,
      arrived: true,
      routeIndex: Math.max(0, input.points.length - 2),
    };
  }

  const lateral = rand(-3, 3);
  const headingRad = ((interp.bearing + 90) * Math.PI) / 180;
  const jittered = offsetMeters(
    interp.point.lat,
    interp.point.lng,
    Math.cos(headingRad) * lateral,
    Math.sin(headingRad) * lateral,
  );

  return {
    lat: jittered.lat,
    lng: jittered.lng,
    altitudeM: input.groundElevationM + 1.5 + rand(-1.2, 1.2),
    accuracyM: Number(rand(3.0, 6.0).toFixed(2)),
    speedMps: Number(clamp(targetSpeed, 0.3, 20).toFixed(3)),
    bearing: Number(interp.bearing.toFixed(1)),
    elapsedMs: input.elapsedMs,
    progressM: nextProgress,
    arrived: interp.remainingM <= 2,
    routeIndex: interp.index,
  };
}
