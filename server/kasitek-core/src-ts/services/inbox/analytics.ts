import type { PoolClient } from 'pg';
import type { JsonValue } from '@kasitek/contracts';
import { enqueueEvent, enqueueManifest } from '../../analytics/index.js';
async function event(
  tx: PoolClient,
  org: string,
  subjectType: string,
  subjectId: string,
  action: string,
  time: Date,
  attributes: Record<string, JsonValue>,
) {
  const id = `${subjectType}:${subjectId}:${action}:${time.getTime()}`;
  return enqueueEvent(tx, {
    record_id: id,
    source_domain: 'inbox',
    source_stream_key: `organization:${org}:inbox`,
    contract_name:
      subjectType === 'message'
        ? 'conversation.message.lifecycle@1'
        : 'conversation.lifecycle@1',
    schema_version: 1,
    scope_kind: 'core_organization',
    scope_external_id: org,
    subject_type: subjectType,
    subject_id: subjectId,
    occurred_at: time,
    attributes,
    idempotency_key: id,
    correlation_id: null,
    causation_id: null,
  });
}
export const enqueueConversationLifecycle = (
  tx: PoolClient,
  org: string,
  id: string,
  channel: string,
  action: string,
  status: string,
  actorType: string,
  time: Date,
) =>
  event(tx, org, 'conversation', id, action, time, {
    conversation_id: id,
    channel,
    action,
    status,
    actor_type: actorType,
    occurred_at: time.toISOString(),
  });
export const enqueueMessageLifecycle = (
  tx: PoolClient,
  org: string,
  id: string,
  conversationId: string,
  channel: string,
  action: string,
  direction: string,
  responderType: string,
  messageType: string,
  deliveryStatus: string | null,
  responseTimeMs: number | null,
  time: Date,
) =>
  event(tx, org, 'message', id, action, time, {
    message_id: id,
    conversation_id: conversationId,
    channel,
    action,
    direction,
    responder_type: responderType,
    message_type: messageType,
    delivery_status: deliveryStatus,
    response_time_ms: responseTimeMs,
    occurred_at: time.toISOString(),
  });
export async function precedingCustomerResponseTimeMs(
  tx: PoolClient,
  id: string,
  time: Date,
): Promise<number | null> {
  const row = (
    await tx.query<{ response_time_ms: string | null }>(
      `SELECT GREATEST(0,ROUND(EXTRACT(EPOCH FROM (($2::timestamptz-timestamp)*1000))))::bigint AS response_time_ms FROM "Message" WHERE "conversationId"=$1 AND sender='customer' AND timestamp<=$2 ORDER BY timestamp DESC LIMIT 1`,
      [id, time],
    )
  ).rows[0];
  return row?.response_time_ms == null ? null : Number(row.response_time_ms);
}
export async function enqueueMetaManifest(
  tx: PoolClient,
  org: string,
  count: number,
  time = new Date(),
) {
  const stream = `organization:${org}:inbox`,
    version = Math.max(1, Math.floor(time.getTime() / 3600000));
  return enqueueManifest(tx, {
    record_id: `manifest:${stream}:core.inbox.meta:${version}`,
    source_domain: 'inbox',
    source_stream_key: stream,
    contract_name: 'source.manifest@1',
    schema_version: 1,
    scope_kind: 'core_organization',
    scope_external_id: org,
    manifest_key: 'core.inbox.meta',
    manifest_version: version,
    provider: 'meta',
    connection_ref: null,
    supported_contracts: [
      'conversation.lifecycle@1',
      'conversation.message.lifecycle@1',
    ],
    supported_observation_contracts: [],
    supported_metrics: [
      'conversation.lifecycle_events',
      'conversation.message.lifecycle_events',
      'conversation.response_time_ms',
    ],
    supported_dimensions: [
      'conversation_channel',
      'lifecycle_action',
      'status',
      'message_action',
      'message_direction',
      'responder_type',
      'message_type',
      'message_delivery_status',
    ],
    expected_refresh_seconds: 3600,
    reliable_coverage_start: null,
    highest_authoritative_source_sequence: null,
    approved_checkpoint_count: count,
    approved_checkpoint_hash: null,
    last_successful_collection_at: time,
    last_attempted_collection_at: time,
    safe_failure_code: null,
    next_expected_at: new Date(time.getTime() + 3600000),
    manifest_state: 'active',
    generated_at: time,
    idempotency_key: null,
  });
}
