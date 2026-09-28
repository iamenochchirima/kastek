import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  buildEvent,
  enqueueOutbox,
  type AnalyticsOutboxRecord,
  type JsonObject,
} from "./producer";

export type MemoryAnalyticsKind = "working" | "episodic" | "semantic" | "procedural" | "knowledge";
export type MemoryAnalyticsNamespace = "conversation" | "end_user_private" | "workspace_shared" | "agent_private" | "procedural" | "knowledge";
export type MemoryLifecycleAction = "capture" | "candidate" | "review" | "conflict" | "checkpoint";
export type MemoryLifecycleState =
  | "observed"
  | "candidate"
  | "review_pending"
  | "quarantined"
  | "active"
  | "rejected"
  | "superseded"
  | "expired"
  | "deleted";
export type MemoryLifecycleStatus = MemoryLifecycleState
  | "accepted"
  | "requested"
  | "committed"
  | "blocked"
  | "failed"
  | "replayed";
/*
 * The status union includes checkpoint outcomes; transitions remain memory
 * state transitions and therefore cannot use an operational checkpoint status.
 */
export type MemoryLifecycleTransitionState = MemoryLifecycleState;
export type MemoryRetrievalDecision = "not_requested" | "requested" | "required";
export type MemoryRetrievalStatus = "completed" | "blocked" | "failed";
export type MemoryProjectionKind = "fts" | "vector" | "temporal" | "provider";
export type MemoryProjectionOperation = "upsert" | "delete" | "revalidate";
export type MemoryProjectionStatus = "accepted" | "indexing" | "indexed" | "visible" | "failed" | "blocked" | "deleted";
export type MemoryDeletionTarget = "memory" | "revision" | "conversation" | "end_user" | "user" | "knowledge_source" | "agent" | "workspace" | "organization";
export type MemoryDeletionStatus = "requested" | "held" | "canonical_purged" | "projections_purged" | "provider_confirmed" | "completed" | "blocked" | "failed" | "retrying";

export interface MemoryAnalyticsScopeInput {
  organizationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  agentVersionId?: string | null;
  installationId: string;
}

export interface MemoryLifecycleAnalyticsInput extends MemoryAnalyticsScopeInput {
  memoryId?: string | null;
  revisionId?: string | null;
  checkpointId?: string | null;
  runId?: string | null;
  turnId?: string | null;
  memoryKind: MemoryAnalyticsKind;
  namespace: MemoryAnalyticsNamespace;
  action: MemoryLifecycleAction;
  status: MemoryLifecycleStatus;
  transitionFrom?: MemoryLifecycleTransitionState | null;
  transitionTo?: MemoryLifecycleTransitionState | null;
  relationType?: "supports" | "contradicts" | "supersedes" | "derived_from" | "about" | null;
  sensitivity?: "normal" | "sensitive" | "restricted" | null;
  sourceEventCount?: number;
  candidateCount?: number;
  conflictCount?: number;
  retryCount?: number;
  latencyMs?: number;
  reasonCode?: string | null;
  errorCode?: string | null;
  occurredAt: Date | string;
  correlationId?: string | null;
  causationId?: string | null;
}

export interface MemoryRetrievalAnalyticsInput extends MemoryAnalyticsScopeInput {
  retrievalId: string;
  runId?: string | null;
  turnId?: string | null;
  attemptId?: string | null;
  sourceBoundaryDigest?: string | null;
  query?: string | null;
  queryDigest?: string | null;
  decision: MemoryRetrievalDecision;
  status: MemoryRetrievalStatus;
  freshness: "current" | "historical" | "any";
  memoryKinds: readonly MemoryAnalyticsKind[];
  reasonCode: string;
  plannerVersion: string;
  candidateCount: number;
  evidenceCount: number;
  selectedCount: number;
  measuredTokens: number;
  maxTokens: number;
  latencyMs: number;
  gateSource?: "none" | "heuristic" | "model";
  gateModel?: string | null;
  gateConfidence?: number | null;
  gateLatencyMs?: number | null;
  scopeRejection?: boolean;
  errorCode?: string | null;
  occurredAt: Date | string;
  correlationId?: string | null;
  causationId?: string | null;
}

export interface MemoryProjectionAnalyticsInput extends MemoryAnalyticsScopeInput {
  projectionId: string;
  revisionId: string;
  projectionKind: MemoryProjectionKind;
  operation: MemoryProjectionOperation;
  status: MemoryProjectionStatus;
  providerName?: string | null;
  providerState?: "accepted" | "indexed" | "visible" | "failed" | "deleted" | null;
  projectionVersion?: string | null;
  attemptCount: number;
  maxAttempts?: number;
  retryable?: boolean;
  latencyMs?: number;
  errorCode?: string | null;
  occurredAt: Date | string;
  correlationId?: string | null;
  causationId?: string | null;
}

