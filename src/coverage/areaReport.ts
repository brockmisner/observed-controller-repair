import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { haversineMeters } from "../geo/haversine.js";
import { HttpError } from "../http/errors.js";
import { positionSchema, type Position } from "../radio/schema.js";
import { readVerificationRecord, VERIFICATION_EVENT } from "../ops/verificationHistory.js";
import { resolvePin, prismaTileReader, tileMetadata, type AreaPin, type TileMetadata } from "./areaStore.js";
import { carrierIdentity, eligibleCells, type CarrierIdentity, type EligibleCellSummary } from "./carrier.js";
import { areaRelation, coverageForRecords, gapsFromSamples, radiiSchema, routeSamples, summarizeSamples, type CoverageGap, type SampleCoverage } from "./corridor.js";
import { confidenceBreakdown, isRotatingBleIdentity, observationConfidence, type Observation } from "./observation.js";
import { tileAreaKm2, tileBounds, tilesWithin, zoomForKind } from "./tiles.js";
import { ENGINE_OBSERVATION_LIMIT } from "./usability.js";
import { loadWindow, MAX_SPEED_MPS, MIN_TRAVEL_MARGIN_M, windowRequestSchema, type WindowLoad } from "./window.js";

export const phoneRequestSchema = z.object({
  deviceId: z.string().min(1).max(200),
  position: positionSchema.optional(),
  route: z.array(positionSchema).min(2).max(5000).optional(),
  arrivals: z.array(z.object({
    label: z.string().trim().min(1).max(100),
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
  }).strict()).max(10).default([]),
}).strict();

export const areaReportRequestSchema = z.object({
  dataset: z.string().min(1).max(200),
  revision: z.number().int().min(1).optional(),
  phones: z.array(phoneRequestSchema).max(20).default([]),
  radii: radiiSchema.default({}),
  sampleSpacingM: z.number().finite().min(25).max(2000).default(250),
  travelMarginM: z.number().finite().min(MIN_TRAVEL_MARGIN_M).max(20000).default(450),
  budget: z.number().int().min(100).max(ENGINE_OBSERVATION_LIMIT).default(ENGINE_OBSERVATION_LIMIT),
}).strict();
export type AreaReportRequest = z.infer<typeof areaReportRequestSchema>;

export type AreaTileSummary = {
  footprintTiles: number;
  storedTiles: Record<"WIFI" | "CELL" | "BLUETOOTH", number>;
  tilesWithoutWifi: number;
  tilesWithoutUsableWifi: number;
  tilesWithoutCell: number;
  densestWifiTile: { tileKey: string; records: number; perKm2: number } | null;
  medianWifiTileRecords: number;
  estimatedWindowRecordsAtDensestTile: number | null;
  windowFitsBudget: boolean | null;
  plmn: Array<{ plmn: string; records: number }>;
  holes: Array<{ tileKey: string; center: Position; reason: string }>;
};

export type PhoneReadiness = {
  deviceId: string;
  imageId: string;
  name: string | null;
  position: Position;
  positionSource: "REQUEST" | "DEVICE_CURRENT" | "DEVICE_ANCHOR";
  insideArea: boolean;
  distanceFromAreaCenterM: number;
  carrier: CarrierIdentity;
  eligibleCellsInArea: EligibleCellSummary;
  window: Omit<WindowLoad, "records">;
  coverageHere: ReturnType<typeof coverageForRecords>;
  confidence: ReturnType<typeof confidenceBreakdown>;
  bluetooth: { audibleHere: number; rotatingBleIdentities: number; note: string };
  route: {
    lengthM: number;
    samples: number;
    spacingM: number;
    worst: ReturnType<typeof summarizeSamples>;
    gaps: CoverageGap[];
    windowStatuses: Record<string, number>;
    reloadAfterMinM: number;
  } | null;
  arrivals: Array<{ label: string; position: Position; insideArea: boolean | null; wifiAudible: number; bluetoothAudible: number; eligibleCells: number }>;
  blocking: string[];
  warnings: string[];
};

