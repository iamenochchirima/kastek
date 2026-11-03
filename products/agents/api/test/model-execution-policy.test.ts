import { describe, expect, it } from "vitest";
import { effectiveExecutionPolicySchema, type ModelDescriptor } from "../src/contracts/model-providers";
import {
  compileEffectiveExecutionPolicy, type ExecutionPolicyLayer,
} from "../src/execution/models/policy";

import { contextGrantCeiling, executionModelLayers, modelServicePolicy } from "../src/execution/models/settings";
import { agentConfigurationSchema, defaultBusinessConfiguration, requestDigest } from "../src/contracts/contracts";

it("accepts explicit call allowances beyond 32-bit counters without weakening transport bounds",()=>{
  const limits={maxModelCalls:3000000000,maxToolCalls:3000000000,maxRootModelCalls:4000000000,maxRootToolCalls:4000000000,maxDurationMs:4000000000};
  expect(modelServicePolicy({AGENTS_MODEL_POLICY_JSON:JSON.stringify(limits)})).toMatchObject(limits);
  expect(()=>modelServicePolicy({AGENTS_MODEL_POLICY_JSON:JSON.stringify({maxModelCalls:Number.MAX_SAFE_INTEGER+1})})).toThrow();
  expect(()=>modelServicePolicy({AGENTS_MODEL_POLICY_JSON:JSON.stringify({maxRequestBytes:3000000000})})).toThrow();
});

const official = { kind: "official" as const, reference: "https://models.example.com/model", observedAt: "2026-10-21T00:00:00.000Z" };
const operator = { kind: "operator" as const, reference: "operator-qualification/model-v1", observedAt: "2026-10-21T00:00:00.000Z" };
const descriptor = (): ModelDescriptor => ({
  id: "test-model", providerId: "test-provider", name: "Test model", protocol: "openai_chat_completions", revision: "model-v1",
  contextTokens: { value: 128000, source: official }, maxInputTokens: { value: null, source: null },
  maxOutputTokens: { value: 16000, source: official },
  capabilities: {
    tools: { value: null, evidence: "unknown", source: null },
    reasoning: { value: null, evidence: "unknown", source: null },
    structuredOutput: { value: null, evidence: "unknown", source: null },
  },
  inputModalities: ["text"], outputModalities: ["text"], pricing: null, lifecycle: "active",
});
const platform = (): ExecutionPolicyLayer => ({
  kind: "platform", reference: "platform-policy-v1", limits: {
    contextTokens: 128000, maxInputTokens: 100000, maxOutputTokens: 10000, safetyTokens: 1000,
    compactAtTokens: 80000, maxModelCalls: 20, maxToolCalls: 20, maxCallDurationMs: 120000, maxDurationMs: 600000,
    maxInputBytes: 2000000, maxRequestBytes: 2097152, maxMessages: 256, maxTools: 64, maxResponseBytes: 4000000, maxRootTokens: 200000, maxCostMicros: null,
  },
});

