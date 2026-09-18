import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { haversineMeters } from "../geo/haversine.js";
import { HttpError } from "../http/errors.js";
import { recordKey, type Position, type RadioRecord } from "../radio/schema.js";
import { auditDataset, dateSpan, KINDS, mergeAudits, parseDataset, type DatasetAudit, type Kind } from "./inventory.js";
import { observationSchema, type Observation } from "./observation.js";
import { DEFAULT_TILE_ZOOM, MAX_TILE_ZOOM, MIN_TILE_ZOOM, tileBounds, tileFor } from "./tiles.js";
import { usability } from "./usability.js";
import type { TileReader } from "./window.js";

/** One saved source file or query page, kept so provenance survives the tiling step. */
export const ingestSourceSchema = z.object({
  filename: z.string().trim().min(1).max(300),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  rows: z.number().int().nonnegative(),
  endpoint: z.string().max(100).nullable().default(null),
  queriedAt: z.string().max(100).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
}).strict();
export type IngestSource = z.infer<typeof ingestSourceSchema>;

export type AreaPin = {
  datasetId: string;
  name: string;
  revisionId: string;
  revision: number;
  /** Value handed to the radio engine, so a refresh cannot change a running phone's world. */
  datasetRevision: string;
  tileZoom: number;
  area: { center: Position; radiusM: number };
  counts: { records: number; wifi: number; cell: number; bluetooth: number; tiles: number; maxTileRecords: number };
  dates: { oldestLastSeen: string | null; newestLastSeen: string | null; unknownDateCount: number };
  sources: IngestSource[];
  audit: DatasetAudit | null;
  builtAt: string | null;
  isActiveRevision: boolean;
};

export type AppendSummary = {
  accepted: number;
  invalid: number;
  outside: number;
  replaced: number;
  tilesTouched: number;
  bytesWritten: number;
};

function pinValue(datasetId: string, revision: number): string {
  return `${datasetId}:${revision}`;
}

