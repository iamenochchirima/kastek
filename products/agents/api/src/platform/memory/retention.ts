import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../../infrastructure/database";

const tombstoneSchema=z.strictObject({memoryId:z.uuid(),scopeId:z.uuid(),forgottenAt:z.iso.datetime({offset:true}),generation:z.number().int().nonnegative().safe(),
  fingerprints:z.array(z.strictObject({revision:z.number().int().positive(),content_digest:z.string().regex(/^[a-f0-9]{64}$/)}))});
export type MemoryDeletionTombstone=z.infer<typeof tombstoneSchema>;

export async function exportMemoryDeletionLedger(pool:Pool):Promise<MemoryDeletionTombstone[]> {
  const result=await pool.query("SELECT agents_platform.export_memory_deletion_ledger() AS ledger");
  return z.array(tombstoneSchema).parse(result.rows[0].ledger);
}

export async function replayMemoryDeletionLedger(pool:Pool,input:unknown):Promise<number> {
  const tombstones=z.array(tombstoneSchema).parse(input);
  const result=await transaction(pool,db=>db.query("SELECT agents_platform.replay_memory_deletion_ledger($1::jsonb) AS changed",[JSON.stringify(tombstones)]));
  await purgeMemoryRevisionContent(pool);
  return Number(result.rows[0].changed);
}

/** Caller owns organization, task and conversation locks; this also covers product namespaces. */
export async function forgetConversationMemoriesInTransaction(db: PoolClient, conversationId: string): Promise<number> {
  const result=await db.query("SELECT agents_platform.forget_conversation_memories($1::uuid) AS changed",[conversationId]);
  return Number(result.rows[0].changed);
}

/** Content cleanup keeps namespace fences, digest suppression and mutation identities. */
export async function purgeMemoryRevisionContent(pool: Pool, batchSize = 100): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("Invalid memory retention batch");
  const result = await pool.query("SELECT agents_platform.purge_memory_revision_content($1) AS changed", [batchSize]);
  return Number(result.rows[0].changed);
}
