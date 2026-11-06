import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import type { CoreContext } from "../context.js";
import {
  GROWTH_AGENT_CHANNELS_PATH,
  GrowthAgentChannelContractError,
  growthAgentChannelResponseSchema,
  parseGrowthAgentChannelRequest,
  type GrowthAgentChannelAsset,
  type GrowthAgentActor,
  type GrowthAgentChannelGrant,
  type GrowthAgentChannelProvider,
} from "@kasitek-labs/contracts";
import { ApiError } from "../error.js";
import { growthAgentChannelLinksEnabled, growthAgentDigest, growthAgentIdentityIssuer, verifyGrowthAgentChannelLink } from "./security.js";
import { permissionSnapshots } from "../integrations/connection-permissions.js";
import { beginGrowthAgentChannelAuthorization, completeGrowthAgentWhatsAppSignup } from "./growth-agent-channel-oauth.js";
import { decryptSocialSecret } from "../integrations/crypto.js";
import { metrics } from "@opentelemetry/api";

type ConnectionRow = {
  id: string; orgId: string; orgName: string; provider: string; sourceType: string;
  externalAccountId: string | null; displayName: string; handle: string | null;
  status: string; credentialStatus: string; metadata: Record<string, unknown> | null; updatedAt: Date;
};
type GrantRow = Record<string, unknown>;
type IntentRow = Record<string, unknown>;

const providerName: Record<GrowthAgentChannelProvider, string> = {
  facebook: "FACEBOOK", instagram: "INSTAGRAM", whatsapp: "WHATSAPP",
};
const sourceType: Record<GrowthAgentChannelProvider, string> = {
  facebook: "SOCIAL", instagram: "SOCIAL", whatsapp: "WHATSAPP",
};
const currentCapabilities = ["messaging.inbound", "messaging.outbound"] as const;
const channelMeter = metrics.getMeter("kasitek.growth.agent-channels");
const channelCommandCount = channelMeter.createCounter("growth.agent_channel.command.count");
const channelCommandDuration = channelMeter.createHistogram("growth.agent_channel.command.duration_ms", { unit: "ms" });
const invalid = () => new ApiError(400, "agent_channel_request_invalid", "Channel request is invalid");
const denied = () => new ApiError(403, "agent_channel_access_denied", "Growth channel access is unavailable");
const conflict = () => new ApiError(409, "agent_channel_grant_conflict", "This account already has an active Inbox owner");
const permissionMissing = () => new ApiError(409, "agent_channel_permission_missing", "Messaging permissions need attention in Growth Connections");
const codeHash = (code: string) => createHash("sha256").update(code).digest("hex");

function permissionRevision(row: ConnectionRow): string {
  const permissions = permissionSnapshots(row.provider, row.metadata ?? {}).map(({ definition, providerPermission }) => ({
    key: definition.key, state: definition.state, verificationSource: definition.verificationSource,
    authMode: definition.authMode, providerPermission,
  }));
  return growthAgentDigest({ connectionId: row.id, provider: row.provider, sourceType: row.sourceType,
    externalAccountId: row.externalAccountId, authMethod: row.metadata?.authMethod ?? null, permissions });
}
function eligible(row: ConnectionRow): { inbound: boolean; outbound: boolean } {
  const permissions = permissionSnapshots(row.provider, row.metadata ?? {});
  return {
    inbound: permissions.some(item => item.definition.key === "MESSAGING_INBOUND" && item.definition.state === "GRANTED"),
    outbound: permissions.some(item => item.definition.key === "MESSAGING_OUTBOUND" && item.definition.state === "GRANTED"),
  };
}
function grantDto(row: GrantRow, core: CoreContext): GrowthAgentChannelGrant {
  return {
    grantId: String(row.id), growthActor: { issuer: growthAgentIdentityIssuer(core.config), subject: String(row.actorId) },
    growthOrganizationId: String(row.orgId), connectionId: String(row.connectionId),
    provider: row.provider as GrowthAgentChannelProvider, providerAssetId: String(row.providerAssetId),
    permissionRevision: String(row.permissionRevision), state: row.state as GrowthAgentChannelGrant["state"],
    routeOwner: row.routeOwner as GrowthAgentChannelGrant["routeOwner"],
  };
}

async function assertActor(core: CoreContext, request: ReturnType<typeof parseGrowthAgentChannelRequest>): Promise<string> {
  const row = (await core.pool.query<{ userId: string }>(
    'SELECT "userId" FROM "ExternalIdentity" WHERE issuer=$1 AND subject=$2',
    [request.actor.issuer, request.actor.subject],
  )).rows[0];
  if (!row) throw denied();
  return row.userId;
}

export async function resolveGrowthManagedChannelActor(core: CoreContext, actor: GrowthAgentActor): Promise<string> {
  if (actor.issuer !== growthAgentIdentityIssuer(core.config)) throw denied();
  const row = (await core.pool.query<{ id: string }>(
    'SELECT id FROM "User" WHERE id=$1 AND "emailVerified" IS NOT NULL',
    [actor.subject],
  )).rows[0];
  if (!row) throw denied();
  return row.id;
}

async function assertGrowthManagedActor(core: CoreContext, request: ReturnType<typeof parseGrowthAgentChannelRequest>): Promise<string> {
  return resolveGrowthManagedChannelActor(core, request.actor);
}

async function assertAdmin(db: Pick<PoolClient, "query">, orgId: string, actorId: string): Promise<void> {
  const organization = (await db.query<{ ownerId: string }>(
    'SELECT "ownerId" FROM "Organization" WHERE id=$1 FOR SHARE', [orgId],
  )).rows[0];
  if (!organization) throw denied();
  if (organization.ownerId === actorId) return;
  const member = await db.query(
    'SELECT 1 FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=$2 AND role IN (\'OWNER\',\'ADMIN\') FOR SHARE',
    [orgId, actorId],
  );
  if (!member.rowCount) throw denied();
}

