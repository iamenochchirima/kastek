import { createHash, randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import * as auth from "../integrations/provider-auth.js";
import { instagramAppId } from "../integrations/social-oauth.js";
import { instagramScopesForRequest, metaScopesForRequest } from "../integrations/connection-permissions.js";
import * as socialConnections from "../integrations/social-provider-connections.js";
import { recordSyncedSourceHealth, syncOrgConnections } from "../services/connections.js";
import { completeEmbeddedSignup } from "../services/whatsapp/connections.js";
import { growthAgentChannelLinksEnabled } from "./security.js";

type LoginMode = "meta_login" | "instagram_login" | "whatsapp_embedded_signup";
type Intent = Record<string, unknown> & {
  id: string; actorId: string; orgId: string; provider: string; agentsAgentId: string;
  returnRoute: string; loginMode: LoginMode | null; oauthStateHash: string | null;
  oauthStateExpiresAt: Date | null; authorizedAt: Date | null; expiresAt: Date;
};
type OAuthQuery = { code?: string; state?: string; error?: string };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const messagingPermissionKeys = ["MESSAGING_INBOUND", "MESSAGING_OUTBOUND"];

function appOrigin(core: CoreContext): string {
  const value = core.config.env.AGENTS_FRONTEND_URL;
  if (!value) throw new ApiError(503, "agent_channel_return_unavailable", "Agent return address is not configured");
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (core.config.environment.toLowerCase() === "production" && url.protocol !== "https:") ||
    (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new ApiError(503, "agent_channel_return_unavailable", "Agent return address is invalid");
  }
  return url.origin;
}

function returnUrl(core: CoreContext, intent: Intent, result: "connected" | "cancelled" | "failed" | "expired"): string {
  if (!/^\/app\/agents\/[0-9a-f-]{36}\?section=channels$/i.test(intent.returnRoute))
    throw new ApiError(400, "agent_channel_return_invalid", "Agent return path is invalid");
  const url = new URL(intent.returnRoute, appOrigin(core));
  url.searchParams.set("growthChannel", intent.provider);
  url.searchParams.set("growthResult", result);
  url.searchParams.set("growthIntent", intent.id);
  return url.toString();
}

function encodedUrl(origin: string, path: string, params: Array<[string, string]>): string {
  const url = new URL(path, origin);
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

async function requireIntent(core: CoreContext, input: {
  intentId: string; workspaceId: string; agentId: string; actorId: string;
}): Promise<Intent> {
  const row = (await core.pool.query<Intent>(`SELECT * FROM "GrowthAgentChannelLinkIntent"
    WHERE id=$1 AND "agentsWorkspaceId"=$2 AND "agentsAgentId"=$3 AND "actorId"=$4
      AND "expiresAt">now() AND "completedAt" IS NULL`,
  [input.intentId, input.workspaceId, input.agentId, input.actorId])).rows[0];
  if (!row) throw new ApiError(410, "agent_channel_intent_expired", "Start the channel connection again");
  return row;
}

export async function beginGrowthAgentChannelAuthorization(core: CoreContext, input: {
  intentId: string; workspaceId: string; agentId: string; actorId: string; loginMode: LoginMode;
}) {
  const intent = await requireIntent(core, input);
  const isValidMode = intent.provider === "facebook" ? input.loginMode === "meta_login"
    : intent.provider === "instagram" ? ["meta_login", "instagram_login"].includes(input.loginMode)
      : intent.provider === "whatsapp" ? input.loginMode === "whatsapp_embedded_signup" : false;
  if (!isValidMode) throw new ApiError(400, "agent_channel_login_mode_invalid", "Choose a supported sign-in method");

  if (intent.provider === "whatsapp") {
    const appId = core.config.rawEnv.AUTH_META_APP_ID;
    const configurationId = core.config.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID ??
      core.config.env.META_EMBEDDED_SIGNUP_CONFIG_ID ?? core.config.env.VITE_META_EMBEDDED_SIGNUP_CONFIG_ID;
    if (!appId || !configurationId) throw new ApiError(503, "whatsapp_signup_unavailable", "WhatsApp signup is not configured");
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await core.pool.query(`UPDATE "GrowthAgentChannelLinkIntent" SET "loginMode"=$2,"authorizedAt"=NULL,
      "oauthStateHash"=NULL,"oauthStateExpiresAt"=NULL,"updatedAt"=now() WHERE id=$1`,
    [intent.id, input.loginMode]);
    return {
      operation: "oauth.begin" as const, flow: "embedded_signup" as const, intentId: intent.id,
      appId, apiVersion: core.config.env.META_GRAPH_API_VERSION ?? "v23.0", configurationId,
      messageOrigins: ["https://www.facebook.com", "https://web.facebook.com"], expiresAt: expiresAt.toISOString(),
    };
  }

  const state = `agc_${intent.id}_${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await core.pool.query(`UPDATE "GrowthAgentChannelLinkIntent" SET "loginMode"=$2,"authorizedAt"=NULL,
    "oauthStateHash"=$3,"oauthStateExpiresAt"=$4,"updatedAt"=now() WHERE id=$1`,
  [intent.id, input.loginMode, digest(state), expiresAt]);
  const callbackOrigin = core.config.publicApiUrl.replace(/\/+$/, "");
  const authorizationUrl = input.loginMode === "instagram_login"
    ? encodedUrl("https://www.instagram.com", "/oauth/authorize", [
      ["force_reauth", "true"], ["client_id", instagramAppId(core.config)],
      ["redirect_uri", `${callbackOrigin}/api/social/oauth/instagram/callback`], ["response_type", "code"],
      ["scope", instagramScopesForRequest(messagingPermissionKeys).join(",")], ["state", state],
    ])
    : encodedUrl("https://www.facebook.com", "/v23.0/dialog/oauth", [
      ["client_id", core.config.rawEnv.AUTH_META_APP_ID ?? ""],
      ["redirect_uri", `${callbackOrigin}/api/social/oauth/meta/callback`], ["response_type", "code"],
      ["scope", metaScopesForRequest(intent.provider === "facebook" ? "facebook" : "instagram", messagingPermissionKeys).join(",")],
      ["state", state],
    ]);
  if (!core.config.rawEnv.AUTH_META_APP_ID && input.loginMode === "meta_login")
    throw new ApiError(503, "meta_signup_unavailable", "Meta signup is not configured");
  return { operation: "oauth.begin" as const, flow: "oauth" as const, authorizationUrl, expiresAt: expiresAt.toISOString() };
}

async function consumeOAuthState(core: CoreContext, intent: Intent, state: string): Promise<Intent | null> {
  const client = await core.pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<Intent>(`SELECT * FROM "GrowthAgentChannelLinkIntent" WHERE id=$1 FOR UPDATE`, [intent.id])).rows[0];
    if (!row || row.oauthStateHash !== digest(state) || !row.oauthStateExpiresAt ||
      new Date(row.oauthStateExpiresAt).getTime() <= Date.now() || new Date(row.expiresAt).getTime() <= Date.now() ||
      row.authorizedAt || row.completedAt) {
      await client.query("ROLLBACK");
      return null;
    }
    const claimed = (await client.query<Intent>(`UPDATE "GrowthAgentChannelLinkIntent"
      SET "oauthStateHash"=NULL,"oauthStateExpiresAt"=NULL,"updatedAt"=now() WHERE id=$1 RETURNING *`, [intent.id])).rows[0];
    await client.query("COMMIT");
    return claimed ?? null;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function completeMetaLogin(core: CoreContext, intent: Intent, code: string): Promise<void> {
  const short = await auth.exchangeMetaCodeForTokens(core.config, code);
  if (!short.access_token) throw new ApiError(400, "meta_token_missing", "Meta did not return an access token");
  let tokens = short;
  try { tokens = await auth.exchangeMetaForLongLivedToken(core.config, short.access_token); } catch { /* Keep the valid short-lived token; Growth refresh handles it when supported. */ }
  const grants = await auth.fetchMetaPermissions(core.config, tokens.access_token! ).catch(() => null);
  const pages = await auth.fetchMetaPages(tokens.access_token!);
  const facebook = intent.provider === "facebook";
  const channels = await socialConnections.upsertMetaConnectionsForOrg(
    core.pool, core.config, intent.actorId, intent.orgId, tokens, pages, grants, facebook, !facebook,
    (token, pageId) => auth.fetchPageInstagramAccount(token, pageId),
  );
  await syncOrgConnections(core.pool, intent.orgId);

  let pageAppError: unknown = null, instagramAppError: unknown = null;
  if (facebook) {
    try { await auth.subscribeMetaPageAppWebhooks(core.config); } catch (error) { pageAppError = error; }
  } else {
    try { await auth.subscribeMetaInstagramAppWebhooks(core.config); } catch (error) { instagramAppError = error; }
  }
  for (const page of pages) {
    if (!page.access_token) continue;
    let pageError: unknown = null;
    if (facebook) try { await auth.subscribeMetaPageWebhooks(page.access_token, page.id); } catch (error) { pageError = error; }
    const matching = channels.filter(channel => channel.external_account_id === page.id ||
      (channel.metadata as Record<string, unknown> | null)?.pageId === page.id);
    for (const channel of matching) {
      const failure = pageError ?? pageAppError ?? instagramAppError;
      await recordSyncedSourceHealth(core.pool, intent.orgId, "SOCIAL", channel.id, failure === null,
        failure === null ? "ACTIVE" : "FAILED", failure === null ? null : "Provider webhook subscription needs attention");
    }
  }
}

async function completeInstagramLogin(core: CoreContext, intent: Intent, code: string): Promise<void> {
  const short = await auth.exchangeInstagramCodeForToken(core.config, code);
  if (!short.access_token) throw new ApiError(400, "instagram_token_missing", "Instagram did not return an access token");
  const tokens = await auth.exchangeInstagramForLongLivedToken(core.config, short.access_token);
  if (!tokens.access_token) throw new ApiError(400, "instagram_token_missing", "Instagram did not return an access token");
  const accessToken = tokens.access_token;
  if (!accessToken) throw new ApiError(400, "instagram_token_missing", "Instagram did not return an access token");
  const profile = await auth.fetchInstagramProfile(accessToken);
  const channel = await socialConnections.upsertInstagramConnectionForOrg(
    core.pool, core.config, intent.actorId, intent.orgId, tokens, short.permissions ?? null, profile,
  );
  await syncOrgConnections(core.pool, intent.orgId);
  let webhookError: unknown = null;
  if (channel.external_account_id) try { await auth.subscribeInstagramWebhooks(accessToken, channel.external_account_id); }
  catch (error) { webhookError = error; }
  await recordSyncedSourceHealth(core.pool, intent.orgId, "SOCIAL", channel.id, webhookError === null,
    webhookError === null ? "ACTIVE" : "FAILED", webhookError === null ? null : "Provider webhook subscription needs attention");
}

/** Handles the Growth callback for an Agent-started authorization without a Growth browser session. */
export async function completeGrowthAgentChannelOAuth(
  core: CoreContext, providerRoute: string, query: OAuthQuery, request: FastifyRequest,
): Promise<string | null> {
  const state = query.state;
  if (!state?.startsWith("agc_")) return null;
  request.log.info({ event: "growth.agent_channel.oauth_callback", provider: providerRoute }, "Agent channel authorization returned");
  const match = /^agc_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$/i.exec(state);
  const intentId = match?.[1] ?? "";
  const intent = (await core.pool.query<Intent>(`SELECT * FROM "GrowthAgentChannelLinkIntent" WHERE id=$1`, [intentId])).rows[0];
  if (!intent) {
    const fallback = new URL("/app/agents", appOrigin(core));
    fallback.searchParams.set("growthResult", "expired");
    return fallback.toString();
  }
  if (!growthAgentChannelLinksEnabled(core.config)) {
    await core.pool.query(`UPDATE "GrowthAgentChannelLinkIntent" SET "oauthStateHash"=NULL,"oauthStateExpiresAt"=NULL,"updatedAt"=now()
      WHERE id=$1 AND "oauthStateHash"=$2`, [intent.id, digest(state)]);
    request.log.warn({ event: "growth.agent_channel.oauth.blocked", provider: intent.provider,
      error_code: "agent_channel_links_disabled" });
    return returnUrl(core, intent, "failed");
  }
  const expectedRoute = intent.provider === "instagram" && intent.loginMode === "instagram_login" ? "instagram" : "meta";
  if (providerRoute !== expectedRoute || !/^[0-9a-f-]{36}$/i.test(intentId))
    return returnUrl(core, intent, "failed");
  if (query.error) {
    await core.pool.query(`UPDATE "GrowthAgentChannelLinkIntent" SET "oauthStateHash"=NULL,"oauthStateExpiresAt"=NULL,"updatedAt"=now()
      WHERE id=$1 AND "oauthStateHash"=$2`, [intent.id, digest(state)]);
    return returnUrl(core, intent, "cancelled");
  }
  if (!query.code) return returnUrl(core, intent, "failed");
  const claimed = await consumeOAuthState(core, intent, state);
  if (!claimed) return returnUrl(core, intent, "expired");
  try {
    if (claimed.loginMode === "instagram_login") await completeInstagramLogin(core, claimed, query.code);
    else await completeMetaLogin(core, claimed, query.code);
    await core.pool.query(`UPDATE "GrowthAgentChannelLinkIntent" SET "authorizedAt"=now(),"updatedAt"=now()
      WHERE id=$1 AND "actorId"=$2 AND "completedAt" IS NULL`, [claimed.id, claimed.actorId]);
    return returnUrl(core, claimed, "connected");
  } catch (error) {
    request.log.warn({ event: "growth.agent_channel.oauth_failed", provider: claimed.provider,
      errorType: error instanceof Error ? error.name : "unknown" }, "Agent channel authorization could not be completed");
    return returnUrl(core, claimed, "failed");
  }
}

export async function completeGrowthAgentWhatsAppSignup(core: CoreContext, input: {
  intentId: string; workspaceId: string; agentId: string; actorId: string;
  code: string; wabaId: string; phoneNumberId: string;
}) {
  const intent = await requireIntent(core, input);
  if (intent.provider !== "whatsapp" || intent.loginMode !== "whatsapp_embedded_signup")
    throw new ApiError(409, "whatsapp_signup_not_started", "Start WhatsApp signup again");
  if (intent.authorizedAt) return { operation: "whatsapp.complete" as const, authorized: true as const };
  await completeEmbeddedSignup(core.pool, input.actorId, intent.orgId, input.code, input.wabaId,
    input.phoneNumberId, { config: core.config });
  await syncOrgConnections(core.pool, intent.orgId);
  await core.pool.query(`UPDATE "GrowthAgentChannelLinkIntent" SET "authorizedAt"=now(),"updatedAt"=now()
    WHERE id=$1 AND "actorId"=$2 AND "completedAt" IS NULL`, [intent.id, input.actorId]);
  return { operation: "whatsapp.complete" as const, authorized: true as const };
}
