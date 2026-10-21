import { z } from "zod";
import policies from "./compatible-profile-policies.json";
import { ProviderTransportError, type ProviderTransportRequest } from "../../contracts/model-transport";

const policySchema = z.strictObject({ providerId: z.string().min(1), streamUsage: z.boolean(), toolResultName: z.boolean(),
  contextOverflowError: z.boolean(), docs: z.string().url() });
const reviewed = new Map(z.array(policySchema).parse(policies).map(policy => [policy.providerId, Object.freeze(policy)]));

/** Compatibility is an adapter revision decision, independent of model capability or account access. */
export function compatibleProfile(request: ProviderTransportRequest) {
  const policy = reviewed.get(request.provider);
  if (!policy) return undefined;
  if (request.protocol !== "openai_chat_completions") throw new ProviderTransportError("MODEL_PROTOCOL_UNSUPPORTED", "rejected", 400);
  // Model-specific effort/thinking controls need a separate reviewed contract; never forward SDK options unchecked.
  if (request.reasoning && Object.keys(request.reasoning).length) {
    throw new ProviderTransportError("MODEL_REASONING_OPTIONS_UNSUPPORTED", "rejected", 400);
  }
  return policy;
}

export function compatibleSdkSettings(request: ProviderTransportRequest) {
  const policy = compatibleProfile(request);
  return policy ? { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
    supportsStrictMode: false, supportsUsageInStreaming: policy.streamUsage, requiresToolResultName: policy.toolResultName,
    requiresThinkingAsText: false, maxTokensField: "max_tokens" as const } : undefined;
}

export function prepareCompatiblePayload(request: ProviderTransportRequest, payload: Record<string, unknown>): void {
  const policy = compatibleProfile(request);
  if (!policy) return;
  if (policy.contextOverflowError) payload.context_length_exceeded_behavior = "error";
  // Preserve vendor defaults. A generic SDK must not choose or disable a model's native thinking mode.
  for (const field of ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs", "store", "temperature"]) delete payload[field];
  if (!policy.streamUsage) delete payload.stream_options;
}
