import type {Pool} from "pg";
import type {AdminProductReport,AdminReportQuery} from "@kasitek-labs/contracts";
import {ADMIN_REPORT_METRICS} from "@kasitek-labs/contracts";
import {adminReportSnapshot,reportMetric} from "@kasitek-labs/server-support/admin-reporting";
export async function agencyAdminReport(pool:Pool,q:AdminReportQuery):Promise<AdminProductReport> {
 return adminReportSnapshot(pool,async db=>{
  const args=[q.start,q.end,q.organizationId??null];
  const row=(await db.query(`SELECT
   (SELECT count(*) FROM workspaces WHERE ($3::text IS NULL OR id=$3)) AS organizations,
   (SELECT count(*) FROM workspaces WHERE ($3::text IS NULL OR id=$3) AND created_at>=$1 AND created_at<$2) AS new_organizations,
   (SELECT count(*) FROM tenant_users WHERE status='active' AND ($3::text IS NULL OR workspace_id=$3)) AS memberships,
   (SELECT count(DISTINCT workspace_id) FROM workspace_usage_events WHERE created_at>=$1 AND created_at<$2 AND ($3::text IS NULL OR workspace_id=$3)) AS active_organizations,
   (SELECT max(created_at) FROM workspace_usage_events WHERE ($3::text IS NULL OR workspace_id=$3)) AS observed`,args)).rows[0];
  const observed=row.observed?.toISOString()??null;
  const metrics=Object.entries(row).filter(([key])=>key!=="observed").map(([key,value])=>reportMetric(key,String(value),"agency.authoritative_records",observed,
   key==="active_organizations"?{reason:"Workspaces with recorded workspace_usage_events"}:{}));
  const usage=(await db.query(`SELECT event_type,coalesce(provider,'none') AS provider,sum(quantity)::text AS value,max(created_at) AS observed
   FROM workspace_usage_events WHERE created_at>=$1 AND created_at<$2 AND ($3::text IS NULL OR workspace_id=$3)
   GROUP BY event_type,provider ORDER BY event_type,provider LIMIT 101`,args)).rows;
  for(const item of usage.slice(0,100))metrics.push(reportMetric("operations",item.value,"agency.workspace_usage_events",item.observed?.toISOString()??null,
   {dimensions:{eventType:item.event_type,provider:item.provider},...(usage.length>100?{availability:"partial" as const,reason:"First 100 metric dimensions"}:{})}));
  for(const definition of ADMIN_REPORT_METRICS)if(!metrics.some(m=>m.key===definition.key))metrics.push(reportMetric(definition.key,null,"agency",null,{reason:"No authoritative measurement in this source"}));
  const records=(await db.query(`SELECT id,workspace_id,event_type,created_at FROM workspace_usage_events WHERE created_at>=$1 AND created_at<$2
   AND ($3::text IS NULL OR workspace_id=$3) ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,[...args,q.pageSize+1,(q.page-1)*q.pageSize])).rows;
  return {contractVersion:"1",product:"agency",query:q,generatedAt:new Date().toISOString(),sourceObservedAt:observed,completeThrough:null,
   availability:"partial",metrics,records:records.slice(0,q.pageSize).map(item=>({id:item.id,organizationId:item.workspace_id,kind:"usage",state:item.event_type,occurredAt:item.created_at.toISOString()})),hasMore:records.length>q.pageSize};
 });
}
