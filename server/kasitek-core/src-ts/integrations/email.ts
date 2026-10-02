import { apiJson, parseSerdeValueJson } from "../json.js";
import type { Pool } from "pg";
import { createId } from "@paralleldrive/cuid2";
import { generateToken, sha256Base64Url } from "@kasitek/server-support/crypto";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";
import { syncOrgConnections } from "../services/connections.js";
import { encryptSocialSecret, decryptSocialSecret } from "./crypto.js";
import { buildUrl } from "./social-oauth.js";
import * as sql from "./email-sql.js";
export const GOOGLE_PROVIDER = "GOOGLE",
  MICROSOFT_PROVIDER = "MICROSOFT";
export interface ProviderConfig {
  provider: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
}
export interface OAuthState {
  id: string;
  orgId: string;
  userId: string;
  provider: string;
  redirectUri: string;
  returnPath: string;
}
export interface EmailConnectionSummary {
  id: string;
  provider: string;
  externalAccountId: string;
  emailAddress: string;
  displayName: string;
  status: string;
  healthStatus: string;
  syncStatus: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
  inboxStatus: string;
  inboundStatus: string;
  outboundStatus: string;
}
export interface EmailCredentialRow {
  id: string;
  provider: string;
  email_address: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: Date | null;
}
export type HttpFetch = typeof fetch;
export function normalizeProvider(provider: string): string {
  switch (provider.toLowerCase()) {
    case "google":
    case "gmail":
      return GOOGLE_PROVIDER;
    case "microsoft":
    case "outlook":
      return MICROSOFT_PROVIDER;
    default:
      throw new ApiError(
        400,
        "bad_request",
        "Only Google and Microsoft email accounts are supported",
      );
  }
}
export function providerConfig(
  config: CoreConfig,
  name: string,
): ProviderConfig {
  const provider = normalizeProvider(name),
    google = provider === GOOGLE_PROVIDER,
    label = google ? "Google" : "Microsoft",
    prefix = `KASITEK_EMAIL_${provider}_`;
  const env = (key: string, message: string) => {
    const value = config.env[prefix + key]?.trim();
    if (!value) throw new ApiError(503, "service_unavailable", message);
    return value;
  };
  return {
    provider,
    clientId: env("CLIENT_ID", `${label} email OAuth is not configured`),
    clientSecret: env(
      "CLIENT_SECRET",
      `${label} email OAuth is not configured`,
    ),
    redirectUri: env(
      "REDIRECT_URI",
      `${label} email OAuth redirect is not configured`,
    ),
    authorizeUrl: google
      ? "https://accounts.google.com/o/oauth2/v2/auth"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: google
      ? "https://oauth2.googleapis.com/token"
      : "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: google
      ? [
          "openid",
          "email",
          "profile",
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
        ]
      : [
          "openid",
          "profile",
          "email",
          "offline_access",
          "User.Read",
          "Mail.Read",
          "Mail.Send",
        ],
  };
}
export function safeReturnPath(value?: string | null): string {
  const path = (value ?? "/inbox").trim();
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\")
    ? path
    : "/inbox";
}
export async function createOAuthState(
  pool: Pool,
  orgId: string,
  userId: string,
  provider: ProviderConfig,
  returnPath: string,
): Promise<string> {
  const state = generateToken(48);
  await pool.query(sql.CREATE_OAUTH_STATE_0, [
    createId(),
    orgId,
    userId,
    provider.provider,
    sha256Base64Url(state),
    provider.redirectUri,
    returnPath,
    new Date(Date.now() + 600000),
  ]);
  return state;
}
const camel = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      v,
    ]),
  );
