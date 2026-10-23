import {randomUUID} from "node:crypto";
import type {FastifyInstance} from "fastify";
import type {AdminReportTrend} from "@kasitek-labs/contracts";
import {ADMIN_TREND_DOMAINS} from "@kasitek-labs/server-support/admin-reporting-trends";
import {parseAdminReportQuery} from "@kasitek-labs/server-support/admin-reporting";
import {verifyAdminAuthority,ADMIN_AUTHORITY_HEADER} from "@kasitek-labs/server-support/admin-authority";
import type {AnalyticsContext} from "./context.js";
import {executeReport,type ReportResponse} from "./reporting.js";
import {setAuthorizationContext} from "./authorization.js";
import type {ReportingGrant} from "./scope.js";

export const ADMIN_REPORTING_PATH="/v1/admin/reporting";
/** Platform admin aggregation reuses each scope's promoted generation and registered additive metrics. */
export function registerAdminReportingRoutes(app:FastifyInstance,context:AnalyticsContext) {
 app.get(ADMIN_REPORTING_PATH,async(request,reply)=>{
  const secret=context.config.admin_reporting_secret;
  const token=request.headers[ADMIN_AUTHORITY_HEADER];
  if(!secret)return reply.code(503).send({error:"Administrative reporting is not configured"});
  let actor;
  try{if(typeof token!=="string")throw Error();actor=verifyAdminAuthority(token,{secret,audience:"analytics",method:"GET",path:request.url,capability:"admin:report"});}
  catch{return reply.code(403).send({error:"Insufficient reporting authority"});}
  const params=new URL(request.url,"http://analytics").searchParams;
  if([...params.keys()].some(key=>params.getAll(key).length!==1))return reply.code(400).send({error:"Repeated filter"});
  const product=params.get("product"),identities=(params.get("metrics")??"").split(",");
  params.delete("product");params.delete("metrics");
  if(!["growth","agency","agents"].includes(product??"")||identities.length<1||identities.length>10||new Set(identities).size!==identities.length)return reply.code(400).send({error:"Invalid report selection"});
  let query;try{query=parseAdminReportQuery(Object.fromEntries(params));}catch{return reply.code(400).send({error:"Invalid report filters"});}
  const metrics=identities.map(identity=>context.registry.metrics.find(m=>`${m.key}@${m.version}`===identity));
  if(metrics.some(m=>!m||m.lifecycle!=="active"||m.privacy_class!=="aggregate"||!["sum","distinct_count"].includes(m.temporal_aggregation)||!["count","sum","distinct_count"].includes(m.default_aggregation)||!ADMIN_TREND_DOMAINS[m.key]||m.value_type!=="integer"))return reply.code(400).send({error:"Only registered additive integer metrics are supported"});
  const db=await context.pool.connect();
  const responses:ReportResponse[]=[];
  let included=0,total=0,descendantsCapped=false,reason:string|undefined;
  try{
   await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
   await db.query("SET LOCAL statement_timeout='2s'");
   const roots=(await db.query(`SELECT * FROM analytics.admin_reporting_roots($1,$2)`,[product,query.organizationId??null])).rows;
   total=Number(roots[0]?.total_count??0);
   const deadline=Date.now()+5500;
   for(const root of roots){
    if(Date.now()>deadline){reason="Reporting deadline reached";break;}
    if(root.reporting_timezone!==query.timezone){reason="Some scope timezones differ from the requested timezone";continue;}
    const applicable=metrics.filter(m=>m!.scope_kinds.includes(root.scope_kind));
    if(!applicable.length){reason="Metrics are unsupported for some scopes";continue;}
    const id=BigInt(root.scope_id),now=new Date();
    const ids=(root.authorized_scope_ids as (string|bigint)[]).map(value=>BigInt(value));
    if(Number(root.scope_count)>ids.length){descendantsCapped=true;reason="Descendant scope coverage is capped at 100 per root";}
    const includeDescendants=root.scope_kind==="tenant_workspace";
    const grant:ReportingGrant={grant_id:randomUUID(),issuer:"kasitek-admin",audience:"analytics",principal_type:"service_identity",principal_id:actor.id,
      scope_id:id,root_scope_id:id,descendant_mode:includeDescendants?"all":"none",explicit_descendant_scope_ids:[],permissions:new Set(includeDescendants?["analytics:read","analytics:compare_children"]:["analytics:read"]),
      metric_keys:applicable.map(m=>`${m!.key}@${m!.version}`),dimension_keys:[],policy_version:"admin-reporting-v1",issued_at:now,not_before:now,expires_at:new Date(now.getTime()+60000),correlation_id:request.id,revoked_at:null};
    await setAuthorizationContext(db,includeDescendants?ids:[id],grant.grant_id);
    responses.push(await executeReport(db,context.registry,grant,{requested_scope_id:id,authorized_scope_ids:includeDescendants?ids:[id],scope_kind:root.scope_kind,timezone:root.reporting_timezone},
      {reporting_scope_id:id,range_start:new Date(query.start),range_end:new Date(query.end),timezone:query.timezone,interval:"day",metrics:applicable.map(m=>`${m!.key}@${m!.version}`),metric_set:null,
       breakdowns:[],filters:{},include_descendants:includeDescendants,comparison:null}));
    included++;
   }
   const hasMore=included<total||descendantsCapped;
   if(hasMore&&!reason)reason="Root scope coverage is capped at 100";
   const trends:AdminReportTrend[]=metrics.map(def=>{
    const points=new Map<string,{start:string;end:string;value:bigint|null}>();
    let anyEvidence=false,partial=hasMore,observedAt:string|null=null,completeThrough:string|null=null,allComplete=true;
    for(const response of responses){
     const result=response.metrics.find(m=>m.key===def!.key);
     if(!result){partial=true;allComplete=false;continue;}
     if(result.availability.state==="available"||result.series.length)anyEvidence=true;
     if(result.availability.state!=="available"||result.coverage.state!=="available"||result.freshness.state!=="fresh")partial=true;
     const observed=result.freshness.latest_source_timestamp?.toISOString()??null;
     if(observed&&(!observedAt||observed>observedAt))observedAt=observed;
     const complete=result.coverage.complete_through?.toISOString()??null;
     if(!complete)allComplete=false;else if(!completeThrough||complete<completeThrough)completeThrough=complete;
     for(const point of result.series){
      const start=point.bucket_start.toISOString(),end=point.bucket_end.toISOString(),key=start+"/"+end;
      const current=points.get(key);
      if(point.value===null||!Number.isSafeInteger(point.value)){points.set(key,{start,end,value:null});partial=true;continue;}
      if(current?.value===null)continue;
      points.set(key,{start,end,value:(current?.value??0n)+BigInt(point.value)});
     }
    }
    return {key:def!.key,domain:ADMIN_TREND_DOMAINS[def!.key],unit:def!.unit,availability:included===0||!anyEvidence?"unavailable":partial?"partial":"available",source:"labs-analytics.promoted-projections",
      observedAt,completeThrough:allComplete&&!hasMore?completeThrough:null,scopeCoverage:{includedScopeCount:included,totalScopeCount:total,hasMore},
      ...(reason?{reason}:included===0?{reason:"No instrumented reporting scopes"}:partial?{reason:"Source projection coverage is incomplete"}:{}),
      series:[...points.values()].sort((a,b)=>a.start.localeCompare(b.start)).map(point=>({...point,value:point.value?.toString()??null}))};
   });
   await db.query(`INSERT INTO analytics.admin_reporting_audit(id,actor_id,product,metric_keys,included_scopes,total_scopes,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),actor.id,product,identities,included,total,request.id]);
   await db.query("COMMIT");
   request.log.info({event:"admin.reporting.query",actor_id:actor.id,product,included_scopes:included,total_scopes:total,request_id:request.id},"Administrative report");
   return {trends,includedScopeCount:included,totalScopeCount:total,hasMore};
  }catch(error){await db.query("ROLLBACK");request.log.warn({event:"admin.reporting.failed",error_type:error instanceof Error?error.name:"unknown",request_id:request.id},"Administrative reporting unavailable");return reply.code(503).send({error:"Analytics reporting unavailable"});}
  finally{db.release();}
 });
}
