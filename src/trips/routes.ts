import axios from "axios";
import { distance } from "@turf/distance";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const MAX_POINTS = 100_000;
const MAX_DISTANCE_M = 20_000_000;
const MAX_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
const coordinate = z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict();
const durationMs = z.number().finite().positive().max(MAX_DURATION_MS);
const trafficCategory = z.enum(["NORMAL", "SLOW", "TRAFFIC_JAM", "UNKNOWN"]);
const routeSchema = z.object({
  provider: z.literal("OSRM"), points: z.array(coordinate).min(2).max(MAX_POINTS),
  distanceM: z.number().finite().positive().max(MAX_DISTANCE_M), durationMs, staticDurationMs: durationMs,
  traffic: z.array(z.object({ startIndex: z.number().int().nonnegative(), endIndex: z.number().int().positive(), category: trafficCategory })).min(1).max(MAX_POINTS),
  fetchedAt: z.string().datetime(), expiresAt: z.string().datetime(), origin: coordinate, destination: coordinate,
  description: z.string().max(300).optional(),
  stops: z.array(z.object({ pointIndex: z.number().int().positive(), durationMs: z.number().finite().min(0).max(3_600_000) })).max(5).optional(),
  segmentDurationMs: z.array(z.number().finite().min(0).max(MAX_DURATION_MS)).max(MAX_POINTS).optional(),
});
export type DrivingRoute = z.infer<typeof routeSchema>;
export type LatLng = z.infer<typeof coordinate>;
export type TrafficCategory = z.infer<typeof trafficCategory>;
const inputSchema = z.object({
  origin: coordinate, destination: coordinate,
  waypoints: z.array(coordinate.extend({ stopSeconds: z.number().finite().min(0).max(3600) })).max(5).default([]),
  computeAlternativeRoutes: z.boolean().default(true),
}).strict();
export type DrivingRouteInput = z.input<typeof inputSchema>;

export class DrivingRouteError extends Error {
  constructor(message: string, public readonly statusCode = 502) { super(message); this.name = "DrivingRouteError"; }
}

function invalidResponse(): never { throw new DrivingRouteError("Routing provider returned invalid route data."); }
export function routeSegmentDistance(a: LatLng, b: LatLng): number {
  return distance([a.lng, a.lat], [b.lng, b.lat], { units: "meters" });
}
export function validateDrivingRoute(value: unknown): DrivingRoute {
  const parsed = routeSchema.safeParse(value);
  if (!parsed.success) invalidResponse();
  const route = parsed.data;
  let geometryDistance = 0;
  for (let i = 1; i < route.points.length; i++) geometryDistance += routeSegmentDistance(route.points[i - 1]!, route.points[i]!);
  if (!Number.isFinite(geometryDistance) || geometryDistance <= 0 || geometryDistance > MAX_DISTANCE_M ||
      Math.abs(geometryDistance - route.distanceM) > Math.max(100, route.distanceM * 0.25)) invalidResponse();
  const first = route.points[0]!;
  const last = route.points.at(-1)!;
  if (first.lat !== route.origin.lat || first.lng !== route.origin.lng || last.lat !== route.destination.lat || last.lng !== route.destination.lng ||
      Date.parse(route.expiresAt) <= Date.parse(route.fetchedAt)) invalidResponse();
  let endIndex = 0;
  for (const interval of route.traffic) {
    if (interval.startIndex !== endIndex || interval.endIndex <= interval.startIndex ||
        interval.endIndex >= route.points.length || interval.category !== "UNKNOWN") invalidResponse();
    endIndex = interval.endIndex;
  }
  if (endIndex !== route.points.length - 1) invalidResponse();
  if (route.segmentDurationMs && (route.segmentDurationMs.length !== route.points.length - 1 ||
      route.segmentDurationMs.reduce((sum, duration) => sum + duration, 0) > route.durationMs + Math.max(1000, route.durationMs * 0.05))) invalidResponse();
  let priorStop = 0;
  for (const stop of route.stops ?? []) {
    if (stop.pointIndex <= priorStop || stop.pointIndex >= route.points.length - 1) invalidResponse();
    priorStop = stop.pointIndex;
  }
  return route;
}

