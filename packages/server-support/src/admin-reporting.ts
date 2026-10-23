export { loadAdminTrends, unavailableAdminTrends } from "./admin-reporting-trends.js";
import { providerResultSpan } from "./telemetry.js";
import { sanitizeAdminTrends } from "./admin-reporting-trends.js";
import { ADMIN_REPORT_METRICS, type AdminReportQuery, type AdminProductReport, type AdminReportMetric } from "@kasitek-labs/contracts";

/** Match the existing Analytics API range and pagination safety bounds. */
export function parseAdminReportQuery(input: Record<string, unknown>, now = new Date()): AdminReportQuery {
  const allowed = new Set(["start", "end", "timezone", "organizationId", "consumer", "view", "detail", "page", "pageSize"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("Unknown report filter");
  const date = (value: unknown, fallback: Date) => {
    if (value === undefined) return fallback.toISOString();
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Use a UTC timestamp");
    const normalized = new Date(value).toISOString();
    if (normalized.slice(0,10) !== value.slice(0,10)) throw new Error("Invalid calendar date");
    return normalized;
  };
  const end = date(input.end, now);
  const start = date(input.start, new Date(Date.parse(end) - 30 * 86400000));
  if (Date.parse(start) >= Date.parse(end) || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new Error("Report range must be positive and at most 366 days");
  const timezone = input.timezone ?? "UTC";
  if (typeof timezone !== "string" || timezone.length > 64) throw new Error("Invalid timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new Error("Invalid timezone"); }
  const integer = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (!(typeof value === "bigint" || typeof value === "number" && Number.isSafeInteger(value) || typeof value === "string" && /^[1-9]\d*$/.test(value))) throw new Error("Invalid pagination");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error("Invalid pagination");
    return parsed;
  };
  if (input.organizationId !== undefined && (typeof input.organizationId !== "string" || !input.organizationId.trim() || input.organizationId.length > 200)) throw new Error("Invalid organization");
  if (input.consumer !== undefined && !["growth", "agents", "agency"].includes(String(input.consumer))) throw new Error("Invalid consumer");
  let detail:AdminReportQuery["detail"];
  if(input.detail!==undefined){
    let raw:unknown=input.detail;
    if(typeof raw==="string") {if(Buffer.byteLength(raw)>2048)throw Error("Report detail is too large");try{raw=JSON.parse(raw);}catch{throw Error("Invalid report detail");}}
    if(!raw||typeof raw!=="object"||Array.isArray(raw))throw Error("Invalid report detail");
    const value=raw as Record<string,unknown>;
    if(Object.keys(value).some(key=>!["metric","dimensions"].includes(key))||!ADMIN_REPORT_METRICS.some(metric=>metric.key===value.metric))throw Error("Unknown report detail");
    if(!value.dimensions||typeof value.dimensions!=="object"||Array.isArray(value.dimensions))throw Error("Invalid detail dimensions");
    const dimensions:Record<string,string>={};
    for(const [key,item] of Object.entries(value.dimensions)){
      if(!["consumer","provider","model","productKey","metricKey","eventType","exactness","channel","state","planId","currency"].includes(key)||typeof item!=="string"||item.length>256)throw Error("Invalid detail dimension");
      if(key==="currency"&&!/^[A-Z]{3}$/.test(item))throw Error("Invalid detail currency");
      dimensions[key]=item;
    }
    detail={metric:value.metric as string,dimensions};
    if(Buffer.byteLength(JSON.stringify(detail))>2048)throw Error("Report detail is too large");
  }
  if(input.view!==undefined&&!["activity","customers"].includes(String(input.view)))throw new Error("Invalid report view");
  return {start,end,timezone,...(detail?{detail}:{}),...(input.view===undefined?{}:{view:input.view as AdminReportQuery["view"]}), ...(input.organizationId === undefined ? {} : {organizationId:input.organizationId as string}),
    ...(input.consumer === undefined ? {} : {consumer:input.consumer as AdminReportQuery["consumer"]}),
    page:integer(input.page,1,10000),pageSize:integer(input.pageSize,50,100)};
}
export function reportMetric(key: string, value: string | number | bigint | null, source: string, observedAt: string | null, extra: Partial<AdminReportMetric> = {}): AdminReportMetric {
  return {key,value:value === null ? null : String(value),source,observedAt,availability:value === null ? "unsupported" : "available",...extra};
}
export function missingProductReport(product: AdminProductReport["product"], query: AdminReportQuery, reason: string): AdminProductReport {
  return {contractVersion:"1",product,query,generatedAt:new Date().toISOString(),sourceObservedAt:null,completeThrough:null,
    availability:"unavailable",metrics:[reportMetric("source",null,product,null,{availability:"unavailable",reason})],records:[],hasMore:false};
}
export function reportCsv(reports: readonly AdminProductReport[]): string {
  const cell = (value: unknown) => {
    let raw = value === null || value === undefined ? "" : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(raw)) raw = "'" + raw;
    return '"' + raw.replaceAll('"','""') + '"';
  };
  const rows: unknown[][] = [["product","start","end","timezone","organization","metric","value","currency","dimensions","availability","reason","source","observed_at","complete_through","record_type","bucket_start","bucket_end","unit","included_scopes","total_scopes","consumer","record_id","record_kind","record_state","record_time","record_label","root_id","page","has_more"]];
  for (const report of reports) {
    for (const metric of report.metrics) rows.push([report.product,report.query.start,report.query.end,report.query.timezone,
      report.query.organizationId,metric.key,metric.value,metric.currency,JSON.stringify(metric.dimensions ?? {}),metric.availability,metric.reason,metric.source,metric.observedAt,report.completeThrough,
      "metric",null,null,ADMIN_REPORT_METRICS.find(def=>def.key===metric.key)?.unit,null,null,metric.dimensions?.consumer??report.query.consumer]);
    for (const trend of report.trends??[]) for(const point of trend.series.length?trend.series:[{start:null,end:null,value:null}])rows.push([report.product,report.query.start,report.query.end,report.query.timezone,
      report.query.organizationId,trend.key,point.value,null,"{}",trend.availability,trend.reason,trend.source,trend.observedAt,trend.completeThrough,
      "trend",point.start,point.end,trend.unit,trend.scopeCoverage?.includedScopeCount,trend.scopeCoverage?.totalScopeCount,report.query.consumer]);
    for (const record of report.records) rows.push([report.product,report.query.start,report.query.end,report.query.timezone,
      record.organizationId,report.query.detail?.metric,null,report.query.detail?.dimensions.currency,JSON.stringify(report.query.detail?.dimensions??{}),report.availability,null,report.product,report.sourceObservedAt,report.completeThrough,
      "record",null,null,null,null,null,record.consumer??report.query.consumer,record.id,record.kind,record.state,record.occurredAt,record.label,record.rootId,report.query.page,report.hasMore]);
  }
  return rows.map(row=>[...row,...Array(Math.max(0,rows[0]!.length-row.length)).fill(null)].map(cell).join(",")).join("\r\n") + "\r\n";
}

import type {Pool, PoolClient} from "pg";
/** Several report queries must describe the same committed snapshot. */
export async function adminReportSnapshot<T>(pool: Pool, read: (db: PoolClient) => Promise<T>): Promise<T> {
  const db=await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout = '5s'");
    const result=await read(db);
    await db.query("COMMIT");return result;
  } catch(error) {await db.query("ROLLBACK");throw error;} finally {db.release();}
}

export interface AdminReportSourceRequest {product:AdminProductReport["product"];query:AdminReportQuery;url:string;headers?:HeadersInit}
const availabilityStates=new Set(["available","partial","stale","unavailable","unsupported"]);
/** Project the transport DTO instead of passing unexpected upstream fields into privileged UI or exports. */
export function validateProductReport(raw:unknown,product:AdminProductReport["product"],query:AdminReportQuery):AdminProductReport {
 const value=raw as AdminProductReport;
 const string=(input:unknown,max=256):string=>{if(typeof input!=="string"||input.length>max)throw Error("Invalid source response");return input;};
 const time=(input:unknown):string|null=>{if(input===null)return null;const v=string(input,40);if(!Number.isFinite(Date.parse(v)))throw Error("Invalid source timestamp");return v;};
 if(!value||value.contractVersion!=="1"||value.product!==product||!availabilityStates.has(value.availability)||!Array.isArray(value.metrics)||value.metrics.length>1000||!Array.isArray(value.records)||value.records.length>query.pageSize||typeof value.hasMore!=="boolean")throw Error("Invalid source report");
 const keys=new Set(ADMIN_REPORT_METRICS.map(metric=>metric.key));keys.add("source");
 const metrics=value.metrics.map(metric=>{
   if(!keys.has(metric.key)||!availabilityStates.has(metric.availability)||metric.value!==null&&(typeof metric.value!=="string"||!/^[-]?\d+(?:\.\d+)?$/.test(metric.value)||metric.value.length>80))throw Error("Invalid source metric");
   if(metric.value===null&&metric.availability==="available")throw Error("Unknown metric cannot be available");
   if(metric.currency!==undefined&&!/^[A-Z]{3}$/.test(metric.currency))throw Error("Invalid currency");
   const dimensions:Record<string,string>={};
   for(const [key,input] of Object.entries(metric.dimensions??{})) {
     if(!["consumer","provider","model","productKey","metricKey","eventType","exactness","channel","state","planId"].includes(key))throw Error("Invalid dimension");
     dimensions[key]=string(input);
   }
   if(metric.detailSupported!==undefined&&typeof metric.detailSupported!=="boolean")throw Error("Invalid detail support");
   return {...(metric.detailSupported===undefined?{}:{detailSupported:metric.detailSupported}),key:metric.key,value:metric.value,availability:metric.availability,source:string(metric.source),observedAt:time(metric.observedAt),
     ...(metric.reason===undefined?{}:{reason:string(metric.reason,256)}),...(metric.currency===undefined?{}:{currency:metric.currency}),dimensions};
 });
 const records=value.records.map(record=>{
   if(query.organizationId&&record.organizationId!==query.organizationId)throw Error("Record outside report scope");
   if(record.consumer!==undefined&&!["growth","agency","agents"].includes(record.consumer))throw Error("Invalid consumer");
   return {...(record.label===undefined?{}:{label:string(record.label,200)}),id:string(record.id),kind:string(record.kind),organizationId:string(record.organizationId),state:string(record.state),occurredAt:time(record.occurredAt)!,
     ...(record.consumer===undefined?{}:{consumer:record.consumer}),...(record.rootId===undefined?{}:{rootId:string(record.rootId)})};
 });
 return {contractVersion:"1",product,query,availability:value.availability,generatedAt:time(value.generatedAt)!,sourceObservedAt:time(value.sourceObservedAt),completeThrough:time(value.completeThrough),metrics,records,hasMore:value.hasMore,...(value.trends===undefined?{}:{trends:sanitizeAdminTrends(value.trends,query)})};
}
export async function collectAdminProductReports(requests:readonly AdminReportSourceRequest[],signal?:AbortSignal,fetcher:typeof fetch=fetch):Promise<AdminProductReport[]> {
 if(requests.length>3)throw Error("Too many product sources");
 return Promise.all(requests.map(async source=>{
  try {
   return await providerResultSpan("admin-reporting",source.product,async()=>{
   const response=await fetcher(source.url,{method:"GET",headers:source.headers,cache:"no-store",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
   if(!response.ok)throw Error("Source unavailable");
   if(Number(response.headers.get("content-length")??0)>2_000_000)throw Error("Oversized source report");
   // Bound streamed response bytes as well as Content-Length.
   const reader=response.body?.getReader();if(!reader)throw Error("Empty source report");
   const chunks:Uint8Array[]=[];let size=0;
   for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>2_000_000){await reader.cancel();throw Error("Oversized source report");}chunks.push(item.value);}
   return validateProductReport(JSON.parse(Buffer.concat(chunks).toString("utf8")),source.product,source.query);
   });
  } catch {
   if(signal?.aborted)throw signal.reason;
   return missingProductReport(source.product,source.query,"Reporting source unavailable");
  }
 }));
}

/** Registered Analytics roots may cover only a subset of product organizations. */
export function applyAdminPopulationCoverage(report: AdminProductReport): void {
  if (report.query.organizationId) return;
  const population = report.metrics.find(metric => metric.key === "organizations" && metric.availability === "available")?.value;
  if (population == null || !/^\d+$/.test(population)) return;
  for (const trend of report.trends ?? []) {
    if (!trend.scopeCoverage || BigInt(trend.scopeCoverage.totalScopeCount) >= BigInt(population)) continue;
    if (trend.availability === "available") trend.availability = "partial";
    trend.completeThrough = null;
    trend.reason = "Analytics registration covers a subset of product organizations";
  }
}
