import type { Pool } from "pg";
import type { ConversationHistoryReader, ConversationHistoryTurn } from "../../execution/context/readers";

/**
 * Conversation history for one task, scoped to its conversation, turn sequence and memory fence.
 * The window is the most recent terminal turns; `olderCount` reports the turns outside it.
 */
export class PlatformConversationHistory implements ConversationHistoryReader {
  constructor(readonly pool: Pool) {}

  async readWindow(input: { conversationId: string; beforeSequence: string; limit: number; terminalStates: readonly string[];
    memoryScopeId: string | null; memoryGeneration: number | null }): Promise<{ turns: ConversationHistoryTurn[]; olderCount: number }> {
    const predicate = `FROM agents_platform.tasks t
      WHERE t.conversation_id=$1 AND t.turn_sequence<$2 AND t.state=ANY($3::text[])
      AND NOT EXISTS(SELECT 1 FROM agents_platform.context_snapshots c WHERE c.task_id=t.id AND c.memory_scope_id=$4
        AND c.memory_generation<>$5)`;
    const parameters = [input.conversationId, input.beforeSequence, [...input.terminalStates], input.memoryScopeId, input.memoryGeneration];
    const turns = (await this.pool.query<ConversationHistoryTurn>(`SELECT t.id,t.input,t.output,t.state,t.turn_sequence::text AS sequence,t.created_at ${predicate}
      ORDER BY t.turn_sequence DESC LIMIT $6`, [...parameters, input.limit])).rows;
    const total = Number((await this.pool.query(`SELECT count(*)::int AS n ${predicate}`, parameters)).rows[0]?.n ?? 0);
    return { turns, olderCount: Math.max(0, total - turns.length) };
  }
}
