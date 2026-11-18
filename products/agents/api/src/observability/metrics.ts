import { createModelInvocationMetrics } from "./model-telemetry";
import { subscribeConnectionTelemetry } from "./connection-telemetry";
import type { Pool } from "pg";
import { metrics } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import type { Meter } from "@opentelemetry/api";
import { dispatcherPhases, type DispatcherPhase } from "../contracts/execution";
import { transaction } from "../infrastructure/database";

export function createDispatcherPhaseMetrics(meter:Meter) {
  const duration=meter.createHistogram("agents.dispatcher.phase.duration_ms",{unit:"ms"});
  const passes=meter.createCounter("agents.dispatcher.phase.passes");
  return (phase:DispatcherPhase,durationMs:number,success:boolean):void=>{
    if(!dispatcherPhases.includes(phase)||!Number.isFinite(durationMs)||durationMs<0||typeof success!=="boolean")return;
    const attributes={phase,outcome:success?"ok":"error"};
    duration.record(durationMs,attributes);passes.add(1,attributes);
  };
}

export function createConnectionControlMetrics(meter:Meter){
  const duration=meter.createHistogram("agents.connection.lifecycle.duration_ms",{unit:"ms"});
  const attempts=meter.createCounter("agents.connection.lifecycle.attempts");
  return subscribeConnectionTelemetry(event=>{
    const attributes={provider:event.provider,flow:event.flow,outcome:event.outcome,...(event.failureClass?{failure_class:event.failureClass}:{})};
    attempts.add(1,attributes);duration.record(event.durationMs,attributes);
  });
}