function parseSources(json: string): IngestSource[] {
  try {
    const parsed = z.array(ingestSourceSchema).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch { return []; }
}

function parseAudit(json: string | null): DatasetAudit | null {
  if (!json) return null;
  try { return JSON.parse(json) as DatasetAudit; } catch { return null; }
}

/**
 * Opens (or resumes) a revision under construction. A refresh builds a new revision beside the active
 * one; nothing an active run reads changes until the new revision is complete and activated.
 */
export async function openRevision(prisma: PrismaClient, input: {
  tenantId: string;
  name: string;
  center: Position;
  radiusM: number;
  tileZoom?: number;
  redefine?: boolean;
  resume?: boolean;
}) {
  const tileZoom = input.tileZoom ?? DEFAULT_TILE_ZOOM;
  if (!Number.isInteger(tileZoom) || tileZoom < MIN_TILE_ZOOM || tileZoom > MAX_TILE_ZOOM) {
    throw new HttpError(400, `Tile zoom must be an integer between ${MIN_TILE_ZOOM} and ${MAX_TILE_ZOOM}`);
  }
  if (!Number.isFinite(input.radiusM) || input.radiusM < 100 || input.radiusM > 30_000) {
    throw new HttpError(400, "Service-area radius must be between 100 m and 30,000 m");
  }
  const existing = await prisma.areaDataset.findFirst({ where: { tenantId: input.tenantId, name: input.name } });
  if (existing && !input.redefine) {
    const moved = haversineMeters(existing.centerLat, existing.centerLng, input.center.lat, input.center.lng) > 1;
    if (moved || existing.radiusM !== Math.round(input.radiusM) || existing.tileZoom !== tileZoom) {
      throw new HttpError(409, "This service area already exists with a different centre, radius or tile zoom. "
        + "Revisions of one area must share its geometry; pass redefine to change it.");
    }
  }
  const dataset = existing
    ? await prisma.areaDataset.update({
      where: { id: existing.id },
      data: input.redefine
        ? { centerLat: input.center.lat, centerLng: input.center.lng, radiusM: Math.round(input.radiusM), tileZoom }
        : {},
    })
    : await prisma.areaDataset.create({
      data: {
        tenantId: input.tenantId, name: input.name, centerLat: input.center.lat, centerLng: input.center.lng,
        radiusM: Math.round(input.radiusM), tileZoom,
      },
    });
  if (input.resume !== false) {
    const building = await prisma.areaDatasetRevision.findFirst({
      where: { datasetId: dataset.id, status: "BUILDING" },
      orderBy: { revision: "desc" },
    });
    if (building) return { dataset, revision: building, resumed: true };
  }
  const previous = await prisma.areaDatasetRevision.aggregate({ where: { datasetId: dataset.id }, _max: { revision: true } });
  const revision = await prisma.areaDatasetRevision.create({
    data: {
      datasetId: dataset.id, revision: (previous._max.revision ?? 0) + 1, status: "BUILDING", tileZoom,
      centerLat: dataset.centerLat, centerLng: dataset.centerLng, radiusM: dataset.radiusM,
    },
  });
  return { dataset, revision, resumed: false };
}

/**
 * Merges a batch of observations into the revision's tiles. Each call is durable on its own, so an
 * ingest interrupted by the daily query limit keeps everything it already fetched. Identities already
 * stored are replaced only by a newer sighting.
 */
export async function appendRecords(prisma: PrismaClient, revisionId: string, records: readonly unknown[], now = new Date()): Promise<AppendSummary> {
  const revision = await prisma.areaDatasetRevision.findUnique({ where: { id: revisionId } });
  if (!revision) throw new HttpError(404, "Dataset revision not found");
  if (revision.status !== "BUILDING") throw new HttpError(409, `Revision ${revision.revision} is ${revision.status}; completed revisions are immutable.`);
  const summary: AppendSummary = { accepted: 0, invalid: 0, outside: 0, replaced: 0, tilesTouched: 0, bytesWritten: 0 };
  const buckets = new Map<string, { kind: Kind; tileKey: string; tileX: number; tileY: number; records: Observation[] }>();
  for (const row of records) {
    const parsed = observationSchema.safeParse(row);
    if (!parsed.success) {
      summary.invalid++;
      continue;
    }
    const record = parsed.data;
    if (haversineMeters(revision.centerLat, revision.centerLng, record.lat, record.lng) > revision.radiusM) {
      summary.outside++;
      continue;
    }
    const tile = tileFor({ lat: record.lat, lng: record.lng }, revision.tileZoom);
    const id = `${record.kind}|${tile.key}`;
    const bucket = buckets.get(id) ?? { kind: record.kind, tileKey: tile.key, tileX: tile.x, tileY: tile.y, records: [] };
    bucket.records.push(record);
    buckets.set(id, bucket);
  }

  for (const bucket of buckets.values()) {
    const existing = await prisma.areaDatasetTile.findUnique({
      where: { revisionId_kind_tileKey: { revisionId, kind: bucket.kind, tileKey: bucket.tileKey } },
      select: { id: true, recordsJson: true },
    });
    const merged = new Map<string, Observation>();
    if (existing) {
      for (const row of parseDataset(JSON.parse(existing.recordsJson)).records) merged.set(recordKey(row), row as Observation);
    }
    for (const record of bucket.records) {
      const key = recordKey(record);
      const previous = merged.get(key);
      if (previous) {
        summary.replaced++;
        const incoming = Date.parse(record.lastSeen ?? "");
        const stored = Date.parse(previous.lastSeen ?? "");
        if (!(Number.isFinite(incoming) && (!Number.isFinite(stored) || incoming >= stored))) continue;
      } else summary.accepted++;
      merged.set(key, record);
    }
    const rows = [...merged.values()];
    const recordsJson = JSON.stringify(rows);
    const bounds = tileBounds(revision.tileZoom, bucket.tileX, bucket.tileY);
    const span = dateSpan(rows, now.getTime());
    const plmn: Record<string, number> = {};
    for (const record of rows) {
      if (record.kind !== "CELL" || !record.cell) continue;
      const key = `${record.cell.mcc}-${record.cell.mnc}`;
      plmn[key] = (plmn[key] ?? 0) + 1;
    }
    const data = {
      revisionId, kind: bucket.kind, tileKey: bucket.tileKey, tileX: bucket.tileX, tileY: bucket.tileY,
      minLat: bounds.minLat, maxLat: bounds.maxLat, minLng: bounds.minLng, maxLng: bounds.maxLng,
      recordCount: rows.length,
      usableCount: rows.filter((record) => usability(record).usable).length,
      unknownDateCount: span.unknownLastSeen,
      oldestLastSeen: span.oldestLastSeen ? new Date(span.oldestLastSeen) : null,
      newestLastSeen: span.newestLastSeen ? new Date(span.newestLastSeen) : null,
      plmnJson: JSON.stringify(plmn),
      recordsJson,
      sha256: createHash("sha256").update(recordsJson).digest("hex"),
    };
    if (existing) await prisma.areaDatasetTile.update({ where: { id: existing.id }, data });
    else await prisma.areaDatasetTile.create({ data });
    summary.tilesTouched++;
    summary.bytesWritten += Buffer.byteLength(recordsJson, "utf8");
  }
  return summary;
}

export async function addSources(prisma: PrismaClient, revisionId: string, sources: IngestSource[]): Promise<void> {
  if (!sources.length) return;
  const revision = await prisma.areaDatasetRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { sourcesJson: true } });
  const existing = parseSources(revision.sourcesJson);
  const parsed = z.array(ingestSourceSchema).parse(sources);
  const merged = [...existing];
  for (const source of parsed) {
    const index = merged.findIndex((entry) => entry.filename === source.filename && entry.sha256 === source.sha256);
    if (index >= 0) merged[index] = source;
    else merged.push(source);
  }
  await prisma.areaDatasetRevision.update({ where: { id: revisionId }, data: { sourcesJson: JSON.stringify(merged.slice(-2000)) } });
}

