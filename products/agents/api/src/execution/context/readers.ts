/**
 * Scoped context readers. Context assembly asks for one reader per state owner instead of
 * querying conversation, knowledge, memory and run records directly. Implementations live with
 * the owning module and are injected from composition.
 */
export type ConversationHistoryTurn = {
  id: string;
  input: string;
  output: string | null;
  state: string;
  sequence: string;
  created_at: Date;
};

export interface ConversationHistoryReader {
  readWindow(input: {
    conversationId: string;
    beforeSequence: string;
    limit: number;
    terminalStates: readonly string[];
    memoryScopeId: string | null;
    memoryGeneration: number | null;
  }): Promise<{ turns: ConversationHistoryTurn[]; olderCount: number }>;
}

export interface KnowledgeContextReader {
  pinnedEligible(taskId: string): Promise<boolean>;
  pinnedSources(taskId: string): Promise<unknown>;
  search(taskId: string, operationId: string, query: string): Promise<unknown>;
  read(taskId: string, operationId: string, evidenceId: string, offset?: number): Promise<unknown>;
}

export interface MemoryContextReader {
  readForContext(scope: object, query: string, limit?: number): Promise<unknown>;
  readSkills(scope: object, skillIds: string[]): Promise<unknown>;
}

export type ContextRunState = { state: string; output: string | null; errorCode: string | null };

export interface ContextRunStateReader {
  read(taskId: string): Promise<ContextRunState | null>;
}

/** Readers available to context assembly. Unimplemented readers stay undefined. */
import type { MemoryStorePort } from "../../contracts/memory";
export interface ContextReaders {
  history?: ConversationHistoryReader;
  knowledge?: KnowledgeContextReader;
  memory?: MemoryContextReader & MemoryStorePort;
  runState?: ContextRunStateReader;
}
