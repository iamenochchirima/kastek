import { apiUrl } from "@/lib/server-api";
import type {
  GrowthAgentBootstrap, GrowthAgentCommandOutputs, GrowthAgentContext,
  GrowthAgentFeatureId, GrowthAgentTask, GrowthAgentReview, GrowthDraftReview, GrowthDraftProposal,
  GrowthAgentResourceInputs, GrowthAgentResourceOutputs, MemoryAssertion,
} from "@kasitek-labs/contracts";

export type {
  GrowthAgentBootstrap, GrowthAgentConversation, GrowthAgentContext, GrowthAgentFeature,
  GrowthAgentFeatureId, GrowthAgentMessage, GrowthAgentTask, GrowthAgentTaskState,
  GrowthAgentEvent, GrowthAgentReview, GrowthAgentResult, GrowthAgentSource, GrowthAgentArtifact, GrowthDraftProposal,
} from "@kasitek-labs/contracts";

export class GrowthAgentRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "GrowthAgentRequestError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(`/api/agents${path}`), {
    ...init, credentials: "include", cache: "no-store",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    const message = response.status === 401 ? "Sign in to continue."
      : response.status === 403 ? "You don't have access to this work."
      : response.status === 429 && body.code === "QUOTA_EXCEEDED" ? "Daily agent allowance reached."
      : response.status === 503 ? "Agents are unavailable. Try again shortly."
      : body.error || "Unable to complete this request.";
    throw new GrowthAgentRequestError(message, response.status, body.code);
  }
  return response.json() as Promise<T>;
}

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, String(value));
  const suffix = params.toString();
  return suffix ? `?${suffix}` : "";
}
const id = encodeURIComponent;
const json = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: "POST", body: JSON.stringify(body), signal });
type ResourcePreviewInput = { kind: "source"; sourceId: string; revisionId: string } | { kind: "skill"; skillId: string; path?: string };

