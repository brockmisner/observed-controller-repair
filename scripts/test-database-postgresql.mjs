import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { importOrder, importSnapshot, readSnapshot } from './migrate-sites-database.mjs';
import { seedAllModels } from '../tests/helpers/database-fixture.mjs';

if (process.argv.length !== 3 || process.argv[2] !== '--run') {
  console.log('Usage: node scripts/test-database-postgresql.mjs --run\nRequires local PostgreSQL binaries (pg_config or PG_BINDIR) and generated SQLite/importer clients. Creates and deletes its own temporary local cluster; never uses DATABASE_URL.');
  process.exit(process.argv.includes('--help') ? 0 : 1);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const pgBin = process.env.PG_BINDIR || execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
const { PrismaClient: SqliteClient } = await import('@prisma/client');
const { PrismaClient: PostgresClient } = await import('../prisma/generated/postgresql-import/index.js');
const dir = mkdtempSync(join(tmpdir(), 'controller-pg-test-'));
const dataDir = join(dir, 'pgdata');
const env = { PATH: process.env.PATH, TMPDIR: tmpdir(), NODE_ENV: 'test' };
const run = (binary, args, additions = {}) => execFileSync(binary, args, {
  cwd: root, env: { ...env, ...additions }, stdio: 'pipe', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
});
const prisma = (url, args) => run(process.execPath, [resolve(root, 'node_modules/prisma/build/index.js'), ...args], { DATABASE_URL: url });
let running = false, sqlite, restored, failed;
try {
  const listener = createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  run(join(pgBin, 'initdb'), ['-D', dataDir, '-U', 'maintenance_test', '-A', 'trust', '--no-locale', '--encoding=UTF8']);
  running = true; // Retain the directory if an ambiguous start/stop result cannot rule out a running server.
  run(join(pgBin, 'pg_ctl'), ['-D', dataDir, '-l', join(dir, 'postgres.log'), '-w', '-t', '30', 'start', '-o',
    `-h 127.0.0.1 -p ${port} -k ${dir} -c shared_buffers=16MB -c max_connections=10`]);
  const urlFor = database => `postgresql://maintenance_test@127.0.0.1:${port}/${database}`;
  for (const name of ['restore_test', 'rollback_test']) {
    run(join(pgBin, 'createdb'), ['-h', '127.0.0.1', '-p', String(port), '-U', 'maintenance_test', name]);
    prisma(urlFor(name), ['migrate', 'deploy', '--schema', 'prisma/postgresql/schema.prisma']);
  }
  const sourceUrl = `file:${dir}/source.db`, snapshotPath = join(dir, 'snapshot.json');
  prisma(sourceUrl, ['db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma']);
  sqlite = new SqliteClient({ datasources: { db: { url: sourceUrl } } });
  await seedAllModels(sqlite);
  run(process.execPath, ['scripts/migrate-sites-database.mjs', 'export', '--output', snapshotPath], { DATABASE_URL: sourceUrl });
  const snapshot = await readSnapshot(snapshotPath);
  run(process.execPath, ['scripts/migrate-sites-database.mjs', 'import', '--input', snapshotPath], { DATABASE_URL: urlFor('restore_test') });
  restored = new PostgresClient({ datasources: { db: { url: urlFor('restore_test') } } });
  for (const model of importOrder()) {
    const rows = await restored[model.name[0].toLowerCase() + model.name.slice(1)].findMany({ orderBy: { [model.key]: 'asc' } });
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), snapshot.models[model.name], `${model.name} must preserve every scalar value`);
  }
  await assert.rejects(importSnapshot(restored, snapshot), /Target must be empty/);
  failed = new PostgresClient({ datasources: { db: { url: urlFor('rollback_test') } } });
  // Force a real database error after preceding models have been inserted.
  await failed.$executeRawUnsafe('ALTER TABLE "WarmupRun" ADD CONSTRAINT "fixture_rollback" CHECK ("attempts" < 0)');
  await assert.rejects(importSnapshot(failed, snapshot));
  for (const model of importOrder()) assert.equal(await failed[model.name[0].toLowerCase() + model.name.slice(1)].count(), 0, `${model.name} must roll back`);
  console.log(`PostgreSQL integration passed: ${Object.keys(snapshot.models).length} models restored with exact scalar equality; nonempty target rejected; late constraint failure rolled back every model.`);
} catch (error) {
  // This cluster contains synthetic test data only. Diagnostics are safe to report here.
  console.error(error?.stderr?.toString() || error);
  if (running) { try { console.error(readFileSync(join(dir, 'postgres.log'), 'utf8').slice(-4000)); } catch {} }
  process.exitCode = 1;
} finally {
  await Promise.allSettled([sqlite?.$disconnect(), restored?.$disconnect(), failed?.$disconnect()]);
  if (running) {
    try { run(join(pgBin, 'pg_ctl'), ['-D', dataDir, '-w', '-m', 'immediate', 'stop']); running = false; }
    catch { console.error(`Could not stop the temporary PostgreSQL cluster at ${dataDir}; retained files for recovery.`); process.exitCode = 1; }
  }
  if (!running) rmSync(dir, { recursive: true, force: true });
}
