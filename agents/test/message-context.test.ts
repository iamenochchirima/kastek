import { describe, expect, it } from "vitest";
import { prepareModelMessages, TranscriptProjectionError } from "../src/runtime/message-context";

describe("model message context preparation", () => {
  it("rejects an interrupted assistant tool call before provider projection", () => {
    expect(() => prepareModelMessages({
      messages: [{ role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] }],
    })).toThrowError(TranscriptProjectionError);
  });

  it("leaves history selection to the provider-aware context planner", () => {
    const messages = [
      { role: "system" as const, content: "policy" },
      ...Array.from({ length: 30 }, (_, index) => ({ role: "user" as const, content: `old-${index} ${"history ".repeat(20)}` })),
      { role: "assistant" as const, content: "", toolCalls: [{ id: "call-2", name: "read", arguments: {} }] },
      { role: "tool" as const, name: "read", toolCallId: "call-2", content: "result" },
      { role: "user" as const, content: "latest" },
    ];
    const prepared = prepareModelMessages({ messages });
    expect(prepared.messages).toHaveLength(messages.length);
    expect(prepared.messages[1]?.content).toContain("old-0");
    expect(prepared.messages.at(-1)).toMatchObject({ role: "user", content: "latest" });
    expect(prepared.messages.some((message) => message.role === "tool" && message.toolCallId === "call-2")).toBe(true);
  });

  it("rejects incomplete pairs without applying a token compactor", () => {
    expect(() => prepareModelMessages({
      messages: [
        { role: "system", content: "policy" },
        ...Array.from({ length: 40 }, (_, index) => ({ role: "user" as const, content: `history-${index}` })),
        { role: "assistant", content: "", toolCalls: [{ id: "call-3", name: "lookup", arguments: {} }] },
      ],
    })).toThrowError(TranscriptProjectionError);
  });

  it("rejects orphan tool results instead of exposing an invalid model transcript", () => {
    expect(() => prepareModelMessages({
      messages: [
        { role: "tool", name: "lookup", toolCallId: "call-1", content: "arrived before its call" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] },
        { role: "tool", name: "lookup", toolCallId: "call-1", content: "valid result" },
      ],
    })).toThrowError(TranscriptProjectionError);
  });
});