export type MemoryDeletionScopeResolution = "installation" | "organization_aggregate";

export interface MemoryDeletionAnalyticsInput extends Omit<MemoryAnalyticsScopeInput, "workspaceId" | "agentDefinitionId" | "agentVersionId" | "installationId"> {
  workspaceId: string | null;
  agentDefinitionId: string | null;
  agentVersionId: string | null;
  installationId: string | null;
  scopeResolution?: MemoryDeletionScopeResolution;
  deletionId: string;
  targetType: MemoryDeletionTarget;
  status: MemoryDeletionStatus;
  legalHold: boolean;
  targetCount?: number;
  purgedRevisionCount?: number;
  purgedProjectionCount?: number;
  providerJobCount?: number;
  residualCount?: number;
  providerName?: string | null;
  attemptCount: number;
  retryable?: boolean;
  latencyMs?: number;
  errorCode?: string | null;
  occurredAt: Date | string;
  correlationId?: string | null;
  causationId?: string | null;
}

export function buildMemoryLifecycleEvent(input: MemoryLifecycleAnalyticsInput): AnalyticsOutboxRecord {
  const occurredAt = timestamp(input.occurredAt);
  const entityId = firstId(input.revisionId, input.memoryId, input.checkpointId) ?? `${input.action}:${occurredAt}`;
  const attributes: JsonObject = {
    ...scopeAttributes(input),
    memory_kind: input.memoryKind,
    namespace: input.namespace,
    action: input.action,
    status: input.status,
    occurred_at: occurredAt,
  };
  addOptional(attributes, "memory_id", input.memoryId);
  addOptional(attributes, "revision_id", input.revisionId);
  addOptional(attributes, "checkpoint_id", input.checkpointId);
  addOptional(attributes, "run_id", input.runId);
  addOptional(attributes, "turn_id", input.turnId);
  addOptional(attributes, "transition_from", input.transitionFrom);
  addOptional(attributes, "transition_to", input.transitionTo);
  addOptional(attributes, "relation_type", input.relationType);
  addOptional(attributes, "sensitivity", input.sensitivity);
  addOptionalInteger(attributes, "source_event_count", input.sourceEventCount);
  addOptionalInteger(attributes, "candidate_count", input.candidateCount);
  addOptionalInteger(attributes, "conflict_count", input.conflictCount);
  addOptionalInteger(attributes, "retry_count", input.retryCount);
  addOptionalInteger(attributes, "latency_ms", input.latencyMs);
  addOptional(attributes, "reason_code", boundedReason(input.reasonCode));
  addOptional(attributes, "error_code", boundedErrorCode(input.errorCode));
  return buildMemoryEvent({
    input,
    recordId: `memory:lifecycle:${entityId}:${input.action}:${input.status}`,
    contractName: "agent.memory.lifecycle@1",
    subject: `memory:${entityId}`,
    occurredAt: input.occurredAt,
    attributes,
    idempotencyKey: `agent-platform:memory:lifecycle:${entityId}:${input.action}:${input.status}`,
  });
}

