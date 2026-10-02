import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readMigrations,run} from '../src-ts/migrations.js';
import {createPool} from '../src-ts/db.js';
import {readConfig,type AnalyticsConfig} from '../src-ts/config.js';
/** Source SQL explicitly addresses analytics.*, so each fixture owns a whole disposable database. */
export async function analyticsFixture(overrides:Record<string,string|undefined>={}) {
 const parent=process.env.ANALYTICS_TEST_DATABASE_URL;
 if(!parent)throw Error('ANALYTICS_TEST_DATABASE_URL is required for isolated Analytics fixtures');
 const name=`analytics_ts_fixture_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString:parent});
 const allowed=(await admin.query<{allowed:boolean}>('SELECT rolcreatedb OR rolsuper AS allowed FROM pg_roles WHERE rolname=current_user')).rows[0]?.allowed;
 if(!allowed){await admin.end();throw Error('Analytics fixture connection needs permission to create disposable databases');}
 await admin.query(`CREATE DATABASE "${name}"`);
 const url=new URL(parent);url.pathname=`/${name}`;url.searchParams.delete('options');
 const config:AnalyticsConfig=readConfig({...overrides,ANALYTICS_DATABASE_URL:url.toString()});
 const pool=createPool(config);
 const close=async()=>{
  await pool.end();
  try{
   if(!/^analytics_ts_fixture_[a-f0-9]{32}$/.test(name))throw Error('Invalid disposable database name');
   await admin.query(`DROP DATABASE "${name}"`);
  }finally{await admin.end();}
 };
 try{
  const database=(await pool.query<{name:string}>('SELECT current_database() AS name')).rows[0]!.name;
  if(database!==name)throw Error('Refusing migration outside owned disposable Analytics database');
  await run(pool);
  // Two simultaneous release jobs verify advisory-lock serialization; the next pass
  // verifies SQLx checksums/history and the ordinary no-op release path.
  await Promise.all([run(pool),run(pool)]);
  await run(pool);
  const expected=await readMigrations(),applied=(await pool.query<{version:string;success:boolean;checksum:Buffer}>('SELECT version::text,success,checksum FROM _sqlx_migrations ORDER BY version')).rows;
  if(applied.length!==expected.filter(migration=>!migration.down).length||applied.some((row,index)=>!row.success||row.version!==expected.filter(migration=>!migration.down)[index]?.version||!row.checksum.equals(expected.filter(migration=>!migration.down)[index]!.checksum)))throw Error('Analytics migration ledger does not match source migration checksums');
  return {pool,config,databaseUrl:url.toString(),name,close};
 }catch(error){await close();throw error;}
}
