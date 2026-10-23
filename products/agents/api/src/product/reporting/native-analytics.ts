import {recordOperationsWorkerHeartbeat} from "@kasitek-labs/server-support/operations-source";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { buildObservation, buildScopeDefinition, enqueueOutbox, publishOutboxOnce, AnalyticsIngestionClient, type AnalyticsPublisherSettings } from "@kasitek-labs/server-support/analytics-producer";
import type { ScopeKind } from "@kasitek-labs/contracts";
import { observationSchema, type AgentObservation } from "../../contracts/observations";
import { transaction } from "../../infrastructure/database";
const producer = {source_service:"agent-platform",source_namespace:"agent-platform",source_origin:"kasitek://agents"};
interface NativeEvent { sequence:string; observation:AgentObservation; product:string; organization_id:string; tenant_id:string|null; evaluation_trial_id:string|null }
/** Observations come from the committed task-event log, not process-local telemetry. */
export async function queueNativeAnalytics(pool:Pool, limit=100):Promise<number> {
 return transaction(pool,async db=>{
  const rows=(await db.query<NativeEvent>(`SELECT e.sequence,e.observation,t.product,t.organization_id,p.tenant_id,t.evaluation_trial_id
   FROM agents_platform.analytics_event_receipts a JOIN agents_platform.task_events e ON e.sequence=a.event_sequence
   JOIN agents_platform.tasks t ON t.id=e.task_id
   LEFT JOIN agents_platform.product_execution_tenants p ON p.organization_id=t.organization_id AND p.product=t.product
   WHERE a.state='pending'
   ORDER BY a.event_sequence FOR UPDATE OF a SKIP LOCKED LIMIT $1`,[Math.max(1,Math.min(500,limit))])).rows;
  for(const row of rows){
   const observation=observationSchema.parse(row.observation);
   const organization=row.product==='agents'?row.organization_id:row.tenant_id;
   let state='ignored';
   if(!organization)state='unallocated';
   else {
    const scope:ScopeKind=row.product==='agents'?'agents_organization':row.product==='growth'?'core_organization':'tenant_workspace';
    if(scope==='agents_organization'){
     const result=await enqueueOutbox(db,buildScopeDefinition(producer,{record_id:`scope:${organization}`,source_domain:'agents',source_stream_key:`organization:${scope}:${organization}:agents`,contract_name:'agent.scope.definition@1',schema_version:1,scope_kind:scope,scope_external_id:organization,reporting_timezone:'UTC',status:'active',source_version:1}));
     if(result.kind==='conflict')throw new Error('NATIVE_ANALYTICS_SCOPE_CONFLICT');
    }
    const count=await queueObservationMetrics(db,row.sequence,observation,scope,organization);
    if(count)state='queued';
   }
   await db.query('UPDATE agents_platform.analytics_event_receipts SET state=$2 WHERE event_sequence=$1',[row.sequence,state]);
  }
  return rows.length;
 });
}
async function queueObservationMetrics(db:PoolClient,sequence:string,event:AgentObservation,scope:ScopeKind,organization:string):Promise<number>{
 const metrics:Array<{key:string;value:number;identity:string;time:string}>=[];
 if(event.identity.parentTaskId===null && ['completed','failed'].includes(event.kind))metrics.push({key:`agent.native.root_tasks.${event.kind}`,value:1,identity:`task:${event.identity.taskId}:${event.kind}`,time:event.occurredAt});
 if(['model','context'].includes(event.category) && event.identity.operationId && /\.(completed|failed|uncertain)$/.test(event.kind)){
  const operation=(await db.query(`SELECT id,kind,completed_at,output FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND kind IN ('model','compaction') AND completed_at IS NOT NULL`,[event.identity.operationId,event.identity.taskId])).rows[0];
  if(operation){
   const usage=operation.output?.usage;
   const known=usage?.observed===true && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens>=0 && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens>=0;
   for(const [key,value] of known ? [['input_tokens',usage.inputTokens],['output_tokens',usage.outputTokens]] as const : [['unknown_usage',1]] as const)metrics.push({key:`agent.native.model.${key}`,value,identity:`operation:${operation.id}:${key}`,time:new Date(operation.completed_at).toISOString()});
  }
 }
 for(const metric of metrics){
  const result=await enqueueOutbox(db,buildObservation(producer,{record_id:metric.identity,source_domain:'agents',source_stream_key:`organization:${scope}:${organization}:agents`,contract_name:'agent.native.execution.metric@1',schema_version:1,scope_kind:scope,scope_external_id:organization,provider:'agents-native',metric_key:metric.key,numeric_value:metric.value,unit:metric.key.endsWith('_tokens')?'tokens':'count',reporting_window_start:metric.time,reporting_window_end:new Date(Date.parse(metric.time)+1).toISOString(),observed_at:metric.time,synchronization_run_id:`native:${metric.identity}`,dimensions:{},source_evidence:{task_id:event.identity.taskId,root_task_id:event.identity.rootTaskId,operation_id:event.identity.operationId}}));
  if(result.kind==='conflict')throw new Error('NATIVE_ANALYTICS_RECORD_CONFLICT');
 }
 return metrics.length;
}
export function nativeAnalyticsSettings(environment:NodeJS.ProcessEnv=process.env):AnalyticsPublisherSettings|undefined {
 const endpoint=environment.AGENTS_ANALYTICS_INGESTION_URL,token=environment.AGENTS_ANALYTICS_INGESTION_TOKEN;
 if(!endpoint&&!token)return;
 if(!endpoint||!token)throw new Error('Configure both Agents Analytics ingestion URL and token');
 const url=new URL(endpoint);
 if(url.username||url.password||url.search||url.hash||(!['https:'].includes(url.protocol)&&!(environment.NODE_ENV!=='production'&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))))throw new Error('Agents Analytics ingestion requires HTTPS or a local development endpoint');
 return {endpoint:url.href.replace(/\/$/,''),token,producer_id:'agent-platform-customer-analytics',publisher_id:`agents:${randomUUID()}`,batch_size:100,lease_duration_ms:30000,request_timeout_ms:5000};
}
export function startNativeAnalyticsPublisher(pool:Pool,environment:NodeJS.ProcessEnv=process.env){
 const settings=nativeAnalyticsSettings(environment);
 if(!settings)return {async stop(){}};
 const client=new AnalyticsIngestionClient(settings.endpoint,settings.token,settings.request_timeout_ms);
 let stopped=false,pending:Promise<unknown>|undefined;
 const run=()=>{if(stopped||pending)return;pending=(async()=>{await recordOperationsWorkerHeartbeat(pool,"native_publisher",environment);await queueNativeAnalytics(pool);return publishOutboxOnce(pool,client,settings);})().catch(()=>{process.stderr.write(JSON.stringify({event:'analytics.native.publish.failed',service:'agents-platform',error_code:'native_publish_failed',retryable:true})+'\n');}).finally(()=>{pending=undefined;});};
 const timer=setInterval(run,1000);timer.unref();run();
 return {async stop(){stopped=true;clearInterval(timer);await pending;}};
}
