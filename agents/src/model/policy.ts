import { z } from "zod";
import { isModelProvider, MODEL_PROVIDERS, type ModelProvider } from "./types";

const modelTargetSchema = z.object({ provider: z.enum([...MODEL_PROVIDERS]), model: z.string().trim().min(1).max(240) }).strict();

export const modelPolicySchema = z.object({
  version: z.string().trim().min(1).max(80),
  primary: modelTargetSchema,
  credentialReference: z.string().trim().min(1).max(240).optional(),
  fallback: z.array(modelTargetSchema).max(3).default([]),
  fast: modelTargetSchema.optional(),
  allowUserFundedFallbackToKasiTek: z.boolean().default(false),
  maxTokensPerRun: z.number().int().positive().max(1_000_000).optional(),
  maxEstimatedCostUsd: z.number().nonnegative().max(10_000).optional(),
});
export type ModelPolicy = z.infer<typeof modelPolicySchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize model policy documents at the boundary. Early general-purpose
 * agent versions stored the primary model under `primary.name`; the runtime
 * contract is `primary.model`. Existing published versions must keep running,
 * while new writes use the canonical shape.
 */
export function normalizeModelPolicy(policy: Record<string, unknown>): Record<string, unknown> {
  const candidate = policy.modelPolicy;
  if (!isRecord(candidate) || !isRecord(candidate.primary)) return policy;
  const primary = candidate.primary;
  if (typeof primary.model === "string" || typeof primary.name !== "string") return policy;
  return {
    ...policy,
    modelPolicy: {
      ...candidate,
      primary: {
        ...primary,
        model: primary.name,
      },
    },
  };
}

export interface ResolvedModelTarget {
  provider: ModelProvider;
  model: string;
  credentialReference?: string;
  policyVersion?: string;
  fallback: Array<{ provider: ModelProvider; model: string }>;
  maxTokensPerRun?: number;
  maxEstimatedCostUsd?: number;
  allowUserFundedFallbackToKasiTek: boolean;
}

export function resolveModelTarget(configuration: Record<string, unknown>, policy: Record<string, unknown>): ResolvedModelTarget {
  const candidate = normalizeModelPolicy(policy).modelPolicy;
  if (candidate && typeof candidate === "object") {
    const candidateRecord = candidate as Record<string, unknown>;
    const primary = candidateRecord.primary;
    const validationCandidate = primary && typeof primary === "object" && !Array.isArray(primary)
      ? {
        ...candidateRecord,
        primary: Object.fromEntries(Object.entries(primary).filter(([key]) => key !== "name")),
      }
      : candidate;
    const parsed = modelPolicySchema.parse(validationCandidate);
    return {
      provider: parsed.primary.provider,
      model: parsed.primary.model,
      credentialReference: parsed.credentialReference,
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
  if (!isModelProvider(provider)) throw new Error("Unsupported model provider");
  return { provider, model, fallback: [], allowUserFundedFallbackToKasiTek: false };
}
