import { z } from "zod";
import { haversineMeters } from "../geo/haversine.js";
import { interpolateAlong, segmentLengths } from "../geo/polyline.js";
import { positionSchema, type Position, type RadioRecord } from "../radio/schema.js";
import { SpatialIndex } from "../radio/spatial.js";
import { DEFAULT_RADII_M, audibleFloorDbm, medianPowerDbm, usability } from "./usability.js";

/** Fading in the engine reaches ±6 dB, so anything inside that band of the floor comes and goes. */
export const MARGIN_DB = 6;
export const MAX_SAMPLES = 600;

export const radiiSchema = z.object({
  wifiM: z.number().finite().min(1).max(1000).default(DEFAULT_RADII_M.wifiM),
  cellM: z.number().finite().min(100).max(50000).default(DEFAULT_RADII_M.cellM),
  bluetoothM: z.number().finite().min(1).max(1000).default(DEFAULT_RADII_M.bluetoothM),
}).strict();
export type Radii = z.infer<typeof radiiSchema>;

export const corridorRequestSchema = z.object({
  route: z.array(positionSchema).min(2).max(5000),
  sampleSpacingM: z.number().finite().min(10).max(5000).default(250),
  radii: radiiSchema.default({}),
  arrivals: z.array(z.object({
    label: z.string().trim().min(1).max(100),
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  }).strict()).max(20).default([]),
}).strict();
export type CorridorRequest = z.infer<typeof corridorRequestSchema>;

export type KindCoverage = {
  inRadius: number;
  usable: number;
  audible: number;
  marginal: number;
  strongestDbm: number | null;
};

export type CellCoverage = KindCoverage & {
  matchingPlmn: number;
  eligible: number;
  sectorUnknown: number;
};

export type PositionCoverage = {
  wifi: KindCoverage;
  cell: CellCoverage;
  bluetooth: KindCoverage;
  observationAge: { medianDays: number | null; unknownDates: number };
};

export type SampleCoverage = PositionCoverage & {
  index: number;
  distanceAlongM: number;
  position: Position;
  distanceFromAreaCenterM: number | null;
  insideArea: boolean | null;
};

export type CoverageGap = {
  kind: "WIFI" | "CELL" | "BLUETOOTH";
  fromM: number;
  toM: number;
  samples: number;
};

export type ArrivalCoverage = PositionCoverage & {
  label: string;
  position: Position;
  distanceFromAreaCenterM: number | null;
  insideArea: boolean | null;
};

