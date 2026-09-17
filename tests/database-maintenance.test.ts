import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const checker = await import('../scripts/check-database-schemas.mjs');
const migration = await import('../scripts/migrate-sites-database.mjs');
import { seedAllModels } from './helpers/database-fixture.mjs';
test('schema comparison ignores formatting/providers but detects actual field and default changes', () => {
  assert.ok(checker, 'the advertised schema checker must exist');
  const a = 'datasource db { provider = "sqlite" }\nmodel Example { id String @id\n count Int @default(0) }';
  const b = 'generator other { provider = "ignored" }\nmodel Example {\n// comment\ncount Int @default( 0 )\nid String @id\n}';
  assert.deepEqual(checker.parseModels(a), checker.parseModels(b));
  assert.notDeepEqual(checker.parseModels(a), checker.parseModels(a.replace('count Int', 'count Float')));
  assert.notDeepEqual(checker.parseModels(a), checker.parseModels(a.replace('@default(0)', '@default(1)')));
  assert.ok(checker.checkSchemas().models.length > 20);
});

test('SQLite export preserves scalar values with private/no-overwrite output and validates before target access', async () => {
  assert.ok(migration, 'the advertised export/import script must exist');
  const dir = mkdtempSync(join(tmpdir(), 'database-maintenance-'));
  const url = `file:${dir}/source.db`, output = join(dir, 'snapshot.json');
  let prisma;
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url)),
      'db', 'push', '--skip-generate', '--schema', fileURLToPath(new URL('../prisma/schema.prisma', import.meta.url))],
    { env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe' });
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await seedAllModels(prisma);
    await migration.exportDatabase({ databaseUrl: url, output });
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const snapshot = JSON.parse(readFileSync(output, 'utf8'));
    const validated = migration.validateSnapshot(snapshot);
    assert.equal(validated.models.Tenant[0].name, 'Tenant.name');
    assert.equal(validated.models.Session[0].createdAt, '2025-04-03T02:01:00.123Z');
    assert.ok(Object.keys(validated.models).length > 20);
    assert.ok(Object.values(validated.counts).every(count => count === 1));
    await assert.rejects(migration.exportDatabase({ databaseUrl: url, output }), /exists/);
    const tampered = structuredClone(snapshot); tampered.models.Tenant[0].name = 'Modified';
    assert.throws(() => migration.validateSnapshot(tampered), /digest/i);
    const wrongType = structuredClone(snapshot); wrongType.models.Tenant[0].name = 2;
    wrongType.digest = migration.snapshotDigest(wrongType);
    assert.throws(() => migration.validateSnapshot(wrongType), /Tenant.*name/);
    const wrongFk = structuredClone(snapshot); wrongFk.models.User[0].tenantId = 'missing';
    wrongFk.digest = migration.snapshotDigest(wrongFk);
    assert.throws(() => migration.validateSnapshot(wrongFk), /foreign key/i);
    const wrongFields = structuredClone(snapshot); wrongFields.models.Tenant[0].unknown = 'extra';
    wrongFields.digest = migration.snapshotDigest(wrongFields);
    assert.throws(() => migration.validateSnapshot(wrongFields), /fields.*Tenant/i);
    const duplicate = structuredClone(snapshot); duplicate.models.User.push({ ...duplicate.models.User[0], id: 'other-user' }); duplicate.counts.User++;
    duplicate.digest = migration.snapshotDigest(duplicate);
    assert.throws(() => migration.validateSnapshot(duplicate), /unique.*User/i);
    const wrongCount = structuredClone(snapshot); wrongCount.counts.Session++;
    wrongCount.digest = migration.snapshotDigest(wrongCount);
    assert.throws(() => migration.validateSnapshot(wrongCount), /count.*Session/i);
    const wrongDate = structuredClone(snapshot); wrongDate.models.Session[0].expiresAt = 'invalid';
    wrongDate.digest = migration.snapshotDigest(wrongDate);
    assert.throws(() => migration.validateSnapshot(wrongDate), /Session.*expiresAt/i);
    let connected = false;
    await assert.rejects(migration.importSnapshot({ $transaction() { connected = true; } }, tampered), /digest/i);
    assert.equal(connected, false, 'invalid snapshots must fail before target access');
    const calls: string[] = [];
    const fake = { async $transaction(fn: any) {
      const tx: Record<string, any> = { $executeRawUnsafe: async () => calls.push('lock') };
      for (const name of Object.keys(snapshot.models)) tx[name[0].toLowerCase() + name.slice(1)] = {
        count: async () => name === 'Tenant' ? 1 : 0, createMany: async () => calls.push('write'),
      };
      return fn(tx);
    } };
    await assert.rejects(migration.importSnapshot(fake, snapshot), /empty/i);
    assert.equal(calls.includes('write'), false);
  } finally { await prisma?.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
});

test('maintenance help is available without database credentials', () => {
  assert.ok(migration);
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/migrate-sites-database.mjs', import.meta.url)), '--help'],
    { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.match(stdout, /--output/); assert.match(stdout, /--input/);
});
