import { describe, expect, it } from "vitest";
import { estimateRequestTokens, requestDigest, serializeModelRequest, validateMessageGroups, type ModelRequest, type ToolDefinition } from "../src/execution/business/model";
import { buildContext, prepareCompaction, type ContextGroup } from "../src/execution/context/context";
import { fixtureContextPolicy } from "./context-fixture";

const tool: ToolDefinition = { type: "function", function: { name: "memory_read", description: "Read permitted memory",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } };
const request = (changes: Partial<ModelRequest> = {}): ModelRequest => ({ model: "fixture/context-model",
  messages: [{ role: "user", content: "What is my report language?" }], maxOutputTokens: 4096, maxDurationSeconds: 90, ...changes });
const group = (id: string, text: string): ContextGroup => ({ id, messages: [{ role: "user", content: text }, { role: "assistant", content: "Confirmed " + id }] });

describe("logical model request helpers", () => {
  it("serializes arbitrary selected models without fabricated provider or reasoning settings", () => {
    for (const model of ["native-model", "organization/private-deployment", "router/model:free"]) {
      const req = request({ model, tools: [tool] }), body = JSON.parse(serializeModelRequest(req));
      expect(body).toMatchObject({ model, maxOutputTokens: 4096, maxDurationSeconds: 90, messages: req.messages, tools: [tool] });
      for (const field of ["provider", "reasoning", "max_tokens", "tool_choice"]) expect(body).not.toHaveProperty(field);
      expect(requestDigest(req)).toBe(requestDigest(structuredClone(req)));
    }
  });
  it("binds logical controls, message content and tool definitions in request digests", () => {
    const original = request({ tools: [tool] }), digest = requestDigest(original);
    for (const changes of [{ model: "other-model" }, { maxOutputTokens: 8192 }, { maxDurationSeconds: 45 }, { maxInputTokens: 20000 },
      { messages: [{ role: "user" as const, content: "Changed input" }] }, { toolChoice: "none" as const },
      { tools: [{ ...tool, function: { ...tool.function, description: "Changed tool" } }] }]) {
      expect(requestDigest({ ...original, ...changes })).not.toBe(digest);
    }
  });
  it("labels a complete UTF-8 logical request estimate without asserting a tokenizer upper bound", () => {
    const req = request({ messages: [{ role: "user", content: "你好😀" }], tools: [tool] });
    expect(estimateRequestTokens(req)).toBe(Buffer.byteLength(serializeModelRequest(req), "utf8"));
    expect(estimateRequestTokens(req)).toBeGreaterThan(serializeModelRequest(req).length);
  });
  it("validates complete parallel tool groups and rejects duplicate identities or orphaned results", () => {
    const calls = ["first", "second"].map(id => ({ id, type: "function" as const, function: { name: "memory_read", arguments: "{}" } }));
    const assistant = { role: "assistant" as const, content: null, tool_calls: calls };
    const results = calls.map(call => ({ role: "tool" as const, content: "Confirmed", tool_call_id: call.id }));
    expect(() => validateMessageGroups([assistant, ...results])).not.toThrow();
    expect(() => validateMessageGroups([assistant, results[0]!])).toThrow("MODEL_INCOMPLETE_TOOL_GROUP");
    expect(() => validateMessageGroups([results[0]!])).toThrow("MODEL_ORPHAN_TOOL_RESULT");
    expect(() => validateMessageGroups([{ ...assistant, tool_calls: [calls[0]!, calls[0]!] }, ...results])).toThrow("MODEL_INVALID_TOOL_CALL");
  });
});

