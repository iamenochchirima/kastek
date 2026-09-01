import { describe, expect, it, vi } from "vitest";
import { executeWorkflowGraph } from "../src/workflows/executor";

describe("workflow graph worker-loss recovery contracts", () => {
  it("replays after a model checkpoint without calling the model again", async () => {
    const model = vi.fn(async () => ({
      output: "persisted",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5, estimatedCostUsd: 0.01 },
    }));
    const graph = {
      version: 1 as const,
      entryNodeId: "model",
      nodes: [
        { id: "model", type: "model" as const, writes: ["answer"] },
        { id: "done", type: "deterministic" as const, config: { operation: "set", path: "done", value: true } },
      ],
      edges: [{ from: "model", to: "done" }],
      stateSchema: {},
    };
    const checkpoints: Array<{ nodeId: string; nextNodeId?: string; state: Record<string, unknown> }> = [];
    const crashed = await executeWorkflowGraph(graph, {}, {
      model,
      checkpoint: async (checkpoint) => {
        checkpoints.push({ nodeId: checkpoint.nodeId, nextNodeId: checkpoint.nextNodeId, state: checkpoint.state });
        if (checkpoint.nodeId === "model") throw new Error("worker crashed after model checkpoint");
      },
    });

    expect(crashed.status).toBe("failed");
    expect(checkpoints[0]).toMatchObject({ nodeId: "model", nextNodeId: "done", state: { answer: { output: "persisted" } } });

    const checkpoint = checkpoints[0]!;
    const resumed = await executeWorkflowGraph({ ...graph, entryNodeId: checkpoint.nextNodeId! }, checkpoint.state);

    expect(resumed).toMatchObject({ status: "completed", state: { answer: { output: "persisted" }, done: true } });
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("preserves an approval pause when the worker dies after its pause checkpoint", async () => {
    const tool = vi.fn(async () => ({ ok: true }));
    const graph = {
      version: 1 as const,
      entryNodeId: "approval",
      nodes: [
        { id: "approval", type: "approval" as const, config: { toolName: "publish", arguments: { id: "post-1" }, toolCallId: "call-1" }, writes: ["result"] },
        { id: "done", type: "deterministic" as const, config: { operation: "set", path: "done", value: true } },
      ],
      edges: [{ from: "approval", to: "done" }],
      stateSchema: {},
    };
    const checkpoints: Array<{ nodeId: string; nextNodeId?: string; status: string; state: Record<string, unknown> }> = [];
    const crashed = await executeWorkflowGraph(graph, { requestId: "req-1" }, {
      tool,
      checkpoint: async (checkpoint) => {
        checkpoints.push({ nodeId: checkpoint.nodeId, nextNodeId: checkpoint.nextNodeId, status: checkpoint.status, state: checkpoint.state });
        throw new Error("worker crashed after approval checkpoint");
      },
    });

    expect(crashed.status).toBe("failed");
    expect(checkpoints[0]).toMatchObject({ nodeId: "approval", nextNodeId: "approval", status: "paused", state: { requestId: "req-1" } });

    const checkpoint = checkpoints[0]!;
    const resumed = await executeWorkflowGraph(graph, checkpoint.state, {
      tool,
      resumeApprovedToolCall: { id: "call-1", name: "publish", arguments: { id: "post-1" }, approval: "approved" },
    });

    expect(resumed).toMatchObject({ status: "completed", state: { result: { ok: true }, done: true } });
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it("preserves an external-event pause when the worker dies after its pause checkpoint", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "wait",
      nodes: [
        { id: "wait", type: "wait" as const, config: { eventKey: "provider.completed" }, writes: ["provider"] },
        { id: "done", type: "deterministic" as const, config: { operation: "copy", from: "provider.id", to: "result" } },
      ],
      edges: [{ from: "wait", to: "done" }],
      stateSchema: {},
    };
    const checkpoints: Array<{ nodeId: string; nextNodeId?: string; status: string; state: Record<string, unknown> }> = [];
    const crashed = await executeWorkflowGraph(graph, { requestId: "req-1" }, {
      checkpoint: async (checkpoint) => {
        checkpoints.push({ nodeId: checkpoint.nodeId, nextNodeId: checkpoint.nextNodeId, status: checkpoint.status, state: checkpoint.state });
        throw new Error("worker crashed after external-event checkpoint");
      },
    });

    expect(crashed.status).toBe("failed");
    expect(checkpoints[0]).toMatchObject({ nodeId: "wait", nextNodeId: "wait", status: "paused", state: { requestId: "req-1" } });

    const checkpoint = checkpoints[0]!;
    const resumed = await executeWorkflowGraph(graph, checkpoint.state, {
      resumeExternalEvent: { key: "provider.completed", payload: { id: "evt-1" } },
    });

    expect(resumed).toMatchObject({ status: "completed", state: { provider: { id: "evt-1" }, result: "evt-1" } });
  });

  it("records a terminal checkpoint before a worker loss after completion", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "done",
      nodes: [{ id: "done", type: "deterministic" as const, config: { operation: "set", path: "done", value: true } }],
      edges: [],
      stateSchema: {},
    };
    const checkpoints: Array<{ nodeId: string; nextNodeId?: string; status: string; state: Record<string, unknown> }> = [];
    const crashed = await executeWorkflowGraph(graph, {}, {
      checkpoint: async (checkpoint) => {
        checkpoints.push({ nodeId: checkpoint.nodeId, nextNodeId: checkpoint.nextNodeId, status: checkpoint.status, state: checkpoint.state });
        throw new Error("worker crashed after completion checkpoint");
      },
    });

    expect(crashed.status).toBe("failed");
    expect(checkpoints).toEqual([{ nodeId: "done", nextNodeId: undefined, status: "completed", state: { done: true } }]);
  });
});
