import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type {
  MemoryEvidencePack,
  MemoryRetrievalPort as RuntimeMemoryRetrievalPort,
  MemoryRetrievalRequest as RuntimeMemoryRetrievalRequest,
  MemoryRuntimeScope,
} from "../runtime/context-memory-boundary";
import { buildRetrievalPlan, rankEvidencePack, type RetrievalIntent } from "./retrieval-planner";
import type { MemoryScope } from "./contracts";
import { MemoryRevisionRetrievalRepository } from "../db/repositories/memory-revision-retrieval-repository";
import { MemoryRetrievalDecisionRepository } from "../db/repositories/memory-retrieval-decision-repository";
import type { MemoryRetentionRepository } from "../db/repositories/memory-retention-repository";
import { createEnvironmentEmbeddingProvider, embedSafely, type EmbeddingProvider } from "./embeddings";
import { withTransaction } from "../db/pool";
import { enqueueMemoryRetrievalEvent } from "../analytics/memory";
import { operationalLogger } from "../telemetry/logger";

const intents = new Set<RetrievalIntent>([
  "none",
  "current_fact",
  "historical_episode",
  "semantic_context",
  "procedural",
  "all_memory",
]);

function intentFromReason(reason: string): RetrievalIntent {
  const normalized = reason.trim() as RetrievalIntent;
  if (!intents.has(normalized)) {
    throw Object.assign(new Error("Memory retrieval requires a typed intent"), { code: "MEMORY_RETRIEVAL_INTENT_REQUIRED" });
  }
  return normalized;
}

function scopeFromRuntime(scope: MemoryRuntimeScope): MemoryScope {
  const namespace = scope.namespace.trim();
  if (namespace !== "conversation" && namespace !== "end_user_private" && namespace !== "workspace_shared" && namespace !== "agent_private") {
    throw Object.assign(new Error("Memory retrieval namespace is not supported by the runtime seam"), { code: "MEMORY_SCOPE_INVALID" });
  }
  if (!scope.workspaceId?.trim()) throw Object.assign(new Error("Memory retrieval requires workspace scope"), { code: "MEMORY_SCOPE_MISSING" });
  const readableNamespaces = (scope.readableNamespaces ?? [namespace]).map((value) => value.trim()).filter((value): value is MemoryScope["namespace"] =>
    value === "conversation"
    || value === "end_user_private"
    || value === "workspace_shared"
    || value === "agent_private"
    || value === "procedural"
    || value === "knowledge",
  );
  if (!readableNamespaces || readableNamespaces.length === 0) {
    throw Object.assign(new Error("Memory retrieval namespace policy is empty"), { code: "MEMORY_POLICY_NAMESPACE_EMPTY" });
  }
  return {
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    agentDefinitionId: scope.agentDefinitionId,
    agentVersionId: scope.agentVersionId,
    installationId: scope.installationId,
    ...(scope.conversationId ? { conversationId: scope.conversationId } : {}),
    ...(scope.endUserId ? { endUserId: scope.endUserId } : {}),
    namespace,
    ...(readableNamespaces?.length ? { readableNamespaces: [...new Set(readableNamespaces)] } : {}),
  } as MemoryScope;
}

function packId(request: RuntimeMemoryRetrievalRequest): string {
  return `memory-pack:${createHash("sha256").update(JSON.stringify({
    runId: request.runId,
    turnId: request.turnId,
    attemptId: request.attemptId,
    generation: request.compactionGeneration,
    sourceBoundary: request.sourceEventBoundary.digest,
    reason: request.reason,
    query: request.query,
  })).digest("hex").slice(0, 32)}`;
}