export type CorridorReport = {
  route: {
    points: number;
    lengthM: number;
    sampleSpacingM: number;
    samples: number;
    spacingAdjusted: boolean;
  };
  radii: Radii;
  area: { center: Position; radiusM: number } | null;
  samples: SampleCoverage[];
  edges: { start: SampleCoverage; end: SampleCoverage };
  arrivals: ArrivalCoverage[];
  gaps: CoverageGap[];
  outsideArea: { samples: number; firstAtM: number | null };
  worst: {
    wifiAudible: number;
    eligibleCells: number;
    samplesWithoutEligibleCell: number;
    samplesWithoutWifi: number;
  };
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function emptyKind(): KindCoverage {
  return { inRadius: 0, usable: 0, audible: 0, marginal: 0, strongestDbm: null };
}

/**
 * How much saved data the model could actually use at one position: rows in radius, rows with the
 * fields the engine requires, and rows whose modeled power clears the engine's emission floor.
 * These are properties of the dataset, never a claim about present-day radio conditions.
 */
export function coverageAtPosition(input: {
  index: SpatialIndex<RadioRecord>;
  position: Position;
  radii: Radii;
  plmn?: { mcc: string; mnc: string } | null;
  now?: number;
}): PositionCoverage {
  const { wifiM, cellM, bluetoothM } = input.radii;
  const plmn = input.plmn ?? null;
  const now = input.now ?? Date.now();
  const wifi = emptyKind();
  const bluetooth = emptyKind();
  const cell: CellCoverage = { ...emptyKind(), matchingPlmn: 0, eligible: 0, sectorUnknown: 0 };
  const ages: number[] = [];
  let unknownDates = 0;
  for (const { record, distanceM } of input.index.within(input.position, Math.max(wifiM, cellM, bluetoothM))) {
    const radius = record.kind === "WIFI" ? wifiM : record.kind === "CELL" ? cellM : bluetoothM;
    if (distanceM > radius) continue;
    const bucket = record.kind === "WIFI" ? wifi : record.kind === "CELL" ? cell : bluetooth;
    bucket.inRadius++;
    const result = usability(record);
    const matchesPlmn = record.kind === "CELL" && record.cell && plmn
      && record.cell.mcc === plmn.mcc && record.cell.mnc === plmn.mnc;
    if (matchesPlmn) {
      cell.matchingPlmn++;
      if (result.unknown.includes("SECTOR_UNKNOWN")) cell.sectorUnknown++;
    }
    if (!result.usable) continue;
    bucket.usable++;
    const power = medianPowerDbm(record, input.position, distanceM);
    if (power === null) continue;
    const floor = audibleFloorDbm(record);
    if (power < floor) continue;
    bucket.audible++;
    if (power < floor + MARGIN_DB) bucket.marginal++;
    bucket.strongestDbm = bucket.strongestDbm === null ? power : Math.max(bucket.strongestDbm, power);
    if (matchesPlmn) cell.eligible++;
    const at = Date.parse(record.lastSeen ?? record.lastUpdated ?? "");
    if (Number.isFinite(at)) ages.push((now - at) / 86_400_000);
    else unknownDates++;
  }
  for (const bucket of [wifi, bluetooth, cell]) {
    if (bucket.strongestDbm !== null) bucket.strongestDbm = Math.round(bucket.strongestDbm);
  }
  const medianDays = median(ages);
  return { wifi, cell, bluetooth, observationAge: { medianDays: medianDays === null ? null : Math.round(medianDays), unknownDates } };
}

/** Builds a spatial index for a record set and reports its modeled coverage at one position. */
export function coverageForRecords(input: {
  records: readonly RadioRecord[];
  position: Position;
  radii: Radii;
  plmn?: { mcc: string; mnc: string } | null;
  now?: number;
}): PositionCoverage {
  return coverageAtPosition({ ...input, index: new SpatialIndex<RadioRecord>(input.records as RadioRecord[]) });
}

/** Even sampling along the route, including both ends, with a hard cap on sample count. */
export function routeSamples(route: readonly Position[], sampleSpacingM: number): {
  samples: Array<{ distanceAlongM: number; position: Position }>;
  lengthM: number;
  spacingM: number;
  spacingAdjusted: boolean;
} {
  const points = route.map((point) => ({ lat: point.lat, lng: point.lng }));
  const lengthM = segmentLengths(points).reduce((total, length) => total + length, 0);
  let spacingM = sampleSpacingM;
  let spacingAdjusted = false;
  if (lengthM / spacingM + 1 > MAX_SAMPLES) {
    spacingM = Math.ceil(lengthM / (MAX_SAMPLES - 1));
    spacingAdjusted = true;
  }
  const distances: number[] = [];
  for (let along = 0; along < lengthM; along += spacingM) distances.push(along);
  distances.push(lengthM);
  const samples = distances.map((distanceAlongM) => {
    const interpolated = interpolateAlong(points, distanceAlongM);
    const point = interpolated?.point ?? points[points.length - 1]!;
    return { distanceAlongM: Math.round(distanceAlongM), position: positionSchema.parse({ lat: point.lat, lng: point.lng }) };
  });
  return { samples, lengthM, spacingM, spacingAdjusted };
}

/** Groups consecutive route samples without usable interface coverage into per-interface gaps. */
export function gapsFromSamples(samples: readonly SampleCoverage[]): CoverageGap[] {
  const build = (kind: CoverageGap["kind"], audible: (sample: SampleCoverage) => number): CoverageGap[] => {
    const gaps: CoverageGap[] = [];
    let open: { fromM: number; toM: number; samples: number } | null = null;
    for (const sample of samples) {
      if (audible(sample) === 0) {
        open = open
          ? { fromM: open.fromM, toM: sample.distanceAlongM, samples: open.samples + 1 }
          : { fromM: sample.distanceAlongM, toM: sample.distanceAlongM, samples: 1 };
      } else if (open) {
        gaps.push({ kind, ...open });
        open = null;
      }
    }
    if (open) gaps.push({ kind, ...open });
    return gaps;
  };
  return [
    ...build("WIFI", (sample) => sample.wifi.audible),
    ...build("CELL", (sample) => sample.cell.eligible),
    ...build("BLUETOOTH", (sample) => sample.bluetooth.audible),
  ];
}

/** Returns the route's minimum Wi-Fi and cell coverage and the number of uncovered samples. */
export function summarizeSamples(samples: readonly SampleCoverage[]): CorridorReport["worst"] {
  return {
    wifiAudible: Math.min(...samples.map((sample) => sample.wifi.audible)),
    eligibleCells: Math.min(...samples.map((sample) => sample.cell.eligible)),
    samplesWithoutEligibleCell: samples.filter((sample) => sample.cell.eligible === 0).length,
    samplesWithoutWifi: samples.filter((sample) => sample.wifi.audible === 0).length,
  };
}

/** Reports distance and containment for an area, or null fields when no area is supplied. */
export function areaRelation(position: Position, area?: { center: Position; radiusM: number } | null): {
  distanceFromAreaCenterM: number | null;
  insideArea: boolean | null;
} {
  if (!area) return { distanceFromAreaCenterM: null, insideArea: null };
  const distanceFromAreaCenterM = Math.round(haversineMeters(area.center.lat, area.center.lng, position.lat, position.lng));
  return { distanceFromAreaCenterM, insideArea: distanceFromAreaCenterM <= area.radiusM };
}

/**
 * Corridor coverage for a record set already held in memory. Bounded service-area datasets use the
 * tiled loader instead, one window per sample; this path stays for small saved city datasets and tests.
 */
export function corridorCoverage(input: {
  records: readonly RadioRecord[];
  request: CorridorRequest;
  plmn?: { mcc: string; mnc: string } | null;
  area?: { center: Position; radiusM: number } | null;
  now?: number;
}): CorridorReport {
  const { request } = input;
  const now = input.now ?? Date.now();
  const area = input.area ?? null;
  const index = new SpatialIndex<RadioRecord>(input.records as RadioRecord[]);
  const walk = routeSamples(request.route, request.sampleSpacingM);
  const samples: SampleCoverage[] = walk.samples.map((sample, sampleIndex) => ({
    index: sampleIndex,
    distanceAlongM: sample.distanceAlongM,
    position: sample.position,
    ...areaRelation(sample.position, area),
    ...coverageAtPosition({ index, position: sample.position, radii: request.radii, plmn: input.plmn, now }),
  }));
  const arrivals: ArrivalCoverage[] = request.arrivals.map((arrival) => {
    const position = positionSchema.parse({ lat: arrival.lat, lng: arrival.lng });
    return {
      label: arrival.label,
      position,
      ...areaRelation(position, area),
      ...coverageAtPosition({ index, position, radii: request.radii, plmn: input.plmn, now }),
    };
  });
  const outside = samples.filter((sample) => sample.insideArea === false);
  return {
    route: { points: request.route.length, lengthM: Math.round(walk.lengthM), sampleSpacingM: walk.spacingM, samples: samples.length, spacingAdjusted: walk.spacingAdjusted },
    radii: request.radii,
    area,
    samples,
    edges: { start: samples[0]!, end: samples[samples.length - 1]! },
    arrivals,
    gaps: gapsFromSamples(samples),
    outsideArea: { samples: outside.length, firstAtM: outside[0]?.distanceAlongM ?? null },
    worst: summarizeSamples(samples),
  };
}
