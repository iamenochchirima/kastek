import { z } from "zod";
import type { Meter } from "@opentelemetry/api";
import { requestDigest } from "../contracts/contracts";
import { modelIdSchema, modelProtocolSchema, modelRoleSchema } from "../contracts/model-providers";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const elapsed = z.number().finite().nonnegative();
export const modelInvocationEventSchema = z.strictObject({
  event: z.literal("model.invocation"), traceId: z.string().regex(/^[a-f0-9]{32}$/),
  organizationId: z.uuid(), rootTaskId: z.uuid(), taskId: z.uuid(), operationId: z.string().min(1).max(256),
  connectionId: z.uuid(), providerId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  protocol: modelProtocolSchema, modelId: modelIdSchema, role: modelRoleSchema,
  routeDigest: z.string().regex(/^[a-f0-9]{64}$/), policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  adapterRevision: z.string().min(1).max(128), runtimeRelease: z.string().min(1).max(128),
  outcome: z.enum(["completed", "tool_calls", "refused", "truncated", "rejected", "uncertain", "cancelled"]),
  failureClass: z.enum(["authorization", "credit", "rate_limit", "model_access", "quota", "context", "timeout", "cancelled", "provider", "internal"]).optional(),
  durationMs: elapsed, firstVisibleTokenMs: elapsed.optional(),
  firstVisibleTokenStatus: z.enum(["observed", "unavailable"]),
  queueStatus: z.enum(["unavailable", "observed"]), queueMs: elapsed.optional(),
  usageStatus: z.enum(["observed", "unavailable"]),
  inputTokens: count.optional(), outputTokens: count.optional(), cacheReadTokens: count.optional(),
  cacheWriteTokens: count.optional(), reasoningTokens: count.optional(),
  costStatus: z.enum(["estimate", "unavailable"]), costEstimateMicros: z.string().regex(/^(0|[1-9][0-9]{0,18})$/).optional(),
}).superRefine((event, context) => {
  for (const [status, field, observed] of [[event.firstVisibleTokenStatus, "firstVisibleTokenMs", "observed"],
    [event.queueStatus, "queueMs", "observed"], [event.costStatus, "costEstimateMicros", "estimate"]] as const) {
    if ((status === observed) !== (event[field] !== undefined)) context.addIssue({ code: "custom", path: [field], message: "Measurement must agree with its availability" });
  }
  if (event.usageStatus === "unavailable" && [event.inputTokens,event.outputTokens,event.cacheReadTokens,event.cacheWriteTokens,event.reasoningTokens].some(value=>value!==undefined)) {
    context.addIssue({ code: "custom", path: ["usageStatus"], message: "Unavailable usage cannot contain token observations" });
  }
});
export type ModelInvocationEvent = z.infer<typeof modelInvocationEventSchema>;
type Listener = (event: ModelInvocationEvent) => void | Promise<void>;
const listeners = new Set<Listener>();
export function subscribeModelTelemetry(listener: Listener): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** No messages, errors, endpoints or native protocol objects pass this strict scalar projection. */
export function emitModelInvocation(input: ModelInvocationEvent): void {
  const event = modelInvocationEventSchema.parse(input);
  try { console.info(JSON.stringify(event)); } catch { /* Logging cannot change model settlement. */ }
  for (const listener of listeners) try {
    const result = listener(event);
    if (result && typeof result.catch === "function") void result.catch(() => { /* Exporters are best effort. */ });
  } catch { /* Exporters are best effort. */ }
}
const providers = new Set(["openrouter", "openai", "anthropic", "google", "xai", "deepseek", "mistral", "groq", "together", "fireworks", "moonshot", "zai"]);
/** Process-local attempts only. Database usage ledgers remain the accounting authority. */
export function createModelInvocationMetrics(meter: Meter): () => void {
  const attempts = meter.createCounter("agents.model.invocations");
  const duration = meter.createHistogram("agents.model.duration_ms", { unit: "ms" });
  const first = meter.createHistogram("agents.model.first_visible_token_ms", { unit: "ms" });
  const queue = meter.createHistogram("agents.model.queue_ms", { unit: "ms" });
  const tokens = meter.createCounter("agents.model.observed_tokens", { unit: "{token}" });
  const unavailable = meter.createCounter("agents.model.unavailable_measurements");
  const costs = meter.createCounter("agents.model.cost_estimate_micros", { unit: "{USD_micros}" });
  const saturation = meter.createCounter("agents.model.quota_rejections");
  return subscribeModelTelemetry(event => {
    const attributes = { provider: providers.has(event.providerId) ? event.providerId : "other", protocol: event.protocol,
      role: event.role, outcome: event.outcome };
    attempts.add(1, attributes); duration.record(event.durationMs, attributes);
    if (event.firstVisibleTokenMs !== undefined) first.record(event.firstVisibleTokenMs, attributes);
    else unavailable.add(1, { ...attributes, measurement: "first_visible_token" });
    if (event.queueMs !== undefined) queue.record(event.queueMs, attributes);
    else unavailable.add(1, { ...attributes, measurement: "queue" });
    if (event.usageStatus === "unavailable") unavailable.add(1, { ...attributes, measurement: "usage" });
    for (const category of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
      if (event[category] !== undefined) tokens.add(event[category], { ...attributes, category });
      else unavailable.add(1, { ...attributes, measurement: category });
    }
    if (event.costEstimateMicros !== undefined && BigInt(event.costEstimateMicros) <= BigInt(Number.MAX_SAFE_INTEGER)) {
      costs.add(Number(event.costEstimateMicros), attributes);
    } else unavailable.add(1, { ...attributes, measurement: "cost" });
    if (event.failureClass === "quota") saturation.add(1, attributes);
  });
}
export function modelTraceId(rootTaskId: string): string { return requestDigest(rootTaskId).slice(0, 32); }
