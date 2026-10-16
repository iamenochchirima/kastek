import { describe, expect, it, vi } from "vitest";
import { executeWorkflowGraph } from "../src/workflows/executor";

describe("workflow graph agent-loop contracts", () => {
  it("runs the bounded-loop result through graph state and aggregate usage", async () => {
    const agentLoop = vi.fn(async () => ({
      status: "completed" as const,
      output: "loop response",
      usage: { modelCalls: 2, toolCalls: 1, inputTokens: 8, outputTokens: 4, totalTokens: 12, estimatedCostUsd: 0.02 },
    }));
    const graph = {
      version: 1 as const,
      entryNodeId: "loop",
      nodes: [
        { id: "loop", type: "agent_loop" as const, writes: ["answer"], maxIterations: 3 },
        { id: "done", type: "deterministic" as const, config: { operation: "set", path: "done", value: true } },
      ],
      edges: [{ from: "loop", to: "done" }],
      stateSchema: {},
    };

    const result = await executeWorkflowGraph(graph, {}, { agentLoop });

    expect(result).toMatchObject({ status: "completed", state: { answer: "loop response", done: true } });
    expect(result.usage).toEqual({ modelCalls: 2, toolCalls: 1, inputTokens: 8, outputTokens: 4, totalTokens: 12, estimatedCostUsd: 0.02 });
    expect(agentLoop).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "loop", maxIterations: 3, usage: expect.objectContaining({ modelCalls: 0 }) }));
  });

  it("converts a bounded-loop approval pause into a durable graph pause", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const result = await executeWorkflowGraph({
      version: 1,
      entryNodeId: "loop",
      nodes: [{ id: "loop", type: "agent_loop", writes: ["answer"] }],
      edges: [],
      stateSchema: {},
    }, { requestId: "req-1" }, {
      agentLoop: async () => ({
        status: "awaiting_approval" as const,
        pendingToolCalls: [{ id: "call-1", name: "publish", arguments: { id: "post-1" }, argumentsHash: "hash-1" }],
        usage: { modelCalls: 1, toolCalls: 1, inputTokens: 3, outputTokens: 1, totalTokens: 4, estimatedCostUsd: 0.01 },
      }),
      checkpoint,
    });

    expect(result).toMatchObject({
      status: "awaiting_approval",
      pausedAt: "loop",
      pendingToolCalls: [{ id: "call-1", name: "publish" }],
      state: { requestId: "req-1" },
    });
    expect(checkpoint).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "loop", status: "paused", nextNodeId: "loop" }));
  });

  it("does not apply a loop result after cancellation", async () => {
    const controller = new AbortController();
    const agentLoop = vi.fn(async () => {
      controller.abort();
      return { status: "completed" as const, output: "late response", usage: { modelCalls: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 } };
    });
    const result = await executeWorkflowGraph({
      version: 1,
      entryNodeId: "loop",
      nodes: [{ id: "loop", type: "agent_loop", writes: ["answer"] }],
      edges: [],
      stateSchema: {},
    }, {}, { agentLoop, signal: controller.signal });

    expect(result).toMatchObject({ status: "failed", error: "Workflow execution cancelled", state: {} });
    expect(agentLoop).toHaveBeenCalledTimes(1);
  });
});
