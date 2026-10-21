import { z } from "zod";
import { requestDigest } from "../../contracts/contracts";
import { modelDescriptorSchema, modelIdSchema, type ModelDescriptor, type ProviderDefinition } from "../../contracts/model-providers";
import { enrichProviderModels } from "../../adapters/models/model-metadata";

const capacity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const modalities = z.array(z.enum(["text", "image", "audio", "video"])).min(1).max(4);
export const manualModelInput = z.strictObject({
  expectedRevision: z.number().int().positive(), modelId: modelIdSchema,
  metadata: z.strictObject({
    reference: z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
    contextTokens: capacity.optional(), maxInputTokens: capacity.optional(), maxOutputTokens: capacity.optional(),
    tools: z.boolean().optional(), reasoning: z.boolean().optional(),
    inputModalities: modalities.optional(), outputModalities: modalities.optional(),
  }).optional(),
  confirmMetadata: z.literal(true).optional(),
}).refine(input => !input.metadata || input.confirmMetadata === true, "Confirm the reviewed model metadata");

/** Owner declarations constrain a private route; they never override platform ceilings or prove inference. */
export async function manualModelDescriptor(definition: ProviderDefinition, accountId: string,
  input: z.infer<typeof manualModelInput>, observedAt: string): Promise<ModelDescriptor> {
  const unknown = { value: null, source: null };
  const unsupported = { value: null, source: null, evidence: "unknown" as const };
  const empty: ModelDescriptor = { id: input.modelId, name: input.modelId.slice(0, 256), providerId: definition.id,
    protocol: definition.protocol, revision: "pending", contextTokens: unknown, maxInputTokens: unknown, maxOutputTokens: unknown,
    capabilities: { tools: unsupported, reasoning: unsupported, structuredOutput: unsupported }, inputModalities: [], outputModalities: [],
    pricing: null, lifecycle: "unknown" };
  const model = (await enrichProviderModels(definition.id, [empty], observedAt))[0]!;
  const metadata = input.metadata;
  if (metadata) {
    const source = { kind: "operator" as const, reference: `owner:${accountId}:${metadata.reference}`, observedAt };
    model.setupSource = source;
    for (const field of ["contextTokens", "maxInputTokens", "maxOutputTokens"] as const) {
      if (metadata[field] !== undefined) model[field] = { value: metadata[field], source };
    }
    for (const field of ["tools", "reasoning"] as const) {
      if (metadata[field] !== undefined) model.capabilities[field] = { value: metadata[field], source, evidence: "declared" };
    }
    // Modalities are declarations within this explicitly attested descriptor, not discovered account access.
    if (metadata.inputModalities) model.inputModalities = metadata.inputModalities;
    if (metadata.outputModalities) model.outputModalities = metadata.outputModalities;
  }
  model.revision = requestDigest({ ...model, revision: "pending" });
  return modelDescriptorSchema.parse(model);
}

export function overlayManualModel(current: ModelDescriptor | undefined, manual: ModelDescriptor): ModelDescriptor {
  if (!current) return manual;
  const result = modelDescriptorSchema.parse(manual);
  for (const field of ["contextTokens", "maxInputTokens", "maxOutputTokens"] as const) {
    if (manual[field].source?.kind !== "operator" && current[field].value !== null) result[field] = current[field];
  }
  for (const field of ["tools", "reasoning", "structuredOutput"] as const) {
    if (manual.capabilities[field].source?.kind !== "operator" && current.capabilities[field].value !== null) result.capabilities[field] = current.capabilities[field];
  }
  if (current.inputModalities.length) result.inputModalities = current.inputModalities;
  if (current.outputModalities.length) result.outputModalities = current.outputModalities;
  if (current.pricing) result.pricing = current.pricing;
  result.lifecycle = current.lifecycle;
  result.revision = requestDigest({ ...result, revision: "pending" });
  return modelDescriptorSchema.parse(result);
}
