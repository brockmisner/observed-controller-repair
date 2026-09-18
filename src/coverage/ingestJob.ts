import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { HttpError } from "../http/errors.js";
import type { Position } from "../radio/schema.js";
import { addSources, appendRecords, finalizeRevision, openRevision, type IngestSource } from "./areaStore.js";
import { ENDPOINTS, planQueryCells, WIGLE_PAGE_SIZE, type QueryKind } from "./ingestPlan.js";
import { classifyResponse, mergeNormalizations, normalizeWigleRows, type CellScenario, type RowNormalization } from "./wigleRows.js";

/**
 * Resumable area ingest.
 *
 * The WiGLE daily allowance stops an ingest mid-way, so the work is split into per-cell, per-kind units
 * with their own `searchAfter` cursor, every fetched page is merged into the revision immediately, and a
 * rate-limited response pauses the job instead of failing it. Restarting continues from the stored
 * cursors; nothing already fetched is fetched again.
 */

export const ingestJobRequestSchema = z.object({
  name: z.string().trim().min(1).max(100),
  center: z.object({ lat: z.number().finite().min(-90).max(90), lng: z.number().finite().min(-180).max(180) }).strict(),
  radiusM: z.number().finite().min(100).max(30000),
  kinds: z.array(z.enum(["WIFI", "CELL", "BLUETOOTH"])).min(1).default(["WIFI", "CELL", "BLUETOOTH"]),
  cellSizeM: z.number().finite().min(100).max(5000).default(1000),
  dailyQueryBudget: z.number().int().min(1).max(100000).default(2000),
  tileZoom: z.number().int().min(10).max(18).optional(),
  redefine: z.boolean().default(false),
}).strict();
export type IngestJobRequest = z.infer<typeof ingestJobRequestSchema>;

export type UnitStatus = "PENDING" | "PARTIAL" | "DONE" | "EMPTY" | "BLOCKED";
export type JobStatus = "RUNNING" | "PAUSED_RATE_LIMIT" | "PAUSED" | "COMPLETE" | "FAILED";

export type FetchInput = {
  kind: QueryKind;
  endpoint: string;
  bbox: { latrange1: number; latrange2: number; longrange1: number; longrange2: number };
  cursor: string | null;
  resultsPerPage: number;
};
export type PageFetcher = (input: FetchInput) => Promise<unknown>;

export type RunSummary = {
  jobId: string;
  revisionId: string;
  datasetRevision: string | null;
  status: JobStatus;
  requestsThisRun: number;
  rowsThisRun: number;
  storedThisRun: number;
  requestsUsed: number;
  unitsRemaining: number;
  unitsDone: number;
  unitsBlocked: number;
  rateLimited: boolean;
  finalized: boolean;
  message: string | null;
  normalization: Omit<RowNormalization, "records">;
  warnings: string[];
};

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Creates the job and its query units, or returns the existing job for this dataset revision. */
export async function startOrResumeIngest(prisma: PrismaClient, tenantId: string, raw: unknown, now = new Date()) {
  const request = ingestJobRequestSchema.parse(raw);
  const opened = await openRevision(prisma, {
    tenantId, name: request.name, center: request.center, radiusM: request.radiusM,
    tileZoom: request.tileZoom, redefine: request.redefine,
  });
  const existing = await prisma.areaIngestJob.findUnique({ where: { revisionId: opened.revision.id } });
  if (existing) {
    if (existing.status === "PAUSED_RATE_LIMIT" || existing.status === "PAUSED") {
      await prisma.areaIngestJob.update({ where: { id: existing.id }, data: { status: "RUNNING" } });
    }
    return { job: { ...existing, status: "RUNNING" as JobStatus }, revision: opened.revision, resumed: true };
  }
  const cells = planQueryCells(request.center, request.radiusM, request.cellSizeM);
  const job = await prisma.areaIngestJob.create({
    data: {
      revisionId: opened.revision.id, datasetId: opened.dataset.id, tenantId, status: "RUNNING",
      kindsJson: JSON.stringify(request.kinds), cellSizeM: Math.round(request.cellSizeM),
      dailyQueryBudget: request.dailyQueryBudget, budgetDay: dayKey(now),
    },
  });
  const units = request.kinds.flatMap((kind) => cells.map((cell) => ({
    jobId: job.id, kind, cellKey: cell.cellKey,
    minLat: cell.minLat, maxLat: cell.maxLat, minLng: cell.minLng, maxLng: cell.maxLng,
  })));
  for (let index = 0; index < units.length; index += 200) {
    await prisma.areaIngestUnit.createMany({ data: units.slice(index, index + 200) });
  }
  return { job, revision: opened.revision, resumed: false };
}

