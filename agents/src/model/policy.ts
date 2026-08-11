import { z } from "zod";
import type { ModelProvider } from "./types";

const modelTargetSchema = z.object({ provider: z.enum(["openrouter", "openai", "anthropic", "gemini"]), model: z.string().trim().min(1).max(240) });

export const modelPolicySchema = z.object({
  version: z.string().trim().min(1).max(80),
  primary: modelTargetSchema,
  fallback: z.array(modelTargetSchema).max(3).default([]),
  fast: modelTargetSchema.optional(),
  allowUserFundedFallbackToKasiTek: z.boolean().default(false),
  maxTokensPerRun: z.number().int().positive().max(1_000_000).optional(),
  maxEstimatedCostUsd: z.number().nonnegative().max(10_000).optional(),
});
export type ModelPolicy = z.infer<typeof modelPolicySchema>;

export interface ResolvedModelTarget {
  provider: ModelProvider;
  model: string;
  policyVersion?: string;
  fallback: Array<{ provider: ModelProvider; model: string }>;
  maxTokensPerRun?: number;
  maxEstimatedCostUsd?: number;
  allowUserFundedFallbackToKasiTek: boolean;
}

export function resolveModelTarget(configuration: Record<string, unknown>, policy: Record<string, unknown>): ResolvedModelTarget {
  const candidate = policy.modelPolicy;
  if (candidate && typeof candidate === "object") {
    const parsed = modelPolicySchema.parse(candidate);
    return {
      provider: parsed.primary.provider,
      model: parsed.primary.model,
      policyVersion: parsed.version,
      fallback: parsed.fallback,
      maxTokensPerRun: parsed.maxTokensPerRun,
      maxEstimatedCostUsd: parsed.maxEstimatedCostUsd,
      allowUserFundedFallbackToKasiTek: parsed.allowUserFundedFallbackToKasiTek,
    };
  }
  const provider = (configuration.provider ?? configuration.modelProvider ?? "openrouter");
  const model = configuration.model;
  if (typeof model !== "string" || !model) throw new Error("Published agent version has no model configured");
  if (provider !== "openrouter" && provider !== "openai" && provider !== "anthropic" && provider !== "gemini") throw new Error("Unsupported model provider");
  return { provider, model, fallback: [], allowUserFundedFallbackToKasiTek: false };
}
