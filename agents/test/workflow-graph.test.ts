import { describe, expect, it } from "vitest";
import { validateWorkflowGraph } from "../src/workflows/graph";

describe("workflow graph validation", () => {
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
