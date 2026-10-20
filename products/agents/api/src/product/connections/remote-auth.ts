import { auth, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PlatformError } from "../../contracts/contracts";
import { createBoundedFetch, publicAddress } from "../../infrastructure/connected-network";

export interface RemoteAuthorization {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  state?: string;
  authorizationUrl?: string;
  issuedAt?: number;
  ownClientIssuer?: string;
}
export interface RemoteAuthOptions {
  endpoint: string;
  callbackUrl: string;
  clientMetadataUrl?: string;
  clientName?: string;
  testLoopback?: boolean;
}
const failure = (code: string, message: string) => new PlatformError(code, 400, message);

export function remoteEndpoint(value: string, testLoopback = false): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw failure("MCP_URL_INVALID", "Enter a valid MCP server URL"); }
  const local = testLoopback && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!local && (url.protocol !== "https:" || url.port && url.port !== "443")) || url.username || url.password || url.hash || value.length > 2048)
    throw failure("MCP_URL_INVALID", "Use an HTTPS server URL without credentials or a fragment");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!local && (host === "localhost" || isIP(host) && !publicAddress(host)))
    throw failure("MCP_DESTINATION_DENIED", "The server must have a public address");
  return url;
}

async function publicRedirect(value: URL, testLoopback = false): Promise<void> {
  remoteEndpoint(value.href, testLoopback);
  if (testLoopback && value.protocol === "http:") return;
  const addresses = await lookup(value.hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true });
  if (!addresses.length || addresses.some(address => !publicAddress(address.address)))
    throw failure("MCP_DESTINATION_DENIED", "The authorization server must have a public address");
}

/** Only trusted SDK requests use this transport. No headers or bodies come from model output. */
export function remoteAuthFetch(testLoopback = false, deadlineAt = Date.now() + 30000): typeof fetch {
  let requests = 0;
  return async (input, init = {}) => {
    if (++requests > 16) throw failure("OAUTH_REQUEST_LIMIT", "Authorization made too many requests");
    if (input instanceof Request) throw failure("OAUTH_REQUEST_INVALID", "Unsupported authorization request");
    const target = remoteEndpoint(String(input), testLoopback);
    const headers = Object.fromEntries(new Headers(init.headers));
    const body = init.body instanceof URLSearchParams ? init.body.toString() : init.body;
    return createBoundedFetch({ authorizeUrl: candidate => candidate.href === target.href,
      headers, maxRequestBytes: 32768, maxResponseBytes: 262144, maxRequests: 1, maxAttempts: 1,
      deadlineAt, testLoopback, returnAuthenticationResponses: true })(target, { ...init, body, redirect: "error" });
  };
}

export function remoteAuthProvider(options: RemoteAuthOptions, data: RemoteAuthorization): OAuthClientProvider {
  return {
    redirectUrl: options.callbackUrl,
    ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
    clientMetadata: { client_name: options.clientName ?? "Kasitek Agents", redirect_uris: [options.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    state: () => { if (!data.state) throw failure("OAUTH_STATE_REQUIRED", "Restart sign in"); return data.state; },
    clientInformation: ctx => {
      if(ctx && data.ownClientIssuer && data.ownClientIssuer!==ctx.issuer)throw failure("OAUTH_ISSUER_CHANGED","The authorization server differs from the configured client issuer");
      return !ctx || !data.client?.issuer || data.client.issuer===ctx.issuer ? data.client : undefined;
    },
    saveClientInformation: (client, ctx) => { data.client = { ...client, ...(ctx ? { issuer: ctx.issuer } : {}) }; },
    tokens: ctx => !ctx || !data.tokens?.issuer || data.tokens.issuer === ctx.issuer ? data.tokens : undefined,
    saveTokens: (tokens, ctx) => { data.tokens = { ...tokens, ...(ctx ? { issuer: ctx.issuer } : {}) }; data.issuedAt = Date.now(); },
    saveCodeVerifier: verifier => { data.verifier = verifier; },
    codeVerifier: () => { if (!data.verifier) throw failure("OAUTH_ATTEMPT_EXPIRED", "Restart sign in"); return data.verifier; },
    saveDiscoveryState: discovery => { data.discovery = discovery; },
    discoveryState: () => data.discovery,
    redirectToAuthorization: async url => { await publicRedirect(url, options.testLoopback); data.authorizationUrl = url.href; },
    invalidateCredentials: scope => {
      if (scope === "all" || scope === "client") delete data.client;
      if (scope === "all" || scope === "tokens") delete data.tokens;
      if (scope === "all" || scope === "verifier") delete data.verifier;
      if (scope === "all" || scope === "discovery") delete data.discovery;
    },
  };
}

export async function authorizeRemote(options: RemoteAuthOptions, data: RemoteAuthorization,
  callback?: { code: string; issuer?: string }, forceReauthorization = false): Promise<"AUTHORIZED" | "REDIRECT"> {
  remoteEndpoint(options.endpoint, options.testLoopback);
  delete data.authorizationUrl;
  return auth(remoteAuthProvider(options, data), { serverUrl: options.endpoint,
    fetchFn: remoteAuthFetch(options.testLoopback), forceReauthorization,
    ...(callback ? { authorizationCode: callback.code, iss: callback.issuer } : {}) });
}