export type AreaCoverageReport = {
  pin: AreaPin;
  tiles: AreaTileSummary;
  phones: PhoneReadiness[];
  verdict: {
    overall: "SUPPORTED" | "SUPPORTED_WITH_LIMITS" | "NOT_SUPPORTED";
    byInterface: {
      wifi: "SUPPORTED" | "PARTIAL" | "NOT_SUPPORTED";
      cellular: "SUPPORTED" | "PARTIAL" | "NOT_SUPPORTED";
      bluetoothArrival: "HISTORICAL_ONLY" | "NOT_SUPPORTED";
    };
    blocking: string[];
    warnings: string[];
  };
};

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** Area-wide coverage from tile statistics only: bounded reads, no record payloads. */
export function summarizeTiles(pin: AreaPin, tiles: readonly TileMetadata[], radii: { wifiM: number }, travelMarginM: number, budget: number): AreaTileSummary {
  const footprint = tilesWithin(pin.area.center, pin.area.radiusM, zoomForKind("WIFI", pin.tileZoom));
  const cellFootprint = tilesWithin(pin.area.center, pin.area.radiusM, zoomForKind("CELL", pin.tileZoom));
  const byKind = { WIFI: 0, CELL: 0, BLUETOOTH: 0 } as Record<"WIFI" | "CELL" | "BLUETOOTH", number>;
  const wifiByKey = new Map<string, TileMetadata>();
  const cellKeys = new Set<string>();
  const plmn = new Map<string, number>();
  for (const tile of tiles) {
    byKind[tile.kind]++;
    if (tile.kind === "WIFI") wifiByKey.set(tile.tileKey, tile);
    if (tile.kind === "CELL") {
      cellKeys.add(tile.tileKey);
      for (const [key, count] of Object.entries(tile.plmn)) plmn.set(key, (plmn.get(key) ?? 0) + count);
    }
  }
  const holes: AreaTileSummary["holes"] = [];
  let tilesWithoutWifi = 0;
  let tilesWithoutUsableWifi = 0;
  let tilesWithoutCell = 0;
  for (const ref of footprint) {
    const wifi = wifiByKey.get(ref.key);
    const bounds = tileBounds(ref.zoom, ref.x, ref.y);
    const center = { lat: (bounds.minLat + bounds.maxLat) / 2, lng: (bounds.minLng + bounds.maxLng) / 2 };
    if (!wifi) {
      tilesWithoutWifi++;
      if (holes.length < 100) holes.push({ tileKey: ref.key, center, reason: "No Wi-Fi observation stored for this tile" });
    } else if (wifi.usableCount === 0) {
      tilesWithoutUsableWifi++;
      if (holes.length < 100) holes.push({ tileKey: ref.key, center, reason: "Wi-Fi rows exist but none carry the fields the model requires" });
    }
  }
  for (const ref of cellFootprint) {
    if (!cellKeys.has(ref.key)) tilesWithoutCell++;
  }
  const wifiTiles = [...wifiByKey.values()];
  const densest = wifiTiles.reduce<TileMetadata | null>((best, tile) => !best || tile.recordCount > best.recordCount ? tile : best, null);
  const windowRadiusM = radii.wifiM + travelMarginM;
  const windowAreaKm2 = (Math.PI * windowRadiusM ** 2) / 1_000_000;
  const densestPerKm2 = densest ? densest.recordCount / Math.max(0.001, tileAreaKm2(zoomForKind("WIFI", pin.tileZoom), densest.tileY)) : null;
  const estimatedWindowRecords = densestPerKm2 === null ? null : Math.round(densestPerKm2 * windowAreaKm2);
  return {
    footprintTiles: footprint.length,
    storedTiles: byKind,
    tilesWithoutWifi,
    tilesWithoutUsableWifi,
    tilesWithoutCell,
    densestWifiTile: densest ? { tileKey: densest.tileKey, records: densest.recordCount, perKm2: Math.round(densestPerKm2!) } : null,
    medianWifiTileRecords: median(wifiTiles.map((tile) => tile.recordCount)),
    estimatedWindowRecordsAtDensestTile: estimatedWindowRecords,
    windowFitsBudget: estimatedWindowRecords === null ? null : estimatedWindowRecords <= budget,
    plmn: [...plmn.entries()].map(([key, records]) => ({ plmn: key, records })).sort((a, b) => b.records - a.records),
    holes,
  };
}

