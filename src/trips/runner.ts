import { usesPlayer } from "./playerConnection.js";
import { stepPlayerTrip } from "./playerRunner.js";
import type { DrivingTrip } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { applyDeviceEnvironment, getDeviceStatus } from "../api/duoPlusClient.js";
import { readDeviceWifi, wifiReadbackMatches } from "../api/environmentWifi.js";
import { prisma } from "../db.js";
import { loadSavedEnvironment } from "../env/savedEnvironmentData.js";
import { HttpError } from "../http/errors.js";
import { logger } from "../logger.js";
import { reserveMovement, withEnvironmentWindow } from "../orchestrator/deviceOperations.js";
import { dispatchGps, gpsEligibility, gpsIsDue } from "../orchestrator/locationDispatch.js";
import { checkDevicePower, recordPowerObservation } from "../orchestrator/powerCheck.js";
import { withTripLease, type TripLease } from "./lease.js";
import { feedTripRadio } from "../radio/tripFeed.js";
import { readRetryableCheckpoint } from "./retryCheckpoint.js";
import { createRouteTimeline } from "./routeTimeline.js";
import { validateDrivingRoute } from "./routes.js";
import { ensureTripMaps, phoneSyncState, waitForTripPhone } from "./phoneSync.js";
import { checkpointAdvanceMs } from "./checkpointClock.js";

export const minimumTripIntervalMs = 1100;
const readinessPollMs = 3000;
const readinessTimeoutMs = 30_000;
const schedulerStallMs = 15_000;
const clocks = new Map<string, { revision: string; at: number; checkedAt: number }>();
interface ReadinessWait { revision: string; startedAt: number; nextPollAt: number; firstOnAt?: number }
const readiness = new Map<string, ReadinessWait>();
const running = new Map<string, Promise<void>>();

async function pauseUnsafe(trip: DrivingTrip, reason: string): Promise<void> {
  const changed = await prisma.$transaction(async (tx) => {
    const paused = await tx.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: { in: ["RUNNING", "ARRIVING"] } },
      data: { status: "PAUSED", pauseReason: reason, error: reason, lastStepAt: null, nextTickAt: null } });
    if (paused.count) await tx.device.updateMany({ where: { id: trip.deviceId, tenantId: trip.tenantId, activeTripId: trip.id }, data: { active: false } });
    return paused.count > 0;
  });
  if (changed) logger.warn({ tripId: trip.id, deviceId: trip.deviceId, reason }, "Driving trip paused");
  clocks.delete(trip.id);
  readiness.delete(trip.id);
}

async function requireOwnership(trip: DrivingTrip, lease: TripLease, status: "RUNNING" | "ARRIVING"): Promise<void> {
  await lease.assertOwned();
  const row = await prisma.drivingTrip.findFirst({ where: { id: trip.id, revision: trip.revision, status,
    device: { activeTripId: trip.id, tenantId: trip.tenantId, active: true } } });
  if (!row) throw new HttpError(409, "Trip ownership or state changed before dispatch");
}

async function holdForReadiness(trip: DrivingTrip, waiting: ReadinessWait, reason: string): Promise<void> {
  readiness.set(trip.id, waiting);
  const held = await prisma.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: "RUNNING",
    device: { activeTripId: trip.id, active: true } }, data: {
    pauseReason: reason, error: null, nextTickAt: new Date(Date.now() + readinessPollMs),
  } });
  if (held.count !== 1) throw new HttpError(409, "Trip state changed during its readiness check");
}

