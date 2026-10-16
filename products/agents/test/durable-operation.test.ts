import { describe, expect, it } from "vitest";
import {
  DurableOperationConflict,
  DurableOperationCoordinator,
  InMemoryDurableOperationStore,
  fingerprintOperationRequest,
} from "../src/operations/durable-operation";

describe("durable operation coordinator", () => {
  it("replays completed operations and refuses a changed request", async () => {
    const coordinator = new DurableOperationCoordinator(new InMemoryDurableOperationStore());
    const identity = {
      organizationId: "org-1",
      runId: "run-1",
      kind: "mcp" as const,
      operationKey: "run-1:tool-1",
      requestFingerprint: fingerprintOperationRequest({ tool: "search", query: "hello" }),
    };
    const prepared = await coordinator.prepare(identity);
    expect(prepared.outcome).toBe("new");
    await coordinator.markRunning({ operationId: prepared.operation.id, providerRequestId: "provider-1" });
    const completed = await coordinator.complete({ operationId: prepared.operation.id, responseReceipt: { ok: true } });
    expect(completed.status).toBe("completed");
    expect((await coordinator.prepare(identity)).outcome).toBe("completed");
    await expect(coordinator.prepare({ ...identity, requestFingerprint: "different" })).rejects.toBeInstanceOf(DurableOperationConflict);
  });

  it("does not automatically retry an operation with an unknown provider outcome", async () => {
    const coordinator = new DurableOperationCoordinator(new InMemoryDurableOperationStore());
    const prepared = await coordinator.prepare({
      organizationId: "org-1",
      kind: "plugin",
      operationKey: "plugin-1",
      requestFingerprint: "fp-1",
    });
    await coordinator.markRunning({ operationId: prepared.operation.id });
    await coordinator.markUnknown({ operationId: prepared.operation.id, error: { code: "WORKER_LOST", message: "Worker stopped" } });
    expect((await coordinator.prepare({ organizationId: "org-1", kind: "plugin", operationKey: "plugin-1", requestFingerprint: "fp-1" })).outcome).toBe("unknown");
    await expect(coordinator.markRunning({ operationId: prepared.operation.id })).rejects.toThrow("DURABLE_OPERATION_OUTCOME_UNKNOWN");
    const reconciled = await coordinator.reconcile({ operationId: prepared.operation.id, outcome: "completed", responseReceipt: { recovered: true } });
    expect(reconciled.status).toBe("completed");
  });

  it("allows failed operations to be prepared as a new attempt", async () => {
    const store = new InMemoryDurableOperationStore();
    const coordinator = new DurableOperationCoordinator(store);
    const identity = { organizationId: "org-1", kind: "context" as const, operationKey: "context-1", requestFingerprint: "fp-1" };
    const prepared = await coordinator.prepare(identity);
    await coordinator.markRunning({ operationId: prepared.operation.id });
    await coordinator.fail({ operationId: prepared.operation.id, error: { code: "TIMEOUT", message: "Timed out", retryable: true } });
    const retry = await coordinator.prepare(identity);
    expect(retry.outcome).toBe("new");
    expect(retry.operation.attempt).toBe(1);
  });
});
