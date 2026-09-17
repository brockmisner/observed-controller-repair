import { importOrder } from '../../scripts/migrate-sites-database.mjs';

// Exercise every scalar column and declared foreign key using disposable test databases only.
export async function seedAllModels(client) {
  const rows = new Map();
  for (const model of importOrder()) {
    const data = Object.fromEntries(model.fields.map(field => [field.name, field.optional ? null :
      field.type === 'DateTime' ? new Date('2025-04-03T02:01:00.123Z') :
      field.type === 'Boolean' ? false : field.type === 'Int' ? 1 : field.type === 'Float' ? 1.25 :
      field.name.endsWith('Json') ? '{}' : `${model.name}.${field.name}`]));
    for (const relation of model.relations) relation.from.forEach((field, index) => {
      data[field] = rows.get(relation.model)[relation.to[index]];
    });
    await client[model.name[0].toLowerCase() + model.name.slice(1)].create({ data });
    rows.set(model.name, data);
  }
}
