import { describe, expect, it, vi } from "vitest";
import {
  ChildExecutionKernel,
  parseChildExecutionPolicy,
  validateChildExecutionPolicy,
  type BoundedChildExecutor,
} from "../src/children";
import { createExecutionScope } from "../src/runtime/execution-scope";

const parent = createExecutionScope({
  organizationId: "org-a",
  installationId: "installation-a",
  agentDefinitionId: "parent-agent",
  agentVersionId: "parent-version",
  sessionId: "session-a",
  conversationId: "conversation-a",
  runId: "parent-run",
  correlationId: "correlation-a",
  capabilityGrants: ["research.read", "crm.write"],
  resourceGrants: ["contact:42"],
});

const request = (idempotencyKey: string, overrides: Record<string, unknown> = {}) => ({
  childAgentDefinitionId: "research-agent",
  childAgentVersionId: "research-v1",
  idempotencyKey,
  input: { question: "qualify" },
  capabilityGrants: ["research.read"],
  resourceGrants: ["contact:42"],
  ...overrides,
});

describe("bounded child execution kernel", () => {
  it("validates policy limits and creates an isolated root context", () => {
    expect(validateChildExecutionPolicy({ maxDepth: -1 })).toMatchObject({ ok: false });
    const kernel = new ChildExecutionKernel(parseChildExecutionPolicy({
      maxDepth: 2,
      maxFanOut: 3,
      maxConcurrentChildren: 2,
      budget: { contextTokens: 100, modelTokens: 500, toolCalls: 4, graphSteps: 8, wallTimeMs: 1_000 },
    }));
    expect(kernel.createContext().snapshot()).toMatchObject({
      depth: 0,
      directChildren: 0,
      activeChildren: 0,
      remainingBudget: { modelTokens: 500, wallTimeMs: 1_000 },
    });
  });

  it("attenuates grants and child budgets while preserving parent-child evidence", async () => {
    const kernel = new ChildExecutionKernel(parseChildExecutionPolicy({
      budget: { contextTokens: 100, modelTokens: 500, toolCalls: 4, graphSteps: 8, wallTimeMs: 1_000 },
    }));
    const context = kernel.createContext();
    const events: string[] = [];
    const executor: BoundedChildExecutor<{ ok: boolean }> = {
      async execute(input) {
        expect(input.scope.capabilityGrants).toEqual(["research.read"]);
        expect(input.budget.modelTokens).toBe(200);
        input.progress.report({ progress: 0.5, message: "researching" });
        return { output: { ok: true }, usage: { modelTokens: 80, toolCalls: 1, wallTimeMs: 25 } };
      },
    };

    const result = await kernel.execute(parent, context, request("bounded", { capabilityGrants: ["research.read"] }), executor, {
      requestedBudget: { modelTokens: 200, toolCalls: 2, wallTimeMs: 500 },
      onProgress: (evidence) => events.push(`${evidence.phase}:${evidence.parentRunId}:${evidence.depth}`),
    });

    expect(result).toMatchObject({ status: "succeeded", output: { ok: true }, scope: { parentRunId: "parent-run", capabilityGrants: ["research.read"] } });
    expect(result.progress.map((event) => event.phase)).toEqual(["admitted", "started", "progress", "completed"]);
    expect(events).toEqual(["admitted:parent-run:1", "started:parent-run:1", "progress:parent-run:1", "completed:parent-run:1"]);
    expect(result.budget).toMatchObject({
      granted: { modelTokens: 200, toolCalls: 2 },
      used: { modelTokens: 80, toolCalls: 1 },
      parentRemaining: { modelTokens: 420, toolCalls: 3 },
    });
    expect(context.snapshot().remainingBudget).toMatchObject({ modelTokens: 420, toolCalls: 3 });
  });

  it("rejects depth, fan-out, and authority expansion before executing a child", async () => {
    const executor: BoundedChildExecutor = { execute: vi.fn(async () => ({ output: "unexpected" })) };
    const depthKernel = new ChildExecutionKernel(parseChildExecutionPolicy({ maxDepth: 0 }));
    const depthResult = await depthKernel.execute(parent, depthKernel.createContext(), request("depth"), executor);
    expect(depthResult).toMatchObject({ status: "rejected", error: { code: "CHILD_MAX_DEPTH_EXCEEDED" } });

    const fanOutKernel = new ChildExecutionKernel(parseChildExecutionPolicy({ maxFanOut: 1 }));
    const fanOutResult = await fanOutKernel.executeFanOut(parent, fanOutKernel.createContext(), [
      { input: request("fan-1") },
      { input: request("fan-2") },
    ], executor);
    expect(fanOutResult).toMatchObject({ status: "rejected", error: { code: "CHILD_MAX_FAN_OUT_EXCEEDED" } });

    const authorityResult = await fanOutKernel.execute(parent, fanOutKernel.createContext(), request("authority", { capabilityGrants: ["crm.write", "billing.write"] }), executor);
    expect(authorityResult).toMatchObject({ status: "rejected", error: { code: "CHILD_AUTHORITY_EXPANSION" } });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("runs bounded fan-out in parallel without exceeding concurrency", async () => {
    const kernel = new ChildExecutionKernel(parseChildExecutionPolicy({ maxFanOut: 4, maxConcurrentChildren: 2, budget: { contextTokens: 100, modelTokens: 1_000, toolCalls: 20, graphSteps: 20, wallTimeMs: 2_000 } }));
    const context = kernel.createContext();
    let active = 0;
    let peak = 0;
    const executor: BoundedChildExecutor<number> = {
      async execute(input) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { output: Number(input.scope.invocationId.slice(-2).replace(/[^0-9]/g, "") || 0), usage: { modelTokens: 10, wallTimeMs: 15 } };
      },
    };
    const result = await kernel.executeFanOut(parent, context, [1, 2, 3, 4].map((value) => ({ input: request(`fan-${value}`) })), executor);
    expect(result.status).toBe("completed");
    expect(result.results).toHaveLength(4);
    expect(peak).toBe(2);
  });

  it("returns partial output on cancellation and timeout when allowed", async () => {
    const kernel = new ChildExecutionKernel(parseChildExecutionPolicy({ defaultTimeoutMs: 40, budget: { contextTokens: 100, modelTokens: 500, toolCalls: 4, graphSteps: 8, wallTimeMs: 100 } }));
    const controller = new AbortController();
    const executor: BoundedChildExecutor = {
      async execute(input) {
        input.progress.report({ progress: 0.2, partialOutput: { draft: "in progress" } });
        await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("aborted");
      },
    };
    const cancellation = kernel.execute(parent, kernel.createContext(), request("cancelled"), executor, { signal: controller.signal });
    controller.abort();
    await expect(cancellation).resolves.toMatchObject({ status: "partial", termination: "cancelled", partialOutput: { draft: "in progress" } });

    const ignoringExecutor: BoundedChildExecutor = {
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { output: "too late" };
      },
    };
    const timeoutStartedAt = Date.now();
    const timeout = await kernel.execute(parent, kernel.createContext(), request("timeout"), ignoringExecutor, { timeoutMs: 10 });
    expect(Date.now() - timeoutStartedAt).toBeLessThan(80);
    expect(timeout).toMatchObject({ status: "timed_out", termination: "timed_out", error: { code: "CHILD_TIMEOUT" } });
  });

  it("does not let a progress sink failure fail the child", async () => {
    const kernel = new ChildExecutionKernel(parseChildExecutionPolicy());
    const result = await kernel.execute(parent, kernel.createContext(), request("sink-failure"), {
      async execute(input) {
        input.progress.report({ progress: 1 });
        return { output: "ok" };
      },
    }, { onProgress: async () => { throw new Error("journal unavailable"); } });
    expect(result.status).toBe("succeeded");
  });
});
