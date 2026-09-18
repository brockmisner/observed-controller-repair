import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { RadioEngine } from "../src/radio/engine.js";
import { radioRecordSchema, recordKey, type RadioRecord } from "../src/radio/schema.js";
import { eutraFrequencyMHz, nrFrequencyMHz } from "../src/coverage/arfcn.js";
import { assertEligibleCarrierCoverage, carrierIdentity, eligibleCells, DEVICE_CARRIER_DEFAULTS } from "../src/coverage/carrier.js";
import { corridorCoverage, corridorRequestSchema } from "../src/coverage/corridor.js";
import { auditDataset, mergeAudits, parseDataset } from "../src/coverage/inventory.js";
import { planAreaIngest, planQueryCells, WIGLE_PAGE_SIZE } from "../src/coverage/ingestPlan.js";
import { observationConfidence, isRotatingBleIdentity, observationSchema } from "../src/coverage/observation.js";
import { classifyResponse, normalizeWigleRows, parseCellKey } from "../src/coverage/wigleRows.js";
import { usability, ENGINE_OBSERVATION_LIMIT } from "../src/coverage/usability.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const now = Date.parse("2026-09-18T12:00:00.000Z");
const position = { lat: 25.777, lng: -80.1365 };
const wifi = radioRecordSchema.parse({ ...position, kind: "WIFI", identifier: "aa:00:00:00:00:01", ssid: "AP", frequencyMHz: 2412, lastSeen: "2026-06-01T00:00:00.000Z", qos: 7 });
const cellPropagation = { referenceDbm: -65, referenceDistanceM: 100, exponent: 3, referenceFrequencyMHz: 1800 };
const cell = radioRecordSchema.parse({
  ...position, kind: "CELL", identifier: "310260_33027_222912800", frequencyMHz: 2110,
  cell: { rat: "LTE", mcc: "310", mnc: "260", areaCode: 33027, cellId: 222912800 }, propagation: cellPropagation,
});

test("usability mirrors exactly what the radio engine will skip", () => {
  const missingFrequency = radioRecordSchema.parse({ ...wifi, frequencyMHz: null });
  const engineFrame = new RadioEngine([missingFrequency], {
    tenantId: "t", imageId: "phone", sessionId: "11111111-1111-4111-8111-111111111111", datasetRevision: "d:1", mcc: "310", mnc: "260",
  }).frame(position, 0, 0);
  assert.equal(engineFrame.wifi.length, 0);
  assert.deepEqual(usability(missingFrequency).missing, ["FREQUENCY_MHZ"]);
  assert.equal(usability(wifi).usable, true);
  assert.deepEqual(usability(radioRecordSchema.parse({ ...cell, cell: null, propagation: null })).missing, ["CELL_IDENTITY", "PROPAGATION"]);
});

test("a saved dataset audit counts unusable rows and rows the schema now rejects", () => {
  const parsed = parseDataset([wifi, cell, { kind: "WIFI", identifier: "bad" }, { ...wifi, identifier: "aa:00:00:00:00:01" }]);
  assert.equal(parsed.invalid, 1);
  assert.deepEqual(parsed.duplicateIdentities, [recordKey(wifi)]);
  const audit = auditDataset(parsed, now);
  assert.equal(audit.byKind.WIFI.usable, 2);
  assert.equal(audit.capacity.limit, ENGINE_OBSERVATION_LIMIT);
  const merged = mergeAudits(audit, audit);
  assert.equal(merged.totalRecords, audit.totalRecords * 2);
  assert.equal(merged.byKind.CELL.records, audit.byKind.CELL.records * 2);
});

test("carrier identity separates configuration from observation and never invents a serving cell", () => {
  const device = {
    id: "device-a", imageId: "N5YK6", mcc: DEVICE_CARRIER_DEFAULTS.mcc, mnc: DEVICE_CARRIER_DEFAULTS.mnc,
    operator: "T-Mobile USA", carrierLocked: true, cellLocked: true, cellRadio: "LTE",
    lac: DEVICE_CARRIER_DEFAULTS.lac, cid: DEVICE_CARRIER_DEFAULTS.cid, wigleCellQueriedAt: null,
    proxyIsp: null, proxyKind: null, proxyAsn: null, imsi: "310260123456789", iccid: null,
  };
  const identity = carrierIdentity(device, { checkedAt: "2026-09-17T23:18:24.000Z", cell: "NOT_OBSERVED", wifi: "NOT_OBSERVED", bluetooth: "NOT_OBSERVED" });
  assert.equal(identity.identitySource, "DEVICE_CONFIGURATION");
  assert.equal(identity.identityBasis, "MATCHES_SCHEMA_DEFAULT");
  assert.equal(identity.observedConfirmation, "NOT_OBSERVED");
  assert.equal(identity.profileCellLock.provenance, "MATCHES_SCHEMA_DEFAULT");
  const withProxy = carrierIdentity({ ...device, proxyIsp: "Comcast", proxyKind: "residential" });
  assert.equal(withProxy.identityBasis, "PROXY_ISP_DERIVED_OR_GEO_FALLBACK");

  const summary = eligibleCells([cell], identity);
  assert.equal(summary.usableForModel, 1);
  assert.doesNotThrow(() => assertEligibleCarrierCoverage(summary, "miami-beach:1"));
  const foreign = eligibleCells([radioRecordSchema.parse({ ...cell, cell: { ...cell.cell!, mnc: "410" } })], identity);
  assert.equal(foreign.usableForModel, 0);
  assert.deepEqual(foreign.otherPlmns, [{ plmn: "310-410", records: 1 }]);
  assert.throws(() => assertEligibleCarrierCoverage(foreign, "miami-beach:1"), /no eligible serving cell/);
  const incomplete = eligibleCells([radioRecordSchema.parse({ ...cell, propagation: null })], identity);
  assert.throws(() => assertEligibleCarrierCoverage(incomplete, "miami-beach:1"), /PROPAGATION/);
});

