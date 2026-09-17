import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';

// Real SQLite transactions and lifecycle code; only the external provider is replaced.
const directory = mkdtempSync(join(tmpdir(), 'gps-dispatch-test-'));
process.env.DATABASE_URL = `file:${directory}/test.db`;
process.env.NODE_ENV = 'test';
process.env.DRY_RUN = 'false';
process.env.LOG_LEVEL = 'silent';
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)),
  'db', 'push', '--skip-generate', '--schema', fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url))],
{ env: process.env, stdio: 'pipe' });
const { prisma } = await import('../src/db.js');
const telemetry = await import('../src/ops/locationTelemetry.js');
const { config } = await import('../src/config.js');
const { HttpError } = await import('../src/http/errors.js');
const rejection = await import('../src/api/gpsRejectionReason.js');
const geography = await import('../src/geo/haversine.js');
const pacing = await import('../src/orchestrator/locationPacing.js');
const { logger } = await import('../src/logger.js');
after(async () => { await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true }); });
await prisma.tenant.create({ data: { id: 'gps-tests', name: 'GPS tests' } });

type Provider = (payloads: Array<{ imageId: string }>) => Promise<unknown>;
let provider: Provider;
const dependencies: Record<string, unknown> = {
  '../api/duoPlusClient.js': { modifyDeviceBatch: async (payloads: Array<{ imageId: string }>, _tenant: string, beforeSend: () => Promise<void>) => {
    await beforeSend(); return provider(payloads);
  } },
  '../api/gpsRejectionReason.js': rejection, '../config.js': { config }, '../db.js': { prisma },
  '../geo/haversine.js': geography, '../http/errors.js': { HttpError }, '../logger.js': { logger },
  '../ops/locationTelemetry.js': telemetry, './locationPacing.js': pacing,
};
const exports: Record<string, any> = {};
const compiled = ts.transpileModule(readFileSync(new URL('../src/orchestrator/locationDispatch.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(compiled, { exports, require(name: string) {
  if (!(name in dependencies)) throw new Error(`Unexpected dependency: ${name}`);
  return dependencies[name];
}, Date, performance, Set, Map });
const dispatchGps = exports.dispatchGps as typeof import('../src/orchestrator/locationDispatch.js').dispatchGps;

async function phone(id: string) {
  return prisma.device.create({ data: { id, tenantId: 'gps-tests', imageId: id, active: true,
    anchorLat: 25, anchorLng: -80, currentLat: 25, currentLng: -80,
    phase: 'NAVIGATING', transitMode: 'walk', routeProgressM: 95, polylineJson: 'route',
    campaignEnd: new Date(Date.now() + 86400000), poweredOn: true, duoPlusStatus: 1, lastPowerSyncAt: new Date(),
    wifiSsid: 'Existing', wifiBssid: 'aa:bb:cc:dd:ee:00', wifiMac: 'aa:bb:cc:dd:ee:02' } });
}
const arrival = (device: Awaited<ReturnType<typeof phone>>) => ({ device,
  proposed: { ...device, currentLat: 25.000045, phase: 'STATIONARY', transitMode: null, routeProgressM: 100, lastSpeedMps: 0 } });

test('a rejected final GPS point retains the accepted position and remains eligible for navigation', async () => {
  const device = await phone('rejected');
  provider = async () => ({ success: [], fail: [device.imageId] });
  const [record] = await dispatchGps([arrival(device)], 'JITTER');
  const saved = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
  assert.equal(record.status, 'API_REJECTED');
  assert.equal(saved.currentLat, 25);
  assert.equal(saved.routeProgressM, 95);
  assert.equal(saved.phase, 'NAVIGATING');
  assert.equal(saved.active, true);
  assert.equal(await prisma.telemetryTick.count({ where: { deviceId: device.id } }), 0);
});

