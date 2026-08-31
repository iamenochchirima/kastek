import { MemoryRepository, type MemoryNamespace, type MemoryRecord, type MemoryScope, type MemoryType } from "../db/repositories/memory-repository";
import { memoryPolicyFromAgentPolicy, type MemoryPolicy } from "./policy";

export interface RememberInput {
  namespace: MemoryNamespace;
  memoryType: MemoryType;
  canonicalText: string;
  content?: Record<string, unknown>;
  sensitivity?: "normal" | "sensitive" | "restricted";
  ownerUserId?: string;
  expiresAt?: string | null;
}

export class MemoryLifecycle {
  public constructor(private readonly repository: MemoryRepository) {}

  public policy(value: unknown): MemoryPolicy {
    return memoryPolicyFromAgentPolicy(value);
  }

  public async search(scope: MemoryScope, query: string, policyValue: unknown, requestedLimit?: number): Promise<MemoryRecord[]> {
    const policy = this.policy(policyValue);
    if (policy.mode === "disabled" || policy.maxRetrieved === 0 || !query.trim()) return [];
    if (policy.readableNamespaces.length === 0) return [];
    const limit = requestedLimit === undefined ? policy.maxRetrieved : Math.min(policy.maxRetrieved, Math.max(1, Math.min(50, Math.trunc(requestedLimit))));
    const records = await this.repository.searchMemory(scope, query.slice(0, 4_000), limit, policy.readableNamespaces);
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
      allowInferred: false,
      allowProceduralInference: false,
    });
  }
}
