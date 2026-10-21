import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { effectiveExecutionPolicySchema, modelDescriptorSchema, modelSelectionSchema, providerConnectionSchema,
  providerDefinitionSchema, providerUseGrantSchema, resolvedModelBindingSchema } from "../src/contracts/model-providers";

const source = { kind: "official", reference: "https://example.test/models", observedAt: "2026-10-21T00:00:00Z" };
const capacity = (value: number | null) => ({ value, source: value === null ? null : source });
const unknown = { value: null, source: null, evidence: "unknown" };
const model = { id: "vendor/model:variant", providerId: "router", name: "Model", protocol: "openai_chat_completions", revision: "1",
  contextTokens: capacity(128000), maxInputTokens: capacity(null), maxOutputTokens: capacity(8192),
  capabilities: { tools: unknown, reasoning: unknown, structuredOutput: unknown },
  inputModalities: ["text"], outputModalities: ["text"], pricing: null, lifecycle: "unknown" };
const policy = { revision: "1", digest: "a".repeat(64), contextTokens: 128000, maxInputTokens: 96000, maxOutputTokens: 8192,
  safetyTokens: 1024, compactAtTokens: 80000, maxModelCalls: 20, maxToolCalls: 20, maxCallDurationMs: 120000, maxDurationMs: 300000,
  maxInputBytes: 1000000, maxRequestBytes: 2097152, maxMessages: 256, maxTools: 64, maxResponseBytes: 1000000, maxRootTokens: 200000, maxCostMicros: null };

describe("model provider ownership and capacity contracts", () => {
  it("preserves unknown metadata without inventing capabilities or free pricing", () => {
    const parsed = modelDescriptorSchema.parse(model);
    expect(parsed.maxInputTokens.value).toBeNull(); expect(parsed.pricing).toBeNull();
    expect(parsed.capabilities.tools).toEqual(unknown);
    expect(modelDescriptorSchema.safeParse({ ...model, contextTokens: { value: 128000, source: null } }).success).toBe(false);
    expect(modelDescriptorSchema.safeParse({ ...model, capabilities: { ...model.capabilities, tools: { ...unknown, value: true } } }).success).toBe(false);
  });
  it("accepts sourced larger policies while enforcing reserves, compaction and root allowances", () => {
    expect(effectiveExecutionPolicySchema.parse(policy).maxOutputTokens).toBe(8192);
    for (const changes of [{ contextTokens: 100000 }, { compactAtTokens: 96000 }, { maxRootTokens: 100000 }]) {
      expect(effectiveExecutionPolicySchema.safeParse({ ...policy, ...changes }).success).toBe(false);
    }
    expect(effectiveExecutionPolicySchema.safeParse({ ...policy, contextTokens: Number.MAX_SAFE_INTEGER,
      maxInputTokens: Number.MAX_SAFE_INTEGER, maxOutputTokens: 1, safetyTokens: 0, maxRootTokens: Number.MAX_SAFE_INTEGER }).success).toBe(false);
  });
  it("keeps route selection explicit and never embeds a credential in saved configuration", () => {
    expect(modelSelectionSchema.parse({ kind: "organization_default" })).toEqual({ kind: "organization_default" });
    const selected = { kind: "connection", connectionId: randomUUID(), modelId: "org/private-model" };
    expect(modelSelectionSchema.parse(selected)).toEqual(selected);
    expect(modelSelectionSchema.safeParse({ ...selected, apiKey: "secret" }).success).toBe(false);
    expect(modelSelectionSchema.safeParse({ ...selected, modelId: "bad\nheader" }).success).toBe(false);
  });
  it("requires tenant, consumer, explicit models and allowed roles on a use grant", () => {
    const grant = { id: randomUUID(), organizationId: randomUUID(), connectionId: randomUUID(),
      consumer: { kind: "agent", agentId: randomUUID() }, roles: ["primary"], modelIds: ["lab/model"], revision: 1, state: "active" };
    expect(providerUseGrantSchema.parse(grant).roles).toEqual(["primary"]);
    expect(providerUseGrantSchema.safeParse({ ...grant, modelIds: [] }).success).toBe(false);
    expect(providerUseGrantSchema.safeParse({ ...grant, roles: ["primary", "primary"] }).success).toBe(false);
  });
  it("keeps secrets out of public connection records and immutable invocation bindings", () => {
    const connection = { id: randomUUID(), organizationId: randomUUID(), createdBy: randomUUID(), providerId: "lab", name: "Work",
      endpoint: "https://api.example.test/v1", protocol: "openai_responses", revision: 1, credentialRevision: 1,
      custody: "user_supplied", state: "active", verification: "saved", createdAt: source.observedAt, updatedAt: source.observedAt };
    expect(providerConnectionSchema.parse(connection).verification).toBe("saved");
    expect(providerConnectionSchema.safeParse({ ...connection, apiKey: "secret" }).success).toBe(false);
    const binding = { organizationId: connection.organizationId, connectionId: connection.id, connectionRevision: 1,
      credentialRevision: 1, useGrantId: randomUUID(), useGrantRevision: 1, providerId: "lab", providerDefinitionDigest: "a".repeat(64),
      endpoint: connection.endpoint, protocol: connection.protocol, modelId: "lab/model", modelRevision: "1",
      adapterId: "native-responses", adapterRevision: "1", role: "primary", policyDigest: "b".repeat(64) };
    expect(resolvedModelBindingSchema.parse(binding).modelId).toBe("lab/model");
    expect(resolvedModelBindingSchema.safeParse({ ...binding, authorization: "secret" }).success).toBe(false);
  });
  it("allows reviewed data records but rejects executable hooks and credential-bearing endpoints", () => {
    const profile = { id: "lab", name: "Lab", protocol: "openai_responses", baseUrl: "https://api.example.test/v1",
      auth: { kind: "bearer" }, discovery: { kind: "models_endpoint", path: "/models" },
      officialDocsUrl: "https://example.test/docs", adapter: { id: "responses", revision: "1", readiness: "planned" } };
    expect(providerDefinitionSchema.parse(profile).id).toBe("lab");
    for (const changes of [{ execute: "script" }, { baseUrl: "https://key@example.test" }, { baseUrl: "https://example.test?api_key=secret" },
      { discovery: { kind: "models_endpoint", path: "//other.test/models" } }, { discovery: { kind: "models_endpoint", path: "/../models" } }]) {
      expect(providerDefinitionSchema.safeParse({ ...profile, ...changes }).success).toBe(false);
    }
  });
});
