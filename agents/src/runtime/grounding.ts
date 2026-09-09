import type { ModelProvider, ModelResponse } from "../model/types";

const questionStarters = new Set(["are", "can", "could", "did", "do", "does", "how", "is", "tell", "what", "when", "where", "which", "who", "why", "would"]);
const knowledgeTerms = new Set([
  "account", "available", "availability", "billing", "contact", "cost", "delivery", "details", "feature", "features", "help", "hours", "information", "location", "offer", "offers", "policy", "policies", "price", "pricing", "product", "products", "refund", "return", "services", "shipping", "support", "warranty",
]);
const effectTerms = new Set(["book", "connect", "create", "delete", "draft", "post", "publish", "retry", "schedule", "send", "update", "upload"]);
const casualPhrases = new Set(["hi", "hello", "hey", "thanks", "thank you", "ok", "okay", "good morning", "good afternoon", "good evening", "how are you", "how is it going", "what's up"]);

export type AgentIntent = "capability_request" | "knowledge_request" | "memory_request" | "effect_request" | "casual";

function isCapabilityRequestMessage(normalized: string): boolean {
  return /\b(?:what|which|tell me about)\s+(?:can|could|do)\s+you\s+(?:do|help(?:\s+with)?|support)\b/u.test(normalized)
    || /\bwhat\s+(?:are\s+)?(?:the\s+)?(?:other\s+)?things?(?:\s+you)?\s+can(?:\s+you)?\s+(?:do|help(?:\s+with)?)\b/u.test(normalized)
    || /\b(?:what|which)\s+(?:tools?|capabilities?|integrations?|connections?|skills?|services?)\b/u.test(normalized)
    || /\b(?:available|supported|callable)\s+(?:tools?|capabilities?|integrations?|connections?|skills?)\b/u.test(normalized)
    || /\bwhat(?:'s| is)\s+(?:connected|available|supported)\b/u.test(normalized)
    || /\b(?:full|complete|entire)\s+(?:list|range)\b.*\b(?:tools?|capabilities?|integrations?|skills?)\b/u.test(normalized);
}

function tokensFor(message: string): string[] {
  return message
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}'?]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

/** Returns true when a customer message is asking for factual/configured knowledge. */
export function isKnowledgeSeekingMessage(message: string): boolean {
  const normalized = message.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  if (!normalized || casualPhrases.has(normalized)) return false;
  if (isCapabilityRequestMessage(normalized)) return false;
  const tokens = tokensFor(normalized).map((token) => token.replace(/\?$/u, ""));
  const hasQuestionShape = normalized.includes("?") || questionStarters.has(tokens[0] ?? "");
  const hasEffectRequest = tokens.some((token) => effectTerms.has(token))
    && (tokens[0] === "can" || tokens[0] === "could" || tokens[0] === "please" || tokens[0] === "will" || tokens[0] === "go");
  if (hasEffectRequest) return false;
  return hasQuestionShape || tokens.some((token) => knowledgeTerms.has(token));
}

/**
 * Deterministic routing for the grounding seam. Capability questions are
 * intentionally separate from factual questions: the current runtime
 * projection, not an evidence corpus, is their source of truth.
 */
export function classifyAgentIntent(message: string): AgentIntent {
  const normalized = message.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  if (!normalized || casualPhrases.has(normalized)) return "casual";
  const tokens = tokensFor(normalized).map((token) => token.replace(/\?$/u, ""));
  const effectRequest = tokens.some((token) => effectTerms.has(token))
    && (tokens[0] === "can" || tokens[0] === "could" || tokens[0] === "please" || tokens[0] === "will" || tokens[0] === "go" || tokens[0] === "help");
  if (effectRequest) return "effect_request";
  if (isCapabilityRequestMessage(normalized)) return "capability_request";
  if (/\b(?:remember|previous(?:ly)?|last time|our conversation|my preference|what did i tell|history)\b/u.test(normalized)) return "memory_request";
  if (isKnowledgeSeekingMessage(normalized)) return "knowledge_request";
  return "casual";
}

export function shouldFailClosedWithoutEvidence(input: {
  message: string;
  agentAudience?: "personal" | "customer_service";
  isSystemAgent?: boolean;
  evidenceCount: number;
  capabilityAwarenessEnabled?: boolean;
}): boolean {
  const intent = classifyAgentIntent(input.message);
  const effectiveIntent = input.capabilityAwarenessEnabled === false && intent === "capability_request"
    ? "knowledge_request"
    : intent;
  return input.evidenceCount <= 0
    && (input.agentAudience === "customer_service" || input.isSystemAgent === true)
    && effectiveIntent === "knowledge_request";
}

export const NO_APPROVED_KNOWLEDGE_RESPONSE = "I don’t have enough approved information to answer that yet.";

export function createGroundingFallbackResponse(provider: ModelProvider, model: string): ModelResponse {
  return {
    provider,
    model,
    message: { role: "assistant", content: NO_APPROVED_KNOWLEDGE_RESPONSE },
    toolCalls: [],
    finishReason: "grounding_required",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    latencyMs: 0,
  };
}
