import { createHash, randomBytes } from "node:crypto";
import { resolveRemoteMcpEndpoint } from "./remote";

const MAX_METADATA_BYTES = 128_000;

export interface McpOAuthDiscovery {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported: string[];
}

export interface McpOAuthClient {
  clientId: string;
  clientSecret?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
  scope?: string;
}

export interface McpOAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  scope?: string;
  clientId: string;
  clientSecret?: string;
}

export function createPkcePair(): { state: string; codeVerifier: string; codeChallenge: string } {
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { state, codeVerifier, codeChallenge };
}

export async function discoverMcpOAuth(input: {
  endpointUrl: string;
  environment?: "development" | "test" | "production";
  signal?: AbortSignal;
}): Promise<McpOAuthDiscovery> {
  const endpoint = await resolveRemoteMcpEndpoint(input.endpointUrl, input.environment ?? "production");
  const resourceMetadata = await fetchProtectedResourceMetadata(endpoint, input);
  const resource = typeof resourceMetadata?.resource === "string" && resourceMetadata.resource.trim()
    ? resourceMetadata.resource
    : endpoint.toString();
  const authorizationServers = Array.isArray(resourceMetadata?.authorization_servers)
    ? resourceMetadata.authorization_servers.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const issuer = authorizationServers[0] ?? endpoint.origin;
  const authorizationMetadata = await fetchAuthorizationServerMetadata(issuer, input);
  const authorizationEndpoint = stringValue(authorizationMetadata.authorization_endpoint);
  const tokenEndpoint = stringValue(authorizationMetadata.token_endpoint);
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error("MCP_OAUTH_METADATA_INCOMPLETE");
  return {
    resource,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: stringValue(authorizationMetadata.registration_endpoint) ?? undefined,
    scopesSupported: stringArray(authorizationMetadata.scopes_supported),
  };
}

export async function registerMcpOAuthClient(input: {
  discovery: McpOAuthDiscovery;
  redirectUri: string;
  clientName: string;
  environment?: "development" | "test" | "production";
  signal?: AbortSignal;
}): Promise<McpOAuthClient> {
  if (!input.discovery.registrationEndpoint) throw new Error("MCP_OAUTH_CLIENT_REGISTRATION_UNSUPPORTED");
  await resolveRemoteMcpEndpoint(input.discovery.registrationEndpoint, input.environment ?? "production");
  const response = await fetch(input.discovery.registrationEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: combinedSignal(input.signal),
    redirect: "error",
  });
  const body = await readJson(response);
  if (!response.ok) throw new Error("MCP_OAUTH_CLIENT_REGISTRATION_FAILED");
  const clientId = stringValue(body.client_id);
  if (!clientId) throw new Error("MCP_OAUTH_CLIENT_ID_MISSING");
  return {
    clientId,
    clientSecret: stringValue(body.client_secret) ?? undefined,
    authorizationEndpoint: input.discovery.authorizationEndpoint,
    tokenEndpoint: input.discovery.tokenEndpoint,
    resource: input.discovery.resource,
    scope: input.discovery.scopesSupported.length ? input.discovery.scopesSupported.join(" ") : undefined,
  };
}

export function buildMcpAuthorizationUrl(input: {
  client: McpOAuthClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(input.client.authorizationEndpoint);
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.client.resource) url.searchParams.set("resource", input.client.resource);
  if (input.client.scope) url.searchParams.set("scope", input.client.scope);
  return url.toString();
}

