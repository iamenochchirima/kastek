import { subscribeConnectionTelemetry } from "./connection-telemetry";
import { randomUUID,randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { ROOT_CONTEXT, trace, TraceFlags } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { requestDigest } from "../contracts/contracts";
import { observationSchema, type AgentObservation } from "../contracts/observations";
import { transaction } from "../infrastructure/database";

type RecordedSpan = Parameters<OTLPTraceExporter["export"]>[0][number];
export interface ObservationTransport {
  export(observations: AgentObservation[]): Promise<void>;
  shutdown(): Promise<void>;
}

/** Explicit metadata spans avoid HTTP/SQL auto-instrumentation capturing customer content. */
export function createObservationTelemetry(serviceName: string, environment: NodeJS.ProcessEnv = process.env): ObservationTransport | undefined {
  if (environment.OTEL_SDK_DISABLED === "true") return;
  const endpoint = environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (environment.OTEL_EXPORTER_OTLP_ENDPOINT ? `${environment.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces` : undefined);
  if (!endpoint) return;
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("INVALID_OTEL_ENDPOINT");
  const exporter = new OTLPTraceExporter({ url: url.href, timeoutMillis: 3000 });
  let captured: RecordedSpan[] = [], nextId = "", nextTraceId = "";
  const pending=new Set<Promise<void>>();
  const processor = { onStart() {}, onEnd(span: RecordedSpan) {
    if(!span.name.startsWith("connection.")){captured.push(span);return;}
    if(pending.size>=64)return;
    const job=new Promise<void>(resolve=>{try{exporter.export([span],()=>resolve());}catch{resolve();}});
    pending.add(job);void job.finally(()=>pending.delete(job));
  }, async forceFlush() {await Promise.all(pending);}, async shutdown() {} };
  const sdk = new NodeSDK({ autoDetectResources: false, instrumentations: [], spanProcessors: [processor],
    resource: resourceFromAttributes({ "service.name": serviceName, "service.namespace": "kasitek-agents",
      "deployment.environment.name": environment.NODE_ENV ?? "development" }),
    idGenerator: { generateSpanId: () => nextId||randomBytes(8).toString("hex"), generateTraceId: () => nextTraceId||randomBytes(16).toString("hex") },
  });
  sdk.start();
  const tracer = trace.getTracer("kasitek-agents-observations", "1");
  const unsubscribe=subscribeConnectionTelemetry(event=>{
    nextId=randomBytes(8).toString("hex");nextTraceId=event.traceId;
    const ended=Date.now(),attributes=Object.fromEntries(Object.entries(event).filter(([key])=>key!=="traceId").map(([key,value])=>[`agents.${key}`,value]));
    const span=tracer.startSpan(`connection.${event.flow}`,{attributes,startTime:ended-event.durationMs},ROOT_CONTEXT);
    span.end(ended);nextId="";nextTraceId="";
  });
  return {
    async export(observations) {
      captured = [];
      for (const raw of observations) {
        const item = observationSchema.parse(raw);
        nextId = item.id.slice(0, 16);
        nextTraceId = requestDigest(item.identity.rootTaskId).slice(0, 32);
        const parentTaskId = item.eventKey === "accepted"
          ? item.identity.parentTaskId ?? item.identity.rootTaskId
          : item.identity.taskId;
        const parent = trace.setSpanContext(ROOT_CONTEXT, { traceId: requestDigest(item.identity.rootTaskId).slice(0, 32),
          spanId: requestDigest([parentTaskId, "accepted"]).slice(0, 16), traceFlags: TraceFlags.SAMPLED, isRemote: true });
        const attributes: Record<string, string | number> = {
          "agents.observation_id": item.id, "agents.event_key": item.eventKey, "agents.category": item.category,
          ...Object.fromEntries(Object.entries(item.identity).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => [`agents.${key}`, value])),
          ...Object.fromEntries(Object.entries(item.metadata).map(([key, value]) => [`agents.${key}`, value!])),
        };
        const ended = new Date(item.occurredAt).getTime();
        // The accepted event is the task span; other events retain its native task parent.
        const span = tracer.startSpan(item.kind, { attributes, startTime: ended - (item.metadata.durationMs ?? 0) },
          item.eventKey === "accepted" && !item.identity.parentTaskId ? ROOT_CONTEXT : parent);
        span.end(ended);
      }
      const spans = captured; captured = [];
      if (!spans.length) throw new Error("OTEL_SPANS_UNAVAILABLE");
      await new Promise<void>((resolve, reject) => exporter.export(spans, result => result.code === 0 ? resolve() : reject(new Error("OTEL_EXPORT_FAILED"))));
    },
    async shutdown() { unsubscribe();await Promise.all(pending);await sdk.shutdown(); await exporter.shutdown(); },
  };
}

export async function publishObservationBatch(pool: Pool, transport: ObservationTransport, limit = 100): Promise<number> {
  const owner = randomUUID();
  const rows = await transaction(pool, async db => (await db.query<{ event_sequence: string; observation: unknown }>(`WITH batch AS (
    SELECT event_sequence FROM agents_platform.observation_exports WHERE exported_at IS NULL AND available_at<=now()
      AND (lease_until IS NULL OR lease_until<now()) ORDER BY event_sequence FOR UPDATE SKIP LOCKED LIMIT $1
  ), claimed AS (
    UPDATE agents_platform.observation_exports o SET lease_owner=$2,lease_until=now()+interval '15 seconds',attempts=attempts+1
      FROM batch WHERE o.event_sequence=batch.event_sequence RETURNING o.event_sequence
  ) SELECT e.sequence AS event_sequence,e.observation FROM agents_platform.task_events e JOIN claimed c ON c.event_sequence=e.sequence ORDER BY e.sequence`,
  [Math.max(1, Math.min(limit, 1000)), owner])).rows);
  if (!rows.length) return 0;
  const sequences = rows.map(row => row.event_sequence);
  try {
    await transport.export(rows.map(row => observationSchema.parse(row.observation)));
    await pool.query(`UPDATE agents_platform.observation_exports SET exported_at=now(),lease_owner=NULL,lease_until=NULL
      WHERE event_sequence=ANY($1::bigint[]) AND lease_owner=$2`, [sequences, owner]);
    return rows.length;
  } catch {
    await pool.query(`UPDATE agents_platform.observation_exports SET lease_owner=NULL,lease_until=NULL,
      available_at=now()+least(30,attempts)*interval '1 second' WHERE event_sequence=ANY($1::bigint[]) AND lease_owner=$2`, [sequences, owner]);
    return 0;
  }
}

export function startObservationPublisher(pool: Pool, transport: ObservationTransport | undefined) {
  let stopped = false, pending: Promise<unknown> | undefined;
  const run = () => { if (!stopped && transport && !pending) pending = publishObservationBatch(pool, transport).catch(() => 0).finally(() => { pending = undefined; }); };
  const timer = setInterval(run, 1000); timer.unref(); run();
  return { async stop() { stopped = true; clearInterval(timer); await pending; await transport?.shutdown(); } };
}