export interface MetricPoint { name: string; value: number; attributes: Record<string,string> }
/** Read native facts without event-export counters: retries cannot count usage twice. */
export async function collectNativeMetrics(pool:Pool,role:string):Promise<MetricPoint[]> {
  return transaction(pool,async db=>{
    await db.query("SET LOCAL statement_timeout='1500ms'");
    const result=await db.query<{name:string;value:string;attributes:Record<string,string>}>(`
      SELECT 'agents.tasks' name,count(*)::text value,jsonb_build_object('product',product,'program',effective_composition->'program'->>'id','state',state) attributes
        FROM agents_platform.tasks WHERE state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') OR created_at>now()-interval '24 hours' GROUP BY product,effective_composition->'program'->>'id',state
      UNION ALL SELECT 'agents.capacity.requests',count(*)::text,jsonb_build_object('workload',workload,'state',state)
        FROM agents_platform.capacity_requests WHERE finished_at IS NULL OR created_at>now()-interval '24 hours' GROUP BY workload,state
      UNION ALL SELECT 'agents.capacity.oldest_wait_ms',coalesce(max(extract(epoch FROM now()-created_at)*1000),0)::text,jsonb_build_object('workload',workload)
        FROM agents_platform.capacity_requests WHERE state='waiting' GROUP BY workload
      UNION ALL SELECT 'agents.capacity.wait_p95_ms',coalesce(percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM granted_at-created_at)*1000),0)::text,jsonb_build_object('workload',workload)
        FROM agents_platform.capacity_requests WHERE granted_at>now()-interval '1 hour' GROUP BY workload
      UNION ALL SELECT 'agents.dispatch.pending',count(*)::text,'{}'::jsonb FROM agents_platform.task_outbox WHERE dispatched_at IS NULL
      UNION ALL SELECT 'agents.dispatch.oldest_ms',coalesce(max(extract(epoch FROM now()-created_at)*1000),0)::text,'{}'::jsonb FROM agents_platform.task_outbox WHERE dispatched_at IS NULL
      UNION ALL SELECT 'agents.dispatch.leases',count(*)::text,jsonb_build_object('owner',lease_owner) FROM agents_platform.task_outbox WHERE lease_owner IS NOT NULL AND lease_until>now() GROUP BY lease_owner
      UNION ALL SELECT 'agents.dispatch.attempts',coalesce(sum(attempts),0)::text,'{}'::jsonb FROM agents_platform.task_outbox WHERE created_at>now()-interval '24 hours'
      UNION ALL SELECT 'agents.operations',count(*)::text,jsonb_build_object('kind',kind,'state',state) FROM agents_platform.operations WHERE started_at>now()-interval '24 hours' OR completed_at IS NULL GROUP BY kind,state
      UNION ALL SELECT 'agents.operations.duration_p95_ms',coalesce(percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM completed_at-started_at)*1000),0)::text,jsonb_build_object('kind',kind)
        FROM agents_platform.operations WHERE completed_at>now()-interval '1 hour' GROUP BY kind
      UNION ALL SELECT 'agents.usage.tokens',coalesce(sum(accounted_tokens),0)::text,jsonb_build_object('kind',kind) FROM agents_platform.operations WHERE started_at>now()-interval '24 hours' GROUP BY kind
      UNION ALL SELECT 'agents.model.budget_roots',count(*)::text,jsonb_build_object('budget','cost','state',CASE WHEN a.max_cost_micros IS NULL THEN 'unlimited' WHEN a.used_micros::numeric+a.reserved_micros>=a.max_cost_micros THEN 'saturated' ELSE 'available' END)
        FROM agents_platform.root_model_accounts a JOIN agents_platform.execution_roots r USING(root_task_id) WHERE r.settled_at IS NULL
        GROUP BY CASE WHEN a.max_cost_micros IS NULL THEN 'unlimited' WHEN a.used_micros::numeric+a.reserved_micros>=a.max_cost_micros THEN 'saturated' ELSE 'available' END
      UNION ALL SELECT 'agents.model.budget_roots',count(*)::text,jsonb_build_object('budget','tokens','state',CASE WHEN r.tokens_used::bigint+r.tokens_reserved+r.child_reserved_tokens>=t.root_token_limit THEN 'saturated' ELSE 'available' END)
        FROM agents_platform.execution_roots r JOIN agents_platform.tasks t ON t.id=r.root_task_id WHERE r.settled_at IS NULL
        GROUP BY CASE WHEN r.tokens_used::bigint+r.tokens_reserved+r.child_reserved_tokens>=t.root_token_limit THEN 'saturated' ELSE 'available' END
      UNION ALL SELECT 'agents.model.unknown_cost_operations',coalesce(sum(unknown_operations),0)::text,'{}'::jsonb FROM agents_platform.root_model_accounts
      UNION ALL SELECT 'agents.inbox.commands',count(*)::text,jsonb_build_object('action',action) FROM agents_platform.customer_commands WHERE created_at>now()-interval '24 hours' GROUP BY action
      UNION ALL SELECT 'agents.inbox.deliveries',count(*)::text,jsonb_build_object('state',state) FROM agents_platform.customer_deliveries WHERE created_at>now()-interval '24 hours' GROUP BY state
      UNION ALL SELECT 'agents.channels.connections',count(*)::text,jsonb_build_object('channel',kind,'state',state,
          'provider_health',CASE WHEN mode='growth_managed' THEN COALESCE(metadata#>>'{growthChannelHealth,state}','ready') ELSE 'native' END)
        FROM agents_platform.channel_connections GROUP BY kind,state,mode,metadata#>>'{growthChannelHealth,state}'
      UNION ALL SELECT 'agents.channels.ingress',count(*)::text,jsonb_build_object('channel',c.kind,'state',i.state)
        FROM agents_platform.channel_ingress i JOIN agents_platform.channel_connections c ON c.id=i.connection_id
        WHERE i.state IN ('pending','processing','quarantined') OR i.created_at>now()-interval '24 hours' GROUP BY c.kind,i.state
      UNION ALL SELECT 'agents.channels.delivery',count(*)::text,jsonb_build_object('channel',c.kind,'state',o.state)
        FROM agents_platform.channel_outbound o JOIN agents_platform.channel_connections c ON c.id=o.connection_id
        WHERE o.state IN ('pending','sending','unknown') OR o.created_at>now()-interval '24 hours' GROUP BY c.kind,o.state
      UNION ALL SELECT 'agents.channels.oldest_pending_ms',coalesce(max(extract(epoch FROM now()-o.created_at)*1000),0)::text,jsonb_build_object('channel',c.kind)
        FROM agents_platform.channel_outbound o JOIN agents_platform.channel_connections c ON c.id=o.connection_id WHERE o.state='pending' GROUP BY c.kind
      UNION ALL SELECT 'agents.resources',count(*)::text,jsonb_build_object('kind','sandbox','state',state) FROM agents_platform.sandbox_allocations WHERE state<>'destroyed' GROUP BY state
      UNION ALL SELECT 'agents.resources',count(*)::text,jsonb_build_object('kind','document','state',state) FROM agents_platform.document_allocations WHERE state<>'destroyed' GROUP BY state
      UNION ALL SELECT 'agents.resources',count(*)::text,jsonb_build_object('kind','query_embedding','state',state) FROM agents_platform.query_embedding_allocations WHERE state<>'destroyed' GROUP BY state
      UNION ALL SELECT 'agents.database.lock_waiters',count(*)::text,'{}'::jsonb FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted
      UNION ALL SELECT 'agents.database.oldest_lock_wait_ms',coalesce(max(extract(epoch FROM now()-l.waitstart)*1000),0)::text,'{}'::jsonb FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted
      UNION ALL SELECT 'agents.resources.cleanup',count(*)::text,jsonb_build_object('kind','sandbox','state',state) FROM agents_platform.sandbox_allocations WHERE state IN ('destroyed','destroying','uncertain') AND updated_at>now()-interval '24 hours' GROUP BY state
      UNION ALL SELECT 'agents.resources.cleanup',count(*)::text,jsonb_build_object('kind','document','state',state) FROM agents_platform.document_allocations WHERE state IN ('destroyed','failed') AND updated_at>now()-interval '24 hours' GROUP BY state
      UNION ALL SELECT 'agents.resources.cleanup',count(*)::text,jsonb_build_object('kind','query_embedding','state',state) FROM agents_platform.query_embedding_allocations WHERE state='destroyed' AND updated_at>now()-interval '24 hours' GROUP BY state
      UNION ALL SELECT 'agents.connections',count(*)::text,jsonb_build_object('kind',profile_id,'state',state) FROM agents_platform.connections GROUP BY profile_id,state
      UNION ALL SELECT 'agents.connection.setup',count(*)::text,jsonb_build_object('state',status) FROM agents_platform.connection_onboarding GROUP BY status
      UNION ALL SELECT 'agents.tool_reviews',count(*)::text,jsonb_build_object('state',state) FROM agents_platform.tool_invocation_reviews WHERE state IN ('pending','approved','claimed','uncertain') OR created_at>now()-interval '24 hours' GROUP BY state
      UNION ALL SELECT 'agents.tool_reviews.oldest_pending_ms',coalesce(max(extract(epoch FROM now()-created_at)*1000),0)::text,'{}'::jsonb FROM agents_platform.tool_invocation_reviews WHERE state='pending' AND expires_at>now()
      UNION ALL SELECT 'agents.connected.operations',count(*)::text,jsonb_build_object('state',state) FROM agents_platform.connected_reads WHERE created_at>now()-interval '24 hours' OR state IN ('started','uncertain') GROUP BY state
      UNION ALL SELECT 'agents.connected.provider.attempts',count(*)::text,jsonb_build_object('provider',CASE c.profile_id WHEN 'remote-mcp-v1' THEN 'mcp' WHEN 'custom-api-v1' THEN 'native_api' ELSE 'other' END,'phase',a.phase,'outcome',CASE WHEN a.receipt->>'outcome' IN ('response','ok') AND (a.receipt->>'status')::integer<400 THEN 'response' ELSE 'failed' END)
        FROM agents_platform.connected_attempts a JOIN agents_platform.connected_reads r ON r.operation_id=a.operation_id JOIN agents_platform.connections c ON c.id=r.connection_id
        WHERE r.created_at>now()-interval '1 hour' AND a.receipt IS NOT NULL GROUP BY CASE c.profile_id WHEN 'remote-mcp-v1' THEN 'mcp' WHEN 'custom-api-v1' THEN 'native_api' ELSE 'other' END,a.phase,CASE WHEN a.receipt->>'outcome' IN ('response','ok') AND (a.receipt->>'status')::integer<400 THEN 'response' ELSE 'failed' END
      UNION ALL SELECT 'agents.connected.provider.latency_p95_ms',coalesce(percentile_cont(0.95) WITHIN GROUP(ORDER BY (a.receipt->>'elapsedMs')::double precision),0)::text,jsonb_build_object('provider',CASE c.profile_id WHEN 'remote-mcp-v1' THEN 'mcp' WHEN 'custom-api-v1' THEN 'native_api' ELSE 'other' END,'phase',a.phase)
        FROM agents_platform.connected_attempts a JOIN agents_platform.connected_reads r ON r.operation_id=a.operation_id JOIN agents_platform.connections c ON c.id=r.connection_id
        WHERE r.created_at>now()-interval '1 hour' AND a.receipt IS NOT NULL GROUP BY CASE c.profile_id WHEN 'remote-mcp-v1' THEN 'mcp' WHEN 'custom-api-v1' THEN 'native_api' ELSE 'other' END,a.phase
      UNION ALL SELECT 'agents.observation.pending',count(*)::text,'{}'::jsonb FROM agents_platform.observation_exports WHERE exported_at IS NULL
    `);
    const points=result.rows.map(row=>({name:row.name,value:Number(row.value),attributes:row.attributes}));
    points.push(...[{state:"total",value:pool.totalCount},{state:"idle",value:pool.idleCount},{state:"waiting",value:pool.waitingCount}].map(item=>({name:"agents.pool.connections",value:item.value,attributes:{role,state:item.state}})));
    return points.filter(point=>Number.isFinite(point.value)&&point.value>=0);
  });
}

