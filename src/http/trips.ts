import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashToken } from "../security/crypto.js";
import { createTripToken, listTripTokens, readTripToken, revokeTripToken, rateLimitTripTrigger, type TripTokenContext } from "../security/tripTokens.js";
import { DrivingRouteError, searchDrivingAddresses } from "../trips/routes.js";
import { adoptTripAnchor, cancelTrip, createTrip, getTrip, getTripEnvironment, listTrips, pauseTrip, resumeTrip,
  selectRoute, selectTripEnvironment, startTrip } from "../trips/service.js";
import { HttpError } from "./errors.js";

const identifier = z.string().min(1).max(200).refine((value) => value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value));
const coordinate = z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict();
const optionsSchema = z.object({
  timeScale: z.number().finite().min(1).max(2).optional(),
  maxSpeedMps: z.number().finite().min(1).max(40).optional(),
  accelerationMps2: z.number().finite().min(0.1).max(5).optional(),
  decelerationMps2: z.number().finite().min(0.1).max(8).optional(),
}).strict();
const selectionSchema = z.object({ uploadId: identifier, recordIndex: z.number().int().min(0).max(999) }).strict();
const environmentSchema = z.object({ enabled: z.boolean(), selection: selectionSchema.optional() }).strict();
const createSchema = z.object({
  imageId: identifier, destination: coordinate, origin: coordinate.optional(),
  waypoints: z.array(coordinate.extend({ stopSeconds: z.number().finite().min(0).max(3600) })).max(5).optional(),
  options: optionsSchema.optional(), arrivalWifi: z.union([z.literal(false), environmentSchema]).optional(),
  openMaps: z.boolean().optional(),
}).strict();
const revisionSchema = z.object({ revision: identifier }).strict();
const triggerSchema = z.object({
  image_id: identifier, dest_lat: coordinate.shape.lat, dest_lng: coordinate.shape.lng,
  time_scale: z.number().finite().min(1).max(2).optional(), options: optionsSchema.optional(),
  open_maps: z.boolean().optional(),
}).strict().refine((value) => value.time_scale === undefined || value.options?.timeScale === undefined || value.time_scale === value.options.timeScale);
const idempotencySchema = z.string().min(1).max(128).refine((value) => value === value.trim() && !/[\x00-\x1f\x7f-\x9f]/.test(value));

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65_536) { req.resume(); throw new HttpError(413, "Request body too large"); }
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw new HttpError(400, "Invalid JSON"); }
}

function decodedId(value: string): string {
  try { return identifier.parse(decodeURIComponent(value)); }
  catch { throw new HttpError(400, "Invalid trip request identifier"); }
}

function queryKeys(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "Invalid trip query parameters");
  }
}