async function latestVerification(prisma: PrismaClient, device: { id: string; tenantId: string; imageId: string }) {
  const event = await prisma.deviceEvent.findFirst({
    where: { deviceId: device.id, kind: VERIFICATION_EVENT },
    orderBy: { createdAt: "desc" },
    select: { detail: true },
  });
  const record = readVerificationRecord(event?.detail, device);
  return record ? { checkedAt: record.checkedAt, cell: record.radios.cell, wifi: record.radios.wifi, bluetooth: record.radios.bluetooth } : null;
}

/**
 * Pre-execution readiness for one phone in a service area: what its own bounded window would hold, which
 * carrier the model would filter on and where that identity comes from, and where coverage runs out
 * along its route. Nothing here observes the phone; it reports what the saved dataset can support.
 */
export async function phoneReadiness(prisma: PrismaClient, tenantId: string, pin: AreaPin, request: z.infer<typeof phoneRequestSchema>, options: {
  radii: { wifiM: number; cellM: number; bluetoothM: number };
  travelMarginM: number;
  budget: number;
  sampleSpacingM: number;
  now?: number;
}): Promise<PhoneReadiness> {
  const now = options.now ?? Date.now();
  const device = await prisma.device.findFirst({ where: { id: request.deviceId, tenantId } });
  if (!device) throw new HttpError(404, `Phone ${request.deviceId} not found in this workspace`);
  const positionSource = request.position ? "REQUEST" : device.currentLat && device.currentLng ? "DEVICE_CURRENT" : "DEVICE_ANCHOR";
  const position = request.position
    ?? (positionSource === "DEVICE_CURRENT" ? { lat: device.currentLat, lng: device.currentLng } : { lat: device.anchorLat, lng: device.anchorLng });
  const reader = prismaTileReader(prisma);
  const identity = carrierIdentity(device, await latestVerification(prisma, device));
  const blocking: string[] = [];
  const warnings: string[] = [];

  const windowRequest = windowRequestSchema.parse({
    position, radii: options.radii, travelMarginM: options.travelMarginM, budget: options.budget,
  });
  const load = await loadWindow({
    reader, revisionId: pin.revisionId, datasetRevision: pin.datasetRevision, tileZoom: pin.tileZoom,
    request: windowRequest, area: pin.area,
  });
  const { records, ...windowSummary } = load;
  const coverageHere = coverageForRecords({ records, position, radii: options.radii, plmn: identity, now });
  const cellSummary = eligibleCells(records, identity);
  const relation = areaRelation(position, pin.area);
  const observations = records as Observation[];
  const rotatingBle = observations.filter((record) => isRotatingBleIdentity(record)).length;

  if (!relation.insideArea) blocking.push(`Phone position is outside the imported service area (${relation.distanceFromAreaCenterM} m from centre, radius ${pin.area.radiusM} m).`);
  if (coverageHere.wifi.audible === 0) blocking.push("No usable Wi-Fi observation is in range at this position.");
  if (coverageHere.cell.eligible === 0) {
    blocking.push(`No eligible serving cell for MCC ${identity.mcc} / MNC ${identity.mnc} at this position; a serving cell will not be fabricated.`);
  }
  if (identity.observedConfirmation === "NOT_OBSERVED") {
    warnings.push("Carrier identity is configuration only; no observed radio readback confirms this phone's active carrier.");
  }
  if (load.plan.status === "DENSITY_EXCEEDS_WINDOW") blocking.push(...load.warnings.slice(0, 1));
  else warnings.push(...load.warnings);
  if (coverageHere.wifi.marginal === coverageHere.wifi.audible && coverageHere.wifi.audible > 0) {
    warnings.push("Every in-range Wi-Fi observation here is within the modeled fading margin of the emission floor, so the visible set will fluctuate.");
  }

  let route: PhoneReadiness["route"] = null;
  if (request.route) {
    const walk = routeSamples(request.route, options.sampleSpacingM);
    const samples: SampleCoverage[] = [];
    const windowStatuses: Record<string, number> = {};
    let reloadAfterMinM = Number.POSITIVE_INFINITY;
    for (const [index, sample] of walk.samples.entries()) {
      const sampleLoad = await loadWindow({
        reader, revisionId: pin.revisionId, datasetRevision: pin.datasetRevision, tileZoom: pin.tileZoom,
        request: windowRequestSchema.parse({ position: sample.position, radii: options.radii, travelMarginM: options.travelMarginM, budget: options.budget }),
        area: pin.area,
      });
      windowStatuses[sampleLoad.plan.status] = (windowStatuses[sampleLoad.plan.status] ?? 0) + 1;
      reloadAfterMinM = Math.min(reloadAfterMinM, sampleLoad.plan.reloadAfterM);
      samples.push({
        index,
        distanceAlongM: sample.distanceAlongM,
        position: sample.position,
        ...areaRelation(sample.position, pin.area),
        ...coverageForRecords({ records: sampleLoad.records, position: sample.position, radii: options.radii, plmn: identity, now }),
      });
    }
    const gaps = gapsFromSamples(samples);
    route = {
      lengthM: Math.round(walk.lengthM), samples: samples.length, spacingM: walk.spacingM,
      worst: summarizeSamples(samples), gaps, windowStatuses,
      reloadAfterMinM: Number.isFinite(reloadAfterMinM) ? reloadAfterMinM : 0,
    };
    const wifiGap = gaps.find((gap) => gap.kind === "WIFI");
    if (wifiGap) blocking.push(`Route has no usable Wi-Fi coverage between ${wifiGap.fromM} m and ${wifiGap.toM} m.`);
    const cellGap = gaps.find((gap) => gap.kind === "CELL");
    if (cellGap) blocking.push(`Route has no eligible serving cell between ${cellGap.fromM} m and ${cellGap.toM} m.`);
    if (samples.some((sample) => sample.insideArea === false)) {
      blocking.push("Route leaves the imported service area; coverage past the area edge was never imported.");
    }
    if (route.reloadAfterMinM < options.travelMarginM) {
      warnings.push(`Density on this route forces a window reload every ${route.reloadAfterMinM} m (about ${Math.round(route.reloadAfterMinM / MAX_SPEED_MPS)} s at ${MAX_SPEED_MPS} m/s).`);
    }
  }

  const arrivals: PhoneReadiness["arrivals"] = [];
  for (const arrival of request.arrivals) {
    const arrivalPosition = positionSchema.parse({ lat: arrival.lat, lng: arrival.lng });
    const arrivalLoad = await loadWindow({
      reader, revisionId: pin.revisionId, datasetRevision: pin.datasetRevision, tileZoom: pin.tileZoom,
      request: windowRequestSchema.parse({ position: arrivalPosition, radii: options.radii, travelMarginM: options.travelMarginM, budget: options.budget }),
      area: pin.area,
    });
    const arrivalCoverage = coverageForRecords({ records: arrivalLoad.records, position: arrivalPosition, radii: options.radii, plmn: identity, now });
    arrivals.push({
      label: arrival.label,
      position: arrivalPosition,
      ...areaRelation(arrivalPosition, pin.area),
      wifiAudible: arrivalCoverage.wifi.audible,
      bluetoothAudible: arrivalCoverage.bluetooth.audible,
      eligibleCells: arrivalCoverage.cell.eligible,
    });
    if (arrivalCoverage.bluetooth.audible === 0) {
      warnings.push(`Arrival "${arrival.label}" has no Bluetooth observation in range; an arrival replacement there would carry an empty list, which is not the same as unavailable data.`);
    }
  }

  return {
    deviceId: device.id,
    imageId: device.imageId,
    name: device.name,
    position,
    positionSource,
    insideArea: relation.insideArea === true,
    distanceFromAreaCenterM: relation.distanceFromAreaCenterM ?? 0,
    carrier: identity,
    eligibleCellsInArea: cellSummary,
    window: windowSummary,
    coverageHere,
    confidence: confidenceBreakdown(records, now),
    bluetooth: {
      audibleHere: coverageHere.bluetooth.audible,
      rotatingBleIdentities: rotatingBle,
      note: "Bluetooth here is historical BLE catalogue data with rotating identities; it models an arrival update, it is not a current discovery result.",
    },
    route,
    arrivals,
    blocking,
    warnings,
  };
}

