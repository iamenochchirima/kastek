import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { buildEvent, buildScopeDefinition, enqueueOutbox } from "@kasitek-labs/server-support/analytics-producer";

type Action="provisioned"|"restored"|"link_challenge_created"|"link_pending"|"link_confirmed"|"link_revoked"|"task_admitted"|"task_completed";
/** Only aggregate lifecycle facts leave the product; identities are used solely for opaque deduplication. */
export async function recordAssistantLifecycle(db:PoolClient,input:{organizationId:string;key:string;action:Action;channel:"app"|"telegram"|"whatsapp"}) {
  const recordId=`assistant:${createHash('sha256').update(`${input.key}:${input.action}`).digest('hex')}`;
  const occurredAt=new Date().toISOString();
  const producer={source_service:'agent-platform',source_namespace:'agent-platform',source_origin:'kasitek://agents'};
  await enqueueOutbox(db,buildScopeDefinition(producer,{record_id:`scope:${input.organizationId}`,source_domain:'agents',
    source_stream_key:`organization:agents_organization:${input.organizationId}:agents`,contract_name:'agent.scope.definition@1',schema_version:1,
    scope_kind:'agents_organization',scope_external_id:input.organizationId,reporting_timezone:'UTC',status:'active',source_version:1}));
  const record=buildEvent({source_service:'agent-platform',source_namespace:'agent-platform',source_origin:'kasitek://agents'},
    {record_id:recordId,source_domain:'agents',source_stream_key:`organization:agents_organization:${input.organizationId}:agents`,contract_name:'agent.assistant.lifecycle@1',
      schema_version:1,scope_kind:'agents_organization',scope_external_id:input.organizationId,subject_type:'organization',subject_id:input.organizationId,
      occurred_at:occurredAt,attributes:{action:input.action,channel_type:input.channel,occurred_at:occurredAt},idempotency_key:recordId});
  const result=await enqueueOutbox(db,record);
  if(result.kind==='conflict')throw new Error('ASSISTANT_ANALYTICS_CONFLICT');
}
