import { modelIdentitySchema, ProviderTransportError, type ModelIdentity } from "../../contracts/model-transport";

/** Reported names are evidence, never a replacement route or an assertion of alias equivalence. */
export function observeModelIdentity(requestedModelId: string) {
  let returnedModelId: string | null = null;
  return {
    observe(value: unknown): void {
      if (value === undefined) return;
      if (typeof value !== "string" || !value.length || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value) || value.trim() !== value) {
        throw new ProviderTransportError("MODEL_RESPONSE_IDENTITY_INVALID", "uncertain");
      }
      if (returnedModelId !== null && returnedModelId !== value) throw new ProviderTransportError("MODEL_RESPONSE_IDENTITY_CONFLICT", "uncertain");
      returnedModelId = value;
    },
    receipt(): ModelIdentity {
      return modelIdentitySchema.parse({ requestedModelId, returnedModelId,
        relation: returnedModelId === null ? "unreported" : returnedModelId === requestedModelId ? "same" : "different" });
    },
  };
}