test("corridor coverage shows gaps, edges and arrival points instead of one total", () => {
  const request = corridorRequestSchema.parse({
    route: [position, { lat: 25.777, lng: -80.1275 }],
    sampleSpacingM: 250,
    arrivals: [{ label: "salon", lat: 25.777, lng: -80.1275 }],
  });
  const report = corridorCoverage({ records: [wifi, cell], request, plmn: { mcc: "310", mnc: "260" }, area: { center: position, radiusM: 500 }, now });
  assert.ok(report.samples.length > 3);
  assert.equal(report.edges.start.wifi.audible, 1);
  assert.equal(report.edges.end.wifi.audible, 0);
  assert.ok(report.gaps.some((gap) => gap.kind === "WIFI" && gap.toM === report.route.lengthM));
  assert.equal(report.arrivals[0]!.wifi.audible, 0);
  assert.ok(report.outsideArea.samples > 0);
  assert.equal(report.worst.samplesWithoutWifi > 0, true);
});

test("WiGLE responses are classified, including the daily-limit refusal and an empty page", () => {
  const wifiPage = classifyResponse(fixture("wigle-wifi-page.json"));
  assert.equal(wifiPage.kind, "SEARCH");
  assert.equal(wifiPage.page.totalResults, 294975645);
  assert.equal(wifiPage.page.searchAfter, "244");
  const limited = classifyResponse(fixture("wigle-rate-limited.json"));
  assert.equal(limited.kind, "RATE_LIMITED");
  assert.match(limited.message ?? "", /too many queries/);
  // The commercial-token refusal also means "cannot query now" and must pause rather than fail an ingest.
  assert.equal(classifyResponse({ success: false, message: "Insufficient balance for commercial query" }).kind, "RATE_LIMITED");
  assert.equal(classifyResponse({ success: false, message: "malformed search" }).kind, "ERROR");
  const empty = classifyResponse(fixture("wigle-empty.json"));
  assert.equal(empty.kind, "SEARCH");
  assert.equal(empty.empty, true);
  const aggregate = classifyResponse(fixture("wigle-aggregate.json"));
  assert.equal(aggregate.kind, "AGGREGATE");
  assert.deepEqual(aggregate.origin, { lat: 25.784025, lng: -80.136606 });
  assert.equal(aggregate.radiusKm, 1.5);
});

test("real Wi-Fi rows keep frequency, dates, qos and transid, and multicast BSSIDs are refused", () => {
  const result = normalizeWigleRows(classifyResponse(fixture("wigle-wifi-page.json")).rows, { source: "wifi-page", now });
  assert.equal(result.byKind.WIFI, 2);
  assert.equal(result.rejected.MULTICAST_BSSID, 1);
  const [first, second] = result.records;
  assert.equal(first!.frequencyMHz, 5805);
  assert.equal(first!.frequencySource, "SOURCE");
  assert.equal(first!.transid, "20230409-00000");
  assert.equal(first!.qos, 7);
  assert.equal(first!.lastSeen, "2026-01-04T06:00:00.000Z");
  assert.equal(first!.lastUpdated, "2026-01-11T15:00:00.000Z");
  assert.equal(second!.frequencyMHz, 2437);
  assert.equal(second!.frequencySource, "DERIVED_WIFI_CHANNEL");
});

test("cell identity is parsed from the WiGLE key, with the two-digit MNC ambiguity reported", () => {
  assert.deepEqual(parseCellKey("310410_27128_238115753"), { mcc: "310", mnc: "410", areaCode: 27128, cellId: 238115753, mncDigits: 3, ambiguousMnc: false });
  assert.equal(parseCellKey("31048_37889_114886668")?.ambiguousMnc, true);
  assert.equal(parseCellKey("not-a-cell"), null);
});

