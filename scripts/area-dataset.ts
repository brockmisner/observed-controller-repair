/**
 * Service-area dataset tool.
 *
 * Commands
 *   plan        Print the query grid and request estimate for an area, before spending any WiGLE queries.
 *   ingest      Ingest saved WiGLE responses (search pages or aggregated area fetches) into a revision.
 *   fetch       Run or resume a live WiGLE ingest; stops cleanly on the daily limit and keeps progress.
 *   status      Show ingest job progress, including which query units still need pages.
 *   activate    Publish a complete revision so new runs pin to it.
 *   report      Pre-execution coverage report for an area and the phones working it.
 *   window      Show exactly what one phone's bounded window would load at a position.
 *   audit       Audit saved per-device WiGLE uploads and what a reimport would recover.
 *   bench       Measure ingest and window cost with generated observations, for capacity planning only.
 *
 * Exit code is 1 when a report's verdict is NOT_SUPPORTED, so this can gate an acceptance run.
 */
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { prisma } from "../src/db.js";
import { areaCoverageReport } from "../src/coverage/areaReport.js";
import { appendRecords, finalizeRevision, listAreas, openRevision, prismaTileReader, resolvePin } from "../src/coverage/areaStore.js";
import { ingestSavedResponses, ingestStatus, runIngest, startOrResumeIngest, type FetchInput } from "../src/coverage/ingestJob.js";
import { planAreaIngest, WIGLE_PAGE_SIZE } from "../src/coverage/ingestPlan.js";
import { auditReimport } from "../src/coverage/reimport.js";
import { cellScenarioSchema, type CellScenario } from "../src/coverage/wigleRows.js";
import { loadWindow, windowRequestSchema } from "../src/coverage/window.js";
import { tileCache } from "../src/coverage/datasetCache.js";
import { uploadSummary } from "../src/ops/wigleUpload.js";
import { wigleGet } from "../src/env/wigle.js";

const [command, ...argv] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const hit = argv.find((entry) => entry.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

function required(name: string): string {
  const value = flag(name);
  if (value === undefined) throw new Error(`Missing --${name}=`);
  return value;
}

function number(name: string, fallback?: number): number {
  const value = flag(name);
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`Missing --${name}=`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function position(name: string): { lat: number; lng: number } {
  const [lat, lng] = required(name).split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`--${name}=lat,lng expected`);
  return { lat: lat!, lng: lng! };
}

function positions(name: string): Array<{ lat: number; lng: number }> | undefined {
  const value = flag(name);
  if (!value) return undefined;
  return value.split(";").map((pair) => {
    const [lat, lng] = pair.split(",").map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`--${name} expects lat,lng;lat,lng`);
    return { lat: lat!, lng: lng! };
  });
}

async function tenant(): Promise<string> {
  const explicit = flag("tenantId");
  if (explicit) return explicit;
  const first = await prisma.tenant.findFirst({ orderBy: { createdAt: "asc" } });
  if (!first) throw new Error("No workspace exists yet; pass --tenantId=");
  return first.id;
}

