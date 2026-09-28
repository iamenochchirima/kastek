import { apiUrl } from "@/lib/server-api";

export type AgentInstallation = {
  id: string;
  status: "active" | "paused" | "disabled";
  execution_mode?: "system_hosted" | "kasitek_hosted" | "external_connected";
  release_mode?: "pinned";
  agent_audience?: "personal" | "customer_service" | null;
  agent_name?: string;
  agent_slug?: string;
  agent_protected?: boolean;
  settings?: Record<string, unknown>;
};

export type AgentUiAction = {
  id: string;
  label: string;
  kind: "navigate" | "follow_up" | "refresh" | "submit" | "resume";
  href?: string;
  prompt?: string;
  targetId?: string;
  eventKey?: string;
  expiresAt?: string;
};

export type AgentUiBlock =
  | {
      type: "summary";
      id: string;
      title?: string;
      items: Array<{ label: string; value: string; status?: "success" | "warning" | "danger" | "neutral" }>;
    }
  | {
      type: "list";
      id: string;
      title?: string;
      items: Array<{ id?: string; title: string; description?: string; meta?: string; status?: "success" | "warning" | "danger" | "neutral" }>;
      emptyText?: string;
      actions?: AgentUiAction[];
    }
  | {
      type: "progress";
      id: string;
      title?: string;
      steps: Array<{ label: string; status: "pending" | "active" | "complete" | "error"; detail?: string }>;
    }
  | {
      type: "workspace";
      id: string;
      workspace: "connections" | "content" | "report" | "agent_creation";
      title: string;
      description: string;
      href: string;
      actions?: AgentUiAction[];
    }
  | {
      type: "form";
      id: string;
      title?: string;
      description?: string;
      fields: Array<
        | { id: string; label: string; type: "text" | "textarea"; description?: string; placeholder?: string; required?: boolean; maxLength?: number }
        | { id: string; label: string; type: "select"; description?: string; required?: boolean; options: Array<{ id: string; label: string; value?: string }> }
        | { id: string; label: string; type: "checkbox"; description?: string; required?: boolean }
      >;
      actions: AgentUiAction[];
    }
  | {
      type: "choice";
      id: string;
      title?: string;
      description?: string;
      options: Array<{ id: string; label: string; description?: string; value?: string }>;
    };

export type AgentDynamicUi = {
  version: "1";
  mode: "inline" | "expanded";
  blocks: AgentUiBlock[];
};

