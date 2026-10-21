import { z } from "zod";

/** Operator setup protections, not vendor model capacities or generation allowances. */
export const modelSetupPolicySchema = z.strictObject({
  maxCatalogueBytes: z.number().int().positive().max(2097152),
  maxCatalogueModels: z.number().int().positive(),
  catalogueTtlMs: z.number().int().positive(),
  refreshMinIntervalMs: z.number().int().positive().default(30000),
  refreshMaxBackoffMs: z.number().int().positive().default(900000),
  discoveryDeadlineMs: z.number().int().positive().max(30000),
  probeMaxOutputTokens: z.number().int().positive(),
  probeMaxRequestBytes: z.number().int().positive(),
  probeMaxResponseBytes: z.number().int().positive(),
  probeDeadlineMs: z.number().int().positive(),
});
export type ModelSetupPolicy = z.infer<typeof modelSetupPolicySchema>;
export const defaultModelSetupPolicy: ModelSetupPolicy = Object.freeze({
  maxCatalogueBytes: 2097152,
  maxCatalogueModels: 5000,
  catalogueTtlMs: 300000,
  refreshMinIntervalMs: 30000,
  refreshMaxBackoffMs: 900000,
  discoveryDeadlineMs: 30000,
  probeMaxOutputTokens: 256,
  probeMaxRequestBytes: 32768,
  probeMaxResponseBytes: 262144,
  probeDeadlineMs: 30000,
});