describe("shared effective model execution policy compiler", () => {
  it("defaults optional execution allowances to no cap while keeping transport and capacity finite", () => {
    expect(modelServicePolicy({})).toMatchObject({ maxModelCalls: null, maxToolCalls: null, maxRootModelCalls: null,
      maxRootToolCalls: null, maxRootTokens: null, maxDurationMs: null, maxWallDurationMs: null, maxCostMicros: null,
      maxCallDurationMs: 120000, maxInputTokens: 196608, maxOutputTokens: 32768 });
    const model = descriptor(); model.contextTokens.value = 262144;
    const result = compileEffectiveExecutionPolicy(model, [{ kind: "platform", reference: "service", limits: modelServicePolicy({}) }]);
    expect(result.policy.revision).toBe("model-execution-policy-v3");
    expect(result.policy.maxRootTokens).toBeNull();
    expect(result.policy.maxDurationMs).toBeNull();
  });

  it("uses selected model capacity for automatic context and preserves explicit numeric configuration",()=>{
    const automatic=defaultBusinessConfiguration(),model=descriptor();model.contextTokens.value=262144;
    const compile=(configuration:typeof automatic,rootTokenLimit:number|null=null)=>compileEffectiveExecutionPolicy(model,executionModelLayers(configuration,{
      id:"automatic-context-fixture",maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,
      maxContextTokens:contextGrantCeiling(configuration,{}),rootTokenLimit},{}));
    expect(automatic.context).toEqual({mode:"automatic"});
    const selected=compile(automatic);
    expect(selected.policy).toMatchObject({maxInputTokens:196608,compactAtTokens:131072});
    expect(selected.decisions.find(row=>row.field==="maxInputTokens")?.sources).toContainEqual(expect.objectContaining({kind:"derived",reference:expect.stringContaining("automatic-context-v1")}));
    const finite={...automatic,context:{maxInputTokens:8192,compactAtTokens:6144}},before=requestDigest(finite);
    expect(compile(finite).policy).toMatchObject({maxInputTokens:8192,compactAtTokens:6144});
    expect(agentConfigurationSchema.parse(finite).context).toEqual(finite.context);
    expect(requestDigest(agentConfigurationSchema.parse(finite))).toBe(before);
    expect(compile(automatic,20000).policy.maxInputTokens).toBe(15904);
    model.contextTokens.value=8192;
    expect(compile(automatic).policy).toMatchObject({maxInputTokens:3072,compactAtTokens:2048});
  });

  it("keeps local and shared call limits independent and prevents null from erasing finite authority", () => {
    const authority = platform();
    authority.limits.maxModelCalls = null;
    authority.limits.maxToolCalls = null;
    authority.limits.maxRootModelCalls = 100;
    authority.limits.maxRootToolCalls = 200;
    const layers: ExecutionPolicyLayer[] = [authority,
      { kind: "product", reference: "product", limits: { maxModelCalls: 12, maxRootModelCalls: null, maxRootToolCalls: 0 } },
      { kind: "agent", reference: "agent", limits: { maxModelCalls: null, maxToolCalls: 0, maxRootToolCalls: null } },
      { kind: "tenant", reference: "omitted", limits: {} },
    ];
    const result = compileEffectiveExecutionPolicy(descriptor(), layers);
    expect(result.policy).toMatchObject({ maxModelCalls: 12, maxToolCalls: 0, maxRootModelCalls: 100, maxRootToolCalls: 0 });
    expect(result.decisions.find(item => item.field === "maxRootModelCalls")?.sources.some(item => item.reference === "omitted")).toBe(false);
    expect(compileEffectiveExecutionPolicy(descriptor(), layers.toReversed()).policy.digest).toBe(result.policy.digest);
  });

  it("allows omitted optional policy layers and retains finite product token and time entitlements", () => {
    const authority = platform();
    for (const field of ["maxModelCalls", "maxToolCalls", "maxRootTokens", "maxDurationMs", "maxWallDurationMs", "maxCostMicros"] as const) delete authority.limits[field];
    const result = compileEffectiveExecutionPolicy(descriptor(), [authority,
      { kind: "product", reference: "entitlement", limits: { maxRootTokens: 200000, maxDurationMs: 240000, maxWallDurationMs: 3600000 } },
      { kind: "agent", reference: "unrestricted", limits: { maxRootTokens: null, maxDurationMs: null, maxWallDurationMs: null } },
    ]);
    expect(result.policy).toMatchObject({ maxModelCalls: null, maxToolCalls: null, maxRootModelCalls: null, maxRootToolCalls: null,
      maxRootTokens: 200000, maxDurationMs: 240000, maxWallDurationMs: 3600000, maxCostMicros: null });
    expect(() => effectiveExecutionPolicySchema.parse({ ...result.policy, maxCallDurationMs: 240001 })).toThrow("active-time allowance");
  });

  it.each(["maxModelCalls", "maxRootModelCalls", "maxRootTokens", "maxDurationMs", "maxWallDurationMs"] as const)("rejects zero, infinity and sentinel values for %s", field => {
    for (const value of [0, -1, Infinity, "unlimited"]) {
      const authority = platform();
      Object.assign(authority.limits, { [field]: value });
      expect(() => compileEffectiveExecutionPolicy(descriptor(), [authority])).toThrow();
    }
  });


  it("intersects authority layers and vendor capacities with a reproducible decision trail", () => {
    const model = descriptor();
    model.maxInputTokens = { value: 95000, source: official };
    const layers: ExecutionPolicyLayer[] = [
      platform(),
      { kind: "product", reference: "growth-policy-v2", limits: { maxModelCalls: 10, maxToolCalls: 15 } },
      { kind: "tenant", reference: "organization-policy-v3", limits: { maxCallDurationMs: 120000, maxDurationMs: 300000, safetyTokens: 2000 } },
      { kind: "agent", reference: "agent-config-v4", limits: { maxOutputTokens: 4000, maxModelCalls: 5 } },
    ];
    const result = compileEffectiveExecutionPolicy(model, layers);
    expect(result.policy).toMatchObject({
      contextTokens: 128000, maxInputTokens: 95000, maxOutputTokens: 4000, safetyTokens: 2000,
      maxModelCalls: 5, maxToolCalls: 15, maxCallDurationMs: 120000, maxDurationMs: 300000, maxCostMicros: null,
      maxInputBytes: 2000000, maxRequestBytes: 2097152, maxMessages: 256, maxTools: 64, maxResponseBytes: 4000000,
    });
    expect(result.decisions.find(decision => decision.field === "maxInputTokens")).toMatchObject({
      value: 95000, rule: "minimum", sources: expect.arrayContaining([
        { kind: "model", reference: "test-provider/test-model@model-v1", value: 95000, metadata: official },
      ]),
    });
    expect(result.decisions.find(decision => decision.field === "safetyTokens")?.rule).toBe("maximum");
    expect(result.modelRevision).toBe("model-v1");
    expect(result.policy.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(compileEffectiveExecutionPolicy(model, layers.toReversed()).policy.digest).toBe(result.policy.digest);
  });

  it("does not modify its model descriptor or requested authority settings", () => {
    const model = descriptor(), authority = platform();
    const before = structuredClone({ model, authority });
    compileEffectiveExecutionPolicy(model, [authority]);
    expect({ model, authority }).toEqual(before);
  });

  it.each(["contextTokens", "maxOutputTokens"] as const)("refuses unknown %s without a capacity attestation", field => {
    const model = descriptor();
    model[field] = { value: null, source: null };
    expect(() => compileEffectiveExecutionPolicy(model, [platform()])).toThrow("attestation");
    const authority = platform();
    authority.attestedModelCaps = { [field]: { value: field === "contextTokens" ? 128000 : 12000, source: operator } };
    const result = compileEffectiveExecutionPolicy(model, [authority]);
    expect(result.decisions.find(decision => decision.field === field)?.sources).toContainEqual({
      kind: "attestation", reference: "platform-policy-v1", value: authority.attestedModelCaps[field]!.value, metadata: operator,
    });
  });

  it("keeps unknown separate input capacity visible while context bounds an explicit input allowance", () => {
    const result = compileEffectiveExecutionPolicy(descriptor(), [platform()]);
    expect(result.policy.maxInputTokens).toBe(100000);
    expect(result.decisions.find(decision => decision.field === "maxInputTokens")?.sources).toContainEqual({
      kind: "model", reference: "test-provider/test-model@model-v1", value: null, metadata: null,
    });
  });

  it("prevents tenants and agent settings from attesting their own model capabilities or prices", () => {
    for (const kind of ["tenant", "agent", "product"] as const) {
      expect(() => compileEffectiveExecutionPolicy(descriptor(), [platform(), {
        kind, reference: "untrusted-policy", limits: {},
        attestedModelCaps: { contextTokens: { value: 1000000, source: operator } },
      }])).toThrow("Only the platform");
      expect(() => compileEffectiveExecutionPolicy(descriptor(), [platform(), {
        kind, reference: "untrusted-policy", limits: {}, priceCeiling: {
          inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0, cachedInputMicrosPerMillionTokens: 0, source: operator,
        },
      }])).toThrow("Only the platform");
    }
  });

  it("requires exactly one explicit and complete platform policy without numerical defaults", () => {
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [])).toThrow("exactly one");
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [platform(), platform()])).toThrow("exactly one");
    const authority = platform();
    delete authority.limits.maxCallDurationMs;
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [authority])).toThrow("maxCallDurationMs");
  });

  it("rejects unattested provenance and uses attested limits only to narrow a known vendor limit", () => {
    const authority = platform();
    authority.attestedModelCaps = { maxOutputTokens: { value: 5000, source: operator } };
    expect(compileEffectiveExecutionPolicy(descriptor(), [authority]).policy.maxOutputTokens).toBe(5000);
    authority.attestedModelCaps.maxOutputTokens = { value: 50000, source: operator };
    expect(compileEffectiveExecutionPolicy(descriptor(), [authority]).policy.maxOutputTokens).toBe(10000);
    const untrusted = structuredClone(authority) as unknown as Record<string, unknown>;
    untrusted.attestedModelCaps = { contextTokens: { value: 128000, source: { ...official, kind: "registry" } } };
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [untrusted as unknown as ExecutionPolicyLayer])).toThrow("operator or official");
  });

  it("accepts exact context and root reservation boundaries without treating request bytes as tokens", () => {
    const authority = platform();
    authority.limits.contextTokens = 111000;
    authority.limits.maxRootTokens = 110000;
    authority.limits.maxInputBytes = 250;
    const result = compileEffectiveExecutionPolicy(descriptor(), [authority]);
    expect(result.policy).toMatchObject({ contextTokens: 111000, maxInputTokens: 100000, maxInputBytes: 250, maxRootTokens: 110000 });
  });

  it("rejects invalid configured relations before intersecting them with smaller authority ceilings", () => {
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [platform(), {
      kind: "agent", reference: "invalid", limits: { contextTokens: 100, maxInputTokens: 80, maxOutputTokens: 30 },
    }])).toThrow("Configured input");
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [platform(), {
      kind: "agent", reference: "invalid", limits: { compactAtTokens: 50000, maxInputTokens: 50000 },
    }])).toThrow("compaction");
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [platform(), {
      kind: "agent", reference: "invalid", limits: { maxRootTokens: 100, maxInputTokens: 80, maxOutputTokens: 30 },
    }])).toThrow("root token allowance");
  });

  it("rejects conflicting effective context, compaction and root allowance instead of silently rewriting settings", () => {
    const model = descriptor();
    model.contextTokens.value = 105000;
    expect(() => compileEffectiveExecutionPolicy(model, [platform()])).toThrow("reserves exceed");
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [platform(), {
      kind: "tenant", reference: "smaller-input", limits: { maxInputTokens: 50000 },
    }])).toThrow("Compaction threshold");
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [platform(), {
      kind: "tenant", reference: "smaller-root", limits: { maxRootTokens: 100000 },
    }])).toThrow("root token allowance");
  });

  it.each([NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "100"])("rejects invalid positive numerical ceilings: %s", value => {
    const authority = platform();
    (authority.limits as Record<string, unknown>).maxInputBytes = value;
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [authority])).toThrow();
  });

  it("allows zero tool calls and zero safety reserve when explicitly configured", () => {
    const authority = platform();
    authority.limits.maxToolCalls = 0;
    authority.limits.safetyTokens = 0;
    expect(compileEffectiveExecutionPolicy(descriptor(), [authority]).policy).toMatchObject({ maxToolCalls: 0, safetyTokens: 0 });
  });

  it("uses integer-safe relational comparisons at the maximum safe integer boundary", () => {
    const model = descriptor(), authority = platform();
    model.contextTokens.value = Number.MAX_SAFE_INTEGER;
    model.maxOutputTokens.value = Number.MAX_SAFE_INTEGER;
    Object.assign(authority.limits, {
      contextTokens: Number.MAX_SAFE_INTEGER, maxInputTokens: Number.MAX_SAFE_INTEGER - 10,
      maxOutputTokens: 11, safetyTokens: 0, maxRootTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(() => compileEffectiveExecutionPolicy(model, [authority])).toThrow("Configured input");
  });

  it("rejects hard money limits with unknown prices while keeping unknown distinct from zero", () => {
    const authority = platform();
    authority.limits.maxCostMicros = 0;
    expect(() => compileEffectiveExecutionPolicy(descriptor(), [authority])).toThrow("hard cost cap");
    const model = descriptor();
    model.pricing = {
      currency: "USD", inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0,
      cachedInputMicrosPerMillionTokens: null, source: official, revision: "free-price-v1",
    };
    expect(compileEffectiveExecutionPolicy(model, [authority]).policy.maxCostMicros).toBe(0);
    model.pricing.outputMicrosPerMillionTokens = null;
    expect(() => compileEffectiveExecutionPolicy(model, [authority])).toThrow("hard cost cap");
  });

  it("accepts a sourced platform price ceiling and preserves reasoning and cache price accounting inputs", () => {
    const authority = platform();
    authority.limits.maxCostMicros = 100000;
    authority.priceCeiling = {
      inputMicrosPerMillionTokens: 2000000, outputMicrosPerMillionTokens: 8000000,
      cachedInputMicrosPerMillionTokens: 500000, source: operator,
    };
    const model = descriptor();
    model.capabilities.reasoning = { value: true, evidence: "declared", source: official };
    const result = compileEffectiveExecutionPolicy(model, [authority]);
    expect(result.pricing).toEqual({
      inputMicrosPerMillionTokens: 2000000, outputMicrosPerMillionTokens: 8000000,
      cachedInputMicrosPerMillionTokens: 500000, sources: [operator],
    });
    expect(result.policy.maxOutputTokens).toBe(10000);
    model.pricing = {
      currency: "USD", inputMicrosPerMillionTokens: 3000000, outputMicrosPerMillionTokens: 6000000,
      cachedInputMicrosPerMillionTokens: 700000, source: official, revision: "prices-v2",
    };
    expect(compileEffectiveExecutionPolicy(model, [authority]).pricing).toMatchObject({
      inputMicrosPerMillionTokens: 3000000, outputMicrosPerMillionTokens: 8000000, cachedInputMicrosPerMillionTokens: 700000,
    });
  });

  it("changes the policy digest when model capacity, provenance, pricing or a policy reference changes", () => {
    const model = descriptor(), authority = platform();
    const digest = compileEffectiveExecutionPolicy(model, [authority]).policy.digest;
    for (const mutate of [
      (candidate: ModelDescriptor) => { candidate.revision = "model-v2"; },
      (candidate: ModelDescriptor) => { candidate.contextTokens.value = 129000; },
      (candidate: ModelDescriptor) => { candidate.contextTokens.source = { ...official, reference: "https://models.example.com/updated" }; },
      (candidate: ModelDescriptor) => { candidate.pricing = {
        currency: "USD", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 2,
        cachedInputMicrosPerMillionTokens: null, source: official, revision: "prices-v1",
      }; },
    ]) {
      const candidate = structuredClone(model);
      mutate(candidate);
      expect(compileEffectiveExecutionPolicy(candidate, [authority]).policy.digest).not.toBe(digest);
    }
    authority.reference = "platform-policy-v2";
    expect(compileEffectiveExecutionPolicy(model, [authority]).policy.digest).not.toBe(digest);
  });
});
