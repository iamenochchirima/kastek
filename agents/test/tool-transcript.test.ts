import { describe, expect, it } from "vitest";
import {
  assistantToolCallMessage,
  checkpointToolResultMessage,
  durableToolResultContent,
  durableToolResultMessage,
} from "../src/runtime/tool-transcript";
import type { DurableToolCall, DurableToolCallResult } from "../src/temporal/contracts";

function call(overrides: Partial<DurableToolCall> = {}): DurableToolCall {
  return {
    id: "runtime-1",
    providerToolCallId: "provider-1",
    name: "records.lookup",
    arguments: { id: "record-1" },
    argumentsHash: "hash-1",
    sequenceNumber: 1,
    ...overrides,
  };
}

function result(overrides: Partial<DurableToolCallResult> = {}): DurableToolCallResult {
  return {
    id: "runtime-1",
    providerToolCallId: "provider-1",
    name: "records.lookup",
    argumentsHash: "hash-1",
    status: "completed",
    output: { id: "record-1", title: "A durable record" },
    ...overrides,
  };
}

describe("tool transcript projection", () => {
  it("binds one provider assistant message to the durable operation identities", () => {
    const message = assistantToolCallMessage({
      assistantMessage: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "provider-1", name: "records.lookup", arguments: { id: "record-1" } }],
      },
      calls: [call()],
    });

    expect(message).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: "provider-1", runtimeOperationId: "runtime-1", name: "records.lookup" }],
    });
  });

  it("serializes failures as explicit tool evidence", () => {
    const failed = result({ status: "failed", error: { code: "TIMEOUT", message: "The provider timed out" } });

    expect(durableToolResultContent(failed)).toBe(JSON.stringify({ ok: false, error: failed.error }));
    expect(durableToolResultMessage(failed)).toMatchObject({
      role: "tool",
      toolCallId: "provider-1",
      runtimeOperationId: "runtime-1",
      content: JSON.stringify({ ok: false, error: failed.error }),
    });
  });

  it.each([
    ["waiting", "APPROVAL_REQUIRED"],
    ["blocked", "APPROVAL_REJECTED"],
    ["unknown", "EFFECT_OUTCOME_UNKNOWN"],
  ] as const)("keeps %s outcomes explicit in the durable transcript", (status, code) => {
    const outcome = result({
      status,
      error: { code, message: `${status} outcome` },
    });

    expect(durableToolResultMessage(outcome)).toMatchObject({
      role: "tool",
      runtimeOperationId: "runtime-1",
      content: JSON.stringify({ ok: false, error: outcome.error }),
    });
  });

  it("keeps large canonical evidence separate from the bounded checkpoint projection", () => {
    const large = result({ output: { payload: "x".repeat(20_000) } });
    const canonical = durableToolResultMessage(large);
    const checkpoint = checkpointToolResultMessage(large);

    expect(canonical.content.length).toBeGreaterThan(20_000);
    expect(Buffer.byteLength(checkpoint.content, "utf8")).toBeLessThanOrEqual(4_096);
    expect(checkpoint.content).toContain("tool_result_projection");
    expect(checkpoint.content).toContain("runtime-1");
    expect(checkpoint.content).toContain("contentSha256");
    expect(checkpoint.content).not.toContain("x".repeat(20_000));
  });
});