export const growthAgents = {
  previewCapabilityUpgrade: (featureId: GrowthAgentFeatureId, signal?: AbortSignal) => request<import("@kasitek-labs/contracts").GrowthAgentCapabilityUpgradePreview>(`/features/${id(featureId)}/upgrade/preview`, json({}, signal)),
  applyCapabilityUpgrade: (featureId: GrowthAgentFeatureId, input: import("@kasitek-labs/contracts").GrowthAgentCapabilityUpgradeApply, requestId: string) =>
    request<GrowthAgentCommandOutputs["features.upgrade.apply"]>(`/features/${id(featureId)}/upgrade/apply`, json({...input,requestId})),
  models: (featureId: GrowthAgentFeatureId, signal?: AbortSignal) => request<GrowthAgentCommandOutputs["models.list"]>(`/features/${id(featureId)}/models`, { signal }),
  selectModel: (featureId: GrowthAgentFeatureId, input: Omit<import("@kasitek-labs/contracts").GrowthAgentCommandInputs["models.select"], "featureId">, requestId: string) =>
    request<GrowthAgentCommandOutputs["models.select"]>(`/features/${id(featureId)}/model`, { ...json({ ...input, requestId }), method: "PATCH" }),
  resources: (featureId: GrowthAgentFeatureId, signal?: AbortSignal) => request<GrowthAgentResourceOutputs["resources.list"]>(`/features/${id(featureId)}/resources`, { signal }),
  resourcePreview: (featureId: GrowthAgentFeatureId, input: ResourcePreviewInput, signal?: AbortSignal) =>
    request<GrowthAgentResourceOutputs["resources.preview"]>(`/features/${id(featureId)}/resources/preview${query(input as Record<string, string>)}`, { signal }),
  importSource: (featureId: GrowthAgentFeatureId, input: Omit<GrowthAgentResourceInputs["sources.import"], "featureId">, requestId: string) =>
    request<GrowthAgentResourceOutputs["sources.import"]>(`/features/${id(featureId)}/sources`, json({ ...input, requestId })),
  reviewSource: (featureId: GrowthAgentFeatureId, input: Omit<GrowthAgentResourceInputs["sources.review"], "featureId">, requestId: string) =>
    request<GrowthAgentResourceOutputs["sources.review"]>(`/features/${id(featureId)}/sources/review`, json({ ...input, requestId })),
  sourceState: (featureId: GrowthAgentFeatureId, input: Omit<GrowthAgentResourceInputs["sources.state"], "featureId">, requestId: string) =>
    request<GrowthAgentResourceOutputs["sources.state"]>(`/features/${id(featureId)}/sources/state`, json({ ...input, requestId })),
  importSkill: (featureId: GrowthAgentFeatureId, input: GrowthAgentResourceInputs["skills.import"]["package"], requestId: string) =>
    request<GrowthAgentResourceOutputs["skills.import"]>(`/features/${id(featureId)}/skills`, json({ package: input, requestId })),
  reviewSkill: (featureId: GrowthAgentFeatureId, input: Omit<GrowthAgentResourceInputs["skills.review"], "featureId">, requestId: string) =>
    request<GrowthAgentResourceOutputs["skills.review"]>(`/features/${id(featureId)}/skills/review`, json({ ...input, requestId })),
  skillState: (featureId: GrowthAgentFeatureId, input: Omit<GrowthAgentResourceInputs["skills.state"], "featureId">, requestId: string) =>
    request<GrowthAgentResourceOutputs["skills.state"]>(`/features/${id(featureId)}/skills/state`, json({ ...input, requestId })),
  selectResources: (featureId: GrowthAgentFeatureId, input: Omit<GrowthAgentResourceInputs["resources.select"], "featureId">, requestId: string) =>
    request<GrowthAgentResourceOutputs["resources.select"]>(`/features/${id(featureId)}/resources/select`, json({ ...input, requestId })),
  memories:(featureId:GrowthAgentFeatureId,page:{offset?:number;limit?:number}={})=>request<GrowthAgentCommandOutputs["memory.list"]>(`/features/${id(featureId)}/memory${query(page)}`),
  mutateMemory:(featureId:GrowthAgentFeatureId,memoryId:string,input:{expectedRevision:number;action:"accept"|"correct"|"forget";content?:string;assertion?:MemoryAssertion;requestKey:string})=>
    request<GrowthAgentCommandOutputs["memory.mutate"]>(`/features/${id(featureId)}/memory/${id(memoryId)}`,json({expectedRevision:input.expectedRevision,action:input.action,...(input.content===undefined?{}:{content:input.content}),...(input.assertion===undefined?{}:{assertion:input.assertion}),requestId:input.requestKey})),
  configureMemory:(featureId:GrowthAgentFeatureId,enabled:boolean,expectedRevision:number,requestId:string)=>
    request<GrowthAgentCommandOutputs["memory.configure"]>(`/features/${id(featureId)}/memory/settings`,{...json({enabled,expectedRevision,requestId}),method:"PATCH"}),
  bootstrap: (signal?: AbortSignal) => request<GrowthAgentBootstrap>("/bootstrap", { signal }),
  conversations: (options: { featureId?: GrowthAgentFeatureId; search?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["conversations.list"]>(`/conversations${query(options)}`, { signal }),
  createConversation: (input: { requestId: string; featureId: GrowthAgentFeatureId; title?: string; context?: GrowthAgentContext | null }, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["conversations.create"]>("/conversations", json(input, signal)),
  conversation: (conversationId: string, cursor?: string, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["conversations.get"]>(`/conversations/${id(conversationId)}${query({ cursor })}`, { signal }),
  context: (conversationId: string, context: GrowthAgentContext | null, requestId: string, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["conversations.context"]>(`/conversations/${id(conversationId)}/context`, { ...json({ requestId, context }, signal), method: "PATCH" }),
  send: (conversationId: string, text: string, requestId: string, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["turns.submit"]>(`/conversations/${id(conversationId)}/messages`, json({ requestId, text }, signal)),
  tasks: (options: { conversationId?: string; state?: string; search?: string; cursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["tasks.list"]>(`/tasks${query(options)}`, { signal }),
  task: (taskId: string, signal?: AbortSignal) => request<{ task: GrowthAgentTask }>(`/tasks/${id(taskId)}`, { signal }),
  activity: (taskId: string, options: { childTaskId?: string; cursor?: string; operationCursor?: string; limit?: number } = {}, signal?: AbortSignal) =>
    request<import("@kasitek-labs/contracts").GrowthAgentObservation>(`/tasks/${id(taskId)}/activity${query(options)}`, { signal }),
  specialistResult: (taskId: string, childTaskId: string, offset = 0, signal?: AbortSignal) =>
    request<{ taskId: string; state: string; available: boolean; output: string | null; nextOffset: number | null }>(`/tasks/${id(taskId)}/specialists/${id(childTaskId)}/result${query({ offset })}`, { signal }),
  events: (taskId: string, cursor?: string, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["tasks.events"]>(`/tasks/${id(taskId)}/events${query({ cursor })}`, { signal }),
  cancel: (taskId: string, requestId: string, signal?: AbortSignal) =>
    request<{ task: GrowthAgentTask }>(`/tasks/${id(taskId)}/cancel`, json({ requestId }, signal)),
  instruct: (taskId: string, instruction: string, requestId: string, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["tasks.instructions"]>(`/tasks/${id(taskId)}/instructions`, json({ requestId, instruction }, signal)),
  continue: (taskId: string, requestId: string, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["tasks.continue"]>(`/tasks/${id(taskId)}/continue`, json({ requestId }, signal)),
  reviews: (taskId: string, signal?: AbortSignal) => request<{ reviews: GrowthAgentReview[] }>(`/tasks/${id(taskId)}/reviews`, { signal }),
  decide: (review: GrowthAgentReview, decision: "approve" | "reject", requestId: string, signal?: AbortSignal) =>
    request<GrowthAgentCommandOutputs["reviews.decide"]>(`/tasks/${id(review.taskId)}/reviews/${id(review.id)}/decision`, json({ requestId, payloadDigest: review.payloadDigest, decision }, signal)),
  revise: (review: GrowthDraftReview, draft: GrowthDraftProposal, requestId: string, signal?: AbortSignal) =>
    request<{ review: GrowthDraftReview }>(`/tasks/${id(review.taskId)}/reviews/${id(review.id)}`, { ...json({ requestId, payloadDigest: review.payloadDigest, draft }, signal), method: "PATCH" }),
  artifacts: (taskId: string, signal?: AbortSignal) => request<GrowthAgentCommandOutputs["artifacts.list"]>(`/tasks/${id(taskId)}/artifacts`, { signal }),
  artifact: (taskId: string, artifactId: string, signal?: AbortSignal, childTaskId?: string) => request<GrowthAgentCommandOutputs["artifacts.get"]>(`/tasks/${id(taskId)}/artifacts/${id(artifactId)}${query({ childTaskId })}`, { signal }),
};

export function isActiveTask(task: Pick<GrowthAgentTask, "state">) {
  return ["accepted", "queued", "working", "waiting_review", "waiting_authority", "cancel_requested"].includes(task.state);
}
export const taskStateLabel: Record<GrowthAgentTask["state"], string> = {
  accepted: "Accepted", queued: "Queued", working: "Working", waiting_review: "Needs review",
  waiting_authority: "Access required", completed: "Completed", incomplete: "Incomplete", failed: "Failed",
  cancel_requested: "Stopping", cancelled: "Cancelled", uncertain: "Outcome unknown", refused: "Not permitted",
};
export const contextLabel = (context: GrowthAgentContext) => ({
  workspace: "Business", content_post: "Content post", whatsapp_campaign: "WhatsApp campaign", analytics_report: "Analytics report",
})[context.kind];

export { safeGrowthRoute } from "./growth-agent-sources";

export type GrowthDraftDestination = { id: string; platform: string; label: string; ready: boolean };
export function getDraftDestinations(signal?: AbortSignal) {
  return request<{ destinations: GrowthDraftDestination[] }>("/draft-destinations", { signal });
}
