import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readProductDiagnostics,collectReportingDiagnostics,sanitizeReportingDiagnostics,unavailableDiagnostics} from '../dist/admin-reporting-diagnostics.js';
test('strict diagnostics projection excludes raw content and rejects unbounded counts',()=>{
 const report=unavailableDiagnostics('agents');const clean=sanitizeReportingDiagnostics({...report,secret:'private'},'agents');assert(!JSON.stringify(clean).includes('private'));
 assert.throws(()=>sanitizeReportingDiagnostics({...report,service:'growth'},'agents'));
 assert.throws(()=>sanitizeReportingDiagnostics({...report,publication:{pending:-1}},'agents'));
});
test('collector preserves isolated sources, rejects authority and bounds streams',async()=>{
 const denied=await collectReportingDiagnostics('agents','http://fixture',{},undefined,async()=>new Response('{}',{status:403}));assert.equal(denied.connectivity.state,'unauthorized');
 const oversized=await collectReportingDiagnostics('growth','http://fixture',{},undefined,async()=>new Response('x'.repeat(65537)));assert.equal(oversized.connectivity.state,'disconnected');
 const report=unavailableDiagnostics('agency');assert.deepEqual(await collectReportingDiagnostics('agency','http://fixture',{},undefined,async()=>Response.json(report)),report);
 const controller=new AbortController();controller.abort(Error('cancelled'));await assert.rejects(()=>collectReportingDiagnostics('agency','http://fixture',{},controller.signal,async()=>{throw Error();}),/cancelled/);
});
test('product diagnostics observe durable backlog without publication or secret exposure',{skip:!process.env.ADMIN_REPORTING_TEST_DATABASE_URL},async()=>{
 const parent=new pg.Pool({connectionString:process.env.ADMIN_REPORTING_TEST_DATABASE_URL});const name='diagnostics_'+randomUUID().replaceAll('-','');await parent.query(`CREATE DATABASE "${name}"`);
 const url=new URL(process.env.ADMIN_REPORTING_TEST_DATABASE_URL);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.href});
 try{
  let result=await readProductDiagnostics(pool,'agency',{});assert.equal(result.schema.state,'incompatible_schema');assert.equal(result.publication,null);
  await pool.query(`CREATE TABLE workspaces(id text);CREATE TABLE analytics_outbox(delivery_status text,attempt_count int,created_at timestamptz,delivered_at timestamptz,last_error_code text,updated_at timestamptz);
   INSERT INTO analytics_outbox VALUES('pending',2,'2026-10-01',NULL,'upstream_timeout',now()),('delivered',1,'2026-09-01','2026-10-02',NULL,now()),('quarantined',4,'2026-09-01',NULL,'invalid_envelope',now());`);
  result=await readProductDiagnostics(pool,'agency',{ANALYTICS_TENANT_INGESTION_TOKEN:'never-return-this'});assert.equal(result.reads.state,'ready');assert.equal(result.publication.pending,'1');assert.equal(result.publication.retrying,'1');assert.equal(result.publication.quarantined,'1');assert.equal(result.publication.lastPublishedAt,'2026-10-02T00:00:00.000Z');assert(!JSON.stringify(result).includes('never-return-this'));
  assert.equal((await pool.query('SELECT count(*) FROM analytics_outbox')).rows[0].count,'3');
 }finally{await pool.end();await parent.query(`DROP DATABASE "${name}"`);await parent.end();}
});
