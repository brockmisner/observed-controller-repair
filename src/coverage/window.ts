import { z } from "zod";
import { haversineMeters } from "../geo/haversine.js";
import { positionSchema, recordKey, type Position, type RadioRecord } from "../radio/schema.js";
import { TileCache, tileCache as sharedTileCache } from "./datasetCache.js";
import { KINDS, type Kind } from "./inventory.js";
import { tilesWithin, zoomForKind, type TileRef } from "./tiles.js";
import { DEFAULT_RADII_M, ENGINE_OBSERVATION_LIMIT, usability } from "./usability.js";

/** Fastest supported driving speed in the movement model; used to convert a load margin into time. */
export const MAX_SPEED_MPS = 15;
/** Below this margin a phone would have to reload inside a single one-second sample. */
export const MIN_TRAVEL_MARGIN_M = 30;

export const windowRequestSchema = z.object({
  position: positionSchema,
  radii: z.object({
    wifiM: z.number().finite().min(1).max(1000).default(DEFAULT_RADII_M.wifiM),
    cellM: z.number().finite().min(100).max(50000).default(DEFAULT_RADII_M.cellM),
    bluetoothM: z.number().finite().min(1).max(1000).default(DEFAULT_RADII_M.bluetoothM),
  }).strict().default({}),
  /** Extra radius so the phone can keep moving before the next window load. */
  travelMarginM: z.number().finite().min(MIN_TRAVEL_MARGIN_M).max(20000).default(450),
  budget: z.number().int().min(100).max(ENGINE_OBSERVATION_LIMIT).default(ENGINE_OBSERVATION_LIMIT),
}).strict();
export type WindowRequest = z.infer<typeof windowRequestSchema>;

export interface TileReader {
  /** Reads stored tiles for one revision and kind. Missing tiles are simply absent from the result. */
  read(revisionId: string, kind: Kind, tileKeys: string[]): Promise<Array<{ tileKey: string; records: RadioRecord[] }>>;
}

export type WindowPlan = {
  status: "OK" | "MARGIN_REDUCED" | "DENSITY_EXCEEDS_WINDOW";
  budget: number;
  engineRadiiM: WindowRequest["radii"];
  requestedMarginM: number;
  travelMarginM: number;
  servedRadiusM: { wifiM: number; cellM: number; bluetoothM: number };
  reloadAfterM: number;
  reloadAfterSeconds: number;
  records: number;
  attempts: Array<{ marginM: number; records: number; fits: boolean }>;
};

export type WindowLoad = {
  revisionId: string;
  datasetRevision: string;
  position: Position;
  plan: WindowPlan;
  records: RadioRecord[];
  counts: Record<Kind, { records: number; usable: number }>;
  tiles: { requested: number; read: number; byKind: Record<Kind, number>; cacheHits: number; cacheMisses: number };
  /** Records inside the served radii that had to be left out to respect the engine's limit. */
  dropped: number;
  duplicatesRemoved: number;
  warnings: string[];
};

type Neighbour = { record: RadioRecord; distanceM: number; kind: Kind };

function marginCandidates(requested: number): number[] {
  const scaled = [1, 0.75, 0.5, 0.35, 0.2, 0.1].map((factor) => Math.round(requested * factor));
  const candidates = [...scaled, MIN_TRAVEL_MARGIN_M]
    .filter((margin) => margin >= MIN_TRAVEL_MARGIN_M && margin <= requested);
  return [...new Set(candidates)].sort((a, b) => b - a);
}

function radiiFor(request: WindowRequest, marginM: number) {
  return {
    wifiM: request.radii.wifiM + marginM,
    cellM: request.radii.cellM + marginM,
    bluetoothM: request.radii.bluetoothM + marginM,
  };
}

function radiusFor(kind: Kind, radii: { wifiM: number; cellM: number; bluetoothM: number }): number {
  return kind === "WIFI" ? radii.wifiM : kind === "CELL" ? radii.cellM : radii.bluetoothM;
}

/**
 * Chooses the widest load margin whose record count fits the engine's per-session limit.
 * Reducing the margin shortens how far the phone may travel before the next load; it never shrinks the
 * radius below the engine's own reception radii, so no observation the model would use is discarded.
 */
export function planWindow(neighbours: readonly Neighbour[], request: WindowRequest): WindowPlan {
  const attempts: WindowPlan["attempts"] = [];
  let chosen: { marginM: number; records: number } | null = null;
  for (const marginM of marginCandidates(request.travelMarginM)) {
    const radii = radiiFor(request, marginM);
    const records = neighbours.filter((entry) => entry.distanceM <= radiusFor(entry.kind, radii)).length;
    const fits = records <= request.budget;
    attempts.push({ marginM, records, fits });
    if (fits) {
      chosen = { marginM, records };
      break;
    }
  }
  const marginM = chosen?.marginM ?? MIN_TRAVEL_MARGIN_M;
  const radii = radiiFor(request, marginM);
  const records = chosen?.records ?? attempts[attempts.length - 1]?.records ?? 0;
  return {
    status: !chosen ? "DENSITY_EXCEEDS_WINDOW" : marginM === request.travelMarginM ? "OK" : "MARGIN_REDUCED",
    budget: request.budget,
    engineRadiiM: request.radii,
    requestedMarginM: request.travelMarginM,
    travelMarginM: marginM,
    servedRadiusM: radii,
    reloadAfterM: marginM,
    reloadAfterSeconds: Math.round((marginM / MAX_SPEED_MPS) * 10) / 10,
    records,
    attempts,
  };
}

