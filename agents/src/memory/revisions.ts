import { createHash } from "node:crypto";

export type MemoryRevisionType = "semantic" | "episodic";
export type MemoryNamespace = "conversation" | "end_user_private" | "workspace_shared" | "agent_private";
export type MemoryRevisionTransition = "assertion" | "correction" | "supersession" | "revalidation" | "expiration" | "deletion";
export type MemoryRelationType = "supports" | "contradicts" | "supersedes" | "derived_from" | "about";
export type MemoryRevisionLifecycleState =
  | "observed"
  | "candidate"
  | "review_pending"
  | "quarantined"
  | "active"
  | "superseded"
  | "expired"
  | "rejected"
  | "deleted";
export type MemorySourceTrust = "user_explicit" | "platform_curated" | "model_inferred" | "imported" | "system_observed";
export type MemorySensitivity = "normal" | "sensitive" | "restricted";
export type MemoryRedactionClass = "standard" | "sensitive" | "restricted";

export interface MemoryRevisionScope {
  organizationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  installationId: string;
  agentVersionId?: string;
  conversationId?: string;
  endUserId?: string;
  namespace: MemoryNamespace;
  memoryType: MemoryRevisionType;
}

export interface MemoryFactIdentity extends MemoryRevisionScope {
  subjectKey: string;
  predicateKey: string;
  /** Stable scope + subject + predicate identity. The asserted value is not part of this key. */
  factKey: string;
}

export interface MemoryRevisionInput {
  memoryType: MemoryRevisionType;
  transitionType?: MemoryRevisionTransition;
  lifecycleState: MemoryRevisionLifecycleState;
  canonicalText: string;
  typedValue?: Record<string, unknown>;
  eventTime?: string;
  eventSummary?: string;
  participants?: readonly Record<string, unknown>[];
  outcome?: string;
  validFrom: string;
  validTo?: string;
  observedAt?: string;
  confidence?: number;
  sourceTrust: MemorySourceTrust;
  sensitivity?: MemorySensitivity;
  provenance?: Record<string, unknown>;
  evidenceDigest: string;
  extractionVersion: string;
  sourceEventIds: readonly string[];
  sourceEventType?: string;
  sourceRunId?: string;
  sourceOccurredAt?: string;
  redactionClass?: MemoryRedactionClass;
  predecessorRevisionId?: string;
  idempotencyKey: string;
  acceptedAt?: string;
  createdBy: string;
  /** Optional external provider projection requested by the owning policy. */
  providerProjection?: {
    providerName: string;
    projectionVersion?: string;
    payload?: Record<string, unknown>;
  };
}

export interface MemoryRevisionRecord extends MemoryRevisionInput {
  id: string;
  factId: string;
  revisionNumber: number;
  transitionType: MemoryRevisionTransition;
  committedAt: string;
  createdAt: string;
}

export interface MemoryRelationInput {
  organizationId: string;
  fromRevisionId: string;
  toRevisionId: string;
  relationType: MemoryRelationType;
  metadata?: Record<string, unknown>;
  createdBy: string;
}

export interface MemoryRelationRecord extends MemoryRelationInput {
  id: string;
  createdAt: string;
}

const MAX_TEXT_LENGTH = 16_000;
const MAX_KEY_LENGTH = 512;
const MAX_ID_LENGTH = 240;

