import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";
import type { ConversationProjection, ConversationRecord, MessageRecord } from "./conversation-repository";
import { createAgentEvent } from "../../events/envelope";
import { buildEvent, enqueueOutbox } from "../../analytics/producer";
import { enqueueAgentConversationMessage, loadAgentConversationAnalyticsContext } from "../../analytics";
import { ConversationHandoffService, type HandoffOfferRecord, type OfferHandoffInput } from "../../handoff/service";

export type HandoffReason = "customer_requested" | "agent_uncertain" | "policy_required" | "high_value" | "configured_workflow" | "other";
export type HandoffPriority = "normal" | "high" | "urgent";
export type HandoffStatus = "pending" | "claimed" | "resolved" | "expired" | "cancelled";

export interface HandoffRequestRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  conversation_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  run_id: string | null;
  channel_type: string;
  reason: HandoffReason;
  priority: HandoffPriority;
  summary: string;
  customer_message: string | null;
  request_source: "customer_direct" | "customer_confirmed" | "operator" | "legacy_unverified";
  source_message_id: string | null;
  offer_id: string | null;
  consented_at: string | null;
  classifier_version: string | null;
  status: HandoffStatus;
  requested_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
  metadata: Record<string, unknown>;
  idempotency_key: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface RequestHumanInput {
  organizationId: string;
  installationId: string;
  agentId: string;
  agentVersionId: string;
  runId?: string;
  conversationId: string;
  actorId?: string;
  reason: HandoffReason;
  priority: HandoffPriority;
  summary: string;
  customerMessage?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface RequestedHandoff {
  handoff: HandoffRequestRecord;
  conversation: ConversationRecord;
  created: boolean;
}

export interface HandoffQueueFilters {
  installationId?: string;
  agentId?: string;
  channelType?: string;
  reason?: HandoffReason;
  status?: HandoffStatus | HandoffStatus[];
  priority?: HandoffPriority;
  search?: string;
  limit?: number;
  cursor?: string;
  before?: string;
  assignment?: "mine" | "team";
  /** Derived from authenticated context. Never accept this value from query input. */
  actorId?: string;
}

export interface CustomerConversationFilters {
  installationId?: string;
  agentId?: string;
  channelType?: string;
  search?: string;
  limit?: number;
}

export interface ConversationSummary {
  all: number;
  live: number;
  inbox: number;
  mine: number;
  team: number;
}

export interface HandoffQueueItem {
  handoff: HandoffRequestRecord;
  conversation: ConversationRecord;
  history?: HandoffHistoryEvent[];
}

export interface HandoffHistoryEvent {
  id: string;
  event_type: string;
  sequence_number: string | number;
  payload: Record<string, unknown>;
  actor_type: string;
  actor_id: string | null;
  created_at: string;
}

export interface HandoffQueuePage {
  items: HandoffQueueItem[];
  nextCursor: string | null;
  nextBefore: string | null;
}

export interface LiveConversationItem {
  conversation: ConversationProjection;
}

export interface HandoffMutationResult {
  handoff: HandoffRequestRecord;
  conversation: ConversationRecord;
  changed: boolean;
  /** Set when Continue with agent had to create a new durable run. */
  continuationRunId?: string | null;
  continuationRunCreated?: boolean;
}

export interface HumanMessageResult {
  handoff: HandoffRequestRecord;
  conversation: ConversationRecord;
  message: MessageRecord;
  deliveryAttemptId: string | null;
  deliveryAttemptStatus: string | null;
  created: boolean;
}

function handoffError(message: string, code: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

type HandoffCursor = { createdAt: string; id: string };

function encodeCursor(value: HandoffCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value: string): HandoffCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HandoffCursor>;
    if (typeof parsed.createdAt !== "string" || Number.isNaN(Date.parse(parsed.createdAt)) || typeof parsed.id !== "string") {
      throw new Error("invalid cursor");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw handoffError("The handoff cursor is invalid", "handoff_cursor_invalid", 400);
  }
}

export class HandoffRepository {
  private readonly handoffService = new ConversationHandoffService();

  public constructor(private readonly pool: Pool) {}

  public async offerHandoff(input: OfferHandoffInput): Promise<{ offer: HandoffOfferRecord; conversation: ConversationRecord; created: boolean }> {
    return withTransaction(this.pool, (client) => this.handoffService.offer(client, input));
  }

  public async listQueue(organizationId: string, filters: HandoffQueueFilters = {}): Promise<HandoffQueuePage> {
    await this.expirePending(organizationId, 100);
    const where = ["h.organization_id = $1"];
    const values: unknown[] = [organizationId];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace("$VALUE", `$${values.length}`));
    };
    if (filters.installationId) add("h.installation_id = $VALUE", filters.installationId);
    if (filters.agentId) add("h.agent_definition_id = $VALUE", filters.agentId);
    if (filters.channelType) {
      const channelTypes = filters.channelType === "messenger" ? ["facebook", "messenger"] : [filters.channelType];
      values.push(channelTypes);
      where.push(`h.channel_type = ANY($${values.length}::text[])`);
    }
    if (filters.reason) add("h.reason = $VALUE", filters.reason);
    if (filters.priority) add("h.priority = $VALUE", filters.priority);
    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      values.push(statuses);
      where.push(`h.status = ANY($${values.length}::text[])`);
    }
    if (filters.assignment) {
      if (!filters.actorId) throw handoffError("An authenticated operator is required for assignment filters", "handoff_assignment_actor_required", 400);
      add(filters.assignment === "mine" ? "h.claimed_by = $VALUE" : "h.claimed_by IS NOT NULL AND h.claimed_by <> $VALUE", filters.actorId);
    }
    if (filters.search?.trim()) {
      values.push(`%${filters.search.trim().replace(/[%_]/g, "\\$&")}%`);
      where.push(`(h.summary ILIKE $${values.length} ESCAPE '\\' OR h.customer_message ILIKE $${values.length} ESCAPE '\\')`);
    }
    if (filters.cursor) {
      const cursor = decodeCursor(filters.cursor);
      values.push(cursor.createdAt, cursor.id);
      where.push(`(h.created_at, h.id) < ($${values.length - 1}::timestamptz, $${values.length})`);
    } else if (filters.before) {
      values.push(filters.before);
      where.push(`h.created_at < $${values.length}::timestamptz`);
    }
    const limit = Math.max(1, Math.min(filters.limit ?? 50, 100));
    values.push(limit + 1);
    const result = await query<HandoffRequestRecord & { conversation: ConversationRecord }>(
      this.pool,
      `SELECT h.*, row_to_json(c) AS conversation
       FROM agent_handoff_requests h
       JOIN conversations c ON c.id = h.conversation_id AND c.organization_id = h.organization_id
       JOIN agent_definitions ad ON ad.id = h.agent_definition_id AND ad.agent_audience = 'customer_service'
       WHERE ${where.join(" AND ")}
       ORDER BY h.created_at DESC, h.id DESC
       LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({ handoff: row, conversation: row.conversation })),
      nextCursor: result.rows.length > limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
      nextBefore: result.rows.length > limit ? last?.created_at ?? null : null,
    };
  }

  public async get(organizationId: string, handoffId: string): Promise<HandoffQueueItem | null> {
    const result = await query<HandoffRequestRecord & { conversation: ConversationRecord }>(
      this.pool,
      `SELECT h.*, row_to_json(c) AS conversation
       FROM agent_handoff_requests h
       JOIN conversations c ON c.id = h.conversation_id AND c.organization_id = h.organization_id
       JOIN agent_definitions ad ON ad.id = h.agent_definition_id AND ad.agent_audience = 'customer_service'
       WHERE h.organization_id = $1 AND h.id = $2`,
      [organizationId, handoffId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { handoff: row, conversation: row.conversation, history: await this.listHistory(organizationId, handoffId) };
  }

  public async listHistory(organizationId: string, handoffId: string): Promise<HandoffHistoryEvent[]> {
    const result = await query<HandoffHistoryEvent>(
      this.pool,
      `SELECT id, event_type, sequence_number, payload, actor_type, actor_id, created_at
       FROM agent_events
       WHERE organization_id = $1
         AND payload ->> 'handoffId' = $2
         AND event_type IN (
           'conversation.handoff.requested',
           'conversation.handoff.offer_accepted',
           'conversation.handoff.claimed',
           'conversation.handoff.released',
           'conversation.handoff.continued',
           'conversation.handoff.resolved',
           'conversation.handoff.expired',
           'conversation.handoff.cancelled',
           'conversation.handoff.first_human_response',
           'conversation.human_message.sent'
         )
       ORDER BY sequence_number ASC, created_at ASC`,
      [organizationId, handoffId],
    );
    return result.rows;
  }

  public async listLive(organizationId: string, filters: CustomerConversationFilters = {}): Promise<{ items: LiveConversationItem[] }> {
    const items = await this.listCustomerProjection(organizationId, filters, true);
    return { items: items.map((conversation) => ({ conversation })) };
  }

  public async listCustomer(organizationId: string, filters: CustomerConversationFilters = {}): Promise<{ items: ConversationProjection[] }> {
    return { items: await this.listCustomerProjection(organizationId, filters) };
  }

  public async getSummary(organizationId: string, actorId: string, filters: Omit<CustomerConversationFilters, "limit"> = {}): Promise<ConversationSummary> {
    const values: unknown[] = [organizationId, actorId];
    const where = [
      "c.organization_id = $1",
      "c.conversation_kind = 'customer'",
      "c.status = 'active'",
      "ai.status = 'active'",
      "ad.agent_audience = 'customer_service'",
    ];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace("$VALUE", `$${values.length}`));
    };
    if (filters.installationId) add("c.installation_id = $VALUE", filters.installationId);
    if (filters.agentId) add("ai.agent_definition_id = $VALUE", filters.agentId);
    if (filters.channelType) {
      const channelTypes = filters.channelType === "messenger" ? ["facebook", "messenger"] : [filters.channelType];
      values.push(channelTypes);
      where.push(`c.channel_type = ANY($${values.length}::text[])`);
    }
    if (filters.search?.trim()) {
      values.push(`%${filters.search.trim().replace(/[%_]/g, "\\$&")}%`);
      where.push(`(c.title ILIKE $${values.length} ESCAPE '\\' OR c.last_message_preview ILIKE $${values.length} ESCAPE '\\' OR participant.display_name ILIKE $${values.length} ESCAPE '\\' OR participant.external_id ILIKE $${values.length} ESCAPE '\\')`);
    }
    const result = await query<ConversationSummary>(
      this.pool,
      `SELECT COUNT(*)::integer AS "all",
              COUNT(*) FILTER (
                WHERE c.handoff_state = 'agent_active'
                  AND c.last_message_at IS NOT NULL
                  AND c.last_message_at >= NOW() - INTERVAL '30 minutes'
              )::integer AS live,
              COUNT(*) FILTER (WHERE c.handoff_state = 'handoff_requested')::integer AS inbox,
              COUNT(*) FILTER (
                WHERE c.handoff_state = 'human_owned' AND c.assigned_actor_id = $2
              )::integer AS mine,
              COUNT(*) FILTER (
                WHERE c.handoff_state = 'human_owned'
                  AND c.assigned_actor_id IS NOT NULL
                  AND c.assigned_actor_id <> $2
              )::integer AS team
       FROM conversations c
       JOIN agent_installations ai
         ON ai.id = c.installation_id
        AND ai.organization_id = c.organization_id
       JOIN agent_definitions ad
         ON ad.id = ai.agent_definition_id
       LEFT JOIN LATERAL (
         SELECT p.display_name, p.external_id
         FROM participants p
         WHERE p.conversation_id = c.id
           AND p.organization_id = c.organization_id
           AND p.participant_type IN ('customer', 'user')
         ORDER BY CASE WHEN p.participant_type = 'customer' THEN 0 ELSE 1 END, p.created_at
         LIMIT 1
       ) participant ON true
       WHERE ${where.join(" AND ")}`,
      values,
    );
    return result.rows[0] ?? { all: 0, live: 0, inbox: 0, mine: 0, team: 0 };
  }

  private async listCustomerProjection(
    organizationId: string,
    filters: CustomerConversationFilters = {},
    liveOnly = false,
  ): Promise<ConversationProjection[]> {
    const values: unknown[] = [organizationId];
    const where = [
      "c.organization_id = $1",
      "c.conversation_kind = 'customer'",
      "c.status = 'active'",
      "ai.status = 'active'",
      "ad.agent_audience = 'customer_service'",
    ];
    if (liveOnly) {
      where.push(
        "c.handoff_state = 'agent_active'",
        "c.last_message_at IS NOT NULL",
        "c.last_message_at >= NOW() - INTERVAL '30 minutes'",
      );
    }
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace("$VALUE", `$${values.length}`));
    };
    if (filters.installationId) add("c.installation_id = $VALUE", filters.installationId);
    if (filters.agentId) add("ai.agent_definition_id = $VALUE", filters.agentId);
    if (filters.channelType) {
      const channelTypes = filters.channelType === "messenger" ? ["facebook", "messenger"] : [filters.channelType];
      values.push(channelTypes);
      where.push(`c.channel_type = ANY($${values.length}::text[])`);
    }
    if (filters.search?.trim()) {
      values.push(`%${filters.search.trim().replace(/[%_]/g, "\\$&")}%`);
      where.push(`(c.title ILIKE $${values.length} ESCAPE '\\' OR c.last_message_preview ILIKE $${values.length} ESCAPE '\\' OR participant.display_name ILIKE $${values.length} ESCAPE '\\' OR participant.external_id ILIKE $${values.length} ESCAPE '\\')`);
    }
    const limit = Math.max(1, Math.min(filters.limit ?? 100, 200));
    values.push(limit);
    const result = await query<ConversationProjection>(
      this.pool,
      `SELECT c.*,
              participant.participant_type,
              participant.external_id AS participant_external_id,
              participant.display_name AS participant_display_name,
              COALESCE(unread.unread_count, 0)::integer AS unread_count
       FROM conversations c
       JOIN agent_installations ai
         ON ai.id = c.installation_id
        AND ai.organization_id = c.organization_id
       JOIN agent_definitions ad
         ON ad.id = ai.agent_definition_id
       LEFT JOIN LATERAL (
         SELECT p.participant_type, p.external_id, p.display_name
         FROM participants p
         WHERE p.conversation_id = c.id
           AND p.organization_id = c.organization_id
           AND p.participant_type IN ('customer', 'user')
         ORDER BY CASE WHEN p.participant_type = 'customer' THEN 0 ELSE 1 END, p.created_at
         LIMIT 1
       ) participant ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS unread_count
         FROM messages m
         WHERE m.conversation_id = c.id
           AND m.organization_id = c.organization_id
           AND m.direction = 'inbound'
           AND m.occurred_at > COALESCE(c.last_read_at, 'epoch'::timestamptz)
       ) unread ON true
       WHERE ${where.join(" AND ")}
       ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC, c.id DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows;
  }

  public async conversationExists(organizationId: string, conversationId: string): Promise<boolean> {
    const result = await query<{ exists: boolean }>(
      this.pool,
      `SELECT EXISTS (
         SELECT 1
         FROM conversations c
         JOIN agent_installations ai
           ON ai.id = c.installation_id
          AND ai.organization_id = c.organization_id
         JOIN agent_definitions ad
           ON ad.id = ai.agent_definition_id
          AND ad.agent_audience = 'customer_service'
         WHERE c.organization_id = $1
           AND c.id = $2
           AND c.status <> 'deleted'
           AND c.conversation_kind = 'customer'
       ) AS exists`,
      [organizationId, conversationId],
    );
    return result.rows[0]?.exists === true;
  }

  public async listConversationEventsAfter(
    organizationId: string,
    conversationId: string,
    afterSequence = 0,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await query(
      this.pool,
      `SELECT sequence_number, event_type, payload, created_at
       FROM agent_events
       WHERE organization_id = $1
         AND subject = $2
         AND sequence_number > $3
         AND EXISTS (
           SELECT 1
           FROM conversations c
           JOIN agent_installations ai
             ON ai.id = c.installation_id
            AND ai.organization_id = c.organization_id
           JOIN agent_definitions ad
             ON ad.id = ai.agent_definition_id
            AND ad.agent_audience = 'customer_service'
           WHERE c.organization_id = $1
             AND c.id = $4
             AND c.status <> 'deleted'
             AND c.conversation_kind = 'customer'
         )
       ORDER BY sequence_number ASC
       LIMIT 200`,
      [organizationId, `conversation:${conversationId}`, afterSequence, conversationId],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  /**
   * @deprecated Direct request creation is intentionally disabled. Customer
   * handoff must go through ConversationHandoffService and trusted inbound
   * consent, while operator actions use the lifecycle methods below.
   */
  public async requestHuman(_input: RequestHumanInput): Promise<never> {
    throw handoffError("Customer consent is required before creating a handoff request", "handoff_consent_required", 409);
  }

  /** Explicit teammate ownership, separate from model offers/customer consent. */
  public async takeOver(input: { organizationId: string; conversationId: string; actorId: string; idempotencyKey: string; reopen?: boolean }): Promise<HandoffMutationResult> {
    return withTransaction(this.pool, async client => {
      const target = await client.query<ConversationRecord & { agent_definition_id: string; agent_version_id: string }>(
        `SELECT c.*, ai.agent_definition_id, ai.agent_version_id FROM conversations c
         JOIN agent_installations ai ON ai.id = c.installation_id AND ai.organization_id = c.organization_id
         JOIN agent_definitions ad ON ad.id = ai.agent_definition_id AND ad.agent_audience = 'customer_service'
         WHERE c.organization_id = $1 AND c.id = $2 AND c.conversation_kind = 'customer' AND c.status = 'active'
         FOR UPDATE OF c`, [input.organizationId, input.conversationId]);
      const conversation = target.rows[0];
      if (!conversation) throw handoffError("Customer conversation not found", "conversation_not_found", 404);
      const active = await client.query<HandoffRequestRecord>(
        `SELECT * FROM agent_handoff_requests WHERE organization_id = $1 AND conversation_id = $2
         AND status IN ('pending', 'claimed') FOR UPDATE`, [input.organizationId, input.conversationId]);
      let handoff = active.rows[0];
      if (handoff?.status === 'claimed') {
        if (handoff.claimed_by !== input.actorId) throw handoffError("Another teammate owns this conversation", "handoff_not_assigned", 403);
        return { handoff, conversation, changed: false };
      }
      const prior = await client.query<HandoffRequestRecord>(
        `SELECT * FROM agent_handoff_requests WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3`,
        [input.organizationId, conversation.installation_id, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].conversation_id !== conversation.id || prior.rows[0].requested_by !== input.actorId)
          throw handoffError("Takeover key belongs to another command", "handoff_idempotency_conflict");
        return { handoff: prior.rows[0], conversation, changed: false };
      }
      if (input.reopen && conversation.handoff_state !== 'resolved') throw handoffError("Only a resolved conversation can be reopened", "conversation_not_resolved");
      if (!handoff) {
        const created = await client.query<HandoffRequestRecord>(
          `INSERT INTO agent_handoff_requests (organization_id, installation_id, conversation_id, agent_definition_id,
           agent_version_id, channel_type, reason, summary, requested_by, idempotency_key, request_source)
           VALUES ($1,$2,$3,$4,$5,$6,'other',$7,$8,$9,'operator') RETURNING *`,
          [input.organizationId, conversation.installation_id, conversation.id, conversation.agent_definition_id,
           conversation.agent_version_id, conversation.channel_type, input.reopen ? 'Teammate reopened the conversation.' : 'Teammate took over the conversation.', input.actorId, input.idempotencyKey]);
        handoff = created.rows[0]!;
      }
      const claimed = await client.query<HandoffRequestRecord>(
        `UPDATE agent_handoff_requests SET status = 'claimed', claimed_by = $3, claimed_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2 RETURNING *`, [input.organizationId, handoff.id, input.actorId]);
      const changed = await client.query<ConversationRecord>(
        `UPDATE conversations SET handoff_state = 'human_owned', assigned_actor_id = $3,
         handoff_revision = handoff_revision + 1, handoff_requested_at = now(), handoff_resolved_at = NULL, updated_at = now()
         WHERE organization_id = $1 AND id = $2 RETURNING *`, [input.organizationId, conversation.id, input.actorId]);
      await this.suppressQueuedAgentReplies(client, input.organizationId, conversation.id);
      await this.appendLifecycleEvent(client, { eventType: 'conversation.handoff.claimed', handoff: claimed.rows[0]!,
        conversation: changed.rows[0]!, actorType: 'user', actorId: input.actorId,
        payload: { status: 'claimed', requestSource: 'operator', reopened: Boolean(input.reopen) } });
      return { handoff: claimed.rows[0]!, conversation: changed.rows[0]!, changed: true };
    });
  }

  public async claim(input: { organizationId: string; handoffId: string; actorId: string }): Promise<HandoffMutationResult> {
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockMutationTarget(client, input.organizationId, input.handoffId);
      if (current.handoff.status === "claimed" && current.handoff.claimed_by === input.actorId && current.conversation.handoff_state === "human_owned") {
        return { ...current, changed: false };
      }
      if (current.handoff.status !== "pending") throw handoffError("Handoff is no longer pending", "handoff_not_pending");
      if (current.conversation.handoff_state !== "handoff_requested") throw handoffError("Conversation is not awaiting a human", "conversation_handoff_not_requested");
      const handoff = await client.query<HandoffRequestRecord>(
        `UPDATE agent_handoff_requests
         SET status = 'claimed', claimed_by = $3, claimed_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'pending'
         RETURNING *`,
        [input.organizationId, input.handoffId, input.actorId],
      );
      const conversation = await client.query<ConversationRecord>(
        `UPDATE conversations
         SET handoff_state = 'human_owned', assigned_actor_id = $3,
             handoff_revision = handoff_revision + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND handoff_state = 'handoff_requested'
         RETURNING *`,
        [input.organizationId, current.conversation.id, input.actorId],
      );
      if (!handoff.rows[0] || !conversation.rows[0]) throw handoffError("Handoff claim could not be committed", "handoff_claim_conflict");
      await this.suppressQueuedAgentReplies(client, input.organizationId, current.conversation.id);
      await this.appendLifecycleEvent(client, {
        eventType: "conversation.handoff.claimed",
        handoff: handoff.rows[0],
        conversation: conversation.rows[0],
        actorType: "user",
        actorId: input.actorId,
        payload: { status: "claimed" },
      });
      return { handoff: handoff.rows[0], conversation: conversation.rows[0], changed: true };
    });
  }

  /** Return an assigned conversation to the pending operator queue. */
  public async release(input: { organizationId: string; handoffId: string; actorId: string; reason?: string }): Promise<HandoffMutationResult> {
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockMutationTarget(client, input.organizationId, input.handoffId);
      if (current.handoff.status === "pending" && current.conversation.handoff_state === "handoff_requested") {
        return { ...current, changed: false };
      }
      if (current.handoff.status !== "claimed" || current.conversation.handoff_state !== "human_owned") {
        throw handoffError("Only a claimed human-owned handoff can be released", "handoff_not_claimed");
      }
      if (current.handoff.claimed_by !== input.actorId) {
        throw handoffError("Only the assigned operator can release this handoff", "handoff_not_assigned", 403);
      }
      const resolution = (input.reason?.trim() || "released_by_operator").slice(0, 2_000);
      const handoff = await client.query<HandoffRequestRecord>(
        `UPDATE agent_handoff_requests
         SET status = 'pending', claimed_by = NULL, claimed_at = NULL,
             resolution = NULL, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'claimed' AND claimed_by = $3
         RETURNING *`,
        [input.organizationId, input.handoffId, input.actorId],
      );
      const conversation = await client.query<ConversationRecord>(
        `UPDATE conversations
         SET handoff_state = 'handoff_requested', assigned_actor_id = NULL,
             handoff_revision = handoff_revision + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND handoff_state = 'human_owned'
         RETURNING *`,
        [input.organizationId, current.conversation.id],
      );
      if (!handoff.rows[0] || !conversation.rows[0]) throw handoffError("Handoff release could not be committed", "handoff_release_conflict");
      await this.appendLifecycleEvent(client, {
        eventType: "conversation.handoff.released",
        handoff: handoff.rows[0],
        conversation: conversation.rows[0],
        actorType: "user",
        actorId: input.actorId,
        payload: { status: "pending", resolution: "released", resolutionCode: "released" },
      });
      return { handoff: handoff.rows[0], conversation: conversation.rows[0], changed: true };
    });
  }

  /** Expire one pending request. Used by operators and the queue sweeper. */
  public async expire(input: { organizationId: string; handoffId: string; actorId?: string }): Promise<HandoffMutationResult> {
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockMutationTarget(client, input.organizationId, input.handoffId);
      if (current.handoff.status === "expired" && current.conversation.handoff_state === "expired") {
        return { ...current, changed: false };
      }
      if (current.handoff.status !== "pending" || current.conversation.handoff_state !== "handoff_requested") {
        throw handoffError("Only a pending handoff can expire", "handoff_not_pending");
      }
      return this.expireLocked(client, current, input.actorId ?? "system:handoff-expiry");
    });
  }

  /** Claim and expire a bounded batch without holding locks across batches. */
  public async expirePending(organizationId?: string, limit = 100): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const values: unknown[] = [];
      const where = ["h.status = 'pending'", "h.expires_at <= now()"];
      if (organizationId) {
        values.push(organizationId);
        where.push(`h.organization_id = $${values.length}`);
      }
      values.push(Math.max(1, Math.min(limit, 500)));
      const expired = await client.query<{ id: string; organization_id: string }>(
        `SELECT h.id, h.organization_id FROM agent_handoff_requests h
         JOIN agent_definitions ad ON ad.id = h.agent_definition_id AND ad.agent_audience = 'customer_service'
         WHERE ${where.join(" AND ")}
         ORDER BY h.expires_at ASC, h.id ASC
         FOR UPDATE OF h SKIP LOCKED
         LIMIT $${values.length}`,
        values,
      );
      let count = 0;
      for (const row of expired.rows) {
        const current = await this.lockMutationTarget(client, row.organization_id, row.id);
        if (current.handoff.status !== "pending" || current.conversation.handoff_state !== "handoff_requested") continue;
        await this.expireLocked(client, current, "system:handoff-expiry");
        count += 1;
      }
      await this.handoffService.expirePendingOffers(client, organizationId, limit);
      return count;
    });
  }

  /**
   * Cancels the pending handoff created by a run when that run is stopped
   * while waiting for a human. Claimed conversations remain human-owned and
   * are intentionally left for the operator to resolve.
   */
  public async cancelForRun(input: { organizationId: string; runId: string; actorId: string; reason?: string }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const currentResult = await client.query<HandoffRequestRecord & { conversation: ConversationRecord }>(
        `SELECT h.*, row_to_json(c) AS conversation
         FROM agent_handoff_requests h
         JOIN conversations c ON c.id = h.conversation_id AND c.organization_id = h.organization_id
         JOIN agent_definitions ad ON ad.id = h.agent_definition_id AND ad.agent_audience = 'customer_service'
         WHERE h.organization_id = $1 AND h.run_id = $2 AND h.status = 'pending'
           AND c.handoff_state = 'handoff_requested'
         ORDER BY h.created_at DESC, h.id DESC
         LIMIT 1
         FOR UPDATE OF h, c`,
        [input.organizationId, input.runId],
      );
      const current = currentResult.rows[0];
      if (!current) return false;
      const resolution = (input.reason?.trim() || "cancelled_by_run").slice(0, 2_000);
      const handoff = await client.query<HandoffRequestRecord>(
        `UPDATE agent_handoff_requests
         SET status = 'cancelled', resolved_by = $3, resolved_at = now(),
             resolution = $4, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'pending'
         RETURNING *`,
        [input.organizationId, current.id, input.actorId, resolution],
      );
      const conversation = await client.query<ConversationRecord>(
        `UPDATE conversations
         SET handoff_state = 'cancelled', assigned_actor_id = NULL,
             handoff_revision = handoff_revision + 1, handoff_resolved_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND handoff_state = 'handoff_requested'
         RETURNING *`,
        [input.organizationId, current.conversation_id],
      );
      if (!handoff.rows[0] || !conversation.rows[0]) throw handoffError("Handoff cancellation could not be committed", "handoff_cancel_conflict");
      await this.appendLifecycleEvent(client, {
        eventType: "conversation.handoff.cancelled",
        handoff: handoff.rows[0],
        conversation: conversation.rows[0],
        actorType: input.actorId.startsWith("agent:") ? "agent" : input.actorId.startsWith("system:") ? "system" : "user",
        actorId: input.actorId,
        payload: { status: "cancelled", resolution, resolutionCode: "run_cancelled" },
      });
      return true;
    });
  }

  public async continueWithAgent(input: { organizationId: string; handoffId: string; actorId: string; resolution?: string }): Promise<HandoffMutationResult> {
    return this.closeClaim(input, "agent_active", "continued_with_agent", input.resolution);
  }

  public async resolve(input: { organizationId: string; handoffId: string; actorId: string; resolution?: string }): Promise<HandoffMutationResult> {
    return this.closeClaim(input, "resolved", "resolved", input.resolution);
  }

  /**
   * Appends a message from the assigned operator while retaining the same
   * conversation ownership lock used by claim/continue/resolve. External
   * channels receive a queued delivery attempt; the HTTP boundary is
   * responsible for handing that attempt to the provider adapter.
   */
  public async appendHumanMessage(input: {
    organizationId: string;
    handoffId: string;
    actorId: string;
    text: string;
    idempotencyKey: string;
  }): Promise<HumanMessageResult> {
    const text = input.text.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!text) throw handoffError("A message is required", "human_message_required", 400);
    if (text.length > 20_000) throw handoffError("The message is too long", "human_message_too_long", 400);
    if (!idempotencyKey || idempotencyKey.length > 240) throw handoffError("A valid idempotency key is required", "human_message_idempotency_required", 400);

    return withTransaction(this.pool, async (client) => {
      const current = await this.lockMutationTarget(client, input.organizationId, input.handoffId);
      if (current.handoff.status !== "claimed" || current.conversation.handoff_state !== "human_owned") {
        throw handoffError("Only a claimed human-owned conversation can receive an operator message", "conversation_not_human_owned");
      }
      if (current.handoff.claimed_by !== input.actorId) {
        throw handoffError("Only the assigned operator can send a message", "handoff_not_assigned", 403);
      }

      const priorHumanResponse = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM messages m
           LEFT JOIN participants p ON p.id = m.participant_id
           WHERE m.organization_id = $1 AND m.conversation_id = $2 AND m.direction = 'outbound'
             AND (m.provider = 'kasitek-human' OR p.participant_type = 'staff')
         ) AS exists`,
        [input.organizationId, current.conversation.id],
      );
      const isFirstHumanResponse = !priorHumanResponse.rows[0]?.exists;

      const existing = await client.query<MessageRecord>(
        `SELECT * FROM messages
         WHERE organization_id = $1 AND provider = 'kasitek-human' AND provider_message_id = $2
         LIMIT 1`,
        [input.organizationId, idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].conversation_id !== current.conversation.id) {
          throw handoffError("The idempotency key belongs to another conversation", "human_message_idempotency_conflict", 409);
        }
        const attempt = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM delivery_attempts WHERE message_id = $1 ORDER BY attempt_number DESC LIMIT 1`,
          [existing.rows[0].id],
        );
        return {
          handoff: current.handoff,
          conversation: current.conversation,
          message: existing.rows[0],
          deliveryAttemptId: attempt.rows[0]?.id ?? null,
          deliveryAttemptStatus: attempt.rows[0]?.status ?? null,
          created: false,
        };
      }

      const participant = await client.query<{ id: string }>(
        `INSERT INTO participants (conversation_id, organization_id, participant_type, external_id, display_name)
         VALUES ($1, $2, 'staff', $3, $3)
         ON CONFLICT (conversation_id, participant_type, external_id)
         DO UPDATE SET display_name = EXCLUDED.display_name
         RETURNING id`,
        [current.conversation.id, input.organizationId, input.actorId],
      );
      const sequence = await client.query<{ sequence_number: string }>(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence_number
         FROM messages WHERE conversation_id = $1`,
        [current.conversation.id],
      );
      const deliveryStatus = current.conversation.channel_type === "platform" ? "local" : "queued";
      const message = await client.query<MessageRecord>(
        `INSERT INTO messages
          (conversation_id, organization_id, participant_id, direction, message_type, content,
           provider, provider_message_id, sequence_number, source_channel,
           external_conversation_id, occurred_at, delivery_status)
         VALUES ($1, $2, $3, 'outbound', 'text', $4::jsonb,
                 'kasitek-human', $5, $6, $7, $8, now(), $9)
         RETURNING *`,
        [
          current.conversation.id,
          input.organizationId,
          participant.rows[0]?.id ?? null,
          JSON.stringify({ text }),
          idempotencyKey,
          sequence.rows[0]!.sequence_number,
          current.conversation.channel_type,
          current.conversation.external_conversation_id,
          deliveryStatus,
        ],
      );
      if (!message.rows[0]) throw new Error("Human message could not be persisted");

      let deliveryAttemptId: string | null = null;
      if (current.conversation.channel_type !== "platform") {
        const attempt = await client.query<{ id: string }>(
          `INSERT INTO delivery_attempts
            (organization_id, conversation_id, message_id, channel_type, status, attempt_number)
           VALUES ($1, $2, $3, $4, 'queued', 1)
           RETURNING id`,
          [input.organizationId, current.conversation.id, message.rows[0].id, current.conversation.channel_type],
        );
        deliveryAttemptId = attempt.rows[0]?.id ?? null;
      }
      const updatedConversation = await client.query<ConversationRecord>(
        `UPDATE conversations
         SET updated_at = now(), last_message_at = now(), last_message_direction = 'outbound',
             last_message_preview = LEFT($3, 500), message_count = message_count + 1
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [input.organizationId, current.conversation.id, text],
      );
      if (!updatedConversation.rows[0]) throw new Error("Conversation update failed after human message");
      const conversationContext = await loadAgentConversationAnalyticsContext(client, input.organizationId, current.conversation.id);
      await enqueueAgentConversationMessage(client, conversationContext, message.rows[0]!, "created");
      if (isFirstHumanResponse) {
        await this.appendLifecycleEvent(client, {
          eventType: "conversation.handoff.first_human_response",
          handoff: current.handoff,
          conversation: updatedConversation.rows[0],
          actorType: "user",
          actorId: input.actorId,
          payload: {
            status: "sent",
            messageId: message.rows[0].id,
            deliveryStatus,
          },
        });
      }
      await this.appendLifecycleEvent(client, {
        eventType: "conversation.human_message.sent",
        handoff: current.handoff,
        conversation: updatedConversation.rows[0],
        actorType: "user",
        actorId: input.actorId,
        payload: {
          status: "sent",
          messageId: message.rows[0].id,
          deliveryStatus,
          deliveryAttemptId,
        },
      });
      return {
        handoff: current.handoff,
        conversation: updatedConversation.rows[0],
        message: message.rows[0],
        deliveryAttemptId,
        deliveryAttemptStatus: deliveryAttemptId ? "queued" : null,
        created: true,
      };
    });
  }

  private async suppressQueuedAgentReplies(client: PoolClient, organizationId: string, conversationId: string): Promise<void> {
    // Website publication is local, so even a sending attempt can be safely
    // suppressed before commit. Already sent messages remain historical facts.
    await client.query(`UPDATE delivery_attempts da SET status = 'failed', error = '{"code":"AGENT_REPLY_SUPPRESSED"}'::jsonb
      FROM messages m WHERE da.message_id = m.id AND da.organization_id = $1 AND m.conversation_id = $2
      AND m.direction = 'outbound' AND m.provider IS DISTINCT FROM 'kasitek-human'
      AND m.provider IS DISTINCT FROM 'kasitek-handoff'
      AND (da.status = 'queued' OR (da.status = 'sending' AND da.channel_type = 'website'))`, [organizationId, conversationId]);
    const messages = await client.query<MessageRecord>(`UPDATE messages m SET delivery_status = 'failed'
      WHERE m.organization_id = $1 AND m.conversation_id = $2 AND m.direction = 'outbound'
      AND EXISTS (SELECT 1 FROM delivery_attempts da WHERE da.message_id = m.id AND da.error->>'code' = 'AGENT_REPLY_SUPPRESSED')
      AND m.delivery_status IN ('queued','sending') RETURNING *`, [organizationId, conversationId]);
    if (messages.rows.length) {
      const context = await loadAgentConversationAnalyticsContext(client, organizationId, conversationId);
      for (const message of messages.rows) await enqueueAgentConversationMessage(client, context, message, 'delivery_updated');
    }
  }

  private async closeClaim(
    input: { organizationId: string; handoffId: string; actorId: string; resolution?: string },
    conversationState: "agent_active" | "resolved",
    defaultResolution: string,
    resolution?: string,
  ): Promise<HandoffMutationResult> {
    return withTransaction(this.pool, async (client) => {
      const current = await this.lockMutationTarget(client, input.organizationId, input.handoffId);
      if (current.handoff.status === "resolved" && current.handoff.resolution === (resolution ?? defaultResolution)) {
        return { ...current, changed: false };
      }
      if (current.handoff.status !== "claimed") throw handoffError("Only a claimed handoff can be closed", "handoff_not_claimed");
      if (current.handoff.claimed_by !== input.actorId) throw handoffError("Only the assigned operator can close this handoff", "handoff_not_assigned", 403);
      if (current.conversation.handoff_state !== "human_owned") throw handoffError("Conversation is not human-owned", "conversation_not_human_owned");
      const finalResolution = (resolution?.trim() || defaultResolution).slice(0, 2_000);
      const handoff = await client.query<HandoffRequestRecord>(
        `UPDATE agent_handoff_requests
         SET status = 'resolved', resolved_by = $3, resolved_at = now(), resolution = $4, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'claimed' AND claimed_by = $3
         RETURNING *`,
        [input.organizationId, input.handoffId, input.actorId, finalResolution],
      );
      const conversation = await client.query<ConversationRecord>(
        `UPDATE conversations
         SET handoff_state = $3, assigned_actor_id = NULL,
             handoff_revision = handoff_revision + 1, handoff_resolved_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND handoff_state = 'human_owned'
         RETURNING *`,
        [input.organizationId, current.conversation.id, conversationState],
      );
      if (!handoff.rows[0] || !conversation.rows[0]) throw handoffError("Handoff close could not be committed", "handoff_close_conflict");
      const continuation = conversationState === "agent_active"
        ? await this.ensureContinuationRun(client, {
          handoff: handoff.rows[0],
          conversation: conversation.rows[0],
          actorId: input.actorId,
        })
        : { id: null, created: false };
      await this.appendLifecycleEvent(client, {
        eventType: conversationState === "agent_active" ? "conversation.handoff.continued" : "conversation.handoff.resolved",
        handoff: handoff.rows[0],
        conversation: conversation.rows[0],
        actorType: "user",
        actorId: input.actorId,
        payload: {
          status: "resolved",
          resolution: defaultResolution,
          conversationState,
          ...(continuation.id ? { continuationRunId: continuation.id, continuationRunCreated: continuation.created } : {}),
        },
      });
      return {
        handoff: handoff.rows[0],
        conversation: conversation.rows[0],
        changed: true,
        continuationRunId: continuation.id,
        continuationRunCreated: continuation.created,
      };
    });
  }

  /**
   * Continue a handoff using the paused workflow when possible. If the
   * original run is terminal (or missing), create one idempotent run from the
   * latest inbound transcript while the conversation lock is still held.
   */
  private async ensureContinuationRun(
    client: PoolClient,
    input: { handoff: HandoffRequestRecord; conversation: ConversationRecord; actorId: string },
  ): Promise<{ id: string | null; created: boolean }> {
    const activeStatuses = ["received", "queued", "running", "awaiting_approval", "awaiting_human", "awaiting_external_event"];
    const sourceResult = input.handoff.run_id
      ? await client.query<{
        id: string;
        status: string;
        reply_channel_type: string | null;
        reply_binding_id: string | null;
        resolved_model_provider: string | null;
        resolved_model: string | null;
      }>(
        `SELECT id, status, reply_channel_type, reply_binding_id,
                resolved_model_provider, resolved_model
         FROM agent_runs
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [input.handoff.organization_id, input.handoff.run_id],
      )
      : { rows: [] };
    const source = sourceResult.rows[0];
    if (source && activeStatuses.includes(source.status)) return { id: null, created: false };

    const activeConversationRun = await client.query<{ id: string }>(
      `SELECT id
       FROM agent_runs
       WHERE organization_id = $1 AND conversation_id = $2
         AND status = ANY($3::text[])
       ORDER BY created_at DESC
       LIMIT 1
       FOR UPDATE`,
      [input.handoff.organization_id, input.conversation.id, activeStatuses],
    );
    if (activeConversationRun.rows[0]) return { id: null, created: false };

    const latestInbound = await client.query<{ content: Record<string, unknown>; source_channel: string | null; source_binding_id: string | null }>(
      `SELECT content, source_channel, source_binding_id
       FROM messages
       WHERE organization_id = $1 AND conversation_id = $2 AND direction = 'inbound'
       ORDER BY sequence_number DESC, created_at DESC
       LIMIT 1`,
      [input.handoff.organization_id, input.conversation.id],
    );
    const content = latestInbound.rows[0]?.content;
    const message = typeof content?.text === "string" && content.text.trim()
      ? content.text.trim()
      : input.handoff.customer_message?.trim() || input.handoff.summary;
    const channelType = source?.reply_channel_type ?? latestInbound.rows[0]?.source_channel ?? input.conversation.channel_type;
    const bindingId = source?.reply_binding_id ?? latestInbound.rows[0]?.source_binding_id ?? null;
    const idempotencyKey = `handoff-continue:${input.handoff.id}`;
    const created = await client.query<{ id: string; correlation_id: string }>(
      `INSERT INTO agent_runs
        (organization_id, agent_definition_id, agent_version_id, installation_id,
         conversation_id, trigger_type, status, input, correlation_id, created_by,
         idempotency_key, reply_channel_type, reply_binding_id,
         resolved_model_provider, resolved_model)
       VALUES ($1, $2, $3, $4, $5, 'message', 'received', $6::jsonb,
               gen_random_uuid(), $7, $8, $9, $10, $11, $12)
       ON CONFLICT DO NOTHING
       RETURNING id, correlation_id`,
      [
        input.handoff.organization_id,
        input.handoff.agent_definition_id,
        input.handoff.agent_version_id,
        input.handoff.installation_id,
        input.conversation.id,
        JSON.stringify({
          message,
          context: {
            handoffContinuation: true,
            handoffId: input.handoff.id,
            previousRunId: input.handoff.run_id,
          },
        }),
        input.actorId,
        idempotencyKey,
        channelType,
        bindingId,
        source?.resolved_model_provider ?? input.conversation.model_provider,
        source?.resolved_model ?? input.conversation.model,
      ],
    );
    if (!created.rows[0]) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM agent_runs WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
        [input.handoff.organization_id, idempotencyKey],
      );
      return { id: existing.rows[0]?.id ?? null, created: false };
    }
    const run = created.rows[0];
    await client.query(
      `INSERT INTO run_attempts (run_id, organization_id, attempt_number, status, trigger)
       VALUES ($1, $2, 1, 'started', 'workflow')`,
      [run.id, input.handoff.organization_id],
    );
    await client.query(
      `INSERT INTO run_workflow_state (run_id, organization_id, state, revision)
       VALUES ($1, $2, '{}'::jsonb, 0)
       ON CONFLICT (run_id) DO NOTHING`,
      [run.id, input.handoff.organization_id],
    );
    await client.query(
      `INSERT INTO agent_events (organization_id, run_id, installation_id, event_type, payload, actor_id, correlation_id)
       VALUES ($1, $2, $3, 'run.received', $4::jsonb, $5, $6)`,
      [
        input.handoff.organization_id,
        run.id,
        input.handoff.installation_id,
        JSON.stringify({ triggerType: "message", handoffContinuation: true, handoffId: input.handoff.id }),
        input.actorId,
        run.correlation_id,
      ],
    );
    return { id: run.id, created: true };
  }

  /**
   * Writes the handoff lifecycle event in the same transaction as the state
   * transition. Consumers can therefore treat agent_events as the durable
   * source for analytics and future realtime fan-out without reconstructing
   * changes from polling responses.
   */
  private async appendLifecycleEvent(
    client: PoolClient,
    input: {
      eventType: string;
      handoff: HandoffRequestRecord;
      conversation: ConversationRecord;
      actorType: "agent" | "user" | "system";
      actorId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const envelope = createAgentEvent({
      type: input.eventType,
      subject: `conversation:${input.conversation.id}`,
      data: {
        handoffId: input.handoff.id,
        conversationId: input.conversation.id,
        installationId: input.handoff.installation_id,
        agentDefinitionId: input.handoff.agent_definition_id,
        agentVersionId: input.handoff.agent_version_id,
        runId: input.handoff.run_id,
        channelType: input.handoff.channel_type,
        ...input.payload,
      },
    });
    await client.query(
      `INSERT INTO agent_events
        (organization_id, run_id, installation_id, event_type, payload, spec_version,
         source, subject, data_content_type, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        input.handoff.organization_id,
        input.handoff.run_id,
        input.handoff.installation_id,
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
    const action = input.eventType === "conversation.handoff.requested"
      ? "requested"
      : input.eventType === "conversation.handoff.claimed"
        ? "claimed"
        : input.eventType === "conversation.human_message.sent"
          ? "human_message"
          : input.eventType === "conversation.handoff.continued"
            ? "continued"
            : input.eventType === "conversation.handoff.resolved"
              ? "resolved"
              : input.eventType === "conversation.handoff.released"
                ? "released"
                : input.eventType === "conversation.handoff.expired"
                  ? "expired"
                  : input.eventType === "conversation.handoff.cancelled"
                    ? "cancelled"
                    : input.eventType === "conversation.handoff.first_human_response"
                      ? "first_human_response"
                      : undefined;
    if (!action) throw new Error(`Unsupported handoff lifecycle event ${input.eventType}`);
    const occurredAt = new Date().toISOString();
    const analyticsAttributes: Record<string, unknown> = {
      handoff_id: input.handoff.id,
      conversation_id: input.conversation.id,
      installation_id: input.handoff.installation_id,
      agent_definition_id: input.handoff.agent_definition_id,
      agent_version_id: input.handoff.agent_version_id,
      agent_audience: "customer_service",
      run_id: input.handoff.run_id,
      channel_type: input.handoff.channel_type,
      action,
      status: action === "human_message"
        ? input.handoff.status
        : typeof input.payload.status === "string" ? input.payload.status : input.handoff.status,
      reason: input.handoff.reason,
      priority: input.handoff.priority,
      actor_type: input.actorType,
      conversation_state: input.conversation.handoff_state,
      occurred_at: occurredAt,
    };
    if (typeof input.payload.messageId === "string") analyticsAttributes.message_id = input.payload.messageId;
    if (typeof input.payload.deliveryStatus === "string") analyticsAttributes.delivery_status = input.payload.deliveryStatus;
    const resolutionCode = action === "continued"
      ? "continued_with_agent"
      : action === "resolved"
        ? "resolved"
        : action === "released"
          ? "released"
          : action === "expired"
            ? "deadline"
            : action === "cancelled"
              ? "run_cancelled"
              : undefined;
    if (resolutionCode) analyticsAttributes.resolution_code = resolutionCode;
    const auditMetadata: Record<string, unknown> = {
      handoff_id: input.handoff.id,
      conversation_id: input.conversation.id,
      installation_id: input.handoff.installation_id,
      agent_definition_id: input.handoff.agent_definition_id,
      agent_version_id: input.handoff.agent_version_id,
      run_id: input.handoff.run_id,
      channel_type: input.handoff.channel_type,
      event_type: input.eventType,
      action,
      status: analyticsAttributes.status,
      reason: input.handoff.reason,
      priority: input.handoff.priority,
      ...(typeof input.payload.resolutionCode === "string" ? { resolution_code: input.payload.resolutionCode } : {}),
    };
    await client.query(
      `INSERT INTO audit_records
        (organization_id, actor_type, actor_id, action, resource_type, resource_id, correlation_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        input.handoff.organization_id,
        input.actorType,
        input.actorId,
        `agent_handoff.${action}`,
        "agent_handoff",
        input.handoff.id,
        input.handoff.run_id,
        JSON.stringify(auditMetadata),
      ],
    );
    const recordSuffix = typeof input.payload.messageId === "string"
      ? `${action}:${input.payload.messageId}`
      : action;
    await enqueueOutbox(client, buildEvent({
      recordId: `handoff:${input.handoff.id}:${recordSuffix}`,
      sourceDomain: "agents",
      sourceStreamKey: `organization:${input.handoff.organization_id}:handoffs`,
      contractName: "agent.handoff.lifecycle@1",
      schemaVersion: 1,
      scopeKind: "core_organization",
      scopeExternalId: input.handoff.organization_id,
      subject: `handoff:${input.handoff.id}`,
      occurredAt,
      attributes: analyticsAttributes,
      correlationId: input.handoff.run_id ?? undefined,
      idempotencyKey: `agent-platform:handoff:${input.handoff.id}:${recordSuffix}`,
    }));
  }

  private async expireLocked(client: PoolClient, current: HandoffQueueItem, actorId: string): Promise<HandoffMutationResult> {
    const handoff = await client.query<HandoffRequestRecord>(
      `UPDATE agent_handoff_requests
       SET status = 'expired', resolved_by = $3, resolved_at = now(), resolution = 'expired', updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND status = 'pending'
       RETURNING *`,
      [current.handoff.organization_id, current.handoff.id, actorId],
    );
    const conversation = await client.query<ConversationRecord>(
      `UPDATE conversations
       SET handoff_state = 'expired', assigned_actor_id = NULL,
           handoff_revision = handoff_revision + 1, handoff_resolved_at = now(), updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND handoff_state = 'handoff_requested'
       RETURNING *`,
      [current.conversation.organization_id, current.conversation.id],
    );
    if (!handoff.rows[0] || !conversation.rows[0]) throw handoffError("Handoff expiry could not be committed", "handoff_expiry_conflict");
    await this.appendLifecycleEvent(client, {
      eventType: "conversation.handoff.expired",
      handoff: handoff.rows[0],
      conversation: conversation.rows[0],
      actorType: actorId.startsWith("system:") ? "system" : "user",
      actorId,
      payload: { status: "expired", resolution: "expired", resolutionCode: "deadline" },
    });
    return { handoff: handoff.rows[0], conversation: conversation.rows[0], changed: true };
  }

  private async lockMutationTarget(client: PoolClient, organizationId: string, handoffId: string): Promise<HandoffQueueItem> {
    const handoffResult = await client.query<HandoffRequestRecord>(
      `SELECT h.*
       FROM agent_handoff_requests h
       JOIN agent_definitions ad ON ad.id = h.agent_definition_id AND ad.agent_audience = 'customer_service'
       WHERE h.organization_id = $1 AND h.id = $2
       FOR UPDATE OF h`,
      [organizationId, handoffId],
    );
    const handoff = handoffResult.rows[0];
    if (!handoff) throw handoffError("Handoff request not found", "handoff_not_found", 404);
    const conversationResult = await client.query<ConversationRecord>(
      `SELECT * FROM conversations WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, handoff.conversation_id],
    );
    const conversation = conversationResult.rows[0];
    if (!conversation) throw new Error("Handoff conversation is missing");
    return { handoff, conversation };
  }
}