async function finishArrival(trip: DrivingTrip, lease: TripLease): Promise<void> {
  await withEnvironmentWindow(trip.deviceId, async () => {
    await requireOwnership(trip, lease, "ARRIVING");
    let wifi = JSON.parse(trip.arrivalWifiJson);
    if (wifi.enabled) {
      if (wifi.dispatchedAt) {
        await pauseUnsafe(trip, "Arrival Wi-Fi was already dispatched. Review its evidence before continuing.");
        return;
      }
      try {
        const device = await prisma.device.findUniqueOrThrow({ where: { id: trip.deviceId } });
        const route = validateDrivingRoute(JSON.parse(trip.routeJson));
        const profile = await loadSavedEnvironment(prisma, { ...device, anchorLat: route.destination.lat, anchorLng: route.destination.lng }, wifi.selection);
        if (!profile.wifi || profile.wifi.bssid !== wifi.profile?.wifi?.bssid || profile.wifi.ssid !== wifi.profile?.wifi?.ssid) {
          throw new HttpError(409, "The selected saved Wi-Fi profile is no longer eligible");
        }
        const submitted = await applyDeviceEnvironment(trip.imageId, { wifi: profile.wifi }, trip.tenantId,
          async () => { await requireOwnership(trip, lease, "ARRIVING"); },
          async () => {
            if (wifi.dispatchedAt) throw new HttpError(409, "Arrival Wi-Fi cannot be replayed automatically");
            await requireOwnership(trip, lease, "ARRIVING");
            wifi = { ...wifi, status: "APPLYING", dispatchedAt: new Date().toISOString() };
            const marked = await prisma.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: "ARRIVING" },
              data: { arrivalWifiJson: JSON.stringify(wifi) } });
            if (marked.count !== 1) throw new HttpError(409, "Arrival ownership changed before Wi-Fi dispatch");
          },
          async (checkedAt) => { await recordPowerObservation(trip.deviceId, trip.tenantId, 1, checkedAt); });
        wifi = { ...wifi, status: "API_ACCEPTED", submitted, acceptedAt: new Date().toISOString(), error: null };
        await lease.assertOwned();
        await prisma.$transaction(async (tx) => {
          const accepted = await tx.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: "ARRIVING" },
            data: { arrivalWifiJson: JSON.stringify(wifi) } });
          if (accepted.count !== 1) throw new HttpError(409, "Arrival ownership changed after Wi-Fi dispatch");
          await tx.device.updateMany({ where: { id: trip.deviceId, tenantId: trip.tenantId, activeTripId: trip.id },
            data: { wifiSsid: submitted.name, wifiBssid: submitted.bssid, wifiMac: submitted.mac } });
        });
        try {
          const readback = readDeviceWifi(await getDeviceStatus(trip.imageId, trip.tenantId), trip.imageId);
          wifi = { ...wifi, readback, readbackAt: new Date().toISOString(),
            status: wifiReadbackMatches(submitted, readback) ? "PROVIDER_MATCH" : "MISMATCH" };
        } catch {
          wifi = { ...wifi, status: "UNAVAILABLE", readbackAt: new Date().toISOString(), error: "Wi-Fi accepted; provider readback unavailable" };
        }
      } catch {
        wifi = { ...wifi, status: "FAILED", error: wifi.dispatchedAt ?
          "Arrival Wi-Fi acceptance was not confirmed. It will not be replayed automatically." :
          "Arrival Wi-Fi was not sent. Check the selected record and device Wi-Fi settings." };
      }
    }
    await lease.assertOwned();
    await prisma.$transaction(async (tx) => {
      const updated = await tx.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: "ARRIVING" },
        data: { status: "ARRIVED", arrivalWifiJson: JSON.stringify(wifi), arrivedAt: new Date(), finishedAt: new Date(), nextTickAt: null } });
      if (updated.count !== 1) throw new HttpError(409, "Arrival state changed");
      await tx.device.updateMany({ where: { id: trip.deviceId, tenantId: trip.tenantId, activeTripId: trip.id },
        data: { activeTripId: null, active: false, phase: "STATIONARY", transitMode: null, lastSpeedMps: 0 } });
    });
    clocks.delete(trip.id);
    readiness.delete(trip.id);
  });
}

