import { requestDigest } from "../../contracts/contracts";
import { modelDescriptorSchema, type ModelDescriptor, type ModelProtocol } from "../../contracts/model-providers";
import { getBundledProviderModels, type BundledProviderModel } from "./pi-transport";

const api: Record<ModelProtocol, string> = { openai_chat_completions: "openai-completions", openai_responses: "openai-responses",
  anthropic_messages: "anthropic-messages", google_generate_content: "google-generative-ai" };
const capacity = (value: number) => Number.isSafeInteger(value) && value > 0;
const price = (value: number): number | null => {
  const micros = Math.ceil(value * 1000000);
  return Number.isFinite(value) && value > 0 && Number.isSafeInteger(micros) ? micros : null;
};

/** Bundled metadata is advisory; it never grants model access or establishes tool conformance. */
export function enrichModelMetadata(discovered: ModelDescriptor, bundled: readonly BundledProviderModel[], observedAt: string): ModelDescriptor {
  const result = modelDescriptorSchema.parse(discovered);
  const nativeApi = result.providerId === "mistral" && result.protocol === "openai_chat_completions" ? "mistral-conversations" : api[result.protocol];
  const profile = bundled.find(candidate => candidate.id === result.id && candidate.api === nativeApi);
  if (!profile) return result;
  const source = { kind: "registry" as const, reference: `@earendil-works/pi-ai@1.1.0:${result.providerId}/${result.id}`, observedAt };
  for (const [field, value] of [["contextTokens", profile.contextWindow], ["maxOutputTokens", profile.maxTokens]] as const) {
    if (result[field].value === null && capacity(value)) result[field] = { value, source };
  }
  if (result.capabilities.reasoning.value === null && typeof profile.reasoning === "boolean") {
    result.capabilities.reasoning = { value: profile.reasoning, source, evidence: "declared" };
  }
  if (!result.inputModalities.length) result.inputModalities = profile.input.filter((value): value is "text" | "image" | "audio" | "video" =>
    ["text", "image", "audio", "video"].includes(value));
  if (!result.outputModalities.length) result.outputModalities = ["text"];
  const input = price(profile.cost.input), output = price(profile.cost.output);
  // Generated catalogues can use zero for missing costs; zero is not proof of a free route.
  if (!result.pricing && input !== null && output !== null) result.pricing = {
    currency: "USD", inputMicrosPerMillionTokens: input, outputMicrosPerMillionTokens: output,
    cachedInputMicrosPerMillionTokens: price(profile.cost.cacheRead), source, revision: requestDigest(profile.cost),
  };
  result.revision = requestDigest({ ...result, revision: "pending" });
  return modelDescriptorSchema.parse(result);
}

export async function enrichProviderModels(providerId: string, discovered: readonly ModelDescriptor[], observedAt: string): Promise<ModelDescriptor[]> {
  const bundled = new Map((await getBundledProviderModels(providerId)).map(model => [model.id, model]));
  return discovered.map(model => {
    if (model.providerId !== providerId) throw new Error("Model metadata provider mismatch");
    const profile = bundled.get(model.id);
    return enrichModelMetadata(model, profile ? [profile] : [], observedAt);
  });
}
