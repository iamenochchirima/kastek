import { z } from "zod";
import type { ProductInformationEnvelope } from "@kasitek-labs/contracts";
import { canonicalJson, PlatformError, requestDigest } from "./contracts";
import type { ResolvedModelBinding } from "./model-providers";

const text = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const actor = z.strictObject({ issuer: z.url().max(512), subject: text });
export const productProviderDestinationSchema = z.strictObject({
  destinationDigest: hash, bindingDigest: hash, providerId: text, protocol: text,
  endpoint: z.url().max(2048), connectionId: z.uuid(), connectionRevision: z.number().int().positive(),
  credentialRevision: z.number().int().positive(), modelId: text,
}).superRefine((value, context) => {
  const { destinationDigest, bindingDigest: _bindingDigest, ...destination } = value;
  if (requestDigest(destination) !== destinationDigest) context.addIssue({ code: "custom", message: "Provider destination digest mismatch" });
});
export const productInformationEnvelopeSchema = z.strictObject({
  version: z.literal("1"),
  origin: z.strictObject({ product: text, tenantId: text, actor }),
  audience: z.strictObject({ product: text, tenantId: text, actor, conversationId: z.uuid(), clientId: text.nullable() }),
  providers: z.array(productProviderDestinationSchema).min(1).max(3)
    .refine(values => new Set(values.map(value => value.destinationDigest)).size === values.length, "Duplicate provider destination"),
});
export const productExecutionLineageSchema = z.strictObject({
  version: z.literal("1"), workId: z.uuid(), rootTaskId: z.uuid(), parentTaskId: z.uuid().nullable(), taskId: z.uuid(),
});

export function productProviderDestination(binding: ResolvedModelBinding): ProductInformationEnvelope["providers"][number] {
  const destination = { providerId: binding.providerId, protocol: binding.protocol, endpoint: binding.endpoint,
    connectionId: binding.connectionId, connectionRevision: binding.connectionRevision,
    credentialRevision: binding.credentialRevision, modelId: binding.modelId };
  return { ...destination, destinationDigest: requestDigest(destination), bindingDigest: requestDigest(binding) };
}

/** A destination may reduce eligible providers. It cannot choose a different recipient. */
export function narrowProductInformation(request: ProductInformationEnvelope, response?: ProductInformationEnvelope): ProductInformationEnvelope {
  const accepted = productInformationEnvelopeSchema.parse(request);
  if (response === undefined) return accepted;
  const returned = productInformationEnvelopeSchema.parse(response);
  if (canonicalJson(returned.origin) !== canonicalJson(accepted.origin) ||
      canonicalJson(returned.audience) !== canonicalJson(accepted.audience) ||
      returned.providers.some(provider => !accepted.providers.some(value => canonicalJson(value) === canonicalJson(provider)))) {
    throw new PlatformError("PRODUCT_INFORMATION_DENIED", 403, "The product result has an incompatible information audience");
  }
  return returned;
}
