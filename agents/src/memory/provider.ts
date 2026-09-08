import type { MemoryEvidencePack, MemoryRetrievalPlan, MemoryRevision } from "./contracts";
import type {
  MemoryProjectionApplyResult,
  MemoryProjectionOperation,
} from "../db/repositories/memory-projection-repository";

/**
 * Provider boundary for semantic/vector/temporal stores. Canonical commits do
 * not depend on a provider being online: providers acknowledge accepted,
 * indexed, and visible independently and can be rebuilt from revisions.
 */
export interface MemoryProviderProjection {
  revisionId: string;
  operation: "upsert" | "delete";
  acceptedAt: string;
  indexedAt?: string;
  visibleAt?: string;
  providerReceipt?: string;
}

export interface MemoryProvider {
  readonly name: string;
  readonly version: string;
  upsert(revision: MemoryRevision): Promise<MemoryProviderProjection>;
  delete(revisionId: string, scope: MemoryRevision["scope"]): Promise<MemoryProviderProjection>;
  retrieve(plan: MemoryRetrievalPlan): Promise<MemoryEvidencePack>;
  health(): Promise<{ available: boolean; latencyMs?: number; reason?: string }>;
}

export interface MemoryProviderFailure {
  provider: string;
  operation: "upsert" | "delete" | "retrieve" | "health";
  retryable: boolean;
  code: string;
  occurredAt: string;
}

/**
 * Validate the provider acknowledgement before it can advance a projection
 * readiness row.  A provider adapter is not allowed to collapse accepted,
 * indexed, visible, and deleted into one successful response: those states
 * drive retrieval eligibility and deletion completion independently.
 *
 * This is deliberately a small, provider-neutral contract check.  Real
 * adapters still need their own conformance tests against their API, but a
 * malformed adapter response cannot make canonical memory appear visible or
 * deleted by accident.
 */
export function assertMemoryProviderProjectionResult(
  operation: MemoryProjectionOperation,
  result: MemoryProjectionApplyResult,
): void {
  if (!result || typeof result !== "object") {
    throw new Error("MEMORY_PROVIDER_RESULT_INVALID");
  }

  const providerState = result.providerState;
  if (operation === "delete") {
    if (result.readiness !== "deleted" || providerState !== "deleted") {
      throw new Error("MEMORY_PROVIDER_DELETE_RESULT_INVALID");
    }
    return;
  }

  if (!providerState || !["accepted", "indexed", "visible"].includes(providerState)) {
    throw new Error("MEMORY_PROVIDER_STATE_MISSING");
  }
  if (result.readiness !== providerState) {
    throw new Error("MEMORY_PROVIDER_READINESS_STATE_MISMATCH");
  }
  if (typeof result.providerRecordId !== "string" || !result.providerRecordId.trim()) {
    throw new Error("MEMORY_PROVIDER_RECORD_ID_MISSING");
  }
}

/** Provider errors are data, not a reason to roll back canonical memory. */
export function classifyMemoryProviderError(error: unknown, operation: MemoryProviderFailure["operation"], provider: string): MemoryProviderFailure {
  const message = error instanceof Error ? error.message : "Memory provider failed";
  const code = message.trim().replace(/[^A-Za-z0-9_.-]+/gu, "_").slice(0, 120) || "MEMORY_PROVIDER_FAILED";
  const retryable = !/AUTH|FORBIDDEN|INVALID|SCHEMA|NOT_FOUND|UNSUPPORTED/iu.test(message);
  return { provider, operation, retryable, code, occurredAt: new Date().toISOString() };
}
