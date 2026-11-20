import { z } from "zod";
import { canonicalJson, requestDigest } from "../../contracts/contracts";
import {
  effectiveExecutionPolicySchema, metadataSourceSchema, modelDescriptorSchema,
  type EffectiveExecutionPolicy, type ModelDescriptor,
} from "../../contracts/model-providers";

export type ExecutionPolicyLimits = Omit<EffectiveExecutionPolicy, "revision" | "digest">;
type MetadataSource = z.infer<typeof metadataSourceSchema>;
export type ModelCapacityKey = "contextTokens" | "maxInputTokens" | "maxOutputTokens";
export type ExecutionPolicyLayerKind = "platform" | "product" | "tenant" | "agent";

export interface AttestedModelCeiling {
  value: number;
  source: MetadataSource & { kind: "operator" | "official" };
}

export interface ExecutionPriceCeiling {
  inputMicrosPerMillionTokens: number;
  outputMicrosPerMillionTokens: number;
  cachedInputMicrosPerMillionTokens: number | null;
  source: MetadataSource & { kind: "operator" | "official" };
}

export interface ExecutionPolicyLayer {
  kind: ExecutionPolicyLayerKind;
  reference: string;
  limits: Partial<ExecutionPolicyLimits>;
  contextMode?:"automatic";
  attestedModelCaps?: Partial<Record<ModelCapacityKey, AttestedModelCeiling>>;
  priceCeiling?: ExecutionPriceCeiling;
}

export interface PolicyLimitSource {
  kind: ExecutionPolicyLayerKind | "model" | "attestation" | "derived";
  reference: string;
  value: number | null;
  metadata?: MetadataSource | null;
}

export interface ExecutionPolicyDecision {
  field: keyof ExecutionPolicyLimits;
  value: number | null;
  rule: "minimum" | "maximum";
  sources: readonly PolicyLimitSource[];
}

export interface ResolvedPolicyPricing {
  inputMicrosPerMillionTokens: number | null;
  outputMicrosPerMillionTokens: number | null;
  cachedInputMicrosPerMillionTokens: number | null;
  sources: readonly MetadataSource[];
}

export interface CompiledExecutionPolicy {
  policy: EffectiveExecutionPolicy;
  decisions: readonly ExecutionPolicyDecision[];
  modelRevision: string;
  pricing: ResolvedPolicyPricing | null;
}

/**
 * Internal maintenance calls need room for a summary even when the user-facing
 * reply cap is small. This never widens the primary or delegated route.
 */
export function withCompactionOutputAllowance(compiled: CompiledExecutionPolicy, model: ModelDescriptor, minimum: number): CompiledExecutionPolicy {
  const available = compiled.policy.contextTokens - compiled.policy.maxInputTokens - compiled.policy.safetyTokens;
  const maxOutputTokens = Math.min(Math.max(compiled.policy.maxOutputTokens, minimum), available);
  if (maxOutputTokens <= compiled.policy.maxOutputTokens) return compiled;
  const { revision, digest: _digest, ...limits } = compiled.policy;
  const resolved = { ...limits, maxOutputTokens };
  const decisions: ExecutionPolicyDecision[] = [...compiled.decisions, { field: "maxOutputTokens", value: maxOutputTokens, rule: "maximum",
    sources: [{ kind: "platform", reference: "compaction-output-floor:v1", value: maxOutputTokens }] }];
  const policy = effectiveExecutionPolicySchema.parse({ ...resolved, revision, digest: "0".repeat(64) });
  policy.digest = requestDigest({ revision, model, decisions, pricing: compiled.pricing, policy: resolved });
  return { ...compiled, policy, decisions };
}

