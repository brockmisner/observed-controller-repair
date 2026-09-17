import type { Device, LocationRequest, Prisma } from "@prisma/client";
import { modifyDeviceBatch } from "../api/duoPlusClient.js";
import { readGpsRejectionDetail, readGpsRejectionReason } from "../api/gpsRejectionReason.js";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { haversineMeters } from "../geo/haversine.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";
import { completeLocationRequest, createLocationRequest, logLocationRequestStage, markLocationDispatched,
  type LocationCompletionStatus, type LocationRequestSource } from "../ops/locationTelemetry.js";
import { LocationPacing } from "./locationPacing.js";

const pacing = new LocationPacing(config.jitterMs);

export async function gpsIsDue(deviceId: string, intervalMs?: number): Promise<boolean> {
  if (!pacing.has(deviceId)) {
    const last = await prisma.locationRequest.findFirst({
      where: { deviceId, dispatchedAt: { not: null } }, orderBy: { dispatchedAt: "desc" },
    });
    pacing.restore(deviceId, last?.dispatchedAt, last?.completedAt);
  }
  return intervalMs === undefined ? pacing.isDue(deviceId) : pacing.isDueWithInterval(deviceId, intervalMs);
}

export function gpsElapsedMs(deviceId: string): number {
  // With no dispatch baseline, first send holds the existing coordinate.
  return pacing.intervalSinceDispatch(deviceId) ?? 0;
}

export function deferGps(deviceId: string): void { pacing.completed(deviceId); }

export function gpsEligibility(tenantId: string, ids: string[], now = new Date(), tripId?: string, siteId?: string): Prisma.DeviceWhereInput {
  return {
    id: { in: ids }, tenantId, ...(siteId ? {} : { active: true }), poweredOn: true, duoPlusStatus: 1,
    site: siteId ? { is: { id: siteId, tenantId } } : { is: null },
    activeTripId: tripId ?? null,
    warmupCampaigns: { none: { reservedImageId: { not: null } } },
    phase: { not: "EXPIRED" }, campaignEnd: { gt: now },
    lastPowerSyncAt: { gte: new Date(now.getTime() - config.powerStatusMaxAgeMs), lte: now },
  };
}

export function classifyGpsAcceptance(result: unknown, imageId: string): LocationCompletionStatus {
  if (!result || typeof result !== "object") return "UNCONFIRMED";
  const { success, fail } = result as { success?: unknown; fail?: unknown };
  if (!Array.isArray(success) || !Array.isArray(fail) ||
      !success.every((id) => typeof id === "string") || !fail.every((id) => typeof id === "string")) return "UNCONFIRMED";
  const accepted = success.filter((id) => id === imageId).length;
  const rejected = fail.filter((id) => id === imageId).length;
  if (accepted === 1 && rejected === 0) return "API_ACCEPTED";
  if (accepted === 0 && rejected === 1) return "API_REJECTED";
  return "UNCONFIRMED";
}

export interface GpsProposal { device: Device; proposed: Device }
export interface GpsDispatchOptions {
  tripId?: string;
  siteId?: string;
  intervalMs?: number;
  beforeDispatch?: () => Promise<void>;
  onDispatched?: (tx: Prisma.TransactionClient, records: LocationRequest[]) => Promise<void>;
}

async function commitProposal(tx: Prisma.TransactionClient, entry: GpsProposal, at: Date, intervalMs: number | null, tripId?: string, siteId?: string): Promise<void> {
  const { device, proposed } = entry;
  const speed = intervalMs && intervalMs > 0 ?
    haversineMeters(device.currentLat, device.currentLng, proposed.currentLat, proposed.currentLng) / (intervalMs / 1000) : 0;
  const updated = await tx.device.updateMany({
    where: {
      AND: [gpsEligibility(device.tenantId, [device.id], at, tripId, siteId)], id: device.id,
      anchorLat: device.anchorLat, anchorLng: device.anchorLng, movementRadiusM: device.movementRadiusM,
      currentLat: device.currentLat, currentLng: device.currentLng, phase: device.phase,
      routeProgressM: device.routeProgressM, polylineJson: device.polylineJson, transitMode: device.transitMode,
    },
    data: {
      currentLat: proposed.currentLat, currentLng: proposed.currentLng,
      lastAltitudeM: proposed.lastAltitudeM, lastAccuracyM: proposed.lastAccuracyM,
      lastSpeedMps: device.phase === "STATIONARY" ? speed : proposed.lastSpeedMps,
      lastBearing: proposed.lastBearing, lastTickAt: at,
      routeProgressM: proposed.routeProgressM, routeIndex: proposed.routeIndex,
      phase: proposed.phase, transitMode: proposed.transitMode,
    },
  });
  if (updated.count !== 1) throw new HttpError(409, "GPS update skipped: device state changed before dispatch");
  await tx.telemetryTick.create({ data: {
    deviceId: device.id, lat: proposed.currentLat, lng: proposed.currentLng,
    altitudeM: proposed.lastAltitudeM, accuracyM: proposed.lastAccuracyM,
    speedMps: device.phase === "STATIONARY" ? speed : proposed.lastSpeedMps,
    bearing: proposed.lastBearing, phase: proposed.phase, createdAt: at,
  } });
}