/**
 * Fetches pages until the run budget, the account's daily allowance or the work runs out.
 * Every page is stored before the next request, so an interruption costs at most one page.
 */
export async function runIngest(prisma: PrismaClient, jobId: string, fetcher: PageFetcher, options: {
  maxRequests?: number;
  scenario?: CellScenario | null;
  now?: Date;
} = {}): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const job = await prisma.areaIngestJob.findUnique({ where: { id: jobId } });
  if (!job) throw new HttpError(404, "Ingest job not found");
  const revision = await prisma.areaDatasetRevision.findUniqueOrThrow({ where: { id: job.revisionId } });
  const area = { center: { lat: revision.centerLat, lng: revision.centerLng } as Position, radiusM: revision.radiusM };
  const today = dayKey(now);
  let requestsToday = job.budgetDay === today ? job.requestsToday : 0;
  const maxRequests = Math.max(0, Math.min(options.maxRequests ?? job.dailyQueryBudget, job.dailyQueryBudget - requestsToday));
  const warnings: string[] = [];
  let normalization = normalizeWigleRows([], { source: "ingest" });
  let requestsThisRun = 0;
  let rowsThisRun = 0;
  let storedThisRun = 0;
  let rateLimited = false;
  let message: string | null = null;

  if (maxRequests === 0) {
    warnings.push(`Daily query budget of ${job.dailyQueryBudget} is already used for ${today}; resume tomorrow or raise the budget.`);
  }

  while (requestsThisRun < maxRequests) {
    const unit = await prisma.areaIngestUnit.findFirst({
      where: { jobId, status: { in: ["PENDING", "PARTIAL"] } },
      orderBy: [{ status: "desc" }, { cellKey: "asc" }, { kind: "asc" }],
    });
    if (!unit) break;
    const kind = unit.kind as QueryKind;
    let response: unknown;
    try {
      response = await fetcher({
        kind,
        endpoint: ENDPOINTS[kind],
        bbox: { latrange1: unit.minLat, latrange2: unit.maxLat, longrange1: unit.minLng, longrange2: unit.maxLng },
        cursor: unit.cursor,
        resultsPerPage: WIGLE_PAGE_SIZE,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 300) : "Query failed";
      await prisma.areaIngestUnit.update({ where: { id: unit.id }, data: { status: "BLOCKED", lastError: detail } });
      warnings.push(`${kind} ${unit.cellKey}: ${detail}`);
      requestsThisRun++;
      requestsToday++;
      continue;
    }
    requestsThisRun++;
    requestsToday++;
    const classified = classifyResponse(response);
    if (classified.kind === "RATE_LIMITED") {
      rateLimited = true;
      message = classified.message;
      await prisma.areaIngestUnit.update({ where: { id: unit.id }, data: { status: "PARTIAL", lastError: classified.message } });
      break;
    }
    if (classified.kind === "ERROR") {
      await prisma.areaIngestUnit.update({ where: { id: unit.id }, data: { status: "BLOCKED", lastError: classified.message } });
      warnings.push(`${kind} ${unit.cellKey}: ${classified.message ?? "search failed"}`);
      continue;
    }
    const page = normalizeWigleRows(classified.rows, {
      source: `wigle:${ENDPOINTS[kind]}:${unit.cellKey}`,
      scenario: options.scenario ?? null,
      area,
      now: now.getTime(),
    });
    normalization = mergeNormalizations(normalization, page);
    rowsThisRun += classified.rows.length;
    if (page.records.length) {
      const appended = await appendRecords(prisma, job.revisionId, page.records, now);
      storedThisRun += appended.accepted;
    }
    await addSources(prisma, job.revisionId, [{
      filename: `wigle:${ENDPOINTS[kind]}:${unit.cellKey}`,
      sha256: null,
      rows: unit.rows + classified.rows.length,
      endpoint: ENDPOINTS[kind],
      queriedAt: now.toISOString(),
      note: classified.page.totalResults === null ? null : `bounded totalResults=${classified.page.totalResults}`,
    }]);
    const exhausted = !classified.page.searchAfter || classified.rows.length < WIGLE_PAGE_SIZE;
    await prisma.areaIngestUnit.update({
      where: { id: unit.id },
      data: {
        status: exhausted ? (unit.rows + classified.rows.length === 0 ? "EMPTY" : "DONE") : "PARTIAL",
        cursor: exhausted ? null : classified.page.searchAfter,
        pages: unit.pages + 1,
        rows: unit.rows + classified.rows.length,
        totalResults: classified.page.totalResults,
        lastError: null,
      },
    });
  }

  const [remaining, done, blocked] = await Promise.all([
    prisma.areaIngestUnit.count({ where: { jobId, status: { in: ["PENDING", "PARTIAL"] } } }),
    prisma.areaIngestUnit.count({ where: { jobId, status: { in: ["DONE", "EMPTY"] } } }),
    prisma.areaIngestUnit.count({ where: { jobId, status: "BLOCKED" } }),
  ]);
  const status: JobStatus = rateLimited ? "PAUSED_RATE_LIMIT" : remaining === 0 ? "COMPLETE" : "PAUSED";
  await prisma.areaIngestJob.update({
    where: { id: jobId },
    data: {
      status,
      requestsUsed: job.requestsUsed + requestsThisRun,
      requestsToday,
      budgetDay: today,
      rowsFetched: job.rowsFetched + rowsThisRun,
      recordsStored: job.recordsStored + storedThisRun,
      rateLimitedAt: rateLimited ? now : job.rateLimitedAt,
      lastMessage: message ?? (remaining === 0 ? "All query units complete" : warnings[0] ?? null),
      completedAt: remaining === 0 ? now : null,
    },
  });

  let datasetRevision: string | null = null;
  let finalized = false;
  if (remaining === 0) {
    const result = await finalizeRevision(prisma, job.revisionId, { activate: false, now });
    datasetRevision = result.datasetRevision;
    finalized = true;
    warnings.push("Revision is complete but not yet active. Activate it explicitly so a refresh never changes a running phone's dataset.");
  } else {
    warnings.push(`${remaining} query unit(s) still pending; the revision stays in BUILDING and is not served to any run.`);
  }
  if (rateLimited) {
    warnings.push(`WiGLE reported "${message}". Progress is saved; resume this job after the allowance resets.`);
  }
  if (blocked) warnings.push(`${blocked} query unit(s) are blocked by errors and need attention before this area is complete.`);

  const { records: _records, ...normalizationSummary } = normalization;
  return {
    jobId, revisionId: job.revisionId, datasetRevision, status,
    requestsThisRun, rowsThisRun, storedThisRun, requestsUsed: job.requestsUsed + requestsThisRun,
    unitsRemaining: remaining, unitsDone: done, unitsBlocked: blocked,
    rateLimited, finalized, message, normalization: normalizationSummary, warnings,
  };
}

