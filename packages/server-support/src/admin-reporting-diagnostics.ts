import {metrics} from "@opentelemetry/api";
import {providerResultSpan,recordQueueAge} from "./telemetry.js";
import type {Pool} from "pg";
import type {AdminReportingDiagnostics,AdminDiagnosticService} from "@kasitek-labs/contracts";
export function unavailableDiagnostics(service:AdminDiagnosticService,state:"disconnected"|"unauthorized"|"not_configured"="disconnected"):AdminReportingDiagnostics {
 return {contractVersion:"1",service,observedAt:new Date().toISOString(),configuration:{state:state==="not_configured"?state:"unknown"},connectivity:{state},schema:{state:"unknown"},reads:{state:"unknown"},publication:null,projection:null};
}
/** No remote checks or publication. The owning API observes its own source database. */
export async function readProductDiagnostics(pool:Pool,service:Exclude<AdminDiagnosticService,"analytics">,environment:NodeJS.ProcessEnv):Promise<AdminReportingDiagnostics> {
 const report=unavailableDiagnostics(service);
 const token=service==="agents"?environment.AGENTS_ANALYTICS_INGESTION_TOKEN:service==="growth"?environment.ANALYTICS_CORE_INGESTION_TOKEN??environment.ANALYTICS_INGESTION_TOKEN:environment.ANALYTICS_TENANT_INGESTION_TOKEN??environment.ANALYTICS_INGESTION_TOKEN;
 const endpoint=service==="agents"?environment.AGENTS_ANALYTICS_INGESTION_URL:environment.ANALYTICS_INGESTION_URL??"http://127.0.0.1:4300";
 report.configuration={state:token?.trim()&&endpoint?.trim()?"ready":"not_configured",code:"publisher_configuration"};
 let db;try {
  db=await pool.connect();await db.query("BEGIN READ ONLY");await db.query("SET LOCAL statement_timeout='2s'");
  const required=service==="growth"?'public."Organization"':service==="agency"?'public.workspaces':'agents_platform.tasks';
  const schema=(await db.query("SELECT to_regclass($1) IS NOT NULL AS source, to_regclass('public.analytics_outbox') IS NOT NULL AS outbox",[required])).rows[0];
  report.connectivity={state:"ready"};report.schema={state:schema.source&&schema.outbox?"ready":"incompatible_schema"};
  if(schema.source){await db.query(`SELECT 1 FROM ${required} LIMIT 1`);report.reads={state:"ready"};}
  if(schema.outbox){
   const row=(await db.query(`SELECT count(*) FILTER(WHERE delivery_status IN ('pending','leased'))::text pending,count(*) FILTER(WHERE delivery_status IN ('pending','leased') AND attempt_count>0)::text retrying,count(*) FILTER(WHERE delivery_status='quarantined')::text quarantined,min(created_at) FILTER(WHERE delivery_status IN ('pending','leased')) oldest,max(delivered_at) last FROM public.analytics_outbox`)).rows[0];
   const error=(await db.query("SELECT last_error_code FROM public.analytics_outbox WHERE delivery_status IN ('pending','leased','quarantined') AND last_error_code IS NOT NULL ORDER BY updated_at DESC LIMIT 1")).rows[0]?.last_error_code;
   let receipts:string|null=null;
   if(service==="agents"&&(await db.query("SELECT to_regclass('agents_platform.analytics_event_receipts') IS NOT NULL present")).rows[0].present)receipts=(await db.query("SELECT count(*)::text count FROM agents_platform.analytics_event_receipts WHERE state='pending'")).rows[0].count;
   report.publication={state:row.last===null&&row.pending==="0"&&row.quarantined==="0"?"no_activity":row.pending!=="0"?"backfilling":"ready",pending:row.pending,retrying:row.retrying,quarantined:row.quarantined,oldestPendingAt:row.oldest?.toISOString()??null,lastPublishedAt:row.last?.toISOString()??null,failureCode:typeof error==="string"&&/^[a-z][a-z0-9_.-]{0,127}$/.test(error)?error:null,pendingReceipts:receipts};
  }
  await db.query("COMMIT");
 }catch(error){if(db)await db.query("ROLLBACK").catch(()=>{});const code=(error as {code?:string}).code;report.schema={state:code==="42P01"||code==="42703"?"incompatible_schema":"unknown"};report.reads={state:"unknown",code:code==="42501"?"read_denied":"read_unavailable"};}
 finally{db?.release();}
 recordDiagnosticMeasurements(report);
 return report;
}
const states=new Set(["ready","unknown","not_configured","disconnected","unauthorized","incompatible_schema","backfilling","stale","no_activity"]);
export function sanitizeReportingDiagnostics(raw:unknown,service:AdminDiagnosticService):AdminReportingDiagnostics {
 if(!raw||typeof raw!=="object")throw Error("Invalid diagnostic");
 const value=raw as Record<string,unknown>;
 if(value.contractVersion!=="1"||value.service!==service)throw Error("Invalid diagnostic identity");
 const time=(v:unknown):string|null=>{if(v===null)return null;if(typeof v!=="string"||!/^\d{4}-\d\d-\d\dT/.test(v)||!Number.isFinite(Date.parse(v)))throw Error("Invalid diagnostic time");return new Date(v).toISOString();};
 const count=(v:unknown):string=>{if(typeof v!=="string"||!/^\d{1,30}$/.test(v))throw Error("Invalid diagnostic count");return v;};
 const check=(key:string)=>{const item=value[key] as {state:string;code?:string}|undefined;if(!item||!states.has(item.state))throw Error("Invalid diagnostic status");return {state:item.state as AdminReportingDiagnostics["reads"]["state"],...(item.code&&/^[a-z][a-z0-9_.-]{0,127}$/.test(item.code)?{code:item.code}:{})};};
 const report:AdminReportingDiagnostics={contractVersion:"1",service,observedAt:time(value.observedAt)!,configuration:check("configuration"),connectivity:check("connectivity"),schema:check("schema"),reads:check("reads"),publication:null,projection:null};
 if(!report.observedAt)throw Error("Missing observation time");
 if(value.publication){const p=value.publication as Record<string,unknown>;if(!["ready","no_activity","backfilling"].includes(String(p.state)))throw Error("Invalid publication status");report.publication={state:p.state as "ready"|"no_activity"|"backfilling",pending:count(p.pending),retrying:count(p.retrying),quarantined:count(p.quarantined),oldestPendingAt:time(p.oldestPendingAt),lastPublishedAt:time(p.lastPublishedAt),pendingReceipts:p.pendingReceipts===null?null:count(p.pendingReceipts),failureCode:typeof p.failureCode==="string"&&/^[a-z][a-z0-9_.-]{0,127}$/.test(p.failureCode)?p.failureCode:null};}
 if(value.projection){const p=value.projection as Record<string,unknown>,sourceStates:Record<string,string>={};if(!p.sourceStates||typeof p.sourceStates!=="object"||Array.isArray(p.sourceStates))throw Error("Invalid source states");
  for(const [state,n]of Object.entries(p.sourceStates)){if(!["available","partial","stale","unsupported","not_instrumented","not_applicable","backfilling","unavailable"].includes(state))throw Error("Unknown source state");sourceStates[state]=count(n);}
  if(!["unknown","partial"].includes(String(p.coverage)))throw Error("Invalid coverage");
  report.projection={registeredScopes:count(p.registeredScopes),observedSourceAt:time(p.observedSourceAt),ingestedAt:time(p.ingestedAt),checkpointAt:time(p.checkpointAt),completeThrough:time(p.completeThrough),pending:count(p.pending),oldestPendingAt:time(p.oldestPendingAt),failed:count(p.failed),backfilling:count(p.backfilling),promotedGenerations:count(p.promotedGenerations),latestPromotedAt:time(p.latestPromotedAt),sourceStates,coverage:p.coverage as "unknown"|"partial"};
 }
 return report;
}
export async function collectReportingDiagnostics(service:AdminDiagnosticService,url:string,headers:Record<string,string>,signal?:AbortSignal,fetcher:typeof fetch=fetch):Promise<AdminReportingDiagnostics>{
 try{return await providerResultSpan("admin-reporting-diagnostics",service,async()=>{
  const response=await fetcher(url,{headers,cache:"no-store",signal:signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
  if(!response.ok)throw Object.assign(Error("Diagnostic source unavailable"),{status:response.status});
  const reader=response.body?.getReader();if(!reader)throw Error();let size=0;const chunks:Uint8Array[]=[];
  for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536){await reader.cancel();throw Error();}chunks.push(part.value);}
  return sanitizeReportingDiagnostics(JSON.parse(Buffer.concat(chunks).toString("utf8")),service);
 });}catch(error){if(signal?.aborted)throw signal.reason;const status=(error as {status?:number}).status;return unavailableDiagnostics(service,status===401||status===403?"unauthorized":"disconnected");}
}

const backlog=metrics.getMeter("kasitek").createHistogram("kasitek.reporting.backlog",{unit:"{record}"});
/** Observation-time snapshots use service and stage labels only. No customer dimensions. */
export function recordDiagnosticMeasurements(report:AdminReportingDiagnostics):void {
 const record=(stage:string,value:string,oldest:string|null)=>{const numeric=Number(value);if(Number.isSafeInteger(numeric))backlog.record(numeric,{service:report.service,stage});if(oldest)recordQueueAge(`reporting.${report.service}.${stage}`,(Date.parse(report.observedAt)-Date.parse(oldest))/1000);};
 if(report.publication)record("publication",report.publication.pending,report.publication.oldestPendingAt);
 if(report.projection)record("projection",report.projection.pending,report.projection.oldestPendingAt);
}
