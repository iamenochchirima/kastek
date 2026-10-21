import { z } from "zod";
import { setupFailure } from "./sessions";

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,512}$/);
const secret = z.string().min(1).max(16384).refine(value => !/[\r\n]/.test(value));
const https = z.url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; });
export const metaSetupProfileSchema = z.strictObject({
  kind: z.enum(["facebook", "instagram", "whatsapp"]), mode: z.enum(["meta", "instagram_login", "cloud_api"]),
  appId: identifier, appSecret: secret, webhookVerifyToken: secret, apiVersion: z.string().regex(/^v\d+\.\d+$/),
  redirectUri: https, scopes: z.array(identifier).min(1).max(30), subscribedFields: z.array(identifier).min(1).max(30),
  embeddedConfigurationId: identifier.optional(), discoveryPageLimit: z.number().int().min(1).max(100),
}).superRefine((value, context) => {
  if (value.kind === "facebook" && value.mode !== "meta" || value.kind === "instagram" && value.mode === "cloud_api" || value.kind === "whatsapp" && value.mode !== "cloud_api") context.addIssue({ code: "custom", message: "Unsupported channel login mode" });
  if (value.kind === "whatsapp" && !value.embeddedConfigurationId) context.addIssue({ code: "custom", message: "Embedded signup configuration is required" });
});
export type MetaSetupProfile = z.infer<typeof metaSetupProfileSchema>;
export type SetupAsset = { id: string; name: string; eligible: boolean; reasonCode: string | null; metadata: Record<string, unknown> };
export type PrivateSetupAsset = SetupAsset & { credential: string };
export type SetupAuthorization = { accessToken: string; expiresAt?: string; wabaId?: string };
export const metaIdentifier = (value: unknown) => identifier.parse(value);
function record(value: unknown): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw setupFailure("CHANNEL_PROVIDER_RESPONSE_INVALID", 502); return value as Record<string, any>; }