/**
 * Loads exactly the tiles a phone can hear from its current position and returns a bounded record set
 * for one engine session. Tiles come from stored dataset revisions and a shared in-process cache; no
 * external query happens here, so this is safe to call on a movement tick.
 */
export async function loadWindow(options: {
  reader: TileReader;
  revisionId: string;
  datasetRevision: string;
  tileZoom: number;
  request: WindowRequest;
  cache?: TileCache;
  area?: { center: Position; radiusM: number } | null;
}): Promise<WindowLoad> {
  const request = windowRequestSchema.parse(options.request);
  const cache = options.cache ?? sharedTileCache;
  const warnings: string[] = [];
  const outerRadii = radiiFor(request, request.travelMarginM);
  const byKind: Record<Kind, number> = { WIFI: 0, CELL: 0, BLUETOOTH: 0 };
  const neighbours: Neighbour[] = [];
  let requested = 0;
  let read = 0;
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const kind of KINDS) {
    const radius = radiusFor(kind, outerRadii);
    const refs: TileRef[] = tilesWithin(request.position, radius, zoomForKind(kind, options.tileZoom));
    requested += refs.length;
    const missing: string[] = [];
    const found = new Map<string, readonly RadioRecord[]>();
    for (const ref of refs) {
      const cached = cache.get(options.revisionId, kind, ref.key);
      if (cached) {
        cacheHits++;
        found.set(ref.key, cached);
      } else {
        cacheMisses++;
        missing.push(ref.key);
      }
    }
    if (missing.length) {
      const returned = new Set<string>();
      for (const tile of await options.reader.read(options.revisionId, kind, missing)) {
        returned.add(tile.tileKey);
        found.set(tile.tileKey, cache.set(options.revisionId, kind, tile.tileKey, tile.records));
      }
      // A complete revision is immutable, so "this tile holds nothing" is cacheable too. Without it,
      // every movement tick would re-query the empty tiles that a 3 km cell radius always spans.
      for (const tileKey of missing) {
        if (!returned.has(tileKey)) cache.set(options.revisionId, kind, tileKey, []);
      }
    }
    for (const [tileKey, records] of found) {
      if (!records.length) continue;
      read++;
      byKind[kind] += records.length;
      void tileKey;
      for (const record of records) {
        const distanceM = haversineMeters(request.position.lat, request.position.lng, record.lat, record.lng);
        if (distanceM <= radius) neighbours.push({ record, distanceM, kind });
      }
    }
  }

  const plan = planWindow(neighbours, request);
  const served = plan.servedRadiusM;
  const seen = new Set<string>();
  const records: RadioRecord[] = [];
  let duplicatesRemoved = 0;
  let dropped = 0;
  const inWindow = neighbours
    .filter((entry) => entry.distanceM <= radiusFor(entry.kind, served))
    .sort((a, b) => a.distanceM - b.distanceM);
  for (const entry of inWindow) {
    const key = recordKey(entry.record);
    if (seen.has(key)) {
      duplicatesRemoved++;
      continue;
    }
    if (records.length >= request.budget) {
      dropped++;
      continue;
    }
    seen.add(key);
    records.push(entry.record);
  }

  const counts = Object.fromEntries(KINDS.map((kind) => {
    const kindRecords = records.filter((record) => record.kind === kind);
    return [kind, { records: kindRecords.length, usable: kindRecords.filter((record) => usability(record).usable).length }];
  })) as WindowLoad["counts"];

  if (plan.status === "MARGIN_REDUCED") {
    warnings.push(`Observation density required reducing the load margin from ${plan.requestedMarginM} m to ${plan.travelMarginM} m; `
      + `reload this window after ${plan.reloadAfterM} m (about ${plan.reloadAfterSeconds} s at ${MAX_SPEED_MPS} m/s).`);
  }
  if (plan.status === "DENSITY_EXCEEDS_WINDOW") {
    warnings.push(`This location holds more than ${request.budget} observations within the model's own reception radii at the `
      + `smallest supported ${MIN_TRAVEL_MARGIN_M} m load margin. Coverage here cannot be served without raising the engine's `
      + "per-session limit or narrowing the modeled radii; nothing was silently discarded.");
  }
  if (dropped) warnings.push(`${dropped} in-window observation(s) exceeded the ${request.budget}-record session limit and are reported, not hidden.`);
  if (duplicatesRemoved) warnings.push(`${duplicatesRemoved} duplicate identity/identities were removed; the engine rejects duplicate identities outright.`);
  if (options.area) {
    const distanceM = haversineMeters(options.area.center.lat, options.area.center.lng, request.position.lat, request.position.lng);
    if (distanceM > options.area.radiusM) {
      warnings.push(`Position is ${Math.round(distanceM - options.area.radiusM)} m beyond the imported service area; coverage past the area edge was never imported.`);
    } else if (distanceM + served.wifiM > options.area.radiusM) {
      warnings.push("Window reaches the service-area edge, where Wi-Fi coverage is cut off by the import boundary rather than by real conditions.");
    }
  }

  return {
    revisionId: options.revisionId,
    datasetRevision: options.datasetRevision,
    position: request.position,
    plan,
    records,
    counts,
    tiles: { requested, read, byKind, cacheHits, cacheMisses },
    dropped,
    duplicatesRemoved,
    warnings,
  };
}
