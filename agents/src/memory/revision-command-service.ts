import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withTransaction } from "../db/pool";
import { query } from "../db/pool";
import { enqueueMemoryRetrievalEvent } from "../analytics/memory";
import { operationalLogger } from "../telemetry/logger";
import type { ToolInvocationContext } from "../tools/types";
import { canonicalFactKey, type MemoryScope } from "./contracts";
import { MemoryRevisionRepository } from "../db/repositories/memory-revision-repository";
import { MemoryRevisionRetrievalRepository } from "../db/repositories/memory-revision-retrieval-repository";
import { assertExpectedPredecessor, type MemoryRevisionRecord } from "./revisions";
import { buildRetrievalPlan, rankEvidencePack } from "./retrieval-planner";
import { createEnvironmentEmbeddingProvider, embedSafely } from "./embeddings";
import { memoryPolicyFromAgentPolicy } from "./policy";

type LegacyNamespace = "conversation" | "user_private" | "organization_shared" | "agent_private";
type RevisionNamespace = "conversation" | "end_user_private" | "workspace_shared" | "agent_private";

function namespaceFor(value: string): RevisionNamespace {
  switch (value as LegacyNamespace) {
    case "conversation": return "conversation";
    case "user_private": return "end_user_private";
    case "organization_shared": return "workspace_shared";
    case "agent_private": return "agent_private";
    default: throw new Error("MEMORY_NAMESPACE_NOT_ALLOWED");
  }
}