const { revision: _revision, digest: _digest, ...limitShape } = effectiveExecutionPolicySchema.shape;
const limitsSchema = z.strictObject({
  ...limitShape,
  maxModelCalls: limitShape.maxModelCalls.removeDefault(), maxToolCalls: limitShape.maxToolCalls.removeDefault(),
  maxRootModelCalls: limitShape.maxRootModelCalls.removeDefault(), maxRootToolCalls: limitShape.maxRootToolCalls.removeDefault(),
  maxRootTokens: limitShape.maxRootTokens.removeDefault(), maxDurationMs: limitShape.maxDurationMs.removeDefault(), maxWallDurationMs: limitShape.maxWallDurationMs.removeDefault(),
}).partial();
const attestationSourceSchema = metadataSourceSchema.refine(
  source => source.kind === "operator" || source.kind === "official", "Capacity and price attestations require operator or official provenance",
);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ceilingSchema = z.strictObject({ value: safeInteger.positive(), source: attestationSourceSchema });
const layerSchema = z.strictObject({
  kind: z.enum(["platform", "product", "tenant", "agent"]),
  reference: z.string().trim().min(1).max(2048),
  limits: limitsSchema,
  contextMode:z.literal("automatic").optional(),
  attestedModelCaps: z.strictObject({
    contextTokens: ceilingSchema.optional(), maxInputTokens: ceilingSchema.optional(), maxOutputTokens: ceilingSchema.optional(),
  }).optional(),
  priceCeiling: z.strictObject({
    inputMicrosPerMillionTokens: safeInteger, outputMicrosPerMillionTokens: safeInteger,
    cachedInputMicrosPerMillionTokens: safeInteger.nullable(), source: attestationSourceSchema,
  }).optional(),
}).superRefine((layer, context) => {
  if (layer.kind !== "platform" && (layer.attestedModelCaps !== undefined || layer.priceCeiling !== undefined)) {
    context.addIssue({ code: "custom", message: "Only the platform may attest model capacity or pricing" });
  }
  if(layer.contextMode&&layer.kind!=="agent")context.addIssue({code:"custom",message:"Automatic context is an agent configuration mode"});
  const limits = layer.limits;
  if (limits.contextTokens !== undefined &&
    BigInt(limits.maxInputTokens ?? 0) + BigInt(limits.maxOutputTokens ?? 0) + BigInt(limits.safetyTokens ?? 0) > BigInt(limits.contextTokens)) {
    context.addIssue({ code: "custom", message: "Configured input, output and safety reserves exceed context" });
  }
  if (limits.maxInputTokens !== undefined && limits.compactAtTokens !== undefined && limits.compactAtTokens >= limits.maxInputTokens) {
    context.addIssue({ code: "custom", message: "Configured compaction threshold must be below input allowance" });
  }
  if (limits.maxRootTokens !== undefined && limits.maxRootTokens !== null &&
    BigInt(limits.maxInputTokens ?? 0) + BigInt(limits.maxOutputTokens ?? 0) > BigInt(limits.maxRootTokens)) {
    context.addIssue({ code: "custom", message: "Configured model call exceeds root token allowance" });
  }
});

const fields = Object.keys(limitShape).sort() as (keyof ExecutionPolicyLimits)[];
const capacityFields: readonly ModelCapacityKey[] = ["contextTokens", "maxInputTokens", "maxOutputTokens"];
const compilerRevision = "model-execution-policy-v3";
const optionalAllowanceFields = new Set<keyof ExecutionPolicyLimits>([
  "maxModelCalls", "maxToolCalls", "maxRootModelCalls", "maxRootToolCalls", "maxRootTokens", "maxDurationMs", "maxWallDurationMs", "maxCostMicros",
]);

function resolvePricing(model: ModelDescriptor, platform: ExecutionPolicyLayer): ResolvedPolicyPricing | null {
  const known = model.pricing;
  const ceiling = platform.priceCeiling;
  if (!known && !ceiling) return null;
  const maximumKnownPrice = (field: "inputMicrosPerMillionTokens" | "outputMicrosPerMillionTokens" | "cachedInputMicrosPerMillionTokens") => {
    const values = [known?.[field], ceiling?.[field]].filter((value): value is number => value !== undefined && value !== null);
    return values.length ? Math.max(...values) : null;
  };
  return {
    inputMicrosPerMillionTokens: maximumKnownPrice("inputMicrosPerMillionTokens"),
    outputMicrosPerMillionTokens: maximumKnownPrice("outputMicrosPerMillionTokens"),
    cachedInputMicrosPerMillionTokens: maximumKnownPrice("cachedInputMicrosPerMillionTokens"),
    sources: [known?.source, ceiling?.source].filter((source): source is MetadataSource => source !== undefined),
  };
}

