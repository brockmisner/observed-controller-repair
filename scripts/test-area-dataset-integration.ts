/**
 * Integration checks for service-area datasets against a temporary SQLite database.
 *
 * Covers the parts that only exist once storage is involved: tiled ingest of real WiGLE response
 * shapes, a rate-limited ingest that resumes without refetching, revision pinning across a refresh,
 * and the pre-execution coverage report for phones sharing one area.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const dir = mkdtempSync(join(tmpdir(), "area-dataset-test-"));
process.env.DATABASE_URL = `file:${dir}/test.db`;
process.env.NODE_ENV = "test";
process.env.REDIS_PORT = "1";
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_PRIVATE_URL = "";
execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "push", "--skip-generate"], { env: { ...process.env }, stdio: "pipe" });

const { prisma } = await import("../src/db.js");
const { redisConnection, producerConnection } = await import("../src/queue/connection.js");
redisConnection.disconnect();
producerConnection.disconnect();

const { ingestSavedResponses, runIngest, startOrResumeIngest, ingestStatus } = await import("../src/coverage/ingestJob.js");
const { resolvePin, prismaTileReader, tileMetadata, verifyTile, listAreas, appendRecords, finalizeRevision, openRevision } = await import("../src/coverage/areaStore.js");
const { areaCoverageReport } = await import("../src/coverage/areaReport.js");
const { loadWindow, windowRequestSchema } = await import("../src/coverage/window.js");
const { tileCache } = await import("../src/coverage/datasetCache.js");

const fixture = (name: string) => readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), "utf8");
const center = { lat: 25.784025, lng: -80.136606 };
const scenario = {
  name: "miami-beach-lte", declaredBy: "integration test",
  propagation: { referenceDbm: -70, referenceDistanceM: 100, exponent: 3.2, referenceFrequencyMHz: 2110 },
};

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

try {
  await prisma.tenant.createMany({ data: [{ id: "a", name: "A" }, { id: "b", name: "B" }] });
  await prisma.device.create({ data: {
    id: "phone-a", tenantId: "a", imageId: "N5YK6", name: "Demo", campaignEnd: new Date(Date.now() + 86_400_000),
    anchorLat: center.lat, anchorLng: center.lng, currentLat: center.lat, currentLng: center.lng,
    wifiSsid: "Existing", wifiBssid: "aa:bb:cc:dd:ee:00", wifiMac: "aa:bb:cc:dd:ee:02",
    mcc: "310", mnc: "260", operator: "T-Mobile USA",
  } });
  await prisma.device.create({ data: {
    id: "phone-b", tenantId: "a", imageId: "K2QQ1", name: "Second", campaignEnd: new Date(Date.now() + 86_400_000),
    anchorLat: center.lat + 0.002, anchorLng: center.lng + 0.002, currentLat: center.lat + 0.002, currentLng: center.lng + 0.002,
    wifiSsid: "Existing", wifiBssid: "aa:bb:cc:dd:ee:10", wifiMac: "aa:bb:cc:dd:ee:12",
    mcc: "311", mnc: "480", operator: "Verizon Wireless",
  } });
  await prisma.device.create({ data: {
    id: "phone-c", tenantId: "a", imageId: "T7BB3", name: "Third", campaignEnd: new Date(Date.now() + 86_400_000),
    anchorLat: 25.7885, anchorLng: -80.1292, currentLat: 25.7885, currentLng: -80.1292,
    wifiSsid: "Existing", wifiBssid: "aa:bb:cc:dd:ee:20", wifiMac: "aa:bb:cc:dd:ee:22",
    mcc: "310", mnc: "410", operator: "AT&T",
  } });

  let revisionOne = "";
  await check("saved WiGLE responses ingest into tiles, with rate-limit and unbounded-query files reported", async () => {
    const result = await ingestSavedResponses(prisma, {
      tenantId: "a", name: "miami-beach", center, radiusM: 11265,
      files: [
        { filename: "wigle-wifi-page.json", contents: fixture("wigle-wifi-page.json") },
        { filename: "wigle-cell-page.json", contents: fixture("wigle-cell-page.json") },
        { filename: "wigle-aggregate.json", contents: fixture("wigle-aggregate.json") },
        { filename: "wigle-empty.json", contents: fixture("wigle-empty.json") },
        { filename: "wigle-rate-limited.json", contents: fixture("wigle-rate-limited.json") },
      ],
      scenario,
      activate: true,
    });
    revisionOne = result.revisionId;
    assert.equal(result.activated, true);
    assert.ok(result.records > 0);
    assert.ok(result.tiles > 0);
    assert.ok(result.warnings.some((warning) => /rate-limit response/.test(warning)), "a rate-limited file must be reported, not silently skipped");
    assert.ok(result.warnings.some((warning) => /unbounded query/.test(warning)), "an unbounded totalResults must be called out");
    assert.ok(result.warnings.some((warning) => /zero results/.test(warning)), "an empty page is absence of coverage, not an error");
    assert.ok(result.warnings.some((warning) => /searchAfter/.test(warning)), "a cursor means the page is partial");
    assert.equal(result.normalization.transidPresent > 0, true, "transid is preserved as provenance");
  });

  await check("pinning serves a complete revision and refuses an incomplete one", async () => {
    const pin = await resolvePin(prisma, "a", { dataset: "miami-beach" });
    assert.equal(pin.datasetRevision, `${pin.datasetId}:1`);
    assert.equal(pin.isActiveRevision, true);
    assert.ok(pin.sources.length >= 4, "every source file stays recorded with the revision");
    assert.ok(pin.audit);
    await assert.rejects(() => resolvePin(prisma, "b", { dataset: "miami-beach" }), /not found/);
    const opened = await openRevision(prisma, { tenantId: "a", name: "miami-beach", center, radiusM: 11265, resume: false });
    await assert.rejects(() => resolvePin(prisma, "a", { dataset: "miami-beach", revision: opened.revision.revision }), /BUILDING/);
    await prisma.areaDatasetRevision.delete({ where: { id: opened.revision.id } });
  });

  await check("tiles re-validate and hash-match after storage", async () => {
    const tiles = await tileMetadata(prisma, revisionOne);
    assert.ok(tiles.length > 0);
    const wifiTile = tiles.find((tile) => tile.kind === "WIFI")!;
    const verified = await verifyTile(prisma, revisionOne, "WIFI", wifiTile.tileKey);
    assert.equal(verified.matches, true);
    assert.equal(verified.invalid, 0);
    assert.equal(verified.revalidated, wifiTile.recordCount);
    const cellTile = tiles.find((tile) => tile.kind === "CELL");
    assert.ok(cellTile && Object.keys(cellTile.plmn).length > 0, "cell tiles carry their PLMN breakdown for carrier checks");
  });

  await check("two phones share one immutable index while filtering to their own carrier", async () => {
    tileCache.reset();
    const pin = await resolvePin(prisma, "a", { dataset: "miami-beach" });
    const reader = prismaTileReader(prisma);
    const first = await loadWindow({
      reader, revisionId: pin.revisionId, datasetRevision: pin.datasetRevision, tileZoom: pin.tileZoom,
      request: windowRequestSchema.parse({ position: center }), area: pin.area,
    });
    const second = await loadWindow({
      reader, revisionId: pin.revisionId, datasetRevision: pin.datasetRevision, tileZoom: pin.tileZoom,
      request: windowRequestSchema.parse({ position: center }), area: pin.area,
    });
    assert.ok(first.records.length > 0);
    assert.equal(second.tiles.cacheMisses, 0, "the second phone reads no tiles from the database");
    assert.equal(tileCache.stats().hits > 0, true);
  });

  await check("a coverage report shows per-phone readiness, carrier source and area holes", async () => {
    const report = await areaCoverageReport(prisma, "a", {
      dataset: "miami-beach",
      phones: [
        { deviceId: "phone-a", position: center, arrivals: [{ label: "salon", lat: center.lat, lng: center.lng }] },
        { deviceId: "phone-b" },
        { deviceId: "phone-c" },
      ],
    });
    assert.equal(report.pin.revision, 1);
    assert.ok(report.tiles.footprintTiles > report.tiles.storedTiles.WIFI, "an area sparsely covered by fixtures must show holes");
    assert.ok(report.tiles.tilesWithoutWifi > 0);
    const [phoneA, phoneB, phoneC] = report.phones;
    assert.equal(phoneA!.carrier.observedConfirmation, "NOT_OBSERVED");
    assert.equal(phoneA!.carrier.identityBasis, "MATCHES_SCHEMA_DEFAULT");
    assert.ok(phoneA!.coverageHere.cell.eligible > 0, "T-Mobile LTE/NR cells with a declared scenario are eligible");
    assert.ok(phoneB!.blocking.some((reason) => /no eligible serving cell/i.test(reason)),
      "a carrier with no stored cell must fail loudly rather than borrow another carrier's cell");
    assert.equal(phoneB!.eligibleCellsInArea.usableForModel, 0);
    assert.ok(phoneB!.eligibleCellsInArea.otherPlmns.length > 0, "the report names the carriers that are present instead");
    assert.ok(phoneC!.coverageHere.cell.eligible > 0, "a second carrier present in the data gets its own cells");
    assert.equal(report.verdict.overall, "NOT_SUPPORTED");
    assert.ok(report.verdict.blocking.some((reason) => reason.startsWith("K2QQ1:")));
  });

  await check("a route report locates the exact distance where coverage runs out", async () => {
    const report = await areaCoverageReport(prisma, "a", {
      dataset: "miami-beach",
      sampleSpacingM: 250,
      phones: [{ deviceId: "phone-a", position: center, route: [center, { lat: center.lat, lng: center.lng + 0.02 }] }],
    });
    const route = report.phones[0]!.route!;
    assert.ok(route.samples > 4);
    assert.ok(route.gaps.some((gap) => gap.kind === "WIFI"), "a route beyond the fixture coverage must show a Wi-Fi gap");
    assert.ok(report.phones[0]!.blocking.some((reason) => /no usable Wi-Fi coverage between/.test(reason)));
  });

  await check("a rate-limited live ingest keeps its cursors and resumes without refetching", async () => {
    const started = await startOrResumeIngest(prisma, "a", {
      name: "resumable-area", center, radiusM: 400, cellSizeM: 500, kinds: ["WIFI"], dailyQueryBudget: 60,
    });
    const page = (index: number) => ({
      success: true, totalResults: 250, resultCount: 100, first: index * 100 + 1, last: index * 100 + 100,
      searchAfter: index < 2 ? String((index + 1) * 100) : null,
      results: Array.from({ length: index < 2 ? 100 : 50 }, (_, row) => ({
        trilat: center.lat + row * 1e-5, trilong: center.lng, ssid: `page-${index}-${row}`,
        netid: `aa:${index.toString(16).padStart(2, "0")}:00:00:${(row >> 8).toString(16).padStart(2, "0")}:${(row & 255).toString(16).padStart(2, "0")}`,
        type: "infra", channel: 6, frequency: 2437, qos: 5,
        firsttime: "2024-01-01T00:00:00.000Z", lasttime: "2026-01-01T00:00:00.000Z", lastupdt: "2026-01-02T00:00:00.000Z",
        transid: "20260101-00000",
      })),
    });
    let call = 0;
    const cursors: Array<string | null> = [];
    const first = await runIngest(prisma, started.job.id, async (input) => {
      cursors.push(input.cursor);
      call++;
      if (call === 1) return page(0);
      return JSON.parse(fixture("wigle-rate-limited.json"));
    }, { maxRequests: 5 });
    assert.equal(first.rateLimited, true);
    assert.equal(first.status, "PAUSED_RATE_LIMIT");
    assert.equal(first.finalized, false);
    assert.ok(first.storedThisRun > 0, "the page fetched before the limit is stored");
    assert.ok(first.warnings.some((warning) => /resume this job/.test(warning)));
    const partial = await prisma.areaIngestUnit.findFirst({ where: { jobId: started.job.id, status: "PARTIAL" } });
    assert.ok(partial?.cursor === "100" || partial?.cursor === null);
    await assert.rejects(() => resolvePin(prisma, "a", { dataset: "resumable-area" }), /no active dataset revision/);

    const resumed = await startOrResumeIngest(prisma, "a", {
      name: "resumable-area", center, radiusM: 400, cellSizeM: 500, kinds: ["WIFI"], dailyQueryBudget: 60,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.revision.id, started.revision.id, "resuming continues the same revision under construction");
    let second = 0;
    const finish = await runIngest(prisma, resumed.job.id, async (input) => {
      cursors.push(input.cursor);
      second++;
      return page(Math.min(2, second));
    }, { maxRequests: 20 });
    assert.equal(finish.status, "COMPLETE");
    assert.equal(finish.finalized, true);
    assert.ok(cursors.some((cursor) => cursor !== null), "a resumed unit continues from its stored searchAfter cursor");
    const status = await ingestStatus(prisma, "a", resumed.job.id);
    assert.equal(status.job.status, "COMPLETE");
    assert.ok(status.units.every((unit) => unit.status === "DONE" || unit.status === "EMPTY"));
    assert.ok(finish.warnings.some((warning) => /not yet active/.test(warning)), "a finished revision is not published implicitly");
  });

  await check("a refresh becomes a new revision and cannot change an active run's world", async () => {
    const pinBefore = await resolvePin(prisma, "a", { dataset: "miami-beach" });
    const refreshed = await openRevision(prisma, { tenantId: "a", name: "miami-beach", center, radiusM: 11265, resume: false });
    await appendRecords(prisma, refreshed.revision.id, [{
      kind: "WIFI", identifier: "aa:00:00:00:00:01", ssid: "Refreshed Net", lat: center.lat, lng: center.lng,
      frequencyMHz: 2412, qos: 7, lastSeen: "2026-09-01T00:00:00.000Z", source: "refresh",
    }]);
    const finalized = await finalizeRevision(prisma, refreshed.revision.id, { activate: false });
    assert.equal(finalized.revision, 2);
    const stillPinned = await resolvePin(prisma, "a", { dataset: "miami-beach", revision: pinBefore.revision });
    assert.equal(stillPinned.datasetRevision, pinBefore.datasetRevision);
    assert.equal((await resolvePin(prisma, "a", { dataset: "miami-beach" })).revision, 1, "the active revision only changes on an explicit activation");
    await prisma.areaDataset.update({ where: { id: pinBefore.datasetId }, data: { activeRevisionId: refreshed.revision.id } });
    assert.equal((await resolvePin(prisma, "a", { dataset: "miami-beach" })).revision, 2);
    const areas = await listAreas(prisma, "a");
    assert.equal(areas.find((area) => area.name === "miami-beach")?.revisions.length, 2);
  });

  await check("geometry changes require an explicit redefine", async () => {
    await assert.rejects(() => openRevision(prisma, { tenantId: "a", name: "miami-beach", center: { lat: 26, lng: -80 }, radiusM: 11265 }), /different centre/);
  });

  console.log(`\n${passed} area dataset integration checks passed`);
} finally {
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
}
