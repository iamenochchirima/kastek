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
};

export type AgentConversation = {
  id: string;
  installation_id: string;
  organization_id: string;
  channel_type: string;
  channel_key: string;
  status: string;
  updated_at: string;
};

export type AgentRun = {
  id: string;
  status: string;
  output?: { message?: string; [key: string]: unknown } | null;
  error?: { message?: string; [key: string]: unknown } | null;
};

type ConversationResponse = {
  conversation: AgentConversation;
  messages: AgentMessage[];
  hasMore?: boolean;
  nextBefore?: string | null;
};

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
    try {
      const body = (await response.json()) as { error?: string };
      detail = body.error ? `: ${body.error}` : "";
    } catch {
      // Keep the status-only error when the proxy returned a non-JSON response.
    }
    throw new Error(`Agent request failed (${response.status})${detail}`);
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

export function createPlatformConversation(installationId: string): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/conversation/new`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function sendPlatformMessage(
  installationId: string,
  body: { message: string; idempotencyKey: string; context?: { route?: string; pageTitle?: string } },
): Promise<{ conversation: AgentConversation; message: AgentMessage; runId: string; status: string }> {
  return request(`/api/agents/installations/${encodeURIComponent(installationId)}/platform/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getPlatformConversation(conversationId: string): Promise<ConversationResponse> {
  return request<ConversationResponse>(`/api/agents/conversations/${encodeURIComponent(conversationId)}`);
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
    throw new Error(`Agent stream failed (${response.status})`);
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
