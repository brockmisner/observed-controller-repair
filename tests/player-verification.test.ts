import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { installedPlayerInfo, playerApkPath, inspectPlayerPackage, UPLOADED_PLAYER_SHA256, verifyPlayer } from '../src/ops/playerVerification.js';

test('installed APK fingerprint distinguishes exact bytes from matching version labels', () => {
  const dump = '  versionCode=1 minSdk=29 targetSdk=34\n  versionName=1.0.0\n';
  assert.equal(installedPlayerInfo(dump, `${UPLOADED_PLAYER_SHA256}  /data/app/x/base.apk`).matchesUploadedApk, true);
  assert.equal(installedPlayerInfo(dump, `${'a'.repeat(64)}  /data/app/x/base.apk`).matchesUploadedApk, false);
  assert.throws(() => installedPlayerInfo(dump, 'permission denied'));
  assert.throws(() => installedPlayerInfo('', `${UPLOADED_PLAYER_SHA256}  /data/app/x/base.apk`));
});
test('package inspection accepts one installed base APK and rejects shell metacharacters or multiple paths', () => {
  assert.equal(playerApkPath('package:/data/app/~~abc=/net.stakeout.duomove.player-xyz==/base.apk\n'), '/data/app/~~abc=/net.stakeout.duomove.player-xyz==/base.apk');
  for (const path of ['package:/data/app/x/$(id)/base.apk', 'package:/data/app/x/a;ls/base.apk',
    'package:/sdcard/x/base.apk', 'package:/data/app/x/base.apk\npackage:/data/app/x/split.apk']) assert.throws(() => playerApkPath(path));
});
function harness() {
  let device: { id: string; imageId: string; tenantId: string } | null = { id: 'phone', imageId: 'image', tenantId: 'owner' };
  let reads = 0;
  const deps = {
    getDevice: async () => device,
    otherTenantHasImage: async () => false,
    configuredImage: () => 'image',
    inspect: async () => { reads++; return { checkedAt: 'now', readOnly: true }; },
  };
  return { deps, reads: () => reads, setDevice: (d: typeof device) => { device = d; } };
}
test('phone verification returns the scoped physical identity without modifying the device', async () => {
  const h = harness();
  assert.deepEqual(await verifyPlayer('phone', 'owner', h.deps), { deviceId: 'phone', imageId: 'image', checkedAt: 'now', readOnly: true });
  assert.equal(h.reads(), 1);
});
test('missing auth, another tenant, another phone or shared physical image prevents inspection', async () => {
  for (const scenario of ['auth', 'tenant', 'phone', 'image', 'shared']) {
    const h = harness();
    if (scenario === 'image') h.deps.configuredImage = () => 'elsewhere';
    if (scenario === 'shared') h.deps.otherTenantHasImage = async () => true;
    await assert.rejects(verifyPlayer(scenario === 'phone' ? 'other' : 'phone', scenario === 'auth' ? '' : scenario === 'tenant' ? 'other' : 'owner', h.deps));
    assert.equal(h.reads(), 0);
  }
});
test('reassignment during inspection withholds the old physical phone response', async () => {
  const h = harness();
  h.deps.inspect = async () => { h.setDevice({ id: 'phone', tenantId: 'owner', imageId: 'other' }); return { checkedAt: 'now', readOnly: true }; };
  await assert.rejects(verifyPlayer('phone', 'owner', h.deps), /Device not found/);
});
test('shared assignment uses independently authorized provider inspection and never shared ADB', async () => {
  const h = harness();
  h.deps.otherTenantHasImage = async () => true;
  let authorizationCalls = 0;
  const deps = { ...h.deps, inspectViaProvider: async (image: string, tenant: string) => {
    assert.equal(image, 'image'); assert.equal(tenant, 'owner'); authorizationCalls++;
    return { checkedAt: 'provider', readOnly: true };
  } };
  assert.equal((await verifyPlayer('phone', 'owner', deps)).checkedAt, 'provider');
  assert.equal(authorizationCalls, 1); assert.equal(h.reads(), 0);
  deps.inspectViaProvider = async () => { throw new Error('provider denied access'); };
  await assert.rejects(verifyPlayer('phone', 'owner', deps), /provider denied access/);
  assert.equal(h.reads(), 0);
});
test('provider inspection uses only validated fixed commands and stops on an invalid package path', async () => {
  const commands: string[] = [];
  const value = await inspectPlayerPackage(async command => {
    commands.push(command);
    if (command.startsWith('pm path ')) return 'package:/data/app/x/base.apk';
    if (command.startsWith('dumpsys package ')) return '  versionCode=1 minSdk=29\n  versionName=1.0.0\n';
    return `${UPLOADED_PLAYER_SHA256}  /data/app/x/base.apk`;
  });
  assert.equal(value.matchesUploadedApk, true);
  assert.deepEqual(commands, ['pm path net.stakeout.duomove.player', 'dumpsys package net.stakeout.duomove.player', 'sha256sum /data/app/x/base.apk']);
  let calls = 0;
  await assert.rejects(inspectPlayerPackage(async () => { calls++; return 'package:/data/app/x/$(id)/base.apk'; }));
  assert.equal(calls, 1);
});

