import { z } from "zod";

export const orchestrationTools = ["agents.discover", "agents.start", "agents.status", "agents.result", "agents.wait", "agents.followup", "agents.cancel", "work.update", "work.inspect"] as const;
export const orchestrationPolicySchema = z.strictObject({
  maxTasks: z.number().int().min(1).max(64),
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
export const childStatusSchema = z.strictObject({ taskId, bindingId: z.string(), versionId: taskId, conversationId: taskId,
  state: taskState, errorCode: z.string().nullable(), priorTaskId: taskId.nullable(), resultAvailable: z.boolean(), needsInput: z.boolean() });
const children = z.array(childStatusSchema).max(64);
const progress = z.strictObject({ revision: z.number().int().nonnegative(), record: workRecordSchema.nullable() });
export const orchestrationContracts = {
  "agents.discover": { input: z.strictObject({ query: z.string().max(200).optional(), bindingId: z.string().max(64).optional(), offset: z.number().int().min(0).max(32).optional() }),
    output: z.strictObject({ specialists: z.array(z.strictObject({ bindingId: z.string(), name: z.string(), description: z.string(), versionId: taskId, ready: z.boolean(), reasons: z.array(z.string()).max(16), tools: z.array(z.string()).max(64), sourceCount: z.number().int().nonnegative(),skillCount:z.number().int().min(0).max(8).optional(),skills:z.array(z.strictObject({name:z.string(),description:z.string()})).max(8).optional() })).max(8), nextOffset: z.number().int().nullable() }) },
  "agents.start": { input: z.strictObject({ requests: z.array(specialistWorkSchema).min(1).max(2) }), output: z.strictObject({ children }) },
  "agents.status": { input: z.strictObject({ taskIds: z.array(taskId).min(1).max(64).optional() }), output: z.strictObject({ children }) },
  "agents.result": { input: z.strictObject({ taskId, offset: z.number().int().min(0).max(1048576).optional() }),
    output: z.strictObject({ taskId, state: taskState, output: z.string().max(4096), nextOffset: z.number().int().nullable(), totalBytes: z.number().int().nonnegative(), contentDigest: z.string().regex(/^[a-f0-9]{64}$/), errorCode: z.string().nullable() }) },
  "agents.wait": { input: z.strictObject({ taskIds: z.array(taskId).min(1).max(8).optional(), mode: z.enum(["any", "all"]).optional(), timeoutSeconds: z.number().int().min(1).max(60).optional() }), output: z.strictObject({ children, timedOut: z.boolean() }) },
  "agents.followup": { input: z.strictObject({ taskId, brief: specialistWorkSchema.shape.brief, context: specialistWorkSchema.shape.context, deliverable: specialistWorkSchema.shape.deliverable, criteria: specialistWorkSchema.shape.criteria }), output: z.strictObject({ children }) },
  "agents.cancel": { input: z.strictObject({ taskId }), output: z.strictObject({ taskId, state: z.enum(["cancel_requested", "already_terminal"]), taskState }) },
  "work.update": { input: z.strictObject({ expectedRevision: z.number().int().nonnegative(), record: workRecordSchema }), output: progress },
  "work.inspect": { input: z.strictObject({}), output: progress },
} as const;