/** Resolve execution settings before admission; this performs no discovery or secret access. */
export function compileEffectiveExecutionPolicy(
  descriptor: ModelDescriptor,
  layers: readonly ExecutionPolicyLayer[],
): CompiledExecutionPolicy {
  const model = modelDescriptorSchema.parse(descriptor);
  const parsed = z.array(layerSchema).parse(layers);
  const platforms = parsed.filter(layer => layer.kind === "platform");
  if (platforms.length !== 1) throw new Error("Execution policy requires exactly one platform authority layer");
  const platform = platforms[0]!;
  for (const field of fields) {
    if (platform.limits[field] === undefined && !optionalAllowanceFields.has(field)) throw new Error(`Platform policy must explicitly configure ${field}`);
  }
  for (const field of capacityFields) {
    if (model[field].value === null && field !== "maxInputTokens" && platform.attestedModelCaps?.[field] === undefined) {
      throw new Error(`Model ${field} is unknown; an operator or official capacity attestation is required`);
    }
  }

  const resolved: Partial<ExecutionPolicyLimits> = {};
  const decisions: ExecutionPolicyDecision[] = [];
  const modelReference = `${model.providerId}/${model.id}@${model.revision}`;
  for (const field of fields) {
    const sources: PolicyLimitSource[] = parsed.flatMap(layer => {
      const value = layer.limits[field];
      return value === undefined ? [] : [{ kind: layer.kind, reference: layer.reference, value }];
    });
    if (capacityFields.includes(field as ModelCapacityKey)) {
      const capacityField = field as ModelCapacityKey;
      const capacity = model[capacityField];
      sources.push({ kind: "model", reference: modelReference, value: capacity.value, metadata: capacity.source });
      const attestation = platform.attestedModelCaps?.[capacityField];
      if (attestation) sources.push({ kind: "attestation", reference: platform.reference, value: attestation.value, metadata: attestation.source });
    }
    sources.sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
    const values = sources.flatMap(source => source.value === null ? [] : [source.value]);
    const rule = field === "safetyTokens" ? "maximum" : "minimum";
    const value = values.length ? (rule === "maximum" ? Math.max(...values) : Math.min(...values)) : null;
    Object.assign(resolved, { [field]: value });
    decisions.push({ field, value, rule, sources });
  }

  if(parsed.some(layer=>layer.contextMode==="automatic")){
    const context=resolved.contextTokens!,output=resolved.maxOutputTokens!,safety=resolved.safetyTokens!;
    const input=Math.min(resolved.maxInputTokens!,context-output-safety,
      ...(resolved.maxRootTokens===null?[]:[resolved.maxRootTokens!-output]));
    if(!Number.isSafeInteger(input)||input<2)throw new Error("The selected model cannot fit the configured output and context reserves");
    const derived=(field:"maxInputTokens"|"compactAtTokens",value:number,reference:string)=>{
      resolved[field]=value;
      const decision=decisions.find(item=>item.field===field)!;decision.value=value;
      decision.sources=[...decision.sources,{kind:"derived" as const,reference,value}].sort((a,b)=>canonicalJson(a)<canonicalJson(b)?-1:canonicalJson(a)>canonicalJson(b)?1:0);
    };
    derived("maxInputTokens",input,"automatic-context-v1:selected-window-minus-output-and-safety-with-service-product-ceilings");
    const ratio=platform.limits.compactAtTokens!/platform.limits.maxInputTokens!;
    const threshold=Math.max(1,Math.min(resolved.compactAtTokens!,input-1,Math.floor(input*ratio)));
    derived("compactAtTokens",threshold,"automatic-context-v1:service-compaction-headroom-proportion");
  }

  const pricing = resolvePricing(model, platform as ExecutionPolicyLayer);
  if (resolved.maxCostMicros !== null &&
    (!pricing || pricing.inputMicrosPerMillionTokens === null || pricing.outputMicrosPerMillionTokens === null)) {
    throw new Error("A hard cost cap requires known input and output pricing or an operator price ceiling");
  }
  const policy = effectiveExecutionPolicySchema.parse({ ...resolved, revision: compilerRevision, digest: "0".repeat(64) });
  policy.digest = requestDigest({
    revision: compilerRevision, model, decisions, pricing, policy: resolved,
  });
  return { policy, decisions, modelRevision: model.revision, pricing };
}
