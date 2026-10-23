import type {Pool,PoolClient} from "pg";
import type {AdminProductReport,AdminReportQuery} from "@kasitek-labs/contracts";
import {ADMIN_REPORT_METRICS} from "@kasitek-labs/contracts";
import {adminReportSnapshot,reportMetric} from "@kasitek-labs/server-support/admin-reporting";

const agencyDetailDefinitions={
 organizations:{table:"workspaces",org:"id",state:"status",kind:"workspace",period:false},
 new_organizations:{table:"workspaces",org:"id",state:"status",kind:"workspace",period:true},
 clients:{table:"tenant_clients",org:"workspace_id",state:"status",kind:"client",period:false,where:"status='active'"},
 memberships:{table:"tenant_users",org:"workspace_id",state:"status",kind:"membership",period:false,where:"status='active'"},
 active_organizations:{table:"workspaces",org:"id",state:"status",kind:"workspace",period:false,where:"EXISTS (SELECT 1 FROM workspace_usage_events u WHERE u.workspace_id=workspaces.id AND u.created_at>=$1 AND u.created_at<$2)"},
 operations:{table:"workspace_usage_events",org:"workspace_id",state:"event_type",kind:"usage",period:true,dimensions:{eventType:"event_type",provider:"coalesce(provider,'none')"}},
} satisfies Record<string,{table:string;org:string;state:string;kind:string;period:boolean;where?:string;dimensions?:Record<string,string>}>;
async function agencyMetricRecords(db:PoolClient,q:AdminReportQuery){
 const detail=q.detail!;
 if(!Object.hasOwn(agencyDetailDefinitions,detail.metric))return [];
 const d:agencyDetailDefinition=agencyDetailDefinitions[detail.metric as keyof typeof agencyDetailDefinitions];
 const dimensions=d.dimensions??{};
 if(Object.keys(detail.dimensions).length!==Object.keys(dimensions).length||Object.keys(dimensions).some(key=>!Object.hasOwn(detail.dimensions,key)))return [];
 const args:unknown[]=[q.start,q.end,q.organizationId??null];
 const filters=[`($3::text IS NULL OR ${d.org}=$3)`,...(d.period?['created_at>=$1 AND created_at<$2']:['$1::timestamptz IS NOT NULL AND $2::timestamptz IS NOT NULL']),...(d.where?[d.where]:[])];
 for(const [key,column] of Object.entries(dimensions)){args.push(detail.dimensions[key]);filters.push(`${column}=$${args.length}`);}
 args.push(q.pageSize+1,(q.page-1)*q.pageSize);
 return (await db.query(`SELECT id,${d.org} AS workspace_id,${d.state} AS event_type,created_at,$${args.length+1}::text AS kind FROM ${d.table} WHERE ${filters.join(' AND ')} ORDER BY created_at DESC,id LIMIT $${args.length-1} OFFSET $${args.length}`,[...args,d.kind])).rows;
}
type agencyDetailDefinition={table:string;org:string;state:string;kind:string;period:boolean;where?:string;dimensions?:Record<string,string>};

