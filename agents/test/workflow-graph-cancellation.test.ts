import { describe, expect, it, vi } from "vitest";
import { executeWorkflowGraph } from "../src/workflows/executor";

describe("workflow graph cancellation contracts", () => {
  it("does not start a node when the enclosing activity is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = vi.fn(async () => ({ output: "should not run" }));
    const result = await executeWorkflowGraph({
      version: 1,
      entryNodeId: "model",
      nodes: [{ id: "model", type: "model", writes: ["answer"] }],
      edges: [],
      stateSchema: {},
    }, {}, { signal: controller.signal, model });

    expect(result).toMatchObject({ status: "failed", error: "Workflow execution cancelled", state: {} });
    expect(model).not.toHaveBeenCalled();
  });

  it("does not apply a remote result or continue after cancellation during a node", async () => {
    const controller = new AbortController();
    const model = vi.fn(async () => {
      controller.abort();
      return { output: "late result" };
    });
    const next = vi.fn(async () => ({ output: "should not run" }));
    const result = await executeWorkflowGraph({
      version: 1,
      entryNodeId: "first",
      nodes: [
        { id: "first", type: "model", writes: ["answer"] },
        { id: "next", type: "model", writes: ["next"] },
      ],
      edges: [{ from: "first", to: "next" }],
      stateSchema: {},
    }, {}, { signal: controller.signal, model: async (input) => input.nodeId === "first" ? model() : next() });

    expect(result).toMatchObject({ status: "failed", error: "Workflow execution cancelled", state: {} });
    expect(model).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});