async function organizationsList(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "organizations.list" }>, actorId: string, logger: FastifyBaseLogger) {
  let stage = "database_query";
  try {
    const organizations = (await core.pool.query<{ id: string; name: string }>(`
      SELECT o.id,o.name FROM "Organization" o
      WHERE o."ownerId"=$1 OR EXISTS(SELECT 1 FROM "OrganizationMember" m
        WHERE m."orgId"=o.id AND m."userId"=$1 AND m.role IN ('OWNER','ADMIN'))
      ORDER BY o.name,o.id LIMIT 200`, [actorId])).rows;
    stage = "response_validation";
    return growthAgentChannelResponseSchema.parse({ operation: "organizations.list", requestId: request.requestId, organizations });
  } catch (error) {
    logger.error({
      event: "growth.agent_channel.organizations_list_failed",
      failure_stage: stage,
      error_type: error instanceof Error ? error.name : "unknown",
    }, "Growth organization listing failed");
    throw error;
  }
}

async function listAssets(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "assets.list" }>, actorId: string) {
  const intent = (await core.pool.query<IntentRow>(`SELECT * FROM "GrowthAgentChannelLinkIntent"
    WHERE id=$1 AND "agentsWorkspaceId"=$2 AND "agentsAgentId"=$3 AND "actorId"=$4 AND "expiresAt">now() AND "completedAt" IS NULL`,
  [request.intentId, request.workspaceId, request.agentId, actorId])).rows[0];
  if (!intent) throw new ApiError(410, "agent_channel_intent_expired", "Start the channel connection again");
  await assertAdmin(core.pool, String(intent.orgId), actorId);
  const organizationId = String(intent.orgId), provider = String(intent.provider) as GrowthAgentChannelProvider;
  await core.pool.query(`UPDATE "GrowthAgentChannelGrant" SET state='revoked',"routeOwner"='growth',"expiresAt"=NULL,"revokedAt"=now(),"updatedAt"=now()
    WHERE state='pending' AND "expiresAt"<=now()`);
  const connectionRows = (await core.pool.query<ConnectionRow>(`
    SELECT c.id,c."orgId",o.name AS "orgName",c.provider,c."sourceType",c."externalAccountId",
      c."displayName",c.handle,c.status::text AS status,c."credentialStatus",c.metadata,c."updatedAt"
    FROM "ExternalConnection" c
    JOIN "Organization" o ON o.id=c."orgId"
    WHERE c."orgId"=$1 AND c.provider=$2 AND c."sourceType"=$3 AND c.status='CONNECTED'
      AND c."credentialStatus"='ACTIVE' AND c."externalAccountId" IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM "GrowthAgentChannelGrant" g WHERE g."connectionId"=c.id AND g.state IN ('pending','active','needs_attention')
        AND NOT (g."agentsWorkspaceId"=$4 AND g."agentsAgentId"=$5))
    ORDER BY c."displayName",c.id LIMIT 500`, [organizationId, providerName[provider], sourceType[provider], request.workspaceId, request.agentId])).rows;
  const assets: GrowthAgentChannelAsset[] = [];
  for (const row of connectionRows) {
    const access = eligible(row);
    if (!access.inbound || !access.outbound) continue;
    assets.push({
      growthOrganizationId: row.orgId, growthOrganizationName: row.orgName,
      connectionId: row.id, provider, providerMode:provider === "instagram" && row.metadata?.authMethod === "instagram_login" ? "instagram_login" : "meta",
      providerAssetId: row.externalAccountId!,
      name: row.displayName, handle: row.handle, permissionRevision: permissionRevision(row), inbound: true, outbound: true,
    });
  }
  return growthAgentChannelResponseSchema.parse({ operation: "assets.list", requestId: request.requestId, assets });
}

