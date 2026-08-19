import { apiUrl } from "@/lib/server-api";

export type AgentInstallation = {
  id: string;
  status: "active" | "paused" | "disabled";
  agent_name?: string;
  agent_slug?: string;
  agent_protected?: boolean;
  settings?: Record<string, unknown>;
};

export type AgentMessage = {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound" | "system";
  message_type: string;
  content: { text?: string; [key: string]: unknown };
  sequence_number: string | number;
  created_at: string;
  run_id?: string | null;
  provider?: string | null;
  provider_message_id?: string | null;
  source_channel?: string;
  source_connection_id?: string | null;
  source_binding_id?: string | null;
  external_conversation_id?: string | null;
  occurred_at?: string;
  delivery_status?: "local" | "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "unknown" | null;
};

export type AgentConversation = {
  id: string;
  installation_id: string;
  organization_id: string;
  channel_type: string;
  channel_key: string;
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
  model_provider?: "openrouter" | "openai" | "anthropic" | "gemini" | null;
  model?: string | null;
  updated_at: string;
};

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
  error?: { message?: string; [key: string]: unknown } | null;
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

export type AgentRunTimeline = {
  run: AgentRun;
  events: AgentOperationEvent[];
  steps: Array<Record<string, unknown>>;
  toolCalls: Array<Record<string, unknown>>;
  effects: Array<Record<string, unknown>>;
};

export type AgentApproval = {
  status: "pending" | "approved" | "denied" | "expired" | "consumed" | "cancelled" | string;
  providerToolCallId: string;
  capability: string;
  argumentsHash: string;
  resourceSnapshot?: Record<string, unknown>;
  previewRevision?: string | null;
  expiresAt: string;
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

export function getAgentRun(runId: string): Promise<{ run: AgentRun; canApprove?: boolean; approval?: AgentApproval | null; events: AgentOperationEvent[] }> {
  return request(`/api/agents/runs/${encodeURIComponent(runId)}`);
}

export function decideAgentRunApproval(runId: string, approval: Pick<AgentApproval, "providerToolCallId" | "argumentsHash">, decision: "approved" | "rejected"): Promise<{ runId: string; status: string }> {
  return request(`/api/agents/runs/${encodeURIComponent(runId)}/approval`, {
    method: "POST",
    body: JSON.stringify({ decision, providerToolCallId: approval.providerToolCallId, argumentsHash: approval.argumentsHash }),
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
  channel_type: string;
  external_identity: string;
  status: string;
};

export type WhatsappConnectionOption = {
  id: string;
  phoneDisplayNumber?: string | null;
  phoneNumberId: string;
};

type ConversationResponse = {
  conversation: AgentConversation;
  messages: AgentMessage[];
  hasMore?: boolean;
  nextBefore?: string | null;
  activeRuns?: Array<{
    id: string;
    conversation_id?: string | null;
    status: string;
    created_at?: string;
    updated_at?: string;
  }>;
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
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
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

export type AgentDefinition = {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  creation_profile?: "general" | "custom" | "system" | null;
  status: string;
  protected: boolean;
  owner_type: string;
  execution_mode?: "system_hosted" | "kasitek_hosted" | "external_connected" | null;
  created_at: string;
  installation_id?: string | null;
  installation_status?: string | null;
  installation_settings?: Record<string, unknown> | null;
  version_number?: number | null;
};

export function listAgents(): Promise<{ agents: AgentDefinition[] }> {
  return request<{ agents: AgentDefinition[] }>("/api/agents");
}

export function createAgent(input: { name: string; slug?: string; description?: string; creationProfile?: "general" | "custom" }): Promise<AgentDefinition> {
  return request("/api/agents", { method: "POST", body: JSON.stringify({ ...input, protected: false }) });
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

export function createAgentVersion(agentId: string, input: { instructions: string; configuration?: Record<string, unknown>; policy?: Record<string, unknown> }): Promise<AgentVersion> {
  return request(`/api/agents/${encodeURIComponent(agentId)}/versions`, { method: "POST", body: JSON.stringify({ configuration: {}, policy: {}, ...input }) });
}

export function createAgentInstallation(agentVersionId: string, settings: Record<string, unknown> = {}): Promise<AgentInstallation> {
  return request("/api/agents/installations", { method: "POST", body: JSON.stringify({ agentVersionId, scopeType: "organization", settings }) });
}

export type AgentTemplate = {
  key: string;
  version: number;
  profile: "custom";
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
};

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

export function createAgentKnowledgeSource(input: { agentId: string; installationId?: string; name: string; sourceType: "url" | "manual" | "platform" | "upload"; sourceUri?: string }): Promise<AgentKnowledgeSource> {
  return request("/api/agents/knowledge/sources", { method: "POST", body: JSON.stringify(input) });
}

export function ingestAgentKnowledgeSourceUrl(sourceId: string, url: string): Promise<{ sourceId: string; revision: number; chunks: unknown[] }> {
  return request(`/api/agents/knowledge/sources/${encodeURIComponent(sourceId)}/ingest-url`, { method: "POST", body: JSON.stringify({ url }) });
}

export function deleteAgentKnowledgeSource(sourceId: string, agentId: string, installationId?: string): Promise<unknown> {
  return request(`/api/agents/knowledge/sources/${encodeURIComponent(sourceId)}`, { method: "DELETE", body: JSON.stringify({ agentId, ...(installationId ? { installationId } : {}) }) });
}

export function listAgentMemory(agentId: string, installationId?: string): Promise<{ memories: AgentMemory[] }> {
  const query = new URLSearchParams({ agentId });
  if (installationId) query.set("installationId", installationId);
  return request(`/api/agents/memory?${query.toString()}`);
}

export function deleteAgentMemory(memoryId: string, agentId: string, installationId?: string): Promise<unknown> {
  return request(`/api/agents/memory/${encodeURIComponent(memoryId)}`, { method: "DELETE", body: JSON.stringify({ agentId, ...(installationId ? { installationId } : {}) }) });
}

export function revalidateAgentMemory(memoryId: string, agentId: string, installationId?: string, expiresAt: string | null = null): Promise<AgentMemory> {
  return request(`/api/agents/memory/${encodeURIComponent(memoryId)}/revalidate`, { method: "POST", body: JSON.stringify({ agentId, ...(installationId ? { installationId } : {}), expiresAt }) });
}

export type AgentInstallationSettings = {
  language?: string;
  tone?: "concise" | "balanced" | "detailed";
  responseDetail?: "concise" | "standard" | "detailed";
  notificationsEnabled?: boolean;
};

export type KasiAiModel = {
  provider: "openrouter" | "openai" | "anthropic" | "gemini";
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
  default_model_provider?: "openrouter" | "openai" | "anthropic" | "gemini" | null;
  default_model?: string | null;
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

export function resolvePlatformConversation(installationId: string): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/conversation`, {
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

export function createPlatformConversation(installationId: string): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/conversation/new`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function listAgentConversations(installationId: string): Promise<{ conversations: AgentConversation[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/conversations`);
}

export function listKasiAiChannels(installationId: string): Promise<{ connections: AgentChannelConnection[]; bindings: AgentChannelBinding[] }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/channels`);
}

export function createAgentChannelConnection(installationId: string, input: { channelType: string; channelKey: string; credentialReference?: string; metadata?: Record<string, unknown> }): Promise<AgentChannelConnection> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/channels`, {
    method: "POST",
    body: JSON.stringify(input),
  });
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
