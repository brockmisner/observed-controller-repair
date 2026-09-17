import { open, stat, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, checkSchemas, digest, MaintenanceError } from './check-database-schemas.mjs';

const FORMAT = 'observatory-database-snapshot';
const VERSION = 1;
const MAX_BYTES = 256 * 1024 * 1024;
const MAX_ROWS = 1_000_000;
const scalarTypes = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime']);
const delegate = name => name[0].toLowerCase() + name.slice(1);
const attr = (attributes, name) => attributes.find(a => a[1] === name);
function arrayArgument(tokens, name) {
  const start = name ? tokens.indexOf(name) + 2 : tokens.indexOf('[');
  if (start < 0 || tokens[start] !== '[') return [];
  const end = tokens.indexOf(']', start);
  if (end < 0) throw new MaintenanceError('Invalid relation/constraint in schema');
  return tokens.slice(start + 1, end).filter(t => t !== ',');
}
function layout(schema) {
  const names = new Set(schema.models.map(m => m.name));
  return schema.models.map(model => {
    const fields = model.fields.filter(f => !names.has(f.type));
    if (fields.some(f => !scalarTypes.has(f.type) || f.list)) throw new MaintenanceError(`Unsupported scalar type in ${model.name}; update the migration format first`);
    const relations = model.fields.filter(f => names.has(f.type)).flatMap(f => {
      const relation = attr(f.attributes, 'relation');
      if (!relation) return [];
      const from = arrayArgument(relation, 'fields');
      return from.length ? [{ model: f.type, from, to: arrayArgument(relation, 'references') }] : [];
    });
    const unique = fields.filter(f => attr(f.attributes, 'id') || attr(f.attributes, 'unique')).map(f => [f.name]);
    for (const a of model.attributes) if (['id', 'unique'].includes(a[1])) unique.push(arrayArgument(a));
    const key = fields.find(f => attr(f.attributes, 'id'))?.name;
    if (!key) throw new MaintenanceError(`${model.name} needs a supported single-field primary key`);
    const mapped = attr(model.attributes, 'map');
    return { name: model.name, fields, relations, unique, key, table: mapped ? JSON.parse(mapped[3]) : model.name };
  });
}
export function importOrder(schema = checkSchemas()) {
  const pending = layout(schema), ordered = [], done = new Set();
  while (pending.length) {
    const index = pending.findIndex(m => m.relations.every(r => done.has(r.model)));
    if (index < 0) throw new MaintenanceError('Cyclic foreign keys need a dedicated migration');
    const [model] = pending.splice(index, 1); ordered.push(model); done.add(model.name);
  }
  return ordered;
}
function exactKeys(value, keys, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      canonical(Object.keys(value).sort()) !== canonical([...keys].sort())) throw new MaintenanceError(`Unexpected or missing fields in ${context}`);
}
function validScalar(value, field, model) {
  if (value === null && field.optional) return;
  const ok = field.type === 'String' ? typeof value === 'string' && !value.includes('\0') :
    field.type === 'Int' ? Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 :
    field.type === 'Float' ? typeof value === 'number' && Number.isFinite(value) :
    field.type === 'Boolean' ? typeof value === 'boolean' :
    field.type === 'DateTime' ? typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value : false;
  if (!ok) throw new MaintenanceError(`Invalid scalar ${model}.${field.name}`);
}
export function snapshotDigest(snapshot) {
  const { digest: _ignored, ...content } = snapshot;
  return digest(content);
}
export function validateSnapshot(snapshot, schema = checkSchemas()) {
  exactKeys(snapshot, ['format', 'version', 'sourceProvider', 'exportedAt', 'schema', 'counts', 'models', 'digest'], 'snapshot');
  if (snapshot.format !== FORMAT || snapshot.version !== VERSION || snapshot.sourceProvider !== 'sqlite') throw new MaintenanceError('Unsupported snapshot format/version/provider');
  if (typeof snapshot.digest !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.digest) || snapshotDigest(snapshot) !== snapshot.digest) throw new MaintenanceError('Snapshot digest does not match');
  validScalar(snapshot.exportedAt, { type: 'DateTime', name: 'exportedAt' }, 'snapshot');
  if (canonical(snapshot.schema) !== canonical(schema)) throw new MaintenanceError('Snapshot schema does not match this checkout');
  const models = layout(schema), names = models.map(m => m.name);
  exactKeys(snapshot.models, names, 'models'); exactKeys(snapshot.counts, names, 'counts');
  let total = 0;
  for (const model of models) {
    const rows = snapshot.models[model.name];
    if (!Array.isArray(rows) || !Number.isSafeInteger(snapshot.counts[model.name]) || snapshot.counts[model.name] !== rows.length) throw new MaintenanceError(`Invalid row count for ${model.name}`);
    total += rows.length; if (total > MAX_ROWS) throw new MaintenanceError('Snapshot exceeds one million rows');
    const unique = model.unique.map(() => new Set());
    for (const row of rows) {
      exactKeys(row, model.fields.map(f => f.name), model.name);
      for (const field of model.fields) validScalar(row[field.name], field, model.name);
      model.unique.forEach((fields, i) => {
        if (fields.some(f => row[f] === null)) return;
        const key = canonical(fields.map(f => row[f]));
        if (unique[i].has(key)) throw new MaintenanceError(`Duplicate unique key in ${model.name}`);
        unique[i].add(key);
      });
    }
  }
  const indexes = new Map();
  for (const model of models) for (const relation of model.relations) {
    const key = canonical([relation.model, relation.to]);
    if (!indexes.has(key)) indexes.set(key, new Set(snapshot.models[relation.model].map(row => canonical(relation.to.map(f => row[f])))));
    for (const row of snapshot.models[model.name]) {
      if (relation.from.some(f => row[f] === null)) continue;
      if (!indexes.get(key).has(canonical(relation.from.map(f => row[f])))) throw new MaintenanceError(`Invalid foreign key from ${model.name} to ${relation.model}`);
    }
  }
  importOrder(schema);
  return snapshot;
}
function sqlitePath(databaseUrl) {
  let url;
  if (typeof databaseUrl !== 'string' || !databaseUrl.startsWith('file:/')) throw new MaintenanceError('Set DATABASE_URL to an explicit absolute file:/path/source.db');
  try { url = new URL(databaseUrl); } catch { throw new MaintenanceError('Set DATABASE_URL to an explicit absolute file:/path/source.db'); }
  if (url.protocol !== 'file:' || url.search || url.hash || url.host) throw new MaintenanceError('Export requires an absolute SQLite file URL without query parameters');
  return fileURLToPath(url);
}
export async function exportDatabase({ databaseUrl, output }) {
  if (!output) throw new MaintenanceError('Export requires --output FILE');
  const source = sqlitePath(databaseUrl);
  if (!(await stat(source)).isFile()) throw new MaintenanceError('SQLite source must be an existing regular file');
  try { await stat(output); throw new MaintenanceError('Output already exists; choose a new file'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const schema = checkSchemas(), models = importOrder(schema);
  const { PrismaClient } = await import('@prisma/client');
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  let snapshot;
  try {
    snapshot = await client.$transaction(async tx => {
      // SQLite query_only prevents accidental writes from this export transaction.
      await tx.$executeRawUnsafe('PRAGMA query_only = ON');
      const data = {}, counts = {};
      let total = 0;
      for (const model of models) {
        const rows = await tx[delegate(model.name)].findMany({ select: Object.fromEntries(model.fields.map(f => [f.name, true])), orderBy: { [model.key]: 'asc' }, take: MAX_ROWS - total + 1 });
        total += rows.length;
        if (total > MAX_ROWS) throw new MaintenanceError('Snapshot exceeds one million rows; use a dedicated migration');
        data[model.name] = rows.map(row => Object.fromEntries(model.fields.map(f => [f.name,
          f.type === 'DateTime' && row[f.name] !== null ? row[f.name].toISOString() : row[f.name]])));
        counts[model.name] = rows.length;
      }
      const result = { format: FORMAT, version: VERSION, sourceProvider: 'sqlite', exportedAt: new Date().toISOString(), schema, counts, models: data };
      return { ...result, digest: snapshotDigest(result) };
    }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 300000 });
  } finally { await client.$disconnect(); }
  validateSnapshot(snapshot, schema);
  const encoded = Buffer.from(JSON.stringify(snapshot));
  if (encoded.length > MAX_BYTES) throw new MaintenanceError('Snapshot exceeds 256 MiB; use a dedicated migration');
  let handle;
  try {
    handle = await open(output, 'wx', 0o600);
    await handle.writeFile(encoded); await handle.sync();
  } catch (error) {
    if (handle) await unlink(output).catch(() => {});
    if (error.code === 'EEXIST') throw new MaintenanceError('Output already exists; choose a new file');
    throw error;
  } finally { await handle?.close(); }
  return { counts: snapshot.counts, digest: snapshot.digest };
}
export async function readSnapshot(input) {
  if (!input) throw new MaintenanceError('Specify --input FILE');
  const handle = await open(input, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new MaintenanceError('Input must be a regular file of at most 256 MiB');
    const raw = await handle.readFile({ encoding: 'utf8' });
    if (Buffer.byteLength(raw) > MAX_BYTES) throw new MaintenanceError('Snapshot exceeds 256 MiB');
    let value; try { value = JSON.parse(raw); } catch { throw new MaintenanceError('Input is not valid JSON'); }
    return validateSnapshot(value);
  } finally { await handle.close(); }
}
export async function importSnapshot(client, snapshot) {
  validateSnapshot(snapshot);
  const order = importOrder();
  const quote = name => `"${name.replaceAll('"', '""')}"`;
  await client.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '10s'");
    // Lock all modeled tables before the empty-target check, preventing races with application writers.
    await tx.$executeRawUnsafe(`LOCK TABLE ${order.map(m => quote(m.table)).join(', ')} IN ACCESS EXCLUSIVE MODE`);
    for (const model of order) if (await tx[delegate(model.name)].count()) throw new MaintenanceError(`Target must be empty; ${model.name} contains data`);
    for (const model of order) {
      const rows = snapshot.models[model.name];
      for (let offset = 0; offset < rows.length; offset += 250) {
        const data = rows.slice(offset, offset + 250).map(row => Object.fromEntries(model.fields.map(f => [f.name,
          f.type === 'DateTime' && row[f.name] !== null ? new Date(row[f.name]) : row[f.name]])));
        await tx[delegate(model.name)].createMany({ data });
      }
    }
  }, { isolationLevel: 'Serializable', maxWait: 10000, timeout: 300000 });
  return snapshot.counts;
}

