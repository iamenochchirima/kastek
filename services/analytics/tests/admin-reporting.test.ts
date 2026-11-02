import pg from "pg";
import {randomUUID} from "node:crypto";
import {loadAdminTrends} from "@kasitek-labs/server-support/admin-reporting-trends";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
import {AnalyticsReportingClient} from "@kasitek-labs/server-support/analytics-reporting";
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {analyticsFixture} from "./database-fixture.js";
import {loadRegistry} from "../src/registry.js";
import {ProcessMetrics} from "../src/metrics.js";
import {registerAdminReportingRoutes,ADMIN_REPORTING_PATH} from "../src/admin-reporting.js";
import {createAdminAuthority,ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
const enabled=!!process.env.ANALYTICS_TEST_DATABASE_URL;
test("admin Analytics aggregates each promoted generation with bounded scoped coverage",{skip:!enabled},async()=>{
 const secret="isolated-admin-reporting-signing-secret-long";
 const f=await analyticsFixture({KASITEK_ADMIN_SERVICE_SECRET:secret});const app=Fastify();
 try{
  const registry=await loadRegistry();
  const metric=registry.metrics.find(m=>m.key==="conversation.lifecycle_events")!;assert(metric);
  async function scope(kind:string,external:string,parent:string|null=null,timezone="UTC"){
   const service=kind==="core_organization"?"core":kind==="agents_organization"?"agent-platform":"tenant-platform";
   return String((await f.pool.query(`INSERT INTO analytics.reporting_scope(scope_kind,owning_source_service,external_source_id,parent_scope_id,status,reporting_timezone)
     VALUES($1,$2,$3,$4,'active',$5) RETURNING scope_id`,[kind,service,external,parent,timezone])).rows[0].scope_id);
  }
  const first=await scope("core_organization","same-id"),second=await scope("core_organization","second"),agency=await scope("tenant_workspace","same-id");
  const start="2026-10-22T00:00:00.000Z",end="2026-10-23T00:00:00.000Z";
  for(const [id,value] of [[first,4],[second,7],[agency,100]] as const){
   const generation=(await f.pool.query(`INSERT INTO analytics.analytics_projection_generation(projection_name,projection_version,reporting_scope_id,root_scope_id,shard_key,generation_number,generation_status,metric_registry_sha256,created_by_type,created_by_id)
    VALUES('typed_domain_facts','1',$1,$1,'default',1,'promoted',$2,'user','fixture') RETURNING generation_id`,[id,registry.sha256])).rows[0].generation_id;
   await f.pool.query(`INSERT INTO analytics.analytics_projection_checkpoint(projection_name,projection_version,reporting_scope_id,root_scope_id,shard_key,generation_id,processing_status) VALUES('typed_domain_facts','1',$1,$1,'default',$2,'idle')`,[id,generation]);
   await f.pool.query(`INSERT INTO analytics.analytics_projection_rollup(generation_id,projection_name,projection_version,metric_key,metric_version,target_scope_id,source_scope_id,root_scope_id,interval,bucket_start,bucket_end,value_count,value_sum,source_high_watermark,coverage)
    VALUES($1,'typed_domain_facts','1',$2,1,$3,$3,$3,'day',$4,$5,$6,$6,1,$7)`,[generation,metric.key,id,start,end,value,JSON.stringify({coverage_state:"observed",required_sources:metric.coverage.required_sources})]);
   await f.pool.query(`INSERT INTO analytics.analytics_source_state(producer_id,source_service,source_domain,source_stream_key,reporting_scope_id,root_scope_id,metric_scope,availability_state,latest_source_timestamp)
    VALUES('core-customer-analytics','core','inbox',$1,$2,$2,$3,'available',NOW())`,[id,id,metric.key]);
   await f.pool.query(`INSERT INTO analytics.analytics_coverage_checkpoint(producer_id,source_service,source_domain,reporting_scope_id,root_scope_id,coverage_layer,window_start,window_end,included_count,coverage_state,complete_through,observed_at)
    VALUES('core-customer-analytics','core','inbox',$1,$1,'temporal',$2,$3,1,'available',$3,NOW())`,[id,start,end]);
  }
  registerAdminReportingRoutes(app,{pool:f.pool,config:f.config,registry,metrics:new ProcessMetrics()});
  const path=(product="growth",extra="")=>ADMIN_REPORTING_PATH+"?"+new URLSearchParams({product,start,end,timezone:"UTC",metrics:metric.key+"@1"})+extra;
  const headers=(url:string)=>({[ADMIN_AUTHORITY_HEADER]:createAdminAuthority({secret,audience:"analytics",actor:{id:"admin-actor",role:"viewer"},method:"GET",path:url,capability:"admin:report"})});
  assert.equal((await app.inject(path())).statusCode,403);
  const response=await app.inject({url:path(),headers:headers(path())});assert.equal(response.statusCode,200,response.body);
  const report=response.json();assert.equal(report.includedScopeCount,2);assert.equal(report.totalScopeCount,2);assert.equal(report.hasMore,false);
  assert.deepEqual(report.trends[0].series.map((p:any)=>p.value),["11"]);assert.equal(report.trends[0].key,metric.key);
  const base=await app.listen({host:"127.0.0.1",port:0});
  const client=new AnalyticsReportingClient(base,"unused-resolver-for-admin");
  const integrated=await loadAdminTrends("growth","admin-actor",parseAdminReportQuery({start,end,timezone:"UTC"}),async()=>({client,adminAuthority:{secret,role:"viewer"}}));
  assert.equal(integrated.length,6);assert.equal(integrated.find(m=>m.key===metric.key)?.series[0]?.value,"11");
  assert.equal(integrated.find(m=>m.key==="agent.native.root_tasks.completed")?.availability,"unavailable");
  await f.pool.query("UPDATE analytics.analytics_source_state SET latest_source_timestamp=NULL");
  const unknown=(await app.inject({url:path(),headers:headers(path())})).json();
  assert.equal(unknown.trends[0].availability,"partial");
  await f.pool.query("UPDATE analytics.analytics_source_state SET latest_source_timestamp=NOW()");
  const orgPath=path("growth","&organizationId=same-id");
  const org=await app.inject({url:orgPath,headers:headers(orgPath)});assert.equal(org.json().trends[0].series[0].value,"4");
  assert.equal((await app.inject({url:path("agency"),headers:headers(path())})).statusCode,403);
  const records=(await f.pool.query('SELECT actor_id,product,included_scopes FROM analytics.admin_reporting_audit')).rows;
  assert(records.every(row=>row.actor_id==="admin-actor"&&row.product==="growth"));
  const role="admin_reporting_"+randomUUID().replaceAll("-","");
  const runtime=new pg.Pool({connectionString:f.databaseUrl,options:`-c role=${role}`});
  const limited=Fastify();
  try{
   await f.pool.query(`CREATE ROLE "${role}" NOLOGIN`);
   await f.pool.query(`GRANT USAGE ON SCHEMA analytics TO "${role}"`);
   await f.pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO "${role}"`);
   await f.pool.query(`GRANT EXECUTE ON FUNCTION analytics.admin_reporting_roots(TEXT,TEXT) TO "${role}"`);
   await f.pool.query(`GRANT INSERT ON analytics.admin_reporting_audit TO "${role}"`);
   assert.equal((await runtime.query("SELECT * FROM analytics.reporting_scope")).rowCount,0);
   registerAdminReportingRoutes(limited,{pool:runtime,config:f.config,registry,metrics:new ProcessMetrics()});
   const scoped=await limited.inject({url:orgPath,headers:headers(orgPath)});assert.equal(scoped.statusCode,200,scoped.body);
   assert.equal(scoped.json().trends[0].series[0].value,"4");
   assert.equal((await runtime.query("SELECT * FROM analytics.reporting_scope")).rowCount,0);
  }finally{
   await limited.close();await runtime.end();
   await f.pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA analytics FROM "${role}"`);
   await f.pool.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA analytics FROM "${role}"`);
   await f.pool.query(`REVOKE ALL ON SCHEMA analytics FROM "${role}"`);
   await f.pool.query(`DROP ROLE "${role}"`);
  }
  // A different source timezone must never be silently bucketed as the selected timezone.
  await scope("core_organization","different-zone",null,"Europe/London");
  const partial=(await app.inject({url:path(),headers:headers(path())})).json();
  assert.equal(partial.hasMore,true);assert.equal(partial.trends[0].availability,"partial");assert.equal(partial.trends[0].completeThrough,null);
  await f.pool.query(`INSERT INTO analytics.reporting_scope(scope_kind,owning_source_service,external_source_id,status,reporting_timezone)
    SELECT 'core_organization','core','bounded-'||n,'active','UTC' FROM generate_series(1,101) n`);
  const bounded=(await app.inject({url:path(),headers:headers(path())})).json();
  assert.equal(bounded.totalScopeCount,104);assert(bounded.includedScopeCount<=100);assert.equal(bounded.hasMore,true);
  assert.equal(bounded.trends[0].availability,"partial");
 }finally{await app.close();await f.close();}
});
