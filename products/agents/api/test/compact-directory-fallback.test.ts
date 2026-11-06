import { describe, expect, it } from "vitest";
import { buildContext, type ContextInput } from "../src/execution/context/context";
import { compactDirectoryFallback } from "../src/execution/context/compact-directory-fallback";
import { fixtureContextPolicy } from "./context-fixture";

describe("compact capability directory on summary overflow", () => {
  it("keeps the full summary, every tool, and the configured input ceiling", () => {
    const directory = "D".repeat(1012);
    const summary = "S".repeat(364);
    const tools = Array.from({ length: 8 }, (_, i) => ({ type: "function" as const, function: {
      name: `tool_${i}`, description: "tool", parameters: { type: "object", properties: {} },
    }}));
    const policy = fixtureContextPolicy({ maxInputTokens: 9000, estimateRequestTokens: request => Buffer.byteLength(JSON.stringify(request)) });
    const input: ContextInput = { instructions: "base\n" + directory, currentInput: "question", summary: { id: "summary", revision: 1, kind: "summary", content: summary }, tools, modelPolicy: policy, maxInputTokens: 9000 };
    const initial = buildContext(input).estimatedTokens;
    input.instructions = "x".repeat(8468 - initial) + input.instructions;
    expect(buildContext(input).estimatedTokens).toBe(8468);
    input.modelPolicy = { ...policy, maxInputTokens: 8192 };
    input.maxInputTokens = 8192;
    expect(() => buildContext(input)).toThrow("CONTEXT_LIMIT");
    const fallback = compactDirectoryFallback(input, directory);
    expect(fallback).toBeDefined();
    expect(fallback!.built.estimatedTokens).toBeLessThanOrEqual(8192);
    expect(fallback!.built.messages.some(message => message.content?.includes(summary))).toBe(true);
    expect(input.tools).toEqual(tools);
    expect(input.maxInputTokens).toBe(8192);
    expect(fallback!.built.modelPolicy?.maxInputTokens).toBe(8192);
  });
});