/**
 * Recomputes the revision's aggregates from its stored tiles and, optionally, publishes it. The audit is
 * built tile by tile so a large area never has to be held in memory at once.
 */
export async function finalizeRevision(prisma: PrismaClient, revisionId: string, options: { activate?: boolean; now?: Date } = {}) {
  const now = options.now ?? new Date();
  const revision = await prisma.areaDatasetRevision.findUniqueOrThrow({ where: { id: revisionId } });
  const tiles = await prisma.areaDatasetTile.findMany({ where: { revisionId }, select: { id: true, kind: true, recordsJson: true, recordCount: true } });
  let audit: DatasetAudit | null = null;
  let maxTileRecords = 0;
  const byKind: Record<Kind, number> = { WIFI: 0, CELL: 0, BLUETOOTH: 0 };
  let oldest: number | null = null;
  let newest: number | null = null;
  let unknownDates = 0;
  let records = 0;
  for (const tile of tiles) {
    const parsed = parseDataset(JSON.parse(tile.recordsJson));
    const tileAudit = auditDataset(parsed, now.getTime());
    audit = audit ? mergeAudits(audit, tileAudit) : tileAudit;
    maxTileRecords = Math.max(maxTileRecords, tile.recordCount);
    byKind[tile.kind as Kind] += parsed.records.length;
    records += parsed.records.length;
    unknownDates += tileAudit.dates.unknownLastSeen;
    const tileOldest = tileAudit.dates.oldestLastSeen ? Date.parse(tileAudit.dates.oldestLastSeen) : null;
    const tileNewest = tileAudit.dates.newestLastSeen ? Date.parse(tileAudit.dates.newestLastSeen) : null;
    if (tileOldest !== null) oldest = oldest === null ? tileOldest : Math.min(oldest, tileOldest);
    if (tileNewest !== null) newest = newest === null ? tileNewest : Math.max(newest, tileNewest);
  }
  const updated = await prisma.areaDatasetRevision.update({
    where: { id: revisionId },
    data: {
      status: "COMPLETE",
      recordCount: records,
      wifiCount: byKind.WIFI, cellCount: byKind.CELL, bluetoothCount: byKind.BLUETOOTH,
      tileCount: tiles.length, maxTileRecords, unknownDateCount: unknownDates,
      oldestLastSeen: oldest === null ? null : new Date(oldest),
      newestLastSeen: newest === null ? null : new Date(newest),
      auditJson: audit ? JSON.stringify(audit) : null,
      builtAt: now,
    },
  });
  if (options.activate) {
    await prisma.areaDataset.update({ where: { id: revision.datasetId }, data: { activeRevisionId: revisionId } });
  }
  return {
    revisionId, revision: updated.revision, datasetRevision: pinValue(revision.datasetId, updated.revision),
    activated: Boolean(options.activate), records, tiles: tiles.length, maxTileRecords, byKind, audit,
  };
}

