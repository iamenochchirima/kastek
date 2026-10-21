import { describe, expect, it, vi } from "vitest";
import {
  buildContext, prepareCompaction, validateCompaction,
  type ContextGroup, type ContextModelPolicy,
} from "../src/execution/context/context";
import type { ModelRequest, ToolDefinition } from "../src/execution/business/model";

// This synthetic counter differs from the logical byte estimate and native prepared-payload counters.
const countFixtureTokens = (request: ModelRequest) => request.messages.reduce((sum, message) => sum + (message.content?.length ?? 0) + 4, 0) +
  (request.tools ? JSON.stringify(request.tools).length : 0);
const policy = (changes: Partial<ContextModelPolicy> = {}): ContextModelPolicy => ({
  modelId: "lab/model-with-native-tokenizer", revision: "resolved-policy-v1", counterRevision: "fixture-token-counter-v1", maxDurationSeconds: 45, contextWindowTokens: 100000,
  maxInputTokens: 50000, maxOutputTokens: 20000, safetyTokens: 1000, maxMessages: 128, maxTools: 32,
  maxRequestBytes: 1000000, estimateRequestTokens: countFixtureTokens, ...changes,
});
const smallPolicy = (changes: Partial<ContextModelPolicy> = {}) => policy({
  contextWindowTokens: 5000, maxInputTokens: 3000, maxOutputTokens: 1000, safetyTokens: 100, ...changes,
});
const group = (id: string, content: string): ContextGroup => ({ id, messages: [{ role: "user", content }, { role: "assistant", content: "Confirmed" }] });
const tool = (name: string): ToolDefinition => ({
  type: "function", function: { name, description: "Read authorized data", parameters: { type: "object", properties: {} } },
});
const completeToolGroup = (): ContextGroup => ({ id: "working", messages: [
  { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "call-1", content: "Confirmed receipt" },
] });