export async function consumeOAuthState(
  pool: Pool,
  state: string,
): Promise<OAuthState | null> {
  const row = (
    await pool.query(sql.CONSUME_OAUTH_STATE_0, [sha256Base64Url(state)])
  ).rows[0];
  return row ? (camel(row) as unknown as OAuthState) : null;
}
export function authorizationUrl(
  provider: ProviderConfig,
  state: string,
): string {
  return buildUrl(provider.authorizeUrl, [
    ["client_id", provider.clientId],
    ["redirect_uri", provider.redirectUri],
    ["response_type", "code"],
    ["scope", provider.scopes.join(" ")],
    ["state", state],
    ...((provider.provider === GOOGLE_PROVIDER
      ? [
          ["access_type", "offline"],
          ["prompt", "consent"],
          ["include_granted_scopes", "true"],
        ]
      : [["response_mode", "query"]]) as [string, string][]),
  ]);
}
export async function ensureInboxBinding(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<void> {
  const row = (
    await pool.query<{
      scopes: string[];
    }>(sql.ENSURE_INBOX_BINDING_0, [id, orgId])
  ).rows[0];
  if (!row) throw new ApiError(404, "not_found", "Email connection not found");
  const read = row.scopes.some((v) =>
      ["https://www.googleapis.com/auth/gmail.readonly", "Mail.Read"].includes(
        v,
      ),
    ),
    send = row.scopes.some((v) =>
      ["https://www.googleapis.com/auth/gmail.send", "Mail.Send"].includes(v),
    );
  await pool.query(sql.ENSURE_INBOX_BINDING_1, [
    `eib_${id}`,
    orgId,
    id,
    read ? "PENDING" : "BLOCKED",
    send ? "READY" : "BLOCKED",
  ]);
}
export async function listEmailConnections(
  pool: Pool,
  orgId: string,
): Promise<EmailConnectionSummary[]> {
  return (await pool.query(sql.LIST_0, [orgId])).rows.map(
    (v) => camel(v) as unknown as EmailConnectionSummary,
  );
}
export async function getConnection(
  pool: Pool,
  orgId: string,
  provider: string,
  externalId: string,
): Promise<EmailConnectionSummary | null> {
  const row = (
    await pool.query(sql.GET_CONNECTION_0, [orgId, provider, externalId])
  ).rows[0];
  return row ? (camel(row) as unknown as EmailConnectionSummary) : null;
}
export async function getConnectionById(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<EmailConnectionSummary | null> {
  const row = (await pool.query(sql.GET_CONNECTION_BY_ID_0, [orgId, id]))
    .rows[0];
  return row ? (camel(row) as unknown as EmailConnectionSummary) : null;
}
export function publicEmailConnection(summary: EmailConnectionSummary) {
  const { externalAccountId: _, scopes: __, ...safe } = summary;
  return safe;
}
export async function upsertConnectionFromTokens(
  pool: Pool,
  config: CoreConfig,
  orgId: string,
  userId: string,
  name: string,
  externalId: string,
  email: string,
  displayName: string,
  access: string,
  refresh: string | null,
  expiresAt: Date | null,
  scopes: string[],
  source: string,
): Promise<EmailConnectionSummary> {
  const provider = normalizeProvider(name);
  if (!access.trim())
    throw new ApiError(400, "bad_request", "Email access token is required");
  await pool.query(sql.UPSERT_CONNECTION_FROM_TOKENS_0, [
    createId(),
    orgId,
    userId,
    provider,
    externalId,
    email,
    displayName,
    encryptSocialSecret(config, access),
    refresh?.trim() ? encryptSocialSecret(config, refresh) : null,
    expiresAt,
    scopes,
    JSON.stringify({ provider, source }),
  ]);
  const id = (
    await pool.query<{
      id: string;
    }>(sql.UPSERT_CONNECTION_FROM_TOKENS_1, [orgId, provider, externalId])
  ).rows[0]!.id;
  await ensureInboxBinding(pool, orgId, id);
  await syncOrgConnections(pool, orgId);
  const summary = await getConnection(pool, orgId, provider, externalId);
  if (!summary)
    throw new ApiError(
      500,
      "internal_error",
      "Email connection projection was not created",
    );
  return summary;
}
interface TokenResponse {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: number | null;
  scope?: string | null;
}
function parseToken(value: unknown, message: string): TokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(502, "bad_gateway", message);
  const token = value as Record<string, unknown>;
  for (const key of ["access_token", "refresh_token", "scope"])
    if (token[key] != null && typeof token[key] !== "string")
      throw new ApiError(502, "bad_gateway", message);
  if (token.expires_in != null) {
    const raw = token.expires_in;
    if (
      !(
        (typeof raw === "number" && Number.isSafeInteger(raw)) ||
        typeof raw === "bigint"
      ) ||
      BigInt(raw) < -(1n << 63n) ||
      BigInt(raw) >= 1n << 63n
    )
      throw new ApiError(502, "bad_gateway", message);
    token.expires_in = Number(raw);
  }
  return token as TokenResponse;
}
async function json(response: Response, message: string): Promise<unknown> {
  try {
    return parseSerdeValueJson(await response.text());
  } catch {
    throw new ApiError(502, "bad_gateway", message);
  }
}
async function request(
  http: HttpFetch,
  url: string,
  options: RequestInit,
  message: string,
): Promise<Response> {
  try {
    return await http(url, options);
  } catch {
    throw new ApiError(502, "bad_gateway", message);
  }
}
export async function loadProfile(
  provider: ProviderConfig,
  token: string,
  http: HttpFetch = fetch,
) {
  const google = provider.provider === GOOGLE_PROVIDER,
    response = await request(
      http,
      google
        ? "https://openidconnect.googleapis.com/v1/userinfo"
        : "https://graph.microsoft.com/v1.0/me",
      { headers: { Authorization: `Bearer ${token}` } },
      "Email profile lookup failed",
    );
  if (!response.ok)
    throw new ApiError(
      502,
      "bad_gateway",
      "Email provider profile lookup failed",
    );
  const raw = await json(
    response,
    `Invalid ${google ? "Google" : "Microsoft"} profile response`,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ApiError(
      502,
      "bad_gateway",
      `Invalid ${google ? "Google" : "Microsoft"} profile response`,
    );
  const value = raw as Record<string, unknown>;
  for (const key of google
    ? ["email", "sub", "name"]
    : ["id", "mail", "user_principal_name", "display_name"])
    if (value[key] != null && typeof value[key] !== "string")
      throw new ApiError(
        502,
        "bad_gateway",
        `Invalid ${google ? "Google" : "Microsoft"} profile response`,
      );
  const email = google
    ? value.email
    : (value.mail ?? value.user_principal_name);
  if (typeof email !== "string")
    throw new ApiError(
      502,
      "bad_gateway",
      `${google ? "Google" : "Microsoft"} did not return an email address`,
    );
  return {
    externalAccountId: ((google ? value.sub : value.id) ?? email) as string,
    emailAddress: email,
    displayName: ((google ? value.name : value.display_name) ??
      email) as string,
  };
}
export async function finishOAuth(
  pool: Pool,
  config: CoreConfig,
  state: OAuthState,
  code: string,
  http: HttpFetch = fetch,
): Promise<EmailConnectionSummary> {
  const provider = providerConfig(config, state.provider);
  if (provider.redirectUri !== state.redirectUri)
    throw new ApiError(
      400,
      "bad_request",
      "Email OAuth redirect does not match the request",
    );
  const response = await request(
    http,
    provider.tokenUrl,
    {
      method: "POST",
      body: new URLSearchParams({
        code,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        redirect_uri: provider.redirectUri,
        grant_type: "authorization_code",
      }),
    },
    "Email token exchange failed",
  );
  if (!response.ok)
    throw new ApiError(
      response.status >= 500 ? 502 : 400,
      "email_oauth_token_exchange_failed",
      "The email provider rejected the OAuth exchange",
    );
  const token = parseToken(
    await json(response, "Email provider returned an invalid token response"),
    "Email provider returned an invalid token response",
  );
  if (token.access_token == null)
    throw new ApiError(
      502,
      "bad_gateway",
      "Email provider did not return an access token",
    );
  const profile = await loadProfile(provider, token.access_token, http);
  return upsertConnectionFromTokens(
    pool,
    config,
    state.orgId,
    state.userId,
    provider.provider,
    profile.externalAccountId,
    profile.emailAddress,
    profile.displayName,
    token.access_token,
    token.refresh_token ?? null,
    token.expires_in == null
      ? null
      : new Date(Date.now() + Math.max(0, token.expires_in) * 1000),
    (token.scope ?? provider.scopes.join(" ")).split(/\s+/).filter(Boolean),
    "workspace_email_oauth",
  );
}
export function oauthErrorPath(state: OAuthState | null, code: string): string {
  const path = state?.returnPath ?? "/inbox";
  return `${path}${path.includes("?") ? "&" : "?"}email=error&code=${encodeURIComponent(code)}`;
}
export function oauthSuccessPath(state: OAuthState, provider: string): string {
  return `${state.returnPath}${state.returnPath.includes("?") ? "&" : "?"}email=connected&provider=${encodeURIComponent(provider)}`;
}
export function frontendRedirect(config: CoreConfig, path: string): string {
  return config.frontendUrl.replace(/\/+$/, "") + path;
}
export function providerOptions() {
  return [
    {
      id: "google",
      name: "Google",
      status: "available",
      capabilities: ["read", "search", "reply"],
    },
    {
      id: "microsoft",
      name: "Microsoft",
      status: "available",
      capabilities: ["read", "search", "reply"],
    },
    {
      id: "custom",
      name: "Custom Email",
      status: "coming_soon",
      capabilities: [],
    },
  ];
}
export async function resolveEmailCredential(
  pool: Pool,
  orgId: string,
  provider?: string | null,
  account?: string | null,
): Promise<EmailCredentialRow> {
  const rows = (
    await pool.query<EmailCredentialRow>(sql.RESOLVE_EMAIL_CREDENTIAL_0, [
      orgId,
      provider?.toUpperCase() ?? null,
      account?.trim() || null,
    ])
  ).rows;
  if (!rows.length)
    throw new ApiError(
      404,
      "not_found",
      "No connected email account matches the request",
    );
  if (rows.length > 1)
    throw new ApiError(
      409,
      "conflict",
      "More than one email account matches; specify the provider or account",
    );
  return rows[0]!;
}
export async function resolveEmailCredentialById(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<EmailCredentialRow> {
  const row = (
    await pool.query<EmailCredentialRow>(sql.RESOLVE_EMAIL_CREDENTIAL_BY_ID_0, [
      id,
      orgId,
    ])
  ).rows[0];
  if (!row)
    throw new ApiError(404, "not_found", "Connected email account not found");
  return row;
}
export async function accessToken(
  pool: Pool,
  config: CoreConfig,
  row: EmailCredentialRow,
  http: HttpFetch = fetch,
): Promise<string> {
  const current = decryptSocialSecret(config, row.access_token);
  if (
    row.token_expires_at === null ||
    row.token_expires_at.getTime() > Date.now() + 30000 ||
    row.refresh_token === null
  )
    return current;
  const refresh = decryptSocialSecret(config, row.refresh_token),
    provider = providerConfig(config, row.provider),
    form = new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
  if (provider.provider === MICROSOFT_PROVIDER)
    form.set("scope", provider.scopes.join(" "));
  const response = await request(
    http,
    provider.tokenUrl,
    { method: "POST", body: form },
    "Email token refresh failed",
  );
  if (!response.ok) throw new ApiError(401, "unauthorized", "Unauthorized");
  const token = parseToken(
    await json(response, "Email provider returned an invalid refresh response"),
    "Email provider returned an invalid refresh response",
  );
  if (token.access_token == null)
    throw new ApiError(401, "unauthorized", "Unauthorized");
  await pool.query(sql.ACCESS_TOKEN_0, [
    encryptSocialSecret(config, token.access_token),
    token.refresh_token == null
      ? null
      : encryptSocialSecret(config, token.refresh_token),
    token.expires_in == null
      ? null
      : new Date(Date.now() + Math.max(0, token.expires_in) * 1000),
    row.id,
  ]);
  return token.access_token;
}
export async function providerRequest(
  pool: Pool,
  config: CoreConfig,
  row: EmailCredentialRow,
  method: string,
  path: string,
  body?: unknown,
  http: HttpFetch = fetch,
): Promise<unknown> {
  const token = await accessToken(pool, config, row, http),
    base =
      row.provider === GOOGLE_PROVIDER
        ? "https://gmail.googleapis.com/gmail/v1"
        : "https://graph.microsoft.com/v1.0",
    response = await request(
      http,
      base + path,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
          consistencylevel: "eventual",
        },
        ...(method === "GET" ? {} : { body: apiJson(body ?? {}) }),
      },
      "Email provider request failed",
    );
  if (response.status === 204) return {};
  let payload: unknown;
  try {
    payload = parseSerdeValueJson(await response.text());
  } catch {
    payload = {};
  }
  if (!response.ok)
    throw response.status === 401
      ? new ApiError(401, "unauthorized", "Unauthorized")
      : new ApiError(502, "bad_gateway", "Email provider request failed");
  return payload;
}
