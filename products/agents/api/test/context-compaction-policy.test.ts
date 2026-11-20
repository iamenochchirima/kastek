import { describe, expect, it } from "vitest";
import { estimateMessagesTokens, prepareCompaction, type ContextGroup, type ContextModelPolicy } from "../src/execution/context/context";
import { trimReadToolResults } from "../src/execution/context/tool-results";
import { modelServicePolicy } from "../src/execution/models/settings";

const policy: ContextModelPolicy = {
  modelId: "fixture/model", revision: "1", counterRevision: "1", maxDurationSeconds: 30,
  contextWindowTokens: 262144, maxInputTokens: 196608, maxOutputTokens: 32768, safetyTokens: 1024,
  maxMessages: 256, maxTools: 64, maxRequestBytes: 2097152,
  estimateRequestTokens: request => JSON.stringify(request).length,
};

const group = (id: string, message: { role: "user" | "tool"; content: string }): ContextGroup => ({ id, messages: [message] });

describe("compaction threshold policy", () => {
  it("defaults automatic compaction to 85% of the service input allowance", () => {
    const defaults = modelServicePolicy({});
    expect(defaults.maxInputTokens).toBe(196608);
    expect(defaults.compactAtTokens).toBe(167116);
  });

  it("scales the default threshold for a custom input allowance and respects an explicit threshold", () => {
    expect(modelServicePolicy({ AGENTS_MODEL_POLICY_JSON: JSON.stringify({ maxInputTokens: 8192 }) }).compactAtTokens).toBe(6963);
    expect(modelServicePolicy({ AGENTS_MODEL_POLICY_JSON: JSON.stringify({ maxInputTokens: 8192, compactAtTokens: 6144 }) }).compactAtTokens).toBe(6144);
  });

  it("estimates the full conversation even when a route cap is smaller", () => {
    const long = group("long", { role: "user", content: "x".repeat(50000) });
    const tokens = estimateMessagesTokens({ instructions: "", currentInput: "", modelPolicy: policy, maxInputTokens: 10000 }, long.messages);
    expect(tokens).toBeGreaterThan(10000);
  });
});

describe("recent context retention", () => {
  it("retains groups by token budget instead of a fixed count", () => {
    const groups = [group("a", { role: "user", content: "a".repeat(1000) }), group("b", { role: "user", content: "b".repeat(1000) }),
      group("c", { role: "user", content: "c".repeat(1000) }), group("d", { role: "user", content: "d".repeat(1000) })];
    const small = prepareCompaction(groups, { modelPolicy: policy, retainRecentTokens: 1500, maxInputTokens: 100000, maxOutputTokens: 1000 });
    expect(small.recentGroups.map(item => item.id)).toEqual(["d"]);
    expect(small.compactedGroupIds).toEqual(["a", "b", "c"]);
    const large = prepareCompaction(groups, { modelPolicy: policy, retainRecentTokens: 1_000_000, maxInputTokens: 100000, maxOutputTokens: 1000 });
    expect(large.recentGroups.map(item => item.id)).toEqual(["b", "c", "d"]);
    expect(large.compactedGroupIds).toEqual(["a"]);
  });
});

describe("read tool-result trimming", () => {
  it("shortens old tool results and leaves the newest result whole", () => {
    const old = group("old", { role: "tool", content: "o".repeat(5000) });
    const newest = group("new", { role: "tool", content: "n".repeat(5000) });
    const trimmed = trimReadToolResults([old, newest]);
    expect(trimmed[0]!.messages[0]!.content).toContain("Tool result shortened after it was read");
    expect(trimmed[0]!.messages[0]!.content!.length).toBeLessThan(2200);
    expect(trimmed[1]!.messages[0]!.content).toBe("n".repeat(5000));
    expect(old.messages[0]!.content).toBe("o".repeat(5000));
  });

  it("can trim every group when the newest result has already been read", () => {
    const only = group("only", { role: "tool", content: "z".repeat(5000) });
    expect(trimReadToolResults([only], { keepNewestGroup: false })[0]!.messages[0]!.content).toContain("Tool result shortened");
  });
});
