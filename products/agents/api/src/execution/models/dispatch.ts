import { modelGenerationSchema, type ModelGenerationSettings } from "../../contracts/model-generation";
import { applyGeneration, validateGeneration, generationSdkOptions, modelControlsRevision } from "../../adapters/models/model-controls";
import type { Pool, PoolClient } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { HarnessMessage, ToolDefinition } from "../../contracts/model-messages";
import { effectiveExecutionPolicySchema, modelDescriptorSchema, providerDefinitionSchema, providerUseGrantSchema,
  resolvedModelBindingSchema, type EffectiveExecutionPolicy, type ModelDescriptor, type ProviderDefinition,
  type ProviderUseGrant, type ResolvedModelBinding } from "../../contracts/model-providers";
import { ProviderTransportError, type PrivateNativeState, type ProviderTransportResponse } from "../../adapters/models/pi-transport";
import { modelProviderAdapter } from "../../adapters/models/model-adapter";
import { transaction } from "../../infrastructure/database";
import { createModelFetch, type ModelFetch, type ModelNetworkPolicy } from "../../infrastructure/model-network";
import type { PreparedInputCount } from "../../adapters/models/input-count";
import { googleModelRequestUrl } from "../../adapters/models/google-transport";
import type { ModelFailureDiagnostics } from "../../contracts/model-transport";

export interface AcceptedModelDispatch {
  binding: ResolvedModelBinding;
  model: ModelDescriptor;
  policy: EffectiveExecutionPolicy;
  consumer: ProviderUseGrant["consumer"];
  definition: ProviderDefinition;
  generation?: ModelGenerationSettings; generationRevision?: string;
}
export interface BoundModelDispatchInput {
  pool: Pool;
  providerStore: { resolveCredential(db: PoolClient, binding: ResolvedModelBinding, consumer: ProviderUseGrant["consumer"]): Promise<string> };
  accepted: AcceptedModelDispatch;
  messages: HarnessMessage[];
  tools?: ToolDefinition[];
  nativeHistory?: Record<number, PrivateNativeState>;
  /** Serialized protocol payload allowance, independently configured from raw user input bytes. */
  maxRequestBytes: number;
  /** An enclosing task deadline can only shorten the accepted call duration. */
  deadlineAt?: number;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  beforeDispatch?: () => void | Promise<void>;
  onPreparedInputCount?: (count: PreparedInputCount) => void | Promise<void>;
  beforePayloadDispatch?: (payload: Readonly<Record<string, unknown>>, count: PreparedInputCount) => Promise<void>;
}
export class BoundModelDispatchError extends Error {
  constructor(readonly code: string, readonly outcome: "rejected" | "uncertain", readonly status = 502,readonly diagnostics?:ModelFailureDiagnostics) {
    super(code); this.name = "BoundModelDispatchError";
  }
}
const rejected = (code: string, status = 400) => new BoundModelDispatchError(code, "rejected", status);
function validateAccepted(raw: AcceptedModelDispatch): AcceptedModelDispatch {
  let accepted: AcceptedModelDispatch;
  try {
    accepted = { binding: resolvedModelBindingSchema.parse(raw.binding), model: modelDescriptorSchema.parse(raw.model),
      policy: effectiveExecutionPolicySchema.parse(raw.policy), definition: providerDefinitionSchema.parse(raw.definition),
      consumer: providerUseGrantSchema.shape.consumer.parse(raw.consumer), generation: modelGenerationSchema.parse(raw.generation ?? {}), generationRevision: raw.generationRevision };
  } catch { throw rejected("MODEL_ACCEPTED_BINDING_INVALID"); }
  const { binding, model, policy, definition } = accepted;
  if (definition.id !== binding.providerId || definition.protocol !== binding.protocol ||
    requestDigest(definition) !== binding.providerDefinitionDigest || definition.adapter.id !== binding.adapterId ||
    definition.adapter.revision !== binding.adapterRevision || model.id !== binding.modelId || model.providerId !== binding.providerId ||
    model.protocol !== binding.protocol || model.revision !== binding.modelRevision || policy.digest !== binding.policyDigest ||
    (model.contextTokens.value !== null && policy.contextTokens > model.contextTokens.value) ||
    (model.maxInputTokens.value !== null && policy.maxInputTokens > model.maxInputTokens.value) ||
    (model.maxOutputTokens.value !== null && policy.maxOutputTokens > model.maxOutputTokens.value)) {
    throw rejected("MODEL_ACCEPTED_BINDING_MISMATCH", 409);
  }
  if (raw.generation !== undefined && (raw.generationRevision !== modelControlsRevision || binding.generationDigest !== requestDigest({generation:raw.generation,revision:raw.generationRevision}))) throw rejected("MODEL_GENERATION_CHANGED",409);
  validateGeneration(model, policy, binding.endpoint, accepted.generation);
  if (definition.adapter.readiness !== "installed") throw rejected("MODEL_ADAPTER_NOT_INSTALLED", 501);
  return accepted;
}

/** Dispatch an accepted snapshot with a fresh credential check after DNS and immediately before physical I/O.
 * The explicit factory parameter is for controlled network fixtures; production callers use createModelFetch.
 * Native state is private continuation data and must not be included in product-visible responses. */
