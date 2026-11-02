import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { buildEvent, enqueueOutbox } from "@kasitek-labs/server-support/analytics-producer";
import type { JsonObject } from "@kasitek-labs/contracts";

const producer = { source_service: "agent-platform", source_namespace: "agent-platform", source_origin: "kasitek://agents" };
const actions = ["handoff_requested", "acknowledgement_committed", "waiting_update_committed", "handoff_overdue", "staff_alert_created", "first_human_reply", "customer_notification_delivery"] as const;
const outcomes = ["accepted", "model", "fallback", "published", "created", "accepted_by_provider", "sent", "delivered", "read", "failed", "unknown", "suppressed"] as const;
const channels = ["website", "whatsapp", "telegram", "facebook", "instagram"] as const;
export type SupportLifecycleAction = typeof actions[number];
export type SupportLifecycleOutcome = typeof outcomes[number];
export type SupportChannelKind = typeof channels[number];
const deliveryOutcomes = new Set<SupportLifecycleOutcome>(["accepted_by_provider", "sent", "delivered", "read", "failed", "unknown", "suppressed"]);

interface SupportLifecycleInput {
  conversationId: string;
  /** Private source identity used only to derive a stable opaque outbox key. */
  sourceKey: string;
  action: SupportLifecycleAction;
  outcome: SupportLifecycleOutcome;
  occurredAt: Date;
  durationMs?: number;
}

/**
 * Enqueue bounded support facts in the same transaction as their canonical
 * transition. Conversation, customer, staff and message identifiers never
 * enter the Analytics event attributes or dimensions.
 */
export async function recordSupportLifecycle(db: PoolClient, input: SupportLifecycleInput): Promise<boolean> {
  const context = (await db.query<{
    organization_id: string;
    agent_id: string;
    version_id: string;
    channel_kind: SupportChannelKind;
    evaluation_trial: boolean;
  }>(`SELECT c.organization_id,c.agent_id,c.version_id,c.channel_kind,
      (EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.session_id=c.session_id)
        OR EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=c.channel_deployment_id)) AS evaluation_trial
    FROM agents_platform.customer_conversations c WHERE c.id=$1`, [input.conversationId])).rows[0];
  if (!context) throw new Error("SUPPORT_ANALYTICS_CONVERSATION_MISSING");
  if (context.evaluation_trial) return false;

  const occurredAt = input.occurredAt.toISOString();
  const durationMs = input.durationMs !== undefined && Number.isSafeInteger(input.durationMs)
    && input.durationMs >= 0 && input.durationMs <= 2_592_000_000
    ? input.durationMs : undefined;
  const attributes: JsonObject = {
    agent_definition_id: context.agent_id,
    agent_version_id: context.version_id,
    channel_type: context.channel_kind,
    action: input.action,
    outcome: input.outcome,
    occurred_at: occurredAt,
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
  };
  const opaqueIdentity = createHash("sha256").update(`${input.sourceKey}\u0000${input.action}\u0000${input.outcome}`).digest("hex");
  const recordId = `support:${opaqueIdentity}`;
  const record = buildEvent(producer, {
    record_id: recordId,
    source_domain: "agents",
    source_stream_key: `organization:agents_organization:${context.organization_id}:agents`,
    contract_name: "agent.support.lifecycle@1",
    schema_version: 1,
    scope_kind: "agents_organization",
    scope_external_id: context.organization_id,
    subject_type: "agent_definition",
    subject_id: context.agent_id,
    occurred_at: occurredAt,
    attributes,
    idempotency_key: recordId,
  });
  const result = await enqueueOutbox(db, record);
  if (result.kind === "conflict") throw new Error("SUPPORT_ANALYTICS_RECORD_CONFLICT");
  return result.kind === "inserted";
}

/** Record provider receipts only for acknowledgements, waiting updates and human replies. */
export async function recordSupportNotificationDelivery(db: PoolClient, input: { deliveryId: string; state: string; occurredAt: Date }): Promise<boolean> {
  const outcome: SupportLifecycleOutcome = input.state === "accepted" ? "accepted_by_provider"
    : deliveryOutcomes.has(input.state as SupportLifecycleOutcome) ? input.state as SupportLifecycleOutcome : "unknown";
  const row = (await db.query<{ conversation_id: string; episode_id: string; segment: number }>(`SELECT c.id conversation_id,episode.task_id episode_id,o.segment
    FROM agents_platform.channel_outbound o
    JOIN agents_platform.customer_conversations c ON c.id=o.conversation_id
    JOIN agents_platform.customer_messages m ON m.id=o.message_id AND m.conversation_id=c.id
    JOIN LATERAL (SELECT w.task_id FROM agents_platform.support_waiting w WHERE w.conversation_id=c.id
      AND m.ownership_generation>=w.ownership_generation
      AND (m.author_kind='human'
        OR EXISTS(SELECT 1 FROM agents_platform.support_waiting_notices n WHERE n.task_id=w.task_id AND n.message_id=m.id)
        OR EXISTS(SELECT 1 FROM agents_platform.pending_handoff_receipts r WHERE r.task_id=w.task_id AND r.conversation_id=c.id AND r.message_id=m.id)
        OR EXISTS(SELECT 1 FROM agents_platform.customer_commands command WHERE command.conversation_id=c.id AND command.command_id=w.task_id
          AND command.action='request_handoff' AND command.result->>'handoffReceiptId'=m.id::text))
      ORDER BY w.ownership_generation DESC,w.requested_at DESC LIMIT 1) episode ON true
    WHERE o.id=$1`, [input.deliveryId])).rows[0];
  if (!row) return false;
  return recordSupportLifecycle(db, { conversationId: row.conversation_id, sourceKey: `support-delivery:${input.deliveryId}:${row.segment}:${outcome}`,
    action: "customer_notification_delivery", outcome, occurredAt: input.occurredAt });
}

/** Record an opted-in notification for a human reply in the website conversation. */
export async function recordSupportFollowupDelivery(db: PoolClient, input: { notificationId: string; state: string; occurredAt: Date }): Promise<boolean> {
  const outcome: SupportLifecycleOutcome = input.state === "accepted" ? "accepted_by_provider"
    : input.state === "rejected" ? "failed" : input.state === "unknown" ? "unknown" : "suppressed";
  const row = (await db.query<{ conversation_id: string; episode_id: string }>(`SELECT c.id conversation_id,episode.task_id episode_id
    FROM agents_platform.customer_followup_notifications n
    JOIN agents_platform.customer_conversations c ON c.id=n.conversation_id
    JOIN agents_platform.customer_messages m ON m.id=n.message_id AND m.conversation_id=c.id AND m.author_kind='human'
    JOIN LATERAL (SELECT w.task_id FROM agents_platform.support_waiting w WHERE w.conversation_id=c.id
      AND m.ownership_generation>=w.ownership_generation ORDER BY w.ownership_generation DESC,w.requested_at DESC LIMIT 1) episode ON true
    WHERE n.id=$1`, [input.notificationId])).rows[0];
  if (!row) return false;
  return recordSupportLifecycle(db, { conversationId: row.conversation_id, sourceKey: `support-followup:${input.notificationId}:${outcome}`,
    action: "customer_notification_delivery", outcome, occurredAt: input.occurredAt });
}
