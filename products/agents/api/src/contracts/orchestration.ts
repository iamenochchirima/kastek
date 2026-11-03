import { z } from "zod";

export const orchestrationTools = ["agents.discover", "agents.start", "agents.status", "agents.result", "agents.wait", "agents.followup", "agents.cancel", "work.update", "work.inspect"] as const;
export const orchestrationPolicySchema = z.strictObject({
  maxTasks: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().default(null),
  maxStalls: z.number().int().min(1).max(8),
});
export const workRecordSchema = z.strictObject({
  objective: z.string().trim().min(1).max(1024),
  steps: z.array(z.strictObject({ id: z.string().min(1).max(64), title: z.string().min(1).max(256), state: z.enum(["pending", "in_progress", "completed", "blocked"]) })).max(16)
    .refine(steps => new Set(steps.map(step => step.id)).size === steps.length, "Duplicate step"),
  questions: z.array(z.string().max(512)).max(8),
  evidenceTaskIds: z.array(z.uuid()).max(32),
});
const taskId = z.uuid();
const taskState = z.enum(["accepted", "running", "waiting_authority", "waiting_children", "waiting_review", "cancel_requested", "completed", "incomplete", "refused", "failed", "cancelled", "uncertain"]);
export const specialistWorkSchema = z.strictObject({
  bindingId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), brief: z.string().trim().min(1).max(8192),
  context: z.string().max(8192).optional(), deliverable: z.string().max(1024).optional(), criteria: z.array(z.string().max(512)).max(8).optional(),
});
export const specialistHistoryReferenceSchema = z.strictObject({ taskId, part: z.enum(["input", "output"]),
  offset: z.number().int().nonnegative().default(0), maxBytes: z.number().int().min(4).max(4096).default(4096) });
export const specialistWorkV2Schema = specialistWorkSchema.extend({
  historyReferences: z.array(specialistHistoryReferenceSchema).max(4).optional(),
});
export const specialistWorkV3Schema = specialistWorkV2Schema.extend({
  artifactIds: z.array(taskId).max(8).optional(),
});
export const specialistArtifactReferenceSchema = z.strictObject({ taskId, artifactId: taskId });
export const specialistWorkV4Schema = specialistWorkV3Schema.extend({
  artifactReferences: z.array(specialistArtifactReferenceSchema).max(8).optional(),
});
export const childStatusSchema = z.strictObject({ taskId, bindingId: z.string(), versionId: taskId, conversationId: taskId,
  state: taskState, errorCode: z.string().nullable(), priorTaskId: taskId.nullable(), resultAvailable: z.boolean(), needsInput: z.boolean() });