function serverBase(name: string, fallback: string): string {
  try {
    const url = new URL(process.env[name]?.trim() || fallback);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch { throw new DrivingRouteError(`${name} is not a valid server URL.`, 503); }
}

const nonnegative = z.number().finite().min(0);
const position = z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]);
const osrmSchema = z.object({ code: z.literal("Ok"), routes: z.array(z.object({
  distance: nonnegative.positive().max(MAX_DISTANCE_M), duration: nonnegative.positive().max(MAX_DURATION_MS / 1000),
  geometry: z.object({ type: z.literal("LineString"), coordinates: z.array(position).min(2).max(MAX_POINTS) }),
  legs: z.array(z.object({
    distance: nonnegative.max(MAX_DISTANCE_M), duration: nonnegative.max(MAX_DURATION_MS / 1000),
    summary: z.string().max(1000).optional(),
    annotation: z.object({ distance: z.array(nonnegative.max(MAX_DISTANCE_M)).min(1).max(MAX_POINTS),
      duration: z.array(nonnegative.max(MAX_DURATION_MS / 1000)).min(1).max(MAX_POINTS) }),
  })).min(1).max(6),
})).min(1).max(10) });

export function createOsrmRoutesProvider(options: { maxCallsPerMinute?: number; monotonicNow?: () => number } = {}) {
  const maximum = options.maxCallsPerMinute ?? 30;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 60) throw new Error("Invalid routing call budget.");
  const now = options.monotonicNow ?? (() => performance.now());
  let calls: number[] = [];
  return {
    async compute(value: DrivingRouteInput): Promise<DrivingRoute[]> {
      const parsed = inputSchema.safeParse(value);
      if (!parsed.success) throw new DrivingRouteError("Invalid route input. Select address coordinates before requesting a route.", 400);
      const input = parsed.data;
      const base = serverBase("OSRM_URL", "https://router.project-osrm.org");
      const at = now();
      if (!Number.isFinite(at)) throw new DrivingRouteError("Routing clock unavailable.", 503);
      calls = calls.filter((stamp) => at - stamp < 60_000);
      if (calls.length >= maximum) throw new DrivingRouteError("Routing request budget reached. Try again in a minute.", 429);
      calls.push(at);
      const coordinates = [input.origin, ...input.waypoints, input.destination].map((point) => `${point.lng},${point.lat}`).join(";");
      let response;
      try {
        // The server must be prepared with OSRM's car profile; the URL alone cannot change its transport mode.
        response = await axios.get(`${base}/route/v1/driving/${coordinates}`, {
          params: { overview: "full", geometries: "geojson", annotations: "duration,distance", steps: true, alternatives: input.computeAlternativeRoutes },
          timeout: 10_000, maxRedirects: 0, maxContentLength: 16 * 1024 * 1024,
          validateStatus: () => true,
        });
      } catch { throw new DrivingRouteError("Routing provider could not be reached. Try again later."); }
      if (response.status !== 200) throw new DrivingRouteError(`Routing provider HTTP ${response.status}. Try again later.`);
      if (response.data?.code === "NoRoute" || response.data?.code === "NoSegment" ||
          Array.isArray(response.data?.routes) && response.data.routes.length === 0) {
        throw new DrivingRouteError("No driving route found for the selected coordinates.", 422);
      }
      const decoded = osrmSchema.safeParse(response.data);
      if (!decoded.success) invalidResponse();
      const fetchedAt = new Date();
      return decoded.data.routes.slice(0, 3).map((raw) => {
        if (raw.legs.length !== input.waypoints.length + 1) invalidResponse();
        const points = raw.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
        const segmentDurationMs: number[] = [];
        const stops: NonNullable<DrivingRoute["stops"]> = [];
        let annotationDistance = 0;
        for (const [index, leg] of raw.legs.entries()) {
          if (leg.annotation.distance.length !== leg.annotation.duration.length) invalidResponse();
          segmentDurationMs.push(...leg.annotation.duration.map((seconds) => seconds * 1000));
          annotationDistance += leg.annotation.distance.reduce((sum, meters) => sum + meters, 0);
          if (index < input.waypoints.length) stops.push({ pointIndex: segmentDurationMs.length, durationMs: input.waypoints[index]!.stopSeconds * 1000 });
        }
        if (Math.abs(annotationDistance - raw.distance) > Math.max(10, raw.distance * 0.02)) invalidResponse();
        return validateDrivingRoute({ provider: "OSRM", points, distanceM: raw.distance,
          durationMs: raw.duration * 1000, staticDurationMs: raw.duration * 1000,
          traffic: [{ startIndex: 0, endIndex: points.length - 1, category: "UNKNOWN" }],
          origin: points[0]!, destination: points.at(-1)!, stops, segmentDurationMs,
          description: raw.legs.map((leg) => leg.summary || "").filter(Boolean).join(" / ").slice(0, 300),
          fetchedAt: fetchedAt.toISOString(), expiresAt: new Date(fetchedAt.getTime() + 300_000).toISOString(),
        });
      });
    },
  };
}
const osrmProvider = createOsrmRoutesProvider();
export function computeDrivingRoutes(input: DrivingRouteInput): Promise<DrivingRoute[]> { return osrmProvider.compute(input); }
export async function computeDrivingRoute(input: DrivingRouteInput): Promise<DrivingRoute> { return (await computeDrivingRoutes(input))[0]!; }

