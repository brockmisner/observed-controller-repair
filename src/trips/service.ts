import { usesPlayer } from "./playerConnection.js";
import { preparePlayerStart, stopPlayerTrip } from "./playerRunner.js";
import { randomUUID } from "node:crypto";
import type { Device, DrivingTrip, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { getDeviceStatus } from "../api/duoPlusClient.js";
import { readDeviceWifi } from "../api/environmentWifi.js";
import { HttpError } from "../http/errors.js";
import { withEnvironmentWindow } from "../orchestrator/deviceOperations.js";
import { checkDevicePower } from "../orchestrator/powerCheck.js";
import { loadSavedEnvironment, savedEnvironmentExplorer } from "../env/savedEnvironmentData.js";
import { serializeLocationRequest } from "../ops/locationTelemetry.js";
import { computeDrivingRoutes, DrivingRouteError, routeSegmentDistance, validateDrivingRoute, type DrivingRoute } from "./routes.js";
import { createRouteTimeline, type DrivingTimelineOptions } from "./routeTimeline.js";
import { withTripLease, type TripLease } from "./lease.js";
import { readRetryableCheckpoint } from "./retryCheckpoint.js";
import { readProviderGps } from "../api/providerGps.js";
import { phoneSyncState } from "./phoneSync.js";

const MAX_TRIP_MS = 120 * 60_000;
const MAX_ROAD_ORIGIN_DISTANCE_M = 50;
const identifier = z.string().trim().min(1).max(200);
const pointSchema = z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict();
const optionsSchema = z.object({
  timeScale: z.number().finite().min(1).max(2).optional(), maxSpeedMps: z.number().finite().min(1).max(40).optional(),
  accelerationMps2: z.number().finite().min(0.1).max(5).optional(), decelerationMps2: z.number().finite().min(0.1).max(8).optional(),
}).strict();
const selectionSchema = z.object({ uploadId: identifier, recordIndex: z.number().int().nonnegative() }).strict();
const environmentInputSchema = z.object({ enabled: z.boolean(), selection: selectionSchema.optional() }).strict();
const createSchema = z.object({
  imageId: identifier, origin: pointSchema.optional(), destination: pointSchema,
  waypoints: z.array(pointSchema.extend({ stopSeconds: z.number().finite().min(0).max(3600) })).max(5).optional(),
  options: optionsSchema.default({}), arrivalWifi: z.union([z.literal(false), environmentInputSchema]).default(false),
  openMaps: z.boolean().default(false),
}).strict();
export type CreateTripInput = z.input<typeof createSchema>;
export type TripEnvironmentInput = z.infer<typeof environmentInputSchema>;
export interface TripCreateContext { idempotencyKey: string; requestHash: string }
const pendingCreates = new Map<string, { deviceId: string; requestHash: string; result: Promise<Awaited<ReturnType<typeof serializeTrip>>> }>();
export interface TripArrivalWifi {
  enabled: boolean;
  status: string;
  selection?: z.infer<typeof selectionSchema>;
  profile?: Awaited<ReturnType<typeof loadSavedEnvironment>>;
  error: string | null;
  [key: string]: unknown;
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "Invalid trip input");
  return result.data;
}
async function ownedDevice(tenantId: string, deviceId: string, tx: Prisma.TransactionClient = prisma): Promise<Device> {
  const device = await tx.device.findFirst({ where: { id: deviceId, tenantId } });
  if (!device) throw new HttpError(404, "Device not found");
  if (await tx.site.count({ where: { deviceId, tenantId } })) throw new HttpError(409, "A fixed client owns this phone. Driving is unavailable while it is assigned.");
  return device;
}
async function ownedTrip(tenantId: string, id: string, tx: Prisma.TransactionClient = prisma): Promise<DrivingTrip> {
  parse(identifier, tenantId); parse(identifier, id);
  const row = await tx.drivingTrip.findFirst({ where: { id, tenantId, device: { tenantId } } });
  if (!row) throw new HttpError(404, "Trip not found");
  return row;
}
function revisionMatches(row: DrivingTrip, revision: string): void {
  if (typeof revision !== "string" || row.revision !== revision) throw new HttpError(409, "The trip revision changed. Review the latest trip.");
}
function requireStatus(row: DrivingTrip, allowed: string[]): void {
  if (!allowed.includes(row.status)) throw new HttpError(409, `Trip cannot perform this operation from ${row.status}.`);
}
function routeFrom(row: DrivingTrip): DrivingRoute {
  try { return validateDrivingRoute(JSON.parse(row.routeJson)); }
  catch { throw new HttpError(409, "Saved route data is invalid. Prepare a new trip preview."); }
}
function optionsFrom(row: DrivingTrip): DrivingTimelineOptions {
  try { return optionsSchema.parse(JSON.parse(row.optionsJson)); }
  catch { throw new HttpError(409, "Saved trip options are invalid. Prepare a new trip preview."); }
}
function jsonObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try { const value: unknown = JSON.parse(json); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}
function alternativesFrom(row: DrivingTrip): DrivingRoute[] {
  try {
    const value: unknown = JSON.parse(row.alternativesJson);
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error();
    return value.map(validateDrivingRoute);
  } catch { throw new HttpError(409, "Saved route alternatives are invalid. Prepare a new trip preview."); }
}
function requireFreshPreview(route: DrivingRoute): void {
  if (Date.parse(route.expiresAt) <= Date.now()) throw new HttpError(409, "The route preview expired. Prepare a new trip preview.");
}
function requireStartPosition(device: Device, row: DrivingTrip, route: DrivingRoute): void {
  const current = { lat: device.currentLat, lng: device.currentLng };
  const preview = { lat: row.originLat, lng: row.originLng };
  const anchor = { lat: device.anchorLat, lng: device.anchorLng };
  const radius = Math.max(0, device.movementRadiusM);
  const boundedDrift = device.phase === "STATIONARY"
    && routeSegmentDistance(preview, anchor) <= radius + 0.25
    && routeSegmentDistance(current, anchor) <= radius + 0.25;
  // A preview does not pause stationary drift; opposite points can be two radii apart.
  const tolerance = boundedDrift ? Math.min(30, Math.max(1, 2 * radius)) : 1;
  if (routeSegmentDistance(current, preview) > tolerance) {
    throw new HttpError(409, "The device moved beyond its preview tolerance. Prepare a new route from its current position.");
  }
  if (routeSegmentDistance(current, route.origin) > MAX_ROAD_ORIGIN_DISTANCE_M) {
    throw new HttpError(409, "The road origin is more than 50 m from the current position. Choose a reachable starting point.");
  }
}
function timelineFor(route: DrivingRoute, options: DrivingTimelineOptions) {
  const timeline = createRouteTimeline(route, options);
  if (timeline.durationMs > MAX_TRIP_MS) throw new HttpError(400, "Driving trips are limited to 120 minutes including stops.");
  return timeline;
}
async function prepareArrival(device: Device, route: DrivingRoute, input: TripEnvironmentInput): Promise<TripArrivalWifi> {
  if (!input.selection) {
    if (input.enabled) throw new HttpError(400, "Select a saved destination Wi-Fi observation first.");
    return { enabled: false, status: "DISABLED", error: null };
  }
  const profile = await loadSavedEnvironment(prisma, { ...device, anchorLat: route.destination.lat, anchorLng: route.destination.lng }, input.selection);
  return { enabled: input.enabled, status: input.enabled ? "PREPARED" : "DISABLED", selection: input.selection, profile, error: null };
}