export type AgentWebsiteDeployment = {
  id: string;
  publicId: string;
  embedCode?: string;
  shareUrl?: string;
  orgId: string;
  installationId: string;
  channelConnectionId: string;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "REVOKED";
  allowedOrigins: string[];
  displayName?: string | null;
  welcomeText?: string | null;
  launcherPosition: "bottom-right" | "bottom-left";
  colorPreset: string;
  appearance: {
    primaryColor: string;
    launcherSize: number;
    windowWidth: number;
    windowHeight: number;
    borderRadius: number;
    launcherOffset: number;
    showBranding: boolean;
  };
  avatarUrl?: string | null;
  privacyPolicyUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AgentMessage = {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound" | "system";
  message_type: string;
  content: {
    text?: string;
    authorizationRequired?: AgentAuthorizationRequirement;
    ui?: AgentDynamicUi;
    [key: string]: unknown;
  };
  sequence_number: string | number;
  created_at: string;
  run_id?: string | null;
  provider?: string | null;
  provider_message_id?: string | null;
  participant_type?: "user" | "customer" | "staff" | "agent" | "system" | null;
  participant_display_name?: string | null;
  source_channel?: string;
  source_connection_id?: string | null;
  source_binding_id?: string | null;
  external_conversation_id?: string | null;
  occurred_at?: string;
  delivery_status?: "local" | "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "unknown" | null;
};

export type AgentAuthorizationRequirement = {
  code: string;
  provider: string;
  connectionId?: string;
  requiredCapabilities: string[];
  requestable: boolean;
  authMode?: string | null;
  reasonCode: string;
  remediation: string;
};

export type AgentConversation = {
  id: string;
  installation_id: string;
  organization_id: string;
  channel_type: string;
  channel_key: string;
  external_conversation_id?: string | null;
  status: string;
  title?: string | null;
  owner_actor_id?: string | null;
  is_primary?: boolean;
  archived_at?: string | null;
  title_source?: "fallback" | "ai" | "manual";
  title_generated_at?: string | null;
  title_locked?: boolean;
  pinned?: boolean;
  last_opened_at?: string | null;
  last_read_at?: string | null;
  model_provider?: AgentModelProvider | null;
  model?: string | null;
  conversation_kind?: "personal" | "customer" | "test" | "external";
  assigned_actor_id?: string | null;
  last_message_at?: string | null;
  last_message_direction?: "inbound" | "outbound" | "system" | null;
  last_message_preview?: string | null;
  message_count?: number;
  participant_type?: "user" | "customer" | "staff" | "agent" | "system" | null;
  participant_external_id?: string | null;
  participant_display_name?: string | null;
  unread_count?: number;
  updated_at: string;
};

export type AgentHandoffStatus = "pending" | "claimed" | "resolved" | "expired" | "cancelled";
export type AgentHandoffPriority = "normal" | "high" | "urgent";
export type AgentHandoffReason = "customer_requested" | "agent_uncertain" | "policy_required" | "high_value" | "configured_workflow" | "other";

export type AgentHandoffRequest = {
  id: string;
  organization_id: string;
  installation_id: string;
  conversation_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  run_id?: string | null;
  channel_type: string;
  reason: AgentHandoffReason;
  priority: AgentHandoffPriority;
  summary: string;
  customer_message?: string | null;
  request_source?: "customer_direct" | "customer_confirmed" | "operator" | "legacy_unverified";
  source_message_id?: string | null;
  offer_id?: string | null;
  consented_at?: string | null;
  classifier_version?: string | null;
  status: AgentHandoffStatus;
  requested_by: string;
  claimed_by?: string | null;
  claimed_at?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  resolution?: string | null;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
  expires_at?: string;
  created_at: string;
  updated_at: string;
};

export type AgentHandoffQueueItem = {
  handoff: AgentHandoffRequest;
  conversation: AgentConversation;
  history?: AgentHandoffHistoryEvent[];
};

export type AgentHandoffHistoryEvent = {
  id: string;
  event_type: string;
  sequence_number: string | number;
  payload: Record<string, unknown>;
  actor_type: string;
  actor_id?: string | null;
  created_at: string;
};

export type AgentHandoffQueue = {
  items: AgentHandoffQueueItem[];
  nextCursor?: string | null;
  nextBefore: string | null;
};

export type AgentHandoffMutation = AgentHandoffQueueItem & { changed: boolean };

export type AgentHumanMessageResult = AgentHandoffQueueItem & {
  message: AgentMessage;
  deliveryAttemptId: string | null;
  deliveryAttemptStatus?: string | null;
  created: boolean;
  delivery?: { status: string; error?: { code?: string; message?: string } };
};

export type AgentLiveConversation = {
  conversation: AgentConversation;
};

export type AgentConversationSummary = {
  all: number;
  live: number;
  inbox: number;
  mine: number;
  team: number;
};

export function listAgentHandoffs(filters: {
  installationId?: string;
  agentId?: string;
  status?: AgentHandoffStatus[];
  priority?: AgentHandoffPriority;
  channelType?: string;
  reason?: AgentHandoffReason;
  search?: string;
  limit?: number;
  cursor?: string;
  before?: string;
  assignment?: "mine" | "team";
} = {}): Promise<AgentHandoffQueue> {
  const query = new URLSearchParams();
  if (filters.installationId) query.set("installationId", filters.installationId);
  if (filters.agentId) query.set("agentId", filters.agentId);
  if (filters.status?.length) query.set("status", filters.status.join(","));
  if (filters.priority) query.set("priority", filters.priority);
  if (filters.channelType) query.set("channelType", filters.channelType);
  if (filters.reason) query.set("reason", filters.reason);
  if (filters.search) query.set("search", filters.search);
  if (filters.limit) query.set("limit", String(filters.limit));
  if (filters.cursor) query.set("cursor", filters.cursor);
  if (filters.before) query.set("before", filters.before);
  if (filters.assignment) query.set("assignment", filters.assignment);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request<AgentHandoffQueue>(`/api/agents/conversations/handoffs${suffix}`);
}

export function listAgentCustomerConversations(filters: { installationId?: string; agentId?: string; channelType?: string; search?: string; limit?: number } = {}): Promise<{ items: AgentConversation[] }> {
  const query = new URLSearchParams();
  if (filters.installationId) query.set("installationId", filters.installationId);
  if (filters.agentId) query.set("agentId", filters.agentId);
  if (filters.channelType) query.set("channelType", filters.channelType);
  if (filters.search) query.set("search", filters.search);
  if (filters.limit) query.set("limit", String(filters.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request(`/api/agents/conversations/customer${suffix}`);
}

export function listAgentLiveConversations(filters: { installationId?: string; agentId?: string; channelType?: string; search?: string; limit?: number } = {}): Promise<{ items: AgentLiveConversation[] }> {
  const query = new URLSearchParams();
  if (filters.installationId) query.set("installationId", filters.installationId);
  if (filters.agentId) query.set("agentId", filters.agentId);
  if (filters.channelType) query.set("channelType", filters.channelType);
  if (filters.search) query.set("search", filters.search);
  if (filters.limit) query.set("limit", String(filters.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request(`/api/agents/conversations/live${suffix}`);
}

export function getAgentConversationSummary(filters: { installationId?: string; agentId?: string; channelType?: string; search?: string } = {}): Promise<AgentConversationSummary> {
  const query = new URLSearchParams();
  if (filters.installationId) query.set("installationId", filters.installationId);
  if (filters.agentId) query.set("agentId", filters.agentId);
  if (filters.channelType) query.set("channelType", filters.channelType);
  if (filters.search) query.set("search", filters.search);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request(`/api/agents/conversations/summary${suffix}`);
}

export function getAgentHandoff(handoffId: string): Promise<AgentHandoffQueueItem> {
  return request(`/api/agents/conversations/handoffs/${encodeURIComponent(handoffId)}`);
}

export function claimAgentHandoff(handoffId: string): Promise<AgentHandoffMutation> {
  return request(`/api/agents/conversations/handoffs/${encodeURIComponent(handoffId)}/claim`, { method: "POST", body: JSON.stringify({}) });
}

export function continueAgentHandoff(handoffId: string, resolution?: string): Promise<AgentHandoffMutation> {
  return request(`/api/agents/conversations/handoffs/${encodeURIComponent(handoffId)}/continue`, {
    method: "POST",
    body: JSON.stringify(resolution ? { resolution } : {}),
  });
}

export function resolveAgentHandoff(handoffId: string, resolution?: string): Promise<AgentHandoffMutation> {
  return request(`/api/agents/conversations/handoffs/${encodeURIComponent(handoffId)}/resolve`, {
    method: "POST",
    body: JSON.stringify(resolution ? { resolution } : {}),
  });
}

export function releaseAgentHandoff(handoffId: string, reason?: string): Promise<AgentHandoffMutation> {
  return request(`/api/agents/conversations/handoffs/${encodeURIComponent(handoffId)}/release`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function expireAgentHandoff(handoffId: string): Promise<AgentHandoffMutation> {
  return request(`/api/agents/conversations/handoffs/${encodeURIComponent(handoffId)}/expire`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function sendAgentHumanMessage(handoffId: string, input: { text: string; idempotencyKey: string }): Promise<AgentHumanMessageResult> {
  return request(`/api/agents/conversations/handoffs/${encodeURIComponent(handoffId)}/messages`, {
    method: "POST",
    headers: { "idempotency-key": input.idempotencyKey },
    body: JSON.stringify({ text: input.text }),
  });
}

export type AgentRun = {
  id: string;
  organization_id?: string;
  agent_definition_id?: string;
  agent_version_id?: string;
  installation_id?: string;
  conversation_id?: string | null;
  trigger_type?: string;
  status: string;
  input?: Record<string, unknown>;
  output?: { message?: string; [key: string]: unknown } | null;
  error?: { code?: string; message?: string; userMessage?: string; remediation?: string; [key: string]: unknown } | null;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  updated_at?: string;
  created_by?: string;
  agent_name?: string | null;
  agent_slug?: string | null;
};

export type AgentOperationsSummary = {
  organizationId: string;
  generatedAt: string;
  runs: { runsByStatus: Array<{ status: string; count: number }>; oldestQueuedAt: string | null };
  models: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number; failedCalls: number };
  tools: Array<{ status: string; count: number }>;
  effects: { pendingReconciliation: number };
};

export type AgentEffectReceipt = {
  id: string;
  organization_id?: string;
  installation_id?: string;
  run_id?: string;
  provider_tool_call_id?: string;
  capability?: string;
  capability_version?: string;
  arguments_hash?: string;
  idempotency_key?: string;
  status: string;
  provider_receipt?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  reconciliation_required?: boolean;
  created_at?: string;
  updated_at?: string;
};

export type AgentKillSwitch = {
  id: string;
  organization_id?: string | null;
  scope_type: "organization" | "agent" | "installation" | "tool" | string;
  scope_id: string;
  reason: string;
  enabled: boolean;
  created_by?: string;
  created_at?: string;
  disabled_at?: string | null;
};

export type AgentOperationEvent = {
  id?: string;
  sequence_number?: number | string;
  event_type?: string;
  payload?: Record<string, unknown>;
  created_at?: string;
  [key: string]: unknown;
};

export type AgentJournalEvent = {
  id: string;
  sequence: number;
  occurredAt: string;
  scope?: {
    organizationId?: string;
    installationId?: string;
    runId?: string;
    operationId?: string;
  };
  event?: {
    kind?: string;
    data?: {
      type?: string;
      payload?: Record<string, unknown>;
      [key: string]: unknown;
    };
  };
};

export type AgentRuntimeTelemetry = {
  runId?: string;
  turnId?: string;
  revision: number;
  observedAt: string;
  context: {
    tokens?: number;
    basis: "provider_reported" | "anchored_estimate" | "full_estimate" | "unknown_after_compaction" | "not_measured";
    contextWindowTokens?: number;
    utilizationPercent?: number;
    reservedOutputTokens?: number;
    safetyMarginTokens?: number;
    softThresholdTokens?: number;
    hardLimitTokens?: number;
    pressure?: "normal" | "soft" | "hard";
    capabilitySource?: string;
    decision?: "ready" | "compact" | "prune" | "limited" | "cannot_fit";
    compactionCount: number;
    manifestDigest?: string;
    manifest?: Record<string, unknown>;
    usageAnchorOperationKey?: string;
    latestCompaction?: Record<string, unknown>;
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    basis: "provider_reported" | "partial" | "not_measured";
  };
  runBudget: {
    maxTotalTokens?: number;
    remainingTokens?: number;
  };
  modelAttempt?: {
    status: "queued" | "running" | "streaming" | "completed" | "failed";
    provider?: string;
    model?: string;
    operationKey?: string;
    queuedAt?: string;
    startedAt?: string;
    firstTokenAt?: string;
    completedAt?: string;
    queueMs?: number;
    timeToFirstTokenMs?: number;
    latencyMs?: number;
    outputTokens?: number;
    throughputTokensPerSecond?: number;
    errorCode?: string;
  };
  attempts: Array<{
    status: "queued" | "running" | "streaming" | "completed" | "failed";
    provider?: string;
    model?: string;
    operationKey?: string;
    queuedAt?: string;
    startedAt?: string;
    firstTokenAt?: string;
    completedAt?: string;
    queueMs?: number;
    timeToFirstTokenMs?: number;
    latencyMs?: number;
    outputTokens?: number;
    throughputTokensPerSecond?: number;
    errorCode?: string;
  }>;
  turn: {
    status: "running" | "completed" | "failed" | "limited" | "waiting";
    admittedAt?: string;
    startedAt?: string;
    finishedAt?: string;
    elapsedMs?: number;
    waitMs?: number;
  };
  rolling: {
    sampleCount: number;
    latencyMs?: number;
    outputTokensPerSecond?: number;
  };
};

export type AgentRunTimeline = {
  run: AgentRun;
  events: AgentOperationEvent[];
  journal?: AgentJournalEvent[];
  items?: Array<{
    id: string;
    kind: "event" | "journal" | "step" | "tool_call" | "effect" | string;
    scope: { organizationId: string; installationId: string; runId: string; operationId?: string };
    sequence?: number;
    occurredAt?: string;
    event?: string;
    status?: string;
    operationId?: string;
    attemptId?: string;
    data: Record<string, unknown>;
  }>;
  telemetry?: AgentRuntimeTelemetry;
  projection?: {
    version: string;
    cursor: number;
    freshness: "live" | "settled" | "unknown" | string;
    redaction: "role_scoped" | "redacted" | string;
    observedAt: string;
  };
  steps: Array<Record<string, unknown>>;
  toolCalls: Array<Record<string, unknown>>;
  effects: Array<Record<string, unknown>>;
};

export type AgentMemoryObservatoryGraph = {
  organizationId: string;
  runId?: string;
  cursor: number;
  hasMore: boolean;
  nodes: Array<{
    id: string;
    sequence?: number;
    kind: string;
    status: string;
    occurredAt: string;
    scope: { organizationId: string; installationId: string; runId?: string };
    sourceEventIds: string[];
    revisionIds: string[];
    evidenceIds: string[];
    readiness?: string;
    retryCount: number;
    errorCode?: string;
    metadata: Record<string, string | number | boolean>;
  }>;
  edges: Array<{ id: string; from: string; to: string; relation: string }>;
  projection?: {
    version: string;
    cursor: number;
    freshness: "live" | "settled" | "unknown" | string;
    redaction: "role_scoped" | "redacted" | string;
    observedAt: string;
  };
};

export type AgentApproval = {
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "cancelled" | string;
  providerToolCallId: string;
  runtimeOperationId?: string;
  capability: string;
  argumentsHash: string;
  resourceSnapshot?: Record<string, unknown>;
  resourceSelector?: { type: string; argument: string; value: string };
  previewRevision?: string | null;
  expiresAt: string;
};

export type AgentApprovalGroup = {
  id: string;
  batchId: string;
  turnKey: string;
  planDigest: string;
  policyRevision: string;
  status: string;
  decision?: string | null;
  selectedOperationIds: string[];
  decidedBy?: string | null;
  expiresAt: string;
  createdAt: string;
  decidedAt?: string | null;
  operations: AgentApproval[];
};

export type AgentOperationRun = AgentRun & {
  agent_name?: string | null;
  agent_slug?: string | null;
};

export function getAgentOperationsSummary(): Promise<AgentOperationsSummary> {
  return request<AgentOperationsSummary>("/api/agents/operations/summary");
}

export function listAgentEffectReconciliation(limit = 100): Promise<{ effects: AgentEffectReceipt[] }> {
  return request(`/api/agents/operations/effects/reconciliation?limit=${encodeURIComponent(String(limit))}`);
}

export function reconcileAgentEffect(effectId: string, input: { outcome: "succeeded" | "failed"; providerReceipt?: Record<string, unknown>; error?: Record<string, unknown> }): Promise<{ effectId: string; status: string; reconciliationRequired: boolean }> {
  return request(`/api/agents/operations/effects/${encodeURIComponent(effectId)}/reconcile`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listAgentKillSwitches(): Promise<{ killSwitches: AgentKillSwitch[] }> {
  return request("/api/agents/operations/kill-switches");
}

export function createAgentKillSwitch(input: { scopeType: "organization" | "agent" | "installation" | "tool"; scopeId: string; reason: string }): Promise<AgentKillSwitch> {
  return request("/api/agents/operations/kill-switches", { method: "POST", body: JSON.stringify(input) });
}

export function disableAgentKillSwitch(switchId: string): Promise<void> {
  return request(`/api/agents/operations/kill-switches/${encodeURIComponent(switchId)}`, { method: "DELETE" });
}

export function listAgentOperationRuns(limit = 50): Promise<{ runs: AgentOperationRun[] }> {
  return request(`/api/agents/operations/runs?limit=${encodeURIComponent(String(limit))}`);
}

export function getAgentRun(runId: string): Promise<{ run: AgentRun; canApprove?: boolean; approvalGroup?: AgentApprovalGroup | null; approvalGroups?: AgentApprovalGroup[]; events: AgentOperationEvent[] }> {
  return request(`/api/agents/runs/${encodeURIComponent(runId)}`);
}

export function getAgentRunTimeline(runId: string): Promise<AgentRunTimeline> {
  return request(`/api/agents/runs/${encodeURIComponent(runId)}/timeline`);
}

export function getAgentRunMemoryObservatory(runId: string, options: { afterSequence?: number; limit?: number } = {}): Promise<AgentMemoryObservatoryGraph> {
  const query = new URLSearchParams();
  if (options.afterSequence !== undefined) query.set("afterSequence", String(options.afterSequence));
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request(`/api/agents/runs/${encodeURIComponent(runId)}/memory-observatory${suffix}`);
}

export function getAgentMemoryLineage(revisionId: string): Promise<AgentMemoryObservatoryGraph> {
  return request(`/api/agents/memory/revisions/${encodeURIComponent(revisionId)}/lineage`);
}

export function decideAgentRunApprovalGroup(runId: string, group: Pick<AgentApprovalGroup, "id" | "planDigest">, decision: "approved" | "rejected", selectedOperationIds?: string[], idempotencyKey?: string, grantScope?: "once" | "session"): Promise<{ runId: string; groupId: string; status: string }> {
  const decisionKey = idempotencyKey ?? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${group.id}:${decision}:${Date.now()}`);
  return request(`/api/agents/runs/${encodeURIComponent(runId)}/approval-group`, {
    method: "POST",
    headers: { "Idempotency-Key": decisionKey },
    body: JSON.stringify({ groupId: group.id, planDigest: group.planDigest, decision, ...(selectedOperationIds ? { selectedOperationIds } : {}), ...(grantScope ? { grantScope } : {}) }),
  });
}

export type AgentChannelConnection = {
  id: string;
  installation_id: string;
  channel_type: string;
  channel_key: string;
  metadata: Record<string, unknown>;
  status: string;
};

export type AgentChannelBinding = {
  id: string;
  installation_id: string;
  channel_connection_id?: string;
  channel_type: string;
  external_identity: string;
  status: string;
};

export type WhatsappConnectionOption = {
  id: string;
  phoneDisplayNumber?: string | null;
  phoneNumberId: string;
};

export type AgentConversationRunSummary = {
  id: string;
  conversation_id?: string | null;
  status: string;
  created_at?: string;
  updated_at?: string;
};

export const ACTIVE_AGENT_RUN_STATUSES = new Set([
  "received",
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_human",
  "awaiting_external_event",
]);

export function isActiveAgentRunStatus(status: string | undefined): boolean {
  return Boolean(status && ACTIVE_AGENT_RUN_STATUSES.has(status));
}

export function activeConversationRun(
  runs: AgentConversationRunSummary[] | undefined,
): AgentConversationRunSummary | null {
  return runs?.find((run) => isActiveAgentRunStatus(run.status)) ?? null;
}

export type ConversationResponse = {
  conversation: AgentConversation;
  messages: AgentMessage[];
  hasMore?: boolean;
  nextBefore?: string | null;
  activeRuns?: AgentConversationRunSummary[];
};

export class AgentRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AgentRequestError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (!isFormData && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(apiUrl(path), {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers,
  });
  if (!response.ok) {
    let detail = "";
    let code: string | undefined;
    try {
      const body = (await response.json()) as { error?: string; code?: string };
      detail = body.error ? `: ${body.error}` : "";
      code = body.code;
    } catch {
      // Keep the status-only error when the proxy returned a non-JSON response.
    }
    if (response.status === 401 && typeof window !== "undefined" && window.location.pathname !== "/login") {
      const callbackUrl = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
      throw new AgentRequestError("Your session has expired. Sign in again.", response.status, code);
    }
    throw new AgentRequestError(`Agent request failed (${response.status})${detail}`, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function ensureKasiAi(): Promise<AgentInstallation> {
  return request<AgentInstallation>("/api/agents/kasiai/ensure", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function ensureKasiAiPlayground(): Promise<AgentInstallation> {
  return request<AgentInstallation>("/api/agents/kasiai/ensure", {
    method: "POST",
    body: JSON.stringify({ environment: "playground" }),
  });
}

export function ensureKasiAiLive(): Promise<AgentInstallation> {
  return request<AgentInstallation>("/api/agents/kasiai/ensure", {
    method: "POST",
    body: JSON.stringify({ environment: "live" }),
  });
}

export type AgentDefinition = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  creation_profile?: "general" | "custom" | "system" | null;
  agent_audience?: "personal" | "customer_service" | null;
  status: string;
  protected: boolean;
  owner_type: string;
  execution_mode?: "system_hosted" | "kasitek_hosted" | "external_connected" | null;
  release_mode?: "pinned" | null;
  created_at: string;
  installation_id?: string | null;
  installation_status?: string | null;
  installation_settings?: Record<string, unknown> | null;
  installation_version_id?: string | null;
  published_version_id?: string | null;
  version_number?: number | null;
  published_version_number?: number | null;
};

export type AgentAudience = "personal" | "customer_service";

export type AgentAudienceCounts = {
  total: number;
  personal: number;
  customer_service: number;
};

export function listAgents(): Promise<{ agents: AgentDefinition[]; counts?: AgentAudienceCounts }> {
  return request<{ agents: AgentDefinition[]; counts?: AgentAudienceCounts }>("/api/agents");
}

export function createAgent(input: { name: string; slug?: string; description?: string; creationProfile?: "general" | "custom"; agentAudience?: AgentAudience }): Promise<AgentDefinition> {
  return request("/api/agents", { method: "POST", body: JSON.stringify({ ...input, protected: false }) });
}

export type StudioAgentCreationInput = {
  name: string;
  description?: string;
  instructions: string;
};

export type StudioAgentCreationResult = {
  agent: AgentDefinition;
  version: AgentVersion;
  installation: AgentInstallation;
};

export function createStudioAgent(input: StudioAgentCreationInput): Promise<StudioAgentCreationResult> {
  return request("/api/agents/studio", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export const AGENT_MODEL_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "glm",
  "kimi",
  "minimax",
  "xai",
  "opencode_go",
  "opencode_zen",
] as const;

export type AgentModelProvider = typeof AGENT_MODEL_PROVIDERS[number];

export const AGENT_MODEL_PROVIDER_LABELS: Record<AgentModelProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Claude",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  glm: "GLM",
  kimi: "Kimi",
  minimax: "MiniMax",
  xai: "xAI",
  opencode_go: "OpenCode Go",
  opencode_zen: "OpenCode Zen",
};

export type AgentModel = {
  provider: AgentModelProvider;
  model: string;
  label: string;
  description: string;
  tier: "fast" | "balanced" | "advanced";
  isWorkspaceDefault?: boolean;
  isFree?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
};

export type AgentModelCatalog = {
  models: AgentModel[];
  source: "live" | "fallback";
  fetchedAt: string;
  error?: string;
};

export function getAgentModelCatalog(): Promise<AgentModelCatalog> {
  return request("/api/agents/models/catalog");
}

export type AgentCredentialVerification = {
  provider: AgentModelProvider;
  status: "verified";
  verifiedAt: string;
};

export function verifyAgentProviderCredential(input: { provider: AgentModelProvider; apiKey: string }): Promise<{ verification: AgentCredentialVerification }> {
  return request("/api/agents/credentials/verify", { method: "POST", body: JSON.stringify(input) });
}

export function createAgentProviderCredential(input: { provider: AgentModelProvider; apiKey: string; label?: string }): Promise<{ id: string; provider: AgentModelProvider; label: string; status: string }> {
  return request("/api/agents/credentials", { method: "POST", body: JSON.stringify(input) });
}

export type AgentProviderCredential = {
  id: string;
  provider: AgentModelProvider;
  label: string;
  funding_source: "user";
  status: "active" | "revoked";
  created_at: string;
};

export function listAgentProviderCredentials(): Promise<{ credentials: AgentProviderCredential[] }> {
  return request("/api/agents/credentials");
}

export function updateAgent(agentId: string, input: { name?: string; slug?: string; description?: string | null }): Promise<AgentDefinition> {
  return request(`/api/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export type ExternalAgentConnection = {
  agent: AgentDefinition;
  version: AgentVersion;
  installation: AgentInstallation & { execution_mode: "external_connected" };
  credential: AgentInstallationCredential;
  secret: string;
  created: boolean;
};

export function createExternalAgentConnection(input: {
  name: string;
  slug?: string;
  description?: string;
  agentAudience?: AgentAudience;
  runtime: string;
  protocols: Array<"mcp" | "rest">;
  capabilities?: string[];
  resources?: Array<{ resourceType: string; resourceId: string }>;
  connectors?: string[];
  instructions?: string;
  credentialLabel: string;
  expiresAt?: string;
  clientKeyId?: string;
  clientPublicKey?: string;
  idempotencyKey: string;
}): Promise<ExternalAgentConnection> {
  return request<ExternalAgentConnection>("/api/agents/external-agents", { method: "POST", body: JSON.stringify(input) });
}

export type ExternalAgentDetails = ExternalAgentConnection & {
  grants: AgentInstallationGrants;
  health: { status: string; activeCredentialCount: number; lastUsedAt: string | null };
};

export function listExternalAgents(): Promise<{ agents: AgentDefinition[] }> {
  return request("/api/agents/external-agents");
}

export type ExternalAgentAccessCatalog = {
  capabilities: AgentCapability[];
  connectors: Array<Pick<AgentConnector, "id" | "version" | "displayName" | "ownerService" | "auth" | "capabilityNames" | "requiredScopes" | "supportsReconciliation">>;
};

export function getExternalAgentAccessCatalog(): Promise<ExternalAgentAccessCatalog> {
  return request("/api/agents/external-agents/catalog");
}

export function getExternalAgentDetails(installationId: string): Promise<ExternalAgentDetails> {
  return request(`/api/agents/external-agents/${encodeURIComponent(installationId)}`);
}

export function setExternalAgentStatus(installationId: string, status: "active" | "paused" | "disabled"): Promise<AgentInstallation> {
  return request(`/api/agents/external-agents/${encodeURIComponent(installationId)}/status/${status}`, { method: "POST" });
}

export function getExternalAgentHealth(installationId: string): Promise<{ installationId: string; mode: "external_connected"; status: string; health: ExternalAgentDetails["health"] }> {
  return request(`/api/agents/external-agents/${encodeURIComponent(installationId)}/health`);
}

export function archiveExternalAgent(installationId: string): Promise<{ archived: boolean; installation: AgentInstallation }> {
  return request(`/api/agents/external-agents/${encodeURIComponent(installationId)}`, { method: "DELETE" });
}

export type AgentSpecInput = {
  specVersion: 1;
  execution?: { mode?: "autonomous"; role?: "standalone" | "orchestrator" };
  identity?: { displayName?: string; purpose?: string; audience?: AgentAudience };
  behavior: {
    instructions: string;
    tone?: "concise" | "balanced" | "detailed" | "formal" | "warm" | "direct";
    responseLength?: "short" | "balanced" | "detailed";
    initiative?: "cautious" | "balanced" | "proactive";
    language?: string;
    formatting?: "plain" | "markdown" | "structured";
    rules?: string[];
    advancedInstructions?: string;
  };
  model: {
    version: string;
    primary: { provider: AgentModelProvider; model: string };
    credentialReference?: string;
    fallback?: Array<{ provider: AgentModelProvider; model: string }>;
    allowUserFundedFallbackToKasiTek?: boolean;
    maxTokensPerRun?: number;
    maxEstimatedCostUsd?: number;
  };
  runtime?: {
    maxContextMessages?: number;
    maxContextTokens?: number;
    maxIterations?: number;
    maxModelCalls?: number;
    maxToolCalls?: number;
    maxTotalTokens?: number;
    maxWallTimeMs?: number;
    maxEstimatedCostUsd?: number;
    temperature?: number;
  };
  capabilities?: { allowedTools?: string[]; requiredCapabilities?: string[] };
  knowledge?: { sourceIds?: string[]; requiredConnections?: string[] };
  memory?: {
    mode?: "disabled" | "explicit" | "reviewed" | "automatic";
    readableNamespaces?: string[];
    writableNamespaces?: string[];
    writableTypes?: string[];
    maxRetrieved?: number;
    maxRetrievedTokens?: number;
    maxWritesPerRun?: number;
    retentionDays?: number;
    allowSensitive?: boolean;
  };
  skills?: { allowedSkillIds?: string[] };
  extensions?: { packages?: unknown[]; grants?: unknown[] };
  workflow?: { graph?: Record<string, unknown> };
  channels?: { allowed?: string[] };
  release?: { mode?: "pinned" };
};

export type AgentVersionCreateInput = {
  instructions: string;
  configuration?: Record<string, unknown>;
  policy?: Record<string, unknown>;
} | { spec: AgentSpecInput };

export function createAgentVersion(agentId: string, input: AgentVersionCreateInput): Promise<AgentVersion> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/versions`, {
    method: "POST",
    body: JSON.stringify("spec" in input ? input : { configuration: {}, policy: {}, ...input }),
  });
}

export function createAgentInstallation(agentVersionId: string, settings: Record<string, unknown> = {}, releaseMode?: "pinned"): Promise<AgentInstallation> {
  return request("/api/agents/installations", { method: "POST", body: JSON.stringify({ agentVersionId, scopeType: "organization", settings, ...(releaseMode ? { releaseMode } : {}) }) });
}

export function ensureAgentPlayground(agentId: string): Promise<AgentInstallation> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/playground/ensure`, { method: "POST", body: JSON.stringify({}) });
}

export type AgentDeploymentVersion = {
  versionId: string;
  versionNumber: number;
  status: string;
  digest: string;
  extensionSnapshotId: string | null;
  extensionSnapshotChecksum: string | null;
};

export type AgentDeploymentStatus = {
  agentId: string;
  state: "pending" | "ready" | "blocked" | "deployed" | "rollback_available";
  status: "pending" | "ready" | "blocked" | "deployed" | "rollback_available";
  playground: { installationId: string | null; status: string | null; version: AgentDeploymentVersion | null; capabilityConfigurationDigest: string | null };
  live: { installationId: string | null; status: string | null; version: AgentDeploymentVersion | null; capabilityConfigurationDigest: string | null };
  rollbackTarget: AgentDeploymentVersion | null;
  latestPromotion: {
    id: string;
    candidateVersionId: string | null;
    previousVersionId: string | null;
    sourceInstallationId: string | null;
    capabilityConfigurationDigest: string | null;
    bindingRevision: string | null;
    createdAt: string;
  } | null;
};

export type AgentDeploymentPreflight = {
  installationId: string;
  agentId: string;
  environment: "live";
  ready: boolean;
  status: "ready" | "blocked";
  candidate: AgentDeploymentVersion | null;
  current: AgentDeploymentVersion | null;
  sourceInstallationId: string | null;
  capabilityConfigurationDigest: string | null;
  bindingRevision: string | null;
  blockers: Array<{ code: string; detail: string }>;
};

export type AgentDeploymentActivation = {
  status: "activated" | "already_active";
  promotionId: string;
  installation: AgentInstallation;
  manifest: {
    sourceInstallationId: string | null;
    targetInstallationId: string;
    candidateVersionId: string;
    candidateDigest: string;
    capabilityConfigurationDigest: string | null;
    extensionSnapshotChecksum: string | null;
    bindingRevision: string | null;
    expectedVersionId: string;
    previousVersionId: string | null;
    idempotencyKey: string;
  };
};

export function deployAgentInstallation(installationId: string, versionId: string, expectedVersionId?: string): Promise<AgentInstallation> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/deploy`, { method: "POST", body: JSON.stringify({ versionId, ...(expectedVersionId ? { expectedVersionId } : {}) }) });
}

export function getAgentDeploymentStatus(agentId: string): Promise<AgentDeploymentStatus> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/deployment-status`);
}

export function preflightAgentInstallationDeployment(installationId: string, input: { versionId: string; sourceInstallationId?: string; expectedVersionId?: string }): Promise<AgentDeploymentPreflight> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/preflight`, { method: "POST", body: JSON.stringify(input) });
}

export function promoteAgentInstallation(installationId: string, input: { versionId: string; sourceInstallationId: string; expectedVersionId: string; idempotencyKey: string }): Promise<AgentDeploymentActivation> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/promote`, { method: "POST", body: JSON.stringify(input) });
}

export function rollbackAgentInstallation(installationId: string, input: { expectedVersionId?: string; targetVersionId?: string; idempotencyKey?: string } = {}): Promise<AgentDeploymentActivation> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/rollback`, { method: "POST", body: JSON.stringify(input) });
}

export type AgentTemplate = {
  key: string;
  version: number;
  profile: "custom";
  audience: "personal" | "customer_service";
  category: string;
  name: string;
  description: string;
  instructions?: string;
  policy?: Record<string, unknown>;
  configuration?: Record<string, unknown>;
  requiredConnections: string[];
  requiredCapabilities: string[];
  setupSteps: string[];
  configurableFields: Array<{ key: string; type: string; description: string }>;
  channelCompatibility?: string[];
};

export function installAgentTemplate(templateKey: string, settings: Record<string, unknown> = {}): Promise<unknown> {
  return request(`/api/agents/templates/${encodeURIComponent(templateKey)}/install`, {
    method: "POST",
    body: JSON.stringify({ settings }),
  });
}

export function setAgentInstallationStatus(installationId: string, status: "active" | "paused" | "disabled"): Promise<unknown> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/status/${status}`, { method: "POST" });
}

export type AgentInstallationCredential = {
  id: string;
  installation_id: string;
  label: string;
  status: "active" | "revoked";
  expires_at?: string | null;
  last_used_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  mcp_scopes: Array<"mcp:read" | "mcp:write">;
  api_scopes?: Array<"api:read" | "api:write">;
  client_key_id?: string | null;
  client_public_key?: string | null;
};

export function listAgentInstallationCredentials(installationId: string): Promise<{ credentials: AgentInstallationCredential[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/credentials`);
}

export function createAgentInstallationCredential(installationId: string, input: {
  label: string;
  expiresAt?: string;
  clientKeyId?: string;
  clientPublicKey?: string;
}): Promise<{ credential: AgentInstallationCredential; secret: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/credentials`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function revokeAgentInstallationCredential(installationId: string, credentialId: string): Promise<unknown> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/credentials/${encodeURIComponent(credentialId)}`, { method: "DELETE" });
}

export function rotateAgentInstallationCredential(installationId: string, credentialId: string): Promise<{ credential: AgentInstallationCredential; secret: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/credentials/${encodeURIComponent(credentialId)}/rotate`, { method: "POST", body: JSON.stringify({}) });
}

export type AgentCapabilityDirectoryEntry = {
  id: string;
  version: string;
  kind: "builtin_tool" | "connector" | "connector_tool" | "skill" | "plugin" | "plugin_tool" | "mcp_server" | "mcp_tool" | "user_tool" | string;
  name: string;
  description: string;
  category: string;
  logo?: string;
  tags: string[];
  source: { kind: string; id: string; version: string; checksum?: string; trust: string };
  provider?: { id: string; name: string; version?: string };
  toolsetIds: string[];
  runtime: { execution: string; riskClass?: string; requiresApproval?: boolean; timeoutMs?: number; requiredScopes: string[]; credentialRequirements: string[] };
};

export type AgentCapabilityToolset = {
  id: string;
  version: string;
  name: string;
  description: string;
  source: { kind: string; id: string; version: string; checksum?: string; trust: string };
  capabilityIds: string[];
  includes: string[];
};

export type AgentCapability = {
  name: string;
  version: string;
  description: string;
  riskClass: string;
  requiresApproval: boolean;
  availability: "available" | "not_granted" | "not_configured" | "unhealthy" | string;
  available?: boolean;
  reasonCode?: "available" | "not_entitled" | "not_granted" | "credential_denied" | "provider_not_configured" | "provider_unhealthy" | "feature_disabled" | "approval_required" | string;
  registryLifecycle?: "active" | "not_registered" | string;
  subscription?: "entitled" | "not_entitled" | "unknown" | string;
  providerReadiness?: "ready" | "not_configured" | "unhealthy" | "unknown" | string;
  installationGrant?: "granted" | "not_granted" | string;
  credentialNarrowing?: "allowed" | "denied" | "not_applicable" | string;
  resourceConstraint?: "unconstrained" | "installation_scoped" | string;
  connectorConstraint?: "unconstrained" | "installation_scoped" | string;
  featureFlag?: "enabled" | "disabled" | "unknown" | string;
  approvalRequired?: boolean;
  effectiveAccess?: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  permission?: { scope: string; label: string; resourceType?: string };
  audit?: { classification: string; description: string; redaction: string[] };
  documentation?: { title: string; summary: string };
  catalog?: {
    kind: AgentCapabilityDirectoryEntry["kind"];
    category: string;
    logo?: string;
    tags: string[];
    source: { kind: string; id: string; version: string; checksum?: string; trust: string };
    provider?: { id: string; name: string; version?: string };
    toolsetIds: string[];
    runtime: { execution: string; riskClass?: string; requiresApproval?: boolean; timeoutMs?: number; requiredScopes: string[]; credentialRequirements: string[] };
  };
};

export function listAgentCapabilities(): Promise<{ capabilities: AgentCapability[]; directory?: AgentCapabilityDirectoryEntry[]; toolsets?: AgentCapabilityToolset[] }> {
  return request("/api/agents/capabilities");
}

export function listAgentCapabilityDirectory(): Promise<{ directory: AgentCapabilityDirectoryEntry[]; toolsets: AgentCapabilityToolset[] }> {
  return request("/api/agents/capabilities/directory");
}

export type AgentConnectionDirectoryEntry = {
  id: string;
  kind: "native" | "mcp" | string;
  name: string;
  description: string;
  category: string;
  logo: string;
  provider?: string;
  oauthProvider?: string;
  auth: "internal" | "oauth2" | "api_key" | "webhook" | "local_connector" | "observability" | "oauth" | "none" | string;
  source: "kasitek" | "reviewed-catalog" | string;
  sourceUrl?: string;
  endpointUrl?: string | null;
  transport?: "http" | "stdio";
  managed?: boolean;
  keywords?: string[];
  hosts?: string[];
  configured?: boolean;
  status?: "ready" | "connected" | "not_configured" | "unhealthy" | "unsupported" | string;
  connectionId?: string | null;
  providerId?: string | null;
};

export type WorkspaceEmailConnection = {
  id: string;
  provider: string;
  emailAddress: string;
  displayName: string;
  status: string;
  healthStatus: string;
  syncStatus: string;
  inboxStatus: string;
  inboundStatus: string;
  outboundStatus: string;
};

export function listWorkspaceEmailConnections(): Promise<{ connections: WorkspaceEmailConnection[] }> {
  return request("/api/email/connections");
}

export function listAgentConnectionDirectory(installationId: string): Promise<{ installationId: string; connections: AgentConnectionDirectoryEntry[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/connection-directory`);
}

export function connectAgentMcpCatalog(installationId: string, catalogId: string, input: { apiKey?: string; agentVersionId?: string } = {}): Promise<unknown> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/mcp/catalog/${encodeURIComponent(catalogId)}/connect`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function startAgentMcpCatalogOAuth(installationId: string, catalogId: string, input: { agentVersionId?: string; clientId?: string; clientSecret?: string } = {}): Promise<{ authorizationUrl: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/mcp/catalog/${encodeURIComponent(catalogId)}/oauth/start`, { method: "POST", body: JSON.stringify(input) });
}

export type AgentSkill = {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  owner_type?: "platform" | "organization" | "user" | string;
  status: "draft" | "published" | "deprecated" | "revoked" | string;
};

export type AgentSkillVersion = {
  id: string;
  skill_definition_id: string;
  version_number: number;
  status: "draft" | "published" | "retired" | "revoked" | string;
  instructions?: string;
  required_capabilities: string[];
  required_connectors: string[];
  skill_slug?: string;
  skill_name?: string;
  skill_status?: string;
  checksum: string;
};

export function listAgentSkills(): Promise<{ skills: AgentSkill[] }> {
  return request("/api/agents/skills");
}

export type AgentSkillDirectoryEntry = {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  category: string;
  tags: string[];
  sourceUrl: string;
  rawUrl: string;
  source: "reviewed-catalog" | string;
  installed: boolean;
  enabled: boolean;
  skillId: string | null;
  versionId: string | null;
};

export function listAgentSkillDirectory(agentVersionId?: string): Promise<{ skills: AgentSkillDirectoryEntry[] }> {
  const query = agentVersionId ? `?agentVersionId=${encodeURIComponent(agentVersionId)}` : "";
  return request(`/api/agents/skills/directory${query}`);
}

export function installAgentSkillCatalog(installationId: string, catalogId: string, agentVersionId?: string): Promise<unknown> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/skills/catalog/${encodeURIComponent(catalogId)}/install`, {
    method: "POST",
    body: JSON.stringify(agentVersionId ? { agentVersionId } : {}),
  });
}

export type AgentExtensionPackage = {
  id: string;
  kind: "skill" | "plugin" | "connector" | "mcp_capability" | string;
  package_id: string;
  version: string;
  name?: string | null;
  checksum: string;
  status: "draft" | "published" | "deprecated" | "revoked" | string;
  declaration: Record<string, unknown>;
  dependencies?: Array<Record<string, unknown>>;
  compatibility?: Record<string, unknown> | null;
};

export function listAgentExtensionPackages(): Promise<{ packages: AgentExtensionPackage[] }> {
  return request("/api/agents/extensions/packages");
}

export type AgentPluginDirectoryEntry = {
  id: string;
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  kind: "backend" | "standalone" | "model-provider" | "platform" | string;
  requiredEnv: string[];
  providedTools: string[];
  providedProviders: string[];
  adapterCapabilityIds: string[];
  hooks: string[];
  platforms: string[];
  homepage?: string;
  sourceUrl: string;
  checksum: string;
  adapterStatus: "metadata_only" | "supported" | string;
  readiness?: { state: "ready" | "blocked"; blockers: string[] } | null;
  source: "reviewed-catalog" | string;
  installed: boolean;
  packageId: string | null;
  packageVersionId: string | null;
  packageStatus?: string | null;
};

export function listAgentPluginDirectory(installationId?: string): Promise<{ plugins: AgentPluginDirectoryEntry[] }> {
  const query = installationId ? `?installationId=${encodeURIComponent(installationId)}` : "";
  return request(`/api/agents/plugins/directory${query}`);
}

export function installAgentPluginCatalog(installationId: string, catalogId: string): Promise<{ plugin: AgentPluginDirectoryEntry; package: AgentExtensionPackage; installationId: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/plugins/catalog/${encodeURIComponent(catalogId)}/install`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listAgentSkillVersions(skillId: string): Promise<{ versions: AgentSkillVersion[] }> {
  return request(`/api/agents/skills/${encodeURIComponent(skillId)}/versions`);
}

export function listAgentVersionSkills(agentVersionId: string): Promise<{ skills: AgentSkillVersion[] }> {
  return request(`/api/agents/agent-versions/${encodeURIComponent(agentVersionId)}/skills`);
}

export function pinAgentSkillVersion(agentVersionId: string, skillVersionId: string): Promise<unknown> {
  return request(`/api/agents/agent-versions/${encodeURIComponent(agentVersionId)}/skills/${encodeURIComponent(skillVersionId)}`, { method: "POST" });
}

export function unpinAgentSkillVersion(agentVersionId: string, skillVersionId: string): Promise<unknown> {
  return request(`/api/agents/agent-versions/${encodeURIComponent(agentVersionId)}/skills/${encodeURIComponent(skillVersionId)}`, { method: "DELETE" });
}

export type AgentMcpProvider = {
  id: string;
  name: string;
  endpoint_url: string;
  catalog_id?: string | null;
  credential_reference?: string | null;
  status: "draft" | "approved" | "revoked" | string;
  health_status: "unknown" | "healthy" | "unhealthy" | string;
  health_latency_ms?: number | null;
  health_failure_code?: string | null;
  health_checked_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type AgentMcpProviderVersion = {
  id: string;
  provider_id: string;
  revision: number;
  status: "draft" | "published" | "revoked" | string;
  protocol_version: string;
  tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>;
  checksum: string;
  provider_name?: string;
  endpoint_url?: string;
  credential_reference?: string | null;
  created_at?: string;
  published_at?: string | null;
};

export function listAgentMcpProviders(): Promise<{ providers: AgentMcpProvider[] }> {
  return request("/api/agents/mcp/providers");
}

export function createAgentMcpProvider(input: { name: string; endpointUrl: string; credentialReference?: string }): Promise<AgentMcpProvider> {
  return request("/api/agents/mcp/providers", { method: "POST", body: JSON.stringify(input) });
}

export function discoverAgentMcpProvider(providerId: string): Promise<AgentMcpProviderVersion> {
  return request(`/api/agents/mcp/providers/${encodeURIComponent(providerId)}/discover`, { method: "POST" });
}

export function healthCheckAgentMcpProvider(providerId: string): Promise<AgentMcpProvider> {
  return request(`/api/agents/mcp/providers/${encodeURIComponent(providerId)}/health`, { method: "POST" });
}

export function listAgentMcpProviderVersions(providerId: string): Promise<{ versions: AgentMcpProviderVersion[] }> {
  return request(`/api/agents/mcp/providers/${encodeURIComponent(providerId)}/versions`);
}

export function publishAgentMcpProviderVersion(providerId: string, versionId: string): Promise<AgentMcpProviderVersion> {
  return request(`/api/agents/mcp/providers/${encodeURIComponent(providerId)}/versions/${encodeURIComponent(versionId)}/publish`, { method: "POST" });
}

export function revokeAgentMcpProvider(providerId: string): Promise<{ revoked: boolean }> {
  return request(`/api/agents/mcp/providers/${encodeURIComponent(providerId)}/revoke`, { method: "POST" });
}

export function listAgentVersionMcpProviders(agentVersionId: string): Promise<{ providers: AgentMcpProviderVersion[] }> {
  return request(`/api/agents/agent-versions/${encodeURIComponent(agentVersionId)}/mcp-providers`);
}

export function pinAgentMcpProviderVersion(agentVersionId: string, providerVersionId: string): Promise<unknown> {
  return request(`/api/agents/agent-versions/${encodeURIComponent(agentVersionId)}/mcp-providers/${encodeURIComponent(providerVersionId)}`, { method: "POST" });
}

export function unpinAgentMcpProviderVersion(agentVersionId: string, providerVersionId: string): Promise<unknown> {
  return request(`/api/agents/agent-versions/${encodeURIComponent(agentVersionId)}/mcp-providers/${encodeURIComponent(providerVersionId)}`, { method: "DELETE" });
}

export type AgentReadiness = {
  installationId: string;
  agentId: string;
  versionId: string;
  profile?: "general" | "custom" | "system" | null;
  executionMode: "system_hosted" | "kasitek_hosted" | "external_connected";
  status: "ready" | "blocked" | string;
  ready: boolean;
  checks: {
    deployment: { status: "ready" | "blocked"; installationStatus: string };
    workflow: { status: "ready" | "blocked"; error?: string };
    capabilities: { required: string[]; available: string[]; missing: string[] };
    connections: { required: string[]; configured: string[]; missing: string[] };
    credentials: { status: "ready" | "blocked" | "not_required"; provider?: string; detail: string };
  };
  blockers: Array<{ code: string; title: string; detail: string; capability?: string; connection?: string }>;
  capabilities: AgentCapability[];
};

export type AgentInstallationGrants = {
  resources: Array<{ resourceType: string; resourceId: string }>;
  connectors: string[];
};

export type AgentConnector = {
  id: string;
  version: string;
  displayName: string;
  ownerService: string;
  auth: string;
  requiredScopes: string[];
  capabilityNames: string[];
  rateLimit: { requests: number; windowSeconds: number };
  supportsReconciliation: boolean;
};

export type AgentIntegration = {
  id: string;
  kind: "tool" | "channel" | string;
  runtime: "tool_registry" | "webhook" | "gateway" | "workspace_channel" | string;
  name: string;
  description: string;
  category: "productivity" | "search" | "apple" | "observability" | string;
  auth: "internal" | "oauth2" | "api_key" | "webhook" | "local_connector" | "observability" | string;
  logo: string;
  provider?: string;
  oauthProvider?: string;
  capabilityNames: string[];
  requiredScopes: string[];
  configurable: boolean;
  status: "not_configured" | "connected" | "unhealthy" | "requires_connector" | "revoked" | string;
  available: boolean;
  hasCredential: boolean;
  configuration: Record<string, unknown>;
  channelType?: "whatsapp" | "telegram" | "discord" | string;
  connectionId?: string | null;
  connectionCount?: number;
  healthMessage?: string | null;
  lastCheckedAt?: string | null;
};

export type AgentInstallationIntegrations = {
  installationId: string;
  integrations: AgentIntegration[];
};

export function listAgentInstallationCapabilities(installationId: string): Promise<{ installationId: string; capabilities: AgentCapability[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/capabilities`);
}

export function getAgentInstallationReadiness(installationId: string): Promise<AgentReadiness> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/readiness`);
}

export function grantAgentInstallationTool(installationId: string, toolName: string): Promise<unknown> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/tools`, {
    method: "POST",
    body: JSON.stringify({ toolName }),
  });
}

export function listAgentInstallationGrants(installationId: string): Promise<AgentInstallationGrants> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/grants`);
}

export function grantAgentInstallationResource(installationId: string, resourceType: string, resourceId: string): Promise<unknown> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/grants/resources`, {
    method: "POST",
    body: JSON.stringify({ resourceType, resourceId }),
  });
}

