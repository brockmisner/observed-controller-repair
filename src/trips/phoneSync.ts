import type { DrivingTrip } from "@prisma/client";
import { launchDeviceMaps, observeDeviceLocation } from "../api/duoPlusClient.js";
import { readProviderGps } from "../api/providerGps.js";
import { prisma } from "../db.js";
import { haversineMeters } from "../geo/haversine.js";
import { phoneReadbackFailure } from "../api/phoneReadbackFailure.js";
import { logger } from "../logger.js";
import { HttpError } from "../http/errors.js";

type MapsResult = Awaited<ReturnType<typeof launchDeviceMaps>>;
type Observation = Awaited<ReturnType<typeof observeDeviceLocation>>;
interface PhoneSync {
  enabled: boolean;
  maps: { status: string; requestedAt?: string; checkedAt?: string; reason?: string };
  gps?: {
    requestId: string;
    status: string;
    startedAt: string;
    checkedAt?: string;
    reason?: string;
    distanceM?: number;
    observation?: Observation;
    provider?: ReturnType<typeof readProviderGps>;
  };
}

export function phoneSyncState(trip: Pick<DrivingTrip, "phoneSyncJson">): PhoneSync {
  try {
    const value = JSON.parse(trip.phoneSyncJson);
    if (value?.enabled === true) return typeof value.maps?.status === "string" ? value :
      { enabled: true, maps: { status: "UNKNOWN" } };
  } catch { /* Older trips have no phone synchronization configuration. */ }
  return { enabled: false, maps: { status: "DISABLED" } };
}

async function save(trip: DrivingTrip, state: PhoneSync, waiting?: string): Promise<void> {
  const result = await prisma.drivingTrip.updateMany({
    where: { id: trip.id, revision: trip.revision, status: trip.status,
      device: { activeTripId: trip.id, tenantId: trip.tenantId, active: true } },
    data: { phoneSyncJson: JSON.stringify(state), ...(waiting ? {
      pauseReason: waiting, nextTickAt: new Date(Date.now() + 3000),
    } : {}) },
  });
  if (result.count !== 1) throw new HttpError(409, "Trip changed during phone synchronization");
  trip.phoneSyncJson = JSON.stringify(state);
}

export async function ensureTripMaps(
  trip: DrivingTrip, destination: { lat: number; lng: number }, requireOwner: () => Promise<void>,
): Promise<void> {
  const state = phoneSyncState(trip);
  if (!state.enabled || state.maps.status === "LAUNCH_ACCEPTED") return;
  if (state.maps.status !== "PENDING") {
    throw new HttpError(409, "Maps launch is unconfirmed. Resume explicitly to retry.");
  }
  // Persist before dispatch so a worker restart cannot launch Maps repeatedly.
  await requireOwner();
  state.maps = { status: "OPENING", requestedAt: new Date().toISOString() };
  await save(trip, state);
  try {
    const result: MapsResult = await launchDeviceMaps(trip.imageId, destination, trip.tenantId, requireOwner);
    await requireOwner();
    state.maps = { ...state.maps, status: result.state, checkedAt: result.checkedAt, reason: result.reason };
    await save(trip, state);
    if (result.state !== "LAUNCH_ACCEPTED") throw new HttpError(409, "Android did not confirm the Maps launch command");
  } catch (error) {
    state.maps = { ...state.maps, status: "FAILED", checkedAt: new Date().toISOString(),
      reason: "Maps launch was not confirmed. Check that Maps is installed and DuoPlus command access is enabled." };
    await save(trip, state);
    throw error;
  }
}

export function phoneFixMatches(
  observation: Observation, expected: { lat: number; lng: number; dispatchedAt: Date },
): { matches: boolean; distanceM?: number } {
  if (observation.state !== "OBSERVED" || !observation.point || observation.ageMs === null ||
      observation.ageMs < 0 || observation.ageMs > 30_000 || observation.provider !== "fused") return { matches: false };
  const capturedAt = Date.parse(observation.checkedAt);
  // This is temporal correlation, not proof that this request caused the fix.
  if (!Number.isFinite(capturedAt) || capturedAt - observation.ageMs < expected.dispatchedAt.getTime()) return { matches: false };
  const distanceM = haversineMeters(expected.lat, expected.lng, observation.point.lat, observation.point.lng);
  return { matches: distanceM <= 10, distanceM };
}

export async function waitForTripPhone(
  trip: DrivingTrip, requireOwner: () => Promise<void>,
): Promise<boolean> {
  const state = phoneSyncState(trip);
  if (!state.enabled || !trip.lastRequestId || trip.acceptedLat === null || trip.acceptedLng === null) return true;
  const prior = state.gps?.observation;
  if (state.gps?.requestId === trip.lastRequestId && state.gps.status === "MATCH" && prior?.state === "OBSERVED" &&
      prior.ageMs !== null && prior.ageMs + Math.max(0, Date.now() - Date.parse(prior.checkedAt)) <= 30_000) return true;
  const request = await prisma.locationRequest.findFirst({ where: { id: trip.lastRequestId, tripId: trip.id,
    tenantId: trip.tenantId, deviceId: trip.deviceId, imageId: trip.imageId, status: "API_ACCEPTED" } });
  if (!request?.dispatchedAt) throw new HttpError(409, "Phone readback has no accepted GPS request to compare");
  const startedAt = state.gps?.requestId === trip.lastRequestId ? state.gps.startedAt : new Date().toISOString();
  const deadline = Date.parse(startedAt) + 90_000;
  if (!Number.isFinite(deadline) || Date.now() >= deadline) {
    throw new HttpError(409, "Android did not confirm the accepted GPS point within 90 seconds. Review phone location before resuming.");
  }
  state.gps = { requestId: trip.lastRequestId, status: "PENDING", startedAt };
  await requireOwner();
  await save(trip, state);
  try {
    await requireOwner();
    const observation = await observeDeviceLocation(trip.imageId, trip.tenantId, requireOwner);
    await requireOwner();
    const match = phoneFixMatches(observation, { lat: request.lat, lng: request.lng, dispatchedAt: request.dispatchedAt });
    if (Date.now() >= deadline) match.matches = false;
    state.gps = { ...state.gps, status: match.matches ? "MATCH" : "WAITING", observation,
      checkedAt: observation.checkedAt, distanceM: match.distanceM,
      reason: match.matches ? "Fresh Android fused fix is within 10 m of the accepted point." :
        observation.state === "UNKNOWN" ? `${observation.reason} No next GPS point is being sent.` :
        observation.provider !== "fused" ? "Android returned GPS but no fresh fused fix. Open Maps and check its location permission. No next GPS point is being sent." :
        "Waiting for a fresh Android fused fix at the accepted point. No next GPS point is being sent." };
    await save(trip, state, match.matches ? undefined : state.gps.reason);
    if (match.matches) return true;
  } catch (error) {
    await requireOwner();
    state.gps = { ...state.gps, status: "UNAVAILABLE", checkedAt: new Date().toISOString(),
      reason: `${phoneReadbackFailure(error)} No next GPS point is being sent.` };
    logger.warn({ tripId: trip.id, imageId: trip.imageId, requestId: trip.lastRequestId,
      reason: phoneReadbackFailure(error) }, "Phone GPS readback failed");
    await save(trip, state, state.gps.reason);
  }
  if (Date.now() >= deadline) {
    throw new HttpError(409, "Android did not confirm the accepted GPS point within 90 seconds. Review phone location before resuming.");
  }
  return false;
}
