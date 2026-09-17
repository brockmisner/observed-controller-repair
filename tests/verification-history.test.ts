import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { HttpError } from '../src/http/errors.js';
import { recordVerification, readVerificationRecord, VerificationJobs, VERIFICATION_EVENT, type VerificationRecord } from '../src/ops/verificationHistory.js';
import { PLAYER_PACKAGE, UPLOADED_PLAYER_SHA256 } from '../src/ops/playerVerification.js';

const phone = { id: 'phone', tenantId: 'owner', imageId: 'image' };
const completed = { deviceId: phone.id, imageId: phone.imageId, checkedAt: '2026-09-17T22:38:55.000Z', readOnly: true,
  verificationSource: 'DUOPLUS_WORKSPACE_COMMAND', installed: { packageName: PLAYER_PACKAGE,
    versionCode: 1, versionName: '1.0.0', sha256: UPLOADED_PLAYER_SHA256, matchesUploadedApk: true },
  player: null, observation: null, locationError: 'Location unavailable' };
async function checked() {
  return recordVerification(phone, async () => completed, async () => {});
}

test('saved inspection survives serialization, with raw provider output and extra keys removed', async () => {
  let stored = '';
  const result = await recordVerification(phone, async () => ({ ...completed, rawOutput: 'private', token: 'private',
    installed: { ...completed.installed, rawSigningDump: 'private' } }), async value => { stored = JSON.stringify(value); });
  assert.deepEqual(readVerificationRecord(stored, phone), result);
  assert.equal(stored.includes('private'), false);
  assert.equal(result.radios.wifi, 'NOT_OBSERVED');
  assert.equal(result.outcome, 'CHECKED');
});
test('saved records are inaccessible after phone, image or workspace reassignment', async () => {
  const stored = JSON.stringify(await checked());
  for (const identity of [{ ...phone, id: 'other' }, { ...phone, imageId: 'other' }, { ...phone, tenantId: 'other' }]) {
    assert.equal(readVerificationRecord(stored, identity), null);
  }
  assert.equal(readVerificationRecord('{broken', phone), null);
  assert.equal(readVerificationRecord('x'.repeat(12001), phone), null);
});
test('provider failure remains failed after reload and cannot retain an earlier success', async () => {
  let stored = JSON.stringify(await checked());
  const error = new HttpError(502, 'Installed APK checksum was unavailable');
  await assert.rejects(recordVerification(phone, async () => { throw error; }, async record => { stored = JSON.stringify(record); }), error);
  const latest = readVerificationRecord(stored, phone)!;
  assert.equal(latest.outcome, 'FAILED'); assert.equal(latest.installed, null); assert.equal(latest.observation, null);
  assert.equal(latest.error, error.message);
});
test('unexpected failures do not put potentially sensitive exception text in history', async () => {
  let stored: VerificationRecord | undefined;
  await assert.rejects(recordVerification(phone, async () => { throw new Error('token=secret'); }, async record => { stored = record; }));
  assert.equal(JSON.stringify(stored).includes('secret'), false);
});
test('history storage failure prevents claiming a saved result', async () => {
  await assert.rejects(recordVerification(phone, async () => completed, async () => { throw new Error('storage unavailable'); }), /storage unavailable/);
});
test('verification cannot certify inconsistent APK hashes or another image response', async () => {
  for (const value of [{ ...completed, imageId: 'other' }, { ...completed, installed: { ...completed.installed, sha256: 'a'.repeat(64) } }]) {
    let outcome = '';
    await assert.rejects(recordVerification(phone, async () => value, async record => { outcome = record.outcome; }));
    assert.equal(outcome, 'FAILED');
  }
});
test('repeat clicks share one inspection; phones and workspaces stay independent', async () => {
  const jobs = new VerificationJobs(2);
  let finish!: (value: VerificationRecord) => void;
  let calls = 0;
  const work = () => { calls++; return new Promise<VerificationRecord>(resolve => { finish = resolve; }); };
  const a = jobs.run(phone, work), b = jobs.run(phone, work);
  assert.equal(a, b);
  const other = jobs.run({ ...phone, tenantId: 'another' }, checked);
  assert.throws(() => jobs.run({ ...phone, id: 'third' }, checked), /busy/);
  await Promise.resolve(); assert.equal(calls, 1);
  finish(await checked()); await Promise.all([a, b, other]);
  assert.equal((await jobs.run(phone, checked)).outcome, 'CHECKED');
});
test('failed inspections release capacity for an explicit retry', async () => {
  const jobs = new VerificationJobs(1);
  await assert.rejects(jobs.run(phone, async () => { throw new Error('offline'); }));
  assert.equal((await jobs.run(phone, checked)).outcome, 'CHECKED');
});

test('saved phone verification and failure history survive reopening the database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-verification-'));
  const url = `file:${dir}/history.db`;
  const { PrismaClient } = await import('@prisma/client');
  let db = new PrismaClient({ datasources: { db: { url } } });
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)),
      'db', 'push', '--skip-generate', '--schema', fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url))],
    { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    await db.tenant.create({ data: { id: phone.tenantId, name: 'Owner' } });
    const data = { ...phone, campaignEnd: new Date('2026-10-01T00:00:00Z'), anchorLat: 25.78, anchorLng: -80.13,
      currentLat: 25.78, currentLng: -80.13, wifiSsid: 'Existing', wifiBssid: 'aa:bb:cc:dd:ee:00', wifiMac: 'aa:bb:cc:dd:ee:02' };
    await db.device.create({ data });
    await db.device.create({ data: { ...data, id: 'other-phone', imageId: 'other-image' } });
    const save = async (record: VerificationRecord) => {
      await db.deviceEvent.create({ data: { deviceId: phone.id, kind: VERIFICATION_EVENT,
        detail: JSON.stringify(record), createdAt: new Date(record.checkedAt) } });
    };
    await recordVerification(phone, async () => completed, save);
    await assert.rejects(recordVerification(phone, async () => { throw new HttpError(502, 'Phone is offline'); }, save,
      () => new Date('2026-09-17T23:00:00Z')));
    await db.$disconnect();
    db = new PrismaClient({ datasources: { db: { url } } });
    const history = await db.deviceEvent.findMany({ where: { deviceId: phone.id, kind: VERIFICATION_EVENT }, orderBy: { createdAt: 'desc' } });
    assert.equal(history.length, 2);
    assert.equal(readVerificationRecord(history[0].detail, phone)?.outcome, 'FAILED');
    assert.equal(readVerificationRecord(history[1].detail, phone)?.installed?.matchesUploadedApk, true);
    assert.equal(await db.deviceEvent.count({ where: { deviceId: 'other-phone' } }), 0);
    assert.equal(readVerificationRecord(history[0].detail, { ...phone, tenantId: 'another' }), null);
  } finally { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
});