/** Runtime adapter: typed planning and scope enforcement live behind one port. */
export function createRuntimeMemoryRetrievalPort(
  repository: MemoryRevisionRetrievalRepository,
  quality?: MemoryRetentionRepository,
  embeddingProvider: EmbeddingProvider | undefined = createEnvironmentEmbeddingProvider(),
  decisions?: MemoryRetrievalDecisionRepository,
  analyticsPool?: Pool,
): RuntimeMemoryRetrievalPort {
  return {
    async retrieve(request): Promise<MemoryEvidencePack> {
      const started = performance.now();
      const id = packId(request);
      let scope: MemoryScope | undefined;
      let intent: RetrievalIntent;
      try {
        scope = scopeFromRuntime(request.scope);
        intent = intentFromReason(request.reason);
      } catch (error) {
        const blockedPack: MemoryEvidencePack = {
          packId: id,
          status: "blocked",
          evidence: [],
          blockedReason: error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : error instanceof Error ? error.message : "MEMORY_RETRIEVAL_BLOCKED",
        };
        const blockedScope = scope;
        if (analyticsPool && blockedScope) {
          const errorCode = blockedPack.blockedReason ?? "MEMORY_RETRIEVAL_BLOCKED";
          try {
            await withTransaction(analyticsPool, (client) => enqueueMemoryRetrievalEvent(client, {
              organizationId: blockedScope.organizationId,
              workspaceId: blockedScope.workspaceId,
              agentDefinitionId: blockedScope.agentDefinitionId,
              agentVersionId: blockedScope.agentVersionId,
              installationId: blockedScope.installationId,
              ...(blockedScope.conversationId ? { conversationId: blockedScope.conversationId } : {}),
              ...(blockedScope.endUserId ? { endUserId: blockedScope.endUserId } : {}),
              retrievalId: id,
              runId: request.runId,
              turnId: request.turnId,
              attemptId: request.attemptId,
              sourceBoundaryDigest: request.sourceEventBoundary.digest,
              query: request.query,
              decision: "requested",
              status: "blocked",
              freshness: "any",
              memoryKinds: ["semantic"],
              reasonCode: errorCode,
              plannerVersion: "typed-v1",
              candidateCount: 0,
              evidenceCount: 0,
              selectedCount: 0,
              measuredTokens: 0,
              maxTokens: request.maxEvidenceTokens ?? 1_600,
              latencyMs: Math.max(0, Math.round(performance.now() - started)),
              ...(request.gate ? {
                gateSource: request.gate.source === "small_model" ? "model" as const : "heuristic" as const,
                gateModel: request.gate.model,
                gateConfidence: request.gate.confidence,
                gateLatencyMs: request.gate.latencyMs,
              } : {}),
              scopeRejection: errorCode.includes("SCOPE") || errorCode.includes("POLICY"),
              errorCode,
              occurredAt: new Date(),
            }));
          } catch (analyticsError) {
            operationalLogger.warn({
              event: "memory.retrieval.analytics.enqueue.failed",
              error_code: analyticsError instanceof Error && "code" in analyticsError && typeof analyticsError.code === "string" ? analyticsError.code : "MEMORY_ANALYTICS_ENQUEUE_FAILED",
            }, "Memory retrieval blocked analytics enqueue failed");
          }
        }
        return blockedPack;
      }
      const resolvedScope = scope;
      if (!resolvedScope) throw Object.assign(new Error("Memory retrieval scope was not resolved"), { code: "MEMORY_SCOPE_MISSING" });
      const plan = buildRetrievalPlan({
        scope: resolvedScope,
        query: request.query,
        intent,
        reason: request.reason,
        readableNamespaces: resolvedScope.readableNamespaces,
        maxTokens: request.maxEvidenceTokens,
      });
      const queryEmbedding = await embedSafely(embeddingProvider, [plan.query]);
      const candidates = await repository.search({
        organizationId: resolvedScope.organizationId,
        workspaceId: resolvedScope.workspaceId,
        agentDefinitionId: resolvedScope.agentDefinitionId,
        agentVersionId: resolvedScope.agentVersionId,
        installationId: resolvedScope.installationId,
        conversationId: resolvedScope.conversationId,
        endUserId: resolvedScope.endUserId,
        memoryKinds: plan.memoryKinds,
        query: plan.query,
        queryEmbedding: queryEmbedding?.[0],
        freshness: plan.freshness,
        readableNamespaces: plan.readableNamespaces,
        limit: plan.maxResults * 4,
      });
      const ranked = rankEvidencePack(plan, candidates);
      const diagnostics = {
        plannerVersion: plan.plannerVersion,
        candidateCount: candidates.length,
        selectedRevisionIds: ranked.items.map((item) => item.revisionId),
        rejectedReasons: [
          ...(candidates.length === 0 ? ["no_authorized_visible_candidates"] : []),
          ...(ranked.items.length < candidates.length ? ["result_or_token_budget"] : []),
        ],
        measuredTokens: ranked.measuredTokens,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
      } as const;
      if (decisions) {
        await decisions.record({
          organizationId: resolvedScope.organizationId,
          workspaceId: resolvedScope.workspaceId,
          agentDefinitionId: resolvedScope.agentDefinitionId,
          agentVersionId: resolvedScope.agentVersionId,
          installationId: resolvedScope.installationId,
          ...(resolvedScope.conversationId ? { conversationId: resolvedScope.conversationId } : {}),
          ...(resolvedScope.endUserId ? { endUserId: resolvedScope.endUserId } : {}),
          runId: request.runId,
          turnId: request.turnId,
          attemptId: request.attemptId,
          sourceBoundaryDigest: request.sourceEventBoundary.digest,
          query: plan.query,
          plan,
          gate: request.gate,
          selectedRevisionIds: diagnostics.selectedRevisionIds,
          rejectedReasons: diagnostics.rejectedReasons,
          status: "completed",
          measuredTokens: diagnostics.measuredTokens,
          candidateCount: diagnostics.candidateCount,
          evidenceCount: ranked.items.length,
          latencyMs: diagnostics.latencyMs,
        });
      }
      if (analyticsPool) {
        try {
          await withTransaction(analyticsPool, (client) => enqueueMemoryRetrievalEvent(client, {
            organizationId: resolvedScope.organizationId,
            workspaceId: resolvedScope.workspaceId,
            agentDefinitionId: resolvedScope.agentDefinitionId,
            agentVersionId: resolvedScope.agentVersionId,
            installationId: resolvedScope.installationId,
            ...(resolvedScope.conversationId ? { conversationId: resolvedScope.conversationId } : {}),
            ...(resolvedScope.endUserId ? { endUserId: resolvedScope.endUserId } : {}),
            retrievalId: id,
            runId: request.runId,
            turnId: request.turnId,
            attemptId: request.attemptId,
            sourceBoundaryDigest: request.sourceEventBoundary.digest,
            query: plan.query,
            decision: plan.decision,
            status: "completed",
            freshness: plan.freshness,
            memoryKinds: plan.memoryKinds,
            reasonCode: plan.reason,
            plannerVersion: plan.plannerVersion,
            candidateCount: diagnostics.candidateCount,
            evidenceCount: ranked.items.length,
            selectedCount: ranked.items.length,
            measuredTokens: diagnostics.measuredTokens,
            maxTokens: plan.maxTokens,
            latencyMs: diagnostics.latencyMs,
            ...(request.gate ? {
              gateSource: request.gate.source === "small_model" ? "model" as const : "heuristic" as const,
              gateModel: request.gate.model,
              gateConfidence: request.gate.confidence,
              gateLatencyMs: request.gate.latencyMs,
            } : {}),
            occurredAt: new Date(),
          }));
        } catch (error) {
          operationalLogger.warn({
            event: "memory.retrieval.analytics.enqueue.failed",
            error_code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "MEMORY_ANALYTICS_ENQUEUE_FAILED",
          }, "Memory retrieval analytics enqueue failed");
        }
      }
      if (quality && ranked.items.length) {
        await Promise.allSettled(ranked.items.map((item) => quality.recordQualityEvent({
          organizationId: resolvedScope.organizationId,
          workspaceId: resolvedScope.workspaceId,
          agentDefinitionId: resolvedScope.agentDefinitionId,
          installationId: resolvedScope.installationId,
          ...(resolvedScope.conversationId ? { conversationId: resolvedScope.conversationId } : {}),
          ...(resolvedScope.endUserId ? { endUserId: resolvedScope.endUserId } : {}),
          revisionId: item.revisionId,
          eventType: "usage",
          actorType: "agent",
          actorId: resolvedScope.agentDefinitionId,
          sourceRunId: request.runId,
          sourceDigest: createHash("sha256").update(`${id}:${item.revisionId}`).digest("hex"),
          idempotencyKey: `memory-usage:${request.runId}:${request.turnId}:${item.revisionId}`,
        })));
      }
      return {
        packId: id,
        status: "completed",
        diagnostics,
        evidence: ranked.items.map((item) => ({
          evidenceId: item.revisionId,
          scope: item.scope,
          provenance: {
            sourceEventIds: item.sources.map((source) => source.sourceEventId),
            sourceRevisionId: item.revisionId,
          },
          validity: {
            ...(item.validFrom ? { validFrom: item.validFrom } : {}),
            ...(item.validTo ? { validTo: item.validTo } : {}),
          },
          lifecycleState: "active" as const,
          retrievalReason: item.selectionReason,
          score: item.score,
          redactedContent: item.text,
          ...(item.relations?.length ? { relations: item.relations } : {}),
        })),
      };
    },
  };
}
