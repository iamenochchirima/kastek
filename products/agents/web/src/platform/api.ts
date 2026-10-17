export type Configuration = {
  executionKind: "business" | "workspace";
  instructions: string;
  model: { provider: "openrouter"; model: "nvidia/nemotron-3-super-120b-a12b:free"; maxInputBytes: number; maxOutputTokens: number; maxDurationSeconds: number };
  knowledgeIds: string[];
  memory?: { enabled: boolean };
  context?: { maxInputTokens: number; compactAtTokens: number };
  tools?: ("knowledge.search" | "knowledge.read" | "memory.search" | "memory.propose")[];
  skillIds?: string[];
  capabilities: { delegation: { enabled: false }; sandbox: { enabled: false }; businessActions: { enabled: false }; workflows: { enabled: false }; schedules: { enabled: false } };
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
export type Task = { id: string; state: string; output: string | null; errorCode: string | null; conversationId: string; input?: string; requestKey?: string; versionId?: string; turnSequence?: number; phase?: string; outcome?: string | null; operations?: TaskOperation[]; events?: TaskEvent[] };
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
export const organizationPath = (id: string) => `/api/organizations/${encodeURIComponent(id)}`;
export const terminal = (state: string) => ["completed", "failed", "cancelled", "uncertain", "incomplete", "refused"].includes(state);
export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed. Try again.";
export function readStored<T>(key: string): T | null { try { return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null; } catch { return null; } }
export function writeStored(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Recovery remains available through the task ID shown in the interface. */ } }