const help = `Usage:
  DATABASE_URL=file:/absolute/source.db npm run db:export:sqlite -- --output FILE
  node scripts/migrate-sites-database.mjs validate --input FILE
  DATABASE_URL=postgresql://... npm run db:import:postgresql -- --input FILE

Export reads every model in one transaction and creates a new private (0600) snapshot.
Import requires matching migrated schemas, a generated PostgreSQL importer client and an empty target.
Import validates the complete snapshot before connecting, locks target tables, and commits all rows together.
Snapshots contain credentials and personal data. See DATABASE-MAINTENANCE.md. No .env file is loaded.
`;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') console.log(help);
    else {
      const [command, flag, filename, ...extra] = args;
      if (!['export', 'import', 'validate'].includes(command) || flag !== (command === 'export' ? '--output' : '--input') || !filename || extra.length) throw new MaintenanceError(help);
      if (command === 'export') console.log(JSON.stringify(await exportDatabase({ databaseUrl: process.env.DATABASE_URL, output: filename })));
      else {
        const snapshot = await readSnapshot(filename);
        if (command === 'validate') console.log(JSON.stringify({ valid: true, counts: snapshot.counts, digest: snapshot.digest }));
        else {
          let url;
          try { url = new URL(process.env.DATABASE_URL); } catch { throw new MaintenanceError('Import requires an explicit PostgreSQL DATABASE_URL'); }
          if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new MaintenanceError('Import requires a PostgreSQL database URL');
          let generated;
          try { generated = await import('../prisma/generated/postgresql-import/index.js'); }
          catch { throw new MaintenanceError('Run npm run prisma:generate:importer before importing'); }
          const client = new generated.PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
          try { console.log(JSON.stringify({ imported: await importSnapshot(client, snapshot) })); }
          finally { await client.$disconnect(); }
        }
      }
    }
  } catch (error) {
    // Database diagnostics can include connection credentials or row contents; never print raw errors.
    console.error(error instanceof MaintenanceError ? error.message : 'Maintenance operation failed. Check file access, generated client and database connectivity; no partial import is committed.');
    process.exitCode = 1;
  }
}