export async function dispatchBoundModel(
  input: BoundModelDispatchInput,
  networkFactory: (policy: ModelNetworkPolicy) => ModelFetch = createModelFetch,
): Promise<ProviderTransportResponse> {
  let counterFailure: ProviderTransportError | undefined;
  try {
    // Parse a fresh copy before any asynchronous work, so callers cannot mutate authority during dispatch.
    const accepted = validateAccepted(input.accepted);
    const { binding, model, policy, definition, consumer } = accepted;
    const messages = structuredClone(input.messages), tools = structuredClone(input.tools), nativeHistory = structuredClone(input.nativeHistory);
    if (messages.length > policy.maxMessages || (tools?.length ?? 0) > policy.maxTools) throw rejected("MODEL_REQUEST_LIMIT");
    const maxRequestBytes = Math.min(input.maxRequestBytes, policy.maxRequestBytes);
    if (!Number.isSafeInteger(input.maxRequestBytes) || input.maxRequestBytes < 1 ||
      (input.deadlineAt !== undefined && !Number.isSafeInteger(input.deadlineAt))) throw rejected("MODEL_NETWORK_POLICY_INVALID");
    const durationDeadline = Date.now() + policy.maxCallDurationMs;
    const deadlineAt = Math.min(durationDeadline, input.deadlineAt ?? durationDeadline);
    if (!Number.isSafeInteger(deadlineAt)) throw rejected("MODEL_NETWORK_POLICY_INVALID");
    if (input.signal?.aborted) throw rejected("MODEL_CANCELLED_BEFORE_DISPATCH", 409);
    if (deadlineAt <= Date.now()) throw rejected("MODEL_NETWORK_DEADLINE", 408);
    if (policy.maxCostMicros !== null) throw rejected("MODEL_COST_CAP_UNSUPPORTED", 422);
    if (tools?.length && model.capabilities.tools.value !== true) throw rejected("MODEL_TOOLS_UNSUPPORTED", 409);
    const apiKey = await transaction(input.pool, db => input.providerStore.resolveCredential(db, binding, consumer));
    const endpoint = new URL(binding.endpoint);
    const suffix = binding.protocol === "openai_chat_completions" ? "/chat/completions" :
      binding.protocol === "openai_responses" ? "/responses" : "/messages";
    const path = endpoint.pathname.replace(/\/+$/, "") + suffix;
    const googleUrl = binding.protocol === "google_generate_content" ? googleModelRequestUrl(binding.endpoint, binding.modelId).href : undefined;
    const headers = definition.auth.kind === "bearer" ? { authorization: `Bearer ${apiKey}` } : { [definition.auth.headerName]: apiKey };
    const fetch = networkFactory({
      authorizeUrl: url => googleUrl ? url.href === googleUrl : url.origin === endpoint.origin && url.pathname === path &&
        (!url.search || binding.protocol === "anthropic_messages" && url.search === "?beta=true") && !url.hash && !url.username && !url.password,
      headers, maxRequestBytes, maxResponseBytes: policy.maxResponseBytes, deadlineAt, signal: input.signal,
      connectTimeoutMs: policy.maxCallDurationMs, idleTimeoutMs: policy.maxCallDurationMs, progressTimeoutMs: policy.maxCallDurationMs,
      beforeDispatch: async () => {
        await input.beforeDispatch?.();
        const current = await transaction(input.pool, db => input.providerStore.resolveCredential(db, binding, consumer));
        if (current !== apiKey) throw rejected("MODEL_CONNECTION_CHANGED", 409);
      },
    });
    return await modelProviderAdapter.invoke({ provider: binding.providerId, protocol: binding.protocol, model: binding.modelId,
      baseUrl: binding.endpoint, credentialRevision: String(binding.credentialRevision), contextWindowTokens: policy.contextTokens,
      maxOutputTokens: policy.maxOutputTokens, messages, tools, nativeHistory, maxRequestBytes,
      reasoningCapable: model.capabilities.reasoning.value === true, reasoning: generationSdkOptions(model, binding.endpoint, accepted.generation ?? {}),
      maxResponseBytes: policy.maxResponseBytes }, { apiKey, signal: input.signal, fetch,
      onText: input.onText, onProgress: fetch.markProgress, preparePayload: payload => applyGeneration(model, policy, binding.endpoint, accepted.generation, payload), beforePayloadDispatch: async payload => {
        let count: PreparedInputCount;
        try {
          const counter = modelProviderAdapter.prepareInputCount(accepted, payload);
          const counterFetch = counter ? networkFactory({ authorizeUrl: url => url.href === counter.url.href,
            headers, maxRequestBytes, maxResponseBytes: Math.min(policy.maxResponseBytes, 65536), deadlineAt, signal: input.signal,
            connectTimeoutMs: policy.maxCallDurationMs, idleTimeoutMs: policy.maxCallDurationMs, progressTimeoutMs: policy.maxCallDurationMs,
            beforeDispatch: async () => { await input.beforeDispatch?.(); const current = await transaction(input.pool, db => input.providerStore.resolveCredential(db, binding, consumer));
              if (current !== apiKey) throw rejected("MODEL_CONNECTION_CHANGED", 409); } }) : fetch;
          count = await modelProviderAdapter.countInput(accepted, payload, counterFetch);
          await input.onPreparedInputCount?.(count);
          if (count.tokens > policy.maxInputTokens || BigInt(count.tokens) + BigInt(policy.maxOutputTokens) + BigInt(policy.safetyTokens) > BigInt(policy.contextTokens)) {
            throw new ProviderTransportError("CONTEXT_LIMIT", "rejected", 400);
          }
        } catch (error) { if (error instanceof ProviderTransportError) counterFailure = error; throw error; }
        await input.beforePayloadDispatch?.(payload, count);
      } });
  } catch (error) {
    if (counterFailure) throw new BoundModelDispatchError(counterFailure.code, counterFailure.outcome, counterFailure.status,counterFailure.diagnostics);
    if (error instanceof BoundModelDispatchError) throw error;
    if (error instanceof ProviderTransportError) throw new BoundModelDispatchError(error.code, error.outcome, error.status,error.diagnostics);
    if (error instanceof PlatformError) throw rejected(error.code, error.statusCode);
    throw rejected("MODEL_DISPATCH_FAILED", 502);
  }
}
