import { describe, expect, it, vi } from "vitest";
import { executeWorkflowGraph } from "../src/workflows/executor";

describe("workflow graph recovery contracts", () => {
  it("resumes from a durable checkpoint without replaying the completed node", async () => {
    const tool = vi.fn(async () => ({ value: "persisted" }));
    const graph = {
      version: 1 as const,
      entryNodeId: "first",
      nodes: [
        { id: "first", type: "tool" as const, config: { toolName: "persist" }, writes: ["first"] },
        { id: "second", type: "deterministic" as const, config: { operation: "set", path: "second", value: true } },
      ],
      edges: [{ from: "first", to: "second" }],
      stateSchema: {},
    };
    const durableCheckpoints: Array<{ nodeId: string; nextNodeId?: string; state: Record<string, unknown> }> = [];
    const crashed = await executeWorkflowGraph(graph, {}, {
      tool,
      checkpoint: async (checkpoint) => {
        durableCheckpoints.push({ nodeId: checkpoint.nodeId, nextNodeId: checkpoint.nextNodeId, state: checkpoint.state });
        if (checkpoint.nodeId === "first") throw new Error("worker crashed after checkpoint");
      },
    });

    expect(crashed.status).toBe("failed");
    expect(durableCheckpoints[0]).toMatchObject({ nodeId: "first", nextNodeId: "second", state: { first: { value: "persisted" } } });

    const checkpoint = durableCheckpoints[0]!;
    const resumed = await executeWorkflowGraph({ ...graph, entryNodeId: checkpoint.nextNodeId! }, checkpoint.state, { tool });

    expect(resumed).toMatchObject({ status: "completed", state: { first: { value: "persisted" }, second: true } });
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it("does not execute fan-in after a branch fails", async () => {
    const joined = vi.fn();
    const graph = {
      version: 1 as const,
      entryNodeId: "fan",
      nodes: [
        { id: "fan", type: "fan_out" as const, parallelGroup: "work", config: { fanInNodeId: "join" } },
        { id: "left", type: "deterministic" as const, config: { operation: "set", path: "left", value: true } },
        { id: "right", type: "tool" as const, config: { toolName: "fail" } },
        { id: "join", type: "deterministic" as const, config: { operation: "set", path: "joined", value: true } },
      ],
      edges: [{ from: "fan", to: "left" }, { from: "fan", to: "right" }, { from: "left", to: "join" }, { from: "right", to: "join" }],
      stateSchema: {},
    };
    const result = await executeWorkflowGraph(graph, {}, {
      tool: async ({ nodeId }) => {
        if (nodeId === "right") throw new Error("branch failed");
        return {};
      },
      checkpoint: async ({ nodeId }) => {
        if (nodeId === "join") joined();
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("branch failed");
    expect(joined).not.toHaveBeenCalled();
  });
});
