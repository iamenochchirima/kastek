import { describe, expect, it } from "vitest";
import { withCompactionOutputAllowance } from "../src/execution/models/policy";
import { modelServicePolicy } from "../src/execution/models/settings";
import type { ModelDescriptor } from "../src/contracts/model-providers";

const model = { id: "fixture/model", providerId: "fixture", protocol: "openai_chat_completions" } as ModelDescriptor;

function compiled(input: { maxInputTokens: number; maxOutputTokens: number; contextTokens?: number; safetyTokens?: number }) {
  const limits = modelServicePolicy({});
  const policy = {
    ...limits,
    contextTokens: input.contextTokens ?? 262_144,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    safetyTokens: input.safetyTokens ?? 1_024,
    compactAtTokens: Math.floor(input.maxInputTokens * 0.85),
    revision: "fixture",
    digest: "0".repeat(64),
  };
  return { policy, decisions: [], modelRevision: "fixture", pricing: null };
}

describe("compaction output allowance", () => {
  it("raises the internal summary budget without touching the user-facing cap", () => {
    const base = compiled({ maxInputTokens: 24_000, maxOutputTokens: 4_096 });
    const next = withCompactionOutputAllowance(base, model, 8_192);
    expect(base.policy.maxOutputTokens).toBe(4_096);
    expect(next.policy.maxOutputTokens).toBe(8_192);
    expect(next.policy.maxInputTokens).toBe(24_000);
    expect(next.policy.digest).not.toBe(base.policy.digest);
    expect(next.decisions.some(decision => decision.sources.some(source => source.reference === "compaction-output-floor:v1"))).toBe(true);
  });

  it("never exceeds the model window or the configured safety reserve", () => {
    const small = compiled({ maxInputTokens: 7_000, maxOutputTokens: 4_096, contextTokens: 12_000, safetyTokens: 512 });
    expect(withCompactionOutputAllowance(small, model, 8_192).policy.maxOutputTokens).toBe(4_488);
  });

  it("leaves the policy unchanged when no headroom is available", () => {
    const tight = compiled({ maxInputTokens: 10_000, maxOutputTokens: 4_096, contextTokens: 14_608, safetyTokens: 512 });
    const next = withCompactionOutputAllowance(tight, model, 8_192);
    expect(next).toBe(tight);
  });
});