export function listAgentConnectors(): Promise<{ connectors: AgentConnector[] }> {
  return request("/api/agents/connectors");
}

export function listAgentInstallationConnectors(installationId: string): Promise<{ installationId: string; connectors: AgentConnector[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/connectors`);
}

export function grantAgentInstallationConnector(installationId: string, connectorId: string): Promise<unknown> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/grants/connectors`, {
    method: "POST",
    body: JSON.stringify({ connectorId }),
  });
}

export function listAgentInstallationIntegrations(installationId: string): Promise<AgentInstallationIntegrations> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/integrations`);
}

export function saveAgentIntegrationApiKey(installationId: string, integrationId: string, input: { apiKey: string; label?: string }): Promise<{ integration: AgentIntegration }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/integrations/${encodeURIComponent(integrationId)}/api-key`, { method: "POST", body: JSON.stringify(input) });
}

export function saveAgentIntegrationLocalConnector(installationId: string, integrationId: string, input: { endpoint: string; secret: string; label?: string }): Promise<{ integration: AgentIntegration }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/integrations/${encodeURIComponent(integrationId)}/local-connector`, { method: "POST", body: JSON.stringify(input) });
}

export function startAgentIntegrationOAuth(installationId: string, integrationId: string): Promise<{ authorizationUrl: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/integrations/${encodeURIComponent(integrationId)}/oauth/start`);
}