function methodNotAllowed(res: ServerResponse, methods: string[]): never {
  res.setHeader("Allow", methods.join(", "));
  throw new HttpError(405, "Method not allowed");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

async function requireTokenTrip(token: TripTokenContext, id: string): Promise<void> {
  if (!await prisma.drivingTrip.findFirst({ where: {
    id, tenantId: token.tenantId, deviceId: token.deviceId, imageId: token.imageId, device: { tenantId: token.tenantId },
  }, select: { id: true } })) throw new HttpError(404, "Trip not found");
}

export async function handleTripRequest(req: IncomingMessage, res: ServerResponse, url: URL, authTenantId?: string): Promise<boolean> {
  const path = url.pathname;
  const tripNamespace = path === "/api/trips" || path.startsWith("/api/trips/");
  const tokenNamespace = /^\/devices\/[^/]+\/trip-token(?:\/|$)/.test(path);
  if (!tripNamespace && !tokenNamespace) return false;
  res.setHeader("Cache-Control", "no-store");
  try {
    const method = req.method ?? "GET";
    const resource = path.match(/^\/api\/trips\/([^/]+)(?:\/([^/]+))?$/);
    const trigger = path === "/api/trips/trigger";
    const token = req.headers.authorization !== undefined || !authTenantId ? await readTripToken(req) : null;
    if (!token && (req.headers.authorization !== undefined || !authTenantId)) throw new HttpError(401, "Authentication required");
    const tenantId = token?.tenantId ?? identifier.parse(authTenantId);
    if (token) {
      const allowedResource = resource && !["config", "geocode", "trigger"].includes(resource[1]!) &&
        (method === "GET" && resource[2] === undefined || method === "POST" && resource[2] === "cancel");
      if (!(trigger && method === "POST") && !allowedResource) throw new HttpError(403, "This trip token does not permit this action");
    }

    if (path === "/api/trips/config") {
      queryKeys(url, []);
      if (method !== "GET") methodNotAllowed(res, ["GET"]);
      send(res, 200, { configured: true, provider: "OSRM", trafficAvailable: false, minimumIntervalMs: 1100, maxTripMinutes: 120,
        playbackMode: "REST_CHECKPOINTS", continuousPlayback: false });
      return true;
    }
    if (path === "/api/trips/geocode") {
      queryKeys(url, ["q"]);
      if (method !== "GET") methodNotAllowed(res, ["GET"]);
      const query = z.string().trim().min(3).max(200).parse(url.searchParams.get("q"));
      send(res, 200, { results: await searchDrivingAddresses(query) });
      return true;
    }
    if (trigger) {
      queryKeys(url, []);
      if (method !== "POST") methodNotAllowed(res, ["POST"]);
      if ((req.rawHeaders?.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "idempotency-key").length ?? 0) > 1) {
        throw new HttpError(400, "Provide one Idempotency-Key header");
      }
      const idempotencyKey = idempotencySchema.parse(req.headers["idempotency-key"]);
      const body = triggerSchema.parse(await readJson(req));
      if (token && body.image_id !== token.imageId) throw new HttpError(403, "This trip token is scoped to another device");
      if (token) await rateLimitTripTrigger(token.id);
      const input = {
        imageId: body.image_id, destination: { lat: body.dest_lat, lng: body.dest_lng }, arrivalWifi: false as const,
        openMaps: body.open_maps ?? false,
        options: { timeScale: body.time_scale ?? body.options?.timeScale ?? 1, maxSpeedMps: body.options?.maxSpeedMps ?? 31.3,
          accelerationMps2: body.options?.accelerationMps2 ?? 1.5, decelerationMps2: body.options?.decelerationMps2 ?? 2.5 },
      };
      let trip = await createTrip(tenantId, input, { idempotencyKey, requestHash: hashToken(JSON.stringify(canonical(input))) });
      if (token) await requireTokenTrip(token, trip.id);
      if (trip.status === "PREVIEW") {
        try { trip = await startTrip(tenantId, trip.id, trip.revision); }
        catch (error) {
          if (!(error instanceof HttpError) || error.status !== 409) throw error;
          const current = await getTrip(tenantId, trip.id);
          if (current.status === "PREVIEW") throw error;
          trip = current;
        }
      }
      send(res, 202, { trip_id: trip.id, trip });
      return true;
    }
    if (path === "/api/trips") {
      queryKeys(url, method === "GET" ? ["deviceId"] : []);
      if (method === "GET") {
        const deviceId = url.searchParams.has("deviceId") ? identifier.parse(url.searchParams.get("deviceId")) : undefined;
        send(res, 200, { trips: await listTrips(tenantId, deviceId) });
      } else if (method === "POST") send(res, 201, { trip: await createTrip(tenantId, createSchema.parse(await readJson(req))) });
      else methodNotAllowed(res, ["GET", "POST"]);
      return true;
    }
    if (tokenNamespace) {
      queryKeys(url, []);
      const match = path.match(/^\/devices\/([^/]+)\/trip-token(?:\/([^/]+))?$/);
      if (!match) throw new HttpError(404, "Trip token endpoint not found");
      const deviceId = decodedId(match[1]!);
      if (match[2] !== undefined) {
        if (method !== "DELETE") methodNotAllowed(res, ["DELETE"]);
        await revokeTripToken(deviceId, tenantId, decodedId(match[2]));
        send(res, 200, { ok: true });
      } else if (method === "GET") send(res, 200, { tokens: await listTripTokens(deviceId, tenantId) });
      else if (method === "POST") {
        const input = await readJson(req) as Parameters<typeof createTripToken>[2];
        send(res, 201, await createTripToken(deviceId, tenantId, input));
      } else methodNotAllowed(res, ["GET", "POST"]);
      return true;
    }
    if (!resource) throw new HttpError(404, "Trip endpoint not found");
    queryKeys(url, []);
    const id = decodedId(resource[1]!);
    const action = resource[2];
    if (token) await requireTokenTrip(token, id);
    if (!action) {
      if (method !== "GET") methodNotAllowed(res, ["GET"]);
      send(res, 200, { trip: await getTrip(tenantId, id) });
      return true;
    }
    if (action === "environment" && method === "GET") {
      send(res, 200, await getTripEnvironment(tenantId, id));
      return true;
    }
    if (!["start", "pause", "resume", "cancel", "adopt-anchor", "route", "environment"].includes(action)) {
      throw new HttpError(404, "Trip action not found");
    }
    if (method !== "POST") methodNotAllowed(res, action === "environment" ? ["GET", "POST"] : ["POST"]);
    const input = await readJson(req);
    let trip;
    if (action === "route") {
      const body = revisionSchema.extend({ index: z.number().int().min(0).max(2) }).parse(input);
      trip = await selectRoute(tenantId, id, body.revision, body.index);
    } else if (action === "environment") {
      const { revision, ...selection } = environmentSchema.extend({ revision: identifier }).parse(input);
      trip = await selectTripEnvironment(tenantId, id, revision, selection);
    } else if (action === "adopt-anchor") {
      const body = revisionSchema.extend({ resumeDrift: z.boolean().default(false) }).parse(input);
      trip = await adoptTripAnchor(tenantId, id, body.revision, { resumeDrift: body.resumeDrift });
    } else {
      const { revision } = revisionSchema.parse(input);
      const mutations = { start: startTrip, pause: pauseTrip, resume: resumeTrip, cancel: cancelTrip };
      trip = await mutations[action as keyof typeof mutations](tenantId, id, revision);
    }
    send(res, 200, { trip });
  } catch (error) {
    if (error instanceof HttpError) send(res, error.status, { error: error.message });
    else if (error instanceof z.ZodError) send(res, 400, { error: "Invalid trip request" });
    else if (error instanceof DrivingRouteError) send(res, error.statusCode, { error: error.message });
    else send(res, 500, { error: "Trip request failed. Try again shortly." });
  }
  return true;
}