test('accepted GPS positions advance only after provider acceptance, including mixed batch results', async () => {
  const accepted = await phone('accepted'), rejected = await phone('mixed-rejected');
  provider = async () => {
    assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: accepted.id } })).currentLat, 25);
    assert.equal(await prisma.telemetryTick.count({ where: { deviceId: accepted.id } }), 0);
    return { success: [accepted.imageId], fail: [rejected.imageId] };
  };
  const records = await dispatchGps([arrival(accepted), arrival(rejected)], 'JITTER');
  const saved = await prisma.device.findUniqueOrThrow({ where: { id: accepted.id } });
  assert.equal(records.find(r => r.deviceId === accepted.id)?.status, 'API_ACCEPTED');
  assert.equal(saved.currentLat, 25.000045);
  assert.equal(saved.phase, 'STATIONARY');
  assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: rejected.id } })).phase, 'NAVIGATING');
  assert.equal(await prisma.telemetryTick.count({ where: { deviceId: accepted.id } }), 1);
});

test('a lost or ambiguous GPS response pauses legacy movement without pretending it arrived', async () => {
  for (const ambiguous of [true, false]) {
    const device = await phone(`unknown-${ambiguous}`);
    provider = async () => { if (!ambiguous) throw new Error('Lost response'); return {}; };
    if (ambiguous) await dispatchGps([arrival(device)], 'JITTER');
    else await assert.rejects(dispatchGps([arrival(device)], 'JITTER'), /Lost response/);
    const saved = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
    const record = await prisma.locationRequest.findFirstOrThrow({ where: { deviceId: device.id } });
    assert.equal(record.status, 'UNCONFIRMED');
    assert.equal(saved.currentLat, 25);
    assert.equal(saved.phase, 'NAVIGATING');
    assert.equal(saved.active, false);
  }
});

test('late acceptance keeps its evidence but cannot overwrite a newer operator position', async () => {
  const device = await phone('concurrent-edit');
  provider = async () => {
    await prisma.device.update({ where: { id: device.id }, data: { currentLat: 26, anchorLat: 26, active: false } });
    return { success: [device.imageId], fail: [] };
  };
  const [record] = await dispatchGps([arrival(device)], 'JITTER');
  assert.equal(record.status, 'API_ACCEPTED');
  const saved = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
  assert.equal(saved.currentLat, 26);
  assert.equal(saved.active, false);
  assert.equal(await prisma.telemetryTick.count({ where: { deviceId: device.id } }), 0);
});

test('a failure persisting accepted movement rolls back acceptance and pauses the uncertain legacy dispatch', async () => {
  const device = await phone('write-failure');
  await prisma.$executeRawUnsafe(`CREATE TRIGGER fail_gps_tick BEFORE INSERT ON TelemetryTick
    WHEN NEW.deviceId = 'write-failure' BEGIN SELECT RAISE(ABORT, 'forced GPS storage failure'); END`);
  provider = async () => ({ success: [device.imageId], fail: [] });
  await assert.rejects(dispatchGps([arrival(device)], 'JITTER'));
  const saved = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
  const record = await prisma.locationRequest.findFirstOrThrow({ where: { deviceId: device.id } });
  assert.equal(record.status, 'UNCONFIRMED');
  assert.equal(record.acceptedAt, null);
  assert.equal(saved.currentLat, 25);
  assert.equal(saved.routeProgressM, 95);
  assert.equal(saved.active, false);
});

test('a stale preflight cannot dispatch after the physical image changed', async () => {
  const device = await phone('identity-change');
  await prisma.device.update({ where: { id: device.id }, data: { imageId: 'replacement-image' } });
  let calls = 0;
  provider = async () => { calls++; return { success: [device.imageId], fail: [] }; };
  await assert.rejects(dispatchGps([arrival(device)], 'JITTER'));
  assert.equal(calls, 0);
  assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).currentLat, 25);
});

test('an older response cannot replace a more recently dispatched location', async () => {
  const device = await phone('newer-dispatch');
  provider = async () => {
    const prior = await prisma.locationRequest.findFirstOrThrow({ where: { deviceId: device.id } });
    await prisma.locationRequest.create({ data: { id: 'newer-location-request', deviceId: device.id,
      tenantId: device.tenantId, imageId: device.imageId, source: 'JITTER', lat: 25.00002, lng: -80,
      requestedAt: new Date(), dispatchedAt: new Date(prior.dispatchedAt!.getTime() + 1), status: 'DISPATCHED' } });
    return { success: [device.imageId], fail: [] };
  };
  const records = await dispatchGps([arrival(device)], 'JITTER');
  assert.equal(records[0].status, 'API_ACCEPTED');
  assert.equal((await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).currentLat, 25);
});
