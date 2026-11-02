import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {generateKeyPair,exportSPKI,SignJWT} from 'jose';
import {analyticsFixture} from './database-fixture.js';
import {buildApp} from '../src/app.js';
import {loadRegistry} from '../src/registry.js';
import {ProcessMetrics} from '../src/metrics.js';
import {createAdminAuthority,ADMIN_AUTHORITY_HEADER} from '@kasitek-labs/server-support/admin-authority';

test('API reporting uses the nonowner RLS pool while scope resolution retains writer access',{skip:!process.env.ANALYTICS_TEST_DATABASE_URL},async()=>{
 const keys=await generateKeyPair('ES256',{extractable:true});
 const secret='isolated-reporting-authority-secret-long';
 const f=await analyticsFixture({ANALYTICS_REPORTING_PUBLIC_KEY:await exportSPKI(keys.publicKey),KASITEK_ADMIN_SERVICE_SECRET:secret,ANALYTICS_REPORTING_RESOLVER_CREDENTIALS_JSON:JSON.stringify([{source_service:'core',token:'fixture-resolver'}])});
 const role='report_reader_'+randomUUID().replaceAll('-','');
 let reader:pg.Pool|undefined,app:Awaited<ReturnType<typeof buildApp>>|undefined;
 try{
  await f.pool.query(`CREATE ROLE "${role}" NOLOGIN`);
  await f.pool.query(`GRANT USAGE ON SCHEMA analytics TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO "${role}"; GRANT INSERT ON analytics.reporting_grant,analytics.admin_reporting_audit TO "${role}"; GRANT EXECUTE ON FUNCTION analytics.admin_reporting_roots(TEXT,TEXT),analytics.admin_reporting_diagnostics() TO "${role}"`);
  const org=String((await f.pool.query(`INSERT INTO analytics.reporting_scope(scope_kind,owning_source_service,external_source_id,status,reporting_timezone) VALUES('core_organization','core','read-pool-org','active','UTC') RETURNING scope_id`)).rows[0].scope_id);
  reader=new pg.Pool({connectionString:f.databaseUrl,options:`-c role=${role}`});
  assert.equal((await reader.query('SELECT * FROM analytics.reporting_scope')).rowCount,0);
  await assert.rejects(reader.query(`UPDATE analytics.reporting_scope SET status='inactive'`),/permission denied/);
  await assert.rejects(reader.query(`INSERT INTO analytics.analytics_projection_rollup DEFAULT VALUES`),/permission denied/);
  await assert.rejects(reader.query(`INSERT INTO analytics.reporting_grant(grant_id) VALUES('unauthorized')`),/row-level security|not-null/);
  const registry=await loadRegistry();
  app=await buildApp({pool:f.pool,reportingPool:reader,config:f.config,registry,metrics:new ProcessMetrics()});
  const now=Math.floor(Date.now()/1000),jti=randomUUID();
  const token=await new SignJWT({principal_type:'user',scope_id:Number(org),root_scope_id:Number(org),descendant_mode:'none',policy_version:'fixture-policy',permissions:['analytics:read'],metric_keys:['conversation.lifecycle_events@1']}).setProtectedHeader({alg:'ES256'}).setIssuer('kasitek-core').setAudience('kasitek-analytics-reporting').setSubject('fixture-user').setJti(jti).setIssuedAt(now).setNotBefore(now).setExpirationTime(now+90).sign(keys.privateKey);
  const report=await app.inject({method:'POST',url:'/v1/reports/query',headers:{authorization:`Bearer ${token}`},payload:{reporting_scope_id:Number(org),range_start:'2026-10-22T00:00:00.000Z',range_end:'2026-10-23T00:00:00.000Z',timezone:'UTC',metrics:['conversation.lifecycle_events@1'],interval:'day'}});
  assert.equal(report.statusCode,200,report.body);
  assert.equal((await f.pool.query('SELECT grant_id FROM analytics.reporting_grant WHERE grant_id=$1',[jti])).rowCount,1);
  const stored=(await f.pool.query('SELECT * FROM analytics.reporting_grant WHERE grant_id=$1',[jti])).rows[0];
  for(const ids of [`{${org}}`,'{}']){
   const connection=await reader.connect();
   try{
    await connection.query('BEGIN');
    await connection.query('SELECT analytics.set_authorization_context($1::bigint[],$2)',[ids,'matching-grant']);
    await assert.rejects(connection.query('INSERT INTO analytics.reporting_grant SELECT (json_populate_record(NULL::analytics.reporting_grant,$1::json)).*',[JSON.stringify({...stored,grant_id:ids==='{}'?'matching-grant':'wrong-grant'})]),/row-level security/);
   }finally{await connection.query('ROLLBACK');connection.release();}
  }
  assert.equal((await reader.query('SELECT * FROM analytics.reporting_grant')).rowCount,0);
  assert.equal((await reader.query('SELECT * FROM analytics.reporting_scope')).rowCount,0);
  const path='/v1/admin/reporting?product=growth&start=2026-10-22T00%3A00%3A00Z&end=2026-10-23T00%3A00%3A00Z&timezone=UTC&metrics=conversation.lifecycle_events%401';
  const headers={[ADMIN_AUTHORITY_HEADER]:createAdminAuthority({secret,audience:'analytics',actor:{id:'reader',role:'viewer'},method:'GET',path,capability:'admin:report'})};
  const aggregate=await app.inject({url:path,headers});assert.equal(aggregate.statusCode,200,aggregate.body);assert.equal(aggregate.json().totalScopeCount,1);
  const resolution=await app.inject({url:'/internal/reporting/scopes/resolve?scope_kind=core_organization&external_source_id=read-pool-org',headers:{authorization:'Bearer fixture-resolver','x-source-service':'core'}});assert.equal(resolution.statusCode,200,resolution.body);assert.equal(String(resolution.json().scope_id),org);
 }finally{
  await app?.close();await reader?.end();
  await f.pool.query(`DROP OWNED BY "${role}";DROP ROLE "${role}"`);
  await f.close();
 }
});
