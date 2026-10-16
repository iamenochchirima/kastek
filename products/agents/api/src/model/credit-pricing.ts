import type { ModelGateway } from "./gateway";
import type { ModelMessage, ModelPricing, ModelRequest, ModelResponse } from "./types";

export interface ModelCreditPricing {
  creditsPerUsd: number;
  version: string;
}

export function shouldChargeModelCredits(
  billingMode: "disabled" | "shadow" | "enforced",
  fundingSource: "kasitek" | "user",
): boolean {
  return billingMode !== "disabled" && fundingSource === "kasitek";
}

function pricingFor(
  pricing: Record<string, ModelPricing>,
  provider: ModelRequest["provider"],
  model: string,
): ModelPricing {
  const value = pricing[`${provider}:${model}`] ?? pricing[`${provider}:*`];
  if (!value || !Number.isFinite(value.inputUsdPerMillion) || !Number.isFinite(value.outputUsdPerMillion)) {
    throw new Error(`MODEL_CREDIT_PRICING_UNAVAILABLE:${provider}:${model}`);
  }
  return value;
}

function serializedMessageSize(messages: ModelMessage[]): number {
  return messages.reduce((total, message) => total + message.role.length + message.content.length + JSON.stringify(message.toolCalls ?? []).length, 0);
}

/**
 * Estimate prompt tokens conservatively without coupling billing to a provider
 * tokenizer. Actual provider usage is always used for capture.
 */
export function estimatePromptTokens(request: Pick<ModelRequest, "messages" | "tools">): number {
  const messageSize = serializedMessageSize(request.messages);
  const toolSize = JSON.stringify(request.tools ?? []).length;
  return Math.max(1, Math.ceil((messageSize + toolSize) / 3));
}

export function creditsForModelUsage(
  gateway: ModelGateway,
  pricing: Record<string, ModelPricing>,
  policy: ModelCreditPricing,
  provider: ModelRequest["provider"],
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const modelPricing = pricingFor(pricing, provider, model);
  const providerCostUsd = (inputTokens / 1_000_000) * modelPricing.inputUsdPerMillion
    + (outputTokens / 1_000_000) * modelPricing.outputUsdPerMillion;
  // Keep the gateway calculation as the shared numeric implementation check.
  const gatewayCostUsd = gateway.estimateCost(provider, model, inputTokens, outputTokens);
  const costUsd = gatewayCostUsd > 0 ? gatewayCostUsd : providerCostUsd;
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("MODEL_CREDIT_PRICING_INVALID");
  return Math.max(1, Math.ceil(costUsd * policy.creditsPerUsd));
}

export function estimateModelCallCredits(
  gateway: ModelGateway,
  pricing: Record<string, ModelPricing>,
  policy: ModelCreditPricing,
  request: Pick<ModelRequest, "provider" | "model" | "messages" | "tools" | "maxTokens">,
): number {
  const inputTokens = estimatePromptTokens(request);
  const outputTokens = Math.max(1, request.maxTokens ?? 4_096);
  // A modest buffer covers tokenizer overhead and provider-specific framing;
  // capture returns the unused portion after the response is measured.
  return Math.max(
    1,
    Math.ceil(creditsForModelUsage(gateway, pricing, policy, request.provider, request.model, inputTokens, outputTokens) * 1.25),
  );
}

export function actualModelCallCredits(
  gateway: ModelGateway,
  pricing: Record<string, ModelPricing>,
  policy: ModelCreditPricing,
  response: Pick<ModelResponse, "provider" | "model" | "usage">,
): number {
  return creditsForModelUsage(
    gateway,
    pricing,
    policy,
    response.provider,
    response.model,
    response.usage.inputTokens,
    response.usage.outputTokens,
  );
}
