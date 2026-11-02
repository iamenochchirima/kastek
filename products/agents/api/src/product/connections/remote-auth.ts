import { auth, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { PlatformError } from "../../contracts/contracts";
import { createBoundedFetch, publicAddress } from "../../infrastructure/connected-network";
import {z} from "zod";

export interface RemoteAuthorization {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
  verifier?: string;
  state?: string;
  authorizationUrl?: string;
  issuedAt?: number;
  ownClientIssuer?: string;
  resource?: string;
  requestedScope?: string;
  stepUp?: boolean;
}
export interface RemoteAuthOptions {
  endpoint: string;
  callbackUrl: string;
  clientMetadataUrl?: string;
  clientName?: string;
  testLoopback?: boolean;
  preRegisteredClients?:readonly {issuer:string;clientId:string;clientSecret?:string;authMethod?:"none"|"client_secret_basic"|"client_secret_post"}[];
}
export interface RemoteScopeChallenge {resource:string;requiredScope:string}
function scopes(value:string):string[] {
  if(Buffer.byteLength(value)>2048||!/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(value))throw failure("OAUTH_SCOPE_INVALID","The server requested unsupported permissions");
  const result=[...new Set(value.split(" "))];if(result.length>32)throw failure("OAUTH_SCOPE_INVALID","The server requested too many permissions");return result;
}
const failure = (code: string, message: string) => new PlatformError(code, 400, message);

/** Operator metadata refers to environment-held credentials; API/model input never selects a client. */
export function remoteAuthOptionsFromEnvironment(env:NodeJS.ProcessEnv=process.env):Pick<RemoteAuthOptions,"preRegisteredClients"|"clientMetadataUrl"> {
  const result:Pick<RemoteAuthOptions,"preRegisteredClients"|"clientMetadataUrl">={};
  if(env.AGENTS_MCP_CLIENT_METADATA_URL){const url=remoteEndpoint(env.AGENTS_MCP_CLIENT_METADATA_URL);if(url.pathname==="/"||url.search)throw failure("OAUTH_CONFIGURATION_INVALID","Client metadata needs a fixed HTTPS document URL");result.clientMetadataUrl=url.href;}
  if(!env.AGENTS_MCP_OAUTH_CLIENTS)return result;
  try{
    if(Buffer.byteLength(env.AGENTS_MCP_OAUTH_CLIENTS)>16384)throw Error();
    const reference=z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
    const records=z.array(z.strictObject({issuer:z.string().max(2048),clientIdEnvironment:reference,clientSecretEnvironment:reference.optional(),authMethod:z.enum(["none","client_secret_basic","client_secret_post"]).default("none")})).max(16).parse(JSON.parse(env.AGENTS_MCP_OAUTH_CLIENTS));
    const issuers=new Set<string>();
    result.preRegisteredClients=records.map(record=>{
      const url=remoteEndpoint(record.issuer);if(url.search||issuers.has(record.issuer))throw Error();issuers.add(record.issuer);
      const clientId=env[record.clientIdEnvironment],clientSecret=record.clientSecretEnvironment?env[record.clientSecretEnvironment]:undefined;
      if(!clientId||clientId.length>2048||record.clientSecretEnvironment&&!clientSecret||clientSecret&&clientSecret.length>4096||record.authMethod!=="none"&&!clientSecret)throw Error();
      return {issuer:record.issuer,clientId,...(clientSecret?{clientSecret}:{}),authMethod:record.authMethod};
    });return result;
  }catch{throw failure("OAUTH_CONFIGURATION_INVALID","OAuth client references are invalid or missing environment values");}
}

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
    const response=await createBoundedFetch({ authorizeUrl: candidate => candidate.href === target.href,
      headers, maxRequestBytes: 32768, maxResponseBytes: 262144, maxRequests: 1, maxAttempts: 1,
      deadlineAt, testLoopback, returnAuthenticationResponses: true })(target, { ...init, body, redirect: "error" });
    // The SDK logs OAuth error messages during refresh recovery. Provider bodies must not reach that logger.
    let json:unknown;
    try{json=JSON.parse(await response.text());}catch{if(response.status<400)throw failure("OAUTH_RESPONSE_INVALID","OAuth provider returned invalid JSON");}
    const tokenRequest=typeof body==="string"&&new URLSearchParams(body).has("grant_type");
    const providerError=json&&typeof json==="object"&&!Array.isArray(json)&&"error" in json;
    const safeHeaders=new Headers(response.headers);safeHeaders.delete("content-length");safeHeaders.set("content-type","application/json");
    const wrap=(value:unknown,status=response.status)=>{const safe=new Response(JSON.stringify(value),{status,headers:safeHeaders});Object.defineProperty(safe,"url",{value:response.url});return safe;};
    if(response.status>=400||tokenRequest&&providerError){
      const codes=new Set(["invalid_request","invalid_client","invalid_grant","unauthorized_client","unsupported_grant_type","invalid_scope","access_denied","server_error","temporarily_unavailable"]);
      const value=json as {error?:unknown}|undefined,code=typeof value?.error==="string"&&codes.has(value.error)?value.error:"server_error";
      return wrap({error:code},response.status>=400?response.status:400);
    }
    if(tokenRequest&&!z.object({access_token:z.string().min(1).max(8192),id_token:z.string().max(65536).optional(),token_type:z.string().regex(/^Bearer$/i),refresh_token:z.string().min(1).max(8192).optional(),expires_in:z.number().int().min(0).max(31536000).optional(),scope:z.string().max(2048).optional()}).safeParse(json).success)throw failure("OAUTH_RESPONSE_INVALID","OAuth provider returned invalid token data");
    return wrap(json);
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
      if(!ctx)return data.client;
      if(data.ownClientIssuer)return data.client;
      const configured=options.preRegisteredClients?.filter(client=>client.issuer===ctx.issuer)??[];
      if(configured.length>1)throw failure("OAUTH_CLIENT_INVALID","Multiple clients are configured for this issuer");
      const client=configured[0];if(!client)return !data.client?.issuer||data.client.issuer===ctx.issuer?data.client:undefined;
      remoteEndpoint(client.issuer,options.testLoopback);
      const method=client.authMethod??"none";
      if(!client.clientId||client.clientId.length>2048||client.clientSecret&&client.clientSecret.length>4096||method!=="none"&&!client.clientSecret)throw failure("OAUTH_CLIENT_INVALID","The configured OAuth client is invalid");
      if(data.client?.issuer===ctx.issuer&&data.client.client_id!==client.clientId&&(data.tokens||data.verifier))throw failure("OAUTH_CLIENT_CHANGED","The OAuth client changed; start a new authorization attempt");
      const selected={client_id:client.clientId,...(client.clientSecret?{client_secret:client.clientSecret}:{}),token_endpoint_auth_method:method,issuer:ctx.issuer};
      data.client=selected;return selected;
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
  const resource=remoteEndpoint(options.endpoint, options.testLoopback).href;
  if(data.resource&&data.resource!==resource)throw failure("OAUTH_RESOURCE_CHANGED","Authorization belongs to another server resource");
  if(options.preRegisteredClients&&options.preRegisteredClients.length>16)throw failure("OAUTH_CLIENT_INVALID","Too many OAuth clients are configured");
  data.resource=resource;
  delete data.authorizationUrl;
  const result=await auth(remoteAuthProvider(options, data), { serverUrl: options.endpoint,
    fetchFn: remoteAuthFetch(options.testLoopback), forceReauthorization,
    ...(data.requestedScope?{scope:scopes(data.requestedScope).join(" ")} : {}),
    ...(callback ? { authorizationCode: callback.code, iss: callback.issuer } : {}) });
  if(result==="AUTHORIZED"&&data.requestedScope&&data.tokens){
    const granted=data.tokens.scope===undefined?scopes(data.requestedScope):scopes(data.tokens.scope);
    if(scopes(data.requestedScope).some(scope=>!granted.includes(scope)))throw failure("OAUTH_SCOPE_DENIED","The requested permissions were not granted");
    if(data.tokens.scope===undefined)data.tokens.scope=data.requestedScope;
  }
  return result;
}

/** Only an observed resource-server challenge enters this flow; it never retries a tool. */
export async function beginRemotePermissionStepUp(options:RemoteAuthOptions,data:RemoteAuthorization,challenge:RemoteScopeChallenge):Promise<"AUTHORIZED"|"REDIRECT"> {
  if(challenge.resource!==remoteEndpoint(options.endpoint,options.testLoopback).href||!data.tokens)throw failure("OAUTH_RESOURCE_CHANGED","Permission request belongs to another server resource");
  const current=data.tokens.scope?scopes(data.tokens.scope):[],required=scopes(challenge.requiredScope),union=[...new Set([...current,...required])];
  if(union.length>32||!required.some(scope=>!current.includes(scope)))throw failure("OAUTH_STEP_UP_REPEATED","Reconnect to review the server permissions");
  data.requestedScope=scopes(union.join(" ")).join(" ");data.stepUp=true;
  return authorizeRemote(options,data,undefined,true);
}
