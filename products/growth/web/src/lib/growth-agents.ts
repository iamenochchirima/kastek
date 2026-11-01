import { apiUrl } from "@/lib/server-api";
import type {
  GrowthAgentBootstrap, GrowthAgentCommandOutputs, GrowthAgentContext,
  GrowthAgentFeatureId, GrowthAgentTask, GrowthAgentReview, GrowthDraftProposal,
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

export const growthAgents = {
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
  revise: (review: GrowthAgentReview, draft: GrowthDraftProposal, requestId: string, signal?: AbortSignal) =>
    request<{ review: GrowthAgentReview }>(`/tasks/${id(review.taskId)}/reviews/${id(review.id)}`, { ...json({ requestId, payloadDigest: review.payloadDigest, draft }, signal), method: "PATCH" }),
  artifacts: (taskId: string, signal?: AbortSignal) => request<GrowthAgentCommandOutputs["artifacts.list"]>(`/tasks/${id(taskId)}/artifacts`, { signal }),
  artifact: (taskId: string, artifactId: string, signal?: AbortSignal) => request<GrowthAgentCommandOutputs["artifacts.get"]>(`/tasks/${id(taskId)}/artifacts/${id(artifactId)}`, { signal }),
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
