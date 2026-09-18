import test from "node:test";
import assert from "node:assert/strict";
import { radioRecordSchema, recordKey, type RadioRecord } from "../src/radio/schema.js";
import { haversineMeters } from "../src/geo/haversine.js";
import { TileCache } from "../src/coverage/datasetCache.js";
import { tileBounds, tileFor, tileIntersectsCircle, tilesWithin } from "../src/coverage/tiles.js";
import { loadWindow, MIN_TRAVEL_MARGIN_M, planWindow, windowRequestSchema, type TileReader } from "../src/coverage/window.js";
import type { Kind } from "../src/coverage/inventory.js";

const zoom = 15;
const center = { lat: 25.784025, lng: -80.136606 };

function wifiAt(lat: number, lng: number, index: number): RadioRecord {
  const octet = (value: number) => (value & 255).toString(16).padStart(2, "0");
  return radioRecordSchema.parse({
    kind: "WIFI", identifier: `aa:${octet(index >> 16)}:${octet(index >> 8)}:${octet(index)}:00:01`,
    ssid: `net-${index}`, lat, lng, frequencyMHz: 2412, qos: 6, lastSeen: "2026-06-01T00:00:00.000Z",
  });
}

function cellAt(lat: number, lng: number, index: number): RadioRecord {
  return radioRecordSchema.parse({
    kind: "CELL", identifier: `310260_1_${index}`, lat, lng, frequencyMHz: 2145,
    cell: { rat: "LTE", mcc: "310", mnc: "260", areaCode: 1, cellId: index },
    propagation: { referenceDbm: -70, referenceDistanceM: 100, exponent: 3.2, referenceFrequencyMHz: 2110 },
  });
}

/** Tile reader over an in-memory dataset, tiled the same way the store tiles it. */
function fakeReader(records: readonly RadioRecord[], options: { onRead?: (kind: Kind, keys: string[]) => void } = {}): TileReader {
  const tiles = new Map<string, RadioRecord[]>();
  for (const record of records) {
    const key = `${record.kind}|${tileFor({ lat: record.lat, lng: record.lng }, zoom).key}`;
    tiles.set(key, [...(tiles.get(key) ?? []), record]);
  }
  return {
    async read(_revisionId, kind, tileKeys) {
      options.onRead?.(kind, tileKeys);
      return tileKeys.flatMap((tileKey) => {
        const found = tiles.get(`${kind}|${tileKey}`);
        return found ? [{ tileKey, records: found }] : [];
      });
    },
  };
}

test("tile lookup covers every tile that can hold an in-radius record, including across a tile edge", () => {
  const tile = tileFor(center, zoom);
  const bounds = tileBounds(zoom, tile.x, tile.y);
  const justInsideEdge = { lat: bounds.minLat + 1e-7, lng: center.lng };
  const neighbour = tileFor({ lat: bounds.minLat - 1e-6, lng: center.lng }, zoom);
  assert.notEqual(neighbour.key, tile.key);
  const keys = tilesWithin(justInsideEdge, 200, zoom).map((ref) => ref.key);
  assert.ok(keys.includes(tile.key));
  assert.ok(keys.includes(neighbour.key), "a phone on a tile edge must load the neighbouring tile");
  assert.equal(tileIntersectsCircle(tile, { lat: center.lat + 1, lng: center.lng }, 100), false);
});

test("tile lookup handles the anti-meridian without dropping tiles", () => {
  const near = { lat: 0, lng: 179.9995 };
  const keys = tilesWithin(near, 300, zoom).map((ref) => ref.key);
  const across = tileFor({ lat: 0, lng: -179.9995 }, zoom);
  assert.ok(keys.includes(across.key));
});

test("a window keeps the engine's own radii and trades travel margin for the record budget", () => {
  const neighbours = Array.from({ length: 400 }, (_, index) => ({
    record: wifiAt(center.lat, center.lng, index),
    distanceM: index,
    kind: "WIFI" as const,
  }));
  const request = windowRequestSchema.parse({ position: center, travelMarginM: 450, budget: 200 });
  const plan = planWindow(neighbours, request);
  assert.equal(plan.status, "MARGIN_REDUCED");
  assert.ok(plan.travelMarginM < 450 && plan.travelMarginM >= MIN_TRAVEL_MARGIN_M);
  assert.equal(plan.servedRadiusM.wifiM, request.radii.wifiM + plan.travelMarginM);
  assert.ok(plan.servedRadiusM.wifiM > request.radii.wifiM, "the served radius never drops below the model's reception radius");
  assert.ok(plan.records <= 200);
  assert.equal(plan.reloadAfterM, plan.travelMarginM);

  const dense = Array.from({ length: 5000 }, (_, index) => ({ record: wifiAt(center.lat, center.lng, index), distanceM: 10, kind: "WIFI" as const }));
  const impossible = planWindow(dense, windowRequestSchema.parse({ position: center, travelMarginM: 450, budget: 1000 }));
  assert.equal(impossible.status, "DENSITY_EXCEEDS_WINDOW");
});

