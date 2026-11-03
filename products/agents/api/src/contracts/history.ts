import { z } from "zod";

const operationId = z.string().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/);
const sequence = z.string().regex(/^[0-9]{1,19}$/);
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const part = z.enum(["conversation", "operations"]);

const historySearchV1InputSchema = z.strictObject({
  query: z.string().max(512).optional(), since: z.iso.datetime({ offset: true }).optional(),
  before: z.iso.datetime({ offset: true }).optional(), part: part.default("conversation"),
  beforeOperationId: operationId.optional(), beforeSequence: sequence.optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
export const historySearchInputSchema = historySearchV1InputSchema.extend({
  part: z.enum(["conversation", "operations", "artifacts"]).default("conversation"),
  beforeArtifactId: z.uuid().optional(),
}).refine(input => input.part === "artifacts" || input.beforeArtifactId === undefined);
export const historyReadInputSchema = z.strictObject({
  taskId: z.uuid().optional(), operationId: operationId.optional(), artifactId: z.uuid().optional(), offset: offset.default(0),
  part: z.enum(["conversation", "operations", "artifact"]).default("conversation"),
}).refine(input => Boolean(input.taskId) !== Boolean(input.operationId))
  .refine(input => input.artifactId ? Boolean(input.taskId) && input.part !== "operations" : input.part !== "artifact");
const historyReadV1InputSchema = z.strictObject({
  taskId: z.uuid().optional(), operationId: operationId.optional(), offset: offset.default(0),
  part: part.default("conversation"),
}).refine(input => Boolean(input.taskId) !== Boolean(input.operationId));
const historyResultSchema = z.strictObject({
  taskId: z.uuid(), sequence, createdAt: z.iso.datetime({ offset: true }),
  preview: z.string().max(512), complete: z.literal(false), digest,
  operationId: operationId.optional(), name: z.string().optional(),
  state: z.enum(["completed", "failed", "uncertain"]).optional(),
});
const artifactMetadata = z.strictObject({ name: z.string().max(120), contentType: z.string().max(128), bytes: offset, contentDigest: digest });
const currentHistoryResultSchema = historyResultSchema.extend({ artifactId: z.uuid().optional(), artifact: artifactMetadata.optional(), metadataOnly: z.literal(true).optional() });
export type HistoryResult = z.infer<typeof currentHistoryResultSchema>;
export const historyResultBytes = { "history.search": 98304, "history.read": 32768 } as const;
export const historyContracts = {
  "history.search": {
    input: historySearchInputSchema,
    output: z.strictObject({ results: z.array(currentHistoryResultSchema).max(20),
      nextBeforeSequence: sequence.nullable(), nextBeforeOperationId: operationId.nullable().optional(),
      nextBeforeArtifactId: z.uuid().nullable().optional(),
      availability: z.literal("retained_authorized_records"), previews: z.literal(true) }),
    authority: ["model.reply"], resources: ["current_noncustomer_conversation", "current_evidence_authority"],
    reconciliation: "not_applicable",
  },
  "history.read": {
    input: historyReadInputSchema,
    output: z.strictObject({ taskId: z.uuid(), operationId: operationId.optional(), artifactId: z.uuid().optional(),
      part: z.enum(["conversation", "operations", "artifact"]),
      artifact: z.strictObject({ name: z.string().max(120), contentType: z.string().max(128), contentDigest: digest }).optional(),
      encoding: z.literal("utf8").optional(),
      content: z.string().max(4096), offset, nextOffset: offset.nullable(), totalBytes: offset,
      digest, complete: z.boolean(), availability: z.literal("available"), trust: z.literal("reference_data") }),
    authority: ["model.reply"], resources: ["current_noncustomer_conversation", "exact_retained_record", "current_evidence_authority"],
    reconciliation: "not_applicable",
  },
} as const;

export const historySearchV1Contract = { ...historyContracts["history.search"], input: historySearchV1InputSchema,
  output: z.strictObject({ results: z.array(historyResultSchema).max(20),
    nextBeforeSequence: sequence.nullable(), nextBeforeOperationId: operationId.nullable().optional(),
    availability: z.literal("retained_authorized_records"), previews: z.literal(true) }) };
export const historyReadV1Contract = { ...historyContracts["history.read"], input: historyReadV1InputSchema,
  output: historyContracts["history.read"].output.omit({ artifactId: true, artifact: true, encoding: true }).extend({ part }) };
