import type {Pool} from "pg";
import type {AdminProductReport,AdminReportQuery} from "@kasitek-labs/contracts";
import {ADMIN_REPORT_METRICS} from "@kasitek-labs/contracts";
import {adminReportSnapshot,reportMetric} from "@kasitek-labs/server-support/admin-reporting";

export async function growthAdminReport(pool:Pool,q:AdminReportQuery):Promise<AdminProductReport> {
 return adminReportSnapshot(pool,async db=>{
  const args=[q.start,q.end,q.organizationId??null];
  const counts=(await db.query(`SELECT
   (SELECT count(*) FROM "Organization" WHERE ($3::text IS NULL OR id=$3)) AS organizations,
   (SELECT count(*) FROM "Organization" WHERE ($3::text IS NULL OR id=$3) AND "createdAt">=$1 AND "createdAt"<$2) AS new_organizations,
   (SELECT count(*) FROM "OrganizationMember" WHERE ($3::text IS NULL OR "orgId"=$3)) AS memberships,
   (SELECT count(DISTINCT "orgId") FROM "UsageEvent" WHERE ($3::text IS NULL OR "orgId"=$3) AND "occurredAt">=$1 AND "occurredAt"<$2) AS active_organizations,
   (SELECT count(*) FROM "Conversation" WHERE ($3::text IS NULL OR "orgId"=$3) AND "createdAt">=$1 AND "createdAt"<$2) AS conversations,
   (SELECT coalesce(sum("creditsCharged"),0) FROM "CreditUsageEvent" WHERE ($3::text IS NULL OR "orgId"=$3) AND "createdAt">=$1 AND "createdAt"<$2) AS credits,
   (SELECT max("occurredAt") FROM "UsageEvent" WHERE ($3::text IS NULL OR "orgId"=$3)) AS observed`,args)).rows[0];
  const observed=counts.observed?.toISOString()??null;
  const source="growth.authoritative_records";
  const metrics=Object.entries(counts).filter(([key])=>key!=="observed").map(([key,value])=>reportMetric(key,String(value),source,observed,
   key==="active_organizations"?{reason:"Organizations with recorded UsageEvent activity"}:{}));
  const usage=(await db.query(`SELECT "productKey","metricKey",sum(quantity)::text AS value,max("occurredAt") AS observed FROM "UsageEvent"
   WHERE "occurredAt">=$1 AND "occurredAt"<$2 AND ($3::text IS NULL OR "orgId"=$3)
   GROUP BY "productKey","metricKey" ORDER BY "productKey","metricKey" LIMIT 101`,args)).rows;
  for(const row of usage.slice(0,100))metrics.push(reportMetric("operations",row.value,"growth.UsageEvent",row.observed?.toISOString()??null,
   {dimensions:{productKey:row.productKey,metricKey:row.metricKey},...(usage.length>100?{availability:"partial" as const,reason:"First 100 metric dimensions"}:{})}));
  const money=(await db.query(`SELECT currency,
   coalesce(sum("amountMinor") FILTER(WHERE status NOT IN ('DRAFT','VOID') AND "issuedAt">=$1 AND "issuedAt"<$2),0)::text AS invoiced,
   coalesce(sum("amountMinor") FILTER(WHERE status='PAID' AND "paidAt">=$1 AND "paidAt"<$2),0)::text AS paid,
   coalesce(sum("amountMinor") FILTER(WHERE status IN ('OPEN','PENDING','UNPAID','OVERDUE')),0)::text AS outstanding,
   count(*) FILTER(WHERE "amountMinor" IS NULL)::text AS unknown_amounts,max("updatedAt") AS observed
   FROM "BillingInvoice" WHERE ($3::text IS NULL OR "orgId"=$3) GROUP BY currency ORDER BY currency`,args)).rows;
  for(const row of money)for(const key of ["invoiced","paid"])metrics.push(reportMetric(key,row[key],"growth.BillingInvoice",row.observed?.toISOString()??null,
   {currency:row.currency,...(row.unknown_amounts!=="0"?{availability:"partial" as const,reason:"Some invoice amounts are unknown"}:{})}));
  for(const definition of ADMIN_REPORT_METRICS)if(!metrics.some(m=>m.key===definition.key))metrics.push(reportMetric(definition.key,null,source,null,
   {reason:definition.key==="active_users"?"Usage records do not establish human actor identity":definition.key==="refunds"?"Refund amount and time are not recorded": "Not authoritative in this source"}));
  const records=(await db.query(`SELECT id,"orgId",status,"issuedAt" FROM "BillingInvoice" WHERE "issuedAt">=$1 AND "issuedAt"<$2
   AND ($3::text IS NULL OR "orgId"=$3) ORDER BY "issuedAt" DESC,id LIMIT $4 OFFSET $5`,[...args,q.pageSize+1,(q.page-1)*q.pageSize])).rows;
  return {contractVersion:"1",product:"growth",query:q,generatedAt:new Date().toISOString(),sourceObservedAt:observed,completeThrough:null,
   availability:"partial",metrics,records:records.slice(0,q.pageSize).map(row=>({id:row.id,organizationId:row.orgId,kind:"billing_invoice",state:row.status,occurredAt:row.issuedAt.toISOString()})),hasMore:records.length>q.pageSize};
 });
}
