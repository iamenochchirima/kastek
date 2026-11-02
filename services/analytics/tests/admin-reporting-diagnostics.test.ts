import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {analyticsFixture} from './database-fixture.js';
import {loadRegistry} from '../src/registry.js';
import {ProcessMetrics} from '../src/metrics.js';
import {registerAdminReportingDiagnostics} from '../src/admin-reporting-diagnostics.js';
import {createAdminAuthority,ADMIN_AUTHORITY_HEADER} from '@kasitek-labs/server-support/admin-authority';
test('diagnostics require signed authority and expose only aggregate metadata through restricted runtime', {skip:!process.env.ANALYTICS_TEST_DATABASE_URL},async()=>{
 const secret='isolated-diagnostic-secret-at-least-32-bytes';const f=await analyticsFixture({KASITEK_ADMIN_SERVICE_SECRET:secret});
 const role='diag_'+randomUUID().replaceAll('-','');const pool=new pg.Pool({connectionString:f.databaseUrl,options:`-c role=${role}`});const app=Fastify();
 try{
  await f.pool.query(`CREATE ROLE "${role}" NOLOGIN;GRANT USAGE ON SCHEMA analytics TO "${role}";GRANT EXECUTE ON FUNCTION analytics.admin_reporting_diagnostics() TO "${role}"`);
  registerAdminReportingDiagnostics(app,{pool,config:f.config,registry:await loadRegistry(),metrics:new ProcessMetrics()});
  const path='/v1/admin/reporting/diagnostics';
  assert.equal((await app.inject(path)).statusCode,403);
  const headers={[ADMIN_AUTHORITY_HEADER]:createAdminAuthority({secret,audience:'analytics',actor:{id:'diagnostic-viewer',role:'viewer'},method:'GET',path,capability:'admin:report'})};
  const result=await app.inject({url:path,headers});assert.equal(result.statusCode,200,result.body);const report=result.json();
  assert.equal(report.schema.state,'ready');assert.equal(report.reads.state,'no_activity');assert.equal(report.projection.pending,'0');assert.equal(report.projection.completeThrough,null);assert.equal(report.projection.coverage,'unknown');
  assert(!result.body.includes('connectionString'));await assert.rejects(()=>pool.query('SELECT * FROM analytics.analytics_event'));
  assert.equal((await app.inject({url:path+'?tampered=true',headers})).statusCode,403);
 }finally{await app.close();await pool.end();await f.pool.query(`DROP OWNED BY "${role}";DROP ROLE "${role}"`);await f.close();}
});
