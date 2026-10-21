import { z } from "zod";

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const revision = z.string().min(1).max(128);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const modelIdSchema = z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));

// This checks configuration syntax. Dispatch must also apply the server egress policy.
export const modelEndpointSchema = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "Model endpoints require HTTPS without embedded credentials, query or fragment");

export const modelProtocolSchema = z.enum([
  "openai_chat_completions", "openai_responses", "anthropic_messages", "google_generate_content",
]);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;

export const providerDefinitionSchema = z.strictObject({
  id: identifier,
  name: z.string().trim().min(1).max(120),
  protocol: modelProtocolSchema,
  baseUrl: modelEndpointSchema,
  auth: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("bearer") }),
    z.strictObject({ kind: z.literal("header"), headerName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/) }),
  ]),
  discovery: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("curated") }),
    z.strictObject({ kind: z.literal("models_endpoint"), path: z.string().max(256)
      .regex(/^\/[A-Za-z0-9_./-]*$/).refine(value => !value.startsWith("//") && !value.split("/").includes("..")) }),
  ]),
  officialDocsUrl: modelEndpointSchema,
  adapter: z.strictObject({ id: identifier, revision, readiness: z.enum(["planned", "installed"]) }),
});
export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;

export const metadataSourceSchema = z.strictObject({
  kind: z.enum(["official", "registry", "discovery", "verified", "operator"]),
  reference: z.string().min(1).max(2048),
  observedAt: z.iso.datetime(),
});
const sourcedCapacity = z.strictObject({ value: positiveInteger.nullable(), source: metadataSourceSchema.nullable() })
  .refine(field => field.value === null || field.source !== null, "Known capacity requires provenance");
const sourcedCapability = z.strictObject({
  value: z.boolean().nullable(),
  evidence: z.enum(["unknown", "declared", "discovered", "verified"]),
  source: metadataSourceSchema.nullable(),
}).refine(field => field.value === null ? field.evidence === "unknown" : field.source !== null && field.evidence !== "unknown",
  "Capability evidence must agree with its value");

export const modelDescriptorSchema = z.strictObject({
  id: modelIdSchema,
  providerId: identifier,
  name: z.string().min(1).max(256),
  protocol: modelProtocolSchema,
  revision,
  contextTokens: sourcedCapacity,
  maxInputTokens: sourcedCapacity,
  maxOutputTokens: sourcedCapacity,
  capabilities: z.strictObject({ tools: sourcedCapability, reasoning: sourcedCapability, structuredOutput: sourcedCapability }),
  inputModalities: z.array(z.enum(["text", "image", "audio", "video"])),
  outputModalities: z.array(z.enum(["text", "image", "audio", "video"])),
  pricing: z.strictObject({
    currency: z.literal("USD"),
    inputMicrosPerMillionTokens: tokenCount.nullable(),
    outputMicrosPerMillionTokens: tokenCount.nullable(),
    cachedInputMicrosPerMillionTokens: tokenCount.nullable(),
    source: metadataSourceSchema,
    revision,
  }).nullable(),
  lifecycle: z.enum(["active", "deprecated", "retired", "unknown"]),
  setupSource: metadataSourceSchema.optional(),
});
export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

export const modelRoleSchema = z.enum(["primary", "compaction", "delegated"]);
export type ModelRole = z.infer<typeof modelRoleSchema>;
export const modelSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("organization_default") }),
  z.strictObject({ kind: z.literal("connection"), connectionId: z.uuid(), modelId: modelIdSchema }),
]);
export type ModelSelection = z.infer<typeof modelSelectionSchema>;

