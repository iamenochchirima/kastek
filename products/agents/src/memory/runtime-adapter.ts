import type {
  MemoryCheckpointPort as RuntimeMemoryCheckpointPort,
  MemoryCheckpointRequest as RuntimeMemoryCheckpointRequest,
  MemoryCheckpointResult as RuntimeMemoryCheckpointResult,
} from "../runtime/context-memory-boundary";
import {
  createEvidenceItem,
  evidenceDigest,
  type MemoryCheckpointRequest,
  type MemoryEvidenceEnvelope,
} from "./contracts";
import { MemoryCheckpointRepository } from "../db/repositories/memory-checkpoint-repository";

function actorForRole(role: string): "end_user" | "agent" | "tool" | "operator" | "system" {
  if (role === "user") return "end_user";
  if (role === "assistant") return "agent";
  if (role === "tool") return "tool";
  if (role === "system") return "system";
  return "operator";
}

/** Convert the runtime's redacted boundary to the canonical memory envelope. */
export function toMemoryCheckpointRequest(request: RuntimeMemoryCheckpointRequest): MemoryCheckpointRequest {
  const workspaceId = request.scope.workspaceId?.trim();
  const agentVersionId = request.scope.agentVersionId.trim();
  if (!workspaceId || !agentVersionId) {
    throw Object.assign(new Error("Memory checkpoint requires workspace and agent-version scope"), { code: "MEMORY_CHECKPOINT_SCOPE_MISSING" });
  }
  const items = request.directEvidence.items.map((item) => createEvidenceItem({
    id: item.sourceEventId,
    actor: actorForRole(item.role),
    occurredAt: new Date().toISOString(),
    sourceType: item.role === "tool" ? "tool_result" : "message",
    rawContent: item.redactedContent ?? "",
    ...(item.redactedContent === undefined ? { includeContent: false } : {}),
  }));
  const evidence: MemoryEvidenceEnvelope = {
    contractVersion: "memory-v2",
    scope: {
      organizationId: request.scope.organizationId,
      workspaceId,
      agentDefinitionId: request.scope.agentDefinitionId,
      agentVersionId,
      installationId: request.scope.installationId,
      ...(request.scope.conversationId ? { conversationId: request.scope.conversationId } : {}),
      ...(request.scope.endUserId ? { endUserId: request.scope.endUserId } : {}),
    },
    sourceEventIds: [...request.sourceEventBoundary.eventIds],
    items,
    evidenceDigest: evidenceDigest(items),
    redaction: "content_redacted",
    capturedAt: new Date().toISOString(),
  };
  return {
    scope: evidence.scope,
    runId: request.runId,
    turnId: request.turnId,
    compactionGeneration: request.compactionGeneration,
    sourceBoundary: request.sourceEventBoundary.digest,
    evidence,
    idempotencyKey: `memory-checkpoint:${request.runId}:${request.turnId}:${request.compactionGeneration}:${request.sourceEventBoundary.digest}`,
  };
}

export function createRuntimeMemoryCheckpointPort(repository: MemoryCheckpointRepository): RuntimeMemoryCheckpointPort {
  return {
    async checkpoint(request): Promise<RuntimeMemoryCheckpointResult> {
      const receipt = await repository.commit(toMemoryCheckpointRequest(request));
      return { status: receipt.status, checkpointId: receipt.checkpointId };
    },
  };
}