export function bindAgentWorkspaceEmail(installationId: string, integrationId: string, connectionId: string): Promise<{ integration: AgentIntegration }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/integrations/${encodeURIComponent(integrationId)}/workspace-email`, {
    method: "POST",
    body: JSON.stringify({ connectionId }),
  });
}

export function disconnectAgentIntegration(installationId: string, integrationId: string): Promise<unknown> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/integrations/${encodeURIComponent(integrationId)}`, { method: "DELETE" });
}

export type AgentInstallationRun = AgentRun & {
  organization_id: string;
  installation_id: string;
  trigger_type?: string;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  error?: { message?: string; code?: string; [key: string]: unknown } | null;
};

export function listAgentInstallationRuns(installationId: string, limit = 50): Promise<{ installationId: string; runs: AgentInstallationRun[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/runs?limit=${encodeURIComponent(String(limit))}`);
}

export type AgentInstallationOperation = AgentInstallationRun & {
  transport?: "mcp" | "rest" | "unknown";
  tool_name?: string | null;
  tool_invocation_count?: number;
  model_call_count?: number;
  approval_status?: string | null;
};

export type AgentInstallationOperationSummary = {
  total: number;
  byStatus: Record<string, number>;
  toolInvocations: number;
  modelCalls: number;
  estimatedCostUsd: string;
};

export function listAgentInstallationOperations(installationId: string, limit = 50): Promise<{ installationId: string; operations: AgentInstallationOperation[]; summary: AgentInstallationOperationSummary }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/operations?limit=${encodeURIComponent(String(limit))}`);
}