export async function agencyAdminReport(pool:Pool,q:AdminReportQuery):Promise<AdminProductReport> {
 return adminReportSnapshot(pool,async db=>{
  const args=[q.start,q.end,q.organizationId??null];
  const row=(await db.query(`SELECT
   (SELECT count(*) FROM workspaces WHERE ($3::text IS NULL OR id=$3)) AS organizations,
   (SELECT count(*) FROM workspaces WHERE ($3::text IS NULL OR id=$3) AND created_at>=$1 AND created_at<$2) AS new_organizations,
   (SELECT count(*) FROM tenant_clients WHERE status='active' AND ($3::text IS NULL OR workspace_id=$3)) AS clients,
   (SELECT count(*) FROM tenant_users WHERE status='active' AND ($3::text IS NULL OR workspace_id=$3)) AS memberships,
   (SELECT count(DISTINCT workspace_id) FROM workspace_usage_events WHERE created_at>=$1 AND created_at<$2 AND ($3::text IS NULL OR workspace_id=$3)) AS active_organizations,
   (SELECT max(updated_at) FROM workspaces WHERE ($3::text IS NULL OR id=$3)) AS organizations_observed,
   (SELECT max(updated_at) FROM tenant_users WHERE ($3::text IS NULL OR workspace_id=$3)) AS memberships_observed,
   (SELECT max(updated_at) FROM tenant_clients WHERE ($3::text IS NULL OR workspace_id=$3)) AS clients_observed,
   (SELECT max(created_at) FROM workspace_usage_events WHERE ($3::text IS NULL OR workspace_id=$3)) AS observed`,args)).rows[0];
  const observed=row.observed?.toISOString()??null;
  const metrics=Object.entries(row).filter(([key])=>key!=="observed"&&!key.endsWith("_observed")).map(([key,value])=>reportMetric(key,String(value),"agency.authoritative_records",
   (row[(key==="new_organizations"?"organizations":key)+"_observed"]??(key==="active_organizations"?row.observed:null))?.toISOString()??null,
   key==="active_organizations"?{reason:"Workspaces with recorded workspace_usage_events"}:{}));
  const usage=(await db.query(`SELECT event_type,coalesce(provider,'none') AS provider,sum(quantity)::text AS value,max(created_at) AS observed
   FROM workspace_usage_events WHERE created_at>=$1 AND created_at<$2 AND ($3::text IS NULL OR workspace_id=$3)
   GROUP BY event_type,coalesce(provider,'none') ORDER BY event_type,provider LIMIT 101`,args)).rows;
  for(const item of usage.slice(0,100))metrics.push(reportMetric("operations",item.value,"agency.workspace_usage_events",item.observed?.toISOString()??null,
   {dimensions:{eventType:item.event_type,provider:item.provider},...(usage.length>100?{availability:"partial" as const,reason:"First 100 metric dimensions"}:{})}));
  for(const definition of ADMIN_REPORT_METRICS)if(!metrics.some(m=>m.key===definition.key))metrics.push(reportMetric(definition.key,null,"agency",null,{reason:"No authoritative measurement in this source"}));
  for(const metric of metrics)if(metric.value!==null&&Object.hasOwn(agencyDetailDefinitions,metric.key))metric.detailSupported=true;
  const records=q.detail?await agencyMetricRecords(db,q):(await db.query(`SELECT id,workspace_id,event_type,created_at FROM workspace_usage_events WHERE created_at>=$1 AND created_at<$2
   AND ($3::text IS NULL OR workspace_id=$3) ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`,[...args,q.pageSize+1,(q.page-1)*q.pageSize])).rows;
  if(!q.detail&&q.view==="customers"){
   const customers=(await db.query(`SELECT id,display_name,status,created_at FROM workspaces WHERE ($1::text IS NULL OR id=$1) AND ($4::text IS NULL OR id=$4 OR strpos(lower(display_name),lower($4))>0) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,[q.organizationId??null,q.pageSize+1,(q.page-1)*q.pageSize,q.customerSearch||null])).rows;
   records.splice(0,records.length,...customers.map(row=>({id:row.id,workspace_id:row.id,event_type:row.status,created_at:row.created_at,label:row.display_name})));
  }
  return {contractVersion:"1",product:"agency",query:q,generatedAt:new Date().toISOString(),sourceObservedAt:metrics.reduce<string|null>((last,m)=>m.observedAt&&(!last||m.observedAt>last)?m.observedAt:last,null),completeThrough:null,
   availability:"partial",metrics,records:records.slice(0,q.pageSize).map(item=>({id:item.id,organizationId:item.workspace_id,kind:item.kind??(q.view==="customers"?"workspace":"usage"),...(item.label?{label:item.label}:{}),state:item.event_type,occurredAt:item.created_at.toISOString()})),hasMore:records.length>q.pageSize};
 });
}
