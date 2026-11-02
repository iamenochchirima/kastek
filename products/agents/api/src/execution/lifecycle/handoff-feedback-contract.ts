import { z } from "zod";
import { dependencyManifestSchema, assertDependencyManifest } from "../../contracts/source-contracts";
import type { ModelRequest } from "../business/model";
import { validateMessageGroups } from "../business/model";

const message = z.strictObject({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().nullable(),
  tool_calls: z.array(z.strictObject({ id: z.string().min(1), type: z.literal("function"),
    function: z.strictObject({ name: z.string().min(1), arguments: z.string() }) })).optional(),
  tool_call_id: z.string().min(1).optional(),
});

// Controller-owned snapshot. There are deliberately no model-callable tools.
export const handoffFeedbackRequestSchema = z.strictObject({
  modelRequest: z.strictObject({ model: z.string().min(1), messages: z.array(message).min(1),
    maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
    maxDurationSeconds: z.number().positive() }),
  evidenceManifest: dependencyManifestSchema,
});
export type HandoffFeedbackRequest = z.infer<typeof handoffFeedbackRequestSchema>;
export function parseHandoffFeedbackRequest(value: unknown): HandoffFeedbackRequest {
  const request = handoffFeedbackRequestSchema.parse(value);
  assertDependencyManifest(request.evidenceManifest);
  validateMessageGroups(request.modelRequest.messages);
  return request;
}
export function modelRequestForHandoff(request: HandoffFeedbackRequest): ModelRequest { return request.modelRequest; }