/**
 * Resolves the exact revision a run is pinned to. An explicit revision must be complete; otherwise the
 * dataset's active revision is used. A dataset with no complete revision fails instead of serving nothing.
 */
export async function resolvePin(prisma: PrismaClient, tenantId: string, ref: { dataset: string; revision?: number }): Promise<AreaPin> {
  const dataset = await prisma.areaDataset.findFirst({ where: { tenantId, OR: [{ id: ref.dataset }, { name: ref.dataset }] } });
  if (!dataset) throw new HttpError(404, "Service area not found in this workspace");
  const revisionRow = ref.revision === undefined
    ? dataset.activeRevisionId
      ? await prisma.areaDatasetRevision.findFirst({ where: { id: dataset.activeRevisionId, datasetId: dataset.id } })
      : null
    : await prisma.areaDatasetRevision.findFirst({ where: { datasetId: dataset.id, revision: ref.revision } });
  if (!revisionRow) {
    throw new HttpError(409, ref.revision === undefined
      ? `Service area "${dataset.name}" has no active dataset revision. Ingest and activate one before running.`
      : `Revision ${ref.revision} does not exist for service area "${dataset.name}".`);
  }
  if (revisionRow.status !== "COMPLETE") {
    throw new HttpError(409, `Revision ${revisionRow.revision} of "${dataset.name}" is ${revisionRow.status}; an incomplete revision is never served.`);
  }
  return {
    datasetId: dataset.id,
    name: dataset.name,
    revisionId: revisionRow.id,
    revision: revisionRow.revision,
    datasetRevision: pinValue(dataset.id, revisionRow.revision),
    tileZoom: revisionRow.tileZoom,
    area: { center: { lat: revisionRow.centerLat, lng: revisionRow.centerLng }, radiusM: revisionRow.radiusM },
    counts: {
      records: revisionRow.recordCount, wifi: revisionRow.wifiCount, cell: revisionRow.cellCount,
      bluetooth: revisionRow.bluetoothCount, tiles: revisionRow.tileCount, maxTileRecords: revisionRow.maxTileRecords,
    },
    dates: {
      oldestLastSeen: revisionRow.oldestLastSeen?.toISOString() ?? null,
      newestLastSeen: revisionRow.newestLastSeen?.toISOString() ?? null,
      unknownDateCount: revisionRow.unknownDateCount,
    },
    sources: parseSources(revisionRow.sourcesJson),
    audit: parseAudit(revisionRow.auditJson),
    builtAt: revisionRow.builtAt?.toISOString() ?? null,
    isActiveRevision: dataset.activeRevisionId === revisionRow.id,
  };
}

const storedShape = z.array(z.object({
  kind: z.enum(["WIFI", "CELL", "BLUETOOTH"]),
  identifier: z.string().min(1),
  lat: z.number().finite(),
  lng: z.number().finite(),
}).passthrough());

/**
 * Tile reader over stored revisions. Rows were validated against the full schema on the way in and
 * hashed, so reads check shape only; re-validating every field on a movement tick would cost more than
 * it proves. `verifyTile` re-validates on demand.
 */
export function prismaTileReader(prisma: PrismaClient): TileReader {
  return {
    async read(revisionId, kind, tileKeys) {
      if (!tileKeys.length) return [];
      const rows = await prisma.areaDatasetTile.findMany({
        where: { revisionId, kind, tileKey: { in: tileKeys } },
        select: { tileKey: true, recordsJson: true },
      });
      return rows.map((row) => {
        const parsed = storedShape.safeParse(JSON.parse(row.recordsJson));
        if (!parsed.success) throw new HttpError(500, `Stored tile ${kind}/${row.tileKey} is unreadable; reimport this revision.`);
        return { tileKey: row.tileKey, records: parsed.data as unknown as RadioRecord[] };
      });
    },
  };
}

export type TileMetadata = {
  kind: Kind;
  tileKey: string;
  tileX: number;
  tileY: number;
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  recordCount: number;
  usableCount: number;
  unknownDateCount: number;
  oldestLastSeen: string | null;
  newestLastSeen: string | null;
  plmn: Record<string, number>;
};