export type AgentSchedule = {
  id: string;
  installation_id: string;
  expression: string;
  timezone: string;
  input: Record<string, unknown>;
  status: "active" | "paused" | "disabled" | string;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
};

export function listAgentInstallationSchedules(installationId: string): Promise<{ schedules: AgentSchedule[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/schedules`);
}

export function createAgentInstallationSchedule(installationId: string, input: { expression: string; timezone: string; input?: Record<string, unknown>; nextRunAt?: string }): Promise<AgentSchedule> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/schedules`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function setAgentScheduleStatus(scheduleId: string, status: "active" | "paused" | "disabled"): Promise<AgentSchedule> {
  return request(`/api/agents/schedules/${encodeURIComponent(scheduleId)}/status/${status}`, { method: "POST" });
}

export type AgentKnowledgeSource = {
  id: string;
  organization_id: string;
  agent_definition_id: string | null;
  installation_id: string | null;
  name: string;
  source_type: string;
  source_uri: string | null;
  provenance: Record<string, unknown>;
  status: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type AgentMemory = {
  id: string;
  namespace: string;
  memory_type: string;
  canonical_text: string;
  source_type: string;
  sensitivity: string;
  status: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export function listAgentKnowledgeSources(agentId: string, installationId?: string): Promise<{ sources: AgentKnowledgeSource[] }> {
  const query = new URLSearchParams({ agentId });
  if (installationId) query.set("installationId", installationId);
  return request(`/api/agents/knowledge/sources?${query.toString()}`);
}

export function getAgentKnowledgeSource(sourceId: string): Promise<{ source: AgentKnowledgeSource; text: string }> {
  return request(`/api/agents/knowledge/sources/${encodeURIComponent(sourceId)}`);
}

export function createAgentKnowledgeSource(input: { agentId: string; installationId?: string; name: string; sourceType: "url" | "manual" | "platform" | "upload"; sourceUri?: string }): Promise<AgentKnowledgeSource> {
  return request("/api/agents/knowledge/sources", { method: "POST", body: JSON.stringify(input) });
}

export type AgentWebsiteMapLink = { url: string; title?: string; description?: string };
export type AgentWebsiteCrawl = { source: AgentKnowledgeSource; crawlId: string; status: string };

export function mapAgentWebsite(input: { agentId: string; installationId?: string; url: string; limit?: number; includeSubdomains?: boolean }): Promise<{ url: string; links: AgentWebsiteMapLink[] }> {
  return request("/api/agents/knowledge/websites/map", { method: "POST", body: JSON.stringify(input) });
}

export function startAgentWebsiteCrawl(input: { agentId: string; installationId?: string; name: string; url: string; limit?: number; maxDiscoveryDepth?: number; includePaths?: string[]; excludePaths?: string[]; allowSubdomains?: boolean }): Promise<AgentWebsiteCrawl> {
  return request("/api/agents/knowledge/websites/crawl", { method: "POST", body: JSON.stringify(input) });
}

export function getAgentWebsiteCrawl(sourceId: string): Promise<AgentWebsiteCrawl & { total?: number; completed?: number; pages?: number }> {
  return request(`/api/agents/knowledge/websites/crawl/${encodeURIComponent(sourceId)}`);
}

export function cancelAgentWebsiteCrawl(sourceId: string): Promise<AgentWebsiteCrawl> {
  return request(`/api/agents/knowledge/websites/crawl/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
}

export function ingestAgentKnowledgeSourceUrl(sourceId: string, url: string): Promise<{ sourceId: string; revision: number; chunks: unknown[] }> {
  return request(`/api/agents/knowledge/sources/${encodeURIComponent(sourceId)}/ingest-url`, { method: "POST", body: JSON.stringify({ url }) });
}

export function ingestAgentKnowledgeSourceText(sourceId: string, text: string): Promise<{ sourceId: string; revision: number; chunks: unknown[] }> {
  return request(`/api/agents/knowledge/sources/${encodeURIComponent(sourceId)}/ingest-text`, { method: "POST", body: JSON.stringify({ text, contentType: "text/markdown" }) });
}

export function ingestAgentKnowledgeSourceFile(sourceId: string, file: File): Promise<{ sourceId: string; revision: number; filename: string; format: string; bytes: number; chunks: unknown[] }> {
  const body = new FormData();
  body.append("file", file, file.name);
  return request(`/api/agents/knowledge/sources/${encodeURIComponent(sourceId)}/ingest-file`, { method: "POST", body });
}

export function deleteAgentKnowledgeSource(sourceId: string, agentId: string, installationId?: string): Promise<unknown> {
  return request(`/api/agents/knowledge/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE", body: JSON.stringify({ agentId, ...(installationId ? { installationId } : {}) }) });
}

export function listAgentMemory(agentId: string, installationId?: string): Promise<{ memories: AgentMemory[] }> {
  const query = new URLSearchParams({ agentId });
  if (installationId) query.set("installationId", installationId);
  query.set("reviewable", "true");
  return request(`/api/agents/memory?${query.toString()}`);
}

export function deleteAgentMemory(memoryId: string, agentId: string, installationId?: string): Promise<unknown> {
  return request(`/api/agents/memory/${encodeURIComponent(memoryId)}`, { method: "DELETE", body: JSON.stringify({ agentId, ...(installationId ? { installationId } : {}) }) });
}

export function revalidateAgentMemory(memoryId: string, agentId: string, installationId?: string, expiresAt: string | null = null): Promise<AgentMemory> {
  return request(`/api/agents/memory/${encodeURIComponent(memoryId)}/revalidate`, { method: "POST", body: JSON.stringify({ agentId, ...(installationId ? { installationId } : {}), expiresAt }) });
}

export function reviewAgentMemory(memoryId: string, agentId: string, decision: "approve" | "reject", installationId?: string): Promise<{ memory: AgentMemory }> {
  return request(`/api/agents/memory/${encodeURIComponent(memoryId)}/review`, { method: "POST", body: JSON.stringify({ agentId, ...(installationId ? { installationId } : {}), decision }) });
}

export type AgentInstallationSettings = {
  language?: string;
  tone?: "concise" | "balanced" | "detailed";
  responseDetail?: "concise" | "standard" | "detailed";
  notificationsEnabled?: boolean;
};

export type KasiAiModel = {
  provider: AgentModelProvider;
  model: string;
  label: string;
  description: string;
  tier: "fast" | "balanced" | "advanced";
  isWorkspaceDefault?: boolean;
  isFree?: boolean;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  contextWindow?: number;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
};

export type KasiAiPreferences = {
  language?: string | null;
  tone?: "concise" | "balanced" | "detailed" | null;
  response_detail?: "concise" | "standard" | "detailed" | null;
  notifications_enabled?: boolean;
  use_saved_preferences?: boolean;
  reference_previous_chats?: boolean;
  default_model_provider?: AgentModelProvider | null;
  default_model?: string | null;
  default_credential_reference?: string | null;
};

export type KasiAiHome = {
  installation: AgentInstallation;
  conversations: AgentConversation[];
  archivedConversations: AgentConversation[];
  channelDefaultConversationId: string | null;
  preferences: KasiAiPreferences | null;
  models: KasiAiModel[];
  modelCatalog?: { source: "live" | "fallback"; fetchedAt: string; error?: string };
};

export function updateAgentInstallationSettings(installationId: string, settings: AgentInstallationSettings): Promise<AgentInstallation> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/settings`, {
    method: "PATCH",
    body: JSON.stringify(settings),
  });
}

export type AgentVersion = {
  id: string;
  agent_definition_id: string;
  version_number: number;
  status: "draft" | "published" | "retired" | "archived" | string;
  instructions?: string | null;
  configuration?: Record<string, unknown>;
  policy?: Record<string, unknown>;
  model_policy?: Record<string, unknown>;
  tool_policy?: Record<string, unknown>;
  created_at: string;
  published_at?: string | null;
  retired_at?: string | null;
};

export type AgentEffectiveConfigProjection = {
  version: {
    id: string;
    agentDefinitionId: string;
    versionNumber: number;
    status: string;
    checksum: string;
    extensionSnapshotId: string | null;
    createdAt: string;
    publishedAt: string | null;
  };
  source: "typed" | "legacy" | string;
  behavior: { instructionCharacters: number };
  model: {
    provider?: string;
    model?: string;
    policyVersion?: string;
    fallback: Array<{ provider: string; model: string }>;
    maxTokensPerRun?: number;
    maxEstimatedCostUsd?: number;
    allowUserFundedFallbackToKasiTek: boolean;
    error?: string;
  };
  tools: string[];
  connectors: string[];
  knowledge: { sourceIds: string[]; requiredConnections: string[] };
  memory: Record<string, unknown>;
  limits: Record<string, unknown>;
  workflow: { configured: boolean; valid: boolean; nodeCount?: number; error?: string };
  channels: string[];
  skills: Array<{
    id: string;
    skillDefinitionId: string;
    name: string;
    slug: string;
    versionNumber: number;
    status: string;
    checksum: string;
    requiredCapabilities: string[];
    requiredConnectors: string[];
    knowledgeSourceIds: string[];
  }>;
  remoteMcpProviders: Array<{
    id: string;
    providerName: string;
    revision: number;
    status: string;
    protocolVersion: string;
    checksum: string;
    toolCount: number;
    healthStatus: string;
  }>;
  installation?: {
    id: string;
    scopeType: string;
    scopeId: string;
    executionMode: string;
    releaseMode: string;
  };
};

export function getAgentVersionEffectiveConfig(agentVersionId: string, installationId?: string): Promise<{ effective: AgentEffectiveConfigProjection }> {
  const query = installationId ? `?installationId=${encodeURIComponent(installationId)}` : "";
  return request(`/api/agents/agent-versions/${encodeURIComponent(agentVersionId)}/effective-config${query}`);
}

export function listAgentVersions(agentId: string): Promise<{ versions: AgentVersion[] }> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/versions`);
}

export function publishAgentVersion(agentId: string, versionId: string): Promise<AgentVersion> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/publish`, { method: "POST" });
}

export function rollbackAgentVersion(agentId: string, versionId: string): Promise<AgentVersion> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/rollback`, { method: "POST" });
}

export function retireAgentVersion(agentId: string, versionId: string): Promise<AgentVersion> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/retire`, { method: "POST" });
}

export function archiveAgent(agentId: string): Promise<AgentDefinition> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/archive`, { method: "POST" });
}

