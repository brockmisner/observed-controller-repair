import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const directory = mkdtempSync(join(tmpdir(), 'radio-evidence-test-'));
process.env.DATABASE_URL = `file:${directory}/test.db`;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)),
  'db', 'push', '--skip-generate', '--schema', fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url))],
{ env: process.env, stdio: 'pipe' });

const { PrismaRadioEvidenceStore } = await import('../src/radio/evidenceStore.js');
const { prisma } = await import('../src/db.js');
after(async () => { await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('a service restart still has tenant-scoped radio evidence and does not treat the previous session as current', async () => {
  const store = new PrismaRadioEvidenceStore();
  const base = {
    tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a', deviceId: 'device-a',
    instanceId: 'agent-a', datasetRevision: 'city:1', sequence: 0, simElapsedMs: 0, phase: 'MOVING' as const,
    kind: 'RESULT' as const, lifecycle: 'VALIDATED', applied: false, uncertain: false,
    evidenceClass: 'PREPARED_NOT_APPLIED' as const, source: 'LOCAL_PREPARE' as const,
    detail: 'scheduled locally', payload: { sequence: 0 },
  };
  await store.append({ ...base, sessionId: sessionA, bootId: 'boot-a' });
  const afterRestart = new PrismaRadioEvidenceStore();
  await afterRestart.append({ ...base, sessionId: sessionB, bootId: 'boot-b', sequence: 1, simElapsedMs: 1000, detail: 'new session after restart' });

  const current = await afterRestart.current({ tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a', sessionId: sessionB, bootId: 'boot-b' });
  const history = await afterRestart.list({ tenantId: 'workspace-one', imageId: 'phone-a', tripId: 'trip-a' });
  assert.equal(current.length, 1);
  assert.equal(current[0]!.sessionId, sessionB);
  assert.equal(current[0]!.current, true);
  assert.ok(history.some((row) => row.sessionId === sessionA && row.current === false));
  assert.equal((await afterRestart.list({ tenantId: 'workspace-two', imageId: 'phone-a', tripId: 'trip-a' })).length, 0);
  assert.equal((await afterRestart.list({ tenantId: 'workspace-one', imageId: 'phone-b', tripId: 'trip-a' })).length, 0);
  assert.notEqual(randomUUID(), sessionA);
});
