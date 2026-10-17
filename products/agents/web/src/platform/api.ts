export type DelegationBinding = { id: string; label?: string; description?: string; versionNumber?: number; versionId: string; knowledgeIds: string[]; tools: ("knowledge.search" | "knowledge.read")[]; maxTokens: number; maxActiveMs: number };
export type DelegationConfiguration = { enabled: false } | { enabled: true; bindings: DelegationBinding[]; maxChildren: 2; maxDepth: 1 };
export type Configuration = {
  executionKind: "business" | "workspace";
  instructions: string;
  model: { provider: "openrouter"; model: "nvidia/nemotron-3-super-120b-a12b:free"; maxInputBytes: number; maxOutputTokens: number; maxDurationSeconds: number };
  knowledgeIds: string[];
  memory?: { enabled: boolean };
  context?: { maxInputTokens: number; compactAtTokens: number };
  tools?: ("knowledge.search" | "knowledge.read" | "memory.search" | "memory.propose" | "agents.delegate" | "sandbox.analyze")[];
  skillIds?: string[];
  capabilities: { delegation: DelegationConfiguration; sandbox: { enabled: false } | { enabled: true; profileId: "python-analysis-v1" }; businessActions: { enabled: false }; workflows: { enabled: false } | { enabled: true; profileId: "report-delivery-v1"; connectionId: string; reportArtifactName?: string; title?: string }; schedules: { enabled: false } };
};
export type Agent = { id: string; name: string; draft: Configuration; draftRevision: number; updatedAt: string };
export type Version = { id: string; number: number; configuration: Configuration };
export type Deployment = { id: string; versionId: string; allowedOrigins: string[] };
export type Knowledge = { id: string; title: string; content: string; visibility: "public" | "private" };
export type Organization = { id: string; name: string; role: string };
export type Session = { account: { id: string; email: string; displayName: string }; organizations: Organization[] };
export type Memory = { id: string; kind: "semantic" | "episodic"; content: string; status: "candidate" | "accepted" | "forgotten"; revision: number; createdAt: string; updatedAt: string; sourceTaskId: string | null };
export type Skill = { id: string; name: string; description: string; body: string; revision: number; contentDigest: string; createdAt: string };
export type TaskOperation = { id?: string; operationId?: string; kind?: string; name?: string; toolName?: string; state: string; errorCode?: string | null; inputTokens?: number | null; outputTokens?: number | null };
export type TaskEvent = { sequence: string | number; kind: string; payload?: Record<string, unknown> | null };
export type ChildTask = { id: string; agentName: string; versionId: string; versionNumber: number; bindingId: string; state: string; output: string | null; errorCode: string | null; rootTaskId: string; parentTaskId: string };
export type TaskResource = { id: string; taskId: string; profile: string; state: string; cleanupState: "active" | "pending" | "completed" | "uncertain"; errorCode?: string | null; expiresAt: string };
export type TaskArtifact = { id: string; taskId: string; name: string; contentType: string; bytes: number; downloadPath: string };
export type ConnectionTarget = { id: string; label: string; resource: string };
export type Connection = { id: string; name: string; targetId: string; targetLabel: string; resource: string; revision: number; state: "active" | "revoked"; expiresAt: string; createdAt: string };
export type AutomationSchedule = { kind: "once"; at: string } | { kind: "interval"; anchor: string; everySeconds: number } | { kind: "event" };
export type Automation = { id: string; name: string; versionId: string; ownerAccountId: string; reviewerAccountId: string; input: string; expiresAt: string; maxOccurrencesPerDay: number; schedule: AutomationSchedule; revision: number; state: "active" | "paused" | "revoked" };
export type AutomationOccurrence = { id: string; automationId: string; revision: number; status: "accepted" | "skipped_overlap" | "blocked" | "skipped_coalesced"; taskId: string | null; scheduledAt: string; errorCode: string | null; createdAt: string };
export type DeliveryAction = { id: string; reviewId: string; reviewerAccountId?: string; accountId?: string; taskId: string; rootTaskId: string; connectionId: string; connectionRevision: number; destination: { label: string; resource: string }; artifactId: string; title: string; payloadDigest: string; reviewDigest: string; state: "pending_review" | "approved" | "rejected" | "expired" | "invalidated" | "claimed" | "delivered" | "failed" | "uncertain"; expiresAt: string; preview: { name: string; contentType: string; content: string }; receipt?: { id: string; payloadDigest: string; acceptedAt: string }; errorCode?: string };
export type TaskDetail = { task: Task; canControl?: boolean; canDownloadArtifacts?: boolean; events?: TaskEvent[]; operations?: TaskOperation[]; children?: ChildTask[]; resources?: TaskResource[]; artifacts?: TaskArtifact[]; actions?: DeliveryAction[] };
export type Task = { id: string; state: string; output: string | null; errorCode: string | null; conversationId: string; input?: string; requestKey?: string; versionId?: string; turnSequence?: number; phase?: string; outcome?: string | null; operations?: TaskOperation[]; events?: TaskEvent[]; children?: ChildTask[]; resources?: TaskResource[]; artifacts?: TaskArtifact[]; actions?: DeliveryAction[] };
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token?: string): Promise<T> {
  const response = await fetch(path, {
    method, credentials: "same-origin",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error && typeof data.error === "object" ? data.error : data;
    throw new ApiError(response.status, typeof detail.message === "string" ? detail.message : typeof data.error === "string" ? data.error : "Request failed. Try again.", detail.code);
  }
  return data as T;
}
export async function loadTaskDetail(path: string, token?: string): Promise<TaskDetail> {
  const detail = await api<TaskDetail>(path, undefined, "GET", token);
  if (detail.actions === undefined && (detail.task.state === "waiting_review" || detail.operations?.some(operation => operation.name === "report.prepare"))) {
    detail.actions = (await api<{ actions: DeliveryAction[] }>(`${path}/actions`, undefined, "GET", token)).actions;
  }
  return detail;
}
export const organizationPath = (id: string) => `/api/organizations/${encodeURIComponent(id)}`;
export const terminal = (state: string) => ["completed", "failed", "cancelled", "uncertain", "incomplete", "refused"].includes(state);
export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed. Try again.";
export function readStored<T>(key: string): T | null { try { return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null; } catch { return null; } }
export function writeStored(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Recovery remains available through the task ID shown in the interface. */ } }
