import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class MaintenanceError extends Error {}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// Parse the model grammar used here without changing either schema or relying on generated-client freshness.
export function parseModels(source) {
  const pattern = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|@@?|[A-Za-z_][A-Za-z_0-9]*|\d+|[{}()[\],?:.=+-]/gy;
  const tokens = [];
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) throw new MaintenanceError(`Unsupported Prisma syntax at character ${offset}`);
    offset = pattern.lastIndex;
    if (!/^\s|^\/\//.test(match[0]) && !match[0].startsWith('/*')) tokens.push(match[0]);
  }
  let i = 0;
  const expect = value => { if (tokens[i++] !== value) throw new MaintenanceError('Unsupported Prisma model syntax'); };
  const name = () => {
    const value = tokens[i++];
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value ?? '')) throw new MaintenanceError('Invalid Prisma identifier');
    return value;
  };
  const attribute = () => {
    const result = [tokens[i++], name()];
    while (tokens[i] === '.') { result.push(tokens[i++], name()); }
    if (tokens[i] === '(') {
      let depth = 0;
      do {
        const token = tokens[i++];
        if (token === undefined) throw new MaintenanceError('Unterminated Prisma attribute');
        if (token === '(') depth++;
        if (token === ')') depth--;
        result.push(token);
      } while (depth);
    }
    return result;
  };
  const models = [];
  while (i < tokens.length) {
    const kind = name(), modelName = name(); expect('{');
    if (['datasource', 'generator'].includes(kind)) {
      let depth = 1;
      while (depth && i < tokens.length) { const t = tokens[i++]; if (t === '{') depth++; if (t === '}') depth--; }
      if (depth) throw new MaintenanceError('Unterminated Prisma block');
      continue;
    }
    if (kind !== 'model') throw new MaintenanceError(`Unsupported schema declaration: ${kind}`);
    const fields = [], attributes = [];
    while (tokens[i] !== '}') {
      if (tokens[i] === '@@') { attributes.push(attribute()); continue; }
      const field = { name: name(), type: name(), optional: false, list: false, attributes: [] };
      if (tokens[i] === '?') { field.optional = true; i++; }
      else if (tokens[i] === '[') { field.list = true; i++; expect(']'); }
      while (tokens[i] === '@') field.attributes.push(attribute());
      field.attributes.sort((a, b) => compare(canonical(a), canonical(b)));
      fields.push(field);
    }
    expect('}');
    if (new Set(fields.map(f => f.name)).size !== fields.length) throw new MaintenanceError(`Duplicate fields in ${modelName}`);
    models.push({ name: modelName, fields: fields.sort((a, b) => compare(a.name, b.name)),
      attributes: attributes.sort((a, b) => compare(canonical(a), canonical(b))) });
  }
  if (!models.length || new Set(models.map(m => m.name)).size !== models.length) throw new MaintenanceError('Missing or duplicate Prisma models');
  return models.sort((a, b) => compare(a.name, b.name));
}

export function checkSchemas() {
  const sqlite = parseModels(readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8'));
  const postgres = parseModels(readFileSync(new URL('../prisma/postgresql/schema.prisma', import.meta.url), 'utf8'));
  if (canonical(sqlite) !== canonical(postgres)) {
    const changed = [...new Set([...sqlite, ...postgres].map(m => m.name))].filter(name =>
      canonical(sqlite.find(m => m.name === name)) !== canonical(postgres.find(m => m.name === name)));
    throw new MaintenanceError(`SQLite/PostgreSQL models differ: ${changed.join(', ')}`);
  }
  return { sha256: digest(sqlite), models: sqlite };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.slice(2).length && process.argv.slice(2).join(' ') !== '--help') throw new MaintenanceError('Usage: node scripts/check-database-schemas.mjs [--help]');
    if (process.argv.includes('--help')) console.log('Compare SQLite and PostgreSQL Prisma models, ignoring generators, datasource/provider configuration, comments and formatting. Does not access databases.');
    else { const schema = checkSchemas(); console.log(`Schemas match: ${schema.models.length} models (${schema.sha256})`); }
  } catch (error) { console.error(error instanceof MaintenanceError ? error.message : 'Schema comparison failed'); process.exitCode = 1; }
}