// Producers hold reserveMovement; site setup holds the exclusive environment window.
export async function dispatchGps(entries: GpsProposal[], source: LocationRequestSource, options: GpsDispatchOptions = {}): Promise<LocationRequest[]> {
  if (!entries.length) return [];
  if ((source === "DRIVE") !== Boolean(options.tripId) || (source === "SITE") !== Boolean(options.siteId) ||
      options.siteId && options.tripId || options.intervalMs !== undefined &&
      (!(options.tripId || options.siteId) || !Number.isFinite(options.intervalMs) || options.intervalMs < 1100)) throw new Error("Invalid GPS dispatch ownership");
  const tenantId = entries[0]!.device.tenantId;
  if (entries.length > 20 || entries.some(({ device }) => device.tenantId !== tenantId) ||
      new Set(entries.map(({ device }) => device.id)).size !== entries.length) throw new Error("Invalid GPS batch");
  const requests: Array<{ record: LocationRequest; entry: GpsProposal; queuedAt: number }> = [];
  const completed = new Set<string>();
  let startedAt: Date | undefined;
  let startMono: number | undefined;
  let completedWithoutError = false;
  try {
    for (const entry of entries) {
      const queuedAt = performance.now();
      const record = await createLocationRequest(entry.device,
        { lat: entry.proposed.currentLat, lng: entry.proposed.currentLng }, source, options.tripId);
      requests.push({ record, entry, queuedAt });
    }
    if (config.dryRun) {
      for (const { record } of requests) {
        await completeLocationRequest(record.id, { status: "DRY_RUN", at: new Date(), apiLatencyMs: null });
        completed.add(record.id);
      }
      return prisma.locationRequest.findMany({ where: { id: { in: requests.map(({ record }) => record.id) } } });
    }
    const result = await modifyDeviceBatch(entries.map(({ proposed }) => ({
      imageId: proposed.imageId, lat: proposed.currentLat, lng: proposed.currentLng, bindEnvironment: false,
    })), tenantId, async () => {
      // Key failover must not resend a lifecycle or bypass the device cooldown.
      if (startedAt) throw new HttpError(409, "GPS retry deferred until the next paced request");
      await options.beforeDispatch?.();
      const ids = entries.map(({ device }) => device.id);
      if ((await prisma.device.count({ where: gpsEligibility(tenantId, ids, new Date(), options.tripId, options.siteId) })) !== ids.length) {
        throw new HttpError(409, "GPS update skipped: a device is no longer confirmed active and ON");
      }
      if (entries.some(({ device }) => options.intervalMs === undefined ? !pacing.isDue(device.id) :
        !pacing.isDueWithInterval(device.id, options.intervalMs))) throw new HttpError(409, "GPS update skipped: device is cooling down");
      const at = new Date();
      const dispatched = await prisma.$transaction(async (tx) => {
        const rows: LocationRequest[] = [];
        for (const { record, entry, queuedAt } of requests) {
          const dispatchIntervalMs = pacing.intervalSinceDispatch(entry.device.id);
          await commitProposal(tx, entry, at, dispatchIntervalMs, options.tripId, options.siteId);
          rows.push(await markLocationDispatched(record.id, { at, dispatchIntervalMs, queueDelayMs: performance.now() - queuedAt }, tx));
        }
        await options.onDispatched?.(tx, rows);
        return rows;
      });
      startedAt = at;
      startMono = performance.now();
      for (const { device } of entries) pacing.dispatched(device.id);
      for (const row of dispatched) logLocationRequestStage(row, "DISPATCHED");
      logger.info({ tenantId, deviceIds: ids, startedAt }, "GPS update request started");
    });
    const at = new Date();
    const apiLatencyMs = startMono === undefined ? null : performance.now() - startMono;
    for (const { record, entry } of requests) {
      const status = classifyGpsAcceptance(result, entry.device.imageId);
      await completeLocationRequest(record.id, { status, at, apiLatencyMs,
        rejectionReason: status === "API_REJECTED" ? readGpsRejectionReason(result, entry.device.imageId) : undefined,
        rejectionDetail: status === "API_REJECTED" ? readGpsRejectionDetail(result, entry.device.imageId) : undefined });
      completed.add(record.id);
    }
    completedWithoutError = true;
    return prisma.locationRequest.findMany({ where: { id: { in: requests.map(({ record }) => record.id) } } });
  } catch (error) {
    for (const { record } of requests) {
      if (completed.has(record.id)) continue;
      await completeLocationRequest(record.id, {
        status: startedAt ? "UNCONFIRMED" : error instanceof HttpError && error.status === 409 ? "SKIPPED" : "FAILED",
        at: new Date(), apiLatencyMs: startMono === undefined ? null : performance.now() - startMono,
      });
    }
    throw error;
  } finally {
    for (const { device } of entries) pacing.completed(device.id);
    if (startedAt) logger.info({ tenantId, deviceIds: entries.map(({ device }) => device.id), startedAt,
      endedAt: new Date(), completedWithoutError }, "GPS update request finished");
  }
}