async function createIntent(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "intent.create" }>, actorId: string) {
  if (request.returnRoute !== `/app/agents/${request.agentId}?section=channels`) throw invalid();
  const requestDigest = growthAgentDigest(request);
  const client = await core.pool.connect();
  try {
    await client.query("BEGIN");
    await assertAdmin(client, request.growthOrganizationId, actorId);
    const prior = (await client.query<IntentRow>(`SELECT * FROM "GrowthAgentChannelLinkIntent"
      WHERE "agentsWorkspaceId"=$1 AND "requestId"=$2 FOR UPDATE`, [request.workspaceId, request.requestId])).rows[0];
    if (prior) {
      if (prior.requestDigest !== requestDigest || prior.actorId !== actorId || prior.orgId !== request.growthOrganizationId ||
        prior.agentsAgentId !== request.agentId || prior.provider !== request.provider) throw new ApiError(409, "agent_channel_request_reused", "The channel request was already used");
      if (new Date(String(prior.expiresAt)).getTime() <= Date.now()) throw new ApiError(410, "agent_channel_intent_expired", "Start the channel connection again");
      await client.query("COMMIT");
      return growthAgentChannelResponseSchema.parse({ operation: "intent.create", requestId: request.requestId, intentId: prior.id, expiresAt: new Date(String(prior.expiresAt)).toISOString() });
    }
    const intentId = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await client.query(`DELETE FROM "GrowthAgentChannelLinkIntent" WHERE "expiresAt"<now()-interval '7 days' AND ("completedAt" IS NOT NULL OR "codeExpiresAt"<now())`);
    await client.query(`INSERT INTO "GrowthAgentChannelLinkIntent" (
      id,"actorId","orgId",provider,"agentsWorkspaceId","agentsAgentId","requestId","requestDigest","returnRoute","expiresAt"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [intentId, actorId, request.growthOrganizationId, request.provider, request.workspaceId, request.agentId, request.requestId, requestDigest, request.returnRoute, expiresAt]);
    await client.query("COMMIT");
    return growthAgentChannelResponseSchema.parse({ operation: "intent.create", requestId: request.requestId, intentId, expiresAt: expiresAt.toISOString() });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function beginOAuth(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "oauth.begin" }>, actorId: string) {
  const intent = await core.pool.query<IntentRow>(`SELECT * FROM "GrowthAgentChannelLinkIntent"
    WHERE id=$1 AND "agentsWorkspaceId"=$2 AND "agentsAgentId"=$3 AND "actorId"=$4 AND "expiresAt">now() AND "completedAt" IS NULL`,
  [request.intentId, request.workspaceId, request.agentId, actorId]);
  if (!intent.rows[0]) throw new ApiError(410, "agent_channel_intent_expired", "Start the channel connection again");
  await assertAdmin(core.pool, String(intent.rows[0].orgId), actorId);
  return growthAgentChannelResponseSchema.parse({ ...await beginGrowthAgentChannelAuthorization(core, {
    intentId: request.intentId, workspaceId: request.workspaceId, agentId: request.agentId,
    actorId, loginMode: request.loginMode,
  }), requestId: request.requestId });
}

async function completeWhatsAppSignup(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "whatsapp.complete" }>, actorId: string) {
  const intent = (await core.pool.query<IntentRow>(`SELECT * FROM "GrowthAgentChannelLinkIntent" WHERE id=$1
    AND "agentsWorkspaceId"=$2 AND "agentsAgentId"=$3 AND "actorId"=$4`, [request.intentId,request.workspaceId,request.agentId,actorId])).rows[0];
  if(!intent)throw new ApiError(410,"agent_channel_intent_expired","Start the channel connection again");
  await assertAdmin(core.pool,String(intent.orgId),actorId);
  return growthAgentChannelResponseSchema.parse(await completeGrowthAgentWhatsAppSignup(core, {
    intentId: request.intentId, workspaceId: request.workspaceId, agentId: request.agentId,
    actorId, code: request.code, wabaId: request.wabaId, phoneNumberId: request.phoneNumberId,
  }).then(result => ({ ...result, requestId: request.requestId })));
}

async function sendAgentChannelMessage(
  core: CoreContext,
  request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "message.send" }>,
  actorId: string,
) {
  const digest = growthAgentDigest(request);
  const client = await core.pool.connect();
  let deliveryToken = "";
  let instagramMetadata: Record<string, unknown> = {};
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const prior = (await client.query<Record<string, unknown>>(
      `SELECT * FROM "GrowthAgentChannelSend" WHERE "deliveryId"=$1 FOR UPDATE`,
      [request.deliveryId],
    )).rows[0];
    if (prior) {
      if (prior.grantId !== request.grantId || prior.requestDigest !== digest)
        throw new ApiError(409, "agent_channel_delivery_reused", "This channel delivery ID was already used");
      if (prior.state === "sending" && Date.now() - new Date(String(prior.createdAt)).getTime() > 30_000) {
        await client.query(`UPDATE "GrowthAgentChannelSend" SET state='unknown',code='provider_outcome_unknown',"updatedAt"=now()
          WHERE "deliveryId"=$1 AND state='sending'`, [request.deliveryId]);
        prior.state = "unknown";
        prior.code = "provider_outcome_unknown";
      }
      await client.query("COMMIT");
      transactionOpen = false;
      return growthAgentChannelResponseSchema.parse({ operation: "message.send", requestId: request.requestId,
        state: prior.state === "accepted" ? "accepted" : prior.state === "failed" ? "failed" : "unknown",
        providerMessageId: typeof prior.providerMessageId === "string" ? prior.providerMessageId : null,
        code: typeof prior.code === "string" ? prior.code : prior.state === "sending" ? "outcome_pending" : null });
    }

    const row = (await client.query<Record<string, unknown>>(
      `SELECT g.*,e.status AS external_status,e."credentialStatus" AS credential_status,
        e."sourceType" AS source_type,e."sourceId" AS source_id,e."externalAccountId" AS external_asset_id,
        e.metadata AS external_metadata,e."updatedAt" AS external_updated_at
      FROM "GrowthAgentChannelGrant" g
      JOIN "ExternalConnection" e ON e.id=g."connectionId" AND e."orgId"=g."orgId"
      WHERE g.id=$1 AND g."agentsWorkspaceId"=$2 AND g."agentsAgentId"=$3 AND g."agentsConnectionId"=$4
        AND g."actorId"=$5 AND g.state IN ('active','needs_attention') AND g."routeOwner"='agents'
      FOR SHARE OF g,e`,
      [request.grantId, request.workspaceId, request.agentId, request.agentsConnectionId, actorId],
    )).rows[0];
    if (!row) throw denied();
    await assertAdmin(client, String(row.orgId), actorId);
    const provider = request.provider;
    if (row.provider !== provider || row.providerAssetId !== request.providerAssetId) throw denied();

    const failNeedsAttention = async (code: string, message: string): Promise<never> => {
      await client.query(`UPDATE "GrowthAgentChannelGrant" SET state='needs_attention',"updatedAt"=now()
        WHERE id=$1 AND state='active' AND "routeOwner"='agents'`, [request.grantId]);
      await client.query("COMMIT");
      transactionOpen = false;
      throw new ApiError(409, code, message);
    };

    if (row.external_status !== "CONNECTED" || row.credential_status !== "ACTIVE")
      await failNeedsAttention("agent_channel_connection_needs_attention", "Reconnect this account in Growth Connections");

    const external: ConnectionRow = {
      id: String(row.connectionId), orgId: String(row.orgId), orgName: "", provider: providerName[provider],
      sourceType: sourceType[provider], externalAccountId: String(row.external_asset_id), displayName: "", handle: null,
      status: String(row.external_status), credentialStatus: String(row.credential_status),
      metadata: row.external_metadata && typeof row.external_metadata === "object" ? row.external_metadata as Record<string, unknown> : null,
      updatedAt: new Date(String(row.external_updated_at)),
    };
    const access = eligible(external);
    if (!access.outbound || permissionRevision(external) !== row.permissionRevision)
      await failNeedsAttention("agent_channel_permission_missing", "Confirm messaging permissions in Growth Connections");

    if (provider === "whatsapp") {
      if (row.source_type !== "WHATSAPP") throw denied();
      const credential = (await client.query<Record<string, unknown>>(
        `SELECT "phoneNumberId" AS asset,"accessTokenEncrypted" AS token FROM "WhatsappConnection"
          WHERE id=$1 AND "orgId"=$2 FOR SHARE`, [row.source_id, row.orgId],
      )).rows[0];
      if (!credential || credential.asset !== request.providerAssetId || typeof credential.token !== "string")
        return failNeedsAttention("agent_channel_connection_needs_attention", "Reconnect this account in Growth Connections");
      deliveryToken = String(credential.token);
    } else {
      if (row.source_type !== "SOCIAL") throw denied();
      const credential = (await client.query<Record<string, unknown>>(
        `SELECT platform::text AS platform,"externalAccountId" AS asset,"accessToken" AS token,metadata
          FROM "SocialChannelConnection" WHERE id=$1 AND "orgId"=$2 FOR SHARE`, [row.source_id, row.orgId],
      )).rows[0];
      if (!credential || credential.platform !== providerName[provider] || credential.asset !== request.providerAssetId ||
        typeof credential.token !== "string")
        return failNeedsAttention("agent_channel_connection_needs_attention", "Reconnect this account in Growth Connections");
      deliveryToken = String(credential.token);
      instagramMetadata = credential.metadata && typeof credential.metadata === "object" ? credential.metadata as Record<string, unknown> : {};
    }

    const inserted = (await client.query(
      `INSERT INTO "GrowthAgentChannelSend"("deliveryId","grantId","requestDigest",state)
        VALUES($1,$2,$3,'sending') ON CONFLICT ("deliveryId") DO NOTHING RETURNING "deliveryId"`,
      [request.deliveryId, request.grantId, digest],
    )).rowCount;
    if (!inserted) {
      const raced = (await client.query<Record<string, unknown>>(
        `SELECT * FROM "GrowthAgentChannelSend" WHERE "deliveryId"=$1 FOR UPDATE`, [request.deliveryId],
      )).rows[0];
      if (!raced || raced.grantId !== request.grantId || raced.requestDigest !== digest)
        throw new ApiError(409, "agent_channel_delivery_reused", "This channel delivery ID was already used");
      await client.query("COMMIT");
      transactionOpen = false;
      return growthAgentChannelResponseSchema.parse({ operation: "message.send", requestId: request.requestId,
        state: raced.state === "accepted" ? "accepted" : raced.state === "failed" ? "failed" : "unknown",
        providerMessageId: typeof raced.providerMessageId === "string" ? raced.providerMessageId : null,
        code: typeof raced.code === "string" ? raced.code : "outcome_pending" });
    }
    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  let state: "accepted" | "failed" | "unknown" = "unknown";
  let providerMessageId: string | null = null;
  let code: string | null = null;
  try {
    const token = decryptSocialSecret(core.config, deliveryToken);
    const { message, provider } = request;
    const attachment = message.attachments?.[0];
    if (attachment && (Boolean(attachment.url) === Boolean(attachment.providerMediaId) ||
      attachment.url && (!attachment.url.startsWith("https://") || new URL(attachment.url).username || new URL(attachment.url).password))) {
      state = "failed";
      code = "message_invalid";
    } else if (provider === "whatsapp") {
      const body: Record<string, unknown> = { messaging_product: "whatsapp", recipient_type: "individual", to: message.recipientId };
      if (message.replyToProviderMessageId) body.context = { message_id: message.replyToProviderMessageId };
      if (message.template) {
        body.type = "template";
        body.template = { name: message.template.name, language: { code: message.template.language },
          ...(message.template.components ? { components: message.template.components } : {}) };
      } else if (message.buttons?.length) {
        body.type = "interactive";
        body.interactive = { type: "button", body: { text: message.text }, action: {
          buttons: message.buttons.map(button => ({ type: "reply", reply: { id: button.payload, title: button.title } })) } };
      } else if (attachment) {
        const media: Record<string, string> = attachment.url ? { link: attachment.url } : { id: attachment.providerMediaId! };
        if (attachment.kind === "document" && attachment.fileName) media.filename = attachment.fileName;
        if (attachment.kind !== "audio" && message.text) media.caption = message.text;
        body.type = attachment.kind;
        body[attachment.kind] = media;
      } else {
        body.type = "text";
        body.text = { body: message.text };
      }
      const asset = request.providerAssetId;
      const version = core.config.env.META_GRAPH_API_VERSION ?? "v23.0";
      if (!/^v\d{1,3}\.\d{1,2}$/.test(version) || !/^\d{1,32}$/.test(asset)) throw new Error("channel_configuration_invalid");
      const response = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(asset)}/messages`, {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
      const messages = Array.isArray(raw?.messages) ? raw.messages as Record<string, unknown>[] : [];
      if (response.ok && typeof messages[0]?.id === "string") {
        state = "accepted";
        providerMessageId = String(messages[0].id);
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        state = "failed";
        code = "provider_rejected";
      } else code = "provider_outcome_unknown";
    } else {
      const direct = provider === "instagram" && instagramMetadata.authMethod === "instagram_login";
      const senderAsset = provider === "instagram" && !direct && typeof instagramMetadata.pageId === "string"
        ? instagramMetadata.pageId : request.providerAssetId;
      const version = core.config.env.META_GRAPH_API_VERSION ?? "v23.0";
      const host = direct ? "graph.instagram.com" : "graph.facebook.com";
      const content: Record<string, unknown> = {};
      if (attachment) content.attachment = { type: attachment.kind === "document" ? "file" : attachment.kind,
        payload: attachment.url ? { url: attachment.url } : { attachment_id: attachment.providerMediaId } };
      else content.text = message.text;
      if (message.replyToProviderMessageId) content.reply_to = { mid: message.replyToProviderMessageId };
      const body = { recipient: { id: message.recipientId }, ...(!direct ? { messaging_type: "RESPONSE" } : {}), message: content };
      if (!/^v\d{1,3}\.\d{1,2}$/.test(version) || !/^[A-Za-z0-9_.-]{1,512}$/.test(senderAsset)) throw new Error("channel_configuration_invalid");
      const response = await fetch(`https://${host}/${version}/${encodeURIComponent(senderAsset)}/messages`, {
        method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      const raw = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (response.ok && typeof raw?.message_id === "string") {
        state = "accepted";
        providerMessageId = String(raw.message_id);
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        state = "failed";
        code = "provider_rejected";
      } else code = "provider_outcome_unknown";
    }
  } catch {
    state = "unknown";
    code = "provider_outcome_unknown";
  }
  await core.pool.query(`UPDATE "GrowthAgentChannelSend" SET state=$2,"providerMessageId"=$3,code=$4,"updatedAt"=now()
    WHERE "deliveryId"=$1 AND state='sending'`, [request.deliveryId, state, providerMessageId, code]);
  return growthAgentChannelResponseSchema.parse({ operation: "message.send", requestId: request.requestId, state, providerMessageId, code });
}

async function issueGrantCode(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "grant.issue" }>, actorId: string) {
  const client = await core.pool.connect();
  try {
    await client.query("BEGIN");
    const intent = (await client.query<IntentRow>(`SELECT * FROM "GrowthAgentChannelLinkIntent"
      WHERE id=$1 AND "agentsWorkspaceId"=$2 AND "agentsAgentId"=$3 AND "actorId"=$4 AND "expiresAt">now() AND "completedAt" IS NULL FOR UPDATE`,
    [request.intentId, request.workspaceId, request.agentId, actorId])).rows[0];
    if (!intent) throw new ApiError(410, "agent_channel_intent_expired", "Start the channel connection again");
    await assertAdmin(client, String(intent.orgId), actorId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`growth-agent-channel:${intent.provider}:${request.providerAssetId}`]);
    const connection = (await client.query<ConnectionRow>(`
      SELECT c.id,c."orgId",o.name AS "orgName",c.provider,c."sourceType",c."externalAccountId",
        c."displayName",c.handle,c.status::text AS status,c."credentialStatus",c.metadata,c."updatedAt"
      FROM "ExternalConnection" c JOIN "Organization" o ON o.id=c."orgId"
      WHERE c.id=$1 AND c."orgId"=$2 FOR UPDATE OF c`, [request.connectionId, intent.orgId])).rows[0];
    const provider = String(intent.provider) as GrowthAgentChannelProvider;
    if (!connection || connection.provider !== providerName[provider] || connection.sourceType !== sourceType[provider] ||
      connection.externalAccountId !== request.providerAssetId || connection.status !== "CONNECTED" || connection.credentialStatus !== "ACTIVE") throw denied();
    const access = eligible(connection);
    if (!access.inbound || !access.outbound) throw permissionMissing();
    const permission = permissionRevision(connection);
    const existing = (await client.query<GrantRow>(`SELECT * FROM "GrowthAgentChannelGrant"
      WHERE ("connectionId"=$1 OR (provider=$2 AND "providerAssetId"=$3)) AND state IN ('pending','active','needs_attention') FOR UPDATE`,
    [connection.id, provider, request.providerAssetId])).rows[0];
    if (existing && (existing.agentsWorkspaceId !== request.workspaceId || existing.agentsAgentId !== request.agentId || existing.agentsConnectionId !== request.agentsConnectionId)) throw conflict();
    const code = randomBytes(32).toString("base64url"), expiresAt = new Date(Date.now() + 120_000);
    await client.query(`UPDATE "GrowthAgentChannelLinkIntent" SET "connectionId"=$2,"providerAssetId"=$3,"permissionRevision"=$4,
      "codeHash"=$5,"codeExpiresAt"=$6,"updatedAt"=now() WHERE id=$1`,
    [request.intentId, connection.id, request.providerAssetId, permission, codeHash(code), expiresAt]);
    await client.query("COMMIT");
    return growthAgentChannelResponseSchema.parse({ operation: "grant.issue", requestId: request.requestId, intentId: request.intentId, code, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    await client.query("ROLLBACK");
    const code = (error as { code?: string }).code;
    if (code === "23505") throw conflict();
    throw error;
  } finally { client.release(); }
}

async function exchangeGrantCode(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "grant.exchange" }>, actorId: string) {
  const digest = growthAgentDigest(request), client = await core.pool.connect();
  try {
    await client.query("BEGIN");
    const prior = (await client.query<GrantRow>(`SELECT * FROM "GrowthAgentChannelGrant" WHERE "agentsWorkspaceId"=$1 AND "requestId"=$2 FOR UPDATE`,
      [request.workspaceId, request.requestId])).rows[0];
    if (prior) {
      if (prior.requestDigest !== digest || prior.actorId !== actorId || prior.agentsAgentId !== request.agentId || prior.intentId !== request.intentId ||
        prior.agentsConnectionId !== request.agentsConnectionId) throw new ApiError(409, "agent_channel_request_reused", "The channel request was already used");
      await client.query("COMMIT");
      return growthAgentChannelResponseSchema.parse({ operation: "grant.exchange", requestId: request.requestId, grant: grantDto(prior, core) });
    }
    const intent = (await client.query<IntentRow>(`SELECT * FROM "GrowthAgentChannelLinkIntent"
      WHERE id=$1 AND "agentsWorkspaceId"=$2 AND "agentsAgentId"=$3 AND "actorId"=$4 AND "expiresAt">now()
        AND "codeHash"=$5 AND "codeExpiresAt">now() AND "completedAt" IS NULL FOR UPDATE`,
    [request.intentId, request.workspaceId, request.agentId, actorId, codeHash(request.code)])).rows[0];
    if (!intent || !intent.connectionId || !intent.providerAssetId || !intent.permissionRevision) throw new ApiError(410, "agent_channel_code_expired", "The channel authorization expired. Try again");
    await assertAdmin(client, String(intent.orgId), actorId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`growth-agent-channel:${intent.provider}:${intent.providerAssetId}`]);
    const connection = (await client.query<ConnectionRow>(`
      SELECT c.id,c."orgId",o.name AS "orgName",c.provider,c."sourceType",c."externalAccountId",
        c."displayName",c.handle,c.status::text AS status,c."credentialStatus",c.metadata,c."updatedAt"
      FROM "ExternalConnection" c JOIN "Organization" o ON o.id=c."orgId"
      WHERE c.id=$1 AND c."orgId"=$2 FOR SHARE OF c`, [intent.connectionId, intent.orgId])).rows[0];
    const provider = String(intent.provider) as GrowthAgentChannelProvider;
    if (!connection || connection.provider !== providerName[provider] || connection.sourceType !== sourceType[provider] ||
      connection.externalAccountId !== intent.providerAssetId || connection.status !== "CONNECTED" || connection.credentialStatus !== "ACTIVE") throw denied();
    const access = eligible(connection), permission = permissionRevision(connection);
    if (!access.inbound || !access.outbound || permission !== intent.permissionRevision) throw permissionMissing();
    const conflictRow = (await client.query<GrantRow>(`SELECT * FROM "GrowthAgentChannelGrant"
      WHERE ("connectionId"=$1 OR (provider=$2 AND "providerAssetId"=$3)) AND state IN ('pending','active','needs_attention') FOR UPDATE`,
    [connection.id, provider, intent.providerAssetId])).rows[0];
    if (conflictRow && (conflictRow.agentsWorkspaceId !== request.workspaceId || conflictRow.agentsAgentId !== request.agentId)) throw conflict();
    const grantId = conflictRow?.id ?? randomUUID();
    const parameters = [grantId, intent.orgId, connection.id, provider, intent.providerAssetId, request.workspaceId, request.agentId,
      request.agentsConnectionId, request.intentId, actorId, JSON.stringify(currentCapabilities), permission, request.requestId, digest];
    let grant: GrantRow;
    if (conflictRow) {
      grant = (await client.query<GrantRow>(`UPDATE "GrowthAgentChannelGrant" SET "agentsConnectionId"=$2,"intentId"=$3,"actorId"=$4,
        capabilities=$5::jsonb,"permissionRevision"=$6,state='pending',"routeOwner"='growth',"requestId"=$7,"requestDigest"=$8,
        "expiresAt"=now()+interval '15 minutes',"revokedAt"=NULL,"updatedAt"=now() WHERE id=$1 RETURNING *`,
      [grantId, request.agentsConnectionId, request.intentId, actorId, JSON.stringify(currentCapabilities), permission, request.requestId, digest])).rows[0]!;
    } else {
      grant = (await client.query<GrantRow>(`INSERT INTO "GrowthAgentChannelGrant" (
        id,"orgId","connectionId",provider,"providerAssetId","agentsWorkspaceId","agentsAgentId","agentsConnectionId","intentId",
        "actorId",capabilities,"permissionRevision",state,"routeOwner","requestId","requestDigest"
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,'pending','growth',$13,$14) RETURNING *`, parameters)).rows[0]!;
    }
    await client.query(`UPDATE "GrowthAgentChannelLinkIntent" SET "agentsConnectionId"=$2,"completedAt"=now(),"updatedAt"=now() WHERE id=$1`, [request.intentId, request.agentsConnectionId]);
    await client.query("COMMIT");
    return growthAgentChannelResponseSchema.parse({ operation: "grant.exchange", requestId: request.requestId, grant: grantDto(grant, core) });
  } catch (error) {
    await client.query("ROLLBACK");
    const code = (error as { code?: string }).code;
    if (code === "23505") throw conflict();
    throw error;
  } finally { client.release(); }
}

async function activateGrant(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "grant.activate" }>, actorId: string) {
  const client = await core.pool.connect();
  try {
    await client.query("BEGIN");
    const intent = (await client.query<IntentRow>(`SELECT * FROM "GrowthAgentChannelLinkIntent"
      WHERE id=$1 AND "agentsWorkspaceId"=$2 AND "agentsAgentId"=$3 AND "agentsConnectionId"=$4 AND "actorId"=$5 FOR UPDATE`,
    [request.intentId, request.workspaceId, request.agentId, request.agentsConnectionId, actorId])).rows[0];
    if (!intent || !intent.completedAt) throw new ApiError(409, "agent_channel_grant_not_ready", "Complete account selection first");
    await assertAdmin(client, String(intent.orgId), actorId);
    const grant = (await client.query<GrantRow>(`SELECT * FROM "GrowthAgentChannelGrant"
      WHERE "agentsWorkspaceId"=$1 AND "agentsAgentId"=$2 AND "agentsConnectionId"=$3 AND "intentId"=$4 FOR UPDATE`,
    [request.workspaceId, request.agentId, request.agentsConnectionId, request.intentId])).rows[0];
    if (!grant) throw new ApiError(409, "agent_channel_grant_not_ready", "Complete account selection first");
    if (grant.state === "active" && grant.routeOwner === "agents") {
      const live = (await client.query<ConnectionRow>(`SELECT c.id,c."orgId",o.name AS "orgName",c.provider,c."sourceType",c."externalAccountId",
          c."displayName",c.handle,c.status::text AS status,c."credentialStatus",c.metadata,c."updatedAt"
        FROM "ExternalConnection" c JOIN "Organization" o ON o.id=c."orgId"
        WHERE c.id=$1 AND c."orgId"=$2 FOR SHARE OF c`, [grant.connectionId, grant.orgId])).rows[0];
      const permissions = live ? eligible(live) : { inbound: false, outbound: false };
      if (!live || live.status !== "CONNECTED" || live.credentialStatus !== "ACTIVE" || !permissions.inbound || !permissions.outbound ||
        live.provider !== providerName[grant.provider as GrowthAgentChannelProvider] ||
        live.sourceType !== sourceType[grant.provider as GrowthAgentChannelProvider] || live.externalAccountId !== grant.providerAssetId) {
        const attention = (await client.query<GrantRow>(`UPDATE "GrowthAgentChannelGrant" SET state='needs_attention',"updatedAt"=now()
          WHERE id=$1 AND state='active' AND "routeOwner"='agents' RETURNING *`, [grant.id])).rows[0] ?? grant;
        await client.query("COMMIT");
        return growthAgentChannelResponseSchema.parse({ operation: "grant.activate", requestId: request.requestId, grant: grantDto(attention, core) });
      }
      const revision = permissionRevision(live);
      const current = revision === grant.permissionRevision ? grant : (await client.query<GrantRow>(`UPDATE "GrowthAgentChannelGrant"
        SET "permissionRevision"=$2,"updatedAt"=now() WHERE id=$1 AND state='active' AND "routeOwner"='agents' RETURNING *`,
      [grant.id, revision])).rows[0] ?? grant;
      await client.query("COMMIT");
      return growthAgentChannelResponseSchema.parse({ operation: "grant.activate", requestId: request.requestId, grant: grantDto(current, core) });
    }
    if (grant.state === "needs_attention" && grant.routeOwner === "agents") {
      const live = (await client.query<ConnectionRow>(`SELECT c.id,c."orgId",o.name AS "orgName",c.provider,c."sourceType",c."externalAccountId",
          c."displayName",c.handle,c.status::text AS status,c."credentialStatus",c.metadata,c."updatedAt"
        FROM "ExternalConnection" c JOIN "Organization" o ON o.id=c."orgId"
        WHERE c.id=$1 AND c."orgId"=$2 FOR SHARE OF c`, [grant.connectionId, grant.orgId])).rows[0];
      const permissions = live ? eligible(live) : { inbound: false, outbound: false };
      if (!live || live.status !== "CONNECTED" || live.credentialStatus !== "ACTIVE" || !permissions.inbound || !permissions.outbound ||
        live.provider !== providerName[grant.provider as GrowthAgentChannelProvider] || live.sourceType !== sourceType[grant.provider as GrowthAgentChannelProvider] ||
        live.externalAccountId !== grant.providerAssetId)
        throw permissionMissing();
      const refreshed = (await client.query<GrantRow>(`UPDATE "GrowthAgentChannelGrant" SET state='active',"permissionRevision"=$2,
        "updatedAt"=now() WHERE id=$1 AND state='needs_attention' AND "routeOwner"='agents' RETURNING *`,
      [grant.id, permissionRevision(live)])).rows[0];
      if (!refreshed) throw new ApiError(409, "agent_channel_grant_changed", "Reconnect this channel in Agent Channels");
      await client.query("COMMIT");
      return growthAgentChannelResponseSchema.parse({ operation: "grant.activate", requestId: request.requestId, grant: grantDto(refreshed, core) });
    }
    if (grant.state !== "pending" || grant.routeOwner !== "growth" || new Date(String(grant.expiresAt)).getTime() <= Date.now())
      throw new ApiError(410, "agent_channel_grant_expired", "Start the channel connection again");
    if (!growthAgentChannelLinksEnabled(core.config))
      throw new ApiError(503, "agent_channel_links_disabled", "Agent channel connections are unavailable");
    const live = (await client.query<ConnectionRow>(`SELECT c.id,c."orgId",o.name AS "orgName",c.provider,c."sourceType",c."externalAccountId",
        c."displayName",c.handle,c.status::text AS status,c."credentialStatus",c.metadata,c."updatedAt"
      FROM "ExternalConnection" c JOIN "Organization" o ON o.id=c."orgId"
      WHERE c.id=$1 AND c."orgId"=$2 FOR SHARE OF c`, [grant.connectionId, grant.orgId])).rows[0];
    const permissions = live ? eligible(live) : { inbound: false, outbound: false };
    if (!live || live.status !== "CONNECTED" || live.credentialStatus !== "ACTIVE" || !permissions.inbound || !permissions.outbound ||
      permissionRevision(live) !== grant.permissionRevision)
      throw permissionMissing();
    const active = (await client.query<GrantRow>(`UPDATE "GrowthAgentChannelGrant" SET state='active',"routeOwner"='agents',"expiresAt"=NULL,
      "updatedAt"=now() WHERE id=$1 AND state='pending' RETURNING *`, [grant.id])).rows[0]!;
    await client.query("COMMIT");
    return growthAgentChannelResponseSchema.parse({ operation: "grant.activate", requestId: request.requestId, grant: grantDto(active, core) });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function revokeGrant(core: CoreContext, request: Extract<ReturnType<typeof parseGrowthAgentChannelRequest>, { operation: "grant.revoke" }>, actorId: string) {
  const client = await core.pool.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<GrantRow>(`SELECT * FROM "GrowthAgentChannelGrant" WHERE id=$1 AND "agentsWorkspaceId"=$2
      AND "agentsAgentId"=$3 AND "agentsConnectionId"=$4 FOR UPDATE`,
    [request.grantId, request.workspaceId, request.agentId, request.agentsConnectionId])).rows[0];
    if (!row) throw denied();
    if (row.actorId !== actorId) await assertAdmin(client, String(row.orgId), actorId);
    const updated = row.state === "revoked" ? row : (await client.query<GrantRow>(`
      UPDATE "GrowthAgentChannelGrant" SET state='revoked',"routeOwner"='growth',"expiresAt"=NULL,"revokedAt"=now(),"updatedAt"=now()
      WHERE id=$1 RETURNING *`, [request.grantId])).rows[0]!;
    await client.query("COMMIT");
    return growthAgentChannelResponseSchema.parse({ operation: "grant.revoke", requestId: request.requestId, grant: grantDto(updated, core) });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export function registerGrowthAgentChannelRoutes(app: FastifyInstance, core: CoreContext): void {
  app.post(GROWTH_AGENT_CHANNELS_PATH, { bodyLimit: 32768 }, async request => {
    await verifyGrowthAgentChannelLink(core.config, request.headers.authorization, request.body);
    let command;
    try { command = parseGrowthAgentChannelRequest(request.body); }
    catch (error) { if (error instanceof GrowthAgentChannelContractError) throw invalid(); throw error; }
    const actorId = command.operation === "message.send"
      ? await assertGrowthManagedActor(core, command)
      : await assertActor(core, command);
    const startedAt = performance.now();
    const provider = "provider" in command ? command.provider : undefined;
    const correlationId = "requestId" in command ? command.requestId : undefined;
    const record = (outcome: "succeeded" | "failed", state: string, errorCode?: string,
      resultProvider?: string, routeOwner?: "agents" | "growth") => {
      const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
      const resolvedProvider = provider ?? resultProvider;
      const attributes = { operation: command.operation, ...(resolvedProvider ? { provider: resolvedProvider } : {}), outcome, state,
        ...(routeOwner ? { route_owner: routeOwner } : {}) };
      channelCommandCount.add(1, attributes);
      channelCommandDuration.record(durationMs, attributes);
      const fields = { event: "growth.agent_channel.command", operation: command.operation,
        ...(resolvedProvider ? { provider: resolvedProvider } : {}), outcome, state, duration_ms: durationMs,
        ...(routeOwner ? { route_owner: routeOwner } : {}),
        ...(correlationId ? { correlation_id: correlationId } : {}), ...(errorCode ? { error_code: errorCode } : {}) };
      if (outcome === "failed") request.log.warn(fields);
      else request.log.info(fields);
    };
    try {
      if (!growthAgentChannelLinksEnabled(core.config) && ["intent.create", "assets.list", "oauth.begin", "whatsapp.complete", "grant.issue", "grant.exchange"].includes(command.operation))
        throw new ApiError(503, "agent_channel_links_disabled", "Agent channel connections are unavailable");
      let result: unknown;
      switch (command.operation) {
        case "organizations.list": result = await organizationsList(core, command, actorId, request.log); break;
        case "intent.create": result = await createIntent(core, command, actorId); break;
        case "assets.list": result = await listAssets(core, command, actorId); break;
        case "oauth.begin": result = await beginOAuth(core, command, actorId); break;
        case "whatsapp.complete": result = await completeWhatsAppSignup(core, command, actorId); break;
        case "grant.issue": result = await issueGrantCode(core, command, actorId); break;
        case "grant.exchange": result = await exchangeGrantCode(core, command, actorId); break;
        case "grant.activate": result = await activateGrant(core, command, actorId); break;
        case "grant.revoke": result = await revokeGrant(core, command, actorId); break;
        case "message.send": result = await sendAgentChannelMessage(core, command, actorId); break;
        case "webhook.deliver": throw invalid();
      }
      const response = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const grant = response.grant && typeof response.grant === "object" ? response.grant as Record<string, unknown> : {};
      const rawState = typeof grant.state === "string" ? grant.state : typeof response.state === "string" ? response.state :
        command.operation === "intent.create" ? "created" : "completed";
      const state = ["created", "completed", "pending", "active", "needs_attention", "revoked", "accepted", "failed", "unknown"].includes(rawState)
        ? rawState : "completed";
      const routeOwner = grant.routeOwner === "agents" || grant.routeOwner === "growth" ? grant.routeOwner : undefined;
      record("succeeded", state, undefined, typeof grant.provider === "string" ? grant.provider : undefined, routeOwner);
      return result;
    } catch (error) {
      record("failed", "error", error instanceof ApiError ? error.code : "internal");
      throw error;
    }
  });
}