/**
 * Offline ingest of saved WiGLE responses, including the aggregated area fetches. Same normalizer and
 * same tiled storage as the live path, so a file-based ingest and an API ingest produce the same dataset.
 */
export async function ingestSavedResponses(prisma: PrismaClient, input: {
  tenantId: string;
  name: string;
  center: Position;
  radiusM: number;
  tileZoom?: number;
  redefine?: boolean;
  files: Array<{ filename: string; contents: string }>;
  scenario?: CellScenario | null;
  activate?: boolean;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const opened = await openRevision(prisma, {
    tenantId: input.tenantId, name: input.name, center: input.center, radiusM: input.radiusM,
    tileZoom: input.tileZoom, redefine: input.redefine,
  });
  const area = { center: input.center, radiusM: input.radiusM };
  let normalization = normalizeWigleRows([], { source: "files" });
  const sources: IngestSource[] = [];
  const warnings: string[] = [];
  let stored = 0;
  let rows = 0;
  let rateLimitedFiles = 0;
  for (const file of input.files) {
    let parsed: unknown;
    try { parsed = JSON.parse(file.contents); }
    catch {
      warnings.push(`${file.filename}: not valid JSON; skipped.`);
      continue;
    }
    const classified = classifyResponse(parsed);
    const sha256 = createHash("sha256").update(file.contents).digest("hex");
    if (classified.kind === "RATE_LIMITED") {
      rateLimitedFiles++;
      warnings.push(`${file.filename}: WiGLE rate-limit response ("${classified.message}"), so this file carries no observations.`);
      sources.push({ filename: file.filename, sha256, rows: 0, endpoint: null, queriedAt: null, note: `rate limited: ${classified.message}` });
      continue;
    }
    if (classified.kind === "ERROR") {
      warnings.push(`${file.filename}: ${classified.message ?? "unrecognized response"}; skipped.`);
      continue;
    }
    if (classified.empty) warnings.push(`${file.filename}: valid response with zero results — that is an absence of coverage, not an error.`);
    if (classified.origin && classified.radiusKm) {
      const offsetM = Math.abs(classified.radiusKm * 1000 - input.radiusM);
      if (offsetM > 1) {
        warnings.push(`${file.filename}: file states a ${classified.radiusKm} km fetch radius, which differs from this area's ${Math.round(input.radiusM / 100) / 10} km radius.`);
      }
    }
    if (classified.page.totalResults !== null && classified.page.totalResults > 1_000_000) {
      warnings.push(`${file.filename}: totalResults=${classified.page.totalResults} indicates an unbounded query; its row count describes the whole WiGLE corpus, not this area.`);
    }
    if (classified.page.searchAfter) {
      warnings.push(`${file.filename}: response carries a searchAfter cursor, so it is one page of a larger result set and coverage from it is partial.`);
    }
    const page = normalizeWigleRows(classified.rows, { source: file.filename, scenario: input.scenario ?? null, area, now: now.getTime() });
    normalization = mergeNormalizations(normalization, page);
    rows += classified.rows.length;
    if (page.records.length) {
      const appended = await appendRecords(prisma, opened.revision.id, page.records, now);
      stored += appended.accepted;
    }
    sources.push({
      filename: file.filename, sha256, rows: classified.rows.length,
      endpoint: classified.kind === "AGGREGATE" ? "aggregate" : null,
      queriedAt: null,
      note: classified.page.totalResults === null ? null : `totalResults=${classified.page.totalResults}`,
    });
  }
  await addSources(prisma, opened.revision.id, sources);
  const finalized = await finalizeRevision(prisma, opened.revision.id, { activate: input.activate, now });
  const { records: _records, ...normalizationSummary } = normalization;
  if (normalization.outsideRadius) {
    warnings.push(`${normalization.outsideRadius} row(s) fell outside the ${input.radiusM} m service area and were not stored.`);
  }
  if (rateLimitedFiles) warnings.push(`${rateLimitedFiles} file(s) were rate-limit responses; the ingest is incomplete by exactly their missing pages.`);
  return { ...finalized, rows, stored, normalization: normalizationSummary, sources, warnings };
}

export async function ingestStatus(prisma: PrismaClient, tenantId: string, jobId: string) {
  const job = await prisma.areaIngestJob.findFirst({ where: { id: jobId, tenantId } });
  if (!job) throw new HttpError(404, "Ingest job not found in this workspace");
  const units = await prisma.areaIngestUnit.groupBy({ by: ["kind", "status"], where: { jobId }, _count: true, _sum: { rows: true, pages: true } });
  return {
    job: {
      ...job,
      startedAt: job.startedAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      rateLimitedAt: job.rateLimitedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      kinds: JSON.parse(job.kindsJson) as QueryKind[],
      kindsJson: undefined,
    },
    units: units.map((row) => ({ kind: row.kind, status: row.status, units: row._count, rows: row._sum.rows ?? 0, pages: row._sum.pages ?? 0 })),
  };
}