function memoryTypeFor(value: string): "semantic" | "episodic" {
  if (value === "semantic" || value === "episodic") return value;
  throw Object.assign(new Error("MEMORY_TYPE_NOT_SUPPORTED_BY_REVISION_DOMAIN"), { code: "MEMORY_TYPE_NOT_SUPPORTED_BY_REVISION_DOMAIN" });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface InstallationScopeRow { scope_id: string; }

type MemoryCommandResult = {
  id: string;
  namespace: LegacyNamespace;
  memoryType: "semantic" | "episodic";
  text: string;
  expiresAt: null;
  status: "created" | "review_pending";
  conflict?: {
    reason: "concurrent_correction";
    expectedRevisionId: string;
    observedRevisionId: string;
  };
};

/** Explicit memory command adapter for the v2 revision domain. */
export class MemoryRevisionCommandService {
  private readonly retrieval: MemoryRevisionRetrievalRepository;
  private readonly analyticsPool: Pool | undefined;

  public constructor(
    private readonly pool: Pool,
    private readonly revisions: MemoryRevisionRepository,
    options: { analyticsPool?: Pool } = {},
  ) {
    this.retrieval = new MemoryRevisionRetrievalRepository(pool);
    this.analyticsPool = options.analyticsPool;
  }

  private async workspaceId(organizationId: string, installationId: string): Promise<string> {
    const result = await query<InstallationScopeRow>(this.pool, `SELECT scope_id FROM agent_installations WHERE id = $1 AND organization_id = $2`, [installationId, organizationId]);
    const scopeId = result.rows[0]?.scope_id?.trim();
    if (!scopeId) throw Object.assign(new Error("MEMORY_SCOPE_MISSING"), { code: "MEMORY_SCOPE_MISSING" });
    return scopeId;
  }

  private async factForCommand(input: {
    context: ToolInvocationContext;
    namespace: string;
    memoryType: string;
    factKey?: string;
  }) {
    const namespace = namespaceFor(input.namespace);
    const memoryType = memoryTypeFor(input.memoryType);
    const scope = input.context.scope;
    const workspaceId = await this.workspaceId(scope.organizationId, scope.installationId);
    const subject = namespace === "conversation"
      ? `conversation:${scope.conversationId}`
      : namespace === "end_user_private"
        ? `actor:${input.context.actorId}`
        : `agent:${scope.agentDefinitionId}`;
    const predicate = input.factKey?.trim() || "explicit_memory";
    return this.revisions.findFact({
      organizationId: scope.organizationId,
      workspaceId,
      agentDefinitionId: scope.agentDefinitionId,
      installationId: scope.installationId,
      agentVersionId: scope.agentVersionId,
      ...(namespace === "conversation" ? { conversationId: scope.conversationId } : {}),
      ...(namespace === "end_user_private" ? { endUserId: input.context.actorId } : {}),
      namespace,
      memoryType,
      subjectKey: subject,
      predicateKey: predicate,
      factKey: canonicalFactKey({ organizationId: scope.organizationId, workspaceId, agentDefinitionId: scope.agentDefinitionId, installationId: scope.installationId, namespace, subject, predicate }),
    });
  }

  public async rememberExplicit(input: {
    context: ToolInvocationContext;
    namespace: string;
    memoryType: string;
    text: string;
    sensitivity?: "normal" | "sensitive" | "restricted";
    factKey?: string;
    idempotencyKey?: string;
    expectedRevisionId?: string;
  }): Promise<MemoryCommandResult> {
    const namespace = namespaceFor(input.namespace);
    const memoryType = memoryTypeFor(input.memoryType);
    const scope = input.context.scope;
    if (namespace === "conversation" && !scope.conversationId) throw new Error("CONVERSATION_SCOPE_REQUIRED");
    if (namespace === "end_user_private" && !input.context.actorId) throw new Error("END_USER_SCOPE_REQUIRED");
    const workspaceId = await this.workspaceId(scope.organizationId, scope.installationId);
    const subject = namespace === "conversation" ? `conversation:${scope.conversationId}` : namespace === "end_user_private" ? `actor:${input.context.actorId}` : `agent:${scope.agentDefinitionId}`;
    const predicate = input.factKey?.trim() || "explicit_memory";
    const fact = await this.revisions.createFact({
      organizationId: scope.organizationId,
      workspaceId,
      agentDefinitionId: scope.agentDefinitionId,
      installationId: scope.installationId,
      agentVersionId: scope.agentVersionId,
      ...(namespace === "conversation" ? { conversationId: scope.conversationId } : {}),
      ...(namespace === "end_user_private" ? { endUserId: input.context.actorId } : {}),
      namespace,
      memoryType,
      subjectKey: subject,
      predicateKey: predicate,
      factKey: canonicalFactKey({ organizationId: scope.organizationId, workspaceId, agentDefinitionId: scope.agentDefinitionId, installationId: scope.installationId, namespace, subject, predicate }),
    });
    const now = new Date().toISOString();
    const operationKey = input.idempotencyKey?.trim() || `memory-command:${scope.runId}:${digest({ namespace, memoryType, text: input.text, predicate })}`;
    const predecessor = memoryType === "semantic"
      ? await this.revisions.resolveCurrent(scope.organizationId, fact.id)
      : null;
    if (input.expectedRevisionId) assertExpectedPredecessor(input.expectedRevisionId, predecessor?.id);
    const revision = await this.revisions.appendRevision(fact.id, {
      memoryType,
      lifecycleState: "active",
      ...(predecessor ? { transitionType: "correction" as const, predecessorRevisionId: predecessor.id } : {}),
      canonicalText: input.text,
      typedValue: { text: input.text, source: "explicit" },
      ...(memoryType === "episodic" ? { eventTime: now, eventSummary: input.text } : {}),
      validFrom: now,
      observedAt: now,
      sourceTrust: "user_explicit",
      sensitivity: input.sensitivity ?? "normal",
      provenance: { source: "memory_command", sourceRunId: scope.runId, workspaceId },
      evidenceDigest: digest({ scope: scope.runId, operationKey, text: input.text }),
      extractionVersion: "explicit-v2",
      sourceEventIds: [`memory-command:${scope.runId}:${operationKey}`],
      sourceEventType: "memory.command",
      sourceRunId: scope.runId,
      sourceOccurredAt: now,
      idempotencyKey: operationKey,
      acceptedAt: now,
      createdBy: input.context.actorId ?? "system",
    }, input.expectedRevisionId);
    return { id: revision.revision.id, namespace: input.namespace as LegacyNamespace, memoryType, text: input.text, expiresAt: null, status: "created" };
  }

  /** Correct a semantic fact with an explicit compare-and-set predecessor. */
  public async correct(input: Parameters<MemoryRevisionCommandService["rememberExplicit"]>[0] & { expectedRevisionId: string }): Promise<MemoryCommandResult> {
    try {
      return await this.rememberExplicit(input);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
      if (code !== "MEMORY_STALE_EXPECTED_REVISION") throw error;

      // A losing compare-and-set correction is still useful evidence. Keep it
      // as a review-pending revision linked to the winner instead of dropping
      // the writer's proposal or allowing two active values for one fact key.
      const namespace = namespaceFor(input.namespace);
      const memoryType = memoryTypeFor(input.memoryType);
      const scope = input.context.scope;
      const workspaceId = await this.workspaceId(scope.organizationId, scope.installationId);
      const fact = await this.factForCommand(input);
      const current = fact ? await this.revisions.resolveCurrent(scope.organizationId, fact.id) : null;
      if (!fact || !current) throw error;
      const now = new Date().toISOString();
      const operationKey = input.idempotencyKey?.trim() || `memory-correction-conflict:${scope.runId}:${digest({ namespace, memoryType, text: input.text, expectedRevisionId: input.expectedRevisionId })}`;
      const revision = await this.revisions.appendRevision(fact.id, {
        memoryType,
        transitionType: "correction",
        lifecycleState: "review_pending",
        predecessorRevisionId: current.id,
        canonicalText: input.text,
        typedValue: { text: input.text, source: "explicit", conflict: "concurrent_correction" },
        validFrom: now,
        observedAt: now,
        sourceTrust: "user_explicit",
        sensitivity: input.sensitivity ?? "normal",
        provenance: {
          source: "memory_command",
          sourceRunId: scope.runId,
          workspaceId,
          conflictType: "concurrent_correction",
          expectedRevisionId: input.expectedRevisionId,
          observedRevisionId: current.id,
        },
        evidenceDigest: digest({ scope: scope.runId, operationKey, text: input.text, expectedRevisionId: input.expectedRevisionId, observedRevisionId: current.id }),
        extractionVersion: "explicit-v2",
        sourceEventIds: [`memory-command:${scope.runId}:${operationKey}`],
        sourceEventType: "memory.command.correct.conflict",
        sourceRunId: scope.runId,
        sourceOccurredAt: now,
        idempotencyKey: operationKey,
        acceptedAt: now,
        createdBy: input.context.actorId ?? "system",
      }, current.id);
      return {
        id: revision.revision.id,
        namespace: input.namespace as LegacyNamespace,
        memoryType,
        text: input.text,
        expiresAt: null,
        status: "review_pending",
        conflict: {
          reason: "concurrent_correction",
          expectedRevisionId: input.expectedRevisionId,
          observedRevisionId: current.id,
        },
      };
    }
  }

  /** Append a deletion transition; historical revisions remain auditable but are not readable. */
  public async forget(input: {
    context: ToolInvocationContext;
    namespace: string;
    memoryType: string;
    factKey?: string;
    expectedRevisionId?: string;
  }): Promise<{ status: "deleted" | "not_found" | "replayed"; revisionId?: string }> {
    const fact = await this.factForCommand(input);
    if (!fact) return { status: "not_found" };
    const current = await this.revisions.resolveCurrent(input.context.scope.organizationId, fact.id);
    if (!current) return { status: "not_found" };
    if (input.expectedRevisionId) assertExpectedPredecessor(input.expectedRevisionId, current.id);
    const now = new Date().toISOString();
    const result = await this.revisions.appendRevision(fact.id, {
      memoryType: current.memoryType,
      transitionType: "deletion",
      lifecycleState: "deleted",
      canonicalText: "Memory deleted",
      typedValue: { deleted: true },
      ...(current.memoryType === "episodic" ? { eventTime: current.eventTime ?? current.validFrom, eventSummary: current.eventSummary ?? "Memory deleted" } : {}),
      validFrom: now,
      observedAt: now,
      sourceTrust: "system_observed",
      sensitivity: current.sensitivity,
      provenance: { source: "memory.forget", predecessorRevisionId: current.id },
      evidenceDigest: digest({ runId: input.context.scope.runId, command: "forget", revisionId: current.id }),
      extractionVersion: "command-v2",
      sourceEventIds: [`memory-forget:${input.context.scope.runId}:${current.id}`],
      sourceEventType: "memory.command.forget",
      sourceRunId: input.context.scope.runId,
      sourceOccurredAt: now,
      predecessorRevisionId: current.id,
      idempotencyKey: `memory-forget:${input.context.scope.runId}:${current.id}`,
      createdBy: input.context.actorId ?? "system",
    }, input.expectedRevisionId ?? current.id);
    return { status: result.status === "replayed" ? "replayed" : "deleted", revisionId: result.revision.id };
  }

  private async transitionRevision(input: {
    context: ToolInvocationContext;
    revisionId: string;
    lifecycleState: "active" | "rejected";
    transitionType: "revalidation";
    command: "approve" | "reject" | "revalidate";
  }): Promise<{ status: "created" | "replayed"; revision: MemoryRevisionRecord }> {
    const scope = input.context.scope;
    const current = await this.revisions.getRevision(scope.organizationId, input.revisionId);
    if (!current) throw Object.assign(new Error("MEMORY_REVISION_NOT_FOUND"), { code: "MEMORY_REVISION_NOT_FOUND" });
    const now = new Date().toISOString();
    return this.revisions.appendRevision(current.factId, {
      memoryType: current.memoryType,
      transitionType: input.transitionType,
      lifecycleState: input.lifecycleState,
      canonicalText: current.canonicalText,
      typedValue: current.typedValue,
      ...(current.memoryType === "episodic" ? { eventTime: current.eventTime ?? current.validFrom, eventSummary: current.eventSummary ?? current.canonicalText } : {}),
      validFrom: now,
      observedAt: now,
      sourceTrust: current.sourceTrust,
      sensitivity: current.sensitivity,
      provenance: { ...current.provenance, source: `memory.${input.command}`, predecessorRevisionId: current.id },
      evidenceDigest: digest({ runId: scope.runId, command: input.command, revisionId: current.id }),
      extractionVersion: "command-v2",
      sourceEventIds: [`memory-${input.command}:${scope.runId}:${current.id}`],
      sourceEventType: `memory.command.${input.command}`,
      sourceRunId: scope.runId,
      sourceOccurredAt: now,
      predecessorRevisionId: current.id,
      idempotencyKey: `memory-${input.command}:${scope.runId}:${current.id}`,
      createdBy: input.context.actorId ?? "system",
    }, current.id);
  }

  public approve(input: { context: ToolInvocationContext; revisionId: string }) {
    return this.transitionRevision({ ...input, lifecycleState: "active", transitionType: "revalidation", command: "approve" });
  }

  public reject(input: { context: ToolInvocationContext; revisionId: string }) {
    return this.transitionRevision({ ...input, lifecycleState: "rejected", transitionType: "revalidation", command: "reject" });
  }

  public revalidate(input: { context: ToolInvocationContext; revisionId: string }) {
    return this.transitionRevision({ ...input, lifecycleState: "active", transitionType: "revalidation", command: "revalidate" });
  }

  /**
   * Operator transitions do not belong to an agent run. Keep them on the
   * same immutable revision path, but omit the optional source-run foreign
   * key and use the dual-approved command id as the idempotency boundary.
   */
  public async operatorTransition(input: {
    organizationId: string;
    revisionId: string;
    actorId: string;
    operationId: string;
    command: "approve" | "reject" | "revalidate";
    validTo?: string | null;
  }): Promise<{ status: "created" | "replayed"; revision: MemoryRevisionRecord }> {
    const organizationId = input.organizationId.trim();
    const actorId = input.actorId.trim();
    const operationId = input.operationId.trim();
    if (!organizationId || !actorId || !operationId) throw new Error("MEMORY_OPERATOR_SCOPE_REQUIRED");
    const current = await this.revisions.getRevision(organizationId, input.revisionId);
    if (!current) throw Object.assign(new Error("MEMORY_REVISION_NOT_FOUND"), { code: "MEMORY_REVISION_NOT_FOUND" });
    const now = new Date().toISOString();
    return this.revisions.appendRevision(current.factId, {
      memoryType: current.memoryType,
      transitionType: "revalidation",
      lifecycleState: input.command === "reject" ? "rejected" : "active",
      canonicalText: current.canonicalText,
      typedValue: current.typedValue,
      ...(current.memoryType === "episodic" ? { eventTime: current.eventTime ?? current.validFrom, eventSummary: current.eventSummary ?? current.canonicalText } : {}),
      validFrom: now,
      ...(input.validTo ? { validTo: input.validTo } : {}),
      observedAt: now,
      sourceTrust: current.sourceTrust,
      sensitivity: current.sensitivity,
      provenance: { ...current.provenance, source: `memory.operator.${input.command}`, predecessorRevisionId: current.id, operatorId: actorId },
      evidenceDigest: digest({ operationId, command: input.command, revisionId: current.id }),
      extractionVersion: "operator-v2",
      sourceEventIds: [`memory-operator:${input.command}:${operationId}:${current.id}`],
      sourceEventType: `memory.operator.${input.command}`,
      sourceOccurredAt: now,
      predecessorRevisionId: current.id,
      idempotencyKey: `memory-operator:${input.command}:${operationId}:${current.id}`,
      createdBy: actorId,
    }, current.id);
  }

  public async inspect(input: { context: ToolInvocationContext; revisionId: string }) {
    const revision = await this.revisions.getRevision(input.context.scope.organizationId, input.revisionId);
    if (!revision) return null;
    return { revision, relations: await this.revisions.listRelations(input.context.scope.organizationId, input.revisionId) };
  }

  public async search(input: { context: ToolInvocationContext; query: string; limit?: number; allowSensitive?: boolean }): Promise<Array<{ id: string; namespace: string; memoryType: string; text: string; sensitivity: "normal" | "sensitive" | "restricted"; confidence?: number; expiresAt: null }>> {
    const scope = input.context.scope;
    const workspaceId = await this.workspaceId(scope.organizationId, scope.installationId);
    const memoryPolicy = memoryPolicyFromAgentPolicy(input.context.memoryPolicy);
    if (memoryPolicy.mode === "disabled" || memoryPolicy.maxRetrieved === 0 || memoryPolicy.readableNamespaces.length === 0) return [];
    const legacyNamespaces = memoryPolicy.readableNamespaces;
    const readableNamespaces = legacyNamespaces.map((value) => {
      switch (value) {
        case "user_private": return "end_user_private";
        case "organization_shared": return "workspace_shared";
        default: return value;
      }
    });
    const scopeForPlan = {
      organizationId: scope.organizationId,
      workspaceId,
      agentDefinitionId: scope.agentDefinitionId,
      agentVersionId: scope.agentVersionId,
      installationId: scope.installationId,
      ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
      ...(input.context.actorId ? { endUserId: input.context.actorId } : {}),
      namespace: scope.conversationId ? "conversation" as const : "workspace_shared" as const,
      readableNamespaces: readableNamespaces as MemoryScope["namespace"][],
    };
    const plan = buildRetrievalPlan({
      scope: scopeForPlan,
      query: input.query,
      intent: "semantic_context",
      reason: "memory_search",
      maxResults: Math.min(input.limit ?? memoryPolicy.maxRetrieved, memoryPolicy.maxRetrieved),
      maxTokens: memoryPolicy.maxRetrievedTokens,
      readableNamespaces: readableNamespaces as MemoryScope["namespace"][],
    });
    const queryEmbedding = (await embedSafely(createEnvironmentEmbeddingProvider(), [plan.query]))?.[0];
    const candidates = await this.retrieval.search({
      organizationId: scope.organizationId,
      workspaceId,
      agentDefinitionId: scope.agentDefinitionId,
      agentVersionId: scope.agentVersionId,
      installationId: scope.installationId,
      conversationId: scope.conversationId,
      endUserId: input.context.actorId,
      memoryKinds: plan.memoryKinds,
      query: plan.query,
      freshness: plan.freshness,
      allowSensitive: input.allowSensitive === true && memoryPolicy.allowSensitive,
      readableNamespaces,
      queryEmbedding,
      limit: plan.maxResults * 4,
    });
    const ranked = rankEvidencePack(plan, candidates);
    await this.recordRetrievalAnalytics({
      context: input.context,
      plan,
      query: plan.query,
      candidates: candidates.length,
      selected: ranked.items.length,
      measuredTokens: ranked.measuredTokens,
      latencyMs: 0,
    });
    return ranked.items.map((candidate) => ({
      id: candidate.revisionId,
      namespace: candidate.scope.namespace,
      memoryType: candidate.kind,
      text: candidate.text,
      sensitivity: candidates.find((entry) => entry.revisionId === candidate.revisionId)?.sensitivity ?? "normal",
      ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
      expiresAt: null,
    }));
  }

  private async recordRetrievalAnalytics(input: {
    context: ToolInvocationContext;
    plan: ReturnType<typeof buildRetrievalPlan>;
    query: string;
    candidates: number;
    selected: number;
    measuredTokens: number;
    latencyMs: number;
  }): Promise<void> {
    if (!this.analyticsPool) return;
    const retrievalId = `memory-search:${digest({
      runId: input.context.runId,
      operationId: input.context.operationId,
      query: input.query,
      plannerVersion: input.plan.plannerVersion,
    }).slice(0, 32)}`;
    try {
      await withTransaction(this.analyticsPool, (client) => enqueueMemoryRetrievalEvent(client, {
        organizationId: input.context.scope.organizationId,
        workspaceId: input.plan.scope.workspaceId,
        agentDefinitionId: input.context.scope.agentDefinitionId,
        agentVersionId: input.context.scope.agentVersionId,
        installationId: input.context.scope.installationId,
        ...(input.context.scope.conversationId ? { conversationId: input.context.scope.conversationId } : {}),
        ...(input.context.actorId ? { endUserId: input.context.actorId } : {}),
        retrievalId,
        runId: input.context.runId,
        turnId: input.context.operationId ?? `${input.context.runId}:memory-search`,
        attemptId: input.context.operationId ?? `${input.context.runId}:memory-search`,
        sourceBoundaryDigest: digest(`memory-search:${input.context.runId}:${input.query}`),
        query: input.query,
        decision: input.plan.decision,
        status: "completed",
        freshness: input.plan.freshness,
        memoryKinds: input.plan.memoryKinds,
        reasonCode: input.plan.reason,
        plannerVersion: input.plan.plannerVersion,
        candidateCount: input.candidates,
        evidenceCount: input.selected,
        selectedCount: input.selected,
        measuredTokens: input.measuredTokens,
        maxTokens: input.plan.maxTokens,
        latencyMs: input.latencyMs,
        gateSource: "none",
        occurredAt: new Date(),
      }));
    } catch (error) {
      operationalLogger.warn({
        event: "memory.retrieval.analytics.enqueue.failed",
        error_code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "MEMORY_ANALYTICS_ENQUEUE_FAILED",
      }, "Memory retrieval analytics enqueue failed");
    }
  }
}
