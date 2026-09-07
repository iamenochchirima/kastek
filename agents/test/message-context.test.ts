import { describe, expect, it } from "vitest";
import { prepareModelMessages } from "../src/runtime/message-context";

describe("model message context preparation", () => {
  it("repairs an interrupted assistant tool call with a typed tool result", () => {
    const prepared = prepareModelMessages({
      maxContextTokens: 1_000,
      messages: [{ role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] }],
    });
    expect(prepared.repairedPairCount).toBe(1);
    expect(prepared.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "call-1" });
  });

  it("compacts the middle while retaining a pair boundary at the tail", () => {
    const messages = [
      { role: "system" as const, content: "policy" },
      ...Array.from({ length: 30 }, (_, index) => ({ role: "user" as const, content: `old-${index} ${"history ".repeat(20)}` })),
      { role: "assistant" as const, content: "", toolCalls: [{ id: "call-2", name: "read", arguments: {} }] },
      { role: "tool" as const, name: "read", toolCallId: "call-2", content: "result" },
      { role: "user" as const, content: "latest" },
    ];
    const prepared = prepareModelMessages({ messages, maxContextTokens: 256 });
    expect(prepared.compacted).toBe(true);
    expect(prepared.messages[1]?.content).toContain("Earlier conversation compacted");
    expect(prepared.messages.at(-1)).toMatchObject({ role: "user", content: "latest" });
    expect(prepared.messages.some((message) => message.role === "tool" && message.toolCallId === "call-2")).toBe(true);
  });
});