async function scenario(): Promise<CellScenario | null> {
  const path = flag("cellScenario");
  if (!path) return null;
  return cellScenarioSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function inputFiles(): Promise<Array<{ filename: string; contents: string }>> {
  const directory = flag("dir");
  const list = flag("files");
  const paths = directory
    ? (await readdir(directory)).filter((entry) => entry.endsWith(".json")).map((entry) => join(directory, entry))
    : (list ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!paths.length) throw new Error("Pass --dir=<directory> or --files=a.json,b.json");
  return Promise.all(paths.map(async (path) => ({ filename: basename(path), contents: await readFile(path, "utf8") })));
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Live WiGLE page fetch for one query unit. Bounded by the caller's request budget. */
function wigleFetcher(tenantId: string) {
  return async (input: FetchInput) => {
    const response = await wigleGet<unknown>(input.endpoint, {
      onlymine: false,
      resultsPerPage: input.resultsPerPage,
      latrange1: input.bbox.latrange1,
      latrange2: input.bbox.latrange2,
      longrange1: input.bbox.longrange1,
      longrange2: input.bbox.longrange2,
      ...(input.cursor ? { searchAfter: input.cursor } : {}),
    }, tenantId);
    // 429 is the daily-allowance refusal; 402 is the commercial-token balance refusal. Both pause the job.
    if (response.status === 429) return { success: false, message: "too many queries today" };
    if (response.status === 402) return { success: false, message: "insufficient balance for commercial query" };
    if (response.status < 200 || response.status >= 300) return { success: false, message: `WiGLE HTTP ${response.status}` };
    return response.data;
  };
}

function generatedRecords(count: number, center: { lat: number; lng: number }, radiusM: number, now: number) {
  const records = [];
  for (let index = 0; index < count; index++) {
    // Deterministic spiral fill, so a benchmark is repeatable. Synthetic data for cost measurement only.
    const angle = index * 2.399963;
    const distance = radiusM * Math.sqrt((index % count) / count);
    const lat = center.lat + (distance * Math.cos(angle)) / 111_139;
    const lng = center.lng + (distance * Math.sin(angle)) / (111_139 * Math.cos((center.lat * Math.PI) / 180));
    const octet = (value: number) => value.toString(16).padStart(2, "0").slice(-2);
    records.push({
      kind: "WIFI" as const,
      identifier: `02:${octet(index & 255)}:${octet((index >> 8) & 255)}:${octet((index >> 16) & 255)}:00:01`.replace(/^02/, "aa"),
      ssid: `bench-${index}`,
      lat, lng,
      qos: index % 8,
      frequencyMHz: 2412 + (index % 13) * 5,
      channel: 1 + (index % 13),
      lastSeen: new Date(now - (index % 900) * 86_400_000).toISOString(),
      lastUpdated: new Date(now - (index % 400) * 86_400_000).toISOString(),
      source: "benchmark-generated",
      transid: `bench-${index % 50}`,
    });
  }
  return records;
}

async function main(): Promise<number> {
  switch (command) {
    case "plan": {
      print(planAreaIngest({
        center: position("center"),
        radiusM: number("radiusM", 11265),
        cellSizeM: number("cellSizeM", 1000),
        dailyQueryBudget: number("dailyBudget", 2000),
        ...(flag("kinds") ? { kinds: flag("kinds")!.split(",") as ("WIFI" | "CELL" | "BLUETOOTH")[] } : {}),
        ...(flag("wifiPerKm2") ? { densityPerKm2: { WIFI: number("wifiPerKm2") } } : {}),
      }));
      return 0;
    }
    case "ingest": {
      const result = await ingestSavedResponses(prisma, {
        tenantId: await tenant(),
        name: required("name"),
        center: position("center"),
        radiusM: number("radiusM"),
        ...(flag("tileZoom") ? { tileZoom: number("tileZoom") } : {}),
        redefine: flag("redefine") === "true",
        files: await inputFiles(),
        scenario: await scenario(),
        activate: flag("activate") === "true",
      });
      print(result);
      return 0;
    }
    case "fetch": {
      const tenantId = await tenant();
      const started = await startOrResumeIngest(prisma, tenantId, {
        name: required("name"),
        center: position("center"),
        radiusM: number("radiusM"),
        cellSizeM: number("cellSizeM", 1000),
        dailyQueryBudget: number("dailyBudget", 2000),
        ...(flag("kinds") ? { kinds: flag("kinds")!.split(",") as ("WIFI" | "CELL" | "BLUETOOTH")[] } : {}),
        ...(flag("tileZoom") ? { tileZoom: number("tileZoom") } : {}),
        redefine: flag("redefine") === "true",
      });
      const summary = await runIngest(prisma, started.job.id, wigleFetcher(tenantId), {
        maxRequests: number("maxRequests", 100),
        scenario: await scenario(),
      });
      print({ resumed: started.resumed, ...summary });
      return summary.status === "PAUSED_RATE_LIMIT" ? 0 : 0;
    }
    case "status": {
      print(await ingestStatus(prisma, await tenant(), required("jobId")));
      return 0;
    }
    case "areas": {
      print({ areas: await listAreas(prisma, await tenant()) });
      return 0;
    }
    case "activate": {
      const tenantId = await tenant();
      const pin = await resolvePin(prisma, tenantId, { dataset: required("name"), revision: number("revision") });
      await prisma.areaDataset.update({ where: { id: pin.datasetId }, data: { activeRevisionId: pin.revisionId } });
      print({ activated: pin.datasetRevision, records: pin.counts.records, tiles: pin.counts.tiles });
      return 0;
    }
    case "finalize": {
      const tenantId = await tenant();
      const dataset = await prisma.areaDataset.findFirst({ where: { tenantId, OR: [{ id: required("name") }, { name: required("name") }] } });
      if (!dataset) throw new Error("Service area not found");
      const building = await prisma.areaDatasetRevision.findFirst({ where: { datasetId: dataset.id, status: "BUILDING" }, orderBy: { revision: "desc" } });
      if (!building) throw new Error("No revision is under construction for this area");
      print(await finalizeRevision(prisma, building.id, { activate: flag("activate") === "true" }));
      return 0;
    }
    case "report": {
      const report = await areaCoverageReport(prisma, await tenant(), {
        dataset: required("name"),
        ...(flag("revision") ? { revision: number("revision") } : {}),
        travelMarginM: number("travelMarginM", 450),
        sampleSpacingM: number("sampleSpacingM", 250),
        phones: (flag("deviceIds") ?? "").split(",").filter(Boolean).map((deviceId, index) => ({
          deviceId,
          ...(positions("positions")?.[index] ? { position: positions("positions")![index]! } : {}),
          ...(index === 0 && positions("route") ? { route: positions("route")! } : {}),
          arrivals: index === 0 && positions("arrivals")
            ? positions("arrivals")!.map((point, order) => ({ label: `arrival-${order + 1}`, ...point }))
            : [],
        })),
      });
      print(report);
      return report.verdict.overall === "NOT_SUPPORTED" ? 1 : 0;
    }
    case "window": {
      const tenantId = await tenant();
      const pin = await resolvePin(prisma, tenantId, {
        dataset: required("name"),
        ...(flag("revision") ? { revision: number("revision") } : {}),
      });
      const started = performance.now();
      const load = await loadWindow({
        reader: prismaTileReader(prisma),
        revisionId: pin.revisionId,
        datasetRevision: pin.datasetRevision,
        tileZoom: pin.tileZoom,
        area: pin.area,
        request: windowRequestSchema.parse({ position: position("at"), travelMarginM: number("travelMarginM", 450) }),
      });
      const { records, ...summary } = load;
      print({ ...summary, elapsedMs: Math.round(performance.now() - started), records: records.length, cache: tileCache.stats() });
      return load.plan.status === "DENSITY_EXCEEDS_WINDOW" ? 1 : 0;
    }
    case "audit": {
      const tenantId = await tenant();
      const uploads = await prisma.deviceWigleUpload.findMany({
        where: { device: { tenantId }, ...(flag("deviceId") ? { deviceId: flag("deviceId")! } : {}) },
        orderBy: { importedAt: "desc" },
        take: number("limit", 25),
      });
      print({
        uploads: uploads.map((upload) => ({
          ...uploadSummary(upload),
          deviceId: upload.deviceId,
          reimport: auditReimport(upload.payloadJson, { source: upload.filename }),
        })),
      });
      return 0;
    }
    case "bench": {
      const tenantId = await tenant();
      const center = position("center");
      const radiusM = number("radiusM", 11265);
      const total = number("records", 200000);
      const batchSize = number("batch", 20000);
      const opened = await openRevision(prisma, {
        tenantId, name: flag("name") ?? "benchmark-area", center, radiusM,
        ...(flag("tileZoom") ? { tileZoom: number("tileZoom") } : {}),
        redefine: true, resume: false,
      });
      const now = Date.now();
      const timings = { ingestMs: 0, finalizeMs: 0, windowMs: [] as number[] };
      let stored = 0;
      const ingestStart = performance.now();
      for (let offset = 0; offset < total; offset += batchSize) {
        const batch = generatedRecords(Math.min(batchSize, total - offset), center, radiusM, now)
          .map((record, index) => ({ ...record, identifier: record.identifier, ssid: `bench-${offset + index}` }));
        const result = await appendRecords(prisma, opened.revision.id, batch.map((record, index) => ({
          ...record,
          identifier: `aa:${((offset + index) >> 24 & 255).toString(16).padStart(2, "0")}:${((offset + index) >> 16 & 255).toString(16).padStart(2, "0")}:${((offset + index) >> 8 & 255).toString(16).padStart(2, "0")}:${((offset + index) & 255).toString(16).padStart(2, "0")}:01`,
        })));
        stored += result.accepted;
      }
      timings.ingestMs = Math.round(performance.now() - ingestStart);
      const finalizeStart = performance.now();
      const finalized = await finalizeRevision(prisma, opened.revision.id, { activate: true });
      timings.finalizeMs = Math.round(performance.now() - finalizeStart);
      tileCache.reset();
      const reader = prismaTileReader(prisma);
      const samples = 8;
      let lastLoad;
      for (let index = 0; index < samples; index++) {
        const angle = (index / samples) * 2 * Math.PI;
        const at = {
          lat: center.lat + (radiusM * 0.4 * Math.cos(angle)) / 111_139,
          lng: center.lng + (radiusM * 0.4 * Math.sin(angle)) / (111_139 * Math.cos((center.lat * Math.PI) / 180)),
        };
        const start = performance.now();
        lastLoad = await loadWindow({
          reader, revisionId: opened.revision.id, datasetRevision: finalized.datasetRevision, tileZoom: opened.revision.tileZoom,
          area: { center, radiusM }, request: windowRequestSchema.parse({ position: at, travelMarginM: number("travelMarginM", 450) }),
        });
        timings.windowMs.push(Math.round(performance.now() - start));
      }
      const memory = process.memoryUsage();
      print({
        generated: total, stored, tiles: finalized.tiles, maxTileRecords: finalized.maxTileRecords,
        timings: {
          ingestMs: timings.ingestMs,
          ingestRecordsPerSecond: Math.round((stored / Math.max(1, timings.ingestMs)) * 1000),
          finalizeMs: timings.finalizeMs,
          windowColdMs: timings.windowMs[0] ?? null,
          windowWarmMedianMs: timings.windowMs.slice(1).sort((a, b) => a - b)[Math.floor((timings.windowMs.length - 1) / 2)] ?? null,
        },
        lastWindow: lastLoad ? { records: lastLoad.records.length, plan: lastLoad.plan, tiles: lastLoad.tiles } : null,
        cache: tileCache.stats(),
        memoryMb: { rss: Math.round(memory.rss / 1e6), heapUsed: Math.round(memory.heapUsed / 1e6) },
        note: "Synthetic observations for cost measurement only; these numbers say nothing about real coverage.",
      });
      return 0;
    }
    default: {
      console.log(`area-dataset commands:
  plan     --center=lat,lng [--radiusM=11265] [--cellSizeM=1000] [--dailyBudget=2000] [--kinds=WIFI,CELL,BLUETOOTH] [--wifiPerKm2=]
  ingest   --name= --center=lat,lng --radiusM= (--dir=<dir> | --files=a.json,b.json) [--cellScenario=file] [--activate=true] [--tileZoom=15] [--redefine=true]
  fetch    --name= --center=lat,lng --radiusM= [--cellSizeM=1000] [--dailyBudget=2000] [--maxRequests=100] [--kinds=] [--cellScenario=file]
  status   --jobId=
  areas
  activate --name= --revision=
  finalize --name= [--activate=true]
  report   --name= [--revision=] [--deviceIds=a,b] [--positions=lat,lng;lat,lng] [--route=lat,lng;lat,lng] [--arrivals=lat,lng] [--travelMarginM=450]
  window   --name= --at=lat,lng [--travelMarginM=450] [--revision=]
  audit    [--deviceId=] [--limit=25]
  bench    --center=lat,lng [--radiusM=11265] [--records=200000] [--batch=20000] [--tileZoom=15]

WiGLE pages return ${WIGLE_PAGE_SIZE} rows; 'fetch' stops cleanly on the daily allowance and keeps its cursors.`);
      return 0;
    }
  }
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : error);
    await prisma.$disconnect();
    process.exit(2);
  });
