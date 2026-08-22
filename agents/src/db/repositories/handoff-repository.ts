import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";
import type { ConversationRecord } from "./conversation-repository";

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
  status: HandoffStatus;
  requested_by: string;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
  metadata: Record<string, unknown>;
  idempotency_key: string;
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
  status?: HandoffStatus | HandoffStatus[];
  priority?: HandoffPriority;
  search?: string;
  limit?: number;
  before?: string;
}

export interface HandoffQueueItem {
  handoff: HandoffRequestRecord;
  conversation: ConversationRecord;
}

export interface HandoffQueuePage {
  items: HandoffQueueItem[];
  nextBefore: string | null;
}

export interface HandoffMutationResult {
  handoff: HandoffRequestRecord;
  conversation: ConversationRecord;
  changed: boolean;
}

function handoffError(message: string, code: string, statusCode = 409): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

export class HandoffRepository {
  public constructor(private readonly pool: Pool) {}

  public async listQueue(organizationId: string, filters: HandoffQueueFilters = {}): Promise<HandoffQueuePage> {
    const where = ["h.organization_id = $1"];
    const values: unknown[] = [organizationId];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      where.push(sql.replace("$VALUE", `$${values.length}`));
    };
    if (filters.installationId) add("h.installation_id = $VALUE", filters.installationId);
    if (filters.agentId) add("h.agent_definition_id = $VALUE", filters.agentId);
    if (filters.priority) add("h.priority = $VALUE", filters.priority);
    if (filters.status) {
      const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
      values.push(statuses);
      where.push(`h.status = ANY($${values.length}::text[])`);
    }
    if (filters.search?.trim()) {
      values.push(`%${filters.search.trim().replace(/[%_]/g, "\\$&")}%`);
      where.push(`(h.summary ILIKE $${values.length} ESCAPE '\\' OR h.customer_message ILIKE $${values.length} ESCAPE '\\')`);
    }
    if (filters.before) {
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
       WHERE ${where.join(" AND ")}
       ORDER BY h.created_at DESC, h.id DESC
       LIMIT $${values.length}`,
      values,
    );
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => ({ handoff: row, conversation: row.conversation })),
      nextBefore: result.rows.length > limit ? rows.at(-1)?.created_at ?? null : null,
    };
  }

  public async get(organizationId: string, handoffId: string): Promise<HandoffQueueItem | null> {
    const result = await query<HandoffRequestRecord & { conversation: ConversationRecord }>(
      this.pool,
      `SELECT h.*, row_to_json(c) AS conversation
       FROM agent_handoff_requests h
       JOIN conversations c ON c.id = h.conversation_id AND c.organization_id = h.organization_id
       WHERE h.organization_id = $1 AND h.id = $2`,
      [organizationId, handoffId],
    );
    const row = result.rows[0];
    return row ? { handoff: row, conversation: row.conversation } : null;
  }

  public async requestHuman(input: RequestHumanInput): Promise<RequestedHandoff> {
    const summary = input.summary.trim();
    const customerMessage = input.customerMessage?.trim() || null;
    const metadata = input.metadata ?? {};
    const idempotencyKey = input.idempotencyKey?.trim() || `handoff:${input.runId ?? "manual"}:${input.conversationId}`;
    if (!summary) throw handoffError("A handoff summary is required", "handoff_summary_required", 400);
    if (summary.length > 2_000) throw handoffError("The handoff summary is too long", "handoff_summary_too_long", 400);
    if (customerMessage && customerMessage.length > 4_000) throw handoffError("The handoff customer message is too long", "handoff_customer_message_too_long", 400);

    return withTransaction(this.pool, async (client) => {
      const existing = await client.query<HandoffRequestRecord>(
        `SELECT * FROM agent_handoff_requests
         WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
         LIMIT 1`,
        [input.organizationId, input.installationId, idempotencyKey],
      );
      if (existing.rows[0]) {
        const conversation = await client.query<ConversationRecord>(
          `SELECT * FROM conversations WHERE organization_id = $1 AND id = $2`,
          [input.organizationId, existing.rows[0].conversation_id],
        );
        if (!conversation.rows[0]) throw new Error("Handoff conversation is missing");
        return { handoff: existing.rows[0], conversation: conversation.rows[0], created: false };
      }

      const installation = await client.query<{
        id: string;
        status: string;
        execution_mode: "system_hosted" | "kasitek_hosted" | "external_connected";
        agent_audience: "personal" | "customer_service";
        agent_definition_id: string;
        agent_version_id: string;
      }>(
        `SELECT ai.id, ai.status, ai.execution_mode, ad.agent_audience,
                ai.agent_definition_id, ai.agent_version_id
         FROM agent_installations ai
         JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
         WHERE ai.id = $2 AND ai.organization_id = $1
         LIMIT 1`,
        [input.organizationId, input.installationId],
      );
      const installationRow = installation.rows[0];
      if (!installationRow) throw handoffError("Installation not found", "installation_not_found", 404);
      if (installationRow.status !== "active") throw handoffError("Installation is not active", "installation_not_active", 409);
      if (installationRow.agent_audience !== "customer_service") {
        throw handoffError("Personal agents cannot request customer handoff", "personal_agent_handoff_not_allowed");
      }
      if (installationRow.agent_definition_id !== input.agentId || installationRow.agent_version_id !== input.agentVersionId) {
        throw handoffError("The handoff context does not match the installation", "handoff_context_mismatch", 409);
      }

      const conversationResult = await client.query<ConversationRecord>(
        `SELECT * FROM conversations
         WHERE organization_id = $1 AND installation_id = $2 AND id = $3 AND status <> 'deleted'
         FOR UPDATE`,
        [input.organizationId, input.installationId, input.conversationId],
      );
      const conversation = conversationResult.rows[0];
      if (!conversation) throw handoffError("Conversation not found", "conversation_not_found", 404);
      if (conversation.conversation_kind !== "customer") {
        throw handoffError("Only customer conversations support handoff", "conversation_not_customer", 409);
      }
      if (conversation.handoff_state !== "agent_active") {
        throw handoffError("Conversation already has an active handoff state", "conversation_handoff_active", 409);
      }

      const requestResult = await client.query<HandoffRequestRecord>(
        `INSERT INTO agent_handoff_requests
          (organization_id, installation_id, conversation_id, agent_definition_id,
           agent_version_id, run_id, channel_type, reason, priority, summary,
           customer_message, requested_by, metadata, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
         RETURNING *`,
        [
          input.organizationId,
          input.installationId,
          input.conversationId,
          input.agentId,
          input.agentVersionId,
          input.runId ?? null,
          conversation.channel_type,
          input.reason,
          input.priority,
          summary,
          customerMessage,
          input.actorId ?? `agent:${input.agentId}`,
          JSON.stringify(metadata),
          idempotencyKey,
        ],
      );
      const updatedConversation = await client.query<ConversationRecord>(
        `UPDATE conversations
         SET handoff_state = 'handoff_requested',
             handoff_revision = handoff_revision + 1,
             handoff_requested_at = now(),
             handoff_resolved_at = NULL,
             updated_at = now()
         WHERE organization_id = $1 AND id = $2
         RETURNING *`,
        [input.organizationId, input.conversationId],
      );
      if (!updatedConversation.rows[0]) throw new Error("Conversation handoff update failed");
      return { handoff: requestResult.rows[0]!, conversation: updatedConversation.rows[0], created: true };
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
      return { handoff: handoff.rows[0], conversation: conversation.rows[0], changed: true };
    });
  }

  public async continueWithAgent(input: { organizationId: string; handoffId: string; actorId: string; resolution?: string }): Promise<HandoffMutationResult> {
    return this.closeClaim(input, "agent_active", "continued_with_agent", input.resolution);
  }

  public async resolve(input: { organizationId: string; handoffId: string; actorId: string; resolution?: string }): Promise<HandoffMutationResult> {
    return this.closeClaim(input, "resolved", "resolved", input.resolution);
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
      return { handoff: handoff.rows[0], conversation: conversation.rows[0], changed: true };
    });
  }

  private async lockMutationTarget(client: PoolClient, organizationId: string, handoffId: string): Promise<HandoffQueueItem> {
    const handoffResult = await client.query<HandoffRequestRecord>(
      `SELECT * FROM agent_handoff_requests WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
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