export function buildMemoryRetrievalEvent(input: MemoryRetrievalAnalyticsInput): AnalyticsOutboxRecord {
  const occurredAt = timestamp(input.occurredAt);
  const memoryKinds = [...new Set(input.memoryKinds)].sort();
  if (memoryKinds.length === 0) throw new Error("Memory retrieval analytics requires at least one memory kind");
  const query = input.query ?? "";
  const attributes: JsonObject = {
    ...scopeAttributes(input),
    retrieval_id: required(input.retrievalId, "retrievalId"),
    decision: input.decision,
    status: input.status,
    freshness: input.freshness,
    memory_kinds: memoryKinds,
    reason_code: boundedReason(input.reasonCode) ?? "memory",
    planner_version: required(input.plannerVersion, "plannerVersion").slice(0, 120),
    candidate_count: nonNegativeInteger(input.candidateCount),
    evidence_count: nonNegativeInteger(input.evidenceCount),
    selected_count: nonNegativeInteger(input.selectedCount),
    measured_tokens: nonNegativeInteger(input.measuredTokens),
    max_tokens: positiveInteger(input.maxTokens),
    latency_ms: nonNegativeInteger(input.latencyMs),
    occurred_at: occurredAt,
  };
  addOptional(attributes, "run_id", input.runId);
  addOptional(attributes, "turn_id", input.turnId);
  addOptional(attributes, "attempt_id", input.attemptId);
  addOptional(attributes, "source_boundary_digest", normalizedDigest(input.sourceBoundaryDigest));
  addOptional(attributes, "query_digest", normalizedDigest(input.queryDigest) ?? (query ? sha256(query) : undefined));
  if (input.query !== undefined && input.query !== null) attributes.query_length = query.length;
  addOptional(attributes, "gate_source", input.gateSource);
  addOptional(attributes, "gate_model", input.gateModel?.trim().slice(0, 160));
  if (input.gateConfidence !== undefined && input.gateConfidence !== null) attributes.gate_confidence = boundedConfidence(input.gateConfidence);
  addOptionalInteger(attributes, "gate_latency_ms", input.gateLatencyMs);
  if (input.scopeRejection !== undefined) attributes.scope_rejection = input.scopeRejection;
  addOptional(attributes, "error_code", boundedErrorCode(input.errorCode));
  return buildMemoryEvent({
    input,
    recordId: `memory:retrieval:${input.retrievalId}:${input.status}`,
    contractName: "agent.memory.retrieval@1",
    subject: `memory-retrieval:${required(input.retrievalId, "retrievalId")}`,
    occurredAt: input.occurredAt,
    attributes,
    idempotencyKey: `agent-platform:memory:retrieval:${input.retrievalId}:${input.status}`,
  });
}

export function buildMemoryProjectionEvent(input: MemoryProjectionAnalyticsInput): AnalyticsOutboxRecord {
  const occurredAt = timestamp(input.occurredAt);
  const projectionId = required(input.projectionId, "projectionId");
  const attributes: JsonObject = {
    ...scopeAttributes(input),
    projection_id: projectionId,
    revision_id: required(input.revisionId, "revisionId"),
    projection_kind: input.projectionKind,
    operation: input.operation,
    status: input.status,
    attempt_count: nonNegativeInteger(input.attemptCount),
    occurred_at: occurredAt,
  };
  addOptional(attributes, "provider_name", input.providerName?.trim().slice(0, 160));
  addOptional(attributes, "provider_state", input.providerState);
  addOptional(attributes, "projection_version", input.projectionVersion?.trim().slice(0, 120));
  addOptionalInteger(attributes, "max_attempts", input.maxAttempts);
  if (input.retryable !== undefined) attributes.retryable = input.retryable;
  addOptionalInteger(attributes, "latency_ms", input.latencyMs);
  addOptional(attributes, "error_code", boundedErrorCode(input.errorCode));
  return buildMemoryEvent({
    input,
    recordId: `memory:projection:${projectionId}:${input.status}`,
    contractName: "agent.memory.projection@1",
    subject: `memory-projection:${projectionId}`,
    occurredAt: input.occurredAt,
    attributes,
    idempotencyKey: `agent-platform:memory:projection:${projectionId}:${input.status}`,
  });
}

export function buildMemoryDeletionEvent(input: MemoryDeletionAnalyticsInput): AnalyticsOutboxRecord {
  const occurredAt = timestamp(input.occurredAt);
  const deletionId = required(input.deletionId, "deletionId");
  const scopeResolution = input.scopeResolution ?? inferDeletionScopeResolution(input);
  validateDeletionScope(input, scopeResolution);
  const attemptCount = nonNegativeInteger(input.attemptCount);
  const scopeKey = sha256([
    input.organizationId,
    input.workspaceId ?? "",
    input.agentDefinitionId ?? "",
    input.agentVersionId ?? "",
    input.installationId ?? "",
  ].join("\u001f"));
  const attributes: JsonObject = {
    workspace_id: input.workspaceId,
    agent_definition_id: input.agentDefinitionId,
    agent_version_id: input.agentVersionId,
    installation_id: input.installationId,
    scope_resolution: scopeResolution,
    deletion_id: deletionId,
    target_type: input.targetType,
    status: input.status,
    legal_hold: input.legalHold,
    attempt_count: attemptCount,
    occurred_at: occurredAt,
  };
  addOptionalInteger(attributes, "target_count", input.targetCount);
  addOptionalInteger(attributes, "purged_revision_count", input.purgedRevisionCount);
  addOptionalInteger(attributes, "purged_projection_count", input.purgedProjectionCount);
  addOptionalInteger(attributes, "provider_job_count", input.providerJobCount);
  addOptionalInteger(attributes, "residual_count", input.residualCount);
  addOptional(attributes, "provider_name", input.providerName?.trim().slice(0, 160));
  if (input.retryable !== undefined) attributes.retryable = input.retryable;
  addOptionalInteger(attributes, "latency_ms", input.latencyMs);
  addOptional(attributes, "error_code", boundedErrorCode(input.errorCode));
  return buildMemoryEvent({
    input,
    recordId: `memory:deletion:${deletionId}:${input.status}:${attemptCount}:${scopeKey}`,
    contractName: "agent.memory.deletion@2",
    subject: `memory-deletion:${deletionId}`,
    occurredAt: input.occurredAt,
    attributes,
    idempotencyKey: `agent-platform:memory:deletion:${deletionId}:${input.status}:${attemptCount}:${scopeKey}`,
  });
}