async function runStep(id: string): Promise<void> {
  const initial = await prisma.drivingTrip.findUnique({ where: { id } });
  if (!initial || !["RUNNING", "ARRIVING"].includes(initial.status)) {
    clocks.delete(id);
    readiness.delete(id);
    return;
  }
  await withTripLease(initial.deviceId, initial.tenantId, async (lease) => {
    const trip = await prisma.drivingTrip.findUniqueOrThrow({ where: { id } });
    if (usesPlayer(trip.imageId) && trip.status === "RUNNING") {
      await stepPlayerTrip(trip, lease); return;
    }
    if (trip.status === "ARRIVING") {
      try {
        const ready = await withEnvironmentWindow(trip.deviceId, () => waitForTripPhone(trip,
          () => requireOwnership(trip, lease, "ARRIVING")));
        if (ready) await finishArrival(trip, lease);
      } catch (error) {
        await pauseUnsafe(trip, error instanceof HttpError ? error.message : "Final Android location readback failed.");
      }
      return;
    }
    if (trip.status !== "RUNNING" || trip.nextTickAt && trip.nextTickAt.getTime() > Date.now()) return;
    const retry = await readRetryableCheckpoint(trip);
    if ((trip.pendingElapsedMs !== null || trip.pendingProgressM !== null) && !retry) {
      await pauseUnsafe(trip, "A dispatched GPS request needs reconciliation. No request was replayed."); return;
    }
    const eligible = gpsEligibility(trip.tenantId, [trip.deviceId], new Date(), trip.id);
    let device = await prisma.device.findFirst({ where: { OR: [eligible,
      { ...eligible, poweredOn: undefined, duoPlusStatus: { in: [10, 11] } }] } });
    if (!device) { await pauseUnsafe(trip, "Device is not confirmed active and ON, or its power check has expired."); return; }
    if (!await gpsIsDue(device.id, minimumTripIntervalMs)) return;
    const release = reserveMovement(device.id);
    if (!release) return;
    let arrived = false;
    try {
      const timeline = createRouteTimeline(JSON.parse(trip.routeJson), JSON.parse(trip.optionsJson));
      const storedClock = clocks.get(id);
      const clock = trip.lastStepAt && storedClock?.revision === trip.revision ? storedClock : undefined;
      // Neither provider backpressure nor a stopped scheduler is driving time.
      if (clock && performance.now() - clock.checkedAt > schedulerStallMs) {
        await pauseUnsafe(trip, "The dispatch schedule stalled. Resume explicitly to continue without a catch-up jump."); return;
      }
      const readinessStartedAt = performance.now();
      let waiting = readiness.get(id);
      if (waiting && waiting.revision !== trip.revision) { readiness.delete(id); waiting = undefined; }
      const cachedBusy = device.duoPlusStatus === 10 || device.duoPlusStatus === 11;
      // A healthy ON phone needs no extra settling delay after every accepted checkpoint.
      // Actual busy responses and retry checkpoints retain the two-observation readiness gate.
      if (!waiting && cachedBusy) waiting = {
        revision: trip.revision, startedAt: readinessStartedAt, nextPollAt: readinessStartedAt,
      };
      if (waiting && cachedBusy) {
        waiting = { ...waiting, firstOnAt: undefined };
        readiness.set(id, waiting);
      }
      if (waiting && readinessStartedAt - waiting.startedAt >= readinessTimeoutMs) {
        await pauseUnsafe(trip, "The device did not become ready within 30 seconds. Resume explicitly after it is ON."); return;
      }
      if (waiting && readinessStartedAt < waiting.nextPollAt) return;
      try { device = await checkDevicePower(device.id, trip.tenantId); }
      catch {
        await pauseUnsafe(trip, "Device readiness could not be confirmed. No GPS update was sent."); return;
      }
      await requireOwnership(trip, lease, "RUNNING");
      if (device.phase === "EXPIRED" || device.campaignEnd.getTime() <= Date.now()) {
        await pauseUnsafe(trip, "The device campaign has expired. No GPS update was sent."); return;
      }
      if ((waiting || device.duoPlusStatus === 10 || device.duoPlusStatus === 11) &&
          performance.now() - (waiting?.startedAt ?? readinessStartedAt) >= readinessTimeoutMs) {
        await pauseUnsafe(trip, "The device did not become ready within 30 seconds. Resume explicitly after it is ON."); return;
      }
      if (device.duoPlusStatus === 10 || device.duoPlusStatus === 11) {
        await holdForReadiness(trip, {
          revision: trip.revision, startedAt: waiting?.startedAt ?? readinessStartedAt,
          nextPollAt: performance.now() + readinessPollMs,
        }, `Waiting for DuoPlus to finish its current update (status ${device.duoPlusStatus}). No GPS is being sent.`);
        return;
      }
      if (!device.poweredOn || device.duoPlusStatus !== 1) {
        await pauseUnsafe(trip, "Device is not confirmed ON. No GPS update was sent."); return;
      }
      if (waiting && (waiting.firstOnAt === undefined || performance.now() - waiting.firstOnAt < readinessPollMs)) {
        const observedAt = performance.now();
        await holdForReadiness(trip, { ...waiting, firstOnAt: waiting.firstOnAt ?? observedAt, nextPollAt: observedAt + readinessPollMs },
          "Waiting for DuoPlus to confirm stable ON status. No GPS is being sent.");
        return;
      }
      if (phoneSyncState(trip).enabled && trip.lastRequestId && !retry) {
        const ready = await waitForTripPhone(trip, () => requireOwnership(trip, lease, "RUNNING"));
        if (!ready) return;
      }
      await ensureTripMaps(trip, validateDrivingRoute(JSON.parse(trip.routeJson)).destination,
        () => requireOwnership(trip, lease, "RUNNING"));
      const before = performance.now();
      const elapsed = checkpointAdvanceMs(before, clock?.at, minimumTripIntervalMs);
      const elapsedMs = retry ? trip.pendingElapsedMs! : Math.min(timeline.durationMs, trip.elapsedMs + elapsed);
      const sampled = timeline.sample(elapsedMs);
      const point = retry ? { ...sampled, lat: retry.lat, lng: retry.lng, distanceM: trip.pendingProgressM! } : sampled;
      const proposed = { ...device, currentLat: point.lat, currentLng: point.lng, lastSpeedMps: point.speedMps,
        lastBearing: point.bearing, routeProgressM: point.distanceM, routeIndex: point.routeIndex, phase: "NAVIGATING", transitMode: "drive" };
      const records = await dispatchGps([{ device, proposed }], "DRIVE", { tripId: trip.id, intervalMs: minimumTripIntervalMs,
        beforeDispatch: async () => {
          await requireOwnership(trip, lease, "RUNNING");
          if (performance.now() - before > 5000) throw new HttpError(409, "Trip GPS waited too long in the provider queue");
        },
        onDispatched: async (tx, records) => {
          const updated = await tx.drivingTrip.updateMany({ where: {
            id: trip.id, revision: trip.revision, status: "RUNNING", lastRequestId: trip.lastRequestId,
            pendingElapsedMs: retry ? trip.pendingElapsedMs : null, pendingProgressM: retry ? trip.pendingProgressM : null,
            gpsRetryCount: retry ? 0 : trip.gpsRetryCount,
          }, data: { pendingElapsedMs: elapsedMs, pendingProgressM: point.distanceM, lastRequestId: records[0]!.id,
            ...(retry ? { gpsRetryCount: 1 } : {}) } });
          if (updated.count !== 1) throw new HttpError(409, "Trip state changed before GPS dispatch");
        },
      });
      const record = records[0]!;
      if (record.status !== "API_ACCEPTED") {
        if (record.status === "API_REJECTED" && !retry && trip.gpsRetryCount === 0) {
          const pending = await prisma.drivingTrip.findFirst({ where: { id, revision: trip.revision, status: "RUNNING", lastRequestId: record.id } });
          if (pending && await readRetryableCheckpoint(pending)) {
            await requireOwnership(trip, lease, "RUNNING");
            const now = performance.now();
            await holdForReadiness(trip, { revision: trip.revision, startedAt: now,
              nextPollAt: now + readinessPollMs },
              "Waiting for DuoPlus before one retry of the same GPS checkpoint. No GPS is being sent.");
            return;
          }
        }
        if (record.status === "API_REJECTED") await prisma.drivingTrip.updateMany({ where: { id, revision: trip.revision, status: "RUNNING", lastRequestId: record.id },
          data: { pendingElapsedMs: null, pendingProgressM: null } });
        await pauseUnsafe(trip, record.status === "DRY_RUN" ? "Dry run: no GPS was sent." :
          record.status === "API_REJECTED" && record.error ? record.error : "GPS acceptance was not confirmed. Review the request evidence.");
        return;
      }
      await lease.assertOwned();
      const accepted = await prisma.drivingTrip.updateMany({ where: { id, revision: trip.revision, status: "RUNNING", lastRequestId: record.id,
        device: { activeTripId: id } }, data: {
        elapsedMs, progressM: point.distanceM, acceptedLat: point.lat, acceptedLng: point.lng,
        pendingElapsedMs: null, pendingProgressM: null, gpsRetryCount: 0, lastStepAt: record.dispatchedAt,
        nextTickAt: new Date(Date.now() + minimumTripIntervalMs), status: point.finished ? "ARRIVING" : "RUNNING", pauseReason: null, error: null,
      } });
      if (accepted.count !== 1) throw new HttpError(409, "Trip state changed after GPS acceptance; the request evidence was preserved");
      await feedTripRadio({
        trip, bootId: `unanchored:${trip.imageId}`, instanceId: trip.revision,
        progress: {
          position: { lat: point.lat, lng: point.lng },
          elapsedMs: Math.round(elapsedMs),
          sequence: Math.max(0, Math.round(elapsedMs / 1000)),
          phase: point.finished ? 'ARRIVED' : 'MOVING',
          wallMs: Date.now(),
        },
      });
      logger.info({ tripId: id, imageId: trip.imageId, requestId: record.id,
        modeledElapsedMs: elapsedMs, modeledAdvanceMs: elapsedMs - trip.elapsedMs,
        progressM: point.distanceM, advanceM: point.distanceM - trip.progressM,
        supervisedIntervalMs: elapsed, checkpointRetry: Boolean(retry), phoneLinked: phoneSyncState(trip).enabled,
      }, "Driving checkpoint accepted");
      clocks.set(id, { revision: trip.revision, at: before, checkedAt: performance.now() });
      readiness.delete(id);
      arrived = point.finished;
    } catch (error) {
      await pauseUnsafe(trip, error instanceof HttpError ? error.message : "Trip GPS stopped after a dispatch error. Review its evidence before resuming.");
      logger.warn({ tripId: id, deviceId: device.id, errorType: error instanceof Error ? error.name : "Unknown" }, "Driving tick paused");
    } finally {
      const clock = clocks.get(id);
      if (clock?.revision === trip.revision) clock.checkedAt = performance.now();
      release();
    }
    if (arrived && !phoneSyncState(trip).enabled) await finishArrival(await prisma.drivingTrip.findUniqueOrThrow({ where: { id } }), lease);
  }, { waitMs: 0 });
}

