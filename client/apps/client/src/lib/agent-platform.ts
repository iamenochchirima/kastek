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
  status: string;
  output?: { message?: string; [key: string]: unknown } | null;
  error?: { message?: string; [key: string]: unknown } | null;
};

export function getAgentRun(runId: string): Promise<{ run: AgentRun; events: AgentStreamEvent[] }> {
  return request(`/api/agents/runs/${encodeURIComponent(runId)}`);
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
  status: string;
  protected: boolean;
  owner_type: string;
  created_at: string;
  installation_id?: string | null;
  installation_status?: string | null;
  installation_settings?: Record<string, unknown> | null;
  version_number?: number | null;
};

export function listAgents(): Promise<{ agents: AgentDefinition[] }> {
  return request<{ agents: AgentDefinition[] }>("/api/agents");
}

export type AgentTemplate = {
  key: string;
  version: number;
  name: string;
  description: string;
  requiredConnections: string[];
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