/** Aggregated snapshot gauges are scoped by replica; never sum them across replicas. */
export function createNativeMetrics(pool:Pool,role:string,environment:NodeJS.ProcessEnv=process.env) {
  if(environment.OTEL_SDK_DISABLED==="true")return;
  const endpoint=environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT??(environment.OTEL_EXPORTER_OTLP_ENDPOINT?`${environment.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/,"")}/v1/metrics`:undefined);
  if(!endpoint)return;
  const url=new URL(endpoint);if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.hash)throw Error("INVALID_OTEL_ENDPOINT");
  const exporter=new OTLPMetricExporter({url:url.href,timeoutMillis:3000});
  const reader=new metrics.PeriodicExportingMetricReader({exporter,exportIntervalMillis:15000,exportTimeoutMillis:5000});
  const provider=new metrics.MeterProvider({readers:[reader],resource:resourceFromAttributes({"service.name":`agents-${role}`,"service.instance.id":`${process.pid}`,"service.namespace":"kasitek-agents"})});
  const meter=provider.getMeter("kasitek-agents-native-metrics","1");
  const names=["agents.channels.connections","agents.channels.ingress","agents.channels.delivery","agents.channels.oldest_pending_ms","agents.model.budget_roots","agents.model.unknown_cost_operations","agents.connected.provider.attempts","agents.connected.provider.latency_p95_ms","agents.connections","agents.connection.setup","agents.tool_reviews","agents.tool_reviews.oldest_pending_ms","agents.connected.operations","agents.tasks","agents.capacity.requests","agents.capacity.oldest_wait_ms","agents.capacity.wait_p95_ms","agents.dispatch.pending","agents.dispatch.oldest_ms","agents.dispatch.attempts","agents.dispatch.leases","agents.operations","agents.operations.duration_p95_ms","agents.usage.tokens","agents.inbox.commands","agents.inbox.deliveries","agents.resources","agents.resources.cleanup","agents.observation.pending","agents.database.lock_waiters","agents.database.oldest_lock_wait_ms","agents.pool.connections"];
  const instruments=new Map(names.map(name=>[name,meter.createObservableGauge(name,{description:"Native snapshot; rolling windows documented in Agents observability reference"})]));
  let failures=0;
  const failed=meter.createObservableGauge("agents.metrics.collection_failures");
  meter.addBatchObservableCallback(async result=>{
    try{for(const point of await collectNativeMetrics(pool,role))result.observe(instruments.get(point.name)!,point.value,point.attributes);}catch{failures++;}
    result.observe(failed,failures);
  },[...instruments.values(),failed]);
  const unsubscribe=createConnectionControlMetrics(meter), unsubscribeModels=createModelInvocationMetrics(meter);
  return {dispatcherPhase:createDispatcherPhaseMetrics(meter),forceFlush:()=>provider.forceFlush(),shutdown:async()=>{unsubscribe();unsubscribeModels();await provider.shutdown();}};
}