export function stepTrip(id: string): Promise<void> {
  const active = running.get(id);
  if (active) return active;
  const work = runStep(id).finally(() => { running.delete(id); });
  running.set(id, work);
  return work;
}

export async function recoverTrips(): Promise<void> {
  clocks.clear();
  readiness.clear();
  const interrupted = await prisma.drivingTrip.findMany({ where: { status: { in: ["RUNNING", "ARRIVING"] } } });
  for (const trip of interrupted) await withTripLease(trip.deviceId, trip.tenantId, async (lease) => {
    await lease.assertOwned();
    await prisma.$transaction(async (tx) => {
      const paused = await tx.drivingTrip.updateMany({ where: { id: trip.id, revision: trip.revision, status: { in: ["RUNNING", "ARRIVING"] } }, data: {
        status: "PAUSED", revision: randomUUID(), pauseReason: "Controller restarted. Review the last accepted position before resuming.",
        lastStepAt: null, nextTickAt: null,
      } });
      if (paused.count) await tx.device.updateMany({ where: { id: trip.deviceId, tenantId: trip.tenantId, activeTripId: trip.id }, data: { active: false } });
    });
  }, { waitMs: 65_000 });
}

export function startTripScheduler(): { stop(): Promise<void> } {
  let stopped = false;
  let scan: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || scan) return;
    scan = (async () => {
      const trips = await prisma.drivingTrip.findMany({ where: { status: { in: ["RUNNING", "ARRIVING"] },
        OR: [{ nextTickAt: null }, { nextTickAt: { lte: new Date() } }] }, select: { id: true }, take: 100 });
      for (const trip of trips) void stepTrip(trip.id).catch(() => logger.warn({ tripId: trip.id }, "Trip coordination unavailable"));
    })().catch(() => logger.warn("Trip scheduling is unavailable")).finally(() => { scan = undefined; });
  }, 400);
  return { async stop() { stopped = true; clearInterval(timer); await scan; await Promise.allSettled([...running.values()]); } };
}
