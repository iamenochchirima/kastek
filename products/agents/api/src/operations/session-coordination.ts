import {
  DurableOperationCoordinator,
  fingerprintOperationRequest,
  type DurableOperationRecord,
} from "./durable-operation";
import type {
  SessionLeaseAcquireInput,
  SessionLeaseAcquireResult,
  SessionLeaseMutationInput,
  SessionLeaseMutationResult,
  SessionLeaseRepository,
} from "../db/repositories/session-lease-repository";
import type {
  SessionQueueMetrics,
  SessionQueueObserver,
} from "../runtime/session-ownership";

type SessionOperationResult = SessionLeaseAcquireResult | SessionLeaseMutationResult;

function receipt<T extends SessionOperationResult>(operation: DurableOperationRecord): T {
  const value = operation.responseReceipt?.result;
  if (!value || typeof value !== "object" || typeof (value as { outcome?: unknown }).outcome !== "string") {
    throw new Error("SESSION_OPERATION_RECEIPT_INVALID");
  }
  return value as T;
}

/**
 * Coordinates session lease mutations through the same durable operation
 * lifecycle used by MCP, plugins, delivery, and child work. The lease table
 * remains the authority for ownership; this class makes retries and worker
 * loss observable without moving lease locking into application memory.
 */
export class DurableSessionOperationCoordinator {
  public constructor(
    private readonly operations: DurableOperationCoordinator,
    private readonly leases: SessionLeaseRepository,
    private readonly queueObserver?: SessionQueueObserver,
  ) {}

  public async acquire(input: SessionLeaseAcquireInput): Promise<SessionLeaseAcquireResult> {
    const existingLease = await this.leases.current(input);
    const leaseIsCurrent = existingLease?.status === "active"
      && Date.parse(existingLease.expires_at) > Date.now();
    const staleOwnerCount = existingLease?.status === "active" && !leaseIsCurrent ? 1 : 0;
    const leaseEpoch = existingLease?.fencing_token ?? "0";
    const operationKey = `session:${input.sessionKey}:admit:${input.runId}:${leaseEpoch}:${leaseIsCurrent ? "active" : "reacquire"}`;
    const prepared = await this.operations.prepare({
      organizationId: input.organizationId,
      runId: input.runId,
      sessionKey: input.sessionKey,
      kind: "session",
      operationKey,
      requestFingerprint: fingerprintOperationRequest(input),
      metadata: { action: "admit", ownerId: input.ownerId, leaseEpoch, leaseIsCurrent },
    });
    if (prepared.outcome === "completed") {
      const result = receipt<SessionLeaseAcquireResult>(prepared.operation);
      this.observe("admission", input.sessionKey, result.outcome === "acquired" ? "accepted" : "queued", this.metrics(staleOwnerCount));
      return result;
    }
    if (prepared.outcome === "unknown") {
      // The lease table is authoritative and can safely reconcile an
      // interrupted admission after the previous worker has disappeared.
      const result = await this.leases.acquire(input);
      if (result.outcome === "busy") {
        await this.operations.fail({
          operationId: prepared.operation.id,
          error: { code: "SESSION_BUSY", message: "Session is owned by another run", retryable: true },
        });
      } else {
        await this.operations.reconcile({ operationId: prepared.operation.id, outcome: "completed", responseReceipt: { result } });
      }
      this.observe("admission", input.sessionKey, result.outcome === "acquired" ? "accepted" : "queued", this.metrics(staleOwnerCount), result.outcome === "busy" ? "SESSION_BUSY" : undefined);
      return result;
    }
    if (prepared.outcome === "in_progress") {
      const result = await this.leases.acquire(input);
      if (result.outcome === "busy") {
        this.observe("admission", input.sessionKey, "queued", this.metrics(staleOwnerCount), "SESSION_BUSY");
        return result;
      }
      const current = await this.operations.get(prepared.operation.id);
      if (current?.status === "running") {
        await this.operations.complete({ operationId: prepared.operation.id, responseReceipt: { result } });
      } else {
        await this.operations.markRunning({ operationId: prepared.operation.id });
        await this.operations.complete({ operationId: prepared.operation.id, responseReceipt: { result } });
      }
      this.observe("admission", input.sessionKey, "accepted", this.metrics(staleOwnerCount));
      return result;
    }

    await this.operations.markRunning({ operationId: prepared.operation.id });
    try {
      const result = await this.leases.acquire(input);
      if (result.outcome === "busy") {
        // A busy admission is retryable, not a terminal completed result.
        await this.operations.fail({
          operationId: prepared.operation.id,
          error: { code: "SESSION_BUSY", message: "Session is owned by another run", retryable: true },
        });
        this.observe("admission", input.sessionKey, "queued", this.metrics(staleOwnerCount), "SESSION_BUSY");
        return result;
      }
      await this.operations.complete({ operationId: prepared.operation.id, responseReceipt: { result } });
      this.observe("admission", input.sessionKey, "accepted", this.metrics(staleOwnerCount));
      return result;
    } catch (error) {
      await this.operations.markUnknown({
        operationId: prepared.operation.id,
        error: { code: "SESSION_ADMISSION_OUTCOME_UNKNOWN", message: error instanceof Error ? error.message : "Session admission outcome is unknown" },
      });
      throw error;
    }
  }

