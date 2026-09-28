import { createHash } from "node:crypto";
import type { ModelMessage } from "../model/types";

/**
 * Runtime-facing memory scope. Memory repositories may refine this shape, but
 * the context runtime only carries identity and never interprets storage
 * state, ranking, retention, or semantic revisions.
 */
export interface MemoryRuntimeScope {
  readonly organizationId: string;
  readonly workspaceId?: string;
  readonly agentDefinitionId: string;
  readonly agentVersionId: string;
  readonly installationId: string;
  readonly conversationId?: string;
  readonly endUserId?: string;
  readonly namespace: string;
  /** Namespaces the installation policy permits this retrieval to inspect. */
  readonly readableNamespaces?: readonly string[];
}

export interface MemorySourceEventBoundary {
  readonly eventIds: readonly string[];
  readonly firstSequence?: number;
  readonly lastSequence?: number;
  readonly digest: string;
}

export interface MemoryDirectEvidenceItem {
  readonly sourceEventId: string;
  readonly role: ModelMessage["role"];
  readonly contentDigest: string;
  /** Redacted content is optional; raw prompt/tool content is never required. */
  readonly redactedContent?: string;
}

export interface MemoryDirectEvidenceEnvelope {
  readonly schemaVersion: "v1";
  readonly redacted: true;
  readonly items: readonly MemoryDirectEvidenceItem[];
}

export interface MemoryCheckpointRequest {
  readonly runId: string;
  readonly turnId: string;
  readonly compactionGeneration: number;
  readonly sourceEventBoundary: MemorySourceEventBoundary;
  readonly scope: MemoryRuntimeScope;
  readonly evidenceDigest: string;
  readonly directEvidence: MemoryDirectEvidenceEnvelope;
}

export interface MemoryCheckpointResult {
  readonly status: "committed" | "replayed";
  readonly checkpointId: string;
}

export interface MemoryCheckpointPort {
  checkpoint(request: MemoryCheckpointRequest): Promise<MemoryCheckpointResult>;
}

export interface MemoryEvidenceItem {
  readonly evidenceId: string;
  readonly scope: MemoryRuntimeScope;
  readonly provenance: {
    readonly sourceEventIds: readonly string[];
    readonly sourceRunId?: string;
    readonly sourceRevisionId?: string;
  };
  readonly validity: { readonly validFrom?: string; readonly validTo?: string };
  readonly lifecycleState: "active" | "superseded" | "expired" | "quarantined";
  readonly retrievalReason?: string;
  readonly score?: number;
  readonly redactedContent: string;
  /** Content-free lineage for historical and contradiction explanations. */
  readonly relations?: readonly {
    readonly relationType: "supports" | "contradicts" | "supersedes" | "derived_from" | "about";
    readonly relatedRevisionId: string;
  }[];
  readonly measurement?: Record<string, unknown>;
}

export interface MemoryRetrievalRequest {
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId: string;
  readonly compactionGeneration: number;
  readonly sourceEventBoundary: MemorySourceEventBoundary;
  readonly scope: MemoryRuntimeScope;
  readonly reason: string;
  readonly query: string;
  readonly maxEvidenceTokens?: number;
  readonly gate?: {
    readonly source: "deterministic_prefilter" | "small_model" | "bounded_fallback";
    readonly model?: string;
    readonly confidence?: number;
    readonly latencyMs: number;
    readonly errorCode?: string;
  };
}

export interface MemoryEvidencePack {
  readonly packId: string;
  readonly status: "completed" | "blocked";
  readonly evidence: readonly MemoryEvidenceItem[];
  readonly blockedReason?: string;
  /** Content-free evidence for operators and replay; never includes the query text. */
  readonly diagnostics?: {
    readonly plannerVersion: string;
    readonly candidateCount: number;
    readonly selectedRevisionIds: readonly string[];
    readonly rejectedReasons: readonly string[];
    readonly measuredTokens: number;
    readonly latencyMs: number;
  };
}

