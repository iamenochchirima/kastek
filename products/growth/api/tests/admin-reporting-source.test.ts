import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {buildApp} from "../src/app.js";
import {registerAdminAnalyticsRoutes} from "../src/routes/admin-analytics.js";
import {growthAdminReport} from "../src/services/admin/reporting-source.js";
import {registerAdminReportingRoutes} from "../src/routes/admin-reporting.js";
import {createAdminSession} from "../src/identity/admin-session.js";
import {readConfig} from "../src/config.js";
import {installErrorHandler} from "../src/error.js";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
const url=process.env.ADMIN_REPORTING_TEST_DATABASE_URL;
test("Growth reporting reconciles scoped records and currencies through authorized HTTP",{skip:!url},async()=>{
 const schema="reporting_"+randomUUID().replaceAll("-","");
 const pool=new pg.Pool({connectionString:url,max:1});
 const core={pool,config:readConfig({DATABASE_URL:url})};
 const app=await buildApp(core,[registerAdminReportingRoutes,registerAdminAnalyticsRoutes]);
 try {
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`SET search_path TO ${schema},public`);
  for(const table of ["Organization","OrganizationMember","User","UsageEvent","Conversation","CreditUsageEvent","BillingInvoice","AdminUser","AdminSession","AdminSavedReport","AdminReportExportAuditEvent","PublicApiRequest","BillingCheckout","OrganizationSubscription"])
   await pool.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
  await pool.query(`INSERT INTO "AdminUser"(id,name,email,password,role,"updatedAt")VALUES('reader','Reader','reader@example.test','unused','viewer',now()),('owner','Owner','owner@example.test','unused','owner',now()),('other','Other','other@example.test','unused','owner',now());
   INSERT INTO "User"(id,name,email,"updatedAt")VALUES('person','Person','person@example.test',now());
   INSERT INTO "Organization"(id,name,slug,"ownerId","updatedAt")VALUES('org-a','A','a','person',now()),('org-b','B','b','person',now());
   INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt")VALUES('member','org-a','person','OWNER',now());
   INSERT INTO "UsageEvent"(id,"orgId","productKey","metricKey",quantity,"occurredAt")VALUES('event-a','org-a','growth','send',7,'2026-10-01'),('event-b','org-b','growth','send',9,'2026-10-01');
   INSERT INTO "BillingInvoice"(id,"invoiceNumber","orgId",provider,status,currency,"amountMinor","issuedAt","paidAt","updatedAt")VALUES
    ('zar','A','org-a','fixture','PAID','ZAR',1500,'2026-10-01','2026-10-01',now()),
    ('usd','B','org-a','fixture','PAID','USD',200,'2026-10-01','2026-10-01',now()),
    ('foreign','C','org-b','fixture','PAID','ZAR',9000,'2026-10-01','2026-10-01',now())`);
  await pool.query(`INSERT INTO "PublicApiRequest"(id,"orgId","principalType","principalId",route,method,"statusCode","createdAt","updatedAt")VALUES('ok','org-a','user','person','/safe','GET',200,'2026-10-01',now()),('failed','org-a','user','person','/safe','GET',503,'2026-10-01',now()),('foreign-api','org-b','user','person','/safe','GET',503,'2026-10-01',now());
   INSERT INTO "CreditUsageEvent"(id,"accountId","orgId","actionKey","creditsCharged",status,"createdAt")VALUES('credit','fixture','org-a','send',12,'charged','2026-10-01');
   INSERT INTO "BillingCheckout"(id,reference,"orgId","planId","userId",email,provider,status,"createdAt","updatedAt")VALUES('checkout','fixture','org-a','plan','person','private@example.test','fixture','FAILED','2026-10-01',now());
   INSERT INTO "OrganizationSubscription"(id,"orgId","planId",status,"updatedAt")VALUES('subscription','org-a','plan','ACTIVE',now())`);
  const q=parseAdminReportQuery({start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z",organizationId:"org-a",pageSize:1});
  const report=await growthAdminReport(pool,q);
  for(const search of ["a","org-a"]){const found=await growthAdminReport(pool,{...q,organizationId:undefined,view:"customers",customerSearch:search,pageSize:1});assert.deepEqual(found.records.map(row=>row.id),["org-a"]);}
  for(const search of ["%","_","' OR true --"]){assert.equal((await growthAdminReport(pool,{...q,organizationId:undefined,view:"customers",customerSearch:search})).records.length,0);}
  assert.equal((await growthAdminReport(pool,{...q,organizationId:"org-b",view:"customers",customerSearch:"org-a"})).records.length,0);
  assert.throws(()=>parseAdminReportQuery({customerSearch:"a"}),/Invalid customer search/);
  assert.throws(()=>parseAdminReportQuery({view:"customers",customerSearch:"a".repeat(101)}),/Invalid customer search/);

  assert.equal(report.metrics.find(m=>m.key==="organizations")?.value,"1");
  assert.equal(report.metrics.find(m=>m.key==="operations")?.value,"7");
  assert.deepEqual(report.metrics.filter(m=>m.key==="paid").map(m=>[m.currency,m.value]),[["USD","200"],["ZAR","1500"]]);
  assert.equal(report.metrics.find(m=>m.key==="refunds")?.value,null);
  assert.equal(report.metrics.find(m=>m.key==="outstanding")?.value,null);
  assert.equal(report.metrics.find(m=>m.key==="outstanding")?.availability,"unsupported");
  assert.equal(report.metrics.find(m=>m.key==="outstanding")?.reason,"Current unpaid invoice balance is not recorded by Growth billing");
  assert.equal(report.hasMore,true);assert.equal(report.records.length,1);
  assert(!JSON.stringify(report).includes("person@example"));
  assert.equal(report.metrics.find(m=>m.key==="operations")?.detailSupported,true);
  assert.equal(report.metrics.find(m=>m.key==="refunds")?.detailSupported,undefined);
  const detail=async(metric:string,dimensions:Record<string,string>={},page=1)=>growthAdminReport(pool,{...q,page,detail:{metric,dimensions}});
  const operations=await detail("operations",{productKey:"growth",metricKey:"send"});
  assert.deepEqual(operations.records.map(r=>[r.id,r.kind,r.organizationId]),[["event-a","usage","org-a"]]);
  assert.equal((await detail("operations",{productKey:"growth",metricKey:"missing"})).records.length,0);
  assert.equal((await detail("operations",{productKey:"growth",metricKey:"send",unknown:"ignored?"})).records.length,0);
  assert.deepEqual((await detail("paid",{currency:"ZAR"})).records.map(r=>r.id),["zar"]);
  assert.deepEqual((await detail("invoiced",{currency:"USD"})).records.map(r=>r.id),["usd"]);
  assert.equal((await detail("paid",{currency:"ZAR' OR 1=1 --"})).records.length,0);
  assert.equal((await detail("paid",{currency:"ZAR"},2)).records.length,0);
  assert.deepEqual((await detail("memberships")).records.map(r=>[r.id,r.kind]),[["member","membership"]]);
  assert.deepEqual((await detail("active_organizations")).records.map(r=>r.id),["org-a"]);
  assert.equal((await detail("new_organizations")).records.length,0);
  assert.deepEqual((await detail("organizations")).records.map(r=>r.id),["org-a"]);
  assert.deepEqual((await detail("api_failures")).records.map(r=>[r.id,r.state]),[["failed","503"]]);
  assert.deepEqual((await detail("credits")).records.map(r=>r.id),["credit"]);
  assert.deepEqual((await detail("payment_failures")).records.map(r=>r.id),["checkout"]);
  assert.deepEqual((await detail("subscriptions",{state:"ACTIVE",planId:"plan"})).records.map(r=>r.id),["subscription"]);
  assert.equal((await detail("subscriptions",{state:"ACTIVE",planId:"other"})).records.length,0);
  assert(!JSON.stringify(await detail("payment_failures")).includes("private@example.test"));
  assert.equal((await detail("refunds")).records.length,0);
  assert.equal((await detail('"BillingInvoice"; DROP TABLE "User"')).records.length,0);
  const outside=await growthAdminReport(pool,{...q,start:"2026-10-02T00:00:00Z",end:"2026-10-03T00:00:00Z",detail:{metric:"operations",dimensions:{productKey:"growth",metricKey:"send"}}});
  assert.equal(outside.records.length,0);


  const path="/api/admin/reporting?"+new URLSearchParams({start:q.start,end:q.end,organizationId:"org-a"});
  assert.equal((await app.inject(path)).statusCode,401);
  const token=await createAdminSession(core,"reader");
  const response=await app.inject({url:path,headers:{cookie:`kasitek_admin_session=${token}`}});
  assert.equal(response.statusCode,200);assert.equal(response.json().product,"growth");
  assert.equal((await app.inject({url:path+"&pageSize=1000",headers:{cookie:`kasitek_admin_session=${token}`}})).statusCode,400);
  const owner=await createAdminSession(core,"owner");const other=await createAdminSession(core,"other");
  const headers={cookie:`kasitek_admin_session=${owner}`,origin:"http://localhost:3001"};
  const config={definitionVersion:"1",product:"growth",domain:"revenue",start:q.start,end:q.end,timezone:q.timezone,organizationId:"org-a",pageSize:50};
  const saved=await app.inject({method:"POST",url:"/api/admin/reports",headers,payload:{name:"Scoped revenue",reportKey:"cross-product",config}});
  assert.equal(saved.statusCode,201,saved.body);
  const foreign=await app.inject({url:"/api/admin/reports",headers:{cookie:`kasitek_admin_session=${other}`}});
  assert.equal(foreign.json().saved.length,0);
  const id=randomUUID(),scope={...q,product:"growth",domain:"revenue"};
  const audit=(status:string,cookie=owner)=>app.inject({method:"POST",url:"/api/admin/reporting/export/audit",headers:{...headers,cookie:`kasitek_admin_session=${cookie}`},payload:{id,status,scope}});
  assert.equal((await audit("REQUESTED",token)).statusCode,403);
  const started=await audit("REQUESTED");assert.equal(started.statusCode,200,started.body);
  assert.equal((await audit("SUCCEEDED",other)).statusCode,409);
  assert.equal((await audit("SUCCEEDED")).statusCode,200);
  assert.equal((await audit("FAILED")).statusCode,409);
  const event=(await pool.query('SELECT status,scope FROM "AdminReportExportAuditEvent" WHERE id=$1',[id])).rows[0];
  assert.equal(event.status,"SUCCEEDED");assert.equal(event.scope.organizationId,"org-a");

 }finally{await app.close();await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
