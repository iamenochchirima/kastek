import { describe, expect, it } from "vitest";
import { durableAgentLoopCheckpoint, readDurableAgentLoopCheckpoint } from "../src/runtime/loop-checkpoint";

describe("durable agent loop checkpoints", () => {
  it("round-trips bounded model messages and accumulates progress", () => {
    const first = durableAgentLoopCheckpoint({
      messages: [
        { role: "user", content: "Find the record" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "records.search", arguments: { query: "record" } }] },
        { role: "tool", name: "records.search", toolCallId: "call-1", content: "{\"id\":\"record-1\"}" },
      ],
      iterations: 1,
      toolCalls: 1,
    });
    const second = durableAgentLoopCheckpoint({
      messages: [...first.messages, { role: "assistant", content: "The record is ready." }],
      iterations: 1,
      toolCalls: 0,
    }, first);

    expect(readDurableAgentLoopCheckpoint(second)).toEqual({ ...second, iterations: 2, toolCalls: 1 });
  });

  it("rejects malformed or oversized checkpoint state", () => {
    expect(readDurableAgentLoopCheckpoint({ version: 1, messages: [{ role: "developer", content: "unsafe" }], iterations: 0, toolCalls: 0 })).toBeUndefined();
    expect(readDurableAgentLoopCheckpoint({ version: 1, messages: Array.from({ length: 129 }, () => ({ role: "user", content: "x" })), iterations: 0, toolCalls: 0 })).toBeUndefined();
    expect(readDurableAgentLoopCheckpoint({ version: 1, messages: [], iterations: -1, toolCalls: 0 })).toBeUndefined();
  });
});