export interface DrivingAddress { id: string; label: string; lat: number; lng: number }
const addressCache = new Map<string, { expires: number; results: DrivingAddress[] }>();
const addressPending = new Map<string, Promise<DrivingAddress[]>>();
let addressQueue = Promise.resolve();
let addressNextAt = 0;
const nominatimSchema = z.array(z.object({
  place_id: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  display_name: z.string().min(1).max(2000),
  lat: z.string().regex(/^-?\d+(?:\.\d+)?$/), lon: z.string().regex(/^-?\d+(?:\.\d+)?$/),
})).max(5);

// Only call this for an explicit user search, never for autocomplete or automated route execution.
export async function searchDrivingAddresses(query: string): Promise<DrivingAddress[]> {
  if (typeof query !== "string" || query.trim().length < 3 || query.trim().length > 200) {
    throw new DrivingRouteError("Invalid address search. Enter between 3 and 200 characters.", 400);
  }
  const normalized = query.trim().replace(/\s+/g, " ");
  const base = serverBase("NOMINATIM_URL", "https://nominatim.openstreetmap.org");
  const key = `${base}|${normalized.toLocaleLowerCase("en-US")}`;
  const cached = addressCache.get(key);
  if (cached && cached.expires > Date.now()) return structuredClone(cached.results);
  const pending = addressPending.get(key);
  if (pending) return structuredClone(await pending);
  if (addressPending.size >= 10) throw new DrivingRouteError("Address search is busy. Try again shortly.", 429);
  const work = addressQueue.then(async () => {
    while (addressNextAt > performance.now()) await delay(Math.ceil(addressNextAt - performance.now()));
    addressNextAt = performance.now() + 1000;
    let response;
    try {
      response = await axios.get(`${base}/search`, {
        params: { q: normalized, format: "jsonv2", limit: 5, addressdetails: 0 },
        headers: { "User-Agent": process.env.NOMINATIM_USER_AGENT?.trim() ||
          "ObservatoryController/1.0 (+https://observatory-controller-production.up.railway.app)", "Accept-Language": "en" },
        timeout: 10_000, maxRedirects: 0, maxContentLength: 512 * 1024, validateStatus: () => true,
      });
    } catch { throw new DrivingRouteError("Address search could not be reached. Try again later."); }
    if (response.status !== 200) throw new DrivingRouteError(`Address search HTTP ${response.status}. Try again later.`);
    const parsed = nominatimSchema.safeParse(response.data);
    if (!parsed.success) throw new DrivingRouteError("Address search returned invalid results.");
    const results = parsed.data.map((row) => {
      const point = coordinate.safeParse({ lat: Number(row.lat), lng: Number(row.lon) });
      if (!point.success) throw new DrivingRouteError("Address search returned invalid coordinates.");
      return { id: String(row.place_id), label: row.display_name, ...point.data };
    });
    if (addressCache.size >= 200) addressCache.delete(addressCache.keys().next().value!);
    addressCache.set(key, { expires: Date.now() + 86_400_000, results });
    return results;
  });
  addressQueue = work.then(() => undefined, () => undefined);
  addressPending.set(key, work);
  try { return structuredClone(await work); } finally { addressPending.delete(key); }
}
