import { describe, expect, it, vi } from "vitest";
import { APPROVED_MODEL_PROFILE, callModel, estimateRequestTokens, ModelOperationError,
  serializeModelRequest, type ModelRequest, type ToolDefinition } from "../src/execution/business/model";
import { buildContext, prepareCompaction, type ContextGroup } from "../src/execution/context/context";

const tool: ToolDefinition = { type: "function", function: { name: "memory_read", description: "Read permitted memory",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } } };
const request = (changes: Partial<ModelRequest> = {}): ModelRequest => ({ model: APPROVED_MODEL_PROFILE.model,
  messages: [{ role: "user", content: "What is my report language?" }], maxOutputTokens: 1024, maxDurationSeconds: 120, ...changes });
function response(message: unknown = { role: "assistant", content: "Shona" }, finish_reason = "stop", usage: unknown = { prompt_tokens: 80, completion_tokens: 4 }): Response {
  return Response.json({ id: "provider-1", choices: [{ message, finish_reason }], usage });
}
const group = (id: string, text: string): ContextGroup => ({ id, messages: [{ role: "user", content: text }, { role: "assistant", content: "Confirmed " + id }] });

describe("normalized model boundary", () => {
  it("uses the approved free model without provider fallback or hidden reasoning", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
    const result = await callModel(request(), { openRouterApiKey: "fixture", fetch: fetcher as typeof fetch });
    expect(result).toEqual({ message: { role: "assistant", content: "Shona" }, finishReason: "stop",
      usage: { inputTokens: 80, outputTokens: 4 }, providerRequestId: "provider-1" });
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(sent.provider.allow_fallbacks).toBe(false);
    expect(sent.reasoning).toEqual({ effort: "none", exclude: true });
  });
  it("preserves malformed model tool arguments for bounded trusted validation", async () => {
    const result = await callModel(request({ tools: [tool] }), { openRouterApiKey: "fixture", fetch: (async () => response({ role: "assistant", content: null,
      tool_calls: [{ id: "call1", type: "function", function: { name: "memory_read", arguments: "{" } }] }, "tool_calls")) as typeof fetch });
    expect(result.message.tool_calls?.[0]?.function.arguments).toBe("{");
    expect(result.finishReason).toBe("tool_calls");
  });
  it.each(["length", "content_filter"])("preserves %s as a non-success outcome", async finish => {
    const result = await callModel(request(), { openRouterApiKey: "fixture", fetch: (async () => response({ role: "assistant", content: "Partial" }, finish)) as typeof fetch });
    expect(result.finishReason).toBe(finish === "length" ? "length" : "refusal");
  });
  it.each([400, 401, 402, 403, 404, 422, 429])("classifies definitive HTTP %s without retry", async status => {
    const fetcher = vi.fn(async () => new Response("private provider details", { status }));
    await expect(callModel(request(), { openRouterApiKey: "fixture", fetch: fetcher as typeof fetch })).rejects.toMatchObject({ outcome: "rejected",
      code: status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_REQUEST_REJECTED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([408, 500, 502])("treats HTTP %s as uncertain without regeneration", async status => {
    const fetcher = vi.fn(async () => new Response("private provider details", { status }));
    await expect(callModel(request(), { openRouterApiKey: "fixture", fetch: fetcher as typeof fetch })).rejects.toMatchObject({ outcome: "uncertain" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported profiles, oversized serialized tools, and orphan results before dispatch", async () => {
    const fetcher = vi.fn();
    for (const req of [request({ model: "paid-model" }), request({ tools: [{ ...tool, function: { ...tool.function, description: "x".repeat(9000) } }] }),
      request({ messages: [{ role: "tool", content: "done", tool_call_id: "missing" }] })]) {
      await expect(callModel(req, { openRouterApiKey: "fixture", fetch: fetcher })).rejects.toBeInstanceOf(ModelOperationError);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects missing usage, unknown finish semantics and accounting-profile violations as uncertain", async () => {
    for (const fixture of [response(undefined, "stop", {}), response(undefined, "unexpected"),
      response(undefined, "stop", { prompt_tokens: 9000, completion_tokens: 4 }),
      response(undefined, "stop", { prompt_tokens: 80, completion_tokens: 1025 }),
      response(undefined, "stop", { prompt_tokens: 80, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } })]) {
      await expect(callModel(request(), { openRouterApiKey: "fixture", fetch: (async () => fixture) as typeof fetch })).rejects.toMatchObject({ outcome: "uncertain" });
    }
  });
  it("does not retry after transport loss or oversized streamed response", async () => {
    const lost = vi.fn(async () => { throw new Error("network after acceptance"); });
    await expect(callModel(request(), { openRouterApiKey: "fixture", fetch: lost as typeof fetch })).rejects.toMatchObject({ outcome: "uncertain" });
    expect(lost).toHaveBeenCalledTimes(1);
    await expect(callModel(request(), { openRouterApiKey: "fixture", fetch: (async () => new Response("x".repeat(128001))) as typeof fetch })).rejects.toMatchObject({ code: "MODEL_INVALID_RESPONSE" });
  });
  it("counts complete serialized UTF-8 payload rather than JavaScript character length", () => {
    const req = request({ messages: [{ role: "user", content: "你好😀" }], tools: [tool] });
    expect(estimateRequestTokens(req)).toBe(Buffer.byteLength(serializeModelRequest(req)));
    expect(estimateRequestTokens(req)).toBeGreaterThan(serializeModelRequest(req).length);
  });
});

describe("recordable context planning", () => {
  it("includes authorized ordered history and reference provenance deterministically", () => {
    const input = { instructions: "Answer accurately", currentInput: "What language?", history: [group("1", "I prefer Shona")],
      sources: [{ id: "m1", revision: 2, kind: "memory" as const, content: "preferred language Shona" }] };
    const a = buildContext(input), b = buildContext(structuredClone(input));
    expect(a).toEqual(b);
    expect(a.status).toBe("ready");
    expect(a.historyGroupIds).toEqual(["1"]);
    expect(a.sourceReferences).toEqual([{ id: "m1", revision: 2, kind: "memory" }]);
    expect(a.messages.some(message => message.content?.includes("untrusted reference data"))).toBe(true);
  });
  it("signals compaction instead of silently dropping older turns", () => {
    const result = buildContext({ instructions: "Answer", currentInput: "continue", maxInputTokens: 1200,
      history: [group("1", "old ".repeat(250)), group("2", "recent")] });
    expect(result.status).toBe("compaction_required");
    expect(result.omittedHistoryGroupIds).toEqual(["1"]);
    expect(result.historyGroupIds).toEqual(["2"]);
  });
  it("uses marked Unicode-safe excerpts for sources larger than the prompt allocation", () => {
    const result = buildContext({ instructions: "Answer", currentInput: "What does the source say?", maxInputTokens: 1200,
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
    const result = buildContext({ instructions: "Answer", currentInput: "continue", tools: [tool], workingGroups: [working] });
    expect(result.messages.slice(-2)).toEqual(working.messages);
    expect(() => buildContext({ instructions: "Answer", currentInput: "continue", workingGroups: [{ ...working,
      messages: working.messages.slice(0, 1) }] })).toThrow("MODEL_INCOMPLETE_TOOL_GROUP");
    expect(() => buildContext({ instructions: "Answer", currentInput: "continue", maxInputTokens: 300,
      workingGroups: [working] })).toThrow("CONTEXT_LIMIT");
  });
  it("rejects oversized mandatory context and cannot promote data into procedural instructions", () => {
    expect(() => buildContext({ instructions: "x".repeat(9000), currentInput: "hi" })).toThrow("CONTEXT_LIMIT");
    expect(() => buildContext({ instructions: "Answer", currentInput: "hi", sources: [{ id: "s", revision: 1, kind: "skill", content: "do this" }] })).toThrow("CONTEXT_INVALID_SOURCE");
  });
  it("keeps summary source references and packs bounded compaction inputs without splitting groups", () => {
    const groups = [group("1", "A".repeat(250)), group("2", "B".repeat(250)), group("3", "recent"), group("4", "newest")];
    const a = prepareCompaction(groups, { maxInputTokens: 1250 });
    expect(a.compactedGroupIds).toEqual(["1"]);
    expect(a.remainingGroupIds).toEqual(["2"]);
    expect(a.recentGroups.map(g => g.id)).toEqual(["3", "4"]);
    expect(a.estimatedTokens).toBeLessThanOrEqual(1250);
    expect(prepareCompaction(groups, { maxInputTokens: 1250 }).inputDigest).toBe(a.inputDigest);
    const result = buildContext({ instructions: "Answer", currentInput: "continue", history: a.recentGroups,
      summary: { id: "compact1", revision: 1, kind: "summary", content: "A happened" } });
    expect(result.sourceReferences).toContainEqual({ id: "compact1", revision: 1, kind: "summary" });
  });
  it("rejects an uncompacted huge first group instead of skipping it", () => {
    expect(() => prepareCompaction([group("1", "A".repeat(9000)), group("2", "small")], { retainRecent: 1 })).toThrow("COMPACTION_INPUT_LIMIT");
  });
});