  public heartbeat(input: SessionLeaseMutationInput): Promise<SessionLeaseMutationResult> {
    return this.mutate("heartbeat", input, () => this.leases.heartbeat(input));
  }

  public release(input: SessionLeaseMutationInput): Promise<SessionLeaseMutationResult> {
    return this.mutate("release", input, () => this.leases.release(input));
  }

  private async mutate(
    action: "heartbeat" | "release",
    input: SessionLeaseMutationInput,
    operation: () => Promise<SessionLeaseMutationResult>,
  ): Promise<SessionLeaseMutationResult> {
    const timeBucket = Math.floor(Date.now() / 30_000);
    const operationKey = `session:${input.sessionKey}:${action}:${input.runId}:${input.fencingToken}:${timeBucket}`;
    const prepared = await this.operations.prepare({
      organizationId: input.organizationId,
      runId: input.runId,
      sessionKey: input.sessionKey,
      kind: "session",
      operationKey,
      requestFingerprint: fingerprintOperationRequest({ ...input, action, timeBucket }),
      metadata: { action, ownerId: input.ownerId },
    });
    if (prepared.outcome === "completed") {
      const result = receipt<SessionLeaseMutationResult>(prepared.operation);
      this.observe(action, input.sessionKey, result.outcome === "renewed" || result.outcome === "released" || result.outcome === "already_released" ? "accepted" : "rejected", this.metrics(), result.outcome === "rejected" ? result.reason : undefined);
      return result;
    }
    if (prepared.outcome === "unknown") {
      const result = await operation();
      await this.operations.reconcile({ operationId: prepared.operation.id, outcome: "completed", responseReceipt: { result } });
      this.observe(action, input.sessionKey, result.outcome === "rejected" ? "rejected" : "accepted", this.metrics(), result.outcome === "rejected" ? result.reason : undefined);
      return result;
    }
    if (prepared.outcome === "in_progress") {
      const result = await operation();
      const current = await this.operations.get(prepared.operation.id);
      if (current?.status === "running") {
        await this.operations.complete({ operationId: prepared.operation.id, responseReceipt: { result } });
      }
      this.observe(action, input.sessionKey, result.outcome === "rejected" ? "rejected" : "accepted", this.metrics(), result.outcome === "rejected" ? result.reason : undefined);
      return result;
    }

    await this.operations.markRunning({ operationId: prepared.operation.id });
    try {
      const result = await operation();
      await this.operations.complete({ operationId: prepared.operation.id, responseReceipt: { result } });
      this.observe(action, input.sessionKey, result.outcome === "rejected" ? "rejected" : "accepted", this.metrics(), result.outcome === "rejected" ? result.reason : undefined);
      return result;
    } catch (error) {
      await this.operations.markUnknown({
        operationId: prepared.operation.id,
        error: { code: `SESSION_${action.toUpperCase()}_OUTCOME_UNKNOWN`, message: error instanceof Error ? error.message : "Session mutation outcome is unknown" },
      });
      throw error;
    }
  }

  private metrics(staleOwnerCount = 0): SessionQueueMetrics {
    // The durable queue is owned by the run/session persistence layer. This
    // coordinator must not invent an in-memory depth, but it can still expose
    // lease-staleness and leave queue fields absent until that layer supplies
    // them.
    return { staleOwnerCount };
  }

  private observe(event: "admission" | "heartbeat" | "release", sessionKey: string, outcome: "accepted" | "queued" | "rejected", metrics: SessionQueueMetrics, reasonCode?: string): void {
    if (!this.queueObserver) return;
    try {
      this.queueObserver({
        event,
        sessionKey,
        outcome,
        ...(reasonCode ? { reasonCode } : {}),
        metrics,
      });
    } catch {
      // Observability must never alter durable lease semantics.
    }
  }
}