const context = { module: { exports: {} as { freshPoint: (...args: any[]) => any } } };
vm.runInNewContext(readFileSync(new URL('../public/phone-readback.js', import.meta.url), 'utf8'), context);
const { freshPoint } = context.module.exports;
const now = Date.parse('2026-09-17T22:00:00Z');
const device = { id: 'phone', imageId: 'image', poweredOn: true, duoPlusStatus: 1 };
const fix = { source: 'RUNTIME_COMMAND', state: 'OBSERVED', provider: 'gps', checkedAt: new Date(now).toISOString(), ageMs: 500,
  point: { lat: 25.77, lng: -80.12 }, mock: true };
const manual = { deviceId: device.id, imageId: device.imageId, observation: fix };
test('map uses fresh Android readback, retains mock labeling and expires with actual fix age', () => {
  assert.equal(freshPoint(device, manual, now).lat, 25.77);
  assert.equal(freshPoint(device, manual, now).mock, true);
  assert.equal(freshPoint(device, manual, now + 29500).ageMs, 30000);
  assert.equal(freshPoint(device, manual, now + 29501), null);
  assert.equal(freshPoint(device, manual, now - 1), null);
});
test('map rejects another device, reassigned image and offline phone', () => {
  assert.equal(freshPoint(device, { ...manual, deviceId: 'other' }, now), null);
  assert.equal(freshPoint(device, { ...manual, imageId: 'other' }, now), null);
  assert.equal(freshPoint({ ...device, poweredOn: false }, manual, now), null);
});
test('map rejects invalid measurements rather than falling back to controller coordinates', () => {
  for (const overrides of [{ state: 'UNKNOWN' }, { ageMs: null }, { ageMs: -1 }, { source: 'MODEL' },
    { provider: 'network' }, { point: { lat: NaN, lng: 5 } }, { point: { lat: 0, lng: 181 } }]) {
    assert.equal(freshPoint(device, { ...manual, observation: { ...fix, ...overrides } }, now), null);
  }
});
test('map consumes trip readback for the correct device, and a newer unknown check clears it', () => {
  const trip = { deviceId: device.id, imageId: device.imageId, phoneSync: { player: { phoneObservation: fix } } };
  assert.equal(freshPoint({ ...device, trip }, null, now).lat, fix.point.lat);
  assert.equal(freshPoint({ ...device, trip: { ...trip, imageId: 'other' } }, null, now), null);
  assert.equal(freshPoint({ ...device, trip }, { ...manual, observation: { ...fix, state: 'UNKNOWN', checkedAt: new Date(now + 1).toISOString() } }, now + 1), null);
});
