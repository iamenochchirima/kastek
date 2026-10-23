import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import {growthAdminReport} from "../src/services/admin/reporting-source.js";
import {registerAdminReportingRoutes} from "../src/routes/admin-reporting.js";
import {createAdminSession} from "../src/identity/admin-session.js";
import {readConfig} from "../src/config.js";
import {installErrorHandler} from "../src/error.js";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
const url=process.env.ADMIN_REPORTING_TEST_DATABASE_URL;
test("Growth reporting reconciles scoped records and currencies through authorized HTTP",{skip:!url},async()=>{
 const schema="reporting_"+randomUUID().replaceAll("-","");
 const pool=new pg.Pool({connectionString:url,max:1});const app=Fastify();
 try {
  await pool.query(`CREATE SCHEMA ${schema}`);await pool.query(`SET search_path TO ${schema},public`);
  for(const table of ["Organization","OrganizationMember","User","UsageEvent","Conversation","CreditUsageEvent","BillingInvoice","AdminUser","AdminSession"])
   await pool.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
  await pool.query(`INSERT INTO "AdminUser"(id,name,email,password,role,"updatedAt")VALUES('reader','Reader','reader@example.test','unused','viewer',now());
   INSERT INTO "User"(id,name,email,"updatedAt")VALUES('person','Person','person@example.test',now());
   INSERT INTO "Organization"(id,name,slug,"ownerId","updatedAt")VALUES('org-a','A','a','person',now()),('org-b','B','b','person',now());
   INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt")VALUES('member','org-a','person','OWNER',now());
   INSERT INTO "UsageEvent"(id,"orgId","productKey","metricKey",quantity,"occurredAt")VALUES('event-a','org-a','growth','send',7,'2026-10-01'),('event-b','org-b','growth','send',9,'2026-10-01');
   INSERT INTO "BillingInvoice"(id,"invoiceNumber","orgId",provider,status,currency,"amountMinor","issuedAt","paidAt","updatedAt")VALUES
    ('zar','A','org-a','fixture','PAID','ZAR',1500,'2026-10-01','2026-10-01',now()),
    ('usd','B','org-a','fixture','PAID','USD',200,'2026-10-01','2026-10-01',now()),
    ('foreign','C','org-b','fixture','PAID','ZAR',9000,'2026-10-01','2026-10-01',now())`);
  const q=parseAdminReportQuery({start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z",organizationId:"org-a",pageSize:1});
  const report=await growthAdminReport(pool,q);
  assert.equal(report.metrics.find(m=>m.key==="organizations")?.value,"1");
  assert.equal(report.metrics.find(m=>m.key==="operations")?.value,"7");
  assert.deepEqual(report.metrics.filter(m=>m.key==="paid").map(m=>[m.currency,m.value]),[["USD","200"],["ZAR","1500"]]);
  assert.equal(report.metrics.find(m=>m.key==="refunds")?.value,null);
  assert.equal(report.hasMore,true);assert.equal(report.records.length,1);
  assert(!JSON.stringify(report).includes("person@example"));
  const core={pool,config:readConfig({DATABASE_URL:url})};
  await app.register(cookie);installErrorHandler(app);registerAdminReportingRoutes(app,core);
  const path="/api/admin/reporting?"+new URLSearchParams({start:q.start,end:q.end,organizationId:"org-a"});
  assert.equal((await app.inject(path)).statusCode,401);
  const token=await createAdminSession(core,"reader");
  const response=await app.inject({url:path,headers:{cookie:`kasitek_admin_session=${token}`}});
  assert.equal(response.statusCode,200);assert.equal(response.json().product,"growth");
  assert.equal((await app.inject({url:path+"&pageSize=1000",headers:{cookie:`kasitek_admin_session=${token}`}})).statusCode,400);
 }finally{await app.close();await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await pool.end();}
});
