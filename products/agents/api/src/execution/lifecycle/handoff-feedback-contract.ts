import { handoffFeedbackRequestSchema, type HandoffFeedbackRequest } from "../../contracts/channel";
export { handoffFeedbackRequestSchema, type HandoffFeedbackRequest } from "../../contracts/channel";
import { assertDependencyManifest } from "../../contracts/source-contracts";
import type { ModelRequest } from "../business/model";
import { validateMessageGroups } from "../business/model";

export function parseHandoffFeedbackRequest(value: unknown): HandoffFeedbackRequest {
  const request = handoffFeedbackRequestSchema.parse(value);
  assertDependencyManifest(request.evidenceManifest);
  validateMessageGroups(request.modelRequest.messages);
  return request;
}
export function modelRequestForHandoff(request: HandoffFeedbackRequest): ModelRequest { return request.modelRequest; }
