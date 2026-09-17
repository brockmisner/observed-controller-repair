import { config } from "../config.js";
import type { PhysicsSample } from "../types.js";
import {
  bearingDegrees,
  clamp,
  haversineMeters,
  rand,
  toDeg,
  toRad,
} from "./haversine.js";

type Point = { lat: number; lng: number };

function sphericalDestination(origin: Point, distanceM: number, bearing: number): Point {
  const angular = distanceM / 6_371_000;
  const latitude = toRad(origin.lat);
  const longitude = toRad(origin.lng);
  const nextLatitude = Math.asin(clamp(Math.sin(latitude) * Math.cos(angular) +
    Math.cos(latitude) * Math.sin(angular) * Math.cos(bearing), -1, 1));
  const nextLongitude = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(latitude),
    Math.cos(angular) - Math.sin(latitude) * Math.sin(nextLatitude));
  return { lat: toDeg(nextLatitude), lng: ((toDeg(nextLongitude) + 540) % 360) - 180 };
}

function boundedEndpoint(origin: Point, proposed: Point, allowed: (point: Point) => boolean): Point {
  if (allowed(proposed)) return proposed;
  const distance = haversineMeters(origin.lat, origin.lng, proposed.lat, proposed.lng);
  const bearing = toRad(bearingDegrees(origin.lat, origin.lng, proposed.lat, proposed.lng));
  let next = origin;
  let insideFraction = 0;
  let outsideFraction = 1;
  for (let i = 0; i < 48; i += 1) {
    const fraction = (insideFraction + outsideFraction) / 2;
    const candidate = sphericalDestination(origin, distance * fraction, bearing);
    if (allowed(candidate)) { insideFraction = fraction; next = candidate; }
    else outsideFraction = fraction;
  }
  return next;
}

export function nextStationarySample(input: {
  anchorLat: number;
  anchorLng: number;
  currentLat: number;
  currentLng: number;
  groundElevationM: number;
  lastAltitudeM: number;
  elapsedMs: number;
  movementRadiusM?: number;
}): PhysicsSample {
  const radiusM = input.movementRadiusM ?? config.boundM;
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    throw new RangeError("Movement radius must be a positive finite number");
  }
  if (![input.anchorLat, input.anchorLng, input.currentLat, input.currentLng].every(Number.isFinite) ||
      Math.abs(input.anchorLat) > 90 || Math.abs(input.currentLat) > 90 ||
      Math.abs(input.anchorLng) > 180 || Math.abs(input.currentLng) > 180) {
    throw new RangeError("Anchor and current coordinates must be finite and within latitude/longitude bounds");
  }
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0) throw new RangeError("Elapsed time must be finite and nonnegative");
  if (!Number.isFinite(input.groundElevationM) || !Number.isFinite(input.lastAltitudeM)) {
    throw new RangeError("Model elevation and altitude must be finite numbers");
  }
  if (!Number.isFinite(config.driftMinM) || !Number.isFinite(config.driftMaxM) ||
      config.driftMinM < 0 || config.driftMaxM < config.driftMinM) {
    throw new RangeError("Stationary drift bounds must be finite and nonnegative, with minimum at most maximum");
  }
  if (!Number.isFinite(config.stationaryMaxSpeedMps) || config.stationaryMaxSpeedMps <= 0) {
    throw new RangeError("Stationary maximum speed must be a positive finite number");
  }
  if (!Number.isFinite(config.restorativePull) || config.restorativePull < 0 || config.restorativePull > 1) {
    throw new RangeError("Restorative pull must be finite and between zero and one");
  }

  const anchor = { lat: input.anchorLat, lng: input.anchorLng };
  const current = { lat: input.currentLat, lng: input.currentLng };
  if (haversineMeters(anchor.lat, anchor.lng, current.lat, current.lng) > radiusM) {
    throw new RangeError("Current coordinates are outside the movement radius. Confirm the anchor or radius before resuming.");
  }
  const dt = input.elapsedMs / 1000;
  const maxStepM = Math.min(config.driftMaxM, config.stationaryMaxSpeedMps * dt);
  let next = current;
  if (maxStepM > 0) {
    const drift = rand(config.driftMinM, config.driftMaxM);
    const angle = Math.random() * 2 * Math.PI;
    let proposed = sphericalDestination(current, drift, Math.PI / 2 - angle);
    const anchorDistance = haversineMeters(anchor.lat, anchor.lng, proposed.lat, proposed.lng);
    if (anchorDistance > radiusM) {
      proposed = sphericalDestination(proposed, anchorDistance * config.restorativePull,
        toRad(bearingDegrees(proposed.lat, proposed.lng, anchor.lat, anchor.lng)));
    }
    const insideAnchor = (point: Point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) &&
      haversineMeters(anchor.lat, anchor.lng, point.lat, point.lng) <= radiusM;
    proposed = boundedEndpoint(anchor, proposed, insideAnchor);
    // Cap the corrected endpoint, not just the initial random proposal.
    next = boundedEndpoint(current, proposed, (point) => insideAnchor(point) &&
      haversineMeters(current.lat, current.lng, point.lat, point.lng) <= maxStepM);
  }

  const moved = haversineMeters(
    input.currentLat,
    input.currentLng,
    next.lat,
    next.lng,
  );
  const speed = dt > 0 ? moved / dt : 0;
  const bearing = moved > 0 ? bearingDegrees(
    input.currentLat,
    input.currentLng,
    next.lat,
    next.lng,
  ) : 0;

  const altitude = dt > 0 ? clamp(
    input.groundElevationM + 1.5 + rand(-1.5, 1.5),
    input.groundElevationM - 0.2,
    input.groundElevationM + 4,
  ) : input.lastAltitudeM;

  let accuracy = rand(4.0, 12.0);
  if (accuracy < 1.5) accuracy = 4.0;

  return {
    lat: next.lat,
    lng: next.lng,
    altitudeM: altitude,
    accuracyM: Number(accuracy.toFixed(2)),
    speedMps: speed,
    bearing: Number(bearing.toFixed(1)),
    elapsedMs: input.elapsedMs,
  };
}
