import type { PoolClient } from "pg";
import type { MemoryPurgeResult } from "../../memory/legacy-contracts";

export { type MemoryPurgeResult } from "../../memory/legacy-contracts";

export async function assertNoActiveLegalHold(
  client: PoolClient,
  input: {
    organizationId: string;
    installationIds?: readonly string[];
    conversationIds?: readonly string[];
  },
): Promise<void> {
  const installationIds = [...new Set(input.installationIds ?? [])];
  const conversationIds = [...new Set(input.conversationIds ?? [])];
  const predicates = ["h.organization_id = $1", "h.status = 'active'", "(h.expires_at IS NULL OR h.expires_at > now())", "h.scope_type = 'organization'"];
  const values: unknown[] = [input.organizationId];
  const scopedPredicates: string[] = [];
  if (installationIds.length) {
    values.push(installationIds);
    scopedPredicates.push(`(h.scope_type = 'installation' AND h.scope_id = ANY($${values.length}::text[]))`);
  }
  if (conversationIds.length) {
    values.push(conversationIds);
    scopedPredicates.push(`(h.scope_type = 'conversation' AND h.scope_id = ANY($${values.length}::text[]))`);
  }
  if (scopedPredicates.length) predicates[predicates.length - 1] = `(${predicates[predicates.length - 1]} OR ${scopedPredicates.join(" OR ")})`;
  const hold = await client.query("SELECT 1 FROM agent_legal_holds h WHERE " + predicates.join(" AND ") + " LIMIT 1", values);
  if (hold.rows[0]) {
    throw Object.assign(new Error("The requested data is protected by an active legal hold"), {
      statusCode: 409,
      code: "MEMORY_LEGAL_HOLD_ACTIVE",
    });
  }
}

/**
 * Removes legacy memory rows only as part of an already-authorized cleanup
 * transaction. Runtime memory writes never use this compatibility boundary.
 */
export async function purgeMemoryRecords(
  client: PoolClient,
  input: {
    organizationId: string;
    memoryIds?: readonly string[];
    conversationIds?: readonly string[];
    agentDefinitionId?: string;
  },
): Promise<MemoryPurgeResult> {
  const memoryIds = [...new Set(input.memoryIds ?? [])];
  const conversationIds = [...new Set(input.conversationIds ?? [])];
  const predicates = ["organization_id = $1"];
  const values: unknown[] = [input.organizationId];
  if (memoryIds.length) {
    values.push(memoryIds);
    predicates.push(`id = ANY($${values.length}::uuid[])`);
  }
  if (conversationIds.length) {
    values.push(conversationIds);
    predicates.push(`conversation_id = ANY($${values.length}::uuid[])`);
  }
  if (input.agentDefinitionId) {
    values.push(input.agentDefinitionId);
    predicates.push(`agent_definition_id = $${values.length}`);
  }
  if (!memoryIds.length && !conversationIds.length && !input.agentDefinitionId) return { memoryIds: [], conversationIds: [] };

  const selected = await client.query<{ id: string; installation_id: string | null; conversation_id: string | null }>(
    `SELECT id::text, conversation_id::text, installation_id::text
     FROM memory_records
     WHERE ${predicates.join(" AND ")}`,
    values,
  );
  await assertNoActiveLegalHold(client, {
    organizationId: input.organizationId,
    installationIds: selected.rows.flatMap((row) => row.installation_id ? [row.installation_id] : []),
    conversationIds: [...conversationIds, ...selected.rows.flatMap((row) => row.conversation_id ? [row.conversation_id] : [])],
  });
  if (!selected.rows.length) {
    if (conversationIds.length) {
      await client.query(
        `DELETE FROM conversation_summaries
         WHERE organization_id = $1 AND conversation_id = ANY($2::uuid[])`,
        [input.organizationId, conversationIds],
      );
    }
    return { memoryIds: [], conversationIds };
  }

  const selectedMemoryIds = selected.rows.map((row) => row.id);
  const selectedConversationIds = [...new Set([
    ...conversationIds,
    ...selected.rows.flatMap((row) => row.conversation_id ? [row.conversation_id] : []),
  ])];
  await client.query(
    `UPDATE memory_records
     SET supersedes_memory_id = NULL,
         provenance = COALESCE(provenance, '{}'::jsonb) - 'supersedesMemoryId' - 'supersededByMemoryId',
         updated_at = now()
     WHERE organization_id = $1 AND supersedes_memory_id = ANY($2::uuid[])`,
    [input.organizationId, selectedMemoryIds],
  );
  await client.query(
    `DELETE FROM memory_records
     WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [input.organizationId, selectedMemoryIds],
  );
  if (selectedConversationIds.length) {
    await client.query(
      `DELETE FROM conversation_summaries
       WHERE organization_id = $1 AND conversation_id = ANY($2::uuid[])`,
      [input.organizationId, selectedConversationIds],
    );
  }
  return { memoryIds: selectedMemoryIds, conversationIds: selectedConversationIds };
}
