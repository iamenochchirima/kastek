import { z } from "zod";
import type { ActionScope } from "../../../contracts/connections";
import { ChannelStore } from "../channel-store";
import { MetaSetupSessions, setupFailure } from "./sessions";
import { MetaSetupProvider, metaSetupProfileDigest, metaSetupProfileSchema, metaIdentifier, type MetaSetupProfile, type SetupAuthorization, type PrivateSetupAsset } from "./provider";
import { MetaSetupClaims } from "./claims";
import { channelPolicyReadiness } from "../channel-policy";
import { PlatformError } from "../../../contracts/contracts";

export { MetaSetupSessions } from "./sessions";
export { MetaSetupProvider, metaSetupProfileDigest, metaSetupProfileSchema } from "./provider";
export type { MetaSetupProfile, SetupAsset, SetupAuthorization } from "./provider";
const ticket = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const authorizationSchema = z.strictObject({ accessToken: z.string().min(1).max(16384), expiresAt: z.iso.datetime().optional(), issuedAt: z.iso.datetime().optional(), wabaId: z.string().optional() });

export class MetaChannelSetup {
  private readonly profiles: readonly MetaSetupProfile[];
  constructor(private readonly channels: ChannelStore, private readonly sessions: MetaSetupSessions,
    profiles: readonly MetaSetupProfile[], private readonly transport: typeof fetch) {
    this.profiles = profiles.map(profile => metaSetupProfileSchema.parse(profile));
    if (new Set(this.profiles.map(profile => `${profile.kind}:${profile.mode}`)).size !== profiles.length) throw setupFailure("CHANNEL_SETUP_CONFIGURATION_INVALID", 503);
  }
  /** Safe for customer catalogue/readiness responses. Secrets and private configuration never leave this service. */
  readiness() { return this.profiles.map(({ kind, mode, humanAgentApproved, instagramRefreshReviewed }) => ({ kind, mode, available: true,
    policy: channelPolicyReadiness(kind, mode, humanAgentApproved, kind === "instagram" && mode === "instagram_login"),
    refresh: mode === "instagram_login" && instagramRefreshReviewed ? "eligible_long_lived_only" : "reconnect" })); }
  private provider(kind: string, mode: string): MetaSetupProvider {
    const profile = this.profiles.find(item => item.kind === kind && item.mode === mode);
    if (!profile) throw setupFailure("CHANNEL_SETUP_NOT_CONFIGURED", 503);
    return new MetaSetupProvider(profile, this.transport);
  }
  private async connection(scope: ActionScope, id: string) {
    const connection = await this.channels.get(scope, id);
    if (connection.metadata.evaluationFixture || connection.metadata.evaluationTrialId) throw setupFailure("CHANNEL_EVALUATION_FIXTURE_LIVE_IO_DENIED", 403);
    return connection;
  }
  currentProfileDigest(kind: string, mode: string): string { return metaSetupProfileDigest(this.provider(kind, mode).profile); }
  async begin(scope: ActionScope, sessionId: string, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), expectedRevision: z.number().int().positive() }).parse(raw);
    const connection = await this.connection(scope, input.connectionId), provider = this.provider(connection.kind, connection.mode), p = provider.profile;
    if (connection.revision !== input.expectedRevision) throw setupFailure("CHANNEL_CONNECTION_CHANGED", 409);
    const state = await this.sessions.issue(scope, sessionId, connection.id, connection.revision, "authorization", { profileDigest: metaSetupProfileDigest(p) });
    if (connection.kind === "whatsapp") return { flow: "embedded_signup" as const, state, appId: p.appId, apiVersion: p.apiVersion,
      configurationId: p.embeddedConfigurationId!, responseType: "code", overrideDefaultResponseType: true,
      extras: { setup: {}, sessionInfoVersion: "3" }, messageOrigins: ["https://www.facebook.com", "https://web.facebook.com"] };
    const url = new URL(connection.mode === "instagram_login" ? "https://www.instagram.com/oauth/authorize" : `https://www.facebook.com/${p.apiVersion}/dialog/oauth`);
    url.search = new URLSearchParams({ client_id: p.appId, redirect_uri: p.redirectUri, response_type: "code", scope: p.scopes.join(","), state }).toString();
    return { flow: "oauth" as const, state, authorizationUrl: url.href };
  }
  async complete(scope: ActionScope, sessionId: string, raw: unknown) {
    const input = z.strictObject({ state: ticket, code: z.string().min(1).max(8192), wabaId: z.string().optional() }).parse(raw);
    const attempt = await this.sessions.read(scope, sessionId, input.state, "authorization", true);
    const connection = await this.connection(scope, attempt.connectionId), provider = this.provider(connection.kind, connection.mode);
    if (attempt.payload.profileDigest !== metaSetupProfileDigest(provider.profile)) throw setupFailure("CHANNEL_SETUP_CONFIGURATION_CHANGED", 409);
    const authorization = await provider.exchange(input.code, input.wabaId);
    return { ticket: await this.sessions.issue(scope, sessionId, connection.id, attempt.revision, "selection", { authorization, profileDigest: metaSetupProfileDigest(provider.profile) }), connectionId: connection.id };
  }
  async manual(scope: ActionScope, sessionId: string, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), expectedRevision: z.number().int().positive(), accessToken: z.string().min(1).max(16384), wabaId: z.string().min(1).max(512) }).parse(raw);
    const connection = await this.connection(scope, input.connectionId), provider = this.provider(connection.kind, connection.mode);
    // Authorize owner/session/revision before consuming any provider request with the supplied token.
    const state = await this.sessions.issue(scope, sessionId, connection.id, input.expectedRevision, "authorization", { manual: true });
    await this.sessions.read(scope, sessionId, state, "authorization", true);
    const authorization = await provider.manual(input.accessToken, input.wabaId);
    return { ticket: await this.sessions.issue(scope, sessionId, connection.id, input.expectedRevision, "selection", { authorization, profileDigest: metaSetupProfileDigest(provider.profile) }), connectionId: connection.id };
  }
  private async selection(scope: ActionScope, sessionId: string, key: string, consume = false) {
    const attempt = await this.sessions.read(scope, sessionId, key, "selection", consume), connection = await this.connection(scope, attempt.connectionId);
    const provider = this.provider(connection.kind, connection.mode);
    if (attempt.payload.profileDigest !== metaSetupProfileDigest(provider.profile)) throw setupFailure("CHANNEL_SETUP_CONFIGURATION_CHANGED", 409);
    return { attempt, connection, provider, authorization: authorizationSchema.parse(attempt.payload.authorization) as SetupAuthorization };
  }
  async discover(scope: ActionScope, sessionId: string, raw: unknown) {
    const input = z.strictObject({ ticket, cursor: z.string().min(1).max(2048).optional() }).parse(raw);
    const { provider, authorization } = await this.selection(scope, sessionId, input.ticket);
    const page = await provider.discover(authorization, input.cursor);
    return { assets: page.assets.map(({ credential: _credential, ...asset }) => asset), nextCursor: page.nextCursor };
  }
  async select(scope: ActionScope, sessionId: string, raw: unknown) {
    const input = z.strictObject({ ticket, assetId: z.string().min(1).max(512), registrationPin: z.string().regex(/^\d{6}$/).optional() }).parse(raw);
    const { attempt, connection, provider, authorization } = await this.selection(scope, sessionId, input.ticket, true);
    const asset = await provider.select(authorization, metaIdentifier(input.assetId));
    const claims = new MetaSetupClaims(this.channels.pool), claim = await claims.acquire(scope, connection.id, attempt.revision, provider.profile.appId, provider.subscriptionTarget(asset.id, asset.metadata));
    let dispatched = false;
    try {
      await provider.subscribe(asset, input.registrationPin, async () => { await claims.fence(scope, claim); dispatched = true; });
      // Existing ChannelStore fences activation/reconnect and encrypts credentials against the exact selected asset.
      await claims.fence(scope, claim);
      const selected = await this.activate(scope, connection.id, attempt.revision, provider, asset, authorization);
      await claims.finish(scope, claim, "complete"); return selected;
    } catch (error) { await claims.finish(scope, claim, dispatched ? "uncertain" : "complete"); throw error; }
  }
  private activate(scope: ActionScope, id: string, revision: number, provider: MetaSetupProvider, asset: PrivateSetupAsset, authorization: SetupAuthorization) {
    const credentials = { accessToken: asset.credential, appSecret: provider.profile.appSecret, verifyToken: provider.profile.webhookVerifyToken };
    return this.channels.update(scope, id, { expectedRevision: revision, assetId: asset.id, credentials, state: "active",
      metadata: { ...asset.metadata, apiVersion: provider.profile.apiVersion, subscribedFields: provider.profile.subscribedFields,
        setupProfileDigest: metaSetupProfileDigest(provider.profile), ...(authorization.expiresAt ? { expiresAt: authorization.expiresAt } : {}),
        ...(authorization.issuedAt ? { issuedAt: authorization.issuedAt } : {}) } });
  }
  async health(scope: ActionScope, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), expectedRevision: z.number().int().positive() }).parse(raw);
    const connection = await this.connection(scope, input.connectionId), provider = this.provider(connection.kind, connection.mode);
    const credentials = await this.channels.resolveSetupCredential(scope, connection.id, input.expectedRevision);
    let reason: string | null = null;
    try {
      if (connection.metadata.setupProfileDigest !== metaSetupProfileDigest(provider.profile)) throw setupFailure("CHANNEL_SETUP_CONFIGURATION_CHANGED", 409);
      if (!connection.assetId || typeof connection.metadata.expiresAt === "string" && Date.parse(connection.metadata.expiresAt) <= Date.now()) throw setupFailure("CHANNEL_AUTHENTICATION_FAILED", 401);
      await provider.health(connection.assetId, connection.metadata, credentials.accessToken!);
    } catch (error) { reason = error instanceof PlatformError ? error.code : "CHANNEL_HEALTH_UNVERIFIED"; }
    if (!reason) return { connection, status: connection.state === "active" ? "healthy" : "needs_attention", checkedAt: new Date().toISOString(), reason: connection.state === "active" ? null : "explicit_reconnect_required" };
    const next = await this.channels.update(scope, connection.id, { expectedRevision: input.expectedRevision, state: "needs_attention", metadata: { ...connection.metadata, healthReason: reason } });
    return { connection: next, status: "needs_attention", checkedAt: new Date().toISOString(), reason };
  }
  async refresh(scope: ActionScope, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), expectedRevision: z.number().int().positive() }).parse(raw);
    const connection = await this.connection(scope, input.connectionId), provider = this.provider(connection.kind, connection.mode);
    const credentials = await this.channels.resolveSetupCredential(scope, connection.id, input.expectedRevision);
    if (connection.metadata.setupProfileDigest !== metaSetupProfileDigest(provider.profile) || !connection.assetId) throw setupFailure("CHANNEL_SETUP_CONFIGURATION_CHANGED", 409);
    if (connection.mode !== "instagram_login" || !provider.profile.instagramRefreshReviewed) throw setupFailure("CHANNEL_REFRESH_REVIEW_REQUIRED", 409);
    const claims = new MetaSetupClaims(this.channels.pool), claim = await claims.acquire(scope, connection.id, connection.revision, provider.profile.appId, provider.subscriptionTarget(connection.assetId, connection.metadata));
    let attempted = false;
    try {
      await provider.health(connection.assetId, connection.metadata, credentials.accessToken!);
      await claims.fence(scope, claim); attempted = true;
      const authorization = await provider.refresh(credentials.accessToken!, connection.metadata.issuedAt, connection.metadata.expiresAt);
      await provider.health(connection.assetId, connection.metadata, authorization.accessToken);
      await claims.fence(scope, claim);
      const updated = await this.channels.update(scope, connection.id, { expectedRevision: connection.revision,
        credentials: { ...credentials, accessToken: authorization.accessToken }, metadata: { ...connection.metadata, expiresAt: authorization.expiresAt, issuedAt: authorization.issuedAt } });
      await claims.finish(scope, claim, "complete"); return updated;
    } catch (error) {
      const eligibility = error instanceof PlatformError && ["CHANNEL_REFRESH_NOT_ELIGIBLE", "CHANNEL_REFRESH_REVIEW_REQUIRED"].includes(error.code);
      await claims.finish(scope, claim, attempted && !eligibility ? "uncertain" : "complete");
      if (!eligibility) await this.channels.update(scope, connection.id, { expectedRevision: connection.revision, state: "needs_attention", metadata: { ...connection.metadata, healthReason: "refresh_unverified" } });
      throw error;
    }
  }
  async reconcile(scope: ActionScope, sessionId: string, raw: unknown) {
    const input = z.strictObject({ ticket, assetId: z.string().min(1).max(512), intent: z.enum(["connect", "disconnect"]) }).parse(raw);
    const { attempt, connection, provider, authorization } = await this.selection(scope, sessionId, input.ticket, true);
    const asset = await provider.select(authorization, metaIdentifier(input.assetId)), claims = new MetaSetupClaims(this.channels.pool);
    const claim = await claims.reconcile(scope, connection.id, attempt.revision, provider.profile.appId, provider.subscriptionTarget(asset.id, asset.metadata));
    try {
      // Expiry only fences the previous caller. Native reads establish the actual effect before any local decision or explicit cleanup.
      const observed = await provider.subscription(asset.id, asset.metadata, asset.credential);
      await claims.fence(scope, claim);
      if (input.intent === "connect") {
        if (!observed.subscribed || !observed.fieldsGranted || asset.metadata.registrationRequired) {
          await claims.finish(scope, claim, "complete");
          return { connection, status: "reconnect_required", observedSubscription: observed.subscribed };
        }
        const updated = await this.activate(scope, connection.id, attempt.revision, provider, asset, authorization);
        await claims.finish(scope, claim, "complete"); return { connection: updated, status: "active", observedSubscription: true };
      }
      const target = provider.subscriptionTarget(asset.id, asset.metadata);
      const shared = (await this.channels.pool.query(`SELECT 1 FROM agents_platform.channel_connections WHERE id<>$1
        AND state NOT IN ('disconnected','removed') AND coalesce(metadata->>'wabaId',metadata->>'pageId',asset_id)=$2 LIMIT 1`, [connection.id, target])).rowCount;
      if (observed.subscribed && !shared) await provider.unsubscribe(asset.id, asset.metadata, asset.credential, () => claims.fence(scope, claim));
      await claims.fence(scope, claim);
      const updated = connection.state === "disconnected" ? connection : await this.channels.disconnect(scope, connection.id, attempt.revision);
      await claims.finish(scope, claim, "complete"); return { connection: updated, status: "disconnected", observedSubscription: Boolean(shared) };
    } catch (error) { await claims.finish(scope, claim, "uncertain"); throw error; }
  }
  async disconnect(scope: ActionScope, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), expectedRevision: z.number().int().positive() }).parse(raw);
    const connection = await this.connection(scope, input.connectionId), provider = this.provider(connection.kind, connection.mode);
    const credentials = connection.credentialRevision ? await this.channels.resolveSetupCredential(scope, connection.id, input.expectedRevision) : {};
    const claims = new MetaSetupClaims(this.channels.pool), target = connection.assetId ? provider.subscriptionTarget(connection.assetId, connection.metadata) : `pending:${connection.id}`;
    const claim = await claims.acquire(scope, connection.id, input.expectedRevision, provider.profile.appId, target);
    let dispatched = false;
    try {
      // Revoke local authority before remote cleanup. A provider failure never re-enables local sends.
      const disconnected = await this.channels.disconnect(scope, connection.id, input.expectedRevision);
      claim.revision = disconnected.revision;
      if (!connection.assetId || !credentials.accessToken) { await claims.finish(scope, claim, "complete"); return { connection: disconnected, unsubscribe: "not_needed" as const }; }
      // Multiple Instagram identities may share a Page/WABA app subscription. Never remove a shared resource subscription.
      const shared = (await this.channels.pool.query(`SELECT 1 FROM agents_platform.channel_connections WHERE id<>$1
        AND state NOT IN ('disconnected','removed') AND coalesce(metadata->>'wabaId',metadata->>'pageId',asset_id)=$2 LIMIT 1`, [connection.id, target])).rowCount;
      if (shared) { await claims.finish(scope, claim, "complete"); return { connection: disconnected, unsubscribe: "shared_subscription_retained" as const }; }
      try { await provider.unsubscribe(connection.assetId, connection.metadata, credentials.accessToken!, async () => { await claims.fence(scope, claim); dispatched = true; }); await claims.finish(scope, claim, "complete"); return { connection: disconnected, unsubscribe: "confirmed" as const }; }
      catch { await claims.finish(scope, claim, "uncertain"); return { connection: disconnected, unsubscribe: "unconfirmed" as const }; }
    } catch (error) { await claims.finish(scope, claim, dispatched ? "uncertain" : "complete"); throw error; }
  }
}
