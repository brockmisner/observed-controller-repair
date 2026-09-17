import { handleWarmupRequest } from "./warmup.js";
import { assertNoWarmup } from "../warmup/service.js";
import { savedFolders } from "../orchestrator/folders.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { config } from "../config.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { getDeviceStatus, listCloudPhones, observeDeviceLocation, validateDuoPlusKey } from "../api/duoPlusClient.js";
import {
  parkStationary,
  queueSearch,
  registerDevice,
  setAnchor,
  startNavigation,
} from "../orchestrator/registry.js";
import { routePolyline } from "../geo/osrm.js";
import { eventsSince } from "../ops/events.js";
import { qpsSnapshot } from "../ops/qps.js";
import { keyPool } from "../api/keyPool.js";
import { addTenantKey, deleteTenantKey, listTenantKeys } from "../api/tenantKeys.js";
import { resolveWigleCluster, wigleConfigured } from "../env/wigle.js";
import { getFleetRuntime, syncPowerState } from "../orchestrator/fleetSync.js";
import {
  clearSessionCookie,
  login,
  logout,
  readAuth,
  registerAccount,
  setSessionCookie,
  type AuthContext,
} from "../security/auth.js";
import { tryServeStatic } from "./static.js";
import { HttpError } from "./errors.js";
import { redisConnection } from "../queue/connection.js";
import { getTenantWigleStatus, saveTenantWigleCredentials, deleteTenantWigleCredentials } from "../api/wigleKeys.js";
import { KeyDeadError, RateLimitError } from "../types.js";
import { applyEnvironment, environmentView, previewEnvironment, recheckEnvironment } from "../orchestrator/environment.js";
import { checkDevicePower } from "../orchestrator/powerCheck.js";
import { saveWigleUpload, uploadSummary } from "../ops/wigleUpload.js";
import { savedEnvironmentExplorer } from "../env/savedEnvironmentData.js";
import { getLocationTelemetry, recordAndroidObservation, serializeLocationRequest } from "../ops/locationTelemetry.js";
import { withEnvironmentWindow } from "../orchestrator/deviceOperations.js";
import { handleTripRequest } from "./trips.js";
import { handleSiteRequest } from "./sites.js";
import { getTrip } from "../trips/service.js";
import { haversineMeters } from "../geo/haversine.js";
import { checkPhoneLocation } from "../ops/phoneLocationCheck.js";

const latitude = z.number().finite().min(-90).max(90);
const longitude = z.number().finite().min(-180).max(180);
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(128) });
const registerSchema = loginSchema.extend({ password: z.string().min(12).max(128), workspace: z.string().trim().max(100).default("") });
const authAttempts = new Map<string, { count: number; until: number }>();

function limitAuth(req: IncomingMessage): void {
  const now = Date.now();
  for (const [ip, entry] of authAttempts) if (entry.until < now) authAttempts.delete(ip);
  const forwarded = req.headers["x-forwarded-for"];
  const ip = config.production && typeof forwarded === "string"
    ? forwarded.split(",").at(-1)!.trim() : req.socket.remoteAddress ?? "unknown";
  const entry = authAttempts.get(ip) ?? { count: 0, until: now + 10 * 60_000 };
  if (++entry.count > 30 || (!authAttempts.has(ip) && authAttempts.size >= 10_000)) {
    throw new HttpError(429, "Too many sign-in attempts. Try again in 10 minutes.");
  }
  authAttempts.set(ip, entry);
}

async function readJson(req: IncomingMessage, maxBytes = 65_536): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  if (!req.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) {
      req.resume();
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw new HttpError(400, "Invalid JSON"); }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

export function startHttpServer(): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(config.httpPort, "0.0.0.0", () => {
    logger.info({ port: config.httpPort }, "observatory HTTP + UI listening");
  });
  return server;
}