export async function enqueueMemoryLifecycleEvent(client: PoolClient, input: MemoryLifecycleAnalyticsInput): Promise<void> {
  await enqueueOutbox(client, buildMemoryLifecycleEvent(input));
}

export async function enqueueMemoryRetrievalEvent(client: PoolClient, input: MemoryRetrievalAnalyticsInput): Promise<void> {
  await enqueueOutbox(client, buildMemoryRetrievalEvent(input));
}

export async function enqueueMemoryProjectionEvent(client: PoolClient, input: MemoryProjectionAnalyticsInput): Promise<void> {
  await enqueueOutbox(client, buildMemoryProjectionEvent(input));
}

export async function enqueueMemoryDeletionEvent(client: PoolClient, input: MemoryDeletionAnalyticsInput): Promise<void> {
  await enqueueOutbox(client, buildMemoryDeletionEvent(input));
}

function buildMemoryEvent(input: {
  input: Pick<MemoryAnalyticsScopeInput, "organizationId"> & { correlationId?: string | null; causationId?: string | null };
  recordId: string;
  contractName: `agent.memory.${"lifecycle" | "retrieval" | "projection"}@1` | "agent.memory.deletion@2";
  subject: string;
  occurredAt: Date | string;
  attributes: JsonObject;
  idempotencyKey: string;
}): AnalyticsOutboxRecord {
  return buildEvent({
    recordId: input.recordId,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${required(input.input.organizationId, "organizationId")}:memory`,
    contractName: input.contractName,
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.input.organizationId,
    subject: input.subject,
    occurredAt: input.occurredAt,
    attributes: input.attributes,
    correlationId: input.input.correlationId ?? undefined,
    causationId: input.input.causationId ?? undefined,
    idempotencyKey: input.idempotencyKey,
  });
}

function inferDeletionScopeResolution(input: MemoryDeletionAnalyticsInput): MemoryDeletionScopeResolution {
  return input.workspaceId && input.agentDefinitionId && input.installationId ? "installation" : "organization_aggregate";
}

function validateDeletionScope(input: MemoryDeletionAnalyticsInput, resolution: MemoryDeletionScopeResolution): void {
  const hasInstallationScope = Boolean(input.workspaceId && input.agentDefinitionId && input.installationId);
  if (resolution === "installation" && !hasInstallationScope) {
    throw new Error("Memory deletion analytics installation scope is incomplete");
  }
  if (resolution === "organization_aggregate" && hasInstallationScope) {
    throw new Error("Memory deletion analytics aggregate scope cannot include installation identifiers");
  }
}

function scopeAttributes(input: MemoryAnalyticsScopeInput): JsonObject {
  return {
    workspace_id: required(input.workspaceId, "workspaceId"),
    agent_definition_id: required(input.agentDefinitionId, "agentDefinitionId"),
    agent_version_id: input.agentVersionId === undefined || input.agentVersionId === null ? null : required(input.agentVersionId, "agentVersionId"),
    installation_id: required(input.installationId, "installationId"),
  };
}

function firstId(...values: Array<string | null | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Memory analytics requires ${field}`);
  return normalized;
}

function timestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Memory analytics requires a valid occurredAt");
  return date.toISOString();
}

function nonNegativeInteger(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveInteger(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

function addOptionalInteger(target: JsonObject, key: string, value: number | undefined | null): void {
  if (value !== undefined && value !== null) target[key] = nonNegativeInteger(value);
}

function addOptional(target: JsonObject, key: string, value: string | null | undefined): void {
  if (value !== undefined && value !== null && value.trim().length > 0) target[key] = value;
}

function boundedReason(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 120);
  return normalized || undefined;
}

function boundedErrorCode(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase().replace(/[^A-Z0-9_.-]/g, "_").slice(0, 120);
  return normalized && /^[A-Z]/.test(normalized) ? normalized : undefined;
}

function normalizedDigest(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
