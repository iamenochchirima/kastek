import { describe, expect, it } from "vitest";
import { markDuplicateToolCalls, mapBounded, planToolBatch } from "../src/runtime/tool-batch";

describe("durable tool batch planning", () => {
  it("marks only exact argument duplicates as aliases and preserves distinct calls", () => {
    const calls = markDuplicateToolCalls([
      { id: "one", name: "records.read", argumentsHash: "same" },
      { id: "two", name: "records.read", argumentsHash: "same" },
      { id: "three", name: "records.read", argumentsHash: "different" },
      { id: "four", name: "records.write", argumentsHash: "same" },
    ]);

    expect(calls).toEqual([
      { id: "one", name: "records.read", argumentsHash: "same" },
      { id: "two", name: "records.read", argumentsHash: "same", deduplicatedFrom: "one" },
      { id: "three", name: "records.read", argumentsHash: "different" },
      { id: "four", name: "records.write", argumentsHash: "same" },
    ]);
  });

  it("keeps read calls together and places effects behind barriers", () => {
    const segments = planToolBatch([
      { id: "one", name: "records.read", arguments: {} },
      { id: "two", name: "records.write", arguments: {} },
      { id: "three", name: "records.read", arguments: {} },
    ], (name) => ({
      name,
      version: "1.0.0",
      description: name,
      riskClass: name.endsWith("read") ? "read" : "external-effect",
      requiresApproval: false,
      timeoutMs: 1_000,
      inputSchema: {},
      outputSchema: {},
    }));

    expect(segments.map((segment) => [segment.kind, segment.calls.map(({ call }) => call.id)])).toEqual([
      ["parallel", ["one"]],
      ["sequential", ["two"]],
      ["parallel", ["three"]],
    ]);
  });

  it("never exceeds the configured mapper width and preserves input order", async () => {
    let active = 0;
    let maximum = 0;
    const result = await mapBounded([1, 2, 3, 4, 5], async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 2;
    }, 2);

    expect(maximum).toBe(2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });
});