export async function exchangeMcpOAuthCode(input: {
  client: McpOAuthClient;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  environment?: "development" | "test" | "production";
  signal?: AbortSignal;
}): Promise<McpOAuthToken> {
  await resolveRemoteMcpEndpoint(input.client.tokenEndpoint, input.environment ?? "production");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.client.clientId,
    code_verifier: input.codeVerifier,
  });
  if (input.client.clientSecret) body.set("client_secret", input.client.clientSecret);
  const response = await fetch(input.client.tokenEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: combinedSignal(input.signal),
    redirect: "error",
  });
  const token = await readJson(response);
  if (!response.ok) throw new Error("MCP_OAUTH_TOKEN_EXCHANGE_FAILED");
  const accessToken = stringValue(token.access_token);
  if (!accessToken) throw new Error("MCP_OAUTH_ACCESS_TOKEN_MISSING");
  const expiresIn = numberValue(token.expires_in);
  return {
    accessToken,
    refreshToken: stringValue(token.refresh_token) ?? undefined,
    tokenType: stringValue(token.token_type) ?? undefined,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1_000).toISOString() : undefined,
    scope: stringValue(token.scope) ?? input.client.scope,
    clientId: input.client.clientId,
    clientSecret: input.client.clientSecret,
  };
}

async function fetchProtectedResourceMetadata(endpoint: URL, input: { environment?: "development" | "test" | "production"; signal?: AbortSignal }): Promise<Record<string, unknown> | null> {
  const candidates = [
    new URL(`/.well-known/oauth-protected-resource${endpoint.pathname}`, endpoint.origin),
    new URL("/.well-known/oauth-protected-resource", endpoint.origin),
  ];
  for (const url of uniqueUrls(candidates)) {
    const response = await fetchMetadata(url, input);
    if (response) return response;
  }
  // Some MCP servers advertise RFC 9728 only from the protected resource
  // response. A bounded GET is enough to read that challenge without sending
  // an MCP request or forwarding credentials.
  await resolveRemoteMcpEndpoint(endpoint.toString(), input.environment ?? "production");
  const response = await fetch(endpoint, { headers: { accept: "application/json" }, signal: combinedSignal(input.signal), redirect: "error" });
  const header = response.headers.get("www-authenticate");
  const metadataUrl = header ? parseResourceMetadataUrl(header) : undefined;
  if (metadataUrl) {
    await resolveRemoteMcpEndpoint(metadataUrl, input.environment ?? "production");
    return fetchMetadata(new URL(metadataUrl), input);
  }
  return null;
}

function parseResourceMetadataUrl(header: string): string | undefined {
  const match = /resource_metadata\s*=\s*(?:"([^"]+)"|([^,\s]+))/i.exec(header);
  const value = (match?.[1] ?? match?.[2])?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function fetchAuthorizationServerMetadata(issuer: string, input: { environment?: "development" | "test" | "production"; signal?: AbortSignal }): Promise<Record<string, unknown>> {
  const issuerUrl = await resolveRemoteMcpEndpoint(issuer, input.environment ?? "production");
  const candidates = [
    new URL("/.well-known/oauth-authorization-server", issuerUrl.origin),
    new URL("/.well-known/openid-configuration", issuerUrl.origin),
  ];
  for (const url of uniqueUrls(candidates)) {
    const response = await fetchMetadata(url, input);
    if (response) return response;
  }
  throw new Error("MCP_OAUTH_AUTHORIZATION_SERVER_METADATA_MISSING");
}

async function fetchMetadata(url: URL, input: { environment?: "development" | "test" | "production"; signal?: AbortSignal }): Promise<Record<string, unknown> | null> {
  await resolveRemoteMcpEndpoint(url.toString(), input.environment ?? "production");
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: combinedSignal(input.signal), redirect: "error" });
  if (response.status === 404 || response.status === 405) return null;
  const body = await readJson(response);
  if (!response.ok || !body || Array.isArray(body)) return null;
  return body;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_METADATA_BYTES) throw new Error("MCP_OAUTH_METADATA_TOO_LARGE");
  const raw = await response.text();
  if (raw.length > MAX_METADATA_BYTES) throw new Error("MCP_OAUTH_METADATA_TOO_LARGE");
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

function uniqueUrls(urls: URL[]): URL[] {
  const seen = new Set<string>();
  return urls.filter((url) => {
    const value = url.toString();
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
