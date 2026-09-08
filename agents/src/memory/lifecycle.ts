import { MemoryRepository } from "../db/repositories/memory-repository";
import type { MemoryNamespace, MemoryRecord, MemoryScope, MemoryType } from "./legacy-contracts";
import { memoryPolicyFromAgentPolicy, type MemoryPolicy } from "./policy";
import { recordRetrievalScopeRejection } from "../telemetry/spans";

export interface RememberInput {
  namespace: MemoryNamespace;
  memoryType: MemoryType;
  canonicalText: string;
  content?: Record<string, unknown>;
  sensitivity?: "normal" | "sensitive" | "restricted";
  ownerUserId?: string;
  expiresAt?: string | null;
  factKey?: string;
  supersedesMemoryId?: string;
}

export interface InferredMemoryInput {
  namespace: MemoryNamespace;
  memoryType: Exclude<MemoryType, "procedural">;
  canonicalText: string;
  content?: Record<string, unknown>;
  confidence?: number;
  factKey?: string;
  provenance: Record<string, unknown>;
  expiresAt?: string | null;
}

export function missingMemoryScopeRequirements(scope: MemoryScope, namespaces: readonly MemoryNamespace[]): Array<"missing_installation" | "missing_conversation" | "missing_actor"> {
  const reasons = new Set<"missing_installation" | "missing_conversation" | "missing_actor">();
  for (const namespace of namespaces) {
    if (namespace === "agent_private" && !scope.installationId) reasons.add("missing_installation");
    if (namespace === "conversation" && !scope.conversationId) reasons.add("missing_conversation");
    if (namespace === "user_private" && !scope.actorId) reasons.add("missing_actor");
  }
  return [...reasons];
}

export class MemoryLifecycle {
  public constructor(private readonly repository: MemoryRepository) {}

  public policy(value: unknown): MemoryPolicy {
    return memoryPolicyFromAgentPolicy(value);
  }

  public async search(scope: MemoryScope, query: string, policyValue: unknown, requestedLimit?: number, queryEmbedding?: readonly number[]): Promise<MemoryRecord[]> {
    const policy = this.policy(policyValue);
    if (policy.mode === "disabled" || policy.maxRetrieved === 0 || !query.trim()) return [];
    if (policy.readableNamespaces.length === 0) return [];
    for (const reason of missingMemoryScopeRequirements(scope, policy.readableNamespaces)) recordRetrievalScopeRejection(reason);
    const limit = requestedLimit === undefined ? policy.maxRetrieved : Math.min(policy.maxRetrieved, Math.max(1, Math.min(50, Math.trunc(requestedLimit))));
    const records = await this.repository.searchMemory(scope, query.slice(0, 4_000), limit, policy.readableNamespaces, queryEmbedding);
    return policy.allowSensitive ? records : records.filter((record) => record.sensitivity === "normal");
  }

  public async rememberExplicit(scope: MemoryScope, input: RememberInput, policyValue: unknown): Promise<MemoryRecord> {
    const policy = this.policy(policyValue);
    if (policy.mode === "disabled") throw new Error("MEMORY_DISABLED");
    if (!policy.writableNamespaces.includes(input.namespace)) throw new Error("MEMORY_NAMESPACE_NOT_ALLOWED");
    if (!policy.writableTypes.includes(input.memoryType)) throw new Error("MEMORY_TYPE_NOT_ALLOWED");
    if (input.sensitivity && input.sensitivity !== "normal" && !policy.allowSensitive) throw new Error("MEMORY_SENSITIVITY_NOT_ALLOWED");
    const canonicalText = input.canonicalText.trim();
    if (!canonicalText || canonicalText.length > 8_000) throw new Error("MEMORY_TEXT_INVALID");
    if (scope.runId && await this.repository.countWritesForRun(scope) >= policy.maxWritesPerRun) throw new Error("MEMORY_WRITE_LIMIT_EXCEEDED");
    const requestedExpiresAt = input.expiresAt;
    const expiresAt = requestedExpiresAt === undefined
      ? policy.retentionDays === undefined ? undefined : new Date(Date.now() + policy.retentionDays * 86_400_000).toISOString()
      : requestedExpiresAt;
    const { expiresAt: _ignoredExpiresAt, ...memoryInput } = input;
    return this.repository.createMemory({
      ...scope,
      ...memoryInput,
      canonicalText,
      sourceType: "explicit",
      provenance: scope.runId ? { sourceRunId: scope.runId } : undefined,
      ...(expiresAt === undefined || expiresAt === null ? {} : { expiresAt }),
      ...(input.factKey ? { factKey: input.factKey } : {}),
      ...(input.supersedesMemoryId ? { supersedesMemoryId: input.supersedesMemoryId } : {}),
      allowInferred: false,
      allowProceduralInference: false,
    });
  }

  public async rememberInferred(scope: MemoryScope, input: InferredMemoryInput, policyValue: unknown): Promise<MemoryRecord> {
    const policy = this.policy(policyValue);
    if (policy.mode !== "reviewed" && policy.mode !== "automatic") throw new Error("MEMORY_INFERENCE_DISABLED");
    if (!policy.writableNamespaces.includes(input.namespace)) throw new Error("MEMORY_NAMESPACE_NOT_ALLOWED");
    if (!policy.writableTypes.includes(input.memoryType)) throw new Error("MEMORY_TYPE_NOT_ALLOWED");
    const canonicalText = input.canonicalText.trim();
    if (!canonicalText || canonicalText.length > 8_000) throw new Error("MEMORY_TEXT_INVALID");
    if (scope.runId && await this.repository.countWritesForRun(scope) >= policy.maxWritesPerRun) {
      throw new Error("MEMORY_WRITE_LIMIT_EXCEEDED");
    }
    const requestedExpiresAt = input.expiresAt;
    const expiresAt = requestedExpiresAt === undefined
      ? policy.retentionDays === undefined ? undefined : new Date(Date.now() + policy.retentionDays * 86_400_000).toISOString()
      : requestedExpiresAt;
    return this.repository.createMemory({
      ...scope,
      namespace: input.namespace,
      memoryType: input.memoryType,
      canonicalText,
      content: input.content,
      confidence: input.confidence,
      factKey: input.factKey,
      sourceType: "inferred",
      provenance: {
        ...input.provenance,
        ...(scope.runId ? { sourceRunId: scope.runId } : {}),
      },
      ...(expiresAt === undefined || expiresAt === null ? {} : { expiresAt }),
      sourceTrust: "model_inferred",
      reviewRequired: true,
      allowInferred: true,
      allowProceduralInference: false,
    });
  }
}
