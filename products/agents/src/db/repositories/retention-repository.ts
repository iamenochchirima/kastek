import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";

export interface RetentionPolicyRecord {
  id: string;
  organization_id: string;
  memory_days: number;
  conversation_days: number;
  event_days: number;
  audit_days: number;
  attachment_days: number;
  revision: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface LegalHoldRecord {
  id: string;
  organization_id: string;
  scope_type: "organization" | "installation" | "conversation";
  scope_id: string;
  reason: string;
  status: "active" | "released";
  expires_at: string | null;
  created_by: string;
  created_at: string;
  released_by: string | null;
  released_at: string | null;
  revision: number;
}

export const DEFAULT_RETENTION_POLICY = { memoryDays: 365, conversationDays: 365, eventDays: 365, auditDays: 2555, attachmentDays: 30 } as const;

export class RetentionRepository {
  public constructor(private readonly pool: Pool) {}

  public async getPolicy(organizationId: string): Promise<RetentionPolicyRecord> {
    const result = await query<RetentionPolicyRecord>(this.pool, "SELECT * FROM agent_retention_policies WHERE organization_id = $1", [organizationId]);
    return result.rows[0] ?? {
      id: "default",
      organization_id: organizationId,
      memory_days: DEFAULT_RETENTION_POLICY.memoryDays,
      conversation_days: DEFAULT_RETENTION_POLICY.conversationDays,
      event_days: DEFAULT_RETENTION_POLICY.eventDays,
      audit_days: DEFAULT_RETENTION_POLICY.auditDays,
      attachment_days: DEFAULT_RETENTION_POLICY.attachmentDays,
      revision: 0,
      updated_by: "system",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
  }

  public async listPolicies(limit = 200): Promise<RetentionPolicyRecord[]> {
    return (await query<RetentionPolicyRecord>(this.pool, "SELECT * FROM agent_retention_policies ORDER BY updated_at DESC LIMIT $1", [Math.max(1, Math.min(limit, 500))])).rows;
  }

  public async setPolicy(input: { organizationId: string; memoryDays: number; conversationDays: number; eventDays: number; auditDays: number; attachmentDays: number; actorId: string }): Promise<RetentionPolicyRecord> {
    return withTransaction(this.pool, async (client) => this.setPolicyWithClient(client, input));
  }

  private async setPolicyWithClient(client: PoolClient, input: { organizationId: string; memoryDays: number; conversationDays: number; eventDays: number; auditDays: number; attachmentDays: number; actorId: string }): Promise<RetentionPolicyRecord> {
    const result = await client.query<RetentionPolicyRecord>(
      `INSERT INTO agent_retention_policies (organization_id, memory_days, conversation_days, event_days, audit_days, attachment_days, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id) DO UPDATE SET memory_days = EXCLUDED.memory_days, conversation_days = EXCLUDED.conversation_days,
         event_days = EXCLUDED.event_days, audit_days = EXCLUDED.audit_days, attachment_days = EXCLUDED.attachment_days,
         updated_by = EXCLUDED.updated_by, revision = agent_retention_policies.revision + 1, updated_at = now()
       RETURNING *`,
      [input.organizationId, input.memoryDays, input.conversationDays, input.eventDays, input.auditDays, input.attachmentDays, input.actorId],
    );
    const record = result.rows[0]!;
    await client.query(
      `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'platform_admin', $2, 'retention_policy.updated', 'retention_policy', $3, $4::jsonb)`,
      [record.organization_id, input.actorId, record.id, JSON.stringify({ revision: record.revision, memoryDays: record.memory_days, conversationDays: record.conversation_days, eventDays: record.event_days, auditDays: record.audit_days, attachmentDays: record.attachment_days })],
    );
    return record;
  }

  public async listLegalHolds(limit = 200): Promise<LegalHoldRecord[]> {
    return (await query<LegalHoldRecord>(this.pool, "SELECT * FROM agent_legal_holds ORDER BY created_at DESC LIMIT $1", [Math.max(1, Math.min(limit, 500))])).rows;
  }

  public async getLegalHold(id: string): Promise<LegalHoldRecord | null> {
    return (await query<LegalHoldRecord>(this.pool, "SELECT * FROM agent_legal_holds WHERE id = $1", [id])).rows[0] ?? null;
  }

  public async createLegalHold(input: { organizationId: string; scopeType: LegalHoldRecord["scope_type"]; scopeId: string; reason: string; expiresAt?: string | null; actorId: string }): Promise<LegalHoldRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<LegalHoldRecord>(
        `INSERT INTO agent_legal_holds (organization_id, scope_type, scope_id, reason, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [input.organizationId, input.scopeType, input.scopeId, input.reason, input.expiresAt ?? null, input.actorId],
      );
      const record = result.rows[0]!;
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'platform_admin', $2, 'legal_hold.created', 'legal_hold', $3, $4::jsonb)`,
        [record.organization_id, input.actorId, record.id, JSON.stringify({ scopeType: record.scope_type, scopeId: record.scope_id, expiresAt: record.expires_at })],
      );
      return record;
    });
  }

  public async releaseLegalHold(id: string, actorId: string): Promise<LegalHoldRecord> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<LegalHoldRecord>(
        `UPDATE agent_legal_holds SET status = 'released', released_by = $2, released_at = now(), revision = revision + 1
         WHERE id = $1 AND status = 'active' RETURNING *`,
        [id, actorId],
      );
      const record = result.rows[0];
      if (!record) throw Object.assign(new Error("Active legal hold not found"), { statusCode: 404 });
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'platform_admin', $2, 'legal_hold.released', 'legal_hold', $3, $4::jsonb)`,
        [record.organization_id, actorId, record.id, JSON.stringify({ revision: record.revision })],
      );
      return record;
    });
  }

  public async preview(organizationId: string): Promise<Record<string, unknown>> {
    const policy = await this.getPolicy(organizationId);
    const [memory, conversations, events, attachments, holds] = await Promise.all([
      query<{ count: string }>(this.pool, `SELECT COUNT(*)::text AS count
        FROM agent_memory_revisions revision
        JOIN agent_memory_facts fact ON fact.id = revision.fact_id
        WHERE fact.organization_id = $1
          AND revision.lifecycle_state = 'active'
          AND COALESCE(revision.observed_at, revision.valid_from) <= now() - make_interval(days => $2::int)
          AND NOT EXISTS (
            SELECT 1 FROM agent_memory_revisions successor
            WHERE successor.predecessor_revision_id = revision.id
              AND successor.transition_type IN ('correction', 'supersession', 'expiration', 'deletion')
              AND successor.lifecycle_state IN ('active', 'superseded', 'expired', 'deleted')
          )
          AND NOT EXISTS (
            SELECT 1 FROM agent_legal_holds h
            WHERE h.organization_id = fact.organization_id
              AND h.status = 'active'
              AND (h.expires_at IS NULL OR h.expires_at > now())
              AND (
                (h.scope_type = 'organization' AND h.scope_id = fact.organization_id)
                OR (h.scope_type = 'installation' AND h.scope_id = fact.installation_id::text)
                OR (h.scope_type = 'conversation' AND h.scope_id = fact.conversation_id::text)
              )
          )`, [organizationId, policy.memory_days]),
      query<{ count: string }>(this.pool, "SELECT COUNT(*)::text AS count FROM conversations WHERE organization_id = $1 AND status <> 'deleted' AND created_at <= now() - make_interval(days => $2::int)", [organizationId, policy.conversation_days]),
      query<{ count: string }>(this.pool, "SELECT COUNT(*)::text AS count FROM agent_events WHERE organization_id = $1 AND created_at <= now() - make_interval(days => $2::int)", [organizationId, policy.event_days]),
      query<{ count: string }>(this.pool, "SELECT COUNT(*)::text AS count FROM agent_attachment_references WHERE organization_id = $1 AND (retention_expires_at IS NOT NULL AND retention_expires_at <= now())", [organizationId]),
      query<{ count: string }>(this.pool, "SELECT COUNT(*)::text AS count FROM agent_legal_holds WHERE organization_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())", [organizationId]),
    ]);
    return { organizationId, policy: { memoryDays: policy.memory_days, conversationDays: policy.conversation_days, eventDays: policy.event_days, auditDays: policy.audit_days, attachmentDays: policy.attachment_days, revision: policy.revision }, eligible: { memory: Number(memory.rows[0]?.count ?? 0), conversations: Number(conversations.rows[0]?.count ?? 0), events: Number(events.rows[0]?.count ?? 0), attachments: Number(attachments.rows[0]?.count ?? 0) }, activeLegalHolds: Number(holds.rows[0]?.count ?? 0), generatedAt: new Date().toISOString() };
  }

}