export class MetaSetupProvider {
  constructor(readonly profile: MetaSetupProfile, private readonly transport: typeof fetch) {}
  private base(): string { return `https://${this.profile.mode === "instagram_login" ? "graph.instagram.com" : "graph.facebook.com"}/${this.profile.apiVersion}`; }
  private async request(url: string, token?: string, body?: URLSearchParams, method?: "DELETE"): Promise<Record<string, any>> {
    let response: Response;
    try { response = await this.transport(url, { redirect: "error", method: method ?? (body ? "POST" : "GET"),
      headers: { ...(token ? { authorization: `Bearer ${secret.parse(token)}` } : {}), ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, ...(body ? { body: body.toString() } : {}) }); }
    catch { throw setupFailure("CHANNEL_SETUP_PROVIDER_OUTCOME_UNKNOWN", 502); }
    let data: Record<string, any>; try { data = record(await response.json()); } catch { throw setupFailure("CHANNEL_PROVIDER_RESPONSE_INVALID", 502); }
    if (!response.ok || data.error) throw setupFailure(response.status === 401 || data.error?.code === 190 ? "CHANNEL_AUTHENTICATION_FAILED"
      : response.status === 403 || [10, 200].includes(data.error?.code) ? "CHANNEL_PERMISSION_DENIED" : response.status === 429 ? "CHANNEL_RATE_LIMITED" : "CHANNEL_SETUP_PROVIDER_REJECTED", response.status === 429 ? 429 : 502);
    return data;
  }
  async exchange(code: string, wabaId?: string): Promise<SetupAuthorization> {
    const p = this.profile, direct = p.mode === "instagram_login";
    const initial = await this.request(direct ? "https://api.instagram.com/oauth/access_token" : `${this.base()}/oauth/access_token`, undefined,
      new URLSearchParams({ client_id: p.appId, client_secret: p.appSecret, code, ...(p.kind !== "whatsapp" ? { redirect_uri: p.redirectUri } : {}), ...(direct ? { grant_type: "authorization_code" } : {}) }));
    let token = secret.parse(initial.access_token), expiry = initial.expires_in;
    if (direct) {
      const url = new URL("https://graph.instagram.com/access_token"); url.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: p.appSecret, access_token: token }).toString();
      const extended = await this.request(url.href); token = secret.parse(extended.access_token); expiry = extended.expires_in;
    } else if (p.kind !== "whatsapp") {
      const extended = await this.request(`${this.base()}/oauth/access_token`, undefined,
        new URLSearchParams({ grant_type: "fb_exchange_token", client_id: p.appId, client_secret: p.appSecret, fb_exchange_token: token }));
      token = secret.parse(extended.access_token); expiry = extended.expires_in;
    }
    // Business-login grants are checked before discovery. No fallback to a different token or account.
    if (direct && (initial.permissions !== undefined || initial.scope !== undefined)) {
      const scopes = initial.permissions ?? initial.scope;
      const granted = new Set(Array.isArray(scopes) ? scopes : typeof scopes === "string" ? scopes.split(/[ ,]+/) : []);
      if (p.scopes.some(scope => !granted.has(scope))) throw setupFailure("CHANNEL_PERMISSION_DENIED", 403);
    }
    const authorization: SetupAuthorization = direct ? { accessToken: token } : await this.authorizeMetaToken(token, wabaId);
    if (Number.isFinite(expiry) && expiry > 0) authorization.expiresAt = new Date(Date.now() + expiry * 1000).toISOString();
    return authorization;
  }
  private async authorizeMetaToken(token: string, wabaId?: string): Promise<SetupAuthorization> {
    const p = this.profile, inspect = new URL(`${this.base()}/debug_token`); inspect.searchParams.set("input_token", token);
    const inspected = record((await this.request(inspect.href, `${p.appId}|${p.appSecret}`)).data);
    if (inspected.is_valid !== true || String(inspected.app_id) !== p.appId) throw setupFailure("CHANNEL_AUTHENTICATION_FAILED", 401);
    const granted = new Set(Array.isArray(inspected.scopes) ? inspected.scopes : []);
    if (p.scopes.some(scope => !granted.has(scope))) throw setupFailure("CHANNEL_PERMISSION_DENIED", 403);
    const authorization: SetupAuthorization = { accessToken: token };
    if (typeof inspected.expires_at === "number" && inspected.expires_at > 0) {
      if (inspected.expires_at * 1000 <= Date.now()) throw setupFailure("CHANNEL_AUTHENTICATION_FAILED", 401);
      authorization.expiresAt = new Date(inspected.expires_at * 1000).toISOString();
    }
    if (p.kind === "whatsapp") {
      authorization.wabaId = metaIdentifier(wabaId);
      const waba = await this.request(`${this.base()}/${authorization.wabaId}?fields=id`, token);
      if (waba.id !== authorization.wabaId) throw setupFailure("CHANNEL_ASSET_UNAVAILABLE", 409);
    }
    return authorization;
  }
  async manual(accessToken: string, wabaId: string): Promise<SetupAuthorization> {
    if (this.profile.kind !== "whatsapp") throw setupFailure("CHANNEL_MANUAL_SETUP_UNSUPPORTED");
    return this.authorizeMetaToken(secret.parse(accessToken), metaIdentifier(wabaId));
  }
  private async page(path: string, token: string, cursor?: string): Promise<{ data: Record<string, any>[]; nextCursor: string | null }> {
    const url = new URL(`${this.base()}/${path}`); if (cursor) url.searchParams.set("after", z.string().min(1).max(2048).parse(cursor));
    const response = await this.request(url.href, token);
    if (!Array.isArray(response.data)) throw setupFailure("CHANNEL_PROVIDER_RESPONSE_INVALID", 502);
    // Never follow provider-supplied paging.next URLs, which can carry tokens or redirect off-provider.
    const nextCursor = response.paging?.next ? z.string().min(1).max(2048).parse(response.paging?.cursors?.after) : null;
    if (nextCursor === cursor) throw setupFailure("CHANNEL_DISCOVERY_CURSOR_INVALID", 502);
    return { data: response.data.map(record), nextCursor };
  }
  async discover(auth: SetupAuthorization, cursor?: string): Promise<{ assets: PrivateSetupAsset[]; nextCursor: string | null }> {
    if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now()) throw setupFailure("CHANNEL_AUTHENTICATION_FAILED", 401);
    const p = this.profile;
    if (p.mode === "instagram_login") {
      if (cursor) throw setupFailure("CHANNEL_DISCOVERY_CURSOR_INVALID");
      const account = await this.request(`${this.base()}/me?fields=id,user_id,username,account_type`, auth.accessToken);
      return { assets: [{ id: metaIdentifier(account.user_id ?? account.id), name: String(account.username ?? account.id), eligible: true, reasonCode: null, metadata: {}, credential: auth.accessToken }], nextCursor: null };
    }
    const path = p.kind === "whatsapp" ? `${metaIdentifier(auth.wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name,code_verification_status,platform_type` : "me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username,name}";
    const page = await this.page(path, auth.accessToken, cursor), assets: PrivateSetupAsset[] = [];
    for (const entry of page.data) {
      if (p.kind === "whatsapp") {
        const verified = entry.code_verification_status === "VERIFIED";
        assets.push({ id: metaIdentifier(entry.id), name: String(entry.display_phone_number ?? entry.verified_name ?? entry.id), eligible: verified,
          reasonCode: verified ? null : "phone_verification_required", metadata: { wabaId: auth.wabaId, registrationRequired: entry.platform_type !== "CLOUD_API" }, credential: auth.accessToken });
      } else {
        const pageId = metaIdentifier(entry.id), task = Array.isArray(entry.tasks) && (entry.tasks.includes("MESSAGING") || entry.tasks.includes("MANAGE"));
        const candidate = p.kind === "instagram" ? entry.instagram_business_account : entry;
        if (!candidate) { assets.push({ id: pageId, name: String(entry.name ?? pageId), eligible: false, reasonCode: "instagram_account_not_linked", metadata: { pageId }, credential: "" }); continue; }
        const eligible = task && typeof entry.access_token === "string" && entry.access_token.length > 0;
        assets.push({ id: metaIdentifier(candidate.id), name: String(candidate.username ?? candidate.name ?? candidate.id), eligible, reasonCode: eligible ? null : "page_messaging_permission_required", metadata: { pageId }, credential: eligible ? secret.parse(entry.access_token) : "" });
      }
    }
    return { assets, nextCursor: page.nextCursor };
  }
  async select(auth: SetupAuthorization, assetId: string): Promise<PrivateSetupAsset> {
    let cursor: string | undefined; const seen = new Set<string>();
    for (let index = 0; index < this.profile.discoveryPageLimit; index++) {
      const page = await this.discover(auth, cursor), asset = page.assets.find(item => item.id === assetId && item.eligible);
      if (asset) return asset;
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor)) throw setupFailure("CHANNEL_DISCOVERY_CURSOR_INVALID", 502);
      seen.add(page.nextCursor); cursor = page.nextCursor;
      if (index === this.profile.discoveryPageLimit - 1) throw setupFailure("CHANNEL_DISCOVERY_LIMIT_REACHED", 409);
    }
    throw setupFailure("CHANNEL_ASSET_UNAVAILABLE", 409);
  }
  async subscribe(asset: PrivateSetupAsset, registrationPin?: string): Promise<void> {
    const p = this.profile;
    if (p.kind === "whatsapp" && asset.metadata.registrationRequired) {
      if (!registrationPin || !/^\d{6}$/.test(registrationPin)) throw setupFailure("CHANNEL_PHONE_REGISTRATION_REQUIRED", 409);
      const registered = await this.request(`${this.base()}/${metaIdentifier(asset.id)}/register`, asset.credential,
        new URLSearchParams({ messaging_product: "whatsapp", pin: registrationPin }));
      if (registered.success !== true) throw setupFailure("CHANNEL_PHONE_REGISTRATION_NOT_CONFIRMED", 502);
    }
    const target = p.kind === "whatsapp" ? metaIdentifier(asset.metadata.wabaId) : p.mode === "meta" ? metaIdentifier(asset.metadata.pageId) : asset.id;
    const subscribed = await this.request(`${this.base()}/${target}/subscribed_apps`, asset.credential,
      p.kind === "whatsapp" ? new URLSearchParams() : new URLSearchParams({ subscribed_fields: p.subscribedFields.join(",") }));
    if (subscribed.success !== true) throw setupFailure("CHANNEL_SUBSCRIPTION_NOT_CONFIRMED", 502);
  }
  async unsubscribe(assetId: string, metadata: Record<string, unknown>, credential: string): Promise<void> {
    const target = this.profile.kind === "whatsapp" ? metaIdentifier(metadata.wabaId) : this.profile.mode === "meta" ? metaIdentifier(metadata.pageId) : metaIdentifier(assetId);
    const result = await this.request(`${this.base()}/${target}/subscribed_apps`, credential, undefined, "DELETE");
    if (result.success !== true) throw setupFailure("CHANNEL_UNSUBSCRIBE_NOT_CONFIRMED", 502);
  }
}
