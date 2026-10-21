import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { transaction } from "../../infrastructure/database";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import type { ChannelConnection } from "../../contracts/channel-connections";
import { PlatformError } from "../../contracts/contracts";
import type { ChannelStore } from "./channel-store";

const token = z.string().regex(/^\d+:[A-Za-z0-9_-]{1,256}$/);
const revision = z.number().int().positive();
const setupInput = z.strictObject({ expectedRevision: revision, confirmReplacement: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const failure = (code = "TELEGRAM_SETUP_UNAVAILABLE", status = 502) => new PlatformError(code, status, "Telegram setup could not be verified");
export interface TelegramSetupOptions {
  /** Trusted server transport must bound response bytes and enforce cancellation. Never log token-bearing URLs. */
  fetch: typeof globalThis.fetch;
  callbackUrl: (connectionId: string) => string;
  timeoutMs?: number;
}
export interface TelegramSetupResult {
  connection: ChannelConnection;
  status: "pending" | "active" | "replacement_required" | "needs_attention" | "disconnected";
  replacementConfirmation?: string;
}
type Store = Pick<ChannelStore, "create" | "get" | "update" | "disconnect" | "resolveSetupCredential" | "pool">;
function publicCallback(raw: string): string {
  let url: URL; try { url = new URL(raw); } catch { throw failure("TELEGRAM_CALLBACK_INVALID", 400); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host) ||
      url.port && !["443", "80", "88", "8443"].includes(url.port)) throw failure("TELEGRAM_CALLBACK_INVALID", 400);
  return url.href;
}
/** Server-only onboarding. Credentials and provider descriptions never occur in returned DTOs. */
export class TelegramSetupService {
  private readonly timeoutMs: number;
  constructor(private readonly store: Store, private readonly options: TelegramSetupOptions) {
    this.timeoutMs = z.number().int().min(100).max(30000).parse(options.timeoutMs ?? 10000);
    if (typeof options.fetch !== "function" || typeof options.callbackUrl !== "function") throw failure("TELEGRAM_SETUP_CONFIG_INVALID", 503);
  }
  private async acquire(scope: ActionScope, row: ChannelConnection): Promise<string> {
    const claim = randomUUID();
    const acquired = await transaction(this.store.pool, async db => {
      const result = await db.query(`INSERT INTO agents_platform.channel_setup_claims(organization_id,connection_id,claim_id,connection_revision,expires_at,state)
        SELECT $1,$2,$3,$4,clock_timestamp()+($5::int * interval '1 millisecond'),'started'
        FROM agents_platform.channel_connections WHERE organization_id=$1 AND id=$2 AND revision=$4
        ON CONFLICT(connection_id) DO UPDATE SET claim_id=excluded.claim_id,connection_revision=excluded.connection_revision,
          expires_at=excluded.expires_at,state='started'
        WHERE channel_setup_claims.state='complete' RETURNING claim_id`,
      [scope.organizationId, row.id, claim, row.revision, this.timeoutMs * 6]);
      return Boolean(result.rowCount);
    });
    if (!acquired) throw failure("TELEGRAM_SETUP_RECONCILIATION_REQUIRED", 409);
    return claim;
  }
  private async fence(scope: ActionScope, id: string, claim: string): Promise<number> {
    const result = await this.store.pool.query(`SELECT greatest(1,floor(extract(epoch FROM (expires_at-clock_timestamp()))*1000)) AS remaining_ms FROM agents_platform.channel_setup_claims
      WHERE organization_id=$1 AND connection_id=$2 AND claim_id=$3 AND state='started' AND expires_at>clock_timestamp()`, [scope.organizationId, id, claim]);
    if (!result.rowCount) throw failure("TELEGRAM_SETUP_RECONCILIATION_REQUIRED", 409);
    return Math.min(this.timeoutMs, Number(result.rows[0]!.remaining_ms));
  }
  private async finish(scope: ActionScope, id: string, claim: string, state: "complete" | "uncertain"): Promise<void> {
    await this.store.pool.query(`UPDATE agents_platform.channel_setup_claims SET state=$4
      WHERE organization_id=$1 AND connection_id=$2 AND claim_id=$3 AND state='started'`, [scope.organizationId, id, claim, state]);
  }
  private async current(scope: ActionScope, id: string, expectedRevision: number) {
    const credentials = await this.store.resolveSetupCredential(scope, id, expectedRevision);
    const connection = await this.store.get(scope, id);
    if (connection.revision !== expectedRevision || connection.kind !== "telegram" || connection.mode !== "bot") throw failure("CHANNEL_CONNECTION_CHANGED", 409);
    token.parse(credentials.botToken);
    return { connection, credentials };
  }
  private async call(scope: ActionScope, connection: ChannelConnection, method: "getMe" | "getWebhookInfo" | "setWebhook" | "deleteWebhook", body: Record<string, unknown> = {}, claim?: string): Promise<unknown> {
    const { credentials } = await this.current(scope, connection.id, connection.revision);
    const remainingMs = claim ? await this.fence(scope, connection.id, claim) : this.timeoutMs;
    try {
      const response = await this.options.fetch(`https://api.telegram.org/bot${credentials.botToken}/${method}`, {
        method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(remainingMs),
      });
      const payload = z.object({ ok: z.literal(true), result: z.unknown() }).safeParse(await response.json());
      if (!response.ok || !payload.success) throw failure();
      return payload.data.result;
    } catch { throw failure(); }
  }
  private async webhook(scope: ActionScope, row: ChannelConnection, claim?: string): Promise<string> {
    const parsed = z.object({ url: z.string().max(4096) }).safeParse(await this.call(scope, row, "getWebhookInfo", {}, claim));
    if (!parsed.success) throw failure(); return parsed.data.url;
  }
  async connect(scope: ActionScope, raw: unknown): Promise<TelegramSetupResult> {
    const input = z.strictObject({ name: z.string().trim().min(1).max(120), botToken: token }).parse(raw);
    // Validate deployment configuration before writing credentials or making any provider call.
    publicCallback(this.options.callbackUrl("00000000-0000-0000-0000-000000000000"));
    const row = await this.store.create(scope, { kind: "telegram", mode: "bot", name: input.name, state: "pending",
      credentials: { botToken: input.botToken, webhookSecret: randomBytes(32).toString("hex") } });
    return this.setup(scope, row.id, { expectedRevision: row.revision });
  }
  async rotate(scope: ActionScope, id: string, raw: unknown): Promise<TelegramSetupResult> {
    const input = z.strictObject({ expectedRevision: revision, botToken: token }).parse(raw);
    const { connection } = await this.current(scope, id, input.expectedRevision);
    const claim = await this.acquire(scope, connection);
    try {
      const row = await this.store.update(scope, id, { expectedRevision: input.expectedRevision, state: "pending",
        credentials: { botToken: input.botToken, webhookSecret: randomBytes(32).toString("hex") }, metadata: {} });
      return await this.setupClaimed(scope, id, { expectedRevision: row.revision }, claim);
    } catch (error) { await this.finish(scope, id, claim, "uncertain"); throw error; }
  }
  async setup(scope: ActionScope, id: string, raw: unknown): Promise<TelegramSetupResult> {
    const input = setupInput.parse(raw);
    const { connection } = await this.current(scope, id, input.expectedRevision);
    const claim = await this.acquire(scope, connection);
    try { return await this.setupClaimed(scope, id, input, claim); }
    catch (error) { await this.finish(scope, id, claim, "uncertain"); throw error; }
  }
  private async setupClaimed(scope: ActionScope, id: string, input: z.infer<typeof setupInput>, claim: string): Promise<TelegramSetupResult> {
    let { connection: row, credentials } = await this.current(scope, id, input.expectedRevision);
    const callback = publicCallback(this.options.callbackUrl(id));
    try {
      const bot = z.object({ id: z.number().int().positive().safe(), is_bot: z.literal(true), first_name: z.string().min(1).max(256), username: z.string().max(128).optional() }).safeParse(await this.call(scope, row, "getMe", {}, claim));
      if (!bot.success || String(bot.data.id) !== credentials.botToken!.split(":")[0]) throw failure();
      const existing = await this.webhook(scope, row, claim);
      if (existing && existing !== credentials.verifiedWebhookUrl) {
        const confirmation = createHash("sha256").update(JSON.stringify([id, row.revision, existing, callback])).digest("hex");
        if (input.confirmReplacement !== confirmation) {
          await this.finish(scope, id, claim, "complete");
          return { connection: row, status: "replacement_required", replacementConfirmation: confirmation };
        }
      }
      row = await this.store.update(scope, id, { expectedRevision: row.revision, assetId: String(bot.data.id), state: "pending",
        credentials: { botToken: credentials.botToken!, webhookSecret: credentials.webhookSecret! },
        metadata: { botName: bot.data.first_name, ...(bot.data.username ? { botUsername: bot.data.username } : {}), setupStatus: "in_progress" } });
      credentials = (await this.current(scope, id, row.revision)).credentials;
      if (!/^[a-f0-9]{64}$/.test(credentials.webhookSecret ?? "")) throw failure();
      if (await this.call(scope, row, "setWebhook", { url: callback, secret_token: credentials.webhookSecret, allowed_updates: ["message", "callback_query"] }, claim) !== true) throw failure();
      if (await this.webhook(scope, row, claim) !== callback) throw failure();
      await this.fence(scope, id, claim);
      row = await this.store.update(scope, id, { expectedRevision: row.revision, state: "active", credentials: { ...credentials, verifiedWebhookUrl: callback }, metadata: { ...row.metadata, setupStatus: "verified" } });
      await this.finish(scope, id, claim, "complete");
      return { connection: row, status: "active" };
    } catch (error) {
      await this.finish(scope, id, claim, "uncertain");
      if (error instanceof PlatformError && ["CHANNEL_CONNECTION_CHANGED", "ACCESS_DENIED"].includes(error.code)) throw error;
      row = await this.store.update(scope, id, { expectedRevision: row.revision, state: "needs_attention", metadata: { ...row.metadata, setupStatus: "unverified" } });
      return { connection: row, status: "needs_attention" };
    }
  }
  async health(scope: ActionScope, id: string, expectedRevision: number): Promise<TelegramSetupResult> {
    const { connection, credentials } = await this.current(scope, id, expectedRevision);
    const pending = await this.store.pool.query(`SELECT claim_id,state,expires_at<=clock_timestamp() AS expired
      FROM agents_platform.channel_setup_claims WHERE organization_id=$1 AND connection_id=$2`, [scope.organizationId, id]);
    const prior = pending.rows[0];
    if (prior && prior.state !== "complete" && !prior.expired) throw failure("TELEGRAM_SETUP_IN_PROGRESS", 409);
    try {
      const url = await this.webhook(scope, connection);
      if (prior && prior.state !== "complete" && prior.expired && typeof url === "string") {
        await this.store.pool.query(`UPDATE agents_platform.channel_setup_claims SET state='complete'
          WHERE organization_id=$1 AND connection_id=$2 AND claim_id=$3 AND expires_at<=clock_timestamp()`, [scope.organizationId, id, prior.claim_id]);
      }
      if (connection.state === "active" && credentials.verifiedWebhookUrl === publicCallback(this.options.callbackUrl(id)) && url === credentials.verifiedWebhookUrl) return { connection, status: "active" };
    } catch { /* Health uncertainty cannot activate a connection. */ }
    const row = await this.store.update(scope, id, { expectedRevision, state: "needs_attention", metadata: { ...connection.metadata, setupStatus: "unverified" } });
    return { connection: row, status: "needs_attention" };
  }
  async disconnect(scope: ActionScope, id: string, expectedRevision: number): Promise<TelegramSetupResult> {
    let { connection: row, credentials } = await this.current(scope, id, expectedRevision);
    const callback = publicCallback(this.options.callbackUrl(id));
    if (credentials.verifiedWebhookUrl !== callback) throw failure("TELEGRAM_WEBHOOK_NOT_OWNED", 409);
    const claim = await this.acquire(scope, row);
    row = await this.store.update(scope, id, { expectedRevision, state: "needs_attention", metadata: { ...row.metadata, setupStatus: "disconnecting" } });
    try {
      const currentUrl = await this.webhook(scope, row, claim);
      if (currentUrl !== "" && currentUrl !== callback) throw failure();
      if (currentUrl && (await this.call(scope, row, "deleteWebhook", {}, claim) !== true || await this.webhook(scope, row, claim) !== "")) throw failure();
    } catch { await this.finish(scope, id, claim, "uncertain"); return { connection: row, status: "needs_attention" }; }
    await this.fence(scope, id, claim);
    const disconnected = await this.store.disconnect(scope, id, row.revision);
    await this.finish(scope, id, claim, "complete");
    return { connection: disconnected, status: "disconnected" };
  }
}