const children = z.array(childStatusSchema).max(64);
const progress = z.strictObject({ revision: z.number().int().nonnegative(), record: workRecordSchema.nullable() });
const resultOffset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const resultPage = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item).max(8), nextOffset: resultOffset.nullable() });
export const specialistResultMetadataSchema = z.strictObject({
  version: z.literal("1"),
  findings: z.strictObject({ origin: z.literal("agent_reported"), format: z.literal("text"), correctness: z.literal("not_assessed") }),
  coverage: z.strictObject({ assessment: z.literal("not_assessed"), work: progress.extend({ origin: z.literal("agent_reported") }) }),
  sources: resultPage(z.strictObject({ evidenceId: taskId, citation: z.string().max(40), taskId, operationId: z.string().max(1024),
    kind: z.enum(["source", "connection", "product", "memory"]), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) })),
  effects: resultPage(z.strictObject({ kind: z.enum(["product_review", "connected_review", "report_action"]), id: z.string().max(256),
    taskId, operationId: z.string().max(1024), state: z.string().max(32), product: z.string().max(128).nullable(), confirmation: z.enum(["confirmed", "not_confirmed", "unknown"]) })),
  artifacts: resultPage(z.strictObject({ id: taskId, taskId, name: z.string().max(120), contentType: z.string().max(128),
    bytes: z.number().int().nonnegative(), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) })),
});
export const orchestrationContracts = {
  "agents.discover": { input: z.strictObject({ query: z.string().max(200).optional(), bindingId: z.string().max(64).optional(), offset: z.number().int().min(0).max(32).optional() }),
    output: z.strictObject({ specialists: z.array(z.strictObject({ bindingId: z.string(), name: z.string(), description: z.string(), versionId: taskId, ready: z.boolean(), reasons: z.array(z.string()).max(16), tools: z.array(z.string()).max(64), sourceCount: z.number().int().nonnegative(),skillCount:z.number().int().min(0).max(8).optional(),skills:z.array(z.strictObject({name:z.string(),description:z.string()})).max(8).optional() })).max(8), nextOffset: z.number().int().nullable() }) },
  "agents.start": { input: z.strictObject({ requests: z.array(specialistWorkSchema).min(1).max(2) }), output: z.strictObject({ children }) },
  "agents.status": { input: z.strictObject({ taskIds: z.array(taskId).min(1).max(64).optional(), offset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional() }), output: z.strictObject({ children, nextOffset:z.number().int().nonnegative().nullable().optional() }) },
  "agents.result": { input: z.strictObject({ taskId, offset: resultOffset.optional(), sourceOffset: resultOffset.optional(), effectOffset: resultOffset.optional(), artifactOffset: resultOffset.optional() }),
    output: z.strictObject({ taskId, state: taskState, output: z.string().max(4096), nextOffset: z.number().int().nullable(), totalBytes: z.number().int().nonnegative(), contentDigest: z.string().regex(/^[a-f0-9]{64}$/), errorCode: z.string().nullable(), metadata: specialistResultMetadataSchema.optional() }) },
  "agents.wait": { input: z.strictObject({ taskIds: z.array(taskId).min(1).max(8).optional(), mode: z.enum(["any", "all"]).optional(), timeoutSeconds: z.number().int().min(1).max(60).optional() }), output: z.strictObject({ children, timedOut: z.boolean() }) },
  "agents.followup": { input: z.strictObject({ taskId, brief: specialistWorkSchema.shape.brief, context: specialistWorkSchema.shape.context, deliverable: specialistWorkSchema.shape.deliverable, criteria: specialistWorkSchema.shape.criteria }), output: z.strictObject({ children }) },
  "agents.cancel": { input: z.strictObject({ taskId }), output: z.strictObject({ taskId, state: z.enum(["cancel_requested", "already_terminal"]), taskState }) },
  "work.update": { input: z.strictObject({ expectedRevision: z.number().int().nonnegative(), record: workRecordSchema }), output: progress },
  "work.inspect": { input: z.strictObject({instructionSequence:z.string().regex(/^(0|[1-9][0-9]{0,18})$/).refine(value=>BigInt(value)<=9223372036854775807n).optional(),instructionOffset:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()}), output: progress.extend({instructionPage:z.strictObject({taskId,sequence:z.string(),offset:z.number().int().nonnegative(),text:z.string().max(1024),next:z.strictObject({sequence:z.string(),offset:z.number().int().nonnegative()}).nullable()}).nullable().optional()}) },
} as const;
export const specialistStartV2Contract = { ...orchestrationContracts["agents.start"],
  input: z.strictObject({ requests: z.array(specialistWorkV2Schema).min(1).max(2) }) };
export const specialistFollowupV2Contract = { ...orchestrationContracts["agents.followup"],
  input: orchestrationContracts["agents.followup"].input.extend({ historyReferences: z.array(specialistHistoryReferenceSchema).max(4).optional() }) };
export const specialistStartV3Contract = { ...orchestrationContracts["agents.start"],
  input: z.strictObject({ requests: z.array(specialistWorkV3Schema).min(1).max(2) }) };
export const specialistFollowupV3Contract = { ...specialistFollowupV2Contract,
  input: specialistFollowupV2Contract.input.extend({ artifactIds: z.array(taskId).max(8).optional() }) };
export const specialistStartV4Contract = { ...orchestrationContracts["agents.start"],
  input: z.strictObject({ requests: z.array(specialistWorkV4Schema).min(1).max(2) }) };
export const specialistFollowupV4Contract = { ...specialistFollowupV3Contract,
  input: specialistFollowupV3Contract.input.extend({ artifactReferences: z.array(specialistArtifactReferenceSchema).max(8).optional() }) };