function required(value: string, field: string, maxLength = MAX_ID_LENGTH): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field.toUpperCase()}_REQUIRED`);
  if (normalized.length > maxLength) throw new Error(`${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

function optional(value: string | undefined, field: string, maxLength = MAX_ID_LENGTH): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field.toUpperCase()}_INVALID`);
  if (normalized.length > maxLength) throw new Error(`${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

function iso(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field.toUpperCase()}_INVALID`);
  return parsed.toISOString();
}

function boundedText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field.toUpperCase()}_REQUIRED`);
  if (normalized.length > maxLength) throw new Error(`${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

function normalizeJsonObject(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not serializable");
    return JSON.parse(encoded) as Record<string, unknown>;
  } catch {
    throw new Error("MEMORY_JSON_VALUE_INVALID");
  }
}

function normalizeParticipants(value: readonly Record<string, unknown>[] | undefined): readonly Record<string, unknown>[] {
  if (value === undefined) return [];
  return value.map((participant) => normalizeJsonObject(participant));
}

export function normalizeMemoryFactIdentity(input: MemoryFactIdentity): MemoryFactIdentity {
  const organizationId = required(input.organizationId, "organization_id");
  const workspaceId = required(input.workspaceId, "workspace_id");
  const agentDefinitionId = required(input.agentDefinitionId, "agent_definition_id");
  const installationId = required(input.installationId, "installation_id");
  const agentVersionId = optional(input.agentVersionId, "agent_version_id");
  const conversationId = optional(input.conversationId, "conversation_id");
  const endUserId = optional(input.endUserId, "end_user_id");
  const subjectKey = required(input.subjectKey, "subject_key");
  const predicateKey = required(input.predicateKey, "predicate_key");
  const factKey = boundedText(input.factKey, "fact_key", MAX_KEY_LENGTH);

  if (input.namespace === "conversation" && !conversationId) throw new Error("CONVERSATION_SCOPE_REQUIRED");
  if (input.namespace === "conversation" && endUserId) throw new Error("CONVERSATION_SCOPE_CANNOT_HAVE_END_USER");
  if (input.namespace === "end_user_private" && !endUserId) throw new Error("END_USER_SCOPE_REQUIRED");
  if (input.namespace !== "end_user_private" && endUserId) throw new Error("END_USER_SCOPE_NOT_ALLOWED");
  if (input.namespace !== "conversation" && conversationId) throw new Error("CONVERSATION_SCOPE_NOT_ALLOWED");

  return {
    organizationId,
    workspaceId,
    agentDefinitionId,
    installationId,
    ...(agentVersionId ? { agentVersionId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(endUserId ? { endUserId } : {}),
    namespace: input.namespace,
    memoryType: input.memoryType,
    subjectKey,
    predicateKey,
    factKey,
  };
}

export function normalizeMemoryRevisionInput(input: MemoryRevisionInput): MemoryRevisionInput {
  const transitionType = input.transitionType ?? "assertion";
  const canonicalText = boundedText(input.canonicalText, "canonical_text", MAX_TEXT_LENGTH);
  const validFrom = iso(input.validFrom, "valid_from")!;
  const validTo = iso(input.validTo, "valid_to");
  if (validTo && new Date(validTo).getTime() <= new Date(validFrom).getTime()) throw new Error("MEMORY_VALIDITY_INTERVAL_INVALID");
  const eventTime = iso(input.eventTime, "event_time");
  const observedAt = iso(input.observedAt, "observed_at");
  const sourceOccurredAt = iso(input.sourceOccurredAt, "source_occurred_at");
  const predecessorRevisionId = optional(input.predecessorRevisionId, "predecessor_revision_id");
  if (transitionType === "assertion" && predecessorRevisionId) throw new Error("ASSERTION_CANNOT_HAVE_PREDECESSOR");
  if (transitionType !== "assertion" && !predecessorRevisionId) throw new Error("TRANSITION_PREDECESSOR_REQUIRED");
  if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) {
    throw new Error("MEMORY_CONFIDENCE_INVALID");
  }
  const sourceEventIds = [...new Set(input.sourceEventIds.map((value) => required(value, "source_event_id")))];
  if (sourceEventIds.length === 0) throw new Error("MEMORY_SOURCE_EVENT_REQUIRED");
  if (input.memoryType === "episodic" && !eventTime) throw new Error("EPISODIC_EVENT_TIME_REQUIRED");
  if (input.memoryType === "episodic" && !input.eventSummary?.trim()) throw new Error("EPISODIC_EVENT_SUMMARY_REQUIRED");
  if (input.memoryType === "semantic" && eventTime) throw new Error("SEMANTIC_EVENT_TIME_NOT_ALLOWED");
  const providerProjection = input.providerProjection
    ? {
      providerName: required(input.providerProjection.providerName, "provider_name", 160),
      projectionVersion: required(input.providerProjection.projectionVersion ?? "v1", "projection_version", 80),
      payload: normalizeJsonObject(input.providerProjection.payload),
    }
    : undefined;
  return {
    memoryType: input.memoryType,
    transitionType,
    lifecycleState: input.lifecycleState,
    canonicalText,
    typedValue: normalizeJsonObject(input.typedValue),
    ...(eventTime ? { eventTime } : {}),
    ...(input.eventSummary?.trim() ? { eventSummary: boundedText(input.eventSummary, "event_summary", MAX_TEXT_LENGTH) } : {}),
    participants: normalizeParticipants(input.participants),
    ...(input.outcome?.trim() ? { outcome: boundedText(input.outcome, "outcome", MAX_TEXT_LENGTH) } : {}),
    validFrom,
    ...(validTo ? { validTo } : {}),
    ...(observedAt ? { observedAt } : {}),
    ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
    sourceTrust: input.sourceTrust,
    sensitivity: input.sensitivity ?? "normal",
    provenance: normalizeJsonObject(input.provenance),
    evidenceDigest: boundedText(input.evidenceDigest, "evidence_digest", 256),
    extractionVersion: boundedText(input.extractionVersion, "extraction_version", 120),
    sourceEventIds,
    ...(input.sourceEventType ? { sourceEventType: boundedText(input.sourceEventType, "source_event_type", 120) } : {}),
    ...(input.sourceRunId ? { sourceRunId: required(input.sourceRunId, "source_run_id") } : {}),
    ...(sourceOccurredAt ? { sourceOccurredAt } : {}),
    redactionClass: input.redactionClass ?? "standard",
    ...(predecessorRevisionId ? { predecessorRevisionId } : {}),
    idempotencyKey: boundedText(input.idempotencyKey, "idempotency_key", MAX_ID_LENGTH),
    ...(input.acceptedAt ? { acceptedAt: iso(input.acceptedAt, "accepted_at") } : {}),
    createdBy: required(input.createdBy, "created_by"),
    ...(providerProjection ? { providerProjection } : {}),
  };
}

export function assertMemoryRevisionTransition(
  input: Pick<MemoryRevisionInput, "transitionType" | "predecessorRevisionId">,
  predecessor?: { id: string; factId: string; lifecycleState: MemoryRevisionLifecycleState },
  factId?: string,
): void {
  const transitionType = input.transitionType ?? "assertion";
  if (transitionType === "assertion") {
    if (input.predecessorRevisionId) throw new Error("ASSERTION_CANNOT_HAVE_PREDECESSOR");
    return;
  }
  if (!input.predecessorRevisionId) throw new Error("TRANSITION_PREDECESSOR_REQUIRED");
  if (!predecessor) throw new Error("MEMORY_PREDECESSOR_NOT_FOUND");
  if (predecessor.id !== input.predecessorRevisionId) throw new Error("MEMORY_PREDECESSOR_MISMATCH");
  if (factId && predecessor.factId !== factId) throw new Error("MEMORY_PREDECESSOR_SCOPE_MISMATCH");
  if (["rejected", "deleted", "expired"].includes(predecessor.lifecycleState)) throw new Error("MEMORY_PREDECESSOR_NOT_TRANSITIONABLE");
}

/** Compare-and-set guard used by correction/revalidation commands. */
export function assertExpectedPredecessor(
  expectedRevisionId: string | undefined,
  currentRevisionId: string | undefined,
): void {
  const expected = expectedRevisionId?.trim();
  if (!expected) throw new Error("MEMORY_EXPECTED_REVISION_REQUIRED");
  if (!currentRevisionId || expected !== currentRevisionId) {
    throw Object.assign(new Error("MEMORY_STALE_EXPECTED_REVISION"), {
      code: "MEMORY_STALE_EXPECTED_REVISION",
      expectedRevisionId: expected,
      currentRevisionId,
    });
  }
}

export function memoryRevisionFingerprint(factId: string, input: MemoryRevisionInput): string {
  const normalized = normalizeMemoryRevisionInput(input);
  return createHash("sha256").update(JSON.stringify({ factId, ...normalized })).digest("hex");
}

export function resolveCurrentMemoryRevision(
  revisions: readonly MemoryRevisionRecord[],
  asOf = new Date(),
): MemoryRevisionRecord | null {
  const at = asOf.getTime();
  const superseded = new Set(
    revisions
      .filter((revision) => revision.predecessorRevisionId
        && new Date(revision.validFrom).getTime() <= at
        && ["active", "superseded", "expired", "deleted"].includes(revision.lifecycleState)
        && ["correction", "supersession", "expiration", "deletion"].includes(revision.transitionType))
      .map((revision) => revision.predecessorRevisionId!),
  );
  return revisions
    .filter((revision) => revision.lifecycleState === "active")
    .filter((revision) => new Date(revision.validFrom).getTime() <= at)
    .filter((revision) => !revision.validTo || new Date(revision.validTo).getTime() > at)
    .filter((revision) => !superseded.has(revision.id))
    .sort((left, right) => right.revisionNumber - left.revisionNumber)[0] ?? null;
}