/** Whole-area, pre-execution coverage report for one client service area and the phones working it. */
export async function areaCoverageReport(prisma: PrismaClient, tenantId: string, raw: unknown, now = Date.now()): Promise<AreaCoverageReport> {
  const request = areaReportRequestSchema.parse(raw);
  const pin = await resolvePin(prisma, tenantId, { dataset: request.dataset, revision: request.revision });
  const tiles = await tileMetadata(prisma, pin.revisionId);
  const summary = summarizeTiles(pin, tiles, request.radii, request.travelMarginM, request.budget);
  const phones: PhoneReadiness[] = [];
  for (const phone of request.phones) {
    phones.push(await phoneReadiness(prisma, tenantId, pin, phone, {
      radii: request.radii, travelMarginM: request.travelMarginM, budget: request.budget,
      sampleSpacingM: request.sampleSpacingM, now,
    }));
  }

  const blocking: string[] = [];
  const warnings: string[] = [];
  if (!pin.isActiveRevision) warnings.push(`Reporting on revision ${pin.revision}, which is not the dataset's active revision.`);
  if (pin.counts.records === 0) blocking.push("This dataset revision holds no observations at all.");
  if (summary.tilesWithoutWifi) {
    warnings.push(`${summary.tilesWithoutWifi} of ${summary.footprintTiles} tiles in the service area hold no Wi-Fi observation; those are coverage holes, visible before execution.`);
  }
  if (summary.windowFitsBudget === false) {
    warnings.push(`At the densest stored tile, a ${request.radii.wifiM + request.travelMarginM} m window is estimated at `
      + `${summary.estimatedWindowRecordsAtDensestTile} observations, above the ${request.budget}-record engine limit; windows there reload more often.`);
  }
  const cellPlmns = summary.plmn.length;
  if (cellPlmns === 0) blocking.push("No stored cell observation carries an explicit PLMN, so no carrier can be served a cell at all.");
  for (const phone of phones) {
    blocking.push(...phone.blocking.map((reason) => `${phone.imageId}: ${reason}`));
    warnings.push(...phone.warnings.map((reason) => `${phone.imageId}: ${reason}`));
  }
  const wifiOk = phones.length > 0 && phones.every((phone) => phone.coverageHere.wifi.audible > 0 && !phone.route?.gaps.some((gap) => gap.kind === "WIFI"));
  const wifiPartial = phones.some((phone) => phone.coverageHere.wifi.audible > 0);
  const cellOk = phones.length > 0 && phones.every((phone) => phone.coverageHere.cell.eligible > 0 && !phone.route?.gaps.some((gap) => gap.kind === "CELL"));
  const cellPartial = phones.some((phone) => phone.coverageHere.cell.eligible > 0);
  const bluetoothAvailable = phones.some((phone) => phone.bluetooth.audibleHere > 0 || phone.arrivals.some((arrival) => arrival.bluetoothAudible > 0));
  const overall = blocking.length ? "NOT_SUPPORTED" : warnings.length ? "SUPPORTED_WITH_LIMITS" : "SUPPORTED";
  return {
    pin,
    tiles: summary,
    phones,
    verdict: {
      overall,
      byInterface: {
        wifi: wifiOk ? "SUPPORTED" : wifiPartial ? "PARTIAL" : "NOT_SUPPORTED",
        cellular: cellOk ? "SUPPORTED" : cellPartial ? "PARTIAL" : "NOT_SUPPORTED",
        bluetoothArrival: bluetoothAvailable ? "HISTORICAL_ONLY" : "NOT_SUPPORTED",
      },
      blocking,
      warnings,
    },
  };
}

/** Confidence detail for one saved observation, used by the CLI when explaining a sample. */
export function explainConfidence(record: Observation, now = Date.now()) {
  return { identifier: record.identifier, kind: record.kind, source: record.source, transid: record.transid ?? null, ...observationConfidence(record, now) };
}

export function distanceToArea(position: Position, pin: AreaPin): number {
  return Math.round(haversineMeters(pin.area.center.lat, pin.area.center.lng, position.lat, position.lng));
}
