import { describe, expect, it } from "vitest";
import { validateWorkflowGraph } from "../src/workflows/graph";
import { executeWorkflowGraph } from "../src/workflows/executor";

describe("workflow graph validation", () => {
  it("executes deterministic transforms, routes, tools, and records a trace", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "set",
      nodes: [
        { id: "set", type: "deterministic" as const, config: { operation: "set", path: "answer", value: "ok" } },
        { id: "route", type: "route" as const },
        { id: "tool", type: "tool" as const, config: { toolName: "echo", arguments: { value: "hello" } }, writes: ["toolResult"] },
        { id: "done", type: "deterministic" as const, config: { operation: "set", path: "done", value: true } },
      ],
      edges: [{ from: "set", to: "route" }, { from: "route", to: "tool", condition: JSON.stringify({ path: "answer", equals: "ok" }) }, { from: "tool", to: "done" }],
      stateSchema: {},
    };
    const result = await executeWorkflowGraph(graph, {}, { tool: async () => ({ value: "tool-ok" }) });
    expect(result).toMatchObject({ status: "completed", state: { answer: "ok", toolResult: { value: "tool-ok" }, done: true } });
    expect(result.trace.map((entry) => entry.nodeId)).toEqual(["set", "route", "tool", "done"]);
  });

  it("pauses at approval and wait nodes without losing state", async () => {
    const graph = { version: 1 as const, entryNodeId: "approval", nodes: [{ id: "approval", type: "approval" as const }, { id: "wait", type: "wait" as const }], edges: [{ from: "approval", to: "wait" }], stateSchema: {} };
    const result = await executeWorkflowGraph(graph, { value: 1 });
    expect(result).toMatchObject({ status: "awaiting_approval", pausedAt: "approval", state: { value: 1 } });
  });

  it("validates a graph and returns a deterministic order", () => {
    const result = validateWorkflowGraph({
      version: 1,
      entryNodeId: "start",
      nodes: [
        { id: "start", type: "deterministic", writes: ["value"] },
        { id: "model", type: "model", reads: ["value"] },
      ],
      edges: [{ from: "start", to: "model" }],
    });
    expect(result.topologicalOrder).toEqual(["start", "model"]);
  });

  it("rejects unknown edges and unbounded cycles", () => {
    expect(() => validateWorkflowGraph({ version: 1, entryNodeId: "start", nodes: [{ id: "start", type: "route" }], edges: [{ from: "start", to: "missing" }] })).toThrow("unknown node");
    expect(() => validateWorkflowGraph({
      version: 1,
      entryNodeId: "start",
      nodes: [{ id: "start", type: "route" }, { id: "next", type: "model" }],
      edges: [{ from: "start", to: "next" }, { from: "next", to: "start" }],
    })).toThrow("unbounded cycle");
  });

  it("allows a bounded cycle and requires fan-out grouping", () => {
    expect(validateWorkflowGraph({
      version: 1,
      entryNodeId: "loop",
      nodes: [{ id: "loop", type: "route", maxIterations: 3 }, { id: "branch", type: "fan_out", parallelGroup: "work" }],
      edges: [{ from: "loop", to: "loop", maxIterations: 3 }, { from: "loop", to: "branch" }],
    }).graph.version).toBe(1);
    expect(() => validateWorkflowGraph({ version: 1, entryNodeId: "fan", nodes: [{ id: "fan", type: "fan_out" }], edges: [] })).toThrow("parallelGroup");
  });
});
