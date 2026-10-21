import { z } from "zod";

/** Operator setup protections, not vendor model capacities or generation allowances. */
export const modelSetupPolicySchema = z.strictObject({
  maxCatalogueBytes: z.number().int().positive().max(2097152),
  maxCatalogueModels: z.number().int().positive(),
  catalogueTtlMs: z.number().int().positive(),
  discoveryDeadlineMs: z.number().int().positive().max(30000),
});
export type ModelSetupPolicy = z.infer<typeof modelSetupPolicySchema>;
export const defaultModelSetupPolicy: ModelSetupPolicy = Object.freeze({
  maxCatalogueBytes: 2097152,
  maxCatalogueModels: 5000,
  catalogueTtlMs: 300000,
  discoveryDeadlineMs: 30000,
});
