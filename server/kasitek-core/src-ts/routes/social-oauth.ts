import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireAdmin } from "../services/orgs.js";
import { bad, internal, trimmed } from "../services/social/common.js";
import * as oauth from "../integrations/social-oauth.js";
import * as auth from "../integrations/provider-auth.js";
import * as connections from "../integrations/social-provider-connections.js";
import * as permissions from "../integrations/connection-permissions.js";
import { authMode } from "../integrations/provider-permissions.js";
import * as bluesky from "../integrations/bluesky-oauth.js";
import {
  syncOrgConnections,
  recordSyncedSourceHealth,
} from "../services/connections.js";
import { ApiError } from "../error.js";
interface StartQuery {
  connectionId?: string;
  capabilities?: string;
  target?: string;
  handle?: string;
}
interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
  iss?: string;
}
const cookie = (provider: string) => `kasitek_social_${provider}_state`;
async function scope(request: FastifyRequest, core: CoreContext) {
  const user = await extractUser(request, core),
    org = await resolveActiveOrgId(request, core, user.id);
  await requireAdmin(core.pool, org, user.id);
  return { user, org };
}
function setCookie(
  reply: FastifyReply,
  core: CoreContext,
  name: string,
  value: string,
) {
  reply.setCookie(name, value, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: core.config.environment.toLowerCase() === "production",
  });
}
function clearCookie(reply: FastifyReply, name: string) {
  reply.setCookie(name, "", { path: "/", maxAge: 0 });
}
const redirect = (reply: FastifyReply, url: string) =>
  reply.code(302).header("Location", url).send();
