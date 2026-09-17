import type { DrivingTrip, LocationRequest } from "@prisma/client";
import { prisma } from "../db.js";
import { createRouteTimeline } from "./routeTimeline.js";

export async function readRetryableCheckpoint(
  trip: DrivingTrip,
  db: Pick<typeof prisma, "locationRequest"> = prisma,
): Promise<LocationRequest | null> {
  if (trip.gpsRetryCount !== 0 || !trip.lastRequestId || trip.pendingElapsedMs === null || trip.pendingProgressM === null ||
      !Number.isFinite(trip.pendingElapsedMs) || trip.pendingElapsedMs < trip.elapsedMs || trip.pendingElapsedMs > trip.durationMs ||
      !Number.isFinite(trip.pendingProgressM) || trip.pendingProgressM < trip.progressM) return null;
  const request = await db.locationRequest.findFirst({ where: {
    id: trip.lastRequestId, tripId: trip.id, deviceId: trip.deviceId, tenantId: trip.tenantId, imageId: trip.imageId,
    source: "DRIVE", status: "API_REJECTED", rejectionReason: { in: ["DEVICE_BUSY", "DEVICE_TRANSITIONING"] },
    dispatchedAt: { not: null }, completedAt: { not: null }, acceptedAt: null,
  } });
  if (!request || !Number.isFinite(request.lat) || Math.abs(request.lat) > 90 ||
      !Number.isFinite(request.lng) || Math.abs(request.lng) > 180) return null;
  try {
    const sample = createRouteTimeline(JSON.parse(trip.routeJson), JSON.parse(trip.optionsJson)).sample(trip.pendingElapsedMs);
    // SQLite float round-trips can differ by an ULP; matching tolerance stays below a millimeter.
    if (Math.abs(sample.lat - request.lat) > 1e-9 || Math.abs(sample.lng - request.lng) > 1e-9 ||
        Math.abs(sample.distanceM - trip.pendingProgressM) > 1e-6) return null;
  } catch { return null; }
  return request;
}