describe("runtime-supplied context model policy", () => {
  it("requires an explicit policy instead of selecting an implicit model or tokenizer", () => {
    expect(() => buildContext({ instructions: "Answer", currentInput: "Hi" } as never)).toThrow("MODEL_POLICY_REQUIRED");
    expect(() => prepareCompaction([group("old", "Earlier"), group("recent", "Latest")], {} as never)).toThrow("MODEL_POLICY_REQUIRED");
  });
  it("accepts independent model IDs, larger output and context capacities using the supplied counter", () => {
    const counter = vi.fn(countFixtureTokens), modelPolicy = policy({ estimateRequestTokens: counter });
    const result = buildContext({ instructions: "Answer", currentInput: "é".repeat(12000), modelPolicy });
    expect(result.status).toBe("ready");
    expect(result.estimatedTokens).toBe(12014);
    expect(counter).toHaveBeenCalledWith(expect.objectContaining({ model: modelPolicy.modelId, maxInputTokens: 50000, maxOutputTokens: 20000, maxDurationSeconds: 45 }));
    expect(result.profileId).toBe(`${modelPolicy.modelId}@${modelPolicy.revision}`);
    expect(result.modelPolicy).toMatchObject({ contextWindowTokens: 100000, maxInputTokens: 50000, maxOutputTokens: 20000 });
    expect(result.modelPolicy).not.toHaveProperty("estimateRequestTokens");
    expect(result.modelPolicy?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([1.5, 1.001])("preserves millisecond call policies when assembling context: %s", maxDurationSeconds => {
    const result = buildContext({ instructions: "Answer", currentInput: "Hi", modelPolicy: policy({ maxDurationSeconds }) });
    expect(result.status).toBe("ready");
    expect(result.modelPolicy?.maxDurationSeconds).toBe(maxDurationSeconds);
  });

  it("pins model identity, policy revision and limits in context digests", () => {
    const input = { instructions: "Answer", currentInput: "Hi", modelPolicy: policy() };
    const original = buildContext(input);
    expect(buildContext(input)).toEqual(original);
    for (const changes of [{ modelId: "another-lab/model" }, { revision: "policy-v2" }, { counterRevision: "fixture-counter-v2" }, { maxDurationSeconds: 60 }, { maxOutputTokens: 19000 }, { maxRequestBytes: 900000 }]) {
      const next = buildContext({ ...input, modelPolicy: policy(changes) });
      expect(next.digest).not.toBe(original.digest);
      expect(next.modelPolicy?.digest).not.toBe(original.modelPolicy?.digest);
    }
  });

  it("enforces profile ceilings rather than permitting request overrides or a different selected model", () => {
    const input = { instructions: "Answer", currentInput: "Hi", modelPolicy: smallPolicy() };
    expect(() => buildContext({ ...input, model: "another/model" })).toThrow("MODEL_PROFILE_UNSUPPORTED");
    expect(() => buildContext({ ...input, maxInputTokens: 3001 })).toThrow("MODEL_REQUEST_LIMIT");
    expect(() => buildContext({ ...input, maxOutputTokens: 1001 })).toThrow("MODEL_REQUEST_LIMIT");
    expect(buildContext({ ...input, maxInputTokens: 1000, maxOutputTokens: 500 }).status).toBe("ready");
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid injected token counts: %s", count => {
    expect(() => buildContext({ instructions: "Answer", currentInput: "Hi", modelPolicy: policy({ estimateRequestTokens: () => count }) }))
      .toThrow("MODEL_TOKEN_ESTIMATE_INVALID");
  });

  it("sanitizes counter failures without silently falling back to byte counts", () => {
    expect(() => buildContext({ instructions: "Answer", currentInput: "Hi", modelPolicy: policy({ estimateRequestTokens: () => { throw new Error("private counter failure"); } }) }))
      .toThrow("MODEL_TOKEN_ESTIMATE_INVALID");
  });

  it.each([
    { contextWindowTokens: 0 }, { maxInputTokens: -1 }, { maxOutputTokens: 0 }, { maxMessages: 0 },
    { maxRequestBytes: 0 }, { maxTools: -1 }, { safetyTokens: -1 }, { contextWindowTokens: 60000 }, { maxDurationSeconds: 0 }, { maxDurationSeconds: Infinity }, { maxDurationSeconds: NaN }, { maxDurationSeconds: 0.0001 },
  ])("validates explicit policy bounds and context reserve relationships: %j", changes => {
    expect(() => buildContext({ instructions: "Answer", currentInput: "Hi", modelPolicy: policy(changes) })).toThrow("MODEL_REQUEST_LIMIT");
  });

  it("compares context reserve relationships safely at integer boundaries", () => {
    const modelPolicy = policy({ contextWindowTokens: Number.MAX_SAFE_INTEGER, maxInputTokens: Number.MAX_SAFE_INTEGER - 10, maxOutputTokens: 10, safetyTokens: 1 });
    expect(() => buildContext({ instructions: "Answer", currentInput: "Hi", modelPolicy })).toThrow("MODEL_REQUEST_LIMIT");
  });

  it.each(["", " ", "x".repeat(129)])("requires an explicit bounded counter revision: %s", counterRevision => {
    expect(() => buildContext({ instructions: "Answer", currentInput: "Hi", modelPolicy: policy({ counterRevision }) })).toThrow("MODEL_PROFILE_UNSUPPORTED");
  });

  it("separates request-byte envelopes from token estimates", () => {
    const modelPolicy = smallPolicy({ estimateRequestTokens: () => 1, maxRequestBytes: 300 });
    expect(() => buildContext({ instructions: "Answer", currentInput: "😀".repeat(100), modelPolicy })).toThrow("CONTEXT_LIMIT");
  });

  it("uses the selected message/tool limits and still validates tool definitions", () => {
    const tools = Array.from({ length: 20 }, (_, index) => tool(`lookup_${index}`));
    expect(buildContext({ instructions: "Answer", currentInput: "Hi", tools, modelPolicy: policy() }).status).toBe("ready");
    expect(() => buildContext({ instructions: "Answer", currentInput: "Hi", tools, modelPolicy: policy({ maxTools: 19 }) })).toThrow("MODEL_REQUEST_LIMIT");
    expect(() => buildContext({ instructions: "Answer", currentInput: "Hi", modelPolicy: policy({ maxMessages: 1 }) })).toThrow("CONTEXT_LIMIT");
    for (const definitions of [[tool("same"), tool("same")], [tool("invalid name")], [{ ...tool("bad"), function: { ...tool("bad").function, parameters: [] } }]]) {
      expect(() => buildContext({ instructions: "Answer", currentInput: "Hi", tools: definitions as ToolDefinition[], modelPolicy: policy() })).toThrow("MODEL_INVALID_TOOLS");
    }
  });

  it("keeps complete mandatory tool groups and refuses orphaned or overflowing protected content", () => {
    const working = completeToolGroup();
    const result = buildContext({ instructions: "Answer", currentInput: "Continue", workingGroups: [working], modelPolicy: smallPolicy() });
    expect(result.messages.slice(-2)).toEqual(working.messages);
    expect(() => buildContext({ instructions: "Answer", currentInput: "Continue", workingGroups: [{ ...working, messages: working.messages.slice(1) }], modelPolicy: smallPolicy() }))
      .toThrow("MODEL_ORPHAN_TOOL_RESULT");
    expect(() => buildContext({ instructions: "Answer", currentInput: "Continue", workingGroups: [{ ...working, messages: working.messages.slice(0, 1) }], modelPolicy: smallPolicy() }))
      .toThrow("MODEL_INCOMPLETE_TOOL_GROUP");
    working.messages[1]!.content = "x".repeat(4000);
    expect(() => buildContext({ instructions: "Answer", currentInput: "Continue", workingGroups: [working], modelPolicy: smallPolicy() })).toThrow("CONTEXT_LIMIT");
  });

  it("never truncates exact evidence passages or mandatory procedural instructions", () => {
    const source = { id: "exact", revision: 1, kind: "knowledge" as const, content: "x".repeat(5000), evidenceId: "evidence-1" };
    const result = buildContext({ instructions: "Answer", currentInput: "Continue", sources: [source], modelPolicy: smallPolicy() });
    expect(result.sourceReferences).toEqual([]);
    expect(result.messages.some(message => message.content?.includes('"sourceId":"exact"'))).toBe(false);
    expect(source.content).toHaveLength(5000);
    expect(() => buildContext({ instructions: "Answer", currentInput: "Continue", skills: [{ ...source, kind: "skill" }], modelPolicy: smallPolicy() })).toThrow("CONTEXT_LIMIT");
  });

  it("packs a contiguous history tail and marks source excerpts without byte/token conversion", () => {
    const modelPolicy = smallPolicy({ estimateRequestTokens: request => Math.ceil(countFixtureTokens(request) / 4) });
    const result = buildContext({ instructions: "Answer", currentInput: "Continue", modelPolicy,
      history: [group("old", "x".repeat(13000)), group("recent", "Recent record")],
      sources: [{ id: "long", revision: 1, kind: "knowledge", content: "😀".repeat(20000) }],
    });
    expect(result.status).toBe("compaction_required");
    expect(result.historyGroupIds).toEqual(["recent"]);
    expect(result.omittedHistoryGroupIds).toEqual(["old"]);
    expect(result.estimatedTokens).toBeLessThanOrEqual(3000);
    const excerpt = result.messages.find(message => message.content?.includes('"sourceId":"long"'))!;
    expect(excerpt.content).toContain('"excerpt":true');
    expect(excerpt.content).not.toContain("�");
    expect(JSON.parse(excerpt.content!.slice(excerpt.content!.indexOf("{"))).content.length).toBeGreaterThan(3000);
  });
});

describe("role-specific compaction context policy", () => {
  it("uses its own model, counter and output policy and pins them in a verifiable plan", () => {
    const modelPolicy = smallPolicy({ modelId: "compaction-lab/model", maxOutputTokens: 500 });
    const groups = [group("old", "Earlier confirmed outcome"), group("recent", "Latest outcome")];
    const options = { modelPolicy, retainRecent: 1 };
    const plan = prepareCompaction(groups, options);
    expect(plan.compactedGroupIds).toEqual(["old"]);
    expect(plan.recentGroups).toEqual([groups[1]]);
    expect(plan.profileId).toBe(`${modelPolicy.modelId}@${modelPolicy.revision}`);
    expect(plan.modelPolicy?.maxOutputTokens).toBe(500);
    expect(plan.modelPolicy).not.toHaveProperty("estimateRequestTokens");
    expect(() => validateCompaction(plan, options)).not.toThrow();
    expect(() => validateCompaction(plan, { ...options, modelPolicy: { ...modelPolicy, revision: "new-policy" } })).toThrow("COMPACTION_PLAN_INVALID");
    expect(() => validateCompaction(plan, { ...options, modelPolicy: { ...modelPolicy, modelId: "another/model" } })).toThrow("COMPACTION_PLAN_INVALID");
    expect(() => validateCompaction(plan, undefined as never)).toThrow("MODEL_POLICY_REQUIRED");
  });

  it("retains complete compaction groups within role-specific request/message envelopes", () => {
    const groups = [group("one", "A".repeat(500)), group("two", "B".repeat(500)), group("three", "C".repeat(500)), group("recent", "Newest")];
    const modelPolicy = smallPolicy({ maxMessages: 3 });
    const plan = prepareCompaction(groups, { modelPolicy, retainRecent: 1 });
    expect(plan.compactedGroupIds).toEqual(["one", "two"]);
    expect(plan.remainingGroupIds).toEqual(["three"]);
    expect(plan.recentGroups.map(group => group.id)).toEqual(["recent"]);
    expect(() => validateCompaction(plan, { modelPolicy })).not.toThrow();
    expect(() => prepareCompaction(groups, { modelPolicy: { ...modelPolicy, maxRequestBytes: 100 }, retainRecent: 1 })).toThrow("COMPACTION_INPUT_LIMIT");
  });

  it("rejects orphan results even in retained groups and refuses to skip an oversized first group", () => {
    const modelPolicy = smallPolicy();
    const orphan: ContextGroup = { id: "orphan", messages: [{ role: "tool", content: "Receipt", tool_call_id: "missing" }] };
    expect(() => prepareCompaction([group("old", "Confirmed"), orphan], { modelPolicy, retainRecent: 1 })).toThrow("MODEL_ORPHAN_TOOL_RESULT");
    expect(() => prepareCompaction([group("huge", "x".repeat(10000)), group("small", "Small"), group("recent", "Newest")], { modelPolicy, retainRecent: 1 }))
      .toThrow("COMPACTION_INPUT_LIMIT");
    expect(() => prepareCompaction([group("same", "First"), group("same", "Second")], { modelPolicy, retainRecent: 1 })).toThrow("CONTEXT_INVALID_GROUP");
  });

  it("detects tampered messages, estimates, group identities and missing model policy metadata", () => {
    const modelPolicy = smallPolicy(), options = { modelPolicy, retainRecent: 1 };
    const original = prepareCompaction([group("old", "Confirmed"), group("recent", "Newest")], options);
    for (const tamper of [
      (plan: typeof original) => { plan.messages[1]!.content = "Changed"; },
      (plan: typeof original) => { plan.estimatedTokens++; },
      (plan: typeof original) => { plan.compactedGroupIds[0] = "another-group"; },
      (plan: typeof original) => { delete plan.modelPolicy; },
    ]) {
      const plan = structuredClone(original);
      tamper(plan);
      expect(() => validateCompaction(plan, options)).toThrow("COMPACTION_PLAN_INVALID");
    }
  });
});
