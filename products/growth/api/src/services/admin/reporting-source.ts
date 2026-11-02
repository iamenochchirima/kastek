import type {Pool,PoolClient} from "pg";
import type {AdminProductReport,AdminReportQuery} from "@kasitek-labs/contracts";
import {ADMIN_REPORT_METRICS} from "@kasitek-labs/contracts";
import {adminReportSnapshot,reportMetric} from "@kasitek-labs/server-support/admin-reporting";


// Only these product-owned projections may back a metric drill-down. All inputs are bound values.
const growthDetailDefinitions = {
 organizations:{table:'"Organization"',org:'id',time:'"createdAt"',state:"'current'",kind:"organization",period:false},
 new_organizations:{table:'"Organization"',org:'id',time:'"createdAt"',state:"'current'",kind:"organization",period:true},
 memberships:{table:'"OrganizationMember"',org:'"orgId"',time:'"createdAt"',state:'role::text',kind:"membership",period:false},
 active_organizations:{table:'"Organization"',org:'id',time:'"createdAt"',state:"'active'",kind:"organization",period:false,where:'EXISTS (SELECT 1 FROM "UsageEvent" u WHERE u."orgId"="Organization".id AND u."occurredAt">=$1 AND u."occurredAt"<$2)'},
 credits:{table:'"CreditUsageEvent"',org:'"orgId"',time:'"createdAt"',state:'status',kind:"credit_usage",period:true},
 operations:{table:'"UsageEvent"',org:'"orgId"',time:'"occurredAt"',state:'"metricKey"',kind:"usage",period:true,dimensions:{productKey:'"productKey"',metricKey:'"metricKey"'}},
 api_requests:{table:'"PublicApiRequest"',org:'"orgId"',time:'"createdAt"',state:'"statusCode"::text',kind:"api_request",period:true},
 api_failures:{table:'"PublicApiRequest"',org:'"orgId"',time:'"createdAt"',state:'"statusCode"::text',kind:"api_request",period:true,where:'"statusCode">=500'},
 payment_failures:{table:'"BillingCheckout"',org:'"orgId"',time:'"createdAt"',state:'status',kind:"billing_checkout",period:true,where:"status IN ('FAILED','ABANDONED')"},
 subscriptions:{table:'"OrganizationSubscription"',org:'"orgId"',time:'"createdAt"',state:'status::text',kind:"subscription",period:false,dimensions:{state:'status::text',planId:'"planId"'}},
 invoiced:{table:'"BillingInvoice"',org:'"orgId"',time:'"issuedAt"',state:'status',kind:"billing_invoice",period:true,where:"status NOT IN ('DRAFT','VOID')",dimensions:{currency:'currency'}},
 paid:{table:'"BillingInvoice"',org:'"orgId"',time:'"paidAt"',state:'status',kind:"billing_invoice",period:true,where:"status='PAID'",dimensions:{currency:'currency'}},
} satisfies Record<string,{table:string;org:string;time:string;state:string;kind:string;period:boolean;where?:string;dimensions?:Record<string,string>}>;
async function growthMetricRecords(db:PoolClient,q:AdminReportQuery){
 const detail=q.detail!;
 if(!Object.hasOwn(growthDetailDefinitions,detail.metric))return [];
 const d:growthDetailDefinition=growthDetailDefinitions[detail.metric as keyof typeof growthDetailDefinitions];
 const dimensions=d.dimensions??{};
 if(Object.keys(detail.dimensions).length!==Object.keys(dimensions).length||Object.keys(dimensions).some(key=>!Object.hasOwn(detail.dimensions,key)))return [];
 const args:unknown[]=[q.start,q.end,q.organizationId??null];
 const filters=[`($3::text IS NULL OR ${d.org}=$3)`,...(d.period?[`${d.time}>=$1 AND ${d.time}<$2`]:['$1::timestamptz IS NOT NULL AND $2::timestamptz IS NOT NULL']),...(d.where?[d.where]:[])];
 for(const [key,column] of Object.entries(dimensions)){args.push(detail.dimensions[key]);filters.push(`${column}=$${args.length}`);}
 args.push(q.pageSize+1,(q.page-1)*q.pageSize);
 return (await db.query(`SELECT id,${d.org} AS "orgId",${d.state} AS status,${d.time} AS "issuedAt",$${args.length+1}::text AS kind FROM ${d.table} WHERE ${filters.join(' AND ')} ORDER BY ${d.time} DESC,id LIMIT $${args.length-1} OFFSET $${args.length}`,[...args,d.kind])).rows;
}
type growthDetailDefinition={table:string;org:string;time:string;state:string;kind:string;period:boolean;where?:string;dimensions?:Record<string,string>};

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
   (SELECT max("updatedAt") FROM "Organization" WHERE ($3::text IS NULL OR id=$3)) AS organizations_observed,
   (SELECT max("updatedAt") FROM "OrganizationMember" WHERE ($3::text IS NULL OR "orgId"=$3)) AS memberships_observed,
   (SELECT max("updatedAt") FROM "Conversation" WHERE ($3::text IS NULL OR "orgId"=$3)) AS conversations_observed,
   (SELECT max("createdAt") FROM "CreditUsageEvent" WHERE ($3::text IS NULL OR "orgId"=$3)) AS credits_observed,
   (SELECT max("occurredAt") FROM "UsageEvent" WHERE ($3::text IS NULL OR "orgId"=$3)) AS observed`,args)).rows[0];
  const observed=counts.observed?.toISOString()??null;
  const source="growth.authoritative_records";
  const metrics=Object.entries(counts).filter(([key])=>key!=="observed"&&!key.endsWith("_observed")).map(([key,value])=>reportMetric(key,String(value),source,
   (counts[(key==="new_organizations"?"organizations":key)+"_observed"]??(key==="active_organizations"?counts.observed:null))?.toISOString()??null,
   key==="active_organizations"?{reason:"Organizations with recorded UsageEvent activity"}:{}));
  const usage=(await db.query(`SELECT "productKey","metricKey",sum(quantity)::text AS value,max("occurredAt") AS observed FROM "UsageEvent"
   WHERE "occurredAt">=$1 AND "occurredAt"<$2 AND ($3::text IS NULL OR "orgId"=$3)
   GROUP BY "productKey","metricKey" ORDER BY "productKey","metricKey" LIMIT 101`,args)).rows;
  for(const row of usage.slice(0,100))metrics.push(reportMetric("operations",row.value,"growth.UsageEvent",row.observed?.toISOString()??null,
   {dimensions:{productKey:row.productKey,metricKey:row.metricKey},...(usage.length>100?{availability:"partial" as const,reason:"First 100 metric dimensions"}:{})}));
  const money=(await db.query(`SELECT currency,
   coalesce(sum("amountMinor") FILTER(WHERE status NOT IN ('DRAFT','VOID') AND "issuedAt">=$1 AND "issuedAt"<$2),0)::text AS invoiced,
   coalesce(sum("amountMinor") FILTER(WHERE status='PAID' AND "paidAt">=$1 AND "paidAt"<$2),0)::text AS paid,
   count(*) FILTER(WHERE "amountMinor" IS NULL)::text AS unknown_amounts,max("updatedAt") AS observed
   FROM "BillingInvoice" WHERE ($3::text IS NULL OR "orgId"=$3) GROUP BY currency ORDER BY currency`,args)).rows;
  for(const row of money)for(const key of ["invoiced","paid"])metrics.push(reportMetric(key,row[key],"growth.BillingInvoice",row.observed?.toISOString()??null,
   {currency:row.currency,...(row.unknown_amounts!=="0"?{availability:"partial" as const,reason:"Some invoice amounts are unknown"}:{})}));
  const extra=(await db.query(`SELECT
   (SELECT count(*) FROM "PublicApiRequest" WHERE "createdAt">=$1 AND "createdAt"<$2 AND ($3::text IS NULL OR "orgId"=$3)) AS api_requests,
   (SELECT count(*) FROM "PublicApiRequest" WHERE "createdAt">=$1 AND "createdAt"<$2 AND "statusCode">=500 AND ($3::text IS NULL OR "orgId"=$3)) AS api_failures,
   (SELECT count(*) FROM "BillingCheckout" WHERE "createdAt">=$1 AND "createdAt"<$2 AND status IN ('FAILED','ABANDONED') AND ($3::text IS NULL OR "orgId"=$3)) AS payment_failures,
   (SELECT max("createdAt") FROM "PublicApiRequest" WHERE ($3::text IS NULL OR "orgId"=$3)) AS api_observed,
   (SELECT max("updatedAt") FROM "BillingCheckout" WHERE ($3::text IS NULL OR "orgId"=$3)) AS payments_observed`,args)).rows[0];
  for(const key of ["api_requests","api_failures","payment_failures"])metrics.push(reportMetric(key,String(extra[key]),
   key==="payment_failures"?"growth.BillingCheckout":"growth.PublicApiRequest",(key==="payment_failures"?extra.payments_observed:extra.api_observed)?.toISOString()??null));
  const subscriptions=(await db.query(`SELECT status::text,"planId",count(*)::text AS count,max("updatedAt") AS observed
   FROM "OrganizationSubscription" WHERE ($1::text IS NULL OR "orgId"=$1) GROUP BY status,"planId" ORDER BY status,"planId" LIMIT 101`,[q.organizationId??null])).rows;
  for(const row of subscriptions.slice(0,100))metrics.push(reportMetric("subscriptions",row.count,"growth.OrganizationSubscription",row.observed?.toISOString()??null,
   {dimensions:{state:row.status,planId:row.planId},...(subscriptions.length>100?{availability:"partial" as const,reason:"First 100 plan dimensions"}:{})}));
  for(const definition of ADMIN_REPORT_METRICS)if(!metrics.some(m=>m.key===definition.key))metrics.push(reportMetric(definition.key,null,source,null,
   {reason:definition.key==="active_users"?"Usage records do not establish human actor identity":definition.key==="refunds"?"Refund amount and time are not recorded":definition.key==="outstanding"?"Current unpaid invoice balance is not recorded by Growth billing": "Not authoritative in this source"}));
  for(const metric of metrics)if(metric.value!==null&&Object.hasOwn(growthDetailDefinitions,metric.key))metric.detailSupported=true;
  const records=q.detail?await growthMetricRecords(db,q):(await db.query(`SELECT id,"orgId",status,"issuedAt" FROM "BillingInvoice" WHERE "issuedAt">=$1 AND "issuedAt"<$2
   AND ($3::text IS NULL OR "orgId"=$3) ORDER BY "issuedAt" DESC,id LIMIT $4 OFFSET $5`,[...args,q.pageSize+1,(q.page-1)*q.pageSize])).rows;
  if(!q.detail&&q.view==="customers"){
   const customers=(await db.query(`SELECT id,name,"createdAt" FROM "Organization" WHERE ($1::text IS NULL OR id=$1) AND ($4::text IS NULL OR id=$4 OR strpos(lower(name),lower($4))>0) ORDER BY "createdAt" DESC,id LIMIT $2 OFFSET $3`,[q.organizationId??null,q.pageSize+1,(q.page-1)*q.pageSize,q.customerSearch||null])).rows;
   records.splice(0,records.length,...customers.map(row=>({id:row.id,orgId:row.id,status:"current",issuedAt:row.createdAt,label:row.name})));
  }
  return {contractVersion:"1",product:"growth",query:q,generatedAt:new Date().toISOString(),sourceObservedAt:metrics.reduce<string|null>((last,m)=>m.observedAt&&(!last||m.observedAt>last)?m.observedAt:last,null),completeThrough:null,
   availability:"partial",metrics,records:records.slice(0,q.pageSize).map(row=>({id:row.id,organizationId:row.orgId,kind:row.kind??(q.view==="customers"?"organization":"billing_invoice"),...(row.label?{label:row.label}:{}),state:row.status,occurredAt:row.issuedAt.toISOString()})),hasMore:records.length>q.pageSize};
 });
}
