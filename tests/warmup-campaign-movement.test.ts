import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'warmup-move-'));
process.env.DATABASE_URL = `file:${directory}/test.db`;
process.env.NODE_ENV = 'test';
process.env.DRY_RUN = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.REDIS_PORT = '1';
process.env.REDIS_URL = 'redis://127.0.0.1:1';
process.env.REDIS_PRIVATE_URL = '';
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)),
  'db', 'push', '--skip-generate', '--schema', fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url))],
{ env: process.env, stdio: 'pipe' });

const { prisma } = await import('../src/db.js');
const { redisConnection, producerConnection } = await import('../src/queue/connection.js');
redisConnection.disconnect();
producerConnection.disconnect();
const service = await import('../src/warmup/service.js');
const runner = await import('../src/warmup/runner.js');
const { localParts } = await import('../src/warmup/model.js');
const trips = await import('../src/trips/service.js');
after(async () => { await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

const day = localParts(new Date(), 'UTC').date;
const home = { lat: 25.78, lng: -80.13 };
const poi = { lat: 25.7901, lng: -80.1201 };
let submits = 0;
let powerOffs = 0;
const drives: Array<Record<string, unknown>> = [];

runner.warmupIo.withTripLease = (async (_d: string, _t: string, fn: (lease: { assertOwned: () => Promise<void> }) => Promise<unknown>) => fn({ assertOwned: async () => undefined })) as typeof runner.warmupIo.withTripLease;
service.warmupServiceIo.withTripLease = runner.warmupIo.withTripLease;
runner.warmupIo.checkDevicePower = (async () => ({ poweredOn: true, duoPlusStatus: 1 })) as typeof runner.warmupIo.checkDevicePower;
runner.warmupIo.getDeviceStatus = (async (imageId: string) => {
  const device = await prisma.device.findFirstOrThrow({ where: { imageId } });
  return { id: imageId, gps: { latitude: String(device.currentLat), longitude: String(device.currentLng), type: 2 },
    wifi: { name: 'Current', bssid: 'aa:bb:cc:dd:ee:00', mac: 'aa:bb:cc:dd:ee:02', status: 1 } };
}) as typeof runner.warmupIo.getDeviceStatus;
runner.warmupIo.triggerRpaTask = (async (_i: string, _t: string, _v: unknown, opts: { beforeSend?: () => Promise<void> }) => {
  await opts?.beforeSend?.();
  submits += 1;
  return { message: 'success' };
}) as typeof runner.warmupIo.triggerRpaTask;
runner.warmupIo.warmupProvider = (async (path: string, body: { name?: string; status?: unknown; image_ids?: string[] }) => {
  if (path === 'powerOff') { powerOffs += 1; return { success: [body.image_ids?.[0]] }; }
  if (path !== 'taskList') throw new Error(`Unexpected provider mutation ${path}`);
  if (Array.isArray(body.status)) return { list: [], total: 0 };
  return { list: [{ id: 'provider-' + body.name, name: body.name, status: 0 }], total: 1 };
}) as typeof runner.warmupIo.warmupProvider;
runner.warmupIo.startCampaignDrive = (async (input) => {
  drives.push(input);
  const device = await prisma.device.findFirstOrThrow({ where: { imageId: input.imageId } });
  const trip = await prisma.drivingTrip.create({ data: {
    id: `trip-${input.runId}`, tenantId: input.tenantId, deviceId: device.id, imageId: input.imageId, revision: 'rev-1',
    status: 'RUNNING', routeJson: '{}', optionsJson: '{}', originLat: input.origin.lat, originLng: input.origin.lng, durationMs: 60_000,
    phoneSyncJson: JSON.stringify({ warmup: { campaignId: input.campaignId, runId: input.runId } }),
  } });
  await prisma.device.update({ where: { id: device.id }, data: { activeTripId: trip.id, phase: 'NAVIGATING', poweredOn: true, duoPlusStatus: 1 } });
  return { id: trip.id, status: trip.status, revision: trip.revision };
}) as typeof runner.warmupIo.startCampaignDrive;
runner.warmupIo.readCampaignDrive = (async (_tenant: string, tripId: string) => {
  const trip = await prisma.drivingTrip.findUniqueOrThrow({ where: { id: tripId } });
  return { id: trip.id, status: trip.status, revision: trip.revision };
}) as typeof runner.warmupIo.readCampaignDrive;
runner.warmupIo.pauseCampaignDrive = (async (_tenant: string, tripId: string) => {
  const trip = await prisma.drivingTrip.update({ where: { id: tripId }, data: { status: 'PAUSED' } });
  await prisma.device.updateMany({ where: { activeTripId: tripId }, data: { active: false } });
  return { id: trip.id, status: trip.status, revision: trip.revision };
}) as typeof runner.warmupIo.pauseCampaignDrive;

await prisma.tenant.create({ data: { id: 'a', name: 'A' } });
async function phone(id: string, current = home) {
  return prisma.device.create({ data: {
    id, tenantId: 'a', imageId: id, name: id, campaignEnd: new Date(Date.now() + 86400000 * 50),
    anchorLat: home.lat, anchorLng: home.lng, currentLat: current.lat, currentLng: current.lng,
    poweredOn: true, duoPlusStatus: 1, phase: 'IDLE',
    wifiSsid: 'Existing', wifiBssid: 'aa:bb:cc:dd:ee:00', wifiMac: 'aa:bb:cc:dd:ee:02',
  } });
}
const city = await service.cityCreate('a', { name: 'Miami', timezone: 'UTC', lat: home.lat, lng: home.lng, radiusM: 20000 });
const rpa = { key: 'work', name: 'Work', time: '00:00', templateId: 'custom', preservesProfile: true as const, dependsOn: 'outbound' };
const outbound = { key: 'outbound', name: 'Outbound', time: '00:00', kind: 'DRIVE' as const, destination: poi, preservesProfile: true as const };

test('RPA dispatch keeps durable coordinates instead of snapping to the campaign home', async () => {
  const device = await phone('snap-phone', poi);
  const campaign = await service.campaignCreate('a', {
    name: 'No teleport', deviceId: device.id, cityId: city.id, clientFolder: 'Client',
    lat: home.lat, lng: home.lng, timezone: 'UTC', providerTimezone: 'UTC', startDate: day, durationDays: 30,
    schedule: [{ key: 'daily', name: 'Daily', time: '00:00', templateId: 'custom', preservesProfile: true }],
  });
  await service.campaignAction('a', campaign.id, 'start');
  const before = submits;
  await runner.scanWarmup();
  const saved = await prisma.device.findUniqueOrThrow({ where: { id: device.id } });
  assert.equal(saved.currentLat, poi.lat);
  assert.equal(saved.currentLng, poi.lng);
  assert.equal(saved.anchorLat, home.lat);
  assert.equal(submits, before + 1);
});

test('a campaign owns a drive under its reservation and independent trips stay blocked', async () => {
  const device = await phone('drive-phone', home);
  const campaign = await service.campaignCreate('a', {
    name: 'Owned drive', deviceId: device.id, cityId: city.id, clientFolder: 'Client',
    lat: home.lat, lng: home.lng, timezone: 'UTC', providerTimezone: 'UTC', startDate: day, durationDays: 30,
    schedule: [rpa], movement: [outbound],
  });
  await service.campaignAction('a', campaign.id, 'start');
  await assert.rejects(trips.createTrip('a', { imageId: device.imageId, destination: poi }), /warmup campaign/);
  const before = submits;
  await runner.scanWarmup();
  const move = await prisma.warmupRun.findFirstOrThrow({ where: { campaignId: campaign.id, slotKey: 'outbound' } });
  const work = await prisma.warmupRun.findFirstOrThrow({ where: { campaignId: campaign.id, slotKey: 'work' } });
  assert.equal(move.status, 'RUNNING');
  assert.equal(work.status, 'WAITING');
  assert.equal(submits, before);
  assert.equal(drives.at(-1)?.campaignId, campaign.id);
  assert.equal(drives.at(-1)?.runId, move.id);
  const evidence = JSON.parse(move.evidenceJson ?? '{}');
  assert.equal(evidence.observedApplication, false);
  assert.equal(evidence.stub, false);
  assert.equal(evidence.source, 'CAMPAIGN_DRIVE');
});

test('dependent RPA waits for arrival and expired movement is recorded without burst replay', async () => {
  const device = await phone('window-phone', home);
  const campaign = await service.campaignCreate('a', {
    name: 'Window', deviceId: device.id, cityId: city.id, clientFolder: 'Client',
    lat: home.lat, lng: home.lng, timezone: 'UTC', providerTimezone: 'UTC', startDate: day, durationDays: 30,
    schedule: [rpa], movement: [outbound],
  });
  await service.campaignAction('a', campaign.id, 'start');
  await runner.scanWarmup();
  const move = await prisma.warmupRun.findFirstOrThrow({ where: { campaignId: campaign.id, slotKey: 'outbound' } });
  await prisma.warmupRun.update({ where: { id: move.id }, data: { deadlineAt: new Date(Date.now() - 1000), nextCheckAt: new Date(0) } });
  const work = await prisma.warmupRun.findFirstOrThrow({ where: { campaignId: campaign.id, slotKey: 'work' } });
  await prisma.warmupRun.update({ where: { id: work.id }, data: { deadlineAt: new Date(Date.now() + 60_000) } });
  const before = submits;
  await runner.scanWarmup();
  const suspended = await prisma.warmupRun.findUniqueOrThrow({ where: { id: move.id } });
  const missed = await prisma.warmupRun.findUniqueOrThrow({ where: { id: work.id } });
  assert.equal(suspended.status, 'SUSPENDED_IN_PLACE');
  assert.equal(JSON.parse(suspended.evidenceJson ?? '{}').code, 'WINDOW_EXCEEDED');
  assert.equal(missed.status, 'MISSED');
  assert.equal(submits, before);
  await runner.scanWarmup();
  assert.equal((await prisma.warmupRun.findUniqueOrThrow({ where: { id: work.id } })).status, 'MISSED');
  assert.equal(submits, before);
});

test('auto-power will not shut down a phone that is away from home', async () => {
  const device = await phone('power-phone', poi);
  const campaign = await service.campaignCreate('a', {
    name: 'Power gate', deviceId: device.id, cityId: city.id, clientFolder: 'Client', autoPower: true,
    lat: home.lat, lng: home.lng, timezone: 'UTC', providerTimezone: 'UTC', startDate: day, durationDays: 30,
    schedule: [{ key: 'daily', name: 'Daily', time: '00:00', templateId: 'custom', preservesProfile: true, firstDay: 2, lastDay: 2 }],
  });
  await prisma.warmupCampaign.update({ where: { id: campaign.id }, data: { powerOwned: true, status: 'RUNNING' } });
  const before = powerOffs;
  await runner.scanWarmup();
  assert.equal(powerOffs, before);
  await prisma.device.update({ where: { id: device.id }, data: { currentLat: home.lat, currentLng: home.lng, phase: 'IDLE', activeTripId: null } });
  await runner.scanWarmup();
  assert.equal(powerOffs, before + 1);
});