async function snapshot(tenantId?: string) {
  const runtime = getFleetRuntime(tenantId);
  const folderInventory = await savedFolders(tenantId);
  const deviceWhere = tenantId ? { tenantId } : {};
  const [deviceRows, keys, rpa, tickRows, activeDevices, poweredOn] = await Promise.all([
    prisma.device.findMany({ where: deviceWhere, orderBy: { updatedAt: "desc" }, include: {
      environment: true,
      drivingTrips: { orderBy: { createdAt: "desc" }, take: 1 },
      locationRequests: { orderBy: { requestedAt: "desc" }, take: 1 },
      wigleArchives: { orderBy: { importedAt: "desc" }, select: {
        id: true, sha256: true, clusterJson: true, queriedAt: true, importedAt: true, source: true,
      } },
      wigleUploads: { orderBy: { importedAt: "desc" }, select: {
        id: true, filename: true, importedAt: true, wifiCount: true, cellCount: true,
        rejectedCount: true, duplicateCount: true, bluetoothCount: true,
      } },
    } }),
    tenantId ? listTenantKeys(tenantId) : prisma.apiKeyStat.findMany({ orderBy: { label: "asc" } }),
    prisma.rpaJob.findMany({
      where: tenantId ? { device: { tenantId } } : undefined,
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    prisma.telemetryTick.findMany({
      where: tenantId ? { device: { tenantId } } : undefined,
      orderBy: { createdAt: "desc" },
      take: 800,
    }),
    prisma.device.count({ where: { ...deviceWhere, active: true } }),
    prisma.device.count({ where: { ...deviceWhere, poweredOn: true, duoPlusStatus: 1 } }),
  ]);
  const devices = await Promise.all(deviceRows.map(async ({ environment, locationRequests, drivingTrips, ...device }) => ({
    ...device,
    environment: environmentView(environment, device),
    locationTelemetry: locationRequests[0] ? serializeLocationRequest(locationRequests[0]) : null,
    trip: drivingTrips[0] ? await getTrip(device.tenantId, drivingTrips[0].id) : null,
  })));
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = await eventsSince(devices.map((d) => d.id), since);

  const ticks: Record<string, typeof tickRows> = {};
  for (const tick of tickRows) {
    const list = ticks[tick.deviceId] ?? [];
    if (list.length < 250) list.push(tick);
    ticks[tick.deviceId] = list;
  }

  return {
    health: {
      ok: true,
      service: "observatory-controller",
      keys: Array.isArray(keys) ? keys.length : keyPool.size(),
      activeDevices,
      dryRun: config.dryRun,
      sendExtendedGps: config.sendExtendedGps,
      tickWindowMs: [config.stationaryTickMinMs, config.stationaryTickMaxMs],
      boundM: config.boundM,
      wigleConfigured: await wigleConfigured(tenantId),
      wigleRadiusM: config.wigleRadiusM,
      poweredOn,
      telemetryOnlyWhenPowered: config.telemetryOnlyWhenPowered,
      lastFleetSyncAt: runtime.lastSyncAt,
      fleetSyncError: runtime.lastError,
      nextFleetSyncMs: runtime.nextSyncMs,
      powerStatusMaxAgeMs: config.powerStatusMaxAgeMs,
      qps: qpsSnapshot(tenantId, Math.max(1, keys.length)),
      darkHoursToday: Number((runtime.darkMsToday / 3_600_000).toFixed(2)),
    },
    devices,
    folderInventory,
    discoveredDevices: runtime.onlineDevices,
    keys,
    rpa,
    ticks,
    events,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    if (config.production) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const origin = req.headers.origin;
      if (req.headers["sec-fetch-site"] === "cross-site" || (origin && new URL(origin).host !== req.headers.host)) {
        throw new HttpError(403, "Cross-site request rejected");
      }
    }

    if (method === "GET" && path === "/health") {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all([prisma.$queryRaw`SELECT 1`, redisConnection.ping()]),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("health timeout")), 2000); }),
        ]);
        send(res, 200, { ok: true, service: "observatory-controller" });
      } catch { send(res, 503, { ok: false, service: "observatory-controller" }); }
      finally { clearTimeout(timeout); }
      return;
    }

    if (method === "GET" && path === "/auth/config") {
      send(res, 200, { signupsOpen: config.signupsOpen });
      return;
    }

    if (method === "GET" && (path === "/" || path.startsWith("/ui") || path.startsWith("/assets") || path.startsWith("/downloads/") || path.includes("."))) {
      if (tryServeStatic(req, res)) return;
    }

    if (method === "POST" && path === "/auth/register") {
      limitAuth(req);
      if (!config.signupsOpen) {
        send(res, 403, { error: "signups closed" });
        return;
      }
      const body = registerSchema.parse(await readJson(req));
      await registerAccount(body.email, body.password, body.workspace ?? "");
      const { token, ctx } = await login(body.email, body.password);
      setSessionCookie(res, token);
      send(res, 201, { user: ctx });
      return;
    }

    if (method === "POST" && path === "/auth/login") {
      limitAuth(req);
      const body = loginSchema.parse(await readJson(req));
      const { token, ctx } = await login(body.email, body.password);
      setSessionCookie(res, token);
      send(res, 200, { user: ctx });
      return;
    }

    if (method === "POST" && path === "/auth/logout") {
      await logout(req);
      clearSessionCookie(res);
      send(res, 200, { ok: true });
      return;
    }

    if (method === "GET" && path === "/auth/me") {
      const me = await readAuth(req);
      if (!me) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      send(res, 200, { user: me });
      return;
    }

    const auth = await readAuth(req);
    if (await handleWarmupRequest(req, res, url, auth?.tenantId)) return;
    if (await handleSiteRequest(req, res, url, auth?.tenantId)) return;
    if (await handleTripRequest(req, res, url, auth?.tenantId)) return;
    if (config.authRequired && !auth && path !== "/health") {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    const tenantId = auth?.tenantId;

    if (method === "GET" && path === "/api/snapshot") {
      send(res, 200, { ...(await snapshot(tenantId)), user: auth });
      return;
    }

    if (method === "GET" && path === "/api/keys") {
      if (!tenantId) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      send(res, 200, { keys: await listTenantKeys(tenantId) });
      return;
    }

    if (method === "POST" && path === "/api/keys") {
      if (!tenantId) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const body = z.object({ key: z.string().trim().min(8).max(4096), label: z.string().trim().max(100).optional() }).parse(await readJson(req));
      await validateDuoPlusKey(body.key);
      const created = await addTenantKey(tenantId, body.key, body.label);
      send(res, 201, { key: created });
      return;
    }

    const delKey = path.match(/^\/api\/keys\/([^/]+)$/);
    if (method === "DELETE" && delKey && tenantId) {
      await deleteTenantKey(tenantId, decodeURIComponent(delKey[1]!));
      send(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/api/fleet-sync") {
      const result = await syncPowerState(tenantId);
      send(res, 200, { ...result, lastSyncAt: getFleetRuntime(tenantId).lastSyncAt });
      return;
    }

    if (method === "GET" && path === "/api/route") {
      const oLat = Number(url.searchParams.get("oLat"));
      const oLng = Number(url.searchParams.get("oLng"));
      const dLat = Number(url.searchParams.get("dLat"));
      const dLng = Number(url.searchParams.get("dLng"));
      if (!["oLat", "oLng", "dLat", "dLng"].every((name) => url.searchParams.has(name)) || ![oLat, oLng, dLat, dLng].every(Number.isFinite)) {
        send(res, 400, { error: "oLat oLng dLat dLng required" });
        return;
      }
      latitude.parse(oLat); longitude.parse(oLng); latitude.parse(dLat); longitude.parse(dLng);
      const points = await routePolyline({ lat: oLat, lng: oLng }, { lat: dLat, lng: dLng }, "foot");
      send(res, 200, { points });
      return;
    }

    if (method === "GET" && path === "/api/wigle") {
      if (!tenantId) throw new HttpError(401, "Unauthorized");
      if (!url.searchParams.has("lat") && !url.searchParams.has("lng")) {
        send(res, 200, { credential: await getTenantWigleStatus(tenantId) });
        return;
      }
      const lat = Number(url.searchParams.get("lat"));
      const lng = Number(url.searchParams.get("lng"));
      if (!url.searchParams.has("lat") || !url.searchParams.has("lng") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        send(res, 400, { error: "lat and lng query params required" });
        return;
      }
      latitude.parse(lat); longitude.parse(lng);
      if (!await wigleConfigured(tenantId)) throw new HttpError(400, "Add your WiGLE API name and token first.");
      const cluster = await resolveWigleCluster(lat, lng, undefined, tenantId);
      send(res, 200, { cluster, networks: cluster.nearby });
      return;
    }

    if (path === "/api/wigle" && (method === "POST" || method === "DELETE")) {
      if (!tenantId) throw new HttpError(401, "Unauthorized");
      if (method === "DELETE") {
        await deleteTenantWigleCredentials(tenantId);
        send(res, 200, { ok: true });
      } else {
        const body = z.object({ apiName: z.string().trim().min(1).max(512), apiToken: z.string().trim().min(1).max(4096) }).parse(await readJson(req));
        try {
          send(res, 200, { credential: await saveTenantWigleCredentials(tenantId, body.apiName, body.apiToken) });
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : "WiGLE validation failed");
        }
      }
      return;
    }

    const devicePath = path.match(/^\/devices\/([^/]+)\//);
    const scopedDevice = devicePath ? await prisma.device.findFirst({
      where: { tenantId, OR: [{ imageId: decodeURIComponent(devicePath[1]!) }, { id: decodeURIComponent(devicePath[1]!) }] },
    }) : null;
    if (devicePath && !scopedDevice) throw new HttpError(404, "Device not found");

    if (method === "GET" && /^\/devices\/[^/]+\/location-telemetry$/.test(path)) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      const limit = url.searchParams.has("limit")
        ? z.coerce.number().int().min(1).max(50).parse(url.searchParams.get("limit")) : 20;
      const requests = await getLocationTelemetry(scopedDevice!.id, limit);
      send(res, 200, { requests: requests.map(serializeLocationRequest) });
      return;
    }

    const observationPath = path.match(/^\/devices\/[^/]+\/location-telemetry\/([^/]+)\/observation$/);
    if (method === "POST" && observationPath) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      const request = await recordAndroidObservation(scopedDevice!.id, decodeURIComponent(observationPath[1]!), await readJson(req));
      send(res, 200, { request: serializeLocationRequest(request) });
      return;
    }

    if (method === "GET" && /^\/devices\/[^/]+\/wigle\/explorer$/.test(path)) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      send(res, 200, await savedEnvironmentExplorer(prisma, scopedDevice!));
      return;
    }

    const wigleUploadsPath = path.match(/^\/devices\/([^/]+)\/wigle\/uploads$/);
    if (wigleUploadsPath && method === "POST") {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      // A bounded JSON envelope keeps uploaded files out of the filesystem and provider paths.
      const body = z.object({ filename: z.string().min(1).max(255), data: z.unknown() }).strict()
        .parse(await readJson(req, 1_048_576 + 1024));
      const result = await saveWigleUpload(prisma, scopedDevice!.id, tenantId, body.filename, body.data);
      send(res, result.duplicate ? 200 : 201, result);
      return;
    }

    const wigleUploadPath = path.match(/^\/devices\/([^/]+)\/wigle\/uploads\/([^/]+)$/);
    if (wigleUploadPath && method === "GET") {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      const upload = await prisma.deviceWigleUpload.findFirst({ where: {
        id: decodeURIComponent(wigleUploadPath[2]!), deviceId: scopedDevice!.id, device: { tenantId },
      } });
      if (!upload) throw new HttpError(404, "Saved WiGLE upload not found");
      send(res, 200, { upload: { ...uploadSummary(upload), data: JSON.parse(upload.payloadJson) } });
      return;
    }

    if (method === "GET" && path === "/devices") {
      const devices = await prisma.device.findMany({
        where: tenantId ? { tenantId } : undefined,
        orderBy: { updatedAt: "desc" },
      });
      send(res, 200, { devices });
      return;
    }

    const ticksPath = path.match(/^\/devices\/([^/]+)\/ticks$/);
    if (method === "GET" && ticksPath) {
      const device = scopedDevice;
      if (!device) {
        send(res, 404, { error: "device not found" });
        return;
      }
      const ticks = await prisma.telemetryTick.findMany({
        where: { deviceId: device.id },
        orderBy: { createdAt: "desc" },
        take: 200,
      });
      send(res, 200, { device, ticks: ticks.reverse() });
      return;
    }

    if (method === "POST" && path === "/devices") {
      const body = z.object({
        imageId: z.string().trim().min(1).max(200), name: z.string().max(200).optional(),
        anchorLat: latitude, anchorLng: longitude,
        groundElevationM: z.number().finite().optional(), timezone: z.string().max(100).optional(),
        language: z.string().max(50).optional(), wifiSsid: z.string().max(100).optional(),
        wifiBssid: z.string().max(100).optional(), wifiMac: z.string().max(100).optional(),
        lookupWigle: z.boolean().optional(), carrier: z.string().max(100).optional(),
        msisdn: z.string().max(100).optional(), msin: z.string().max(100).optional(),
        iccid: z.string().max(100).optional(), imsi: z.string().max(100).optional(),
        lac: z.number().int().nonnegative().optional(), cid: z.number().int().nonnegative().optional(),
        proxyIp: z.string().max(100).optional(), proxyIsp: z.string().max(200).optional(),
        proxyAsn: z.string().max(100).optional(), proxyKind: z.string().max(100).optional(),
        campaignDays: z.number().positive().max(3650).optional(),
      }).parse(await readJson(req));
      if (!tenantId) {
        send(res, 401, { error: "unauthorized" });
        return;
      }
      const device = await registerDevice({ ...body, tenantId });
      send(res, 201, { device });
      return;
    }

    const nav = path.match(/^\/devices\/([^/]+)\/navigate$/);
    if (method === "POST" && nav) {
      const imageId = scopedDevice!.id;
      const body = z.object({ destLat: latitude, destLng: longitude,
        polyline: z.union([z.string().max(50_000), z.array(z.object({ lat: latitude, lng: longitude })).min(2).max(2000)]).optional(),
        transitMode: z.enum(["walk", "drive"]).optional(),
      }).parse(await readJson(req));
      const current = scopedDevice;
      const origin = current
        ? { lat: current.currentLat, lng: current.currentLng }
        : { lat: body.destLat, lng: body.destLng };
      const dest = { lat: body.destLat, lng: body.destLng };
      const mode = body.transitMode ?? "walk";
      const points =
        body.polyline && (typeof body.polyline === "string" || body.polyline.length > 2)
          ? body.polyline
          : await routePolyline(origin, dest, mode === "drive" ? "driving" : "foot");
      const device = await startNavigation(imageId, dest, points, mode, tenantId);
      send(res, 200, { device });
      return;
    }

    const anchorPath = path.match(/^\/devices\/([^/]+)\/anchor$/);
    if (method === "POST" && anchorPath) {
      const body = z.object({ lat: latitude, lng: longitude }).parse(await readJson(req));
      const result = await setAnchor(scopedDevice!.id, body.lat, body.lng, tenantId);
      send(res, 200, { ...result, locationRequest: result.locationRequest ? serializeLocationRequest(result.locationRequest) : null });
      return;
    }

    const radiusPath = path.match(/^\/devices\/([^/]+)\/radius$/);
    if (method === "POST" && radiusPath) {
      const body = z.object({ radiusM: z.number().finite().int().min(1).max(100) }).parse(await readJson(req));
      const device = await withEnvironmentWindow(scopedDevice!.id, () => prisma.$transaction(async (tx) => {
        const current = await tx.device.findFirst({ where: { id: scopedDevice!.id, tenantId } });
        if (!current) throw new HttpError(404, "Device not found");
        if (await prisma.site.count({ where: { deviceId: current.id } })) throw new HttpError(409, "Use the Clients workspace for this phone");
        if (current.activeTripId) throw new HttpError(409, "A driving trip owns this device. Cancel the trip before changing its radius.");
        const distanceM = haversineMeters(current.anchorLat, current.anchorLng, current.currentLat, current.currentLng);
        if (!Number.isFinite(distanceM) || distanceM > body.radiusM) {
          throw new HttpError(409, "The current position is outside the requested radius. Confirm the anchor or choose a larger radius.");
        }
        await assertNoWarmup(current.id, tx);
        return tx.device.update({ where: { id: current.id }, data: { movementRadiusM: body.radiusM } });
      }));
      send(res, 200, { device });
      return;
    }

    if (method === "POST" && /^\/devices\/[^/]+\/location\/check$/.test(path)) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      z.object({}).strict().parse(await readJson(req));
      const result = await withEnvironmentWindow(scopedDevice!.id, () => checkPhoneLocation(scopedDevice!.id, tenantId, {
        getDevice: (id, tenantId) => prisma.device.findFirst({ where: { id, tenantId } }),
        observe: observeDeviceLocation, powerMaxAgeMs: config.powerStatusMaxAgeMs,
      }));
      send(res, 200, result);
      return;
    }

    const powerCheck = path.match(/^\/devices\/([^/]+)\/power\/check$/);
    if (method === "POST" && powerCheck) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      z.object({}).strict().parse(await readJson(req));
      const { id, poweredOn, duoPlusStatus, lastPowerSyncAt, lastSeenOnAt } = await checkDevicePower(scopedDevice!.id, tenantId);
      send(res, 200, { device: { id, poweredOn, duoPlusStatus, lastPowerSyncAt, lastSeenOnAt } });
      return;
    }

    const environmentPreview = path.match(/^\/devices\/([^/]+)\/(?:environment\/(preview|more)|rebind)$/);
    if (method === "POST" && environmentPreview) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      const body = await readJson(req);
      let continuation: { revision: string } | undefined;
      if (environmentPreview[2] === "more") continuation = z.object({ revision: z.string().min(1).max(100) }).strict().parse(body);
      else z.object({}).strict().parse(body);
      const environment = await previewEnvironment(scopedDevice!.id, tenantId, undefined, continuation);
      const wigleUploads = await prisma.deviceWigleUpload.findMany({
        where: { deviceId: scopedDevice!.id, device: { tenantId } }, orderBy: { importedAt: "desc" },
        select: { id: true, filename: true, importedAt: true, wifiCount: true, cellCount: true,
          bluetoothCount: true, rejectedCount: true, duplicateCount: true },
      });
      send(res, 200, { environment, wigleUploads: wigleUploads.map(uploadSummary) });
      return;
    }

    if (method === "POST" && /^\/devices\/[^/]+\/environment\/preview-saved$/.test(path)) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      const selection = z.object({ uploadId: z.string().min(1).max(100), recordIndex: z.number().int().min(0).max(999) }).strict()
        .parse(await readJson(req));
      send(res, 200, { environment: await previewEnvironment(scopedDevice!.id, tenantId, selection) });
      return;
    }

    const environmentApply = path.match(/^\/devices\/([^/]+)\/environment\/apply$/);
    if (method === "POST" && environmentApply) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      const body = z.object({ revision: z.string().min(1).max(100) }).strict().parse(await readJson(req));
      send(res, 200, { environment: await applyEnvironment(scopedDevice!.id, tenantId, body.revision) });
      return;
    }

    if (method === "POST" && /^\/devices\/[^/]+\/environment\/recheck$/.test(path)) {
      if (!tenantId) throw new HttpError(401, "Workspace required");
      const body = z.object({ revision: z.string().min(1).max(100) }).strict().parse(await readJson(req));
      send(res, 200, { environment: await recheckEnvironment(scopedDevice!.id, tenantId, body.revision) });
      return;
    }

    const park = path.match(/^\/devices\/([^/]+)\/stationary$/);
    if (method === "POST" && park) {
      const device = await parkStationary(scopedDevice!.id, tenantId);
      send(res, 200, { device });
      return;
    }

    const toggle = path.match(/^\/devices\/([^/]+)\/active$/);
    if (method === "POST" && toggle) {
      const body = z.object({ active: z.boolean().optional() }).parse(await readJson(req));
      const existing = scopedDevice;
      if (!existing) {
        send(res, 404, { error: "device not found" });
        return;
      }
      const device = await withEnvironmentWindow(existing.id, async () => {
        const current = await prisma.device.findUniqueOrThrow({ where: { id: existing.id } });
        if (await prisma.site.count({ where: { deviceId: current.id } })) throw new HttpError(409, "A client owns this phone; legacy drift cannot be enabled");
        if (current.activeTripId) throw new HttpError(409, "Use the Driving pause, resume or cancel controls for this device.");
        await assertNoWarmup(current.id);
        return prisma.device.update({ where: { id: current.id, activeTripId: null }, data: { active: body.active ?? !current.active } });
      });
      send(res, 200, { device });
      return;
    }

    const rpa = path.match(/^\/devices\/([^/]+)\/rpa$/);
    if (method === "POST" && rpa) {
      const body = z.object({ templateId: z.string().min(1).max(200), name: z.string().max(200).optional(), variables: z.record(z.unknown()).optional() }).parse(await readJson(req));
      await queueSearch(scopedDevice!.id, body.templateId, body.variables ?? {}, body.name, tenantId);
      send(res, 202, { queued: true });
      return;
    }

    const remote = path.match(/^\/devices\/([^/]+)\/remote$/);
    if (method === "GET" && remote) {
      const data = await getDeviceStatus(scopedDevice!.imageId, tenantId);
      send(res, 200, { data });
      return;
    }

    if (method === "GET" && path === "/cloud-phones") {
      const data = await listCloudPhones(1, 50, tenantId);
      send(res, 200, { data });
      return;
    }

    if (method === "GET" && tryServeStatic(req, res)) return;
    send(res, 404, { error: "not found" });
  } catch (err) {
    if (err instanceof RateLimitError) {
      res.setHeader("Retry-After", Math.ceil(err.retryAfterMs / 1000));
      send(res, 429, { error: "DuoPlus is rate limited. Try again shortly." }); return;
    }
    if (err instanceof KeyDeadError) { send(res, 400, { error: "DuoPlus authentication failed. Update your API key." }); return; }
    if (err instanceof HttpError) { send(res, err.status, { error: err.message }); return; }
    if (err instanceof z.ZodError) {
      send(res, 400, { error: err.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") });
      return;
    }
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      send(res, 409, { error: req.url?.startsWith("/api/warmup") ? "That name or phone is already reserved. Refresh before trying again." : "This account or API key already exists" }); return;
    }
    logger.error({ message: err instanceof Error ? err.message : "unknown error" }, "http handler error");
    send(res, 500, { error: "Request failed. Please try again." });
  }
}