export function deleteAgent(agentId: string): Promise<{
  agentId: string;
  installationIds?: string[];
  deleted: boolean;
  status: "deleted" | "queued";
  deletionJobId?: string;
}> {
  return request(`/api/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
}

export function resolvePlatformConversation(installationId: string): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/conversation`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function createNewPlatformConversation(installationId: string): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/conversation/new`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function clearPlatformConversations(installationId: string): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/conversations/clear`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getKasiAiHome(installationId: string): Promise<KasiAiHome> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/kasiai/home`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function updateKasiAiPreferences(installationId: string, preferences: {
  language?: string;
  tone?: "concise" | "balanced" | "detailed";
  responseDetail?: "concise" | "standard" | "detailed";
  notificationsEnabled?: boolean;
  useSavedPreferences?: boolean;
  referencePreviousChats?: boolean;
  defaultModelProvider?: KasiAiModel["provider"];
  defaultModel?: string;
  defaultCredentialReference?: string | null;
}): Promise<{ preferences: KasiAiPreferences }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/kasiai/preferences`, {
    method: "PATCH",
    body: JSON.stringify(preferences),
  });
}

export function updateKasiAiConversation(conversationId: string, body: {
  title?: string;
  pinned?: boolean;
  modelProvider?: KasiAiModel["provider"] | null;
  model?: string | null;
  clearModel?: boolean;
}): Promise<AgentConversation> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function setKasiAiChannelDefault(conversationId: string): Promise<AgentConversation> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/channel-default`, { method: "POST", body: JSON.stringify({}) });
}

export function setKasiAiConversationStatus(conversationId: string, status: "archived" | "deleted"): Promise<AgentConversation> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/status/${status}`, { method: "POST", body: JSON.stringify({}) });
}

