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

  it("binds configured approval nodes to a stable tool proposal and resumes once", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "approve",
      nodes: [
        { id: "approve", type: "approval" as const, config: { toolName: "echo", arguments: { value: "approved" }, toolCallId: "call-1" }, writes: ["result"] },
        { id: "done", type: "deterministic" as const, config: { operation: "set", path: "done", value: true } },
      ],
      edges: [{ from: "approve", to: "done" }],
      stateSchema: {},
    };
    const pending = await executeWorkflowGraph(graph, {} , { tool: async () => ({ ok: true }) });
    expect(pending).toMatchObject({ status: "awaiting_approval", pausedAt: "approve", pendingToolCalls: [{ id: "call-1", name: "echo" }] });
    const resumed = await executeWorkflowGraph(graph, {}, { tool: async (request) => ({ ok: request.approved === "approval" }), resumeApprovedToolCall: { id: "call-1", name: "echo", arguments: { value: "approved" }, approval: "approval" } });
    expect(resumed).toMatchObject({ status: "completed", state: { result: { ok: true }, done: true } });
  });

  it("pauses on a named external event and resumes with the event payload", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "prepare",
      nodes: [
        { id: "prepare", type: "deterministic" as const, config: { operation: "set", path: "prepared", value: true }, writes: [] },
        { id: "wait", type: "wait" as const, config: { eventKey: "provider.completed" }, writes: ["provider"] },
        { id: "done", type: "deterministic" as const, config: { operation: "copy", from: "provider.id", to: "result" } },
      ],
      edges: [{ from: "prepare", to: "wait" }, { from: "wait", to: "done" }],
      stateSchema: {},
    };
    const pending = await executeWorkflowGraph(graph, {});
    expect(pending).toMatchObject({ status: "awaiting_external_event", pausedAt: "wait", waitingFor: "provider.completed", state: { prepared: true } });
    const resumed = await executeWorkflowGraph({ ...graph, entryNodeId: "wait" }, pending.state, { resumeExternalEvent: { key: "provider.completed", payload: { id: "evt-1" } } });
    expect(resumed).toMatchObject({ status: "completed", state: { prepared: true, provider: { id: "evt-1" }, result: "evt-1" } });
  });

  it("pauses for a human handoff and resumes only with the configured handoff key", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "handoff",
      nodes: [
        { id: "handoff", type: "handoff" as const, config: { handoffKey: "support.resolved" }, writes: ["handoff"] },
        { id: "done", type: "deterministic" as const, config: { operation: "set", path: "done", value: true } },
      ],
      edges: [{ from: "handoff", to: "done" }],
      stateSchema: {},
    };
    const pending = await executeWorkflowGraph(graph, { ticket: "T-1" });
    expect(pending).toMatchObject({ status: "awaiting_human", pausedAt: "handoff", waitingFor: "support.resolved", state: { ticket: "T-1" } });
    const wrongKey = await executeWorkflowGraph(graph, pending.state, { resumeExternalEvent: { key: "other.event", payload: {} } });
    expect(wrongKey.status).toBe("awaiting_human");
    const resumed = await executeWorkflowGraph(graph, pending.state, { resumeExternalEvent: { key: "support.resolved", payload: { owner: "operator-1" } } });
    expect(resumed).toMatchObject({ status: "completed", state: { handoff: { owner: "operator-1" }, done: true } });
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
    })).toThrow(/cycles are not supported/);
  });

  it("rejects cycles and still requires fan-out grouping before feature support", () => {
    expect(() => validateWorkflowGraph({
      version: 1,
      entryNodeId: "loop",
      nodes: [{ id: "loop", type: "route", maxIterations: 3 }],
      edges: [{ from: "loop", to: "loop", maxIterations: 3 }],
    })).toThrow(/cycles are not supported/);
    expect(() => validateWorkflowGraph({ version: 1, entryNodeId: "fan", nodes: [{ id: "fan", type: "fan_out" }], edges: [] })).toThrow("parallelGroup");
  });

  it("rejects graph constructs that do not yet have durable execution semantics", () => {
    expect(() => validateWorkflowGraph({
      version: 1,
      entryNodeId: "loop",
      nodes: [{ id: "loop", type: "route", maxIterations: 3 }],
      edges: [{ from: "loop", to: "loop", maxIterations: 3 }],
    })).toThrow(/cycles are not supported/);
    expect(() => validateWorkflowGraph({
      version: 1,
      entryNodeId: "fan",
      nodes: [{ id: "fan", type: "fan_out", parallelGroup: "work" }],
      edges: [],
    })).toThrow(/not supported/);
    expect(() => validateWorkflowGraph({
      version: 1,
      entryNodeId: "loop",
      nodes: [{ id: "loop", type: "agent_loop" }],
      edges: [],
    })).toThrow(/not supported/);
  });

  it("validates declared state types after every node", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "set",
      nodes: [{ id: "set", type: "deterministic" as const, config: { operation: "set", path: "count", value: "not-a-number" } }],
      edges: [],
      stateSchema: { count: { type: "number" } },
    };
    const result = await executeWorkflowGraph(graph, {});
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/state.*count.*number/i);
  });

  it("enforces edge iteration limits for a directly supplied bounded graph", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "loop",
      nodes: [{ id: "loop", type: "route" as const }],
      edges: [{ from: "loop", to: "loop", maxIterations: 2 }],
      stateSchema: {},
    };
    const result = await executeWorkflowGraph(graph, {});
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Edge iteration limit exceeded");
  });

  it("merges independent fan-out deltas without losing sibling writes", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "fan",
      nodes: [
        { id: "fan", type: "fan_out" as const, parallelGroup: "work" },
        { id: "left", type: "deterministic" as const, config: { operation: "set", path: "left", value: true } },
        { id: "right", type: "deterministic" as const, config: { operation: "set", path: "right", value: true } },
      ],
      edges: [{ from: "fan", to: "left" }, { from: "fan", to: "right" }],
      stateSchema: {},
    };
    const result = await executeWorkflowGraph(graph, {});
    expect(result).toMatchObject({ status: "completed", state: { left: true, right: true } });
  });

  it("fails rather than silently choosing between overlapping fan-out writes", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "fan",
      nodes: [
        { id: "fan", type: "fan_out" as const, parallelGroup: "work" },
        { id: "left", type: "deterministic" as const, config: { operation: "set", path: "answer", value: "left" } },
        { id: "right", type: "deterministic" as const, config: { operation: "set", path: "answer", value: "right" } },
      ],
      edges: [{ from: "fan", to: "left" }, { from: "fan", to: "right" }],
      stateSchema: {},
    };
    const result = await executeWorkflowGraph(graph, {});
    expect(result.status).toBe("failed");
    expect(result.error).toContain("overlapping");
  });

  it("aggregates model usage and stops before exceeding a graph model-call limit", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "first",
      nodes: [
        { id: "first", type: "model" as const, writes: ["first"] },
        { id: "second", type: "model" as const, writes: ["second"] },
      ],
      edges: [{ from: "first", to: "second" }],
      stateSchema: {},
    };
    let calls = 0;
    const result = await executeWorkflowGraph(graph, {}, {
      limits: { maxModelCalls: 1, maxTotalTokens: 20 },
      model: async () => {
        calls += 1;
        return { output: "ok", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, estimatedCostUsd: 0.01 } };
      },
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("maxModelCalls");
    expect(result.usage).toEqual({ modelCalls: 1, toolCalls: 0, inputTokens: 4, outputTokens: 2, totalTokens: 6, estimatedCostUsd: 0.01 });
  });

  it("reports usage from every model node when a graph completes", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "first",
      nodes: [
        { id: "first", type: "model" as const, writes: ["first"] },
        { id: "second", type: "model" as const, writes: ["second"] },
      ],
      edges: [{ from: "first", to: "second" }],
      stateSchema: {},
    };
    const result = await executeWorkflowGraph(graph, {}, {
      model: async () => ({ output: "ok", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, estimatedCostUsd: 0.01 } }),
    });
    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({ modelCalls: 2, toolCalls: 0, inputTokens: 8, outputTokens: 4, totalTokens: 12, estimatedCostUsd: 0.02 });
  });

  it("checkpoints each completed node before continuing", async () => {
    const graph = {
      version: 1 as const,
      entryNodeId: "first",
      nodes: [
        { id: "first", type: "deterministic" as const, config: { operation: "set", path: "first", value: true } },
        { id: "second", type: "deterministic" as const, config: { operation: "set", path: "second", value: true } },
      ],
      edges: [{ from: "first", to: "second" }],
      stateSchema: {},
    };
    const checkpoints: Array<{ nodeId: string; nextNodeId?: string; idempotencyKey: string }> = [];
    const result = await executeWorkflowGraph(graph, {}, {
      checkpoint: async (checkpoint) => checkpoints.push({ nodeId: checkpoint.nodeId, nextNodeId: checkpoint.nextNodeId, idempotencyKey: checkpoint.idempotencyKey }),
    });
    expect(result.status).toBe("completed");
    expect(checkpoints).toEqual([
      { nodeId: "first", nextNodeId: "second", idempotencyKey: "workflow:first:1:completed" },
      { nodeId: "second", nextNodeId: undefined, idempotencyKey: "workflow:second:1:completed" },
    ]);
  });
});