function warn(
  request: FastifyRequest,
  provider: string,
  operation: string,
  error: unknown,
) {
  request.log.warn(
    {
      event: "provider.call.failed",
      provider,
      operation,
      error_type: error instanceof Error ? error.name : "unknown",
    },
    "provider operation failed",
  );
}
async function prepare(
  core: CoreContext,
  org: string,
  user: string,
  query: StartQuery,
  provider: string,
  target: string,
  state: string,
) {
  const requested =
    query.connectionId !== undefined
      ? permissions.parseRequestedCapabilities(query.capabilities)
      : permissions.normalizeRequestedCapabilities(query.capabilities);
  if (query.connectionId === undefined)
    return { state, attempt: null, requested };
  const plan = await permissions.planAccessRequest(
    core.pool,
    org,
    query.connectionId,
    requested,
  );
  if (plan.context.provider.toUpperCase() !== provider)
    throw bad("The access request provider does not match the connection");
  const attempt = await permissions.createAuthorizationAttempt(
    core.pool,
    org,
    user,
    query.connectionId,
    plan.context.provider,
    authMode(plan.adapter),
    target,
    plan.effectiveCapabilities,
    state,
  );
  return { state, attempt, requested: attempt.requestedCapabilities };
}
async function finish(
  core: CoreContext,
  org: string,
  user: string,
  state: string | undefined,
  provider: string,
  status: string,
  failure: string | null,
) {
  if (state === undefined) return null;
  const attempt = await permissions.findAuthorizationAttempt(
    core.pool,
    org,
    user,
    state,
  );
  if (!attempt) return null;
  if (attempt.provider.toUpperCase() !== provider)
    throw bad("OAuth state does not match the requested provider");
  await permissions.finishAuthorizationAttempt(
    core.pool,
    attempt.id,
    status,
    failure,
  );
  return attempt;
}
function validateCallback(
  request: FastifyRequest,
  provider: string,
  query: CallbackQuery,
) {
  const title =
    provider === "instagram"
      ? "Instagram "
      : provider === "threads"
        ? "Threads "
        : provider === "tiktok"
          ? "TikTok "
          : "";
  if (provider === "threads" || provider === "tiktok") {
    if (
      query.state === undefined ||
      request.cookies[cookie(provider)] !== query.state
    )
      throw bad(`Invalid ${title}OAuth state`);
    if (query.code === undefined) throw bad(`Missing ${title}OAuth code`);
  } else {
    if (query.code === undefined) throw bad(`Missing ${title}OAuth code`);
    if (
      query.state === undefined ||
      request.cookies[cookie(provider)] !== query.state
    )
      throw bad(`Invalid ${title}OAuth state`);
  }
  return { code: query.code!, state: query.state! };
}
export function registerSocialOAuthRoutes(
  app: FastifyInstance,
  core: CoreContext,
): void {
  for (const provider of ["x", "linkedin", "threads", "tiktok"] as const) {
    app.get(`/api/social/oauth/${provider}/start`, async (request, reply) => {
      const { user, org } = await scope(request, core),
        query = request.query as StartQuery,
        x = provider === "x" ? oauth.createXOAuthState() : null,
        state = x?.state ?? oauth.createLinkedinOAuthState();
      let organization = false;
      if (provider === "linkedin" && query.connectionId !== undefined)
        organization =
          (
            await permissions.getConnectionAccessContext(
              core.pool,
              org,
              query.connectionId,
            )
          ).metadata?.accountType === "organization";
      const prepared = await prepare(
        core,
        org,
        user.id,
        query,
        provider.toUpperCase(),
        provider,
        state,
      );
      const url =
        provider === "x"
          ? oauth.buildXAuthorizeUrl(
              core.config,
              prepared.state,
              x!.challenge,
              prepared.requested,
            )
          : provider === "linkedin"
            ? oauth.buildLinkedinAuthorizeUrl(
                core.config,
                prepared.state,
                prepared.requested,
                organization,
              )
            : provider === "threads"
              ? oauth.buildThreadsAuthorizeUrl(
                  core.config,
                  prepared.state,
                  prepared.requested,
                )
              : oauth.buildTiktokAuthorizeUrl(
                  core.config,
                  prepared.state,
                  prepared.requested,
                );
      setCookie(reply, core, cookie(provider), prepared.state);
      if (x) setCookie(reply, core, "kasitek_social_x_verifier", x.verifier);
      return redirect(reply, url);
    });
  }
  for (const provider of ["meta", "instagram"] as const) {
    app.get(`/api/social/oauth/${provider}/start`, async (request, reply) => {
      const { user, org } = await scope(request, core),
        query = request.query as StartQuery,
        target =
          provider === "instagram" ? "instagram" : (query.target ?? "facebook");
      if (!["facebook", "instagram"].includes(target))
        throw bad("Meta connection target must be facebook or instagram");
      const requested =
        query.connectionId !== undefined
          ? permissions.parseRequestedCapabilities(query.capabilities)
          : permissions.normalizeRequestedCapabilities(query.capabilities);
      let state = oauth.createMetaOAuthState(),
        effective = requested;
      if (query.connectionId !== undefined) {
        const plan = await permissions.planAccessRequest(
            core.pool,
            org,
            query.connectionId,
            requested,
          ),
          mode = authMode(plan.adapter);
        if (provider === "instagram") {
          if (
            plan.context.provider !== "INSTAGRAM" ||
            mode !== "instagram_login"
          )
            throw bad(
              "This connection must be authorized through Instagram Login",
            );
        } else if (
          plan.context.provider !==
            (target === "facebook" ? "FACEBOOK" : "INSTAGRAM") ||
          mode !== "meta_login"
        )
          throw bad(
            "The access request target does not match the connection authorization mode",
          );
        const attempt = await permissions.createAuthorizationAttempt(
          core.pool,
          org,
          user.id,
          query.connectionId,
          plan.context.provider,
          mode,
          target,
          plan.effectiveCapabilities,
        );
        state = attempt.state;
        effective = attempt.requestedCapabilities;
      }
      const url =
        provider === "meta"
          ? oauth.buildMetaAuthorizeUrl(core.config, state, target, effective)
          : oauth.buildInstagramAuthorizeUrl(core.config, state, effective);
      setCookie(reply, core, cookie(provider), state);
      if (provider === "meta")
        setCookie(reply, core, "kasitek_social_meta_target", target);
      return redirect(reply, url);
    });
  }
  for (const provider of [
    "x",
    "linkedin",
    "threads",
    "tiktok",
    "meta",
    "instagram",
  ] as const) {
    app.get(
      `/api/social/oauth/${provider}/callback`,
      async (request, reply) => {
        const { user, org } = await scope(request, core),
          query = request.query as CallbackQuery;
        if (query.error !== undefined) {
          if (provider === "meta" || provider === "instagram") {
            if (query.state !== undefined) {
              const attempt = await permissions.findAuthorizationAttempt(
                core.pool,
                org,
                user.id,
                query.state,
              );
              if (attempt)
                await permissions.finishAuthorizationAttempt(
                  core.pool,
                  attempt.id,
                  "DECLINED",
                  "provider_denied",
                );
            }
          } else
            await finish(
              core,
              org,
              user.id,
              query.state,
              provider.toUpperCase(),
              "DECLINED",
              "provider_denied",
            );
          if (provider === "linkedin") clearCookie(reply, cookie(provider));
          return redirect(
            reply,
            `${core.config.frontendUrl}/connections?error=${encodeURIComponent(query.error_description ?? query.error)}`,
          );
        }
        const { code, state } = validateCallback(request, provider, query);
        let url: string;
        if (provider === "x") {
          const verifier = request.cookies.kasitek_social_x_verifier;
          if (verifier === undefined) throw bad("Invalid OAuth state");
          const tokens = await auth.exchangeXCodeForTokens(
            core.config,
            code,
            verifier,
          );
          if (tokens.access_token == null) throw bad("Missing X access token");
          const profile = await auth.fetchXMe(tokens.access_token);
          await connections.upsertXConnectionForOrg(
            core.pool,
            core.config,
            user.id,
            org,
            tokens,
            profile,
          );
          const attempt = await finish(
            core,
            org,
            user.id,
            state,
            "X",
            "COMPLETED",
            null,
          );
          url = `${core.config.frontendUrl}/connections?connected=x${attempt ? "&access=granted" : ""}`;
          clearCookie(reply, "kasitek_social_x_verifier");
        } else if (provider === "linkedin") {
          let tokens: Awaited<
            ReturnType<typeof auth.exchangeLinkedinCodeForTokens>
          >;
          try {
            tokens = await auth.exchangeLinkedinCodeForTokens(
              core.config,
              code,
            );
          } catch (error) {
            warn(request, "linkedin", "oauth.token_exchange", error);
            if (error instanceof ApiError && error.status === 400)
              throw bad(`LinkedIn token exchange failed: ${error.message}`);
            throw error;
          }
          if (tokens.access_token == null)
            throw bad("Missing LinkedIn access token");
          let profile: Awaited<ReturnType<typeof auth.fetchLinkedinProfile>>;
          try {
            profile = await auth.fetchLinkedinProfile(tokens.access_token);
          } catch (error) {
            warn(request, "linkedin", "oauth.profile_lookup", error);
            if (error instanceof ApiError && error.status === 400)
              throw bad(`LinkedIn profile lookup failed: ${error.message}`);
            throw error;
          }
          let pages: Awaited<ReturnType<typeof auth.fetchLinkedinPages>> = [],
            unavailable = false;
          if (
            oauth.linkedinOrganizationScopesConfigured(core.config) ||
            tokens.scope
              ?.split(/\s+/)
              .some((value) =>
                ["r_organization_admin", "w_organization_social"].includes(
                  value,
                ),
              )
          ) {
            try {
              pages = await auth.fetchLinkedinPages(tokens.access_token);
            } catch (error) {
              unavailable = true;
              warn(request, "linkedin", "oauth.page_discovery", error);
            }
          }
          await connections.upsertLinkedinConnectionForOrg(
            core.pool,
            core.config,
            user.id,
            org,
            tokens,
            profile,
          );
          const pageChannels =
            await connections.upsertLinkedinPageConnectionsForOrg(
              core.pool,
              core.config,
              user.id,
              org,
              tokens,
              pages,
            );
          await syncOrgConnections(core.pool, org);
          const attempt = await finish(
            core,
            org,
            user.id,
            state,
            "LINKEDIN",
            "COMPLETED",
            null,
          );
          url = `${core.config.frontendUrl}/connections?connected=linkedin&pages_count=${pageChannels.length}&pages_status=${unavailable ? "unavailable" : "ready"}&access=${attempt ? "granted" : "connected"}`;
        } else if (provider === "threads") {
          const tokens = await auth.exchangeThreadsCodeForToken(
            core.config,
            code,
          );
          if (tokens.access_token == null)
            throw bad("Missing Threads access token");
          const profile = await auth.fetchThreadsProfile(tokens.access_token),
            attempt = await permissions.findAuthorizationAttempt(
              core.pool,
              org,
              user.id,
              state,
            );
          if (attempt && attempt.provider.toUpperCase() !== "THREADS")
            throw bad("OAuth state does not match the requested provider");
          const scopes = oauth.threadsScopesForRequest(
            core.config,
            attempt?.requestedCapabilities ?? [],
          );
          await connections.upsertThreadsConnectionForOrg(
            core.pool,
            core.config,
            user.id,
            org,
            tokens,
            profile,
            scopes.length ? scopes.join(" ") : null,
          );
          await syncOrgConnections(core.pool, org);
          const finished = await finish(
            core,
            org,
            user.id,
            state,
            "THREADS",
            "COMPLETED",
            null,
          );
          url = `${core.config.frontendUrl}/connections?connected=threads${finished ? "&access=granted" : ""}`;
        } else if (provider === "tiktok") {
          const tokens = await auth.exchangeTiktokCodeForTokens(
            core.config,
            code,
          );
          if (tokens.access_token == null)
            throw bad("Missing TikTok access token");
          const profile = await auth.fetchTiktokProfile(tokens.access_token);
          await connections.upsertTiktokConnectionForOrg(
            core.pool,
            core.config,
            user.id,
            org,
            tokens,
            profile,
          );
          await syncOrgConnections(core.pool, org);
          const attempt = await finish(
            core,
            org,
            user.id,
            state,
            "TIKTOK",
            "COMPLETED",
            null,
          );
          url = `${core.config.frontendUrl}/connections?connected=tiktok${attempt ? "&access=granted" : ""}`;
        } else if (provider === "instagram") {
          const attempt = await permissions.findAuthorizationAttempt(
              core.pool,
              org,
              user.id,
              state,
            ),
            short = await auth.exchangeInstagramCodeForToken(core.config, code);
          if (short.access_token == null)
            throw bad("Missing Instagram access token");
          const tokens = await auth.exchangeInstagramForLongLivedToken(
            core.config,
            short.access_token,
          );
          if (tokens.access_token == null)
            throw bad("Missing Instagram access token");
          const profile = await auth.fetchInstagramProfile(tokens.access_token),
            channel = await connections.upsertInstagramConnectionForOrg(
              core.pool,
              core.config,
              user.id,
              org,
              tokens,
              short.permissions ?? null,
              profile,
            );
          await syncOrgConnections(core.pool, org);
          if (channel.external_account_id === null)
            throw internal(
              "Saved Instagram connection is missing an account ID",
            );
          let error: unknown = null;
          try {
            await auth.subscribeInstagramWebhooks(
              tokens.access_token,
              channel.external_account_id,
            );
          } catch (failure) {
            error = failure;
            warn(request, "instagram", "account_webhooks.subscribe", failure);
          }
          await recordSyncedSourceHealth(
            core.pool,
            org,
            "SOCIAL",
            channel.id,
            error === null,
            error === null ? "ACTIVE" : "FAILED",
            error === null
              ? null
              : error instanceof Error
                ? error.message
                : String(error),
          );
          if (attempt)
            await permissions.finishAuthorizationAttempt(
              core.pool,
              attempt.id,
              "COMPLETED",
              null,
            );
          url = `${core.config.frontendUrl}/connections?connected=instagram&access=${attempt ? "granted" : "connected"}`;
        } else {
          const attempt = await permissions.findAuthorizationAttempt(
              core.pool,
              org,
              user.id,
              state,
            ),
            target =
              attempt?.target ??
              request.cookies.kasitek_social_meta_target ??
              "facebook";
          if (!["facebook", "instagram"].includes(target))
            throw bad("Invalid Meta connection target");
          const short = await auth.exchangeMetaCodeForTokens(core.config, code);
          if (short.access_token == null)
            throw bad("Missing Meta access token");
          let tokens = short;
          try {
            tokens = await auth.exchangeMetaForLongLivedToken(
              core.config,
              short.access_token,
            );
          } catch {}
          if (tokens.access_token == null)
            throw bad("Missing Meta access token");
          let grants: string[] | null = null;
          try {
            grants = await auth.fetchMetaPermissions(
              core.config,
              tokens.access_token,
            );
          } catch (error) {
            warn(request, "meta", "oauth.permissions.inspect", error);
          }
          const pages = await auth.fetchMetaPages(tokens.access_token),
            connected = await connections.upsertMetaConnectionsForOrg(
              core.pool,
              core.config,
              user.id,
              org,
              tokens,
              pages,
              grants,
              target === "facebook",
              target === "instagram",
              auth.fetchPageInstagramAccount,
            ),
            facebookCount = connected.filter(
              (channel) => channel.platform === "FACEBOOK",
            ).length,
            instagramCount = connected.filter(
              (channel) => channel.platform === "INSTAGRAM",
            ).length;
          await syncOrgConnections(core.pool, org);
          let pageAppError: unknown = null,
            instagramAppError: unknown = null;
          if (facebookCount > 0)
            try {
              await auth.subscribeMetaPageAppWebhooks(core.config);
            } catch (error) {
              pageAppError = error;
              warn(request, "meta", "page_app_webhooks.configure", error);
            }
          if (target === "instagram" && instagramCount > 0)
            try {
              await auth.subscribeMetaInstagramAppWebhooks(core.config);
            } catch (error) {
              instagramAppError = error;
              warn(request, "meta", "instagram_app_webhooks.configure", error);
            }
          for (const page of pages) {
            if (page.access_token == null) continue;
            let error: unknown = null;
            try {
              await auth.subscribeMetaPageWebhooks(page.access_token, page.id);
            } catch (failure) {
              error = failure;
              warn(request, "meta", "page_webhooks.subscribe", failure);
            }
            for (const channel of connected.filter(
              (channel) =>
                channel.external_account_id === page.id ||
                (channel.metadata as Record<string, unknown> | null)?.pageId ===
                  page.id,
            )) {
              const failure =
                error ??
                (channel.platform === "INSTAGRAM"
                  ? instagramAppError
                  : pageAppError);
              await recordSyncedSourceHealth(
                core.pool,
                org,
                "SOCIAL",
                channel.id,
                failure === null,
                failure === null ? "ACTIVE" : "FAILED",
                failure === null
                  ? null
                  : failure instanceof Error
                    ? failure.message
                    : String(failure),
              );
            }
          }
          if (attempt)
            await permissions.finishAuthorizationAttempt(
              core.pool,
              attempt.id,
              "COMPLETED",
              null,
            );
          url = `${core.config.frontendUrl}/connections?connected=meta&facebook_count=${facebookCount}&instagram_count=${instagramCount}&access=${attempt ? "granted" : "connected"}`;
          clearCookie(reply, "kasitek_social_meta_target");
        }
        clearCookie(reply, cookie(provider));
        return redirect(reply, url);
      },
    );
  }
  app.get(
    "/api/social/oauth/bluesky/client-metadata",
    async (_request, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .type("application/json")
        .send(bluesky.clientMetadata(core.config)),
  );
  app.get("/api/social/oauth/bluesky/readiness", async (request) => {
    await scope(request, core);
    await bluesky.verifyPublicClientMetadata(core.config);
    return {
      ready: true,
      clientMetadataUrl: bluesky.clientId(core.config),
      callbackUrl: bluesky.callbackUrl(core.config),
    };
  });
  app.get("/api/social/oauth/bluesky/start", async (request, reply) => {
    const { user, org } = await scope(request, core),
      query = request.query as StartQuery,
      handle = trimmed(query.handle);
    if (handle === null) throw bad("Bluesky handle is required");
    const prepared =
      query.connectionId !== undefined
        ? await prepare(
            core,
            org,
            user.id,
            query,
            "BLUESKY",
            "bluesky",
            bluesky.createAuthorizationState(),
          )
        : null;
    const url = await bluesky.startWithState(
      core.pool,
      core.config,
      user.id,
      org,
      handle,
      prepared?.state ?? null,
      prepared?.requested ??
        permissions.normalizeRequestedCapabilities(query.capabilities),
    );
    return redirect(reply, url);
  });
  app.get("/api/social/oauth/bluesky/callback", async (request, reply) => {
    const query = request.query as CallbackQuery;
    if (query.error !== undefined)
      throw bad(
        query.error_description ??
          `Bluesky authorization failed: ${query.error}`,
      );
    if (query.state === undefined) throw bad("Missing Bluesky OAuth state");
    if (query.code === undefined) throw bad("Missing Bluesky OAuth code");
    if (query.iss === undefined) throw bad("Missing Bluesky OAuth issuer");
    const authorization = await bluesky.complete(
      core.pool,
      core.config,
      query.state,
      query.code,
      query.iss,
    );
    await connections.upsertBlueskyOAuthConnectionForOrg(
      core.pool,
      core.config,
      authorization,
    );
    await syncOrgConnections(core.pool, authorization.orgId);
    const attempt = await finish(
      core,
      authorization.orgId,
      authorization.userId,
      query.state,
      "BLUESKY",
      "COMPLETED",
      null,
    );
    return redirect(
      reply,
      `${core.config.frontendUrl}/connections?connected=bluesky${attempt ? "&access=granted" : ""}`,
    );
  });
}
