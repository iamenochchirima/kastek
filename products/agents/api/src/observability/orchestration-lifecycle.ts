import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { buildEvent, buildScopeDefinition, enqueueOutbox } from "@kasitek-labs/server-support/analytics-producer";

const inputSchema = z.strictObject({
  organizationId:z.uuid(), key:z.string().min(1).max(256),
  action:z.enum(["started","revision","completed","failed","stalled"]),
  outcome:z.enum(["pending","completed","incomplete","refused","failed","cancelled","uncertain"]),
  revision:z.number().int().min(0).max(2147483647).default(0),
  specialistTasks:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), occurredAt:z.iso.datetime(),
});
export type OrchestrationLifecycleInput = z.input<typeof inputSchema>;
/** Commit with native state; occurredAt must come from that persisted event for stable retries. */
export async function recordOrchestrationLifecycle(db:PoolClient,raw:OrchestrationLifecycleInput):Promise<void>{
  const input=inputSchema.parse(raw);
  const recordId=`orchestration:${createHash("sha256").update(`${input.key}:${input.action}:${input.revision}`).digest("hex")}`;
  const producer={source_service:"agent-platform",source_namespace:"agent-platform",source_origin:"kasitek://agents"};
  const scope={source_domain:"agents",source_stream_key:`organization:agents_organization:${input.organizationId}:agents`,
    scope_kind:"agents_organization" as const,scope_external_id:input.organizationId};
  await enqueueOutbox(db,buildScopeDefinition(producer,{...scope,record_id:`scope:${input.organizationId}`,
    contract_name:"agent.scope.definition@1",schema_version:1,reporting_timezone:"UTC",status:"active",source_version:1}));
  const result=await enqueueOutbox(db,buildEvent(producer,{...scope,record_id:recordId,contract_name:"agent.orchestration.lifecycle@1",
    schema_version:1,subject_type:"organization",subject_id:input.organizationId,occurred_at:input.occurredAt,
    attributes:{action:input.action,outcome:input.outcome,revision:input.revision,specialist_tasks:input.specialistTasks,occurred_at:input.occurredAt},idempotency_key:recordId}));
  if(result.kind==="conflict")throw new Error("ORCHESTRATION_ANALYTICS_CONFLICT");
}
