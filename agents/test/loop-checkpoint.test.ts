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
    expect(readDurableAgentLoopCheckpoint({ version: 1, messages: Array.from({ length: 2_049 }, () => ({ role: "user", content: "x" })), iterations: 0, toolCalls: 0 })).toBeUndefined();
    expect(readDurableAgentLoopCheckpoint({ version: 1, messages: [], iterations: -1, toolCalls: 0 })).toBeUndefined();
    expect(readDurableAgentLoopCheckpoint({ version: 1, messages: [], iterations: 0, toolCalls: 0, stepIndex: -1 })).toBeUndefined();
    expect(readDurableAgentLoopCheckpoint({ version: 1, messages: [], iterations: 0, toolCalls: 0, status: "unknown" })).toBeUndefined();
    expect(readDurableAgentLoopCheckpoint({ version: 1, messages: [], iterations: 0, toolCalls: 0, pendingToolCalls: [{ id: "call-1", name: "records.search", arguments: [], argumentsHash: "hash" }] })).toBeUndefined();
  });

  it("preserves the activity result needed when a worker is replaced", () => {
    const checkpoint = durableAgentLoopCheckpoint({
      messages: [{ role: "assistant", content: "Choose a tool" }],
      iterations: 1,
      toolCalls: 0,
      status: "awaiting_approval",
      pendingToolCalls: [{ id: "call-1", name: "records.delete", arguments: { id: "record-1" }, argumentsHash: "hash" }],
      ui: { version: "1", mode: "inline", blocks: [{ type: "list", id: "records", items: [{ title: "Record", status: "success" }] }] },
    }, undefined, { stepIndex: 3 });

    expect(readDurableAgentLoopCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("upgrades a valid v1 checkpoint and rejects a tampered v2 transcript", () => {
    const legacy = readDurableAgentLoopCheckpoint({
      version: 1,
      messages: [{ role: "user", content: "continue" }],
      iterations: 1,
      toolCalls: 0,
    });
    expect(legacy).toMatchObject({ version: 2, transcriptCursor: 1, compactionGeneration: 0 });
    expect(legacy?.transcriptDigest).toEqual(expect.any(String));

    const checkpoint = durableAgentLoopCheckpoint({ messages: [{ role: "user", content: "continue" }], iterations: 1, toolCalls: 0 });
    expect(readDurableAgentLoopCheckpoint({ ...checkpoint, messages: [{ role: "user", content: "changed" }] })).toBeUndefined();
  });

  it("keeps transcript identity stable when JSON object keys are reordered by JSONB", () => {
    const checkpoint = durableAgentLoopCheckpoint({
      messages: [{ role: "assistant", content: "", toolCalls: [{ id: "provider-call", runtimeOperationId: "runtime-call", name: "records.search", arguments: { query: "record", limit: 5 } }] }],
      iterations: 1,
      toolCalls: 0,
      status: "limited",
      toolBatchPending: true,
      authorizedToolNames: ["records.search"],
      pendingToolCalls: [{ id: "runtime-call", providerToolCallId: "provider-call", name: "records.search", arguments: { query: "record", limit: 5 }, argumentsHash: "hash" }],
    });
    const reordered = JSON.parse(JSON.stringify(checkpoint, (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse());
    }));
    expect(readDurableAgentLoopCheckpoint(reordered)).toMatchObject({
      transcriptDigest: checkpoint.transcriptDigest,
      authorizedToolNames: ["records.search"],
    });
  });

  it("permits only the typed incomplete round required while awaiting approval", () => {
    const checkpoint = durableAgentLoopCheckpoint({
      messages: [{ role: "user", content: "delete it" }, { role: "assistant", content: "", toolCalls: [{ id: "provider-call", runtimeOperationId: "runtime-call", name: "records.delete", arguments: {} }] }],
      iterations: 1,
      toolCalls: 0,
      status: "awaiting_approval",
      pendingToolCalls: [{ id: "runtime-call", providerToolCallId: "provider-call", name: "records.delete", arguments: {}, argumentsHash: "hash" }],
    });
    expect(readDurableAgentLoopCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(readDurableAgentLoopCheckpoint({ ...checkpoint, status: "limited" })).toBeUndefined();
  });

  it("permits an incomplete durable tool batch only while every result is pending", () => {
    const checkpoint = durableAgentLoopCheckpoint({
      messages: [{ role: "user", content: "find both" }, { role: "assistant", content: "", toolCalls: [
        { id: "provider-1", runtimeOperationId: "runtime-1", name: "records.first", arguments: {} },
        { id: "provider-2", runtimeOperationId: "runtime-2", name: "records.second", arguments: {} },
      ] }],
      iterations: 1,
      toolCalls: 0,
      status: "limited",
      toolBatchPending: true,
      authorizedToolNames: ["records.first", "records.second"],
      pendingToolCalls: [
        { id: "runtime-1", providerToolCallId: "provider-1", name: "records.first", arguments: {}, argumentsHash: "hash-1" },
        { id: "runtime-2", providerToolCallId: "provider-2", name: "records.second", arguments: {}, argumentsHash: "hash-2" },
      ],
    });

    expect(readDurableAgentLoopCheckpoint(checkpoint)).toEqual(checkpoint);
    expect(readDurableAgentLoopCheckpoint({ ...checkpoint, toolBatchPending: false })).toBeUndefined();
  });
});