/** Bounded metadata read: tile statistics without any record payload. */
export async function tileMetadata(prisma: PrismaClient, revisionId: string): Promise<TileMetadata[]> {
  const rows = await prisma.areaDatasetTile.findMany({
    where: { revisionId },
    select: {
      kind: true, tileKey: true, tileX: true, tileY: true, minLat: true, maxLat: true, minLng: true, maxLng: true,
      recordCount: true, usableCount: true, unknownDateCount: true, oldestLastSeen: true, newestLastSeen: true, plmnJson: true,
    },
    orderBy: [{ kind: "asc" }, { tileY: "asc" }, { tileX: "asc" }],
  });
  return rows.map((row) => {
    let plmn: Record<string, number> = {};
    try { plmn = JSON.parse(row.plmnJson) as Record<string, number>; } catch { plmn = {}; }
    return {
      kind: row.kind as Kind, tileKey: row.tileKey, tileX: row.tileX, tileY: row.tileY,
      bounds: { minLat: row.minLat, maxLat: row.maxLat, minLng: row.minLng, maxLng: row.maxLng },
      recordCount: row.recordCount, usableCount: row.usableCount, unknownDateCount: row.unknownDateCount,
      oldestLastSeen: row.oldestLastSeen?.toISOString() ?? null,
      newestLastSeen: row.newestLastSeen?.toISOString() ?? null,
      plmn,
    };
  });
}

export async function listAreas(prisma: PrismaClient, tenantId: string) {
  const datasets = await prisma.areaDataset.findMany({ where: { tenantId }, orderBy: { name: "asc" } });
  return Promise.all(datasets.map(async (dataset) => {
    const revisions = await prisma.areaDatasetRevision.findMany({
      where: { datasetId: dataset.id },
      select: {
        id: true, revision: true, status: true, recordCount: true, wifiCount: true, cellCount: true, bluetoothCount: true,
        tileCount: true, maxTileRecords: true, builtAt: true, oldestLastSeen: true, newestLastSeen: true, sourcesJson: true,
      },
      orderBy: { revision: "desc" },
      take: 10,
    });
    const jobs = await prisma.areaIngestJob.findMany({
      where: { datasetId: dataset.id },
      select: {
        id: true, revisionId: true, status: true, requestsUsed: true, rowsFetched: true, recordsStored: true,
        dailyQueryBudget: true, rateLimitedAt: true, lastMessage: true, completedAt: true,
      },
      orderBy: { startedAt: "desc" },
      take: 5,
    });
    return {
      id: dataset.id, name: dataset.name,
      area: { center: { lat: dataset.centerLat, lng: dataset.centerLng }, radiusM: dataset.radiusM },
      tileZoom: dataset.tileZoom,
      activeRevisionId: dataset.activeRevisionId,
      revisions: revisions.map(({ sourcesJson, ...row }) => ({
        ...row,
        builtAt: row.builtAt?.toISOString() ?? null,
        oldestLastSeen: row.oldestLastSeen?.toISOString() ?? null,
        newestLastSeen: row.newestLastSeen?.toISOString() ?? null,
        active: dataset.activeRevisionId === row.id,
        datasetRevision: pinValue(dataset.id, row.revision),
        sources: parseSources(sourcesJson).length,
      })),
      ingestJobs: jobs.map((job) => ({ ...job, rateLimitedAt: job.rateLimitedAt?.toISOString() ?? null, completedAt: job.completedAt?.toISOString() ?? null })),
    };
  }));
}

/** Re-reads one stored tile, checks its hash and re-validates every record. */
export async function verifyTile(prisma: PrismaClient, revisionId: string, kind: Kind, tileKey: string) {
  const row = await prisma.areaDatasetTile.findFirst({ where: { revisionId, kind, tileKey } });
  if (!row) throw new HttpError(404, "Tile not found in this revision");
  const sha256 = createHash("sha256").update(row.recordsJson).digest("hex");
  const parsed = parseDataset(JSON.parse(row.recordsJson));
  return {
    tileKey, kind, recordCount: row.recordCount, storedSha256: row.sha256, sha256, matches: sha256 === row.sha256,
    revalidated: parsed.records.length, invalid: parsed.invalid, invalidReasons: parsed.invalidReasons,
    duplicateIdentities: parsed.duplicateIdentities.length,
    kinds: Object.fromEntries(KINDS.map((entry) => [entry, parsed.records.filter((record) => record.kind === entry).length])),
  };
}
