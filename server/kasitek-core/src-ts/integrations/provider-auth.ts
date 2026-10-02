import type { Pool } from "pg";
import { canonicalJson, SerdeFloat } from "@kasitek/server-support/json";
import { parseSerdeValueJson } from "../json.js";
import { createId } from "@paralleldrive/cuid2";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";
import {
  requiredEnv,
  instagramAppId,
  instagramAppSecret,
  socialAppUrl,
  buildUrl,
} from "./social-oauth.js";
import { encryptSocialSecret, decryptSocialSecret } from "./crypto.js";
import type {
  Tokens,
  Profile,
  MetaPageAccount,
  LinkedInPage,
} from "./social-provider-connections.js";
import type { HttpFetch } from "./email.js";
import { valueAsIdentifier } from "./social-provider-connections.js";
import type { SocialChannel } from "../services/social/types.js";
import {
  getSocialChannel,
  mergeChannelMetadataWithCapabilities,
} from "../services/social/channels.js";
import {
  recordProviderSyncOutcome,
  providerSyncFailureClass,
} from "../services/connections.js";
export const META_GRAPH_BASE = "https://graph.facebook.com/v23.0";
export const INSTAGRAM_GRAPH_BASE = "https://graph.instagram.com/v23.0";
export const THREADS_GRAPH_BASE = "https://graph.threads.com/v1.0";
export const TIKTOK_TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";
export const LINKEDIN_API_VERSION = "202606";
const META_TOKEN_URL = META_GRAPH_BASE + "/oauth/access_token";
const PAGE_FIELDS =
  "messages,message_echoes,messaging_postbacks,message_deliveries,message_reads";
const INSTAGRAM_FIELDS =
  "messages,messaging_postbacks,messaging_seen,message_reactions";
let pageConfigured = false,
  instagramConfigured = false;
