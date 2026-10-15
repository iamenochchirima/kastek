import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { readMigrations, runMigrations, type Migration } from '../src/migrate.js';

async function fixture(run: (pool:pg.Pool)=>Promise<void>) {
 const admin=new pg.Pool({connectionString:process.env.TENANT_TEST_DATABASE_URL});
 const schema=`tenant_migrations_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:process.env.TENANT_TEST_DATABASE_URL,options:`-c search_path=${schema} -c timezone=UTC`});
 try { await run(pool); }
 finally { await pool.end();try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();} }
}
const enabled=!!process.env.TENANT_TEST_DATABASE_URL;
test('concurrent native startup applies fourteen real source migrations once, retaining SQLx checksums', {skip:!enabled}, async()=>fixture(async pool=>{
 const migrations=await readMigrations();
 await Promise.all([runMigrations(pool,migrations),runMigrations(pool,migrations)]);
 const rows=(await pool.query('SELECT version,description,success,checksum,execution_time FROM _sqlx_migrations ORDER BY version')).rows;
 assert.equal(rows.length,14);
 for(let i=0;i<rows.length;i++) {
  assert.equal(rows[i].version,migrations[i]!.version);assert.equal(rows[i].description,migrations[i]!.description);
  assert.equal(rows[i].success,true);assert.deepEqual(rows[i].checksum,migrations[i]!.checksum);assert.ok(BigInt(rows[i].execution_time)>=0n);
 }
 assert.ok((await pool.query(`SELECT to_regclass('tenant_client_assignments') AS name`)).rows[0].name);
 await runMigrations(pool,migrations);
 assert.equal((await pool.query('SELECT count(*) FROM _sqlx_migrations')).rows[0].count,'14');
 const changed=migrations.map((migration,i)=>i?migration:{...migration,checksum:Buffer.alloc(48)});
 await assert.rejects(runMigrations(pool,changed),/checksum mismatch/);
 await assert.rejects(runMigrations(pool,migrations.slice(1)),/missing from source/);
 await pool.query('UPDATE _sqlx_migrations SET success=FALSE WHERE version=$1',[migrations[0]!.version]);
 await assert.rejects(runMigrations(pool,migrations),/is dirty/);
 await pool.query('UPDATE _sqlx_migrations SET success=TRUE');
 await runMigrations(pool,migrations); // failures released the session lock and checked-out client
}));
test('failed SQL migration rolls back its DDL and ledger, then permits a corrected retry', {skip:!enabled},async()=>fixture(async pool=>{
 const make=(sql:string):Migration=>({version:'1',description:'rollback fixture',sql,checksum:createHash('sha384').update(sql).digest(),down:false,noTransaction:false});
 await assert.rejects(runMigrations(pool,[make('CREATE TABLE fixture_rollback(id TEXT); INSERT INTO fixture_missing VALUES(1);')]));
 assert.equal((await pool.query(`SELECT to_regclass('fixture_rollback') AS name`)).rows[0].name,null);
 assert.equal((await pool.query('SELECT count(*) FROM _sqlx_migrations')).rows[0].count,'0');
 await runMigrations(pool,[make('CREATE TABLE fixture_rollback(id TEXT);')]);
 assert.equal((await pool.query('SELECT count(*) FROM _sqlx_migrations')).rows[0].count,'1');
}));
