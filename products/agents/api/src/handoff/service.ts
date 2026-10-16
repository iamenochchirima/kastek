import { createAgentEvent } from "../events/envelope";
import { HANDOFF_CLASSIFIER_VERSION, classifyHandoffIntent, type HandoffIntent } from "./intent";
import type {
  HandoffPriority,
  HandoffReason,
  HandoffRequestRecord,
} from "../db/repositories/handoff-repository";
import type { ConversationRecord } from "../db/repositories/conversation-repository";
import type { PoolClient } from "pg";

export type HandoffOfferReason = Exclude<HandoffReason, "customer_requested">;
export type HandoffOfferStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled";

export interface HandoffOfferRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  conversation_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  source_run_id: string | null;
  source_message_id: string | null;
  channel_type: string;
  reason: HandoffOfferReason;
  summary: string;
  status: HandoffOfferStatus;
  offered_by: string;
  decision_message_id: string | null;
  classifier_version: string | null;
  idempotency_key: string;
  expires_at: string;
  decided_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OfferHandoffInput {
  organizationId: string;
  installationId: string;
  agentId: string;
  agentVersionId: string;
  runId?: string;
  conversationId: string;
  actorId?: string;
  reason: HandoffOfferReason;
  priority?: HandoffPriority;
  summary: string;
  sourceMessageId?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface InboundHandoffDecisionInput {
  organizationId: string;
  installationId: string;
  agentId: string;
  agentVersionId: string;
  conversationId: string;
  messageId: string;
  channelType: string;
  content: Record<string, unknown>;
  customerMessage: string;
}

export type InboundHandoffDecision =
  | { kind: "none"; intent: HandoffIntent }
  | { kind: "declined"; intent: HandoffIntent; offer: HandoffOfferRecord; conversation: ConversationRecord }
  | { kind: "requested"; intent: HandoffIntent; offer: HandoffOfferRecord | null; handoff: HandoffRequestRecord; conversation: ConversationRecord };

function handoffError(message: string, code: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

function trimmedMessage(value: string): string | null {
  const message = value.replace(/\s+/g, " ").trim();
  return message ? message.slice(0, 4_000) : null;
}

function offerIdempotencyKey(input: OfferHandoffInput): string {
  return input.idempotencyKey?.trim() || `handoff-offer:${input.runId ?? "manual"}:${input.conversationId}`;
}

function requestIdempotencyKey(messageId: string): string {
  return `customer-handoff:${messageId}`;
}

/**
 * The single state-machine seam for customer handoff. Callers may propose an
 * offer, but only this service can turn trusted inbound customer evidence into
 * an ownership-changing request.
 */
export class ConversationHandoffService {
  public async offer(client: PoolClient, input: OfferHandoffInput): Promise<{ offer: HandoffOfferRecord; conversation: ConversationRecord; created: boolean }> {
    const summary = input.summary.trim();
    if (!summary) throw handoffError("A handoff offer summary is required", "handoff_summary_required", 400);
    if (summary.length > 2_000) throw handoffError("The handoff offer summary is too long", "handoff_summary_too_long", 400);
    const idempotencyKey = offerIdempotencyKey(input);

    const installation = await this.loadInstallation(client, input.organizationId, input.installationId);
    if (installation.agent_audience !== "customer_service") {
      throw handoffError("Personal agents cannot offer customer handoff", "personal_agent_handoff_not_allowed");
    }
    if (installation.agent_definition_id !== input.agentId || installation.agent_version_id !== input.agentVersionId) {
      throw handoffError("The handoff offer context does not match the installation", "handoff_context_mismatch");
    }

    const existing = await client.query<HandoffOfferRecord>(
      `SELECT * FROM agent_handoff_offers
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
       LIMIT 1`,
      [input.organizationId, input.installationId, idempotencyKey],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].conversation_id !== input.conversationId
        || existing.rows[0].agent_definition_id !== input.agentId
        || existing.rows[0].agent_version_id !== input.agentVersionId
      ) {
        throw handoffError("The handoff offer idempotency key is already used for another context", "handoff_idempotency_conflict");
      }
      const conversation = await this.loadConversation(client, input.organizationId, existing.rows[0].conversation_id);
      return { offer: existing.rows[0], conversation, created: false };
    }
    const conversation = await this.lockConversation(client, input.organizationId, input.installationId, input.conversationId);
    if (conversation.conversation_kind !== "customer") {
      throw handoffError("Only customer conversations support handoff", "conversation_not_customer");
    }
    if (conversation.handoff_state !== "agent_active") {
      throw handoffError("Conversation already has an active handoff state", "conversation_handoff_active");
    }

    const offerResult = await client.query<HandoffOfferRecord>(
      `INSERT INTO agent_handoff_offers
        (organization_id, installation_id, conversation_id, agent_definition_id,
         agent_version_id, source_run_id, source_message_id, channel_type, reason,
         summary, offered_by, classifier_version, idempotency_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
       RETURNING *`,
      [
        input.organizationId,
        input.installationId,
        input.conversationId,
        input.agentId,
        input.agentVersionId,
        input.runId ?? null,
        input.sourceMessageId ?? null,
        conversation.channel_type,
        input.reason,
        summary,
        input.actorId ?? `agent:${input.agentId}`,
        HANDOFF_CLASSIFIER_VERSION,
        idempotencyKey,
        JSON.stringify({ ...(input.metadata ?? {}), priority: input.priority ?? "normal" }),
      ],
    );
    const offer = offerResult.rows[0];
    if (!offer) throw new Error("Handoff offer could not be created");
    await this.appendEvent(client, {
      eventType: "conversation.handoff.offer_created",
      organizationId: input.organizationId,
      runId: input.runId ?? null,
      installationId: input.installationId,
      conversationId: input.conversationId,
      actorType: "agent",
      actorId: input.actorId ?? `agent:${input.agentId}`,
      payload: { offerId: offer.id, reason: input.reason, classifierVersion: HANDOFF_CLASSIFIER_VERSION },
    });
    return { offer, conversation, created: true };
  }

  public async decideInbound(client: PoolClient, input: InboundHandoffDecisionInput): Promise<InboundHandoffDecision> {
    const pendingResult = await client.query<HandoffOfferRecord>(
      `SELECT * FROM agent_handoff_offers
       WHERE organization_id = $1 AND installation_id = $2 AND conversation_id = $3
         AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [input.organizationId, input.installationId, input.conversationId],
    );
    let offer = pendingResult.rows[0] ?? null;
    if (offer && Date.parse(offer.expires_at) <= Date.now()) {
      const expired = await client.query<HandoffOfferRecord>(
        `UPDATE agent_handoff_offers
         SET status = 'expired', decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [offer.id],
      );
      if (expired.rows[0]) {
        offer = expired.rows[0];
        await this.appendEvent(client, {
          eventType: "conversation.handoff.offer_expired",
          organizationId: input.organizationId,
          runId: offer.source_run_id,
          installationId: input.installationId,
          conversationId: input.conversationId,
          actorType: "system",
          actorId: "system:handoff-expiry",
          payload: { offerId: offer.id },
        });
      }
      offer = null;
    }

    const intent = classifyHandoffIntent(input.content, Boolean(offer));
    if (intent.kind === "decline_handoff" && offer) {
      const declined = await client.query<HandoffOfferRecord>(
        `UPDATE agent_handoff_offers
         SET status = 'declined', decision_message_id = $2, decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [offer.id, input.messageId],
      );
      const updatedOffer = declined.rows[0] ?? offer;
      await this.appendEvent(client, {
        eventType: "conversation.handoff.offer_declined",
        organizationId: input.organizationId,
        runId: updatedOffer.source_run_id,
        installationId: input.installationId,
        conversationId: input.conversationId,
        actorType: "user",
        actorId: `customer:${input.channelType}`,
        payload: { offerId: updatedOffer.id, messageId: input.messageId, classifierVersion: intent.classifierVersion },
      });
      const conversation = await this.loadConversation(client, input.organizationId, input.conversationId);
      return { kind: "declined", intent, offer: updatedOffer, conversation };
    }

    const requested = intent.kind === "request_human" || (intent.kind === "confirm_handoff" && Boolean(offer));
    if (!requested) return { kind: "none", intent };

    const conversation = await this.lockConversation(client, input.organizationId, input.installationId, input.conversationId);
    if (conversation.handoff_state !== "agent_active") {
      throw Object.assign(new Error("Agent execution is paused while this conversation is owned by a human"), {
        statusCode: 409,
        code: "conversation_handoff_active",
      });
    }
    const installation = await this.loadInstallation(client, input.organizationId, input.installationId);
    const requestSource = intent.kind === "confirm_handoff" ? "customer_confirmed" : "customer_direct";
    const reason: HandoffReason = intent.kind === "confirm_handoff" && offer ? offer.reason : "customer_requested";
    const summary = intent.kind === "confirm_handoff" && offer
      ? offer.summary
      : "Customer explicitly requested a human conversation.";
    const idempotencyKey = requestIdempotencyKey(input.messageId);

    const existing = await client.query<HandoffRequestRecord>(
      `SELECT * FROM agent_handoff_requests
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
       LIMIT 1`,
      [input.organizationId, input.installationId, idempotencyKey],
    );
    if (existing.rows[0]) return { kind: "requested", intent, offer, handoff: existing.rows[0], conversation };

    const requestResult = await client.query<HandoffRequestRecord>(
      `INSERT INTO agent_handoff_requests
        (organization_id, installation_id, conversation_id, agent_definition_id,
         agent_version_id, run_id, channel_type, reason, priority, summary,
         customer_message, requested_by, metadata, idempotency_key, request_source,
         source_message_id, offer_id, consented_at, classifier_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
               $14, $15, $16, $17, now(), $18)
       RETURNING *`,
      [
        input.organizationId,
        input.installationId,
        input.conversationId,
        offer?.agent_definition_id ?? installation.agent_definition_id,
        offer?.agent_version_id ?? installation.agent_version_id,
        offer?.source_run_id ?? null,
        input.channelType,
        reason,
        offer?.metadata.priority === "urgent" || offer?.metadata.priority === "high" ? offer.metadata.priority : "normal",
        summary,
        trimmedMessage(input.customerMessage),
        `customer:${input.channelType}`,
        JSON.stringify({ intentRule: intent.matchedRule, ...(offer?.metadata ?? {}) }),
        idempotencyKey,
        requestSource,
        input.messageId,
        offer?.id ?? null,
        intent.classifierVersion,
      ],
    );
    const handoff = requestResult.rows[0];
    if (!handoff) throw new Error("Customer handoff request could not be created");
    if (offer) {
      const accepted = await client.query<HandoffOfferRecord>(
        `UPDATE agent_handoff_offers
         SET status = 'accepted', decision_message_id = $2, decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [offer.id, input.messageId],
      );
      offer = accepted.rows[0] ?? offer;
      await this.appendEvent(client, {
        eventType: "conversation.handoff.offer_accepted",
        organizationId: input.organizationId,
        runId: handoff.run_id,
        installationId: input.installationId,
        conversationId: input.conversationId,
        actorType: "user",
        actorId: `customer:${input.channelType}`,
        payload: { handoffId: handoff.id, offerId: offer.id, messageId: input.messageId, classifierVersion: intent.classifierVersion },
      });
    }
    const updatedConversation = await client.query<ConversationRecord>(
      `UPDATE conversations
       SET handoff_state = 'handoff_requested', handoff_revision = handoff_revision + 1,
           handoff_requested_at = now(), handoff_resolved_at = NULL, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND handoff_state = 'agent_active'
       RETURNING *`,
      [input.organizationId, input.conversationId],
    );
    if (!updatedConversation.rows[0]) throw handoffError("Conversation handoff update failed", "handoff_state_conflict");
    await this.appendEvent(client, {
      eventType: "conversation.handoff.requested",
      organizationId: input.organizationId,
      runId: handoff.run_id,
      installationId: input.installationId,
      conversationId: input.conversationId,
      actorType: "user",
      actorId: `customer:${input.channelType}`,
      payload: {
        handoffId: handoff.id,
        offerId: offer?.id ?? null,
        status: "pending",
        reason,
        requestSource,
        sourceMessageId: input.messageId,
        classifierVersion: intent.classifierVersion,
      },
    });
    return { kind: "requested", intent, offer, handoff, conversation: updatedConversation.rows[0] };
  }

  /** Expire offers that have passed their customer-decision deadline. */
  public async expirePendingOffers(client: PoolClient, organizationId?: string, limit = 100): Promise<number> {
    const values: unknown[] = [];
    const where = ["status = 'pending'", "expires_at <= now()"];
    if (organizationId) {
      values.push(organizationId);
      where.push(`organization_id = $${values.length}`);
    }
    values.push(Math.max(1, Math.min(limit, 500)));
    const expired = await client.query<HandoffOfferRecord>(
      `SELECT * FROM agent_handoff_offers
       WHERE ${where.join(" AND ")}
       ORDER BY expires_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $${values.length}`,
      values,
    );
    for (const offer of expired.rows) {
      const updated = await client.query<HandoffOfferRecord>(
        `UPDATE agent_handoff_offers
         SET status = 'expired', decided_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [offer.id],
      );
      if (!updated.rows[0]) continue;
      await this.appendEvent(client, {
        eventType: "conversation.handoff.offer_expired",
        organizationId: offer.organization_id,
        runId: offer.source_run_id,
        installationId: offer.installation_id,
        conversationId: offer.conversation_id,
        actorType: "system",
        actorId: "system:handoff-expiry",
        payload: { offerId: offer.id },
      });
    }
    return expired.rows.length;
  }

  private async loadInstallation(client: PoolClient, organizationId: string, installationId: string): Promise<{
    agent_definition_id: string;
    agent_version_id: string;
    agent_audience: "personal" | "customer_service";
  }> {
    const result = await client.query<{
      agent_definition_id: string;
      agent_version_id: string;
      agent_audience: "personal" | "customer_service";
    }>(
      `SELECT ai.agent_definition_id, ai.agent_version_id, ad.agent_audience
       FROM agent_installations ai
       JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
       WHERE ai.id = $1 AND ai.organization_id = $2 AND ai.status = 'active'
       LIMIT 1`,
      [installationId, organizationId],
    );
    const installation = result.rows[0];
    if (!installation) throw handoffError("Installation not found", "installation_not_found", 404);
    return installation;
  }

  private async lockConversation(client: PoolClient, organizationId: string, installationId: string, conversationId: string): Promise<ConversationRecord> {
    const result = await client.query<ConversationRecord>(
      `SELECT * FROM conversations
       WHERE organization_id = $1 AND installation_id = $2 AND id = $3 AND status <> 'deleted'
       FOR UPDATE`,
      [organizationId, installationId, conversationId],
    );
    const conversation = result.rows[0];
    if (!conversation) throw handoffError("Conversation not found", "conversation_not_found", 404);
    return conversation;
  }

  private async loadConversation(client: PoolClient, organizationId: string, conversationId: string): Promise<ConversationRecord> {
    const result = await client.query<ConversationRecord>(
      "SELECT * FROM conversations WHERE organization_id = $1 AND id = $2",
      [organizationId, conversationId],
    );
    const conversation = result.rows[0];
    if (!conversation) throw new Error("Handoff conversation is missing");
    return conversation;
  }

  private async appendEvent(client: PoolClient, input: {
    eventType: string;
    organizationId: string;
    runId: string | null;
    installationId: string;
    conversationId: string;
    actorType: "agent" | "user" | "system";
    actorId: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const envelope = createAgentEvent({
      type: input.eventType,
      subject: `conversation:${input.conversationId}`,
      data: {
        conversationId: input.conversationId,
        installationId: input.installationId,
        ...input.payload,
      },
    });
    await client.query(
      `INSERT INTO agent_events
        (organization_id, run_id, installation_id, event_type, payload, spec_version,
         source, subject, data_content_type, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        input.organizationId,
        input.runId,
        input.installationId,
        input.eventType,
        JSON.stringify(envelope.data),
        envelope.specversion,
        envelope.source,
        envelope.subject,
        envelope.datacontenttype,
        input.actorType,
        input.actorId,
      ],
    );
  }
}
