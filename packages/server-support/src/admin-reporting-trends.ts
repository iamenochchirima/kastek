import {createAdminAuthority} from "./admin-authority.js";
import type { AdminReportQuery, AdminReportTrend, AdminReportAvailability, AdminReportDomain } from "@kasitek-labs/contracts";
import { AnalyticsReportingClient, ReportingGrantIssuer, withScope } from "./analytics-reporting.js";
import { SerdeFloat } from "./json.js";

export const PRODUCT_TREND_METRICS = {
  agents: ["agent.native.root_tasks.completed", "agent.native.root_tasks.failed", "agent.native.model.input_tokens", "agent.native.model.output_tokens", "agent.native.model.unknown_usage"],
  growth: ["conversation.lifecycle_events", "campaign.recipients.sent", "campaign.recipients.delivered", "campaign.recipients.failed", "agent.native.root_tasks.completed", "agent.native.root_tasks.failed"],
  agency: ["tenant.leads.lifecycle_events", "tenant.clients.lifecycle_events", "tenant.client.assignment_events", "agent.native.root_tasks.completed", "agent.native.root_tasks.failed"],
} as const;
export const ADMIN_TREND_DOMAINS: Record<string, AdminReportDomain> = {
  "conversation.lifecycle_events":"usage",
  "campaign.recipients.sent":"usage",
  "campaign.recipients.delivered":"reliability",
  "campaign.recipients.failed":"reliability",
  "tenant.leads.lifecycle_events":"adoption",
  "tenant.clients.lifecycle_events":"adoption",
  "tenant.client.assignment_events":"adoption",
  "agent.native.root_tasks.completed":"reliability",
  "agent.native.root_tasks.failed":"reliability",
  "agent.native.model.input_tokens":"usage",
  "agent.native.model.output_tokens":"usage",
  "agent.native.model.unknown_usage":"reliability",
};
type Product = keyof typeof PRODUCT_TREND_METRICS;
export type AdminTrendDependencies = {client: AnalyticsReportingClient; issuer?: ReportingGrantIssuer; adminAuthority?: {secret:string;role:string}};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value instanceof SerdeFloat) throw Error("Invalid Analytics report");
  return value as Record<string, unknown>;
};
const time = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw Error("Invalid Analytics timestamp");
  return new Date(value).toISOString();
};
export function unavailableAdminTrends(product: Product, reason: string, availability: AdminReportAvailability = "unavailable"): AdminReportTrend[] {
  return PRODUCT_TREND_METRICS[product].map(key => ({key,domain:ADMIN_TREND_DOMAINS[key],unit:key.endsWith("_tokens")?"tokens":"count",availability,source:"labs.analytics",observedAt:null,completeThrough:null,series:[],reason}));
}
function quantity(raw: unknown): string | null {
  const value = raw instanceof SerdeFloat ? raw.value : raw;
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d{1,80}$/.test(value)) return value;
  return null;
}
/** Keep Analytics projection coverage separate from product authoritative totals. */
export async function loadAdminTrends(product: Product, principalId: string, query: AdminReportQuery, dependencies: () => Promise<AdminTrendDependencies>): Promise<AdminReportTrend[]> {
  try {
    const {client,issuer,adminAuthority}=await dependencies();
    if (product==="agents" || !query.organizationId) {
      if (!adminAuthority) return unavailableAdminTrends(product,"Cross-organization Analytics reporting is not configured");
      const parameters=new URLSearchParams({product,start:query.start,end:query.end,timezone:query.timezone,metrics:PRODUCT_TREND_METRICS[product].map(key=>`${key}@1`).join(",")});
      if(query.organizationId)parameters.set("organizationId",query.organizationId);
      const path=`/v1/admin/reporting?${parameters}`;
      const authority=createAdminAuthority({secret:adminAuthority.secret,audience:"analytics",actor:{id:principalId,role:adminAuthority.role},method:"GET",path,capability:"admin:report"});
      const response=object(await client.adminReport(parameters,authority));
      const {includedScopeCount,totalScopeCount,hasMore}=response;
      if(!Number.isSafeInteger(includedScopeCount)||!Number.isSafeInteger(totalScopeCount)||Number(includedScopeCount)<0||Number(includedScopeCount)>100||Number(totalScopeCount)<Number(includedScopeCount)||typeof hasMore!=="boolean") throw Error("Invalid aggregate coverage");
      const scopeCoverage={includedScopeCount:Number(includedScopeCount),totalScopeCount:Number(totalScopeCount),hasMore};
      const trends=sanitizeAdminTrends(response.trends,query);
      if(trends.length!==PRODUCT_TREND_METRICS[product].length || trends.some(trend=>!PRODUCT_TREND_METRICS[product].includes(trend.key as never))) throw Error("Unexpected aggregate metrics");
      return trends.map(trend=>({...trend,scopeCoverage,
        ...(hasMore && trend.availability==="available" ? {availability:"partial" as const,completeThrough:null,reason:"Reporting scope coverage is incomplete"} : {})}));
    }
    if(!issuer) throw Error("Scoped reporting signer is not configured");
    const service=product==="growth" ? "core" : "tenant-platform";
    const kind=product==="growth" ? "core_organization" : "tenant_workspace";
    const scope=await client.resolveScope(service,kind,query.organizationId);
    if(scope.owning_source_service!==service || scope.scope_kind!==kind || scope.external_source_id!==query.organizationId) throw Error("Analytics scope mismatch");
    const metrics=[...PRODUCT_TREND_METRICS[product]].map(key=>`${key}@1`);
    const grant=await issuer.issue({principal_id:principalId,scope_id:scope.scope_id,root_scope_id:scope.root_scope_id,descendant_mode:product==="agency"?"all":"none",permissions:product==="agency"?["analytics:read","analytics:compare_children"]:["analytics:read"],metric_keys:metrics,dimension_keys:[]});
    const raw=object(await client.report(grant,withScope({range_start:query.start,range_end:query.end,timezone:query.timezone,interval:"day",metrics,breakdowns:[],filters:{},include_descendants:product==="agency"},scope.scope_id)));
    if(BigInt(raw.scope_id as number|bigint)!==BigInt(scope.scope_id) || raw.scope_kind!==kind || time(raw.range_start)!==time(query.start) || time(raw.range_end)!==time(query.end) || raw.timezone!==query.timezone || !Array.isArray(raw.metrics) || raw.metrics.length!==metrics.length || new Set(raw.metrics.map(item=>object(item).key)).size!==metrics.length) throw Error("Analytics response scope mismatch");
    return PRODUCT_TREND_METRICS[product].map(key=>{
      const metric=object((raw.metrics as unknown[]).find(value=>object(value).key===key));
      if(metric.unit!=="count" || !Array.isArray(metric.series) || metric.series.length>2000) throw Error("Invalid Analytics metric");
      const availability=object(metric.availability),coverage=object(metric.coverage),freshness=object(metric.freshness);
      const series=metric.series.map(value=>{
        const point=object(value),start=time(point.bucket_start),end=time(point.bucket_end);
        if(!start || !end || start>=end || Date.parse(end)<=Date.parse(query.start) || Date.parse(start)>=Date.parse(query.end)) throw Error("Analytics point outside range");
        return {start,end,value:quantity(point.value)};
      });
      let state: AdminReportAvailability = availability.state==="available" ? "available" : availability.state==="not_applicable" ? "unsupported" : ["partial","backfilling"].includes(String(availability.state)) ? "partial" : availability.state==="stale" ? "stale" : "unavailable";
      let reason=typeof availability.reason==="string" ? availability.reason.slice(0,256) : undefined;
      if(freshness.state==="stale") {state="stale";reason="Analytics source evidence is stale";}
      else if(state==="available" && (coverage.state!=="available" || freshness.state!=="fresh")) {state="partial";reason="Analytics temporal coverage or source freshness is incomplete";}
      if(series.some(point=>point.value===null)) {state=state==="available"?"partial":state;reason="Some projection values are unknown or exceed exact integer precision";}
      return {key,domain:ADMIN_TREND_DOMAINS[key],unit:"count",availability:state,source:"labs.analytics",observedAt:time(freshness.latest_source_timestamp),completeThrough:time(coverage.complete_through),series,...(reason?{reason}:{})};
    });
  } catch {return unavailableAdminTrends(product,"Analytics trends are not configured, not ready, or temporarily unavailable");}
}