export function restoreKasiAiConversation(conversationId: string): Promise<AgentConversation> {
  return request(`/api/agents/conversations/${encodeURIComponent(conversationId)}/restore`, { method: "POST", body: JSON.stringify({}) });
}

export function createPlatformConversation(
  installationId: string,
  input: { modelProvider?: KasiAiModel["provider"]; model?: string } = {},
): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/conversation/new`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function listAgentConversations(installationId: string, options: { kind?: "customer" | "test"; search?: string; status?: "active" | "archived" | "deleted" } = {}): Promise<{ mode?: string; conversations: AgentConversation[] }> {
  const query = new URLSearchParams();
  if (options.kind) query.set("kind", options.kind);
  if (options.search) query.set("search", options.search);
  if (options.status) query.set("status", options.status);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/conversations${suffix}`);
}

export function listKasiAiChannels(installationId: string): Promise<{ connections: AgentChannelConnection[]; bindings: AgentChannelBinding[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/channels`);
}

export function listAgentWebsiteDeployments(installationId: string): Promise<{ deployments: AgentWebsiteDeployment[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/website-deployments`);
}

export function createAgentWebsiteDeployment(installationId: string, input: {
  allowedOrigins?: string[];
  displayName?: string;
  welcomeText?: string;
  launcherPosition?: "bottom-right" | "bottom-left";
  colorPreset?: string;
  avatarUrl?: string;
  privacyPolicyUrl?: string;
  appearance?: Partial<AgentWebsiteDeployment["appearance"]>;
}): Promise<{ deployment: AgentWebsiteDeployment; embedCode: string; shareUrl: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/website-deployments`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAgentWebsiteDeployment(installationId: string, deploymentId: string, input: {
  allowedOrigins?: string[];
  displayName?: string;
  welcomeText?: string;
  launcherPosition?: "bottom-right" | "bottom-left";
  colorPreset?: string;
  avatarUrl?: string;
  privacyPolicyUrl?: string;
  appearance?: Partial<AgentWebsiteDeployment["appearance"]>;
}): Promise<{ deployment: AgentWebsiteDeployment }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/website-deployments/${encodeURIComponent(deploymentId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function setAgentWebsiteDeploymentStatus(installationId: string, deploymentId: string, status: "ACTIVE" | "PAUSED" | "REVOKED"): Promise<{ deployment: AgentWebsiteDeployment }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/website-deployments/${encodeURIComponent(deploymentId)}/status/${status}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function createAgentChannelConnection(installationId: string, input: { channelType: string; channelKey?: string; credentialReference?: string; credentialSecret?: string; metadata?: Record<string, unknown> }): Promise<AgentChannelConnection> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/channels`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateAgentChannelAllowedUsers(installationId: string, connectionId: string, allowedUsers: string[]): Promise<AgentChannelConnection> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/channels/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ allowedUsers }),
  });
}