export interface MemoryRetrievalPort {
  retrieve(request: MemoryRetrievalRequest): Promise<MemoryEvidencePack>;
}

export type MemoryRuntimeEventType =
  | "memory_checkpoint_requested"
  | "memory_checkpoint_committed"
  | "memory_checkpoint_blocked"
  | "memory_checkpoint_failed"
  | "memory_retrieval_requested"
  | "memory_retrieval_completed"
  | "memory_retrieval_blocked";

export interface MemoryRuntimeEventPayload {
  readonly type: MemoryRuntimeEventType;
  readonly runId: string;
  readonly turnId: string;
  readonly attemptId?: string;
  readonly compactionGeneration?: number;
  readonly sourceEventBoundaryDigest?: string;
  readonly manifestDigest?: string;
  readonly status?: string;
  readonly reason?: string;
  readonly checkpointId?: string;
  readonly packId?: string;
  readonly evidenceCount?: number;
  readonly diagnostics?: {
    readonly plannerVersion?: string;
    readonly candidateCount?: number;
    readonly selectedRevisionIds?: readonly string[];
    readonly rejectedReasons?: readonly string[];
    readonly measuredTokens?: number;
    readonly latencyMs?: number;
  };
  readonly errorCode?: string;
}

/** A no-op adapter keeps context-runtime tests independent of memory rollout. */
export const noopMemoryRetrievalPort: MemoryRetrievalPort = {
  async retrieve(request) {
    return { packId: `memory-pack:${request.attemptId}`, status: "completed", evidence: [] };
  },
};

export const noopMemoryCheckpointPort: MemoryCheckpointPort = {
  async checkpoint(request) {
    return { checkpointId: `memory-checkpoint:${request.runId}:${request.turnId}:${request.compactionGeneration}`, status: "committed" };
  },
};

export function sourceEventBoundaryFromMessages(messages: readonly ModelMessage[], sourceEventIds: readonly string[] = []): MemorySourceEventBoundary {
  const sourceMessages = messages.filter((message) => !isInjectedMemoryEvidence(message));
  const digest = createHash("sha256").update(JSON.stringify(sourceMessages)).digest("hex");
  return { eventIds: [...sourceEventIds], digest };
}

export function directEvidenceEnvelopeFromMessages(messages: readonly ModelMessage[], sourceEventIds: readonly string[] = []): MemoryDirectEvidenceEnvelope {
  return {
    schemaVersion: "v1",
    redacted: true,
    items: messages.map((message, index) => ({ message, index }))
      .filter(({ message }) => isDirectEvidenceMessage(message))
      .map(({ message, index }) => ({
      sourceEventId: sourceEventIds[index] ?? `message:${index}`,
      role: message.role,
      contentDigest: createHash("sha256").update(JSON.stringify(message.content)).digest("hex"),
    })),
  };
}

/**
 * Checkpoint evidence is the normalized conversational record. System
 * scaffolding, prior summaries, tool payloads, and assistant tool-call
 * envelopes have their own durable journal/effect receipts and must not be
 * re-extracted as user facts during compaction.
 */
function isDirectEvidenceMessage(message: ModelMessage): boolean {
  if (isInjectedMemoryEvidence(message)) return false;
  if (message.role === "user") return true;
  return message.role === "assistant" && !(message.toolCalls && message.toolCalls.length > 0);
}

/**
 * Memory evidence is a model-facing projection, not a new source event. It
 * must not move the durable boundary used to make a later retrieval decision
 * or checkpoint request.
 */
function isInjectedMemoryEvidence(message: ModelMessage): boolean {
  return message.role === "system"
    && typeof message.content === "string"
    && message.content.startsWith('<untrusted-data source="memory-evidence">');
}

export function memoryEvidencePrompt(evidence: readonly MemoryEvidenceItem[]): string | undefined {
  if (!evidence.length) return undefined;
  return `<untrusted-data source="memory-evidence">\n${evidence.map((item) => `[${item.evidenceId}] ${item.redactedContent}`).join("\n")}\n</untrusted-data>`;
}
