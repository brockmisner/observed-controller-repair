# SQLite to PostgreSQL maintenance

These commands copy application rows into an **empty, separately provisioned PostgreSQL database**. They do not change a deployment's database URL, stop controllers, migrate Redis jobs, or overwrite existing target data. Run them from the repository root with the same application revision on both sides.

## Prepare and export

Install the repository dependencies, then generate the normal SQLite client and the separate PostgreSQL importer. The importer is ignored build output; do not commit it.

```sh
npm run prisma:generate
npm run prisma:generate:importer
npm run db:check-schemas
node scripts/migrate-sites-database.mjs --help
```

Use an explicit, absolute SQLite file URL and a new output filename. The script does not load `.env` or select a deployment automatically.

```sh
DATABASE_URL='file:/absolute/path/source.db' npm run db:export:sqlite -- --output /absolute/path/snapshot.json
node scripts/migrate-sites-database.mjs validate --input /absolute/path/snapshot.json
```

Export reads every application's scalar model in one read-only transaction. It preserves identifiers, nulls, timestamps, encrypted credential values, and password/token hashes. Output uses exclusive creation, permissions `0600`, schema/version metadata, row counts, and a SHA-256 digest. Existing files are never replaced. Snapshots contain sensitive application data: transfer and store them with the same access controls as database backups. Keep the corresponding encryption keys separately; they are not included in the snapshot. The digest detects corruption, not an untrusted sender.

The format currently supports the schema's String, Int, Float, Boolean and DateTime fields. A schema change or unsupported type requires updating the scripts. Snapshots are limited to 256 MiB and one million total rows; this is an in-memory maintenance tool, not a streaming backup system.

## Restore and cut over

Provision a new target and apply its schema before importing. Check the explicit target URL before running either command.

```sh
DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/NEW_DATABASE' npx prisma migrate deploy --schema prisma/postgresql/schema.prisma
DATABASE_URL='postgresql://USER:PASSWORD@HOST:5432/NEW_DATABASE' npm run db:import:postgresql -- --input /absolute/path/snapshot.json
```

The importer validates the complete snapshot before connecting: schema, digest, counts, exact scalar fields/types, uniqueness and foreign keys. It locks all application tables, requires all of them to be empty, and inserts parent rows before dependent rows in one transaction. Any error rolls back the whole import. Existing Prisma migration history is allowed; existing application rows are not. Concurrent writers are blocked while the empty-target check and import run. The scripts do not delete or truncate data.

For a production cutover, stop application writers and device dispatch before the final export and keep them stopped until the new database has been checked. A snapshot retains operational state, including active trips and pending requests; reconcile that state and Redis queues before starting dispatch against the new database. Verify row counts and a representative tenant/device/login path, retain the source for rollback, then change the deployment configuration through the normal release process. These scripts themselves do not perform a production cutover.

## Verification

`node --import tsx --test tests/database-maintenance.test.ts` checks schema comparison, a real temporary SQLite export containing every model, file protections, and invalid/nonempty-target rejection. The unit suite does not connect to a configured production database.

With PostgreSQL binaries already installed and both Prisma clients generated, run the optional integration check:

```sh
node scripts/test-database-postgresql.mjs --run
```

It creates a small private temporary PostgreSQL cluster on loopback, applies the checked-in migrations, exports and restores synthetic rows covering every model, compares every scalar value, rejects a second import, and forces a late database constraint failure to check complete rollback. It ignores `DATABASE_URL`, stops its cluster, and removes its temporary files afterward. It does not install PostgreSQL or change an existing system service. Set `PG_BINDIR` if `pg_config` is unavailable on your PATH.
