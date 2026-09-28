import { createHash } from "node:crypto";

/**
 * Versioned domain vocabulary for the memory architecture upgrade.
 *
 * These types deliberately do not mirror the legacy memory_records table. The
 * legacy table is migration input; callers of the new memory system must use
 * an explicit scope, lifecycle state, provenance, and evidence contract.
 */
export const MEMORY_CONTRACT_VERSION = "memory-v2" as const;

export type MemoryNamespace =
  | "conversation"
  | "end_user_private"
  | "workspace_shared"
  | "agent_private"
  | "procedural"
  | "knowledge";

export type MemoryKind = "working" | "episodic" | "semantic" | "procedural" | "knowledge";

/**
 * The classes are intentionally explicit. A summary is a lossy working
 * projection, an episode is a historical event, a semantic claim is a
 * revisable fact, a procedure is executable guidance, and knowledge is an
 * externally curated grounding source. They do not share write or retrieval
 * paths merely because all of them can be rendered as text.
 */
export interface MemoryClassDefinition {
  kind: MemoryKind;
  durable: boolean;
  mutable: boolean;
  eligibleForFactRevision: boolean;
  eligibleForModelGrounding: boolean;
  defaultLifecycle: MemoryLifecycleState;
  description: string;
}

export const MEMORY_CLASS_DEFINITIONS: Readonly<Record<MemoryKind, MemoryClassDefinition>> = {
  working: {
    kind: "working",
    durable: false,
    mutable: true,
    eligibleForFactRevision: false,
    eligibleForModelGrounding: true,
    defaultLifecycle: "observed",
    description: "Bounded turn-local context; replaced by checkpoints and never promoted as a fact.",
  },
  episodic: {
    kind: "episodic",
    durable: true,
    mutable: false,
    eligibleForFactRevision: true,
    eligibleForModelGrounding: true,
    defaultLifecycle: "review_pending",
    description: "A time-bound event with participants, outcome, and source evidence.",
  },
  semantic: {
    kind: "semantic",
    durable: true,
    mutable: false,
    eligibleForFactRevision: true,
    eligibleForModelGrounding: true,
    defaultLifecycle: "review_pending",
    description: "A scoped claim whose value changes through immutable corrections or supersessions.",
  },
  procedural: {
    kind: "procedural",
    durable: true,
    mutable: false,
    eligibleForFactRevision: false,
    eligibleForModelGrounding: true,
    defaultLifecycle: "review_pending",
    description: "Versioned instructions or policies loaded through a procedure-specific interface.",
  },
  knowledge: {
    kind: "knowledge",
    durable: true,
    mutable: false,
    eligibleForFactRevision: false,
    eligibleForModelGrounding: true,
    defaultLifecycle: "active",
    description: "Curated grounding material; never silently promoted into user memory.",
  },
} as const;

export function memoryClassDefinition(kind: MemoryKind): MemoryClassDefinition {
  return MEMORY_CLASS_DEFINITIONS[kind];
}

export type MemoryLifecycleState =
  | "observed"
  | "candidate"
  | "active"
  | "review_pending"
  | "quarantined"
  | "rejected"
  | "superseded"
  | "expired"
  | "deleted";

export type MemoryReadinessState = "accepted" | "committed" | "indexed" | "visible";

export interface MemoryScope {
  organizationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  installationId: string;
  conversationId?: string;
  endUserId?: string;
  namespace: MemoryNamespace;
  /** Optional policy projection used by the typed retrieval planner. */
  readableNamespaces?: readonly MemoryNamespace[];
}

export interface MemorySourceReference {
  sourceEventId: string;
  sourceRunId?: string;
  sourceTurnId?: string;
  sourceMessageId?: string;
  occurredAt: string;
  relation: "direct" | "derived" | "corrected" | "imported";
}

export interface MemoryEvidenceItem {
  id: string;
  actor: "end_user" | "agent" | "tool" | "operator" | "system";
  occurredAt: string;
  contentDigest: string;
  /** Content is only present in a redacted checkpoint envelope. */
  content?: string;
  sourceType: "message" | "tool_result" | "approval" | "effect" | "workspace_state";
}

export interface MemoryEvidenceEnvelope {
  contractVersion: typeof MEMORY_CONTRACT_VERSION;
  scope: Omit<MemoryScope, "namespace">;
  sourceEventIds: string[];
  items: MemoryEvidenceItem[];
  evidenceDigest: string;
  redaction: "content_present" | "content_redacted";
  capturedAt: string;
}

export interface MemoryClaim {
  subject: string;
  predicate: string;
  value: unknown;
  factKey: string;
  validFrom?: string;
  validTo?: string;
}

