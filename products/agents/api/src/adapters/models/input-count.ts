import { requestDigest } from "../../contracts/contracts";
import type { AcceptedModelRoute } from "../../contracts/model-bindings";
import { ProviderTransportError } from "../../contracts/model-transport";
import { googleModelRequestUrl } from "./google-transport";

export interface PreparedInputCount {
  tokens: number;
  precision: "provider_count" | "provider_estimate" | "serialized_bytes_estimate";
  revision: string;
  payloadDigest: string;
}
export interface InputCountRequest { url: URL; body: Record<string, unknown>; headers: Record<string, string>; field: "input_tokens" | "totalTokens"; precision: PreparedInputCount["precision"]; revision: string }
const pick = (payload: Readonly<Record<string, unknown>>, keys: readonly string[]) => Object.fromEntries(keys.filter(key => payload[key] !== undefined).map(key => [key, payload[key]]));
/** Native counting applies only to the reviewed official route, never inferred from API compatibility. */
export function prepareInputCount(route: AcceptedModelRoute, payload: Readonly<Record<string, unknown>>): InputCountRequest | null {
  const binding = route.binding, endpoint = new URL(binding.endpoint);
  if (binding.providerId === "openai" && binding.protocol === "openai_responses" && binding.endpoint.replace(/\/$/, "") === "https://api.openai.com/v1") {
    return { url: new URL(`${binding.endpoint.replace(/\/$/, "")}/responses/input_tokens`),
      body: pick(payload, ["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "truncation", "previous_response_id", "conversation"]),
      headers: {}, field: "input_tokens", precision: "provider_count", revision: "openai-responses-input-tokens-2026-10-21" };
  }
  if (binding.providerId === "anthropic" && binding.protocol === "anthropic_messages" && binding.endpoint.replace(/\/$/, "") === "https://api.anthropic.com/v1") {
    return { url: new URL(`${binding.endpoint.replace(/\/$/, "")}/messages/count_tokens`),
      body: pick(payload, ["model", "messages", "system", "tools", "tool_choice", "thinking"]), headers: { "anthropic-version": "2023-06-01" },
      field: "input_tokens", precision: "provider_estimate", revision: "anthropic-messages-count-tokens-2026-10-21" };
  }
  if (binding.providerId === "google" && binding.protocol === "google_generate_content" && endpoint.origin === "https://generativelanguage.googleapis.com" && ["/v1beta", "/v1"].includes(endpoint.pathname.replace(/\/$/, ""))) {
    const url = googleModelRequestUrl(binding.endpoint, binding.modelId); url.search = ""; url.pathname = url.pathname.replace(/:streamGenerateContent$/, ":countTokens");
    return { url, body: { generateContentRequest: { ...structuredClone(payload), model: `models/${binding.modelId.replace(/^models\//, "")}` } },
      headers: {}, field: "totalTokens", precision: "provider_count", revision: "google-generate-content-count-tokens-2026-10-21" };
  }
  return null;
}
export async function countPreparedInput(route: AcceptedModelRoute, payload: Readonly<Record<string, unknown>>, fetch: typeof globalThis.fetch): Promise<PreparedInputCount> {
  const prepared = prepareInputCount(route, payload), payloadDigest = requestDigest(JSON.parse(JSON.stringify(payload)));
  if (!prepared) return { tokens: Buffer.byteLength(JSON.stringify(payload), "utf8"), precision: "serialized_bytes_estimate", revision: "serialized-native-utf8-v1", payloadDigest };
  try {
    const response = await fetch(prepared.url, { method: "POST", headers: { "content-type": "application/json", ...prepared.headers }, body: JSON.stringify(prepared.body) });
    if (!response.ok) { await response.body?.cancel(); throw new ProviderTransportError(response.status === 429 ? "MODEL_COUNTER_RATE_LIMITED" : "MODEL_COUNTER_UNAVAILABLE", "rejected", response.status); }
    const value: unknown = await response.json();
    const tokens = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[prepared.field] : undefined;
    if (!Number.isSafeInteger(tokens) || Number(tokens) < 0 || Number(tokens) > 2147483647) throw new ProviderTransportError("MODEL_COUNTER_RESPONSE_INVALID", "rejected", 502);
    return { tokens: Number(tokens), precision: prepared.precision, revision: prepared.revision, payloadDigest };
  } catch (error) {
    if (error instanceof ProviderTransportError) throw error;
    // Counting is not generation. A lost counter response never authorizes a generation retry or fallback estimate.
    throw new ProviderTransportError("MODEL_COUNTER_UNAVAILABLE", "rejected", 503);
  }
}
