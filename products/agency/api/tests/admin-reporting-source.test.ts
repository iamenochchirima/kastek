import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {agencyAdminReport} from "../src/admin-reporting-source.js";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
import {runMigrations} from "../src/migrate.js";
import {readConfig} from "../src/config.js";
import {buildApp} from "../src/app.js";
import {registerAdminReportingRoutes} from "../src/controllers/admin-reporting.js";
import {createAdminAuthority,ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
const url=process.env.ADMIN_REPORTING_TEST_DATABASE_URL;
test("Agency reporting uses its own migrated workspace scope and signed actor",{skip:!url},async()=>{
 const admin=new pg.Pool({connectionString:url});const name="agency_report_"+randomUUID().replaceAll("-","");
 await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname="/"+name;
 const pool=new pg.Pool({connectionString:target.href});const secret="reporting-fixture-secret-32-bytes-long";
 const app=await buildApp({pool,config:readConfig({KASITEK_TENANTS_DATABASE_URL:target.href,KASITEK_ADMIN_SERVICE_SECRET:secret})},[registerAdminReportingRoutes]);
 try{
  await runMigrations(pool);
  await pool.query(`INSERT INTO workspaces(id,slug,display_name)VALUES('same-id','first','First'),('other','second','Second');
   INSERT INTO workspace_usage_events(id,workspace_id,event_type,quantity,created_at)VALUES('one','same-id','message',4,'2026-10-01'),('two','other','message',8,'2026-10-01')`);
  await pool.query(`INSERT INTO tenant_clients(id,workspace_id,name,slug,status)VALUES('client-active','same-id','Private customer','active','active'),('client-closed','same-id','Private closed','closed','inactive');
   INSERT INTO tenant_users(id,workspace_id,email,password_hash,status)VALUES('member-active','same-id','private@example.test','secret-hash','active'),('member-closed','same-id','closed@example.test','secret-hash','inactive')`);
  const path="/api/admin/reporting?start=2026-10-01T00%3A00%3A00Z&end=2026-10-02T00%3A00%3A00Z&organizationId=same-id";
  assert.equal((await app.inject(path)).statusCode,403);
  const token=createAdminAuthority({secret,audience:"agency",actor:{id:"reader",role:"viewer"},method:"GET",path});
  const response=await app.inject({url:path,headers:{[ADMIN_AUTHORITY_HEADER]:token}});
  assert.equal(response.statusCode,200,response.body);const report=response.json();
  assert.equal(report.metrics.find((m:any)=>m.key==="organizations").value,"1");
  assert.equal(report.metrics.find((m:any)=>m.key==="operations").value,"4");
  assert.equal(report.metrics.find((m:any)=>m.key==="paid").value,null);
  assert(report.records.every((row:any)=>row.organizationId==="same-id"));
  assert.equal(report.metrics.find((m:any)=>m.key==="operations").detailSupported,true);
  const query=parseAdminReportQuery({start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z",organizationId:"same-id",pageSize:1});
  const detail=async(metric:string,dimensions:Record<string,string>={},page=1)=>agencyAdminReport(pool,{...query,page,detail:{metric,dimensions}});
  assert.deepEqual((await detail("operations",{eventType:"message",provider:"none"})).records.map(r=>[r.id,r.kind,r.organizationId]),[["one","usage","same-id"]]);
  assert.equal((await detail("operations",{eventType:"message",provider:"different"})).records.length,0);
  assert.equal((await detail("operations",{eventType:"message",provider:"none",extra:"no"})).records.length,0);
  assert.equal((await detail("operations",{eventType:"message",provider:"none"},2)).records.length,0);
  assert.deepEqual((await detail("active_organizations")).records.map(r=>r.id),["same-id"]);
  assert.deepEqual((await detail("organizations")).records.map(r=>r.id),["same-id"]);
  assert.equal((await detail("new_organizations")).records.length,0);
  assert.deepEqual((await detail("clients")).records.map(r=>r.id),["client-active"]);
  assert.deepEqual((await detail("memberships")).records.map(r=>r.id),["member-active"]);
  assert(!JSON.stringify(await detail("memberships")).includes("private@example.test"));
  assert(!JSON.stringify(await detail("clients")).includes("Private customer"));

  assert.equal((await detail("paid",{currency:"ZAR"})).records.length,0);
  const outside=await agencyAdminReport(pool,{...query,start:"2026-10-02T00:00:00Z",end:"2026-10-03T00:00:00Z",detail:{metric:"operations",dimensions:{eventType:"message",provider:"none"}}});
  assert.equal(outside.records.length,0);

  assert.equal((await app.inject({url:path+"-tampered",headers:{[ADMIN_AUTHORITY_HEADER]:token}})).statusCode,403);
 }finally{await app.close();await pool.end();await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);await admin.end();}
});