export interface MemoryRevision {
  id: string;
  scope: MemoryScope;
  kind: MemoryKind;
  claim?: MemoryClaim;
  canonicalText: string;
  state: MemoryLifecycleState;
  readiness: Readonly<Record<MemoryReadinessState, string | null>>;
  sources: MemorySourceReference[];
  provenance: Record<string, unknown>;
  confidence?: number;
  sensitivity: "normal" | "sensitive" | "restricted";
  revision: number;
  supersedesRevisionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryCheckpointRequest {
  scope: Omit<MemoryScope, "namespace">;
  runId: string;
  turnId: string;
  compactionGeneration: number;
  sourceBoundary: string;
  evidence: MemoryEvidenceEnvelope;
  idempotencyKey: string;
}

export interface MemoryCheckpointReceipt {
  checkpointId: string;
  evidenceDigest: string;
  sourceBoundary: string;
  status: "committed" | "replayed";
  committedAt: string;
}

export interface MemoryCheckpointPort {
  commit(request: MemoryCheckpointRequest): Promise<MemoryCheckpointReceipt>;
}

export interface MemoryRetrievalPlan {
  scope: MemoryScope;
  decision: "not_requested" | "requested" | "required";
  query: string;
  memoryKinds: MemoryKind[];
  freshness: "current" | "historical" | "any";
  maxResults: number;
  maxTokens: number;
  reason: string;
  plannerVersion: string;
  /** Explicit namespace allow-list. Omitted only for legacy callers that already scoped storage. */
  readableNamespaces?: MemoryNamespace[];
}

export interface MemoryEvidencePackItem {
  revisionId: string;
  text: string;
  score: number;
  rank: number;
  kind: MemoryKind;
  scope: MemoryScope;
  sources: MemorySourceReference[];
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  /** Content-free revision lineage; never contains canonical text or provider payloads. */
  relations?: readonly {
    relationType: "supports" | "contradicts" | "supersedes" | "derived_from" | "about";
    relatedRevisionId: string;
  }[];
  selectionReason: string;
}

export interface MemoryEvidencePack {
  plan: MemoryRetrievalPlan;
  items: MemoryEvidencePackItem[];
  measuredTokens: number;
  measurementBasis: "full_estimate" | "provider_reported";
}

export interface MemoryRetrievalPort {
  retrieve(plan: MemoryRetrievalPlan): Promise<MemoryEvidencePack>;
}

export type MemoryEventType =
  | "memory.capture.accepted"
  | "memory.checkpoint.requested"
  | "memory.checkpoint.committed"
  | "memory.checkpoint.blocked"
  | "memory.checkpoint.failed"
  | "memory.extraction.queued"
  | "memory.extraction.completed"
  | "memory.revision.committed"
  | "memory.revision.superseded"
  | "memory.retrieval.requested"
  | "memory.retrieval.completed"
  | "memory.retrieval.blocked"
  | "memory.retention.expired"
  | "memory.deletion.requested"
  | "memory.deletion.completed"
  | "memory.deletion.blocked";

export interface MemoryEvent {
  id: string;
  type: MemoryEventType;
  scope: Omit<MemoryScope, "namespace">;
  correlationId?: string;
  causationId?: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

const namespaceRequirements: Record<MemoryNamespace, (keyof MemoryScope)[]> = {
  conversation: ["conversationId"],
  end_user_private: ["endUserId"],
  workspace_shared: [],
  agent_private: ["installationId"],
  procedural: ["installationId"],
  knowledge: [],
};

function normalizePart(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function validateMemoryScope(scope: MemoryScope): void {
  for (const [field, value] of Object.entries(scope)) {
    if (field === "namespace") continue;
    if (value !== undefined && (!value || typeof value !== "string")) {
      throw Object.assign(new Error(`Memory scope field is invalid: ${field}`), { code: "MEMORY_SCOPE_INVALID" });
    }
  }
  for (const required of namespaceRequirements[scope.namespace]) {
    if (!scope[required]) {
      throw Object.assign(new Error(`Memory namespace requires ${required}`), { code: "MEMORY_SCOPE_INCOMPLETE", field: required });
    }
  }
}

export function canonicalFactKey(input: Pick<MemoryScope, "organizationId" | "workspaceId" | "agentDefinitionId" | "installationId" | "namespace"> & Pick<MemoryClaim, "subject" | "predicate">): string {
  const canonical = [
    normalizePart(input.organizationId),
    normalizePart(input.workspaceId),
    normalizePart(input.agentDefinitionId),
    normalizePart(input.installationId),
    input.namespace,
    normalizePart(input.subject),
    normalizePart(input.predicate),
  ].join("|");
  return `fact:v1:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function evidenceDigest(items: readonly MemoryEvidenceItem[]): string {
  return createHash("sha256").update(stableJson(items)).digest("hex");
}

const transitions: Record<MemoryLifecycleState, ReadonlySet<MemoryLifecycleState>> = {
  observed: new Set(["candidate", "rejected"]),
  candidate: new Set(["active", "review_pending", "quarantined", "rejected"]),
  active: new Set(["superseded", "expired", "deleted"]),
  review_pending: new Set(["active", "rejected", "quarantined"]),
  quarantined: new Set(["active", "rejected"]),
  rejected: new Set(["deleted"]),
  superseded: new Set(["deleted"]),
  expired: new Set(["deleted"]),
  deleted: new Set(),
};

export function canTransitionMemoryState(from: MemoryLifecycleState, to: MemoryLifecycleState): boolean {
  return transitions[from].has(to);
}

export function assertMemoryStateTransition(from: MemoryLifecycleState, to: MemoryLifecycleState): void {
  if (!canTransitionMemoryState(from, to)) {
    throw Object.assign(new Error(`Invalid memory state transition: ${from} -> ${to}`), {
      code: "MEMORY_STATE_TRANSITION_INVALID",
      from,
      to,
    });
  }
}

const sensitivePatterns = [
  /((?:api[_ -]?key|token|secret|password|passcode)\s*[:=]\s*)[^\s,;]+/giu,
  /\b(?:sk|pk)_[a-z0-9_-]{12,}\b/giu,
];

export function redactEvidenceText(value: string): string {
  let redacted = value.slice(0, 8_000);
  for (const pattern of sensitivePatterns) redacted = redacted.replace(pattern, "$1[REDACTED]");
  return redacted;
}

export function createEvidenceItem(input: Omit<MemoryEvidenceItem, "contentDigest"> & { rawContent: string; includeContent?: boolean }): MemoryEvidenceItem {
  const content = input.includeContent === false ? undefined : redactEvidenceText(input.rawContent);
  return {
    id: input.id,
    actor: input.actor,
    occurredAt: input.occurredAt,
    sourceType: input.sourceType,
    contentDigest: createHash("sha256").update(input.rawContent).digest("hex"),
    ...(content === undefined ? {} : { content }),
  };
}
