import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionScope } from "../../../contracts/connections";
import { ChannelStore } from "../channel-store";
import { MetaSetupSessions, setupFailure } from "./sessions";
import { MetaSetupProvider, metaSetupProfileSchema, metaIdentifier, type MetaSetupProfile, type SetupAuthorization } from "./provider";

export { MetaSetupSessions } from "./sessions";
export { MetaSetupProvider, metaSetupProfileSchema } from "./provider";
export type { MetaSetupProfile, SetupAsset, SetupAuthorization } from "./provider";
const ticket = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const authorizationSchema = z.strictObject({ accessToken: z.string().min(1).max(16384), expiresAt: z.iso.datetime().optional(), wabaId: z.string().optional() });

export class MetaChannelSetup {
  private readonly profiles: readonly MetaSetupProfile[];
  constructor(private readonly channels: ChannelStore, private readonly sessions: MetaSetupSessions,
    profiles: readonly MetaSetupProfile[], private readonly transport: typeof fetch) {
    this.profiles = profiles.map(profile => metaSetupProfileSchema.parse(profile));
    if (new Set(this.profiles.map(profile => `${profile.kind}:${profile.mode}`)).size !== profiles.length) throw setupFailure("CHANNEL_SETUP_CONFIGURATION_INVALID", 503);
  }
  /** Safe for customer catalogue/readiness responses. Secrets and private configuration never leave this service. */
  readiness() { return this.profiles.map(({ kind, mode }) => ({ kind, mode, available: true })); }
  private provider(kind: string, mode: string): MetaSetupProvider {
    const profile = this.profiles.find(item => item.kind === kind && item.mode === mode);
    if (!profile) throw setupFailure("CHANNEL_SETUP_NOT_CONFIGURED", 503);
    return new MetaSetupProvider(profile, this.transport);
  }
  private profileDigest(profile: MetaSetupProfile): string { return createHash("sha256").update(JSON.stringify(profile)).digest("hex"); }
  async begin(scope: ActionScope, sessionId: string, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), expectedRevision: z.number().int().positive() }).parse(raw);
    const connection = await this.channels.get(scope, input.connectionId), provider = this.provider(connection.kind, connection.mode), p = provider.profile;
    if (connection.revision !== input.expectedRevision) throw setupFailure("CHANNEL_CONNECTION_CHANGED", 409);
    const state = await this.sessions.issue(scope, sessionId, connection.id, connection.revision, "authorization", { profileDigest: this.profileDigest(p) });
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
    const connection = await this.channels.get(scope, attempt.connectionId), provider = this.provider(connection.kind, connection.mode);
    if (attempt.payload.profileDigest !== this.profileDigest(provider.profile)) throw setupFailure("CHANNEL_SETUP_CONFIGURATION_CHANGED", 409);
    const authorization = await provider.exchange(input.code, input.wabaId);
    return { ticket: await this.sessions.issue(scope, sessionId, connection.id, attempt.revision, "selection", { authorization, profileDigest: this.profileDigest(provider.profile) }), connectionId: connection.id };
  }
  async manual(scope: ActionScope, sessionId: string, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), expectedRevision: z.number().int().positive(), accessToken: z.string().min(1).max(16384), wabaId: z.string().min(1).max(512) }).parse(raw);
    const connection = await this.channels.get(scope, input.connectionId), provider = this.provider(connection.kind, connection.mode);
    // Authorize owner/session/revision before consuming any provider request with the supplied token.
    const state = await this.sessions.issue(scope, sessionId, connection.id, input.expectedRevision, "authorization", { manual: true });
    await this.sessions.read(scope, sessionId, state, "authorization", true);
    const authorization = await provider.manual(input.accessToken, input.wabaId);
    return { ticket: await this.sessions.issue(scope, sessionId, connection.id, input.expectedRevision, "selection", { authorization, profileDigest: this.profileDigest(provider.profile) }), connectionId: connection.id };
  }
  private async selection(scope: ActionScope, sessionId: string, key: string, consume = false) {
    const attempt = await this.sessions.read(scope, sessionId, key, "selection", consume), connection = await this.channels.get(scope, attempt.connectionId);
    const provider = this.provider(connection.kind, connection.mode);
    if (attempt.payload.profileDigest !== this.profileDigest(provider.profile)) throw setupFailure("CHANNEL_SETUP_CONFIGURATION_CHANGED", 409);
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
    await provider.subscribe(asset, input.registrationPin);
    const credentials: Record<string, string> = { accessToken: asset.credential, appSecret: provider.profile.appSecret, verifyToken: provider.profile.webhookVerifyToken };
    // Existing ChannelStore fences activation/reconnect and encrypts credentials against the exact selected asset.
    return this.channels.update(scope, connection.id, { expectedRevision: attempt.revision, assetId: asset.id, credentials, state: "active",
      metadata: { ...asset.metadata, apiVersion: provider.profile.apiVersion, subscribedFields: provider.profile.subscribedFields,
        ...(authorization.expiresAt ? { expiresAt: authorization.expiresAt } : {}) } });
  }
  async disconnect(scope: ActionScope, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), expectedRevision: z.number().int().positive() }).parse(raw);
    const connection = await this.channels.get(scope, input.connectionId), provider = this.provider(connection.kind, connection.mode);
    const credentials = connection.credentialRevision ? await this.channels.resolveSetupCredential(scope, connection.id, input.expectedRevision) : {};
    // Revoke local authority before remote cleanup. A provider failure never re-enables local sends.
    const disconnected = await this.channels.disconnect(scope, connection.id, input.expectedRevision);
    if (!connection.assetId || !credentials.accessToken) return { connection: disconnected, unsubscribe: "not_needed" as const };
    // Multiple Instagram identities may share a Page/WABA app subscription. Never remove a shared resource subscription.
    const target = connection.metadata.wabaId ?? connection.metadata.pageId ?? connection.assetId;
    const shared = (await this.channels.pool.query(`SELECT 1 FROM agents_platform.channel_connections WHERE id<>$1
      AND state NOT IN ('disconnected','removed') AND coalesce(metadata->>'wabaId',metadata->>'pageId',asset_id)=$2 LIMIT 1`, [connection.id, target])).rowCount;
    if (shared) return { connection: disconnected, unsubscribe: "shared_subscription_retained" as const };
    try { await provider.unsubscribe(connection.assetId, connection.metadata, credentials.accessToken!); return { connection: disconnected, unsubscribe: "confirmed" as const }; }
    catch { return { connection: disconnected, unsubscribe: "unconfirmed" as const }; }
  }
}
