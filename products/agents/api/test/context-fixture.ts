import type { ContextModelPolicy } from "../src/execution/context/context";
import { estimateRequestTokens } from "../src/execution/business/model";

/** Explicit packing budgets for deterministic context fixtures; no vendor tokenizer claim. */
export function fixtureContextPolicy(overrides: Partial<ContextModelPolicy> = {}): ContextModelPolicy {
  return { modelId: "fixture/context-model", revision: "fixture-policy-v1", counterRevision: "logical-json-byte-estimate-v1",
    contextWindowTokens: 32768, maxInputTokens: 8192, maxOutputTokens: 1024, maxDurationSeconds: 120,
    safetyTokens: 128, maxMessages: 256, maxTools: 32, maxRequestBytes: 1048576,
    estimateRequestTokens, ...overrides };
}
