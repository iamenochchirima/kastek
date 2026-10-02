import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type pg from 'pg';

export interface Migration {
 version: string;
 description: string;
 sql: string;
 checksum: Buffer;
 noTransaction: boolean;
 down: boolean;
}
/** SQLx 0.8 PostgreSQL uses CRC-32/ISO-HDLC(database_name) * 0x3d32ad9e. */
export function migrationLockId(database: string): string {
 let crc = 0xffffffff;
 for (const byte of Buffer.from(database)) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
 }
 return (BigInt((crc ^ 0xffffffff) >>> 0) * 0x3d32ad9en).toString();
}
export async function readMigrations(directory = fileURLToPath(new URL('../migrations/', import.meta.url))): Promise<Migration[]> {
 const files = await readdir(directory, { withFileTypes: true });
 const migrations: Migration[] = [];
 for (const file of files) {
  if (!file.isFile()) continue;
  const match = /^([^_]+)_(.+)\.sql$/.exec(file.name);
  if (!match) continue;
  if (!/^[+-]?\d+$/.test(match[1]!)) throw Error(`Invalid migration version: ${file.name}`);
  const version = BigInt(match[1]!);
  if (version < -9223372036854775808n || version > 9223372036854775807n) throw Error(`Invalid migration version: ${file.name}`);
  const bytes = await readFile(join(directory, file.name));
  const sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const description = match[2]!.replace(/\.(up|down)$/, '').replaceAll('_', ' ');
  migrations.push({ version: version.toString(), description, sql,
   checksum: createHash('sha384').update(bytes).digest(), noTransaction: sql.startsWith('-- no-transaction'), down: match[2]!.endsWith('.down') });
 }
 return migrations.sort((a,b) => BigInt(a.version) < BigInt(b.version) ? -1 : BigInt(a.version) > BigInt(b.version) ? 1 : 0);
}
/** Retain existing SQLx ledger, checksum validation and one-connection locking. */
export async function runMigrations(pool: pg.Pool, migrations?: Migration[]): Promise<void> {
 const source = migrations ?? await readMigrations();
 const client = await pool.connect();
 let locked = false;
 let lockId = '';
 let releaseError: Error | undefined;
 try {
  const database = (await client.query<{ name: string }>('SELECT current_database() AS name')).rows[0]!.name;
  lockId = migrationLockId(database);
  await client.query('SELECT pg_advisory_lock($1::bigint)', [lockId]);
  locked = true;
  await client.query(`CREATE TABLE IF NOT EXISTS _sqlx_migrations (
   version BIGINT PRIMARY KEY, description TEXT NOT NULL,
   installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL,
   checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)`);
  const applied = (await client.query<{version:string;success:boolean;checksum:Buffer}>('SELECT version,success,checksum FROM _sqlx_migrations ORDER BY version')).rows;
  const dirty = applied.find(row => !row.success);
  if (dirty) throw Error(`Migration ${dirty.version} is dirty`);
  for (const row of applied) if (!source.some(migration => migration.version === row.version)) throw Error(`Applied migration ${row.version} is missing from source`);
  for (const migration of source) {
   if (migration.down) continue;
   const previous = applied.find(row => row.version === migration.version);
   if (previous) {
    if (!migration.checksum.equals(previous.checksum)) throw Error(`Migration ${migration.version} checksum mismatch`);
    continue;
   }
   const started = process.hrtime.bigint();
   if (!migration.noTransaction) await client.query('BEGIN');
   try {
    await client.query(migration.sql);
    await client.query('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES($1,$2,TRUE,$3,-1)', [migration.version, migration.description, migration.checksum]);
    if (!migration.noTransaction) await client.query('COMMIT');
   } catch (error) {
    if (!migration.noTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
   }
   const elapsed = BigInt.asIntN(64, process.hrtime.bigint() - started).toString();
   await client.query('UPDATE _sqlx_migrations SET execution_time=$1 WHERE version=$2', [elapsed,migration.version]);
  }
 } finally {
  if (locked) {
   try { await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]); }
   catch (error) { releaseError = error instanceof Error ? error : new Error('Migration lock release failed'); }
  }
  // A connection that cannot release its session lock must never return to the pool.
  client.release(releaseError);
 }
}
