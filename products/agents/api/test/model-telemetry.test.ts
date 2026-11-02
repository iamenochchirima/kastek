import { randomUUID } from "node:crypto";
import { metrics } from "@opentelemetry/sdk-node";
import type { Meter } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { invokeObservedTaskModel } from "../src/execution/models/observed-invocation";
import { invokeTaskModel, type TaskModelInvocation, type TaskModelResponse } from "../src/execution/models/runtime";
import { createModelInvocationMetrics, modelInvocationEventSchema, subscribeModelTelemetry } from "../src/observability/model-telemetry";

vi.mock("../src/execution/models/runtime", () => ({ invokeTaskModel: vi.fn() }));
afterEach(() => vi.restoreAllMocks());
function invocation(): TaskModelInvocation {
  const rootTaskId = randomUUID(), taskId = randomUUID();
  const route = { binding: { connectionId: randomUUID(), providerId: "openai", protocol: "openai_responses", modelId: "fixture-model",
    adapterRevision: "fixture-1", credentialRevision: 3, role: "delegated" }, policy: { digest: "a".repeat(64) },
    model: { pricing: { currency: "USD", inputMicrosPerMillionTokens: 1000000, outputMicrosPerMillionTokens: 2000000, cachedInputMicrosPerMillionTokens: 100000 } } };
  return { pool: { query: () => { throw Error("Telemetry must not query the database"); } },
    execution: { models: { primary: route, compaction: { ...route, binding: { ...route.binding, role: "compaction" } } },
      task: { id: taskId, root_task_id: rootTaskId, organization_id: randomUUID(), harness_release: "fixture-release", input: "private customer text" } },
    operationId: `model:${taskId}:0`, role: "primary", messages: [{ role: "user", content: "private prompt" }], providerStore: { apiKey: "secret-key" } } as unknown as TaskModelInvocation;
}
function response(): TaskModelResponse {
  return { message: { role: "assistant", content: "private response" }, finishReason: "stop", usage: { observed: true,
    inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, cacheWriteTokens: 0, reasoningTokens: 3 } };
}
it("projects route, first visible token and observed usage without payloads or credentials", async () => {
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  const input = invocation(), onText = vi.fn(); input.onText = onText;
  vi.mocked(invokeTaskModel).mockImplementationOnce(async options => {
    options.onText?.(""); options.onText?.("private streamed text"); options.onText?.("more text");
    return { ...response(), modelIdentity:{requestedModelId:"fixture-model",returnedModelId:"fixture-model-snapshot",relation:"different"}, privateNativeState: { reasoning: "private signature" }, providerRequestId: "private request" } as TaskModelResponse;
  });
  expect((await invokeObservedTaskModel(input)).message.content).toBe("private response");
  expect(onText).toHaveBeenCalledTimes(3);
  const event = modelInvocationEventSchema.parse(JSON.parse(output.mock.calls[0]![0] as string));
  expect(event).toMatchObject({ outcome: "completed", providerId: "openai", modelId: "fixture-model", returnedModelId:"fixture-model-snapshot", modelIdentityRelation:"different", role: "delegated", usageStatus: "observed",
    inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, reasoningTokens: 3, costStatus: "estimate", costEstimateMicros: "19", firstVisibleTokenStatus: "observed", queueStatus: "unavailable" });
  expect(event.firstVisibleTokenMs).toBeGreaterThanOrEqual(0); expect(event.durationMs).toBeGreaterThanOrEqual(event.firstVisibleTokenMs!);
  expect(JSON.stringify(event)).not.toMatch(/private|secret-key|apiKey|messages|assistant|endpoint|providerRequestId/);
});
it("does not invent unavailable usage, token timing, costs or queue measurements", async () => {
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  vi.mocked(invokeTaskModel).mockResolvedValueOnce({ ...response(), finishReason: "tool_calls", usage: { observed: false, inputTokens: 999 } });
  await invokeObservedTaskModel(invocation());
  const event = JSON.parse(output.mock.calls[0]![0] as string);
  expect(event).toMatchObject({ outcome: "tool_calls", usageStatus: "unavailable", costStatus: "unavailable", firstVisibleTokenStatus: "unavailable", queueStatus: "unavailable" });
  for (const key of ["inputTokens", "outputTokens", "costEstimateMicros", "firstVisibleTokenMs", "queueMs"]) expect(event).not.toHaveProperty(key);
});
it.each([[401, "authorization"], [402, "credit"], [403, "authorization"], [404, "model_access"], [429, "rate_limit"], [504, "provider"]])("bounds status %s failures without logging the error", async (status, failureClass) => {
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = Object.assign(new Error("Bearer private credential and customer body"), { status, outcome: "uncertain", code: "HOSTILE_PROVIDER_BODY" });
  vi.mocked(invokeTaskModel).mockRejectedValueOnce(error);
  await expect(invokeObservedTaskModel(invocation())).rejects.toBe(error);
  expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ outcome: "uncertain", failureClass });
  expect(JSON.stringify(output.mock.calls)).not.toMatch(/Bearer|private|HOSTILE/);
});
it("reports a failed accepted stream as a provider failure while preserving uncertainty and first token timing", async () => {
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  const error = Object.assign(new Error("MODEL_STREAM_FAILED"), { code: "MODEL_STREAM_FAILED", status: 502, outcome: "uncertain" });
  vi.mocked(invokeTaskModel).mockImplementationOnce(async options => { options.onText?.("private partial output"); throw error; });
  await expect(invokeObservedTaskModel(invocation())).rejects.toBe(error);
  expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ outcome: "uncertain", failureClass: "provider", firstVisibleTokenStatus: "observed" });
  expect(JSON.stringify(output.mock.calls)).not.toContain("private partial output");
  expect(invokeTaskModel).toHaveBeenCalled();
});
it("keeps compaction distinct and observes quota rejection without converting it into a retry", async () => {
  const output = vi.spyOn(console, "info").mockImplementation(() => {});
  const input = invocation(); input.role = "compaction";
  const error = Object.assign(new Error("private budget"), { code: "MODEL_TOKEN_LIMIT", outcome: "rejected" });
  vi.mocked(invokeTaskModel).mockRejectedValueOnce(error);
  await expect(invokeObservedTaskModel(input)).rejects.toBe(error);
  expect(JSON.parse(output.mock.calls[0]![0] as string)).toMatchObject({ role: "compaction", outcome: "rejected", failureClass: "quota" });
});
it("does not wait for broken listeners or let a logger failure change the model outcome", async () => {
  vi.spyOn(console, "info").mockImplementation(() => { throw Error("Broken logger"); });
  const stops = [subscribeModelTelemetry(() => { throw Error("Broken exporter"); }),
    subscribeModelTelemetry(async () => { throw Error("Rejected exporter"); }), subscribeModelTelemetry(() => new Promise(() => {}))];
  vi.mocked(invokeTaskModel).mockResolvedValueOnce(response());
  try { expect((await invokeObservedTaskModel(invocation())).finishReason).toBe("stop"); }
  finally { stops.forEach(stop => stop()); }
});
it("keeps every metric label bounded and marks each missing measurement explicitly", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const points: { name: string; value: number; attributes: Record<string, string> }[] = [];
  const instrument = (name: string) => ({ record: (value: number, attributes: Record<string, string>) => points.push({ name, value, attributes }), add: (value: number, attributes: Record<string, string>) => points.push({ name, value, attributes }) });
  const stop = createModelInvocationMetrics({ createHistogram: instrument, createCounter: instrument } as unknown as Meter);
  vi.mocked(invokeTaskModel).mockResolvedValueOnce({ ...response(), usage: { observed: false } });
  const input = invocation(); input.execution.models.primary.binding.providerId = "unbounded-custom-provider";
  try {
    await invokeObservedTaskModel(input);
    expect(points.find(point => point.name === "agents.model.invocations")?.attributes).toEqual({ provider: "other", protocol: "openai_responses", role: "delegated", outcome: "completed" });
    expect(points.some(point => point.name === "agents.model.observed_tokens")).toBe(false);
    expect(points.filter(point => point.name === "agents.model.unavailable_measurements").map(point => point.attributes.measurement)).toContain("usage");
    expect(JSON.stringify(points)).not.toMatch(/fixture-model|connectionId|taskId|unbounded-custom/);
    for (const point of points) expect(Object.keys(point.attributes).sort()).toEqual(expect.arrayContaining(["provider", "protocol", "role", "outcome"].sort()));
  } finally { stop(); }
});

