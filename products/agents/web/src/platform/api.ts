export type DelegationBinding = { id: string; label?: string; description?: string; versionNumber?: number; versionId: string; sourceRevisionIds?: string[]; connectedToolBindingIds?: string[]; productBindingIds?: string[]; tools: NonNullable<Configuration["tools"]>; maxTokens: number | null; maxActiveMs: number | null };
export type DelegationConfiguration = { enabled: false } | { enabled: true; bindings: DelegationBinding[]; maxChildren: number; maxDepth: number | null; policy?: { maxTasks: number | null; maxStalls: number } };
export type Configuration = {
  executionKind: "business" | "workspace";
  program?: { id: "grounded-conversation" | "tool-directed"; version: "1" | "2" | "3" | "4" };
  instructions: string;
  model: { selection: { kind: "organization_default" } | { kind: "connection"; connectionId: string; modelId: string }; maxInputBytes: number; maxOutputTokens: number; maxDurationSeconds: number; maxCostMicros?: number | null; generation?: { temperature?: number; reasoning?: { kind: "effort"; value: string } | { kind: "budget"; tokens: number } | { kind: "level"; value: string } } };
  sourceRevisionIds?: string[];
  connectedToolBindingIds?: string[];
  productBindings?: unknown[];
  commissionableProductBindings?: unknown[];
  retrievalProfile?: { kind: "lexical-v1" } | { kind: "hybrid-v1"; embeddingRelease: string };
  memory?: { enabled: boolean };
  context?: { mode: "automatic" } | { maxInputTokens: number; compactAtTokens: number };
  supportHours?: SupportHours;
  tools?: ("knowledge.search" | "knowledge.read" | "memory.search" | "memory.read" | "memory.propose" | "agents.delegate" | "agents.discover" | "agents.start" | "agents.status" | "agents.result" | "agents.wait" | "agents.followup" | "agents.cancel" | "work.update" | "work.inspect" | "tasks.inspect" | "tasks.cancel" | "sandbox.analyze" | "channel.request_handoff" | "support.request_handoff" | "support.request_handoff_v2" | "support.get_status" | "support.get_status_v2" | "enquiry.submit" | "enquiry.read" | "enquiry.amend" | "records.search" | "records.update")[];
  skillIds?: string[];
  procedures?: Array<{ id: string; version: string }>;
  capabilities: { enquiries?: {enabled:false} | {enabled:true;fields:Array<"name"|"email"|"phone"|"service"|"message">}; delegation: DelegationConfiguration; sandbox: { enabled: false } | { enabled: true; profileId: "python-analysis-v1" }; businessActions: { enabled: false } | { enabled: true; profileId: "calendar-booking-v1"; permittedOperations?: Array<"calendar.availability" | "calendar.book">; policyId: string; policyDigest: string }; workflows: { enabled: false } | { enabled: true; profileId: "report-delivery-v1"; connectionId: string; reportArtifactName?: string; title?: string }; schedules: { enabled: false } };
};
export type CatalogueItem = {
  connectorId?:string; selection?:{kind:"bindings"}|{kind:"capability";capability:"businessActions";profileId:string;setup:"booking"};
  id: string; revision: number | string; digest: string; kind: "builtin" | "mcp" | "native_api" | "skill";
  name: string; description: string; publisher: { id: string; name: string; verified: boolean };
  familyId?: string;
  source?: { kind: "curated" | "private" | "repository"; slug?: string; repository?: string; commit?: string; path?: string };
  purposes: string[]; products: string[]; executionKinds: string[];
  requires: { connectionProfiles: string[]; permissions: string[] };
  readiness: { state: "ready" | "needs_connection" | "needs_configuration" | "unavailable"; reasons: { code: string; message: string }[] };
  added: boolean; recommended: boolean;
  action: { kind: "add" | "connect" | "configure" | "none"; connectionProfileId?: string; connectionId?: string; configurationSection?: "configuration";configurationSetup?:string };
  configuration: { tools: NonNullable<Configuration["tools"]>; connectedToolBindingIds: string[]; skillIds: string[] };
};
export type Catalogue = { schemaVersion: 1; revision: string; agentId: string | null; entries: CatalogueItem[] };
export type SkillPackage = { familyId?: string; state?: "enabled" | "disabled" | "removed"; generation?: number; publisher?: { id: string; name: string; verified: boolean }; source?: { kind: "curated" | "private" | "repository"; slug?: string | null; repository?: string; commit?: string; path?: string; tree?: string }; requires?: { connectionProfiles: string[]; permissions: string[]; runtimes: string[] }; id: string; name: string; description: string; revision: number; contentDigest: string; compatibility: string | null; reviewState: "pending" | "reviewed"; createdAt: string; files: { path: string; size: number; contentDigest: string }[] };
export type CustomerOffering = { id: "faq" | "customer-service" | "booking"; name: string; available: boolean; unavailableCode?: string };
export type SupportHours = { timeZone: string; intervals: Array<{ day: number; start: string; end: string }> };
export type CustomerSetup = {
 business: { name: string; website: string; description: string };
 responsibilities: Array<"answer-questions" | "customer-support" | "bookings" | "enquiries">;
 channels: Array<"website" | "whatsapp" | "facebook" | "instagram" | "telegram">;
 booking?: { durationMinutes: number; notes: string };
 intake?: { fields: Array<"name" | "email" | "phone" | "service" | "message"> };
 supportHours?: SupportHours;
 behaviour: { agentName: string; language: string; tone: "friendly" | "professional" | "concise"; handoffInstructions: string };
};
export type Agent = { setup?: CustomerSetup | null; setupStep?: string | null; offering?: "faq" | "customer-service" | "booking" | null; id: string; name: string; avatar: string; draft: Configuration; draftRevision: number; updatedAt: string };
export type Version = { id: string; number: number; configuration: Configuration; createdAt?: string };
export type Deployment = { id: string; versionId: string; allowedOrigins: string[] };
export type Organization = { id: string; name: string; role: string };
export type Session = { account: { id: string; email: string; displayName: string }; organizations: Organization[] };
export type Memory = { id: string; kind: "semantic" | "episodic"; content: string; status: "candidate" | "accepted" | "forgotten"; revision: number; createdAt: string; updatedAt: string; sourceTaskId: string | null };
export type Skill = { id: string; name: string; description: string; body: string; revision: number; contentDigest: string; createdAt: string };
export type TaskOperation = { label?: string; category?: string; source?: "runtime" | "product" | "connection"; activityKind?: "capability_discovery" | "capability_loading"; technicalName?: string; durationMs?: number | null; startedAt?: string; completedAt?: string | null; id?: string; operationId?: string; kind?: string; name?: string; toolName?: string; transport?: "native_http" | "mcp_http" | null; providerOperation?: string | null; state: string; errorCode?: string | null; inputTokens?: number | null; outputTokens?: number | null };
export type TaskEvent = { createdAt?: string; sequence: string | number; kind: string; payload?: Record<string, unknown> | null };
export type ChildTask = { createdAt?: string; assignment?: string; input?: string; id: string; agentName: string; versionId: string; versionNumber: number; bindingId: string; state: string; output: string | null; outputAvailability?: "available" | "unavailable"; errorCode: string | null; rootTaskId: string; parentTaskId: string };
export type TaskResource = { id: string; taskId: string; profile: string; state: string; cleanupState: "active" | "pending" | "completed" | "uncertain"; errorCode?: string | null; expiresAt: string };
export type TaskArtifact = { id: string; taskId: string; name: string; contentType: string; bytes: number; downloadPath: string };
export type ConnectionTarget = { id: string; label: string; resource: string };
export type ResourceHandle = { kind: string; id: string };
export type RepositorySelection = { owner: string; repository: string; ref: string };
export type ConnectionProfile = { id: "report-delivery-v1" | "github-public-read-v1" | "stash-read-v1" | "public-repository-read-v1"; label: string; allowedTransports: string[] };
export type Connection = { id: string; name: string; targetId: string; targetLabel: string; resource: string; profileId?: ConnectionProfile["id"]; authentication?: "none" | "bearer"; policyRevision?: number; resources?: ResourceHandle[]; selections?: RepositorySelection[]; stashItemIds?: string[]; revision: number; state: "active" | "revoked"; expiresAt: string; createdAt: string };
export type ConnectionList = { connections: Connection[]; targets: ConnectionTarget[]; profiles?: ConnectionProfile[] };
export type RemoteConnection = { id: string; name: string; endpoint: string; authentication: "auto" | "none" | "bearer" | "header" | "oauth"; status: string; revision: number; generation: number; lastError: string | null; identity: unknown; createdAt: string; expiresAt: string };
export type RemoteInventoryTarget = { kind: "resource"; uri: string } | { kind: "template"; uriTemplate: string } | { kind: "prompt"; name: string };
export type RemoteToolCatalogue = { protocolVersion: string; tools: { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; schemaDigest: string; compatible?: boolean; diagnostics?: { code: string; message: string }[] }[]; contentOperations?: { name: string; description: string; compatible: boolean; target?: RemoteTarget; inventoryTarget?: RemoteInventoryTarget; diagnostics: { code: string; message: string }[] }[]; diagnostics?: { code: string; message: string }[] };
export type ApiSecurity = { schemeId: string; type: "none" | "bearer" | "basic" | "api_key" | "oauth2"; in?: "header" | "query"; name?: string; scopes: string[] };
export type ApiResponsePolicy = {projection?:{fields:Record<string,string>};pagination?:{itemsPointer:string;nextCursorPointer:string;cursorParameter:string;maxPages:number};retry?:{maxAttempts:number;maxDelayMs:number}};
export type ApiOperation = {responsePolicy?:ApiResponsePolicy; id: string; alias?: string; operationId: string | null; method: string; path: string; summary: string; compatible: boolean; diagnostics: { code: string; message: string }[]; security: ApiSecurity | null; securityChoices?: { index: number; security: ApiSecurity | null; diagnostics: { code: string; message: string }[] }[]; credentialState: "none" | "required" | "configured" | "unsupported"; effect: "unknown"; reviewRequired: true; selected?: boolean; effectPolicy?: "exact_review" | "owner_reviewed_read" | null; parameters?: { name: string; in: string; required: boolean; schema: unknown }[]; requestBody?: { required: boolean; contentType: string; schema: unknown } | null; responseSchemas?: { status: string; contentType: string; schema: unknown }[] };
export type ApiPreview = { importDigest: string; title: string; server: { url: string; origin: string }; operations: ApiOperation[]; diagnostics: { code: string; message: string }[] };
export type ApiConnection = { id: string; name: string; serverUrl: string; origin: string; title: string; importDigest: string; status: "selection_required" | "ready" | "credentials_required" | "unsupported" | "failed" | "disconnected"; revision: number; policyRevision: number; generation: number; selectedOperationIds: string[]; bindingIds?: string[]; credentialSchemes: { schemeId: string; type: ApiSecurity["type"]; configured: boolean }[]; lastError: string | null; createdAt: string; expiresAt: string };
export type ApiCredential = { type: "bearer"; token: string } | { type: "api_key"; value: string } | { type: "basic"; username: string; password: string };
export type RemoteTarget = { kind: "tool"; name: string } | { kind: "resource"; uri: string } | { kind: "template"; uriTemplate: string; variableNames: string[] } | { kind: "prompt"; name: string; arguments: { name: string; required: boolean; description?: string }[] };
export type RemoteOperation = { compatible?: boolean; providerOperation: string; description: string; inputSchema?: Record<string, unknown>; remote?: { target?: RemoteTarget }; diagnostics?: { code: string; message: string }[] };
export type CapabilityBinding = { id: string; alias: string; digest: string; transport: "builtin" | "native_http" | "mcp_http"; definition: { providerOperation: string; description: string; remote?: { target?: RemoteTarget } }; connection: { id: string; profileId: string; policyRevision: number } | null; resources: ResourceHandle[] };
export type CatalogCandidate = { id: string; connectionId: string; credentialRevision: number; policyRevision: number; createdAt: string; selectableOperations: string[]; catalog: { revision: number; protocolVersion?: string; transport: "native_http" | "mcp_http"; tools: RemoteOperation[] } };
export type KnowledgeRevision = { id: string; revision: number; state: "candidate" | "approved" | "withdrawn"; acquiredAt: string; embeddingRelease?: string | null };
export type KnowledgeSource = { id: string; organizationId: string; importerAccountId: string; title: string; kind: "upload" | "public_url" | "provider_snapshot"; generation: number; state: "active" | "withdrawn"; visibility: "private" | "public"; createdAt: string; canApprove: boolean; revisions: KnowledgeRevision[] };
export type KnowledgeImport = { id: string; sourceId: string; revisionId: string; revision: number; acceptedGeneration: number; state: "queued" | "acquiring" | "extracting" | "indexing" | "ready" | "failed" | "cancelled"; parserRelease: string; deadline: string; contentType: string; errorCode: string | null; createdAt: string };
export type KnowledgeSources = { sources: KnowledgeSource[]; imports: KnowledgeImport[] };
export type KnowledgePreview = { text: string; chunks: { id: string; page: number | null; start: number; end: number; text: string }[]; acquiredAt: string; revisionId: string; revision: number };
export type AutomationSchedule = { kind: "once"; at: string } | { kind: "interval"; anchor: string; everySeconds: number } | { kind: "event" };
export type Automation = { id: string; name: string; versionId: string; ownerAccountId: string; reviewerAccountId: string; input: string; expiresAt: string; maxOccurrencesPerDay: number; schedule: AutomationSchedule; revision: number; state: "active" | "paused" | "revoked" };
export type AutomationOccurrence = { id: string; automationId: string; revision: number; status: "accepted" | "skipped_overlap" | "blocked" | "skipped_coalesced"; taskId: string | null; scheduledAt: string; errorCode: string | null; createdAt: string };
export type CitedPassage = { id: string; label: string; text: string; title: string; page: number | null; section: string | null; contentDigest: string; acquiredAt: string };
export type TaskEvidence = { state: "available" | "unavailable"; code?: string; passages: CitedPassage[] };
export type DeliveryAction = { id: string; reviewId: string; reviewerAccountId?: string; accountId?: string; taskId: string; rootTaskId: string; connectionId: string; connectionRevision: number; destination: { label: string; resource: string }; artifactId: string; title: string; payloadDigest: string; reviewDigest: string; state: "pending_review" | "approved" | "rejected" | "expired" | "invalidated" | "claimed" | "delivered" | "failed" | "uncertain"; expiresAt: string; citedPassages?: CitedPassage[]; preview: { name: string; contentType: string; content: string }; receipt?: { id: string; payloadDigest: string; acceptedAt: string }; errorCode?: string };
export type ToolReview = { id: string; taskId: string; rootTaskId: string; operationId: string; operationName?: string; connectionName?: string; destination?: string | null; effect?: string; bindingId: string; bindingDigest: string; requestDigest: string; arguments: unknown; connectionId: string; reviewerAccountId: string; state: "pending" | "approved" | "rejected" | "claimed" | "completed" | "uncertain" | "expired" | "invalidated"; expiresAt: string };
export type OrchestrationProgress = { revision: number; record: null | { objective: string; steps: { id: string; title: string; state: "pending" | "in_progress" | "completed" | "blocked" }[]; questions: string[]; evidenceTaskIds: string[] } };
export type TaskDetail = { operationsNextCursor?: string | null; updates?: { id: string; text: string; createdAt: string }[]; updatesTruncated?: boolean; orchestration?: OrchestrationProgress; canSteer?: boolean; task: Task; canControl?: boolean; canDownloadArtifacts?: boolean; events?: TaskEvent[]; eventsNextCursor?: string | null; operations?: TaskOperation[]; children?: ChildTask[]; resources?: TaskResource[]; artifacts?: TaskArtifact[]; actions?: DeliveryAction[] };
export type Task = { runtime?: import("@kasitek-labs/ui").AgentRuntimeMeasurements; workElapsedMs?: number | null; canContinue?: boolean; observedAt?: string; elapsedMs?: number | null; finishedAt?: string | null; createdAt?: string; updatedAt?: string; operationsNextCursor?: string | null; updatesTruncated?: boolean; publicUpdates?: { id: string; text: string; createdAt?: string }[]; orchestration?: OrchestrationProgress; canSteer?: boolean; id: string; hasToolReviews?: boolean; hasBookings?: boolean; hasEnquiries?: boolean; state: string; output: string | null; outputAvailability?: "available" | "unavailable"; errorCode: string | null; conversationId: string; input?: string; requestKey?: string; versionId?: string; turnSequence?: number; eventsNextCursor?: string | null; phase?: string; outcome?: string | null; operations?: TaskOperation[]; events?: TaskEvent[]; children?: ChildTask[]; resources?: TaskResource[]; artifacts?: TaskArtifact[]; actions?: DeliveryAction[] };
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export async function api<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST", token?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    method, credentials: "same-origin", signal,
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
export async function loadTaskDetail(path: string, token?: string, signal?: AbortSignal): Promise<TaskDetail> {
  const detail = await api<TaskDetail>(path, undefined, "GET", token, signal);
  if (detail.actions === undefined && (detail.task.state === "waiting_review" || detail.operations?.some(operation => operation.name === "report.prepare"))) {
    detail.actions = (await api<{ actions: DeliveryAction[] }>(`${path}/actions`, undefined, "GET", token, signal)).actions;
  }
  return detail;
}
export const organizationPath = (id: string) => `/api/organizations/${encodeURIComponent(id)}`;
export const terminal = (state: string) => ["completed", "failed", "cancelled", "uncertain", "incomplete", "refused"].includes(state);
export const message = (error: unknown) => error instanceof Error ? error.message : "Request failed. Try again.";
export function readStored<T>(key: string): T | null { try { return JSON.parse(sessionStorage.getItem(key) ?? "null") as T | null; } catch { return null; } }
export function writeStored(key: string, value: unknown) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Recovery remains available through the task ID shown in the interface. */ } }

