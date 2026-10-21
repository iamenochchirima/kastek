import { randomUUID } from "node:crypto";
import { callProviderModel, ProviderTransportError, type ProviderTransportRequest, type ProviderTransportResponse } from "../../adapters/models/pi-transport";
import { modelDescriptorSchema, modelEndpointSchema, providerDefinitionSchema, type ModelDescriptor, type ProviderDefinition } from "../../contracts/model-providers";
import { createModelFetch } from "../../infrastructure/model-network";
import { googleModelRequestUrl } from "../../adapters/models/google-transport";
import { modelSetupPolicySchema, type ModelSetupPolicy } from "./setup-policy";

export interface ModelProviderProbeRequest {
  provider: ProviderDefinition;
  endpoint: string;
  apiKey: string;
  model: ModelDescriptor;
  verifyTools: boolean;
  policy: ModelSetupPolicy;
  reauthorize: () => void | Promise<void>;
}
export interface ModelProviderProbeResult {
  verification: "inference_verified" | "tools_verified";
  modelId: string;
  usage: ProviderTransportResponse["usage"];
  httpStatus?: number;
}
export interface ModelProviderProbeOptions {
  /** Trusted local HTTP fixtures only. Never derive this from request input. */
  testLoopback?: boolean;
}
const reject = (code: string) => new ProviderTransportError(code, "rejected", 400);

function totalUsage(results: ProviderTransportResponse[]): ProviderTransportResponse["usage"] {
  if (results.some(result => !result.usage.observed)) return { observed: false };
  const usage: ProviderTransportResponse["usage"] = { observed: true };
  for (const field of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    if (results.every(result => result.usage[field] !== undefined)) {
      const value = results.reduce((sum, result) => sum + result.usage[field]!, 0);
      if (!Number.isSafeInteger(value) || value < 0) throw new ProviderTransportError("MODEL_USAGE_INVALID", "uncertain");
      usage[field] = value;
    }
  }
  return usage;
}