async function serializeTrip(row: DrivingTrip) {
  const scope = { tripId: row.id, tenantId: row.tenantId, deviceId: row.deviceId, imageId: row.imageId };
  const [requested, accepted, observed] = await Promise.all([
    prisma.locationRequest.findFirst({ where: scope, orderBy: [{ requestedAt: "desc" }, { id: "desc" }] }),
    prisma.locationRequest.findFirst({ where: { ...scope, status: "API_ACCEPTED", acceptedAt: { not: null } }, orderBy: [{ acceptedAt: "desc" }, { id: "desc" }] }),
    prisma.locationRequest.findFirst({ where: { ...scope, observedAt: { not: null }, androidObservationJson: { not: null } }, orderBy: [{ observedAt: "desc" }, { id: "desc" }] }),
  ]);
  const locationTelemetry = requested ? serializeLocationRequest(requested) : null;
  const latestAccepted = accepted ? serializeLocationRequest(accepted) : null;
  const latestObserved = observed ? serializeLocationRequest(observed) : null;
  const { routeJson, alternativesJson, optionsJson, baselineJson, phoneSyncJson, arrivalWifiJson, arrivalRpaJson,
    idempotencyKey, requestHash, ...publicRow } = row;
  const route = routeFrom(row);
  const alternatives = alternativesFrom(row);
  return {
    ...publicRow, playbackMode: jsonObject(phoneSyncJson)?.transport === "DEVICE_PLAYER" || jsonObject(phoneSyncJson)?.player ? "DEVICE_PLAYER" : "REST_CHECKPOINTS", route, alternatives, routeIndex: Math.max(0, alternatives.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(route))), options: optionsFrom(row),
    baseline: jsonObject(baselineJson), arrivalWifi: jsonObject(arrivalWifiJson) ?? { enabled: false, status: "DISABLED", error: null },
    phoneSync: jsonObject(phoneSyncJson) ?? { enabled: false },
    arrivalRpa: null, totalDurationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null, arrivedAt: row.arrivedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null, lastStepAt: row.lastStepAt?.toISOString() ?? null,
    nextTickAt: row.nextTickAt?.toISOString() ?? null, locationTelemetry, latestRequested: locationTelemetry,
    latestAccepted, androidObservation: latestObserved?.androidObservation ?? null,
    evidence: { requested: locationTelemetry, apiAccepted: latestAccepted, androidObserved: latestObserved?.androidObservation ? latestObserved : null },
  };
}
export async function getTrip(tenantId: string, id: string) { return serializeTrip(await ownedTrip(tenantId, id)); }
export async function listTrips(tenantId: string, deviceId?: string) {
  parse(identifier, tenantId);
  if (deviceId) await ownedDevice(tenantId, parse(identifier, deviceId));
  const rows = await prisma.drivingTrip.findMany({ where: { tenantId, ...(deviceId ? { deviceId } : {}), device: { tenantId } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 25 });
  return Promise.all(rows.map(serializeTrip));
}

export async function createTrip(tenantId: string, value: CreateTripInput, context?: TripCreateContext) {
  parse(identifier, tenantId);
  const input = parse(createSchema, value);
  if (context) parse(z.object({ idempotencyKey: identifier, requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), context);
  const device = await prisma.device.findFirst({ where: { tenantId, imageId: input.imageId } });
  if (!device) throw new HttpError(404, "Device not found");
  const existing = async () => {
    if (!context) return null;
    const previous = await prisma.drivingTrip.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey: context.idempotencyKey } } });
    if (!previous) return null;
    if (previous.deviceId !== device.id || previous.requestHash !== context.requestHash) throw new HttpError(409, "This idempotency key was already used for a different trip request.");
    return previous;
  };
  const previous = await existing();
  if (previous) return serializeTrip(previous);
  const pendingKey = context ? JSON.stringify([tenantId, context.idempotencyKey]) : null;
  const pending = pendingKey ? pendingCreates.get(pendingKey) : null;
  if (pending) {
    if (pending.deviceId !== device.id || pending.requestHash !== context!.requestHash) throw new HttpError(409, "This idempotency key is in use for a different trip request.");
    return pending.result;
  }
  const result = withTripLease(device.id, tenantId, (lease) => withEnvironmentWindow(device.id, async () => {
    const duplicate = await existing();
    if (duplicate) return serializeTrip(duplicate);
    const current = await ownedDevice(tenantId, device.id);
    if (current.activeTripId) throw new HttpError(409, "This device already owns an active trip. Cancel it before preparing another.");
    const origin = { lat: current.currentLat, lng: current.currentLng };
    if (input.origin && routeSegmentDistance(input.origin, origin) > 1) throw new HttpError(400, "Trip origin must match the current controller position.");
    let routes: DrivingRoute[];
    try { routes = await computeDrivingRoutes({ origin, destination: input.destination, waypoints: input.waypoints }); }
    catch (error) { if (error instanceof DrivingRouteError) throw new HttpError(error.statusCode, error.message); throw error; }
    if (routes.some((route) => routeSegmentDistance(route.origin, origin) > MAX_ROAD_ORIGIN_DISTANCE_M)) throw new HttpError(409, "The road origin is more than 50 m from the current position. Choose a reachable starting point.");
    const timelines = routes.map((route) => timelineFor(route, input.options));
    const route = routes[0]!;
    const timeline = timelines[0]!;
    const arrivalWifi = await prepareArrival(current, route, input.arrivalWifi === false ? { enabled: false } : input.arrivalWifi);
    await lease.assertOwned();
    let row: DrivingTrip;
    try {
      row = await prisma.$transaction(async (tx) => {
        const fresh = await ownedDevice(tenantId, current.id, tx);
        if (fresh.activeTripId || fresh.currentLat !== origin.lat || fresh.currentLng !== origin.lng) throw new HttpError(409, "The device moved while preparing the route. Preview again.");
        return tx.drivingTrip.create({ data: {
          id: randomUUID(), tenantId, deviceId: current.id, imageId: current.imageId, revision: randomUUID(),
          status: "PREVIEW", routeJson: JSON.stringify(route), alternativesJson: JSON.stringify(routes),
          optionsJson: JSON.stringify(timeline.options), originLat: origin.lat, originLng: origin.lng,
          durationMs: timeline.durationMs, arrivalWifiJson: JSON.stringify(arrivalWifi),
          phoneSyncJson: JSON.stringify({ transport: usesPlayer(current.imageId) ? "DEVICE_PLAYER" : "REST_CHECKPOINTS", enabled: input.openMaps, maps: { status: input.openMaps ? "PENDING" : "DISABLED" } }),
          ...(context ? { idempotencyKey: context.idempotencyKey, requestHash: context.requestHash } : {}),
        } });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") { const duplicate = await existing(); if (duplicate) return serializeTrip(duplicate); }
      throw error;
    }
    return serializeTrip(row);
  }));
  if (pendingKey) pendingCreates.set(pendingKey, { deviceId: device.id, requestHash: context!.requestHash, result });
  try { return await result; } finally { if (pendingKey && pendingCreates.get(pendingKey)?.result === result) pendingCreates.delete(pendingKey); }
}

async function mutate(tenantId: string, id: string, revision: string,
  work: (row: DrivingTrip, device: Device, lease: TripLease) => Promise<void>) {
  const found = await ownedTrip(tenantId, id);
  return withEnvironmentWindow(found.deviceId, () => withTripLease(found.deviceId, tenantId, async (lease) => {
    const row = await ownedTrip(tenantId, id);
    revisionMatches(row, revision);
    await work(row, await ownedDevice(tenantId, row.deviceId), lease);
    return getTrip(tenantId, id);
  }));
}
async function updateTrip(tx: Prisma.TransactionClient, row: DrivingTrip, data: Prisma.DrivingTripUpdateManyMutationInput) {
  const updated = await tx.drivingTrip.updateMany({ where: { id: row.id, tenantId: row.tenantId, revision: row.revision, status: row.status, device: { tenantId: row.tenantId } },
    data: { ...data, revision: randomUUID() } });
  if (updated.count !== 1) throw new HttpError(409, "The trip revision changed. Review the latest trip.");
}
async function freshBaseline(device: Device) {
  const confirmed = await checkDevicePower(device.id, device.tenantId);
  if (confirmed.duoPlusStatus !== 1 || !confirmed.poweredOn) throw new HttpError(409, "The device must be confirmed ON before driving.");
  const info = await getDeviceStatus(device.imageId, device.tenantId);
  const wifi = readDeviceWifi(info, device.imageId);
  const gps = readProviderGps(info, device.imageId);
  return { capturedAt: new Date().toISOString(), provider: { gps: gps.point, gpsType: gps.type, wifi },
    controller: { current: { lat: device.currentLat, lng: device.currentLng }, anchor: { lat: device.anchorLat, lng: device.anchorLng },
      movementRadiusM: device.movementRadiusM }, power: { status: 1, checkedAt: confirmed.lastPowerSyncAt?.toISOString() ?? null } };
}

export async function startTrip(tenantId: string, id: string, revision: string) {
  return mutate(tenantId, id, revision, async (row, device, lease) => {
    requireStatus(row, ["PREVIEW"]);
    if (device.phase === "EXPIRED" || device.campaignEnd.getTime() <= Date.now()) throw new HttpError(409, "The device campaign expired. Renew it before starting a trip.");
    const route = routeFrom(row);
    requireFreshPreview(route);
    if (device.activeTripId) throw new HttpError(409, "This device already has an active trip.");
    requireStartPosition(device, row, route);
    await preparePlayerStart(row);
    const baseline = await freshBaseline(device);
    await lease.assertOwned();
    await prisma.$transaction(async (tx) => {
      requireFreshPreview(route);
      const now = new Date();
      const claimed = await tx.device.updateMany({ where: { id: device.id, tenantId, activeTripId: null, currentLat: device.currentLat, currentLng: device.currentLng,
        anchorLat: device.anchorLat, anchorLng: device.anchorLng, movementRadiusM: device.movementRadiusM,
        campaignEnd: { gt: now }, phase: device.phase, poweredOn: true, duoPlusStatus: 1 }, data: { activeTripId: row.id, active: true, phase: "NAVIGATING", transitMode: "drive",
        targetLat: route.destination.lat, targetLng: route.destination.lng, lastSpeedMps: 0 } });
      if (claimed.count !== 1) throw new HttpError(409, "The device changed or another trip claimed it. Prepare a new preview.");
      await updateTrip(tx, row, { status: "RUNNING", baselineJson: JSON.stringify(baseline), startedAt: now, lastStepAt: null,
        nextTickAt: now, pauseReason: null, error: null });
    });
  });
}
export async function pauseTrip(tenantId: string, id: string, revision: string) {
  return mutate(tenantId, id, revision, async (row, device, lease) => {
    requireStatus(row, ["RUNNING", "ARRIVING", "PAUSED"]);
    if (usesPlayer(row.imageId)) await stopPlayerTrip(row);
    if (device.activeTripId !== row.id) throw new HttpError(409, "The device no longer owns this trip.");
    await lease.assertOwned();
    await prisma.$transaction(async (tx) => {
      await updateTrip(tx, row, { status: "PAUSED", pauseReason: "Paused by user.", nextTickAt: null, lastStepAt: null });
      await tx.device.updateMany({ where: { id: device.id, tenantId, activeTripId: row.id }, data: { active: false } });
    });
  });
}
export async function resumeTrip(tenantId: string, id: string, revision: string) {
  return mutate(tenantId, id, revision, async (row, device, lease) => {
    requireStatus(row, ["PAUSED"]);
    if (usesPlayer(row.imageId)) {
      await stopPlayerTrip(row);
      await preparePlayerStart(row);
    }
    if (device.activeTripId !== row.id) throw new HttpError(409, "The device no longer owns this trip.");
    if ((row.pendingElapsedMs !== null || row.pendingProgressM !== null) && !await readRetryableCheckpoint(row)) {
      throw new HttpError(409, "A prior GPS dispatch is unconfirmed or cannot be safely retried. Cancel this trip and prepare a new preview before driving.");
    }
    routeFrom(row); optionsFrom(row);
    await freshBaseline(device);
    const phoneSync = { ...JSON.parse(row.phoneSyncJson || "{}"), ...phoneSyncState(row) };
    if (usesPlayer(row.imageId)) delete phoneSync.player;
    if (phoneSync.enabled) {
      if (phoneSync.maps.status !== "LAUNCH_ACCEPTED") phoneSync.maps = { status: "PENDING" };
      delete phoneSync.gps;
    }
    await lease.assertOwned();
    await prisma.$transaction(async (tx) => {
      const resumed = await tx.device.updateMany({ where: { id: device.id, tenantId, activeTripId: row.id, poweredOn: true, duoPlusStatus: 1 },
        data: { active: true, phase: "NAVIGATING" } });
      if (resumed.count !== 1) throw new HttpError(409, "The device changed before the trip could resume.");
      await updateTrip(tx, row, { status: "RUNNING", pauseReason: null, error: null, lastStepAt: null, nextTickAt: new Date(),
        phoneSyncJson: JSON.stringify(phoneSync) });
    });
  });
}
export async function cancelTrip(tenantId: string, id: string, revision: string) {
  return mutate(tenantId, id, revision, async (row, device, lease) => {
    requireStatus(row, ["PREVIEW", "RUNNING", "ARRIVING", "PAUSED", "FAILED"]);
    if (usesPlayer(row.imageId)) await stopPlayerTrip(row);
    await lease.assertOwned();
    await prisma.$transaction(async (tx) => {
      await updateTrip(tx, row, { status: "CANCELLED", finishedAt: new Date(), nextTickAt: null, lastStepAt: null, pauseReason: null });
      await tx.device.updateMany({ where: { id: device.id, tenantId, activeTripId: row.id },
        data: { activeTripId: null, active: false, phase: "STATIONARY", transitMode: null, targetLat: null, targetLng: null } });
    });
  });
}
export async function selectRoute(tenantId: string, id: string, revision: string, routeIndex: number) {
  return mutate(tenantId, id, revision, async (row, device, lease) => {
    requireStatus(row, ["PREVIEW"]);
    const routes = alternativesFrom(row);
    if (!Number.isSafeInteger(routeIndex) || routeIndex < 0 || routeIndex >= routes.length) throw new HttpError(400, "Choose an available route alternative.");
    const route = routes[routeIndex]!;
    requireFreshPreview(route);
    if (routeSegmentDistance(route.origin, { lat: row.originLat, lng: row.originLng }) > 50) throw new HttpError(409, "Route origin is too far from the preview position.");
    const timeline = timelineFor(route, optionsFrom(row));
    const previous = jsonObject(row.arrivalWifiJson);
    const arrival = previous?.selection ? await prepareArrival(device, route, parse(environmentInputSchema, { enabled: previous.enabled === true, selection: previous.selection })) : { enabled: false, status: "DISABLED", error: null };
    await lease.assertOwned();
    await prisma.$transaction((tx) => updateTrip(tx, row, { routeJson: JSON.stringify(route), durationMs: timeline.durationMs, arrivalWifiJson: JSON.stringify(arrival) }));
  });
}
export async function getTripEnvironment(tenantId: string, id: string) {
  const row = await ownedTrip(tenantId, id);
  const route = routeFrom(row);
  const device = await ownedDevice(tenantId, row.deviceId);
  return savedEnvironmentExplorer(prisma, { ...device, anchorLat: route.destination.lat, anchorLng: route.destination.lng });
}
export async function selectTripEnvironment(tenantId: string, id: string, revision: string, value: TripEnvironmentInput) {
  const input = parse(environmentInputSchema, value);
  return mutate(tenantId, id, revision, async (row, device, lease) => {
    requireStatus(row, ["PREVIEW"]);
    const route = routeFrom(row);
    requireFreshPreview(route);
    const arrivalWifi = await prepareArrival(device, route, input);
    await lease.assertOwned();
    await prisma.$transaction((tx) => updateTrip(tx, row, { arrivalWifiJson: JSON.stringify(arrivalWifi) }));
  });
}
export async function adoptTripAnchor(tenantId: string, id: string, revision: string, value: { resumeDrift?: boolean } = {}) {
  const input = parse(z.object({ resumeDrift: z.boolean().default(false) }).strict(), value);
  return mutate(tenantId, id, revision, async (row, device, lease) => {
    if (usesPlayer(row.imageId)) throw new HttpError(409, "Player sessions restore normal location on completion; set a new baseline before adopting an anchor.");
    if (row.status !== "ARRIVED" || row.acceptedLat === null || row.acceptedLng === null) throw new HttpError(409, "Only an arrived trip can adopt its final anchor.");
    if (device.activeTripId && device.activeTripId !== row.id) throw new HttpError(409, "Another trip owns this device.");
    const destination = routeFrom(row).destination;
    if (routeSegmentDistance({ lat: row.acceptedLat, lng: row.acceptedLng }, destination) > 1 ||
        routeSegmentDistance({ lat: device.currentLat, lng: device.currentLng }, destination) > 1) throw new HttpError(409, "The device no longer holds the trip destination.");
    if (input.resumeDrift) await freshBaseline(device);
    await lease.assertOwned();
    await prisma.$transaction(async (tx) => {
      await updateTrip(tx, row, {});
      const adopted = await tx.device.updateMany({ where: { id: device.id, tenantId, activeTripId: device.activeTripId,
        currentLat: device.currentLat, currentLng: device.currentLng }, data: { anchorLat: destination.lat, anchorLng: destination.lng,
        active: input.resumeDrift, activeTripId: null, phase: "STATIONARY", transitMode: null, targetLat: null, targetLng: null } });
      if (adopted.count !== 1) throw new HttpError(409, "The device changed before its anchor could be adopted.");
    });
  });
}