const bad = (message: string): never => {
  throw new ApiError(400, "bad_request", message);
};
export async function fetchJson(
  url: string,
  options: RequestInit,
  fallback: string,
  http: HttpFetch = fetch,
): Promise<unknown> {
  let response: Response;
  let body: string;
  try {
    response = await http(url, options);
    body = await response.text();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    )
      throw new ApiError(504, "gateway_timeout", "Provider request timed out");
    throw new ApiError(500, "internal_error", "External request failed");
  }
  if (!response.ok) {
    if (response.status === 429)
      throw new ApiError(429, "rate_limited", "Provider rate limit exceeded");
    if (response.status >= 500)
      throw new ApiError(502, "bad_gateway", "Provider request failed");
    let parsed: unknown;
    try {
      parsed = parseSerdeValueJson(body);
    } catch {}
    const data =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    const nested =
      data.error && typeof data.error === "object"
        ? (data.error as Record<string, unknown>).message
        : null;
    const message =
      [data.detail, data.message, data.error, nested].find(
        (v) => typeof v === "string",
      ) ?? fallback;
    bad(message as string);
  }
  try {
    return parseSerdeValueJson(body);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      "Failed to decode provider response",
    );
  }
}
function object(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    value instanceof SerdeFloat ||
    Array.isArray(value)
  )
    throw new ApiError(
      500,
      "internal_error",
      "Failed to decode provider response",
    );
  return value as Record<string, unknown>;
}
function optionalStrings(value: Record<string, unknown>, keys: string[]): void {
  for (const key of keys)
    if (value[key] != null && typeof value[key] !== "string")
      throw new ApiError(
        500,
        "internal_error",
        "Failed to decode provider response",
      );
}
function profile(value: unknown, requiredId = false): Profile {
  const p = object(value);
  optionalStrings(p, [
    "id",
    "username",
    "name",
    "profile_picture_url",
    "account_type",
    "threads_profile_picture_url",
    "profile_image_url",
    "sub",
    "picture",
    "email",
    "open_id",
    "display_name",
    "avatar_url",
  ]);
  for (const key of ["followers_count", "follows_count", "media_count"])
    if (
      p[key] != null &&
      (typeof p[key] !== "number" || !Number.isSafeInteger(p[key]))
    )
      throw new ApiError(
        500,
        "internal_error",
        "Failed to decode provider response",
      );
  if (requiredId && typeof p.id !== "string")
    throw new ApiError(
      500,
      "internal_error",
      "Failed to decode provider response",
    );
  return p as Profile;
}
function tokens(value: unknown): Tokens {
  const t = object(value);
  optionalStrings(t, [
    "access_token",
    "refresh_token",
    "scope",
    "token_type",
    "open_id",
  ]);
  for (const key of ["expires_in", "refresh_expires_in"]) {
    const raw = t[key];
    if (raw == null) continue;
    if (!(
      (typeof raw === "number" && Number.isSafeInteger(raw)) ||
      typeof raw === "bigint"
    ))
      throw new ApiError(
        500,
        "internal_error",
        "Failed to decode provider response",
      );
    const integer = BigInt(raw);
    if (integer < -(1n << 63n) || integer >= 1n << 63n)
      throw new ApiError(
        500,
        "internal_error",
        "Failed to decode provider response",
      );
    // This typed expiry is consumed as duration arithmetic; generic response Values remain lossless.
    t[key] = Number(integer);
  }
  if (
    t.permissions != null &&
    (!Array.isArray(t.permissions) ||
      t.permissions.some((v) => typeof v !== "string"))
  )
    throw new ApiError(
      500,
      "internal_error",
      "Failed to decode provider response",
    );
  return t as Tokens;
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const form = (value: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(value),
});
export async function exchangeXCodeForTokens(
  config: CoreConfig,
  code: string,
  verifier: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  const clientId = requiredEnv(config, "AUTH_X_CLIENT_ID"),
    secret = config.rawEnv.AUTH_X_CLIENT_SECRET ?? "",
    options = form({
      code,
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: `${socialAppUrl(config)}/api/social/oauth/x/callback`,
      code_verifier: verifier,
    });
  if (secret)
    options.headers = {
      ...options.headers,
      Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`,
    };
  const result = tokens(
    await fetchJson(
      "https://api.x.com/2/oauth2/token",
      options,
      "X OAuth exchange failed",
      http,
    ),
  );
  if (result.access_token == null)
    bad("X OAuth exchange did not return an access token");
  return result;
}
export async function fetchXMe(
  token: string,
  http: HttpFetch = fetch,
): Promise<Profile & { id: string }> {
  const response = object(
    await fetchJson(
      "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url",
      { headers: bearer(token) },
      "Failed to fetch X profile",
      http,
    ),
  );
  if (response.data == null) bad("X account lookup did not return a user");
  return profile(response.data, true) as Profile & { id: string };
}
export async function exchangeLinkedinCodeForTokens(
  config: CoreConfig,
  code: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  const result = tokens(
    await fetchJson(
      "https://www.linkedin.com/oauth/v2/accessToken",
      form({
        grant_type: "authorization_code",
        code,
        client_id: requiredEnv(config, "AUTH_LINKEDIN_CLIENT_ID"),
        client_secret: requiredEnv(config, "AUTH_LINKEDIN_CLIENT_SECRET"),
        redirect_uri: `${socialAppUrl(config)}/api/social/oauth/linkedin/callback`,
      }),
      "LinkedIn OAuth exchange failed",
      http,
    ),
  );
  if (result.access_token == null)
    bad("LinkedIn OAuth exchange did not return an access token");
  return result;
}
export async function fetchLinkedinProfile(
  token: string,
  http: HttpFetch = fetch,
): Promise<Profile> {
  const result = profile(
    await fetchJson(
      "https://api.linkedin.com/v2/userinfo",
      { headers: bearer(token) },
      "Failed to fetch LinkedIn profile",
      http,
    ),
  );
  if (result.sub == null)
    bad("LinkedIn profile lookup did not return a member identifier");
  return result;
}
const linkedinRank = (role: string) =>
  role === "ADMINISTRATOR"
    ? 4
    : ["CONTENT_ADMIN", "CONTENT_ADMINISTRATOR"].includes(role)
      ? 3
      : role === "DIRECT_SPONSORED_CONTENT_POSTER"
        ? 2
        : 0;
export async function fetchLinkedinPages(
  token: string,
  http: HttpFetch = fetch,
): Promise<LinkedInPage[]> {
  const headers = {
      ...bearer(token),
      "Linkedin-Version": LINKEDIN_API_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      "content-type": "application/json",
    },
    roles = new Map<string, string>();
  let start = 0;
  while (true) {
    const response = object(
      await fetchJson(
        buildUrl("https://api.linkedin.com/rest/organizationAcls", [
          ["q", "roleAssignee"],
          ["state", "APPROVED"],
          ["count", "100"],
          ["start", String(start)],
        ]),
        { headers },
        "Failed to load LinkedIn Pages",
        http,
      ),
    );
    const elements = response.elements ?? [];
    if (!Array.isArray(elements))
      throw new ApiError(
        500,
        "internal_error",
        "Failed to decode provider response",
      );
    for (const raw of elements) {
      const access = object(raw);
      optionalStrings(access, [
        "organization",
        "organizationTarget",
        "role",
        "state",
      ]);
      const role = typeof access.role === "string" ? access.role : "";
      if (access.state !== "APPROVED" || !linkedinRank(role)) continue;
      const urn = access.organization ?? access.organizationTarget;
      if (typeof urn !== "string" || !urn.startsWith("urn:li:organization:"))
        continue;
      if (linkedinRank(role) > linkedinRank(roles.get(urn) ?? ""))
        roles.set(urn, role);
    }
    const total =
      response.paging && typeof response.paging === "object"
        ? (response.paging as Record<string, unknown>).total
        : null;
    if (
      elements.length < 100 ||
      (typeof total === "number" && start + elements.length >= total)
    )
      break;
    start += elements.length;
  }
  const pages: LinkedInPage[] = [];
  for (const [urn, role] of roles) {
    const id = urn.slice("urn:li:organization:".length),
      response = object(
        await fetchJson(
          buildUrl("https://api.linkedin.com/rest/organizationsLookup", [
            ["ids", `List(${id})`],
          ]),
          { headers },
          "Failed to load LinkedIn Page details",
          http,
        ),
      ),
      results =
        response.results && typeof response.results === "object"
          ? (response.results as Record<string, unknown>)
          : {},
      raw = results[id];
    if (raw == null) bad(`LinkedIn did not return details for Page ${id}`);
    const details = object(raw),
      name =
        details.name && typeof details.name === "object"
          ? (details.name as Record<string, unknown>)
          : {},
      localized =
        name.localized && typeof name.localized === "object"
          ? (name.localized as Record<string, unknown>)
          : {};
    pages.push({
      id,
      urn,
      role,
      name:
        typeof details.localizedName === "string"
          ? details.localizedName
          : typeof localized.en_US === "string"
            ? localized.en_US
            : "LinkedIn Page",
      vanity_name:
        typeof details.vanityName === "string" ? details.vanityName : null,
    });
  }
  return pages.sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase()
      ? -1
      : a.name.toLowerCase() > b.name.toLowerCase()
        ? 1
        : 0,
  );
}
export async function exchangeThreadsCodeForToken(
  config: CoreConfig,
  code: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  const short = tokens(
    await fetchJson(
      "https://graph.threads.com/oauth/access_token",
      form({
        client_id: requiredEnv(config, "AUTH_THREADS_APP_ID"),
        client_secret: requiredEnv(config, "AUTH_THREADS_APP_SECRET"),
        grant_type: "authorization_code",
        redirect_uri: `${socialAppUrl(config)}/api/social/oauth/threads/callback`,
        code,
      }),
      "Threads OAuth exchange failed",
      http,
    ),
  );
  if (short.access_token == null) bad("Threads did not return an access token");
  return tokens(
    await fetchJson(
      buildUrl("https://graph.threads.com/access_token", [
        ["grant_type", "th_exchange_token"],
        ["client_secret", requiredEnv(config, "AUTH_THREADS_APP_SECRET")],
        ["access_token", short.access_token!],
      ]),
      {},
      "Threads long-lived token exchange failed",
      http,
    ),
  );
}
export async function fetchThreadsProfile(
  token: string,
  http: HttpFetch = fetch,
): Promise<Profile & { id: string }> {
  return profile(
    await fetchJson(
      `${THREADS_GRAPH_BASE}/me?fields=id,username,name,threads_profile_picture_url`,
      { headers: bearer(token) },
      "Failed to fetch Threads profile",
      http,
    ),
    true,
  ) as Profile & { id: string };
}
export async function exchangeTiktokCodeForTokens(
  config: CoreConfig,
  code: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  return tokens(
    await fetchJson(
      TIKTOK_TOKEN_URL,
      form({
        client_key: requiredEnv(config, "AUTH_TIKTOK_CLIENT_KEY"),
        client_secret: requiredEnv(config, "AUTH_TIKTOK_CLIENT_SECRET"),
        code,
        grant_type: "authorization_code",
        redirect_uri: `${socialAppUrl(config)}/api/social/oauth/tiktok/callback`,
      }),
      "TikTok OAuth exchange failed",
      http,
    ),
  );
}
export async function fetchTiktokProfile(
  token: string,
  http: HttpFetch = fetch,
): Promise<Profile> {
  const envelope = object(
    await fetchJson(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name",
      { headers: bearer(token) },
      "Failed to fetch TikTok profile",
      http,
    ),
  );
  if (envelope.error && typeof envelope.error === "object") {
    const error = envelope.error as Record<string, unknown>,
      code = typeof error.code === "string" ? error.code : "ok";
    if (code !== "ok")
      bad(typeof error.message === "string" ? error.message : code);
  }
  const data = envelope.data == null ? {} : object(envelope.data);
  if (data.user == null) bad("TikTok did not return a user profile");
  return profile(data.user);
}
export async function exchangeMetaCodeForTokens(
  config: CoreConfig,
  code: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  const result = tokens(
    await fetchJson(
      buildUrl(META_TOKEN_URL, [
        ["client_id", requiredEnv(config, "AUTH_META_APP_ID")],
        ["client_secret", requiredEnv(config, "AUTH_META_APP_SECRET")],
        [
          "redirect_uri",
          `${socialAppUrl(config)}/api/social/oauth/meta/callback`,
        ],
        ["code", code],
      ]),
      {},
      "Meta OAuth exchange failed",
      http,
    ),
  );
  if (result.access_token == null)
    bad("Meta OAuth exchange did not return an access token");
  return result;
}
export async function exchangeMetaForLongLivedToken(
  config: CoreConfig,
  access: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  const result = tokens(
    await fetchJson(
      buildUrl(META_TOKEN_URL, [
        ["grant_type", "fb_exchange_token"],
        ["client_id", requiredEnv(config, "AUTH_META_APP_ID")],
        ["client_secret", requiredEnv(config, "AUTH_META_APP_SECRET")],
        ["fb_exchange_token", access],
      ]),
      {},
      "Meta long-lived token exchange failed",
      http,
    ),
  );
  if (result.access_token == null)
    bad("Meta long-lived token exchange did not return an access token");
  return result;
}
export async function fetchMetaPermissions(
  config: CoreConfig,
  access: string,
  http: HttpFetch = fetch,
): Promise<string[]> {
  if (
    config.rawEnv.AUTH_META_APP_ID !== undefined &&
    config.rawEnv.AUTH_META_APP_SECRET !== undefined
  ) {
    let response: Record<string, unknown> | null = null;
    try {
      response = object(
        await fetchJson(
          buildUrl(`${META_GRAPH_BASE}/debug_token`, [
            ["input_token", access],
            [
              "access_token",
              `${config.rawEnv.AUTH_META_APP_ID}|${config.rawEnv.AUTH_META_APP_SECRET}`,
            ],
          ]),
          {},
          "Failed to inspect Meta access token",
          http,
        ),
      );
    } catch {}
    if (response) {
      if (response.data == null) bad("Meta token inspection returned no data");
      const data = object(response.data);
      if (data.is_valid === false)
        throw new ApiError(401, "unauthorized", "Unauthorized");
      const scopes = data.scopes ?? [];
      if (!Array.isArray(scopes) || scopes.some((v) => typeof v !== "string"))
        throw new ApiError(
          500,
          "internal_error",
          "Failed to decode provider response",
        );
      const result = scopes as string[];
      const granular = data.granular_scopes ?? [];
      if (!Array.isArray(granular))
        throw new ApiError(
          500,
          "internal_error",
          "Failed to decode provider response",
        );
      for (const raw of granular) {
        const scope = object(raw).scope;
        if (scope != null && typeof scope !== "string")
          throw new ApiError(
            500,
            "internal_error",
            "Failed to decode provider response",
          );
        if (typeof scope === "string" && !result.includes(scope))
          result.push(scope);
      }
      return result;
    }
  }
  const response = object(
      await fetchJson(
        `${META_GRAPH_BASE}/me/permissions`,
        { headers: bearer(access) },
        "Failed to inspect Meta permissions",
        http,
      ),
    ),
    data = response.data ?? [];
  if (!Array.isArray(data))
    throw new ApiError(
      500,
      "internal_error",
      "Failed to decode provider response",
    );
  return data
    .map((v) => object(v))
    .filter((v) => v.status === "granted" && typeof v.permission === "string")
    .map((v) => v.permission as string);
}
export async function exchangeInstagramCodeForToken(
  config: CoreConfig,
  code: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  const result = tokens(
    await fetchJson(
      "https://api.instagram.com/oauth/access_token",
      form({
        client_id: instagramAppId(config),
        client_secret: instagramAppSecret(config),
        grant_type: "authorization_code",
        redirect_uri: `${socialAppUrl(config)}/api/social/oauth/instagram/callback`,
        code,
      }),
      "Instagram OAuth exchange failed",
      http,
    ),
  );
  if (result.access_token == null)
    bad("Instagram OAuth exchange did not return an access token");
  return result;
}
export async function exchangeInstagramForLongLivedToken(
  config: CoreConfig,
  access: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  const result = tokens(
    await fetchJson(
      buildUrl("https://graph.instagram.com/access_token", [
        ["grant_type", "ig_exchange_token"],
        ["client_secret", instagramAppSecret(config)],
        ["access_token", access],
      ]),
      {},
      "Instagram long-lived token exchange failed",
      http,
    ),
  );
  if (result.access_token == null)
    bad("Instagram long-lived token exchange did not return an access token");
  return result;
}
export async function fetchInstagramProfile(
  token: string,
  http: HttpFetch = fetch,
): Promise<Profile> {
  const result = profile(
    await fetchJson(
      buildUrl(`${INSTAGRAM_GRAPH_BASE}/me`, [
        [
          "fields",
          "id,user_id,username,name,profile_picture_url,followers_count,follows_count,media_count,account_type",
        ],
      ]),
      { headers: bearer(token) },
      "Failed to load the Instagram professional account",
      http,
    ),
  );
  if (valueAsIdentifier(result.user_id) === null && result.id == null)
    bad("Instagram account lookup did not return an account identifier");
  return result;
}
function metaPage(value: unknown): MetaPageAccount {
  const p = object(value);
  if (typeof p.id !== "string")
    throw new ApiError(
      500,
      "internal_error",
      "Failed to decode provider response",
    );
  optionalStrings(p, ["name", "username", "access_token"]);
  if (
    p.tasks != null &&
    (!Array.isArray(p.tasks) || p.tasks.some((v) => typeof v !== "string"))
  )
    throw new ApiError(
      500,
      "internal_error",
      "Failed to decode provider response",
    );
  if (p.connected_instagram_account != null)
    profile(p.connected_instagram_account, true);
  if (p.instagram_business_account != null)
    profile(p.instagram_business_account, true);
  return p as unknown as MetaPageAccount;
}
export async function fetchMetaPages(
  token: string,
  http: HttpFetch = fetch,
): Promise<MetaPageAccount[]> {
  const response = object(
    await fetchJson(
      buildUrl(`${META_GRAPH_BASE}/me/accounts`, [
        [
          "fields",
          "id,name,username,access_token,tasks,picture{url},connected_instagram_account{id,username,name,profile_picture_url},instagram_business_account{id,username,name,profile_picture_url}",
        ],
      ]),
      { headers: bearer(token) },
      "Failed to load connected Meta Pages",
      http,
    ),
  );
  const data = response.data ?? [];
  if (!Array.isArray(data))
    throw new ApiError(
      500,
      "internal_error",
      "Failed to decode provider response",
    );
  return data.map(metaPage);
}
export async function fetchPageInstagramAccount(
  token: string,
  id: string,
  http: HttpFetch = fetch,
): Promise<Profile | null> {
  const response = metaPage(
    await fetchJson(
      buildUrl(`${META_GRAPH_BASE}/${id}`, [
        [
          "fields",
          "connected_instagram_account{id,username,name,profile_picture_url},instagram_business_account{id,username,name,profile_picture_url}",
        ],
      ]),
      { headers: bearer(token) },
      "Failed to load connected Instagram account",
      http,
    ),
  );
  return (
    response.connected_instagram_account ??
    response.instagram_business_account ??
    null
  );
}
export async function subscribeInstagramWebhooks(
  token: string,
  id: string,
  http: HttpFetch = fetch,
): Promise<void> {
  await fetchJson(
    `${INSTAGRAM_GRAPH_BASE}/${id}/subscribed_apps`,
    {
      ...form({ subscribed_fields: INSTAGRAM_FIELDS }),
      headers: bearer(token),
    },
    "Failed to subscribe the Instagram account to webhooks",
    http,
  );
}
export async function subscribeMetaPageWebhooks(
  token: string,
  id: string,
  http: HttpFetch = fetch,
): Promise<void> {
  await fetchJson(
    `${META_GRAPH_BASE}/${id}/subscribed_apps`,
    { ...form({ subscribed_fields: PAGE_FIELDS }), headers: bearer(token) },
    "Failed to subscribe the Meta Page to messaging webhooks",
    http,
  );
}
async function subscribeApp(
  config: CoreConfig,
  instagram: boolean,
  http: HttpFetch,
): Promise<void> {
  const id = requiredEnv(config, "AUTH_META_APP_ID"),
    secret = requiredEnv(config, "AUTH_META_APP_SECRET"),
    verify =
      config.rawEnv.META_WEBHOOK_VERIFY_TOKEN ??
      config.rawEnv.AUTH_META_WEBHOOK_VERIFY_TOKEN;
  if (verify === undefined)
    throw new ApiError(
      500,
      "internal_error",
      "META_WEBHOOK_VERIFY_TOKEN or AUTH_META_WEBHOOK_VERIFY_TOKEN is required",
    );
  await fetchJson(
    `${META_GRAPH_BASE}/${id}/subscriptions`,
    form({
      object: instagram ? "instagram" : "page",
      callback_url: `${socialAppUrl(config)}/api/webhooks/meta`,
      verify_token: verify,
      fields: instagram ? INSTAGRAM_FIELDS : PAGE_FIELDS,
      include_values: "true",
      access_token: `${id}|${secret}`,
    }),
    instagram
      ? "Failed to configure Instagram messaging webhooks for the Meta app"
      : "Failed to configure Page messaging webhooks for the Meta app",
    http,
  );
  if (instagram) instagramConfigured = true;
  else pageConfigured = true;
}
export const subscribeMetaPageAppWebhooks = (
  config: CoreConfig,
  http: HttpFetch = fetch,
) => subscribeApp(config, false, http);
export const subscribeMetaInstagramAppWebhooks = (
  config: CoreConfig,
  http: HttpFetch = fetch,
) => subscribeApp(config, true, http);
async function ensureApp(
  pool: Pool,
  orgId: string,
  config: CoreConfig,
  instagram: boolean,
  http: HttpFetch,
): Promise<boolean> {
  if (instagram ? instagramConfigured : pageConfigured) return false;
  const platform = instagram ? "INSTAGRAM" : "FACEBOOK";
  const exists = (
    await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM "SocialChannelConnection" WHERE "orgId"=$1 AND platform=$2::"SocialPlatform" AND status='CONNECTED'::"SocialChannelStatus" AND metadata->>'provider'='meta')`,
      [orgId, platform],
    )
  ).rows[0]!.exists;
  if (!exists) return false;
  await subscribeApp(config, instagram, http);
  return true;
}
export const ensureMetaPageAppWebhooks = (
  pool: Pool,
  orgId: string,
  config: CoreConfig,
  http: HttpFetch = fetch,
) => ensureApp(pool, orgId, config, false, http);
export const ensureMetaInstagramAppWebhooks = (
  pool: Pool,
  orgId: string,
  config: CoreConfig,
  http: HttpFetch = fetch,
) => ensureApp(pool, orgId, config, true, http);
async function ensureAccount(
  pool: Pool,
  orgId: string,
  config: CoreConfig,
  instagram: boolean,
  http: HttpFetch,
): Promise<number> {
  const key = instagram
      ? "instagramWebhookSubscriptionVersion"
      : "metaWebhookSubscriptionVersion",
    version = instagram ? 1 : 2,
    platform = instagram ? "INSTAGRAM" : "FACEBOOK";
  const rows = (
    await pool.query<{
      id: string;
      externalAccountId: string;
      accessToken: string;
    }>(
      `SELECT id,"externalAccountId","accessToken" FROM "SocialChannelConnection" WHERE "orgId"=$1 AND platform=$2::"SocialPlatform" AND status='CONNECTED'::"SocialChannelStatus" AND "externalAccountId" IS NOT NULL AND "accessToken" IS NOT NULL ${instagram ? "AND metadata->>'authMethod'='instagram_login'" : ""} AND COALESCE(metadata->>$3,'0')<>$4`,
      [orgId, platform, key, String(version)],
    )
  ).rows;
  let count = 0;
  for (const row of rows) {
    try {
      const token = decryptSocialSecret(config, row.accessToken);
      if (instagram)
        await subscribeInstagramWebhooks(token, row.externalAccountId, http);
      else await subscribeMetaPageWebhooks(token, row.externalAccountId, http);
    } catch {
      continue;
    }
    await pool.query(
      `UPDATE "SocialChannelConnection" SET metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object($1::text,$2::int),"lastSyncedAt"=NOW(),"updatedAt"=NOW() WHERE id=$3 AND "orgId"=$4`,
      [key, version, row.id, orgId],
    );
    count++;
  }
  return count;
}
export const ensureInstagramAccountWebhookSubscriptions = (
  pool: Pool,
  orgId: string,
  config: CoreConfig,
  http: HttpFetch = fetch,
) => ensureAccount(pool, orgId, config, true, http);
export const ensureMetaPageWebhookSubscriptions = (
  pool: Pool,
  orgId: string,
  config: CoreConfig,
  http: HttpFetch = fetch,
) => ensureAccount(pool, orgId, config, false, http);
export async function refreshThreadsToken(
  config: CoreConfig,
  encrypted: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  return tokens(
    await fetchJson(
      buildUrl("https://graph.threads.com/refresh_access_token", [
        ["grant_type", "th_refresh_token"],
        ["access_token", decryptSocialSecret(config, encrypted)],
      ]),
      {},
      "Threads token refresh failed",
      http,
    ),
  );
}
export async function refreshTiktokToken(
  config: CoreConfig,
  encrypted: string,
  http: HttpFetch = fetch,
): Promise<Tokens> {
  return tokens(
    await fetchJson(
      TIKTOK_TOKEN_URL,
      form({
        client_key: requiredEnv(config, "AUTH_TIKTOK_CLIENT_KEY"),
        client_secret: requiredEnv(config, "AUTH_TIKTOK_CLIENT_SECRET"),
        grant_type: "refresh_token",
        refresh_token: decryptSocialSecret(config, encrypted),
      }),
      "TikTok token refresh failed",
      http,
    ),
  );
}
export async function saveRotatedTokens(
  pool: Pool,
  config: CoreConfig,
  id: string,
  access: string,
  refresh: string | null,
  expiresIn: number | null,
): Promise<void> {
  await pool.query(
    `UPDATE "SocialChannelConnection" SET "accessToken"=$1,"refreshToken"=COALESCE($2,"refreshToken"),metadata=COALESCE(metadata,'{}'::jsonb)||$3,"lastSyncedAt"=NOW(),"updatedAt"=NOW() WHERE id=$4`,
    [
      encryptSocialSecret(config, access),
      refresh === null ? null : encryptSocialSecret(config, refresh),
      JSON.stringify({
        expiresAt:
          expiresIn === null
            ? null
            : new Date(Date.now() + expiresIn * 1000).toISOString(),
      }),
      id,
    ],
  );
}
function base64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value))
    bad("Invalid Threads signed request");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value.replace(/=+$/, ""))
    bad("Invalid Threads signed request");
  return bytes;
}
export function verifyThreadsSignedRequest(
  config: CoreConfig,
  signed: string,
): string {
  const index = signed.indexOf(".");
  if (index < 1 || index === signed.length - 1)
    bad("Invalid Threads signed request");
  const payload = signed.slice(index + 1),
    signature = base64Url(signed.slice(0, index)),
    expected = createHmac(
      "sha256",
      requiredEnv(config, "AUTH_THREADS_APP_SECRET"),
    )
      .update(payload)
      .digest();
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  )
    throw new ApiError(401, "unauthorized", "Unauthorized");
  let data: Record<string, unknown>;
  try {
    data = object(
      parseSerdeValueJson(
        new TextDecoder("utf-8", { fatal: true }).decode(base64Url(payload)),
      ),
    );
  } catch {
    bad("Invalid Threads signed request");
  }
  if (typeof data!.algorithm !== "string")
    bad("Missing Threads signature algorithm");
  if ((data!.algorithm as string).toUpperCase() !== "HMAC-SHA256")
    bad("Unsupported Threads signature algorithm");
  const user = data!.user_id,
    id =
      typeof user === "string"
        ? user
        : typeof user === "number" ||
            typeof user === "bigint" ||
            user instanceof SerdeFloat
          ? canonicalJson(user)
          : null;
  if (id === null || !id.trim()) bad("Missing Threads user identifier");
  return id!;
}
export function threadsDataDeletionStatusUrl(
  config: CoreConfig,
  confirmation: string,
): string {
  return `${socialAppUrl(config)}/api/social/oauth/threads/data-deletion/status/${encodeURIComponent(confirmation)}`;
}
export async function refreshSocialChannelIdentity(
  pool: Pool,
  orgId: string,
  config: CoreConfig,
  id: string,
  http: HttpFetch = fetch,
): Promise<SocialChannel> {
  let provider: string | null = null;
  try {
    provider =
      (
        await pool.query<{ platform: string }>(
          'SELECT platform::text AS platform FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2',
          [id, orgId],
        )
      ).rows[0]?.platform ?? null;
  } catch {}
  const attempt = createId(),
    start = performance.now();
  let failure: unknown;
  try {
    return await refreshIdentity(pool, orgId, config, id, http);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (provider)
      try {
        await recordProviderSyncOutcome(
          pool,
          orgId,
          id,
          provider,
          "identity_refresh",
          attempt,
          failure ? "failed" : "succeeded",
          failure instanceof ApiError
            ? providerSyncFailureClass(failure)
            : failure
              ? "internal"
              : "none",
          Math.floor(performance.now() - start),
        );
      } catch {}
  }
}
async function refreshIdentity(
  pool: Pool,
  orgId: string,
  config: CoreConfig,
  id: string,
  http: HttpFetch,
): Promise<SocialChannel> {
  const channel = (
    await pool.query<{
      platform: string;
      displayName: string;
      handle: string | null;
      externalAccountId: string | null;
      accessToken: string | null;
      metadata: unknown;
    }>(
      'SELECT platform::text AS platform,"displayName",handle,"externalAccountId","accessToken",metadata FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2 LIMIT 1',
      [id, orgId],
    )
  ).rows[0];
  if (!channel) throw new ApiError(404, "not_found", "Channel not found");
  if (channel.accessToken === null)
    bad("Reconnect this account to refresh its profile image");
  if (channel.externalAccountId === null)
    bad("This account does not have a provider identity to refresh");
  const token = decryptSocialSecret(config, channel.accessToken!),
    metadata =
      channel.metadata &&
      typeof channel.metadata === "object" &&
      !Array.isArray(channel.metadata)
        ? { ...(channel.metadata as Record<string, unknown>) }
        : {},
    platform = channel.platform;
  let result: Profile;
  let avatar: string;
  let image: string | null | undefined;
  let accountHandle = channel.handle;
  let name = channel.displayName;
  if (platform === "FACEBOOK") {
    const page = metaPage(
      await fetchJson(
        buildUrl(`${META_GRAPH_BASE}/${channel.externalAccountId}`, [
          ["fields", "id,name,username,picture{url}"],
        ]),
        { headers: bearer(token) },
        "Failed to load Facebook Page profile",
        http,
      ),
    );
    result = { name: page.name, username: page.username };
    avatar = "pictureUrl";
    image = page.picture?.data?.url;
  } else if (platform === "INSTAGRAM") {
    result =
      metadata.authMethod === "instagram_login"
        ? await fetchInstagramProfile(token, http)
        : profile(
            await fetchJson(
              buildUrl(`${META_GRAPH_BASE}/${channel.externalAccountId}`, [
                ["fields", "id,username,name,profile_picture_url"],
              ]),
              { headers: bearer(token) },
              "Failed to load Instagram profile",
              http,
            ),
            true,
          );
    avatar = "profilePictureUrl";
    image = result.profile_picture_url;
  } else if (platform === "X") {
    result = await fetchXMe(token, http);
    avatar = "avatarUrl";
    image = result.profile_image_url;
  } else if (platform === "LINKEDIN") {
    result = await fetchLinkedinProfile(token, http);
    avatar = "picture";
    image = result.picture;
  } else bad("This connection does not provide a profile image");
  if (result!.name?.trim()) name = result!.name!;
  if (platform !== "LINKEDIN")
    accountHandle = result!.username?.trim() ? `@${result!.username}` : null;
  if (image!?.trim()) metadata[avatar!] = image;
  await pool.query(
    'UPDATE "SocialChannelConnection" SET "displayName"=$1,handle=$2,metadata=$3,"lastSyncedAt"=NOW(),"updatedAt"=NOW() WHERE id=$4 AND "orgId"=$5',
    [
      name,
      accountHandle,
      JSON.stringify(mergeChannelMetadataWithCapabilities(platform, metadata)),
      id,
      orgId,
    ],
  );
  const saved = await getSocialChannel(pool, orgId, id);
  if (!saved)
    throw new ApiError(
      500,
      "internal_error",
      "Failed to load refreshed social account",
    );
  return saved;
}