// Public connection records deliberately have no API-key, envelope or fingerprint field.
export const providerConnectionSchema = z.strictObject({
  id: z.uuid(), organizationId: z.uuid(), createdBy: z.uuid(), providerId: identifier,
  name: z.string().trim().min(1).max(120), endpoint: modelEndpointSchema, protocol: modelProtocolSchema,
  revision: positiveInteger, credentialRevision: positiveInteger,
  custody: z.enum(["user_supplied", "platform_managed"]),
  state: z.enum(["active", "revoked", "removed"]),
  verification: z.enum(["saved", "discovered", "inference_verified", "tools_verified"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

export const credentialRevisionSchema = z.strictObject({
  id: z.uuid(), organizationId: z.uuid(), connectionId: z.uuid(), revision: positiveInteger,
  endpoint: modelEndpointSchema, protocol: modelProtocolSchema,
  state: z.enum(["active", "revoked"]), createdAt: z.iso.datetime(),
});
export type CredentialRevision = z.infer<typeof credentialRevisionSchema>;

export const providerUseGrantSchema = z.strictObject({
  id: z.uuid(), organizationId: z.uuid(), connectionId: z.uuid(),
  consumer: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("agent"), agentId: z.uuid() }),
    z.strictObject({ kind: z.literal("service"), serviceId: identifier, product: z.enum(["agents", "growth", "agencies"]) }),
  ]),
  roles: z.array(modelRoleSchema).min(1).refine(values => new Set(values).size === values.length),
  modelIds: z.array(modelIdSchema).min(1).refine(values => new Set(values).size === values.length),
  revision: positiveInteger, state: z.enum(["active", "revoked"]),
});
export type ProviderUseGrant = z.infer<typeof providerUseGrantSchema>;

export const effectiveExecutionPolicySchema = z.strictObject({
  revision, digest: z.string().regex(/^[a-f0-9]{64}$/),
  contextTokens: positiveInteger, maxInputTokens: positiveInteger, maxOutputTokens: positiveInteger,
  safetyTokens: tokenCount, compactAtTokens: positiveInteger,
  maxModelCalls: positiveInteger, maxToolCalls: tokenCount, maxDurationMs: positiveInteger, maxCallDurationMs: positiveInteger,
  maxInputBytes: positiveInteger, maxRequestBytes: positiveInteger, maxResponseBytes: positiveInteger,
  maxMessages: positiveInteger, maxTools: tokenCount, maxRootTokens: positiveInteger,
  maxCostMicros: tokenCount.nullable(),
}).superRefine((policy, context) => {
  if (BigInt(policy.maxInputTokens) + BigInt(policy.maxOutputTokens) + BigInt(policy.safetyTokens) > BigInt(policy.contextTokens)) {
    context.addIssue({ code: "custom", message: "Input, output and safety reserves exceed model context", path: ["maxInputTokens"] });
  }
  if (policy.maxCallDurationMs > policy.maxDurationMs) {
    context.addIssue({ code: "custom", message: "A model call must fit the root active-time allowance", path: ["maxCallDurationMs"] });
  }
  if (policy.compactAtTokens >= policy.maxInputTokens) {
    context.addIssue({ code: "custom", message: "Compaction threshold must be below input allowance", path: ["compactAtTokens"] });
  }
  if (BigInt(policy.maxInputTokens) + BigInt(policy.maxOutputTokens) > BigInt(policy.maxRootTokens)) {
    context.addIssue({ code: "custom", message: "A model call must fit its root token allowance", path: ["maxRootTokens"] });
  }
});
export type EffectiveExecutionPolicy = z.infer<typeof effectiveExecutionPolicySchema>;

export const resolvedModelBindingSchema = z.strictObject({
  organizationId: z.uuid(), connectionId: z.uuid(), connectionRevision: positiveInteger,
  credentialRevision: positiveInteger, useGrantId: z.uuid(), useGrantRevision: positiveInteger,
  providerId: identifier, providerDefinitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  endpoint: modelEndpointSchema, protocol: modelProtocolSchema, modelId: modelIdSchema,
  modelRevision: revision, adapterId: identifier, adapterRevision: revision, role: modelRoleSchema,
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/), generationDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type ResolvedModelBinding = z.infer<typeof resolvedModelBindingSchema>;
