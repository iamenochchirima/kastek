import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type MemoryNamespace = "conversation" | "user_private" | "organization_shared" | "agent_private";
export type MemoryType = "working" | "semantic" | "episodic" | "procedural";

export interface MemoryRecord {
  id: string;
  organization_id: string;
  agent_definition_id: string | null;
  installation_id: string | null;
  conversation_id: string | null;
  owner_user_id: string | null;
  namespace: MemoryNamespace;
  memory_type: MemoryType;
  canonical_text: string;
  content: Record<string, unknown>;
  source_type: "explicit" | "imported" | "inferred";
  provenance: Record<string, unknown>;
  sensitivity: "normal" | "sensitive" | "restricted";
  confidence: number | null;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryScope {
  organizationId: string;
  agentId: string;
  installationId?: string;
  conversationId?: string;
  actorId?: string;
}

export class MemoryRepository {
  public constructor(private readonly pool: Pool) {}

  public async createMemory(input: MemoryScope & {
    namespace: MemoryNamespace;
    memoryType: MemoryType;
    canonicalText: string;
    content?: Record<string, unknown>;
    sourceType: "explicit" | "imported" | "inferred";
    provenance?: Record<string, unknown>;
    sensitivity?: "normal" | "sensitive" | "restricted";
    confidence?: number;
    ownerUserId?: string;
    expiresAt?: string;
    allowInferred?: boolean;
  }): Promise<MemoryRecord> {
    if (input.sourceType === "inferred" && !input.allowInferred) {
      throw new Error("Inferred memory requires an explicit creation policy");
    }
    if (input.namespace === "conversation" && !input.conversationId) throw new Error("Conversation memory requires conversation scope");
    if (input.namespace === "agent_private" && !input.installationId) throw new Error("Agent-private memory requires installation scope");
    if (input.namespace === "user_private" && !input.ownerUserId) throw new Error("User-private memory requires an owner");
    const result = await query<MemoryRecord>(
      this.pool,
      `INSERT INTO memory_records
        (organization_id, agent_definition_id, installation_id, conversation_id, owner_user_id,
         namespace, memory_type, canonical_text, content, source_type, provenance, sensitivity,
         confidence, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12, $13, $14, $15)
       RETURNING *`,
      [
        input.organizationId,
        input.agentId,
        input.installationId ?? null,
        input.conversationId ?? null,
        input.ownerUserId ?? null,
        input.namespace,
        input.memoryType,
        input.canonicalText,
        JSON.stringify(input.content ?? {}),
        input.sourceType,
        JSON.stringify(input.provenance ?? {}),
        input.sensitivity ?? "normal",
        input.confidence ?? null,
        input.expiresAt ?? null,
        input.actorId ?? "system",
      ],
    );
    return result.rows[0]!;
  }

  public async searchMemory(scope: MemoryScope, searchText: string, limit = 8): Promise<MemoryRecord[]> {
    const result = await query<MemoryRecord>(
      this.pool,
      `SELECT * FROM memory_records
       WHERE organization_id = $1
         AND status = 'active'
         AND (expires_at IS NULL OR expires_at > now())
         AND (agent_definition_id IS NULL OR agent_definition_id = $2)
         AND (
           namespace = 'organization_shared'
           OR (namespace = 'agent_private' AND installation_id = $3)
           OR (namespace = 'conversation' AND conversation_id = $4)
           OR (namespace = 'user_private' AND owner_user_id = $5)
         )
         AND search_vector @@ plainto_tsquery('simple', $6)
       ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', $6)) DESC, created_at DESC
       LIMIT $7`,
      [scope.organizationId, scope.agentId, scope.installationId ?? null, scope.conversationId ?? null, scope.actorId ?? null, searchText, limit],
    );
    return result.rows;
  }

  public async deleteMemory(scope: MemoryScope, memoryId: string, requestedBy: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<MemoryRecord>(
        `UPDATE memory_records SET status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND (agent_definition_id IS NULL OR agent_definition_id = $3)
         RETURNING *`,
        [memoryId, scope.organizationId, scope.agentId],
      );
      if (!result.rows[0]) throw new Error("Memory not found");
      await client.query(
        `INSERT INTO memory_deletion_jobs (organization_id, requested_by, target_type, target_id, status)
         VALUES ($1, $2, 'memory', $3, 'completed')`,
        [scope.organizationId, requestedBy, memoryId],
      );
    });
  }
}