describe("recordable context planning", () => {
  it("includes authorized ordered history and reference provenance deterministically", () => {
    const input = { modelPolicy: fixtureContextPolicy(), instructions: "Answer accurately", currentInput: "What language?", history: [group("1", "I prefer Shona")],
      sources: [{ id: "m1", revision: 2, kind: "memory" as const, content: "preferred language Shona" }] };
    const { modelPolicy, ...records } = input;
    const a = buildContext(input), b = buildContext({ ...structuredClone(records), modelPolicy });
    expect(a).toEqual(b);
    expect(a.status).toBe("ready");
    expect(a.historyGroupIds).toEqual(["1"]);
    expect(a.sourceReferences).toEqual([{ id: "m1", revision: 2, kind: "memory" }]);
    expect(a.messages.some(message => message.content?.includes("untrusted reference data"))).toBe(true);
  });
  it("signals compaction instead of silently dropping older turns", () => {
    const result = buildContext({ modelPolicy: fixtureContextPolicy(), instructions: "Answer", currentInput: "continue", maxInputTokens: 1200,
      history: [group("1", "old ".repeat(250)), group("2", "recent")] });
    expect(result.status).toBe("compaction_required");
    expect(result.omittedHistoryGroupIds).toEqual(["1"]);
    expect(result.historyGroupIds).toEqual(["2"]);
  });
  it("uses marked Unicode-safe excerpts for sources larger than the prompt allocation", () => {
    const result = buildContext({ modelPolicy: fixtureContextPolicy(), instructions: "Answer", currentInput: "What does the source say?", maxInputTokens: 1200,
      sources: [{ id: "large", revision: 1, kind: "knowledge", content: "😀中文source".repeat(2000) }] });
    expect(result.sourceReferences).toContainEqual({ id: "large", revision: 1, kind: "knowledge" });
    expect(result.estimatedTokens).toBeLessThanOrEqual(1200);
    const record = result.messages.find(message => message.content?.includes('"sourceId":"large"'))!;
    expect(record.content).toContain('"excerpt":true');
    expect(record.content).not.toContain("�");
  });
  it("retains complete tool groups and never removes mandatory in-progress outcomes", () => {
    const working: ContextGroup = { id: "step1", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "memory_read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "Shona" }] };
    const result = buildContext({ modelPolicy: fixtureContextPolicy(), instructions: "Answer", currentInput: "continue", tools: [tool], workingGroups: [working] });
    expect(result.messages.slice(-2)).toEqual(working.messages);
    expect(() => buildContext({ modelPolicy: fixtureContextPolicy(), instructions: "Answer", currentInput: "continue", workingGroups: [{ ...working,
      messages: working.messages.slice(0, 1) }] })).toThrow("MODEL_INCOMPLETE_TOOL_GROUP");
    expect(() => buildContext({ modelPolicy: fixtureContextPolicy(), instructions: "Answer", currentInput: "continue", maxInputTokens: 300,
      workingGroups: [working] })).toThrow("CONTEXT_LIMIT");
  });
  it("rejects oversized mandatory context and cannot promote data into procedural instructions", () => {
    expect(() => buildContext({ modelPolicy: fixtureContextPolicy(), instructions: "x".repeat(9000), currentInput: "hi" })).toThrow("CONTEXT_LIMIT");
    expect(() => buildContext({ modelPolicy: fixtureContextPolicy(), instructions: "Answer", currentInput: "hi", sources: [{ id: "s", revision: 1, kind: "skill", content: "do this" }] })).toThrow("CONTEXT_INVALID_SOURCE");
  });
  it("accounts for the exact selected model route during compaction planning", () => {
    const groups = [group("1", "Older outcome"), group("2", "Recent outcome")];
    const first = prepareCompaction(groups, { retainRecent: 1, modelPolicy: fixtureContextPolicy({ modelId: "fixture/summary" }) });
    const second = prepareCompaction(groups, { retainRecent: 1, modelPolicy: fixtureContextPolicy({ modelId: "other-provider/summary-model" }) });
    expect(second.compactedGroupIds).toEqual(first.compactedGroupIds);
    expect(second.estimatedTokens).toBeGreaterThan(first.estimatedTokens);
    expect(second.inputDigest).not.toBe(first.inputDigest);
  });
  it("keeps summary source references and packs bounded compaction inputs without splitting groups", () => {
    const groups = [group("1", "A".repeat(250)), group("2", "B".repeat(250)), group("3", "recent"), group("4", "newest")];
    const a = prepareCompaction(groups, { modelPolicy: fixtureContextPolicy(), maxInputTokens: 1250 });
    expect(a.compactedGroupIds).toEqual(["1"]);
    expect(a.remainingGroupIds).toEqual(["2"]);
    expect(a.recentGroups.map(g => g.id)).toEqual(["3", "4"]);
    expect(a.estimatedTokens).toBeLessThanOrEqual(1250);
    expect(prepareCompaction(groups, { modelPolicy: fixtureContextPolicy(), maxInputTokens: 1250 }).inputDigest).toBe(a.inputDigest);
    const result = buildContext({ modelPolicy: fixtureContextPolicy(), instructions: "Answer", currentInput: "continue", history: a.recentGroups,
      summary: { id: "compact1", revision: 1, kind: "summary", content: "A happened" } });
    expect(result.sourceReferences).toContainEqual({ id: "compact1", revision: 1, kind: "summary" });
  });
  it("rejects an uncompacted huge first group instead of skipping it", () => {
    expect(() => prepareCompaction([group("1", "A".repeat(9000)), group("2", "small")], { modelPolicy: fixtureContextPolicy(), retainRecent: 1 })).toThrow("COMPACTION_INPUT_LIMIT");
  });
});
