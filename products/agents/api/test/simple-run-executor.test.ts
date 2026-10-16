import { describe, expect, it, vi } from "vitest";
import type { RuntimeRunRecord } from "../src/db/repositories/run-repository";
import type { AgentRunActivities } from "../src/temporal/contracts";
import { SimpleRunExecutor } from "../src/runtime/simple-run-executor";
import { currentExecutionSignal } from "../src/runtime/execution-signal";

const run = (id: string, maxWallTimeMs = 5_000) => ({ id, organization_id: "org", installation_id: id,
  created_by: "user", status: "received", configuration: { executionStrategy: "simple", maxWallTimeMs } }) as RuntimeRunRecord;

function fixture(executeLoop: AgentRunActivities["executeLoop"]) {
  const transitions: Array<{ runId: string; nextStatus: string }> = [];
  const completeRun = vi.fn();
  const failRun = vi.fn();
  const activities = { executeLoop, waitForConversationTurn: async () => ({ acquired: true }),
    transitionRun: async (input: { runId: string; nextStatus: string }) => { transitions.push(input); },
    completeRun, failRun, deliverRunReply: vi.fn(), cancelHandoff: vi.fn(), cancelApprovalGroup: vi.fn(),
  } as unknown as AgentRunActivities;
  const onError = vi.fn();
  const executor = new SimpleRunExecutor({ runs: { appendEvent: vi.fn() } as never, activities, onError });
  return { executor, transitions, activities, completeRun, failRun, onError };
}

describe("simple run execution", () => {
  it("cancels one run while an unrelated run retains its own signal and completes", async () => {
    const signals = new Map<string, AbortSignal>();
    let finishOther!: () => void;
    const f = fixture(async ({ runId }) => {
      const signal = currentExecutionSignal()!;
      signals.set(runId, signal);
      await new Promise<void>(resolve => {
        if (runId === "cancel") signal.addEventListener("abort", () => resolve(), { once: true });
        else finishOther = resolve;
      });
      return { status: "completed", completionMessage: "done", usage: {}, iterations: 1, toolCalls: 0 } as never;
    });
    await f.executor.start(run("cancel"));
    await f.executor.start(run("other"));
    await vi.waitFor(() => expect(signals.size).toBe(2));
    expect(f.executor.cancel("cancel")).toBe(true);
    expect(signals.get("other")?.aborted).toBe(false);
    finishOther();
    await vi.waitFor(() => expect(f.completeRun).toHaveBeenCalledOnce());
    expect(f.completeRun.mock.calls[0]?.[0].runId).toBe("other");
    await f.executor.close();
    expect(f.transitions).toContainEqual(expect.objectContaining({ runId: "cancel", nextStatus: "cancelled" }));
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("expires a run at its deadline and never persists a late successful response", async () => {
    const f = fixture(async () => {
      await new Promise<void>(resolve => currentExecutionSignal()!.addEventListener("abort", () => resolve(), { once: true }));
      return { status: "completed", completionMessage: "late response" } as never;
    });
    await f.executor.start(run("deadline", 30));
    await vi.waitFor(() => expect(f.transitions).toContainEqual(expect.objectContaining({ nextStatus: "expired" })));
    expect(f.completeRun).not.toHaveBeenCalled();
    await f.executor.close();
  });

  it("rejects a durable wait and clears its pending approval instead of waiting indefinitely", async () => {
    const f = fixture(async () => ({ status: "awaiting_approval", pendingToolCalls: [{ approvalGroupId: "group" }] }) as never);
    await f.executor.start(run("approval"));
    await vi.waitFor(() => expect(f.failRun).toHaveBeenCalledOnce());
    expect(f.failRun.mock.calls[0]?.[0].error.code).toBe("DURABLE_EXECUTION_REQUIRED");
    expect(f.activities.cancelApprovalGroup).toHaveBeenCalledWith(expect.objectContaining({ groupId: "group" }));
    expect(f.completeRun).not.toHaveBeenCalled();
    await f.executor.close();
  });
});
