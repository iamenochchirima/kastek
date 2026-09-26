/**
 * Compatibility types for migration input and cleanup jobs that still touch
 * the pre-v2 memory_records table. New runtime memory code must use contracts.ts.
 */
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
  fact_key: string | null;
  supersedes_memory_id: string | null;
  superseded_at: string | null;
  status: string;
  expires_at: string | null;
  created_at: string | Date;
  updated_at: string;
  embedding_vector?: number[] | null;
  embedding_model?: string | null;
  relevance_score?: number;
  lexical_score?: number;
  vector_score?: number;
}

export interface MemoryScope {
  organizationId: string;
  agentId: string;
  installationId?: string;
  conversationId?: string;
  actorId?: string;
  runId?: string;
}

export interface MemoryPurgeResult {
  memoryIds: string[];
  conversationIds: string[];
}