it("exports actual SDK invocation metrics with observed category subsets and no model identities", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const exporter = new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE);
  const reader = new metrics.PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 });
  const provider = new metrics.MeterProvider({ readers: [reader] });
  const stop = createModelInvocationMetrics(provider.getMeter("model-test"));
  vi.mocked(invokeTaskModel).mockImplementationOnce(async options => { options.onText?.("visible text"); return { ...response(), finishReason: "length" }; });
  try {
    await invokeObservedTaskModel(invocation());
    const { resourceMetrics } = await reader.collect();
    const data = resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics);
    const tokenPoints = data.find(metric => metric.descriptor.name === "agents.model.observed_tokens")!.dataPoints;
    expect(tokenPoints.map(point => [point.attributes.category, point.value])).toEqual(expect.arrayContaining([
      ["inputTokens", 10], ["outputTokens", 5], ["cacheReadTokens", 2], ["cacheWriteTokens", 0], ["reasoningTokens", 3],
    ]));
    const first = data.find(metric => metric.descriptor.name === "agents.model.first_visible_token_ms")!;
    expect(first.dataPoints).toHaveLength(1);
    expect(data.find(metric => metric.descriptor.name === "agents.model.cost_estimate_micros")!.dataPoints[0]!.value).toBe(19);
    expect(data.find(metric => metric.descriptor.name === "agents.model.invocations")!.dataPoints[0]!.attributes.outcome).toBe("truncated");
    expect(JSON.stringify(data)).not.toMatch(/fixture-model|private|connectionId|taskId|routeDigest|modelId/);
  } finally { stop(); await provider.shutdown(); }
});