test("cellular rows become model-usable only for LTE/NR with a channel and a declared scenario", () => {
  const rows = classifyResponse(fixture("wigle-cell-page.json")).rows;
  const plain = normalizeWigleRows(rows, { source: "cell-page", now });
  assert.equal(plain.cellIdentity.parsed, 5);
  assert.equal(plain.unsupportedRat.WCDMA, 1, "an HSPA row is real coverage the LTE/NR model cannot use");
  assert.equal(plain.unsupportedRat.CDMA, 1);
  assert.equal(plain.cellIdentity.ambiguousMnc, 1, "a five-digit PLMN prefix leaves the MNC length ambiguous");
  assert.equal(plain.ratDisagreements >= 1, true, "gentype disagrees with attributes/type on real rows");
  assert.equal(plain.cellIdentity.withDerivedFrequency, 3);
  assert.equal(plain.records.filter((record) => record.cell !== null && record.cell !== undefined).length, 3);
  // Identity plus a derived frequency is still not enough: the engine also needs propagation.
  assert.equal(plain.records.every((record) => usability(record).usable === false), true);

  const scenario = {
    name: "miami-beach-lte", declaredBy: "operator",
    propagation: { referenceDbm: -70, referenceDistanceM: 100, exponent: 3.2, referenceFrequencyMHz: 2110 },
  };
  const withScenario = normalizeWigleRows(rows, { source: "cell-page", scenario, now });
  const usable = withScenario.records.filter((record) => usability(record).usable);
  assert.equal(usable.length, 3);
  assert.equal(usable.every((record) => record.propagationSource?.startsWith("SCENARIO:miami-beach-lte")), true);
  assert.equal(usable.every((record) => usability(record).unknown.includes("SECTOR_UNKNOWN")), true);
  const identity = { mcc: "310", mnc: "260" };
  assert.equal(eligibleCells(withScenario.records as RadioRecord[], identity).usableForModel, 2);
});

test("aggregated area fetches are ingestible and BLE rows stay marked as rotating identities", () => {
  const classified = classifyResponse(fixture("wigle-aggregate.json"));
  const result = normalizeWigleRows(classified.rows, { source: "airgrid", area: { center: classified.origin!, radiusM: 1500 }, now });
  assert.deepEqual(result.byKind, { WIFI: 1, CELL: 1, BLUETOOTH: 1 });
  const bluetooth = result.records.find((record) => record.kind === "BLUETOOTH")!;
  assert.equal(isRotatingBleIdentity(bluetooth), true);
  assert.equal(bluetooth.bluetooth?.manufacturerId, 76);
  assert.equal(bluetooth.transid, "20250301-00000");
});

test("rows outside the service area are counted, not stored", () => {
  const classified = classifyResponse(fixture("wigle-wifi-page.json"));
  const result = normalizeWigleRows(classified.rows, { source: "wifi-page", area: { center: { lat: 26, lng: -80 }, radiusM: 500 }, now });
  assert.equal(result.records.length, 0);
  assert.equal(result.outsideRadius, 3);
});

test("channel numbers convert through the fixed 3GPP rasters only", () => {
  assert.equal(eutraFrequencyMHz(2050)?.frequencyMHz, 2120);
  assert.equal(eutraFrequencyMHz(2050)?.band, 4);
  assert.equal(eutraFrequencyMHz(66786)?.band, 66);
  assert.equal(eutraFrequencyMHz(999999), null);
  assert.equal(nrFrequencyMHz(502110)?.frequencyMHz, 2510.55);
  assert.equal(nrFrequencyMHz(-1), null);
});

test("confidence uses source qos and the last sighting, and reports catalogue freshness separately", () => {
  const fresh = observationSchema.parse({ ...wifi, qos: 7, lastSeen: "2026-06-01T00:00:00.000Z", lastUpdated: "2026-06-02T00:00:00.000Z" });
  const stale = observationSchema.parse({ ...wifi, qos: 2, lastSeen: "2018-04-02T21:00:00.000Z", lastUpdated: "2022-12-11T08:00:00.000Z" });
  const unknown = observationSchema.parse({ ...wifi, qos: null, lastSeen: null });
  assert.equal(observationConfidence(fresh, now).tier, "STRONG");
  assert.equal(observationConfidence(stale, now).tier, "WEAK");
  assert.ok(observationConfidence(stale, now).reasons.includes("CATALOGUE_UPDATED_AFTER_LAST_SIGHTING"));
  assert.equal(observationConfidence(unknown, now).tier, "UNKNOWN");
});

test("an area ingest plan states its query cost and refuses to treat corpus totals as area capacity", () => {
  const plan = planAreaIngest({ center: position, radiusM: 11265, cellSizeM: 1000, dailyQueryBudget: 2000 });
  assert.equal(plan.radiusMiles, 7);
  assert.ok(plan.cells.length > 300 && plan.cells.length < 500);
  assert.ok(plan.estimate.totalQueries > plan.cells.length);
  assert.equal(plan.estimate.daysAtBudget >= 1, true);
  assert.ok(plan.estimate.assumptionsUnverified.some((note) => note.includes("unbounded query")));
  assert.equal(WIGLE_PAGE_SIZE, 100);
  const small = planQueryCells(position, 600, 500);
  assert.ok(small.every((cell) => cell.distanceFromCentreM <= 600 + 500));
});