test("loading a window reads only nearby tiles and returns a bounded, deduplicated record set", async () => {
  const near = Array.from({ length: 30 }, (_, index) => wifiAt(center.lat + index * 1e-5, center.lng, index));
  const far = Array.from({ length: 30 }, (_, index) => wifiAt(center.lat + 0.05, center.lng + 0.05, 1000 + index));
  const cells = [cellAt(center.lat + 0.01, center.lng, 1), cellAt(center.lat + 0.2, center.lng, 2)];
  const reads: Array<{ kind: Kind; keys: number }> = [];
  const reader = fakeReader([...near, ...far, ...cells], { onRead: (kind, keys) => reads.push({ kind, keys: keys.length }) });
  const cache = new TileCache(100_000);
  const load = await loadWindow({
    reader, revisionId: "rev-1", datasetRevision: "area:1", tileZoom: zoom, cache,
    request: windowRequestSchema.parse({ position: center, travelMarginM: 450 }),
    area: { center, radiusM: 11265 },
  });
  assert.ok(load.records.length > 0);
  assert.equal(load.records.every((record) => haversineMeters(center.lat, center.lng, record.lat, record.lng) <= load.plan.servedRadiusM.cellM), true);
  assert.equal(load.records.some((record) => record.lat === center.lat + 0.05), false, "records outside the served radius are not loaded");
  assert.equal(new Set(load.records.map(recordKey)).size, load.records.length);
  assert.equal(load.counts.CELL.records, 1, "only the cell inside the cell radius is served");
  assert.ok(reads.length > 0);

  const cached = await loadWindow({
    reader, revisionId: "rev-1", datasetRevision: "area:1", tileZoom: zoom, cache,
    request: windowRequestSchema.parse({ position: center, travelMarginM: 450 }),
  });
  assert.equal(cached.tiles.cacheMisses, 0, "a second phone in the same neighbourhood reuses the shared tiles");
  assert.ok(cache.stats().hits > 0);
});

test("cached tiles are frozen and keyed per revision, so a refresh cannot change a pinned run", async () => {
  const records = [wifiAt(center.lat, center.lng, 1)];
  const cache = new TileCache(1000);
  const reader = fakeReader(records);
  const first = await loadWindow({
    reader, revisionId: "rev-1", datasetRevision: "area:1", tileZoom: zoom, cache,
    request: windowRequestSchema.parse({ position: center }),
  });
  assert.throws(() => { (first.records[0] as { ssid: string }).ssid = "tampered"; });
  const replacement = fakeReader([wifiAt(center.lat, center.lng, 1)].map((record) => radioRecordSchema.parse({ ...record, ssid: "refreshed" })));
  const pinned = await loadWindow({
    reader: replacement, revisionId: "rev-1", datasetRevision: "area:1", tileZoom: zoom, cache,
    request: windowRequestSchema.parse({ position: center }),
  });
  assert.equal(pinned.records[0]!.ssid, "net-1", "revision 1 keeps its own view after a refresh is prepared");
  const refreshed = await loadWindow({
    reader: replacement, revisionId: "rev-2", datasetRevision: "area:2", tileZoom: zoom, cache,
    request: windowRequestSchema.parse({ position: center }),
  });
  assert.equal(refreshed.records[0]!.ssid, "refreshed");
  cache.dropRevision("rev-1");
  assert.equal(cache.stats().tiles > 0, true);
});

test("a window at the service-area edge says so instead of reporting thin coverage as real", async () => {
  const area = { center, radiusM: 1000 };
  const edge = { lat: center.lat + 0.0089, lng: center.lng };
  const load = await loadWindow({
    reader: fakeReader([wifiAt(edge.lat, edge.lng, 1)]), revisionId: "rev-1", datasetRevision: "area:1", tileZoom: zoom,
    cache: new TileCache(1000), request: windowRequestSchema.parse({ position: edge }), area,
  });
  assert.ok(load.warnings.some((warning) => /service.area edge/.test(warning)), load.warnings.join(" | "));
});
