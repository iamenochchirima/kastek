import { apiUrl } from "@/lib/server-api";

export type DeveloperApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  status: "ACTIVE" | "REVOKED" | "EXPIRED" | string;
  createdById: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DeveloperClient = {
  id: "claude" | "chatgpt" | "claude-code" | "cursor" | "other" | string;
  label: string;
};

export type DevelopersConfig = {
  restBaseUrl: string;
  mcpEndpoint: string;
  mcpPackage: string;
  clients: DeveloperClient[];
};

export type DevelopersBootstrap = {
  apiKeys: DeveloperApiKey[];
  config: DevelopersConfig;
};

export const fallbackDevelopersConfig: DevelopersConfig = {
  restBaseUrl: "http://localhost:8080/v1",
  mcpEndpoint: "http://127.0.0.1:4200/mcp",
  mcpPackage: "@kasitek/mcp",
  clients: [
    { id: "claude", label: "Claude" },
    { id: "chatgpt", label: "ChatGPT" },
    { id: "claude-code", label: "Claude Code" },
    { id: "cursor", label: "Cursor" },
    { id: "other", label: "Other MCP client" },
  ],
};

export type CreatedDeveloperApiKey = {
  key: DeveloperApiKey;
  secret: string;
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
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : "Developer request failed");
  }
  return body as T;
}

export function createDeveloperApiKey(name: string): Promise<CreatedDeveloperApiKey> {
  return request<CreatedDeveloperApiKey>("/api/developers/api-keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export function revokeDeveloperApiKey(id: string): Promise<void> {
  return request<void>(`/api/developers/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function rotateDeveloperApiKey(id: string): Promise<CreatedDeveloperApiKey> {
  return request<CreatedDeveloperApiKey>(`/api/developers/api-keys/${encodeURIComponent(id)}/rotate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