export type Page<K extends string, T> = { [P in K]: T[] } & { nextCursor: string | null };
export type AgentSummary = { id: string; name: string; avatar: string; offering: "faq" | "customer-service" | null; responsibilities: CustomerSetup["responsibilities"]; activeChannels: CustomerSetup["channels"]; lastCustomerConversationAt: string | null; draftRevision: number; updatedAt: string; latestVersion: { id: string; number: number; draftRevision: number; executionKind: string } | null; hasUnpublishedChanges: boolean };
export type ConversationSummary = { id: string; agentId: string; agentName: string; versionId: string; versionNumber: number; title: string; updatedAt: string; state: string; canContinue: boolean };
export type TaskSummary = { id: string; agentId: string; agentName: string; versionId: string; versionNumber: number; conversationId: string | null; state: string; createdAt: string; updatedAt: string; canControl: boolean; reviewOnly: boolean };

export type BookingConfirmation = { id: string; taskId: string; state: "pending" | "approved" | "rejected" | "claimed" | "confirmed" | "conflict" | "uncertain" | "expired"; start: string; end: string; timeZone: string; title: string; requestDigest: string; expiresAt: string };

export type ProviderOperation = { id: string; name: string; description: string; effect: "read" | "reviewed_write" };
export type ConnectorRecord = { operations?: ProviderOperation[]; id: string; name: string; description: string; profileId: string; setup?: { kind: "calendar_service" | "crm_service"; apiPath: string; identityLabel: string } | { kind: "existing_connections" }; readiness: { available: boolean; reasons: { code: string; message: string }[] } };

export type NativeServiceConnector = ConnectorRecord & { setup: Extract<NonNullable<ConnectorRecord["setup"]>, { kind: "calendar_service" | "crm_service" }> };