/** Explicitly billable. One inference call, or two calls for a local native tool round trip. */
export async function probeProviderModel(input: ModelProviderProbeRequest, options: ModelProviderProbeOptions = {}): Promise<ModelProviderProbeResult> {
  const policy = modelSetupPolicySchema.parse(input.policy);
  const provider = providerDefinitionSchema.parse(input.provider);
  const model = modelDescriptorSchema.parse(input.model);
  if (!input.apiKey || /\s/.test(input.apiKey) || input.apiKey.length > 4096 || typeof input.reauthorize !== "function") {
    throw reject("MODEL_CONFIGURATION_INVALID");
  }
  if (provider.adapter.readiness !== "installed" || provider.id !== model.providerId || provider.protocol !== model.protocol ||
      model.lifecycle === "retired" || !model.inputModalities.includes("text") || !model.outputModalities.includes("text")) {
    throw reject("MODEL_PROBE_UNSUPPORTED");
  }
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch { throw reject("MODEL_ENDPOINT_INVALID"); }
  const local = options.testLoopback === true && ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname.replace(/^\[|\]$/g, ""));
  if ((!local && !modelEndpointSchema.safeParse(input.endpoint).success) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw reject("MODEL_ENDPOINT_INVALID");
  }
  const context = model.contextTokens.value, output = model.maxOutputTokens.value, maxInput = model.maxInputTokens.value;
  if (context === null || output === null) throw reject("MODEL_PROBE_CAPACITY_UNKNOWN");
  const maxOutputTokens = Math.min(policy.probeMaxOutputTokens, output);
  if (maxOutputTokens >= context) throw reject("MODEL_PROBE_CAPACITY_INVALID");
  if (input.verifyTools && model.capabilities.tools.value === false) throw reject("MODEL_PROBE_TOOLS_UNSUPPORTED");
  const nonce = randomUUID();
  const request: ProviderTransportRequest = {
    provider: provider.id, protocol: provider.protocol, model: model.id, baseUrl: endpoint.href.replace(/\/$/, ""),
    credentialRevision: "setup-probe", contextWindowTokens: context, maxOutputTokens,
    reasoningCapable: model.capabilities.reasoning.value === true,
    maxRequestBytes: policy.probeMaxRequestBytes, maxResponseBytes: policy.probeMaxResponseBytes,
    messages: [{ role: "user", content: input.verifyTools
      ? `Call setup_echo exactly once with token ${nonce}. After receiving the tool result, reply with only that token.`
      : "Reply with only OK." }],
    ...(input.verifyTools ? { tools: [{ type: "function" as const, function: { name: "setup_echo",
      description: "Returns a setup verification token. No external action.",
      parameters: { type: "object", properties: { token: { type: "string", const: nonce } }, required: ["token"], additionalProperties: false } } }] } : {}),
  };
  const deadlineAt = Date.now() + policy.probeDeadlineMs;
  const headers = provider.auth.kind === "bearer" ? { authorization: `Bearer ${input.apiKey}` }
    : { [provider.auth.headerName]: input.apiKey };
  let httpStatus: number | undefined;
  const responses: ProviderTransportResponse[] = [];
  async function run(): Promise<ProviderTransportResponse> {
    const path = `${endpoint.pathname.replace(/\/$/, "")}/${provider.protocol === "openai_responses" ? "responses" : provider.protocol === "anthropic_messages" ? "messages" : "chat/completions"}`;
    const googleUrl = provider.protocol === "google_generate_content" ? googleModelRequestUrl(request.baseUrl, model.id).href : undefined;
    const network = createModelFetch({ authorizeUrl: url => googleUrl ? url.href === googleUrl : url.origin === endpoint.origin && url.pathname === path &&
      (!url.search || provider.protocol === "anthropic_messages" && url.search === "?beta=true"),
      headers, maxRequestBytes: policy.probeMaxRequestBytes, maxResponseBytes: policy.probeMaxResponseBytes,
      deadlineAt, beforeDispatch: input.reauthorize, testLoopback: options.testLoopback });
    const response = await callProviderModel(request, { apiKey: input.apiKey,
      fetch: (async (url, init) => { const response = await network(url, init); httpStatus = response.status; return response; }) as typeof fetch,
      onProgress: network.markProgress,
      beforePayloadDispatch: async payload => {
        // A conservative setup estimate includes the full payload and native tool history.
        const bytes = Buffer.byteLength(JSON.stringify(payload));
        if (bytes > Math.min(maxInput ?? context!, context! - maxOutputTokens)) throw reject("MODEL_PROBE_INPUT_CAPACITY_EXCEEDED");
      } });
    responses.push(response);
    return response;
  }
  const first = await run();
  if (input.verifyTools) {
    const calls = first.message.tool_calls;
    if (first.finishReason !== "tool_calls" || calls?.length !== 1 || calls[0]!.function.name !== "setup_echo") {
      throw new ProviderTransportError("MODEL_PROBE_TOOL_CALL_INVALID", "uncertain");
    }
    let args: unknown;
    try { args = JSON.parse(calls[0]!.function.arguments); } catch { throw new ProviderTransportError("MODEL_PROBE_TOOL_CALL_INVALID", "uncertain"); }
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 1 || (args as { token?: unknown }).token !== nonce) {
      throw new ProviderTransportError("MODEL_PROBE_TOOL_CALL_INVALID", "uncertain");
    }
    request.messages.push(first.message, { role: "tool", content: nonce, tool_call_id: calls[0]!.id });
    request.nativeHistory = { 1: first.nativeState };
    const final = await run();
    if (final.finishReason !== "stop" || final.message.tool_calls?.length || final.message.content?.trim() !== nonce) {
      throw new ProviderTransportError("MODEL_PROBE_TOOL_ROUND_TRIP_INVALID", "uncertain");
    }
  } else if (first.finishReason !== "stop" || first.message.tool_calls?.length || !first.message.content?.trim()) {
    throw new ProviderTransportError("MODEL_PROBE_INFERENCE_INVALID", "uncertain");
  }
  return { verification: input.verifyTools ? "tools_verified" : "inference_verified", modelId: model.id,
    usage: totalUsage(responses), ...(httpStatus === undefined ? {} : { httpStatus }) };
}
