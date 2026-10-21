import { z } from "zod";
import { providerDefinitionSchema, type ProviderDefinition } from "../../contracts/model-providers";
import profiles from "./provider-profiles.json";

const registrySchema = z.array(providerDefinitionSchema).superRefine((records, context) => {
  const ids = new Set<string>();
  for (const [index, record] of records.entries()) {
    if (ids.has(record.id)) {
      context.addIssue({ code: "custom", path: [index, "id"], message: "Provider IDs must be unique" });
    }
    ids.add(record.id);
  }
});

/** Parse a reviewed configuration snapshot without loading executable provider code. */
export function parseProviderRegistry(input: unknown): readonly ProviderDefinition[] {
  const records = registrySchema.parse(typeof input === "string" ? JSON.parse(input) : input);
  for (const record of records) {
    Object.freeze(record.auth);
    Object.freeze(record.discovery);
    Object.freeze(record.adapter);
    Object.freeze(record);
  }
  return Object.freeze(records);
}

export const builtinProviderRegistry = parseProviderRegistry(profiles);

export function getProviderDefinition(
  id: string,
  registry: readonly ProviderDefinition[] = builtinProviderRegistry,
): ProviderDefinition | undefined {
  return registry.find(record => record.id === id);
}