export function sanitizeAdminTrends(value: unknown, query: AdminReportQuery): AdminReportTrend[] {
  if (!Array.isArray(value) || value.length>30) throw Error("Invalid trend response");
  const text=(value:unknown,max=256):string=>{if(typeof value!=="string" || value.length>max) throw Error("Invalid trend value");return value;};
  const states=new Set(["available","partial","stale","unavailable","unsupported"]);
  const allowed=new Set(Object.keys(ADMIN_TREND_DOMAINS));
  const seen=new Set<string>();
  return value.map(input=>{
    const item=object(input);
    if(!allowed.has(item.key as never) || seen.has(String(item.key)) || !states.has(String(item.availability)) || !Array.isArray(item.series) || item.series.length>2000) throw Error("Invalid trend");
    seen.add(String(item.key));
    const expectedUnit=String(item.key).endsWith("_tokens")?"tokens":"count";
    if(item.unit!==expectedUnit) throw Error("Invalid trend unit");
    const buckets=new Set<string>();
    const series=item.series.map(raw=>{
      const point=object(raw),start=time(point.start),end=time(point.end);
      if(!start || !end || start>=end || Date.parse(end)<=Date.parse(query.start) || Date.parse(start)>=Date.parse(query.end)) throw Error("Trend point outside range");
      if(buckets.has(start+"/"+end)) throw Error("Duplicate trend bucket");
      buckets.add(start+"/"+end);
      if(point.value!==null && (typeof point.value!=="string" || !/^\d{1,80}$/.test(point.value))) throw Error("Invalid trend quantity");
      return {start,end,value:point.value as string|null};
    });
    if(item.availability==="available" && series.some(point=>point.value===null)) throw Error("Unknown trend cannot be available");
    let scopeCoverage:AdminReportTrend["scopeCoverage"];
    if(item.scopeCoverage!==undefined) {
      const coverage=object(item.scopeCoverage);
      if(!Number.isSafeInteger(coverage.includedScopeCount)||!Number.isSafeInteger(coverage.totalScopeCount)||Number(coverage.includedScopeCount)<0||Number(coverage.includedScopeCount)>100||Number(coverage.totalScopeCount)<Number(coverage.includedScopeCount)||typeof coverage.hasMore!=="boolean") throw Error("Invalid trend scope coverage");
      if(!coverage.hasMore && coverage.includedScopeCount!==coverage.totalScopeCount) throw Error("Incomplete scope coverage");
      if(item.availability==="available" && (coverage.hasMore || coverage.includedScopeCount===0)) throw Error("Incomplete trend cannot be available");
      scopeCoverage={includedScopeCount:Number(coverage.includedScopeCount),totalScopeCount:Number(coverage.totalScopeCount),hasMore:coverage.hasMore};
    }
    return {key:text(item.key),domain:ADMIN_TREND_DOMAINS[String(item.key)],unit:text(item.unit,32),availability:item.availability as AdminReportAvailability,source:text(item.source),observedAt:time(item.observedAt),completeThrough:time(item.completeThrough),series,...(scopeCoverage?{scopeCoverage}:{}),...(item.reason===undefined?{}:{reason:text(item.reason)})};
  });
}
