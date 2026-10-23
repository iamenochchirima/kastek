import { z } from "zod";

export const programReferenceSchema = z.strictObject({
  id: z.enum(["grounded-conversation", "tool-directed"]),
  version: z.enum(["1", "2", "3"]),
});
export type ProgramReference = z.infer<typeof programReferenceSchema>;

const releaseSchema = z.strictObject({ id: z.string().min(1), version: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/) });
export const effectiveCompositionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  program: releaseSchema,
  runtime: z.strictObject({ kind: z.enum(["business", "workspace"]), release: z.string().min(1), workflow: z.string().min(1) }),
  context: z.strictObject({
    conversation: z.literal("ordered-evidence-v1"), knowledge: z.literal("approved-revisions-v1"),
    personalMemory: z.enum(["disabled", "reviewed-principal-v1"]),
    compaction: z.literal("dependency-preserving-v1"), productRecords: z.literal("authorized-tool-results-only"),
  }),
  capabilities: z.array(releaseSchema),
  workflows: z.array(releaseSchema),
  connectedBindings: z.array(z.strictObject({ id: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) })),
  productBindings: z.array(z.strictObject({ id:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/) })).default([]),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EffectiveComposition = z.infer<typeof effectiveCompositionSchema>;
