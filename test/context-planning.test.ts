import { describe, expect, it } from "vitest";
import {
  accountProviderUsage,
  estimateApproximateTokens,
  planProviderRequest,
  resolveContextSoftThreshold,
  resolveContextRetainedMessageUnitLimit,
  type ProviderContextProfile,
} from "../src/runtime/context-planning";

const profile: ProviderContextProfile = {
  provider: "openai",
  model: "test-model",
  contextWindowTokens: 1_000,
  maxOutputTokens: 200,
  safetyMarginTokens: 50,
  charsPerToken: 4,
  capabilitySource: "configured_override",
};

const policy = {
  requestedOutputTokens: 120,
  maxToolSchemaTokens: 500,
  maxToolResultTokens: 20,
};

describe("provider context planning", () => {
  it("does not infer configured provenance for an unlabelled profile", () => {
    const plan = planProviderRequest({
      profile: { provider: "openai", model: "unlabelled", contextWindowTokens: 1_000, maxOutputTokens: 200 },
      policy,
      messages: [{ role: "user", content: "current question" }],
      tools: [],
    });

    expect(plan.accounting.capabilitySource).toBe("unknown");
  });

  it("rejects an incomplete tool round before provider admission", () => {
    const plan = planProviderRequest({
      profile,
      policy,
      messages: [
        { role: "user", content: "look it up" },
        { role: "assistant", content: "", toolCalls: [{ id: "provider-call", runtimeOperationId: "runtime-call", name: "records.lookup", arguments: {} }] },
      ],
    });

    expect(plan).toMatchObject({ status: "rejected", decision: "cannot_fit", rejection: { code: "transcript_projection_invalid" } });
    expect(plan.diagnostics.reasons).toContain("transcript_projection_invalid");
  });

  it("plans against provider capacity and exposes approximate accounting", () => {
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, requestedOutputTokens: 250 },
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "current question" },
      ],
      tools: [{ name: "read", description: "Read a record", inputSchema: { type: "object" } }],
    });

    expect(plan.status).toBe("fits");
    expect(plan.decision).toBe("ready");
    expect(plan.accounting.method).toBe("approximate_characters");
    expect(plan.accounting.basis).toBe("full_estimate");
    expect(plan.accounting.capabilitySource).toBe("configured_override");
    expect(plan.accounting.categories.output_reservation).toBe(200);
    expect(plan.accounting.categories.tool_schemas).toBeGreaterThan(0);
    expect(plan.diagnostics.reasons).toContain("provider_output_cap");
    expect(plan.accounting.categories.safety_margin).toBe(50);
    expect(plan.accounting.reservedRequestTokens).toBeLessThanOrEqual(1_000);
    expect(plan.accounting).toMatchObject({
      hardLimitTokens: 750,
      softThresholdTokens: 637,
      pressure: "normal",
    });
    expect(plan.manifest).toMatchObject({
      estimatedInputTokens: plan.accounting.estimatedInputTokens,
      reservedOutputTokens: 200,
      safetyMarginTokens: 50,
      estimatedRequestBytes: expect.any(Number),
    });
    expect(plan.manifest.components.every((component) => component.estimatedBytes >= 0)).toBe(true);
    expect(JSON.stringify(plan.manifest)).not.toContain("old question");
    expect(JSON.stringify(plan.manifest)).not.toContain("Read a record");
  });

  it("applies the agent policy ceiling after provider capacity resolution", () => {
    const plan = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 128_000, policyLimitTokens: 1_000 },
      policy,
      messages: [{ role: "user", content: "current question" }],
    });
    // The policy ceiling controls fit decisions, but telemetry and manifests
    // must retain the provider's verified model capacity.
    expect(plan.accounting.providerContextWindowTokens).toBe(128_000);
    expect(plan.accounting.inputBudgetTokens).toBe(830);
    expect(plan.accounting.reservedRequestTokens).toBeLessThanOrEqual(1_000);
  });

  it("does not turn an unbounded provider window into a legacy policy window", () => {
    const plan = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 1_050_000, policyLimitTokens: undefined },
      policy,
      messages: [{ role: "user", content: "current question" }],
    });

    expect(plan.status).toBe("fits");
    expect(plan.accounting.providerContextWindowTokens).toBe(1_050_000);
    expect(plan.manifest.providerContextWindowTokens).toBe(1_050_000);
    expect(plan.accounting.hardLimitTokens).toBe(1_049_830);
  });

  it("carries durable request identity without copying prompt content into the manifest", () => {
    const plan = planProviderRequest({
      profile,
      policy,
      messages: [{ role: "system", content: "private system" }, { role: "user", content: "private task" }],
      identity: {
        turnId: "turn-1",
        modelAttemptId: "run-1:1:0",
        compactionGeneration: 3,
        sourceEventBoundaryDigest: "boundary-digest",
        providerRequestId: "provider-request-1",
      },
    });

    expect(plan.manifest.identity).toEqual({
      turnId: "turn-1",
      requestManifestId: expect.stringContaining("context-manifest:run-1:1:0:"),
      modelAttemptId: "run-1:1:0",
      compactionGeneration: 3,
      sourceEventBoundaryDigest: "boundary-digest",
      providerRequestId: "provider-request-1",
    });
    expect(JSON.stringify(plan.manifest)).not.toContain("private system");
    expect(JSON.stringify(plan.manifest)).not.toContain("private task");
  });

  it("reports soft pressure from usable input capacity without confusing it with a hard rejection", () => {
    const plan = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 1_000, safetyMarginTokens: 0 },
      policy: { ...policy, requestedOutputTokens: 100, softThresholdTokens: 200 },
      messages: [{ role: "user", content: "x".repeat(800) }],
    });
    expect(plan.status).toBe("fits");
    expect(plan.accounting).toMatchObject({ hardLimitTokens: 900, softThresholdTokens: 200, pressure: "soft" });
  });

  it("uses the Hermes-aligned default pressure threshold by provider capacity", () => {
    const large = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 600_000, maxOutputTokens: 1_000, safetyMarginTokens: 100 },
      policy: { ...policy, requestedOutputTokens: 1_000 },
      messages: [{ role: "user", content: "small" }],
    });
    const small = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 100_000, maxOutputTokens: 1_000, safetyMarginTokens: 100 },
      policy: { ...policy, requestedOutputTokens: 1_000 },
      messages: [{ role: "user", content: "small" }],
    });
    expect(large.accounting.softThresholdTokens).toBe(Math.floor(598_900 * 0.5));
    expect(small.accounting.softThresholdTokens).toBe(Math.floor(98_900 * 0.75));
  });

  it("caps the minimum-floor threshold before it becomes unreachable", () => {
    expect(resolveContextSoftThreshold(64_000, undefined, 64_000)).toBe(54_400);
    expect(resolveContextSoftThreshold(10_000, undefined, 10_000)).toBe(8_500);
  });

  it("carries canonical transcript cursor and generation into the manifest identity", () => {
    const plan = planProviderRequest({
      profile: { provider: "test", model: "small", contextWindowTokens: 8_192 },
      policy: { requestedOutputTokens: 256, maxToolSchemaTokens: 100, maxToolResultTokens: 100 },
      messages: [{ role: "user", content: "hello" }],
      identity: { sourceCursor: 42, sourceGeneration: 3, sourceEventBoundaryDigest: "a".repeat(64) },
    });

    expect(plan.manifest.identity).toMatchObject({ sourceCursor: 42, sourceGeneration: 3 });
  });

  it("tightens the durable retained tail for token pressure even below the unit ceiling", () => {
    const retained = resolveContextRetainedMessageUnitLimit({
      messages: [
        { role: "user", content: "x".repeat(1_000) },
        { role: "assistant", content: "y".repeat(1_000) },
        { role: "user", content: "z".repeat(1_000) },
        { role: "assistant", content: "w".repeat(1_000) },
      ],
      hardLimitTokens: 1_000,
      providerContextWindowTokens: 10_000,
      configuredMaxUnits: 20,
    });

    expect(retained).toBe(1);
  });

  it("rejects serialized payload pressure independently from token pressure", () => {
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, maxRequestBytes: 32 },
      messages: [{ role: "user", content: "a request that is larger than thirty-two bytes" }],
    });
    expect(plan).toMatchObject({ status: "rejected", decision: "cannot_fit", rejection: { code: "request_payload_exceeds_byte_budget" }, diagnostics: { reasons: expect.arrayContaining(["payload_byte_budget"]), estimatedRequestBytes: expect.any(Number) } });
  });

  it("uses the provider adapter envelope measurement before admitting older history", () => {
    const estimateProviderEnvelope = ({ messages, tools }: { messages: readonly unknown[]; tools: readonly unknown[] }) =>
      Buffer.byteLength(JSON.stringify({ providerWrapper: true, messages, tools }), "utf8");
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, requestedOutputTokens: 100, maxRequestBytes: 180 },
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "older request with enough content to cross the provider wrapper limit" },
        { role: "user", content: "current" },
      ],
      requestBytesEstimator: estimateProviderEnvelope,
    });

    expect(plan.status).toBe("compacted");
    expect(plan.diagnostics.omittedMessageCount).toBe(1);
    expect(plan.messages.at(-1)?.content).toBe("current");
    expect(plan.manifest.estimatedRequestBytes).toBe(estimateProviderEnvelope({ messages: plan.messages, tools: plan.tools }));
  });

  it("compacts older message units without splitting an assistant tool pair", () => {
    const plan = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 180, safetyMarginTokens: 20 },
      policy: { ...policy, requestedOutputTokens: 40, maxToolResultTokens: 50 },
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "old ".repeat(120) },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: { query: "x" } }] },
        { role: "tool", name: "lookup", toolCallId: "call-1", content: "result" },
        { role: "user", content: "latest" },
      ],
    });

    expect(plan.status).toBe("compacted");
    expect(plan.decision).toBe("compact");
    expect(plan.diagnostics.protectedPairCount).toBe(1);
    expect(plan.messages.some((message) => message.toolCallId === "call-1")).toBe(true);
    expect(plan.messages.some((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.id === "call-1"))).toBe(true);
    expect(plan.diagnostics.omittedMessageCount).toBeGreaterThan(0);
  });

  it("limits tool schemas and tool results instead of allowing either to consume the request", () => {
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, maxToolSchemaTokens: 30, maxToolResultTokens: 4 },
      tools: [
        { name: "first", description: "x".repeat(100), inputSchema: { type: "object" } },
        { name: "second", description: "y".repeat(100), inputSchema: { type: "object" } },
      ],
      messages: [
        { role: "system", content: "policy" },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "first", arguments: {} }] },
        { role: "tool", name: "first", toolCallId: "call-1", content: "result ".repeat(20) },
        { role: "user", content: "current" },
      ],
    });

    expect(plan.tools).toHaveLength(0);
    expect(plan.decision).toBe("prune");
    expect(plan.diagnostics.omittedToolCount).toBe(2);
    expect(plan.diagnostics.truncatedToolResultCount).toBe(1);
    expect(plan.messages.find((message) => message.role === "tool")?.content.length).toBeLessThanOrEqual(16);
  });

  it("uses bounded digest references for oversized tool results without mutating the source transcript", () => {
    const sourceMessages = [
      { role: "system" as const, content: "policy" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] },
      { role: "tool" as const, name: "lookup", toolCallId: "call-1", content: "result ".repeat(20) },
      { role: "user" as const, content: "current" },
    ];
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, maxToolResultTokens: 4 },
      messages: sourceMessages,
    });

    expect(plan.decision).toBe("prune");
    expect(plan.diagnostics.toolResultReferenceCount).toBe(1);
    expect(plan.messages.find((message) => message.role === "tool")?.content).toMatch(/^\[ref:/);
    expect(plan.messages.find((message) => message.role === "tool")?.content.length).toBeLessThanOrEqual(16);
    expect(plan.manifest.sourceMessageCount).toBe(sourceMessages.length);
    expect(sourceMessages[2]?.content).toBe("result ".repeat(20));
  });

  it("keeps the newest duplicate tool result and references only the older copy", () => {
    const duplicate = "same durable result ".repeat(5);
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, maxToolResultTokens: 40 },
      messages: [
        { role: "assistant", content: "", toolCalls: [
          { id: "call-old", name: "lookup", arguments: {} },
          { id: "call-new", name: "lookup", arguments: {} },
        ] },
        { role: "tool", name: "lookup", toolCallId: "call-old", content: duplicate },
        { role: "tool", name: "lookup", toolCallId: "call-new", content: duplicate },
        { role: "user", content: "current" },
      ],
    });

    const toolMessages = plan.messages.filter((message) => message.role === "tool");
    expect(plan.diagnostics.toolResultReferenceCount).toBe(1);
    expect(toolMessages[0]?.content).toMatch(/^\[ref:/);
    expect(toolMessages[1]?.content).toBe(duplicate);
  });

  it("removes blank assistant echoes and stale reasoning/media replay fields from older assistant envelopes", () => {
    const plan = planProviderRequest({
      profile,
      policy,
      messages: [
        { role: "system", content: "policy" },
        { role: "assistant", content: JSON.stringify({ text: "old answer", reasoning_content: "private chain", images: [{ url: "old-image" }] }) },
        { role: "assistant", content: "" },
        { role: "assistant", content: "new answer" },
        { role: "user", content: "current" },
      ],
    });

    expect(plan.decision).toBe("prune");
    expect(plan.diagnostics.blankAssistantEchoCount).toBe(1);
    expect(plan.diagnostics.staleReplayArtifactCount).toBe(2);
    expect(plan.messages.some((message) => message.role === "assistant" && message.content === "")).toBe(false);
    const oldEnvelope = plan.messages.find((message) => message.role === "assistant" && message.content.includes("old answer"));
    expect(oldEnvelope?.content).not.toContain("reasoning_content");
    expect(oldEnvelope?.content).not.toContain("images");
  });

  it("keeps an explicit current-message index stable after wire-only pruning", () => {
    const plan = planProviderRequest({
      profile,
      policy,
      currentMessageIndex: 5,
      messages: [
        { role: "user", content: "old" },
        { role: "assistant", content: "" },
        { role: "assistant", content: JSON.stringify({ text: "old answer", reasoning: "stale" }) },
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] },
        { role: "tool", name: "lookup", toolCallId: "call-1", content: "result" },
        { role: "user", content: "the active task" },
      ],
    });

    expect(plan.messages.at(-1)).toMatchObject({ role: "user", content: "the active task" });
    expect(plan.manifest.selectedMessageCount).toBeGreaterThan(0);
  });

  it("returns a typed rejection when the current user message cannot fit", () => {
    const plan = planProviderRequest({
      profile: { ...profile, contextWindowTokens: 100, safetyMarginTokens: 20 },
      policy: { ...policy, requestedOutputTokens: 60 },
      messages: [{ role: "system", content: "policy" }, { role: "user", content: "x".repeat(1_000) }],
    });

    expect(plan.status).toBe("rejected");
    expect(plan.decision).toBe("cannot_fit");
    if (plan.status === "rejected") expect(plan.rejection.code).toBe("current_message_cannot_fit");
  });

  it("keeps the active user task when the historical-unit allowance is zero", () => {
    const plan = planProviderRequest({
      profile,
      policy: { ...policy, maxMessageUnits: 0 },
      messages: [{ role: "system", content: "policy" }, { role: "user", content: "active task" }],
      currentMessageIndex: 1,
    });

    expect(plan.messages.at(-1)).toEqual({ role: "user", content: "active task" });
  });

  it("accounts provider usage separately from the approximate plan", () => {
    const plan = planProviderRequest({ profile, policy, messages: [{ role: "user", content: "hello" }] });
    const accepted = accountProviderUsage(plan, { inputTokens: 100, outputTokens: 20 });
    expect(accepted.status).toBe("accepted");
    expect(accepted.source).toBe("provider_reported");
    expect(accepted.basis).toBe("provider_reported");

    const overrun = accountProviderUsage(plan, { inputTokens: plan.accounting.inputBudgetTokens + 1, outputTokens: 20 });
    expect(overrun.status).toBe("provider_overrun");
    expect(overrun.issues).toContain("provider_input_exceeded_planned_budget");

    expect(accountProviderUsage(plan, { inputTokens: -1, outputTokens: 2 }).status).toBe("invalid_usage");
  });

  it("does not present missing provider usage as zero or authoritative telemetry", () => {
    const plan = planProviderRequest({ profile, policy, messages: [{ role: "user", content: "hello" }] });
    const unavailable = accountProviderUsage(plan, {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokensReported: false,
      outputTokensReported: false,
      totalTokensReported: false,
    });
    expect(unavailable).toMatchObject({
      status: "usage_unavailable",
      source: "estimated",
      basis: "full_estimate",
      inputTokens: plan.accounting.estimatedInputTokens,
    });
    expect(unavailable.issues).toEqual(["provider_input_usage_unavailable", "provider_output_usage_unavailable"]);
  });

  it("labels the estimator as approximate and remains deterministic", () => {
    expect(estimateApproximateTokens("1234")).toBe(1);
    expect(estimateApproximateTokens("12345")).toBe(2);
  });
});
