import { adbPreflight } from './adb-preflight.mjs';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';

process.umask(0o077);
const provider = process.env.DATABASE_PROVIDER || 'sqlite';
const generatedSchema = await readFile(new URL('../node_modules/.prisma/client/schema.prisma', import.meta.url), 'utf8');
const generatedProvider = generatedSchema.match(/datasource\s+db\s*\{\s*provider\s*=\s*"([^"]+)"/)?.[1];
if (!['sqlite', 'postgresql'].includes(provider) || generatedProvider !== provider) {
  throw new Error('DATABASE_PROVIDER must match the provider selected when this image was built.');
}
const databaseUrl = process.env.DATABASE_URL || '';
if (provider === 'postgresql' ? !/^postgres(?:ql)?:\/\//.test(databaseUrl) : !databaseUrl.startsWith('file:')) {
  throw new Error('DATABASE_URL does not match DATABASE_PROVIDER.');
}
if (provider === 'sqlite') await mkdir('/app/data', { recursive: true, mode: 0o700 });

let child;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child?.kill(signal));
function run(command, args) {
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
const migrationArgs = provider === 'postgresql'
  ? ['migrate', 'deploy', '--schema', 'prisma/postgresql/schema.prisma']
  : ['db', 'push', '--skip-generate', '--schema', 'prisma/schema.prisma'];
const migrationCode = await run('./node_modules/.bin/prisma', migrationArgs);
if (!migrationCode && !process.env.DUOMOVE_IMAGE_ID) void adbPreflight();
process.exitCode = migrationCode || await run(process.execPath, ['dist/index.js']);