export function updateAgentChannelAllowedPhones(installationId: string, connectionId: string, allowedPhones: string[]): Promise<AgentChannelConnection> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/channels/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ allowedPhones }),
  });
}

export function revokeAgentChannelConnection(installationId: string, connectionId: string): Promise<{ disconnected: boolean }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/channels/${encodeURIComponent(connectionId)}`, { method: "DELETE" });
}

export function issueAgentChannelPairing(installationId: string, connectionId: string): Promise<{ token: string; expires_at: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/channels/${encodeURIComponent(connectionId)}/pairing`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function disconnectKasiAiChannel(bindingId: string): Promise<{ disconnected: boolean }> {
  return request(`/api/agents/channel-bindings/${encodeURIComponent(bindingId)}`, { method: "DELETE" });
}

export function issueKasiAiWhatsappPairing(connectionId: string): Promise<{
  installationId: string;
  pairing: { token: string; expires_at: string };
  instruction: string;
}> {
  return request("/api/agents/kasiai/channels/whatsapp/pairing", {
    method: "POST",
    body: JSON.stringify({ connectionId }),
  });
}

export function listWhatsappConnectionOptions(): Promise<{ connections: WhatsappConnectionOption[] }> {
  return request("/api/whatsapp/connections");
}

export function sendPlatformMessage(
  installationId: string,
  body: { message: string; idempotencyKey: string; conversationId?: string; createNew?: boolean; modelProvider?: KasiAiModel["provider"]; model?: string; context?: { route?: string; pageTitle?: string } },
): Promise<{ conversation: AgentConversation; message: AgentMessage; runId: string; status: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export type AgentUiInteractionInput = {
  conversationId: string;
  messageId: string;
  blockId: string;
  actionId: string;
  idempotencyKey: string;
  values?: Record<string, unknown>;
  context?: { route?: string; pageTitle?: string };
};

export function submitAgentUiInteraction(
  installationId: string,
  body: AgentUiInteractionInput,
): Promise<{ kind: "run"; actionId: string; blockId: string; conversation: AgentConversation; message: AgentMessage; runId: string; status: string; created: boolean; durable: boolean }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/ui-interactions`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function sendPlatformAudio(
  installationId: string,
  input: { file: File; conversationId: string; idempotencyKey: string; caption?: string; context?: { route?: string; pageTitle?: string } },
): Promise<{ jobId: string; status: string; assetId: string; created: boolean; durable: boolean }> {
  const headers = new Headers({
    "content-type": input.file.type || "application/octet-stream",
    "x-audio-idempotency-key": input.idempotencyKey,
    "x-audio-conversation-id": input.conversationId,
    "x-audio-file-name": encodeURIComponent(input.file.name),
  });
  if (input.caption?.trim()) headers.set("x-audio-caption", input.caption.trim());
  if (input.context?.route) headers.set("x-audio-context-route", input.context.route);
  if (input.context?.pageTitle) headers.set("x-audio-context-title", input.context.pageTitle);
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/audio`, {
    method: "POST",
    headers,
    body: input.file,
  });
}

export type AudioTranscriptionJob = {
  jobId: string;
  status: "queued" | "processing" | "dispatching" | "completed" | "retryable_failed" | "failed" | "deleted";
  assetId: string;
  transcript?: string;
  languageCode?: string;
  conversationId?: string;
  messageId?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
  runId?: string;
};

export function getAudioTranscriptionJob(jobId: string): Promise<AudioTranscriptionJob> {
  return request(`/api/agents/audio/transcription-jobs/${encodeURIComponent(jobId)}`);
}

export function retryAudioTranscription(jobId: string): Promise<{ jobId: string; status: string; assetId: string; created: boolean; durable: boolean }> {
  return request(`/api/agents/audio/transcription-jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function getPlatformConversation(conversationId: string, options: { limit?: number; before?: string } = {}): Promise<ConversationResponse> {
  const query = new URLSearchParams();
  if (options.limit) query.set("limit", String(options.limit));
  if (options.before) query.set("before", options.before);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return request<ConversationResponse>(`/api/agents/conversations/${encodeURIComponent(conversationId)}${suffix}`);
}

export function cancelAgentRun(runId: string, reason = "Stopped by user"): Promise<{ runId: string; status: string }> {
  return request(`/api/agents/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function retryAgentRun(runId: string): Promise<{ conversation: AgentConversation; message: AgentMessage; runId: string; status: string; created?: boolean; durable?: boolean }> {
  return request(`/api/agents/runs/${encodeURIComponent(runId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function signalAgentRunExternalEvent(runId: string, input: { key: string; payload?: Record<string, unknown> }): Promise<{ runId: string; status: string; key: string }> {
  return request(`/api/agents/runs/${encodeURIComponent(runId)}/external-event`, {
    method: "POST",
    body: JSON.stringify({ key: input.key, payload: input.payload ?? {} }),
  });
}

export type AgentStreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

export type AgentStreamResult = { lastSequence: number; terminal: boolean };

export async function streamAgentRun(
  runId: string,
  onEvent: (event: AgentStreamEvent) => void,
  signal: AbortSignal,
  after = 0,
): Promise<AgentStreamResult> {
  const query = after > 0 ? `?after=${after}` : "";
  const response = await fetch(apiUrl(`/api/agents/runs/${encodeURIComponent(runId)}/events/stream${query}`), {
    credentials: "include",
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) {
    throw new AgentRequestError(`Agent stream failed (${response.status})`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let lastSequence = after;
  let terminal = false;
  let dataLines: string[] = [];
  const flush = () => {
    if (!dataLines.length) return;
    try {
      const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      const sequence = Number(data.sequence_number);
      if (Number.isSafeInteger(sequence) && sequence > lastSequence) lastSequence = sequence;
      if (["run.completed", "run.failed", "run.cancelled", "run.expired"].includes(eventName)) terminal = true;
      onEvent({ event: eventName, data });
    } catch {
      // Ignore keep-alives and malformed intermediary chunks; the durable run is authoritative.
    }
    eventName = "message";
    dataLines = [];
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line === "") {
        flush();
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (chunk.done) {
      if (buffer.trim()) dataLines.push(buffer.trim());
      flush();
      return { lastSequence, terminal };
    }
  }
}

/** Organization-level conversation changes used by operator queues. */
export async function streamAgentConversationFeed(
  onEvent: (event: AgentStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(apiUrl("/api/agents/conversations/events/stream"), {
    credentials: "include",
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) {
    throw new AgentRequestError(`Conversation feed failed (${response.status})`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  const flush = () => {
    if (!dataLines.length) return;
    try {
      onEvent({ event: eventName, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
    } catch {
      // Ignore keep-alives and malformed intermediary chunks.
    }
    eventName = "message";
    dataLines = [];
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line === "") flush();
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (chunk.done) {
      if (buffer.trim()) dataLines.push(buffer.trim());
      flush();
      return;
    }
  }
}

export async function streamAgentConversation(
  conversationId: string,
  onEvent: (event: AgentStreamEvent) => void,
  signal: AbortSignal,
  after = 0,
): Promise<number> {
  const query = after > 0 ? `?after=${after}` : "";
  const response = await fetch(apiUrl(`/api/agents/conversations/${encodeURIComponent(conversationId)}/events/stream${query}`), {
    credentials: "include",
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok || !response.body) {
    throw new AgentRequestError(`Conversation stream failed (${response.status})`, response.status);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let lastSequence = after;
  let dataLines: string[] = [];
  const flush = () => {
    if (!dataLines.length) return;
    try {
      const data = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      const sequence = Number(data.sequence_number);
      if (Number.isSafeInteger(sequence) && sequence > lastSequence) lastSequence = sequence;
      onEvent({ event: eventName, data });
    } catch {
      // Ignore keep-alives and malformed intermediary chunks.
    }
    eventName = "message";
    dataLines = [];
  };
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !chunk.done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line === "") flush();
      else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (chunk.done) {
      flush();
      return lastSequence;
    }
  }
}
