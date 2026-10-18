import type { Pool } from "pg";
import { metrics } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { transaction } from "../infrastructure/database";

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
      UNION ALL SELECT 'agents.dispatch.attempts',coalesce(sum(attempts),0)::text,'{}'::jsonb FROM agents_platform.task_outbox WHERE created_at>now()-interval '24 hours'
      UNION ALL SELECT 'agents.operations',count(*)::text,jsonb_build_object('kind',kind,'state',state) FROM agents_platform.operations WHERE started_at>now()-interval '24 hours' OR completed_at IS NULL GROUP BY kind,state
      UNION ALL SELECT 'agents.operations.duration_p95_ms',coalesce(percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM completed_at-started_at)*1000),0)::text,jsonb_build_object('kind',kind)
        FROM agents_platform.operations WHERE completed_at>now()-interval '1 hour' GROUP BY kind
      UNION ALL SELECT 'agents.usage.tokens',coalesce(sum(accounted_tokens),0)::text,jsonb_build_object('kind',kind) FROM agents_platform.operations WHERE started_at>now()-interval '24 hours' GROUP BY kind
      UNION ALL SELECT 'agents.inbox.commands',count(*)::text,jsonb_build_object('action',action) FROM agents_platform.customer_commands WHERE created_at>now()-interval '24 hours' GROUP BY action
      UNION ALL SELECT 'agents.inbox.deliveries',count(*)::text,jsonb_build_object('state',state) FROM agents_platform.customer_deliveries WHERE created_at>now()-interval '24 hours' GROUP BY state
      UNION ALL SELECT 'agents.resources',count(*)::text,jsonb_build_object('kind','sandbox','state',state) FROM agents_platform.sandbox_allocations WHERE state<>'destroyed' GROUP BY state
      UNION ALL SELECT 'agents.resources',count(*)::text,jsonb_build_object('kind','document','state',state) FROM agents_platform.document_allocations WHERE state<>'destroyed' GROUP BY state
      UNION ALL SELECT 'agents.resources',count(*)::text,jsonb_build_object('kind','query_embedding','state',state) FROM agents_platform.query_embedding_allocations WHERE state<>'destroyed' GROUP BY state
      UNION ALL SELECT 'agents.database.lock_waiters',count(*)::text,'{}'::jsonb FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted
      UNION ALL SELECT 'agents.database.oldest_lock_wait_ms',coalesce(max(extract(epoch FROM now()-l.waitstart)*1000),0)::text,'{}'::jsonb FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted
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
  const names=["agents.tasks","agents.capacity.requests","agents.capacity.oldest_wait_ms","agents.capacity.wait_p95_ms","agents.dispatch.pending","agents.dispatch.oldest_ms","agents.dispatch.attempts","agents.operations","agents.operations.duration_p95_ms","agents.usage.tokens","agents.inbox.commands","agents.inbox.deliveries","agents.resources","agents.observation.pending","agents.database.lock_waiters","agents.database.oldest_lock_wait_ms","agents.pool.connections"];
  const instruments=new Map(names.map(name=>[name,meter.createObservableGauge(name,{description:"Native snapshot; rolling windows documented in Agents observability reference"})]));
  let failures=0;
  const failed=meter.createObservableGauge("agents.metrics.collection_failures");
  meter.addBatchObservableCallback(async result=>{
    try{for(const point of await collectNativeMetrics(pool,role))result.observe(instruments.get(point.name)!,point.value,point.attributes);}catch{failures++;}
    result.observe(failed,failures);
  },[...instruments.values(),failed]);
  return {forceFlush:()=>provider.forceFlush(),shutdown:()=>provider.shutdown()};
}
