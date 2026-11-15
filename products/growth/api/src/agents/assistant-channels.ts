import { randomUUID } from "node:crypto";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { requestGrowthChannelAdmin } from "./channel-admin-client.js";
import { growthManagedConnectionEligibility } from "./channel-links.js";
import { growthAgentDigest } from "./security.js";
import { syncTelegramProjection } from "./telegram-projection.js";

export type GrowthAgentActor = { issuer: string; subject: string };
export type ChannelAdminClient = typeof requestGrowthChannelAdmin;

export type AssistantChannelView = {
  provider: "whatsapp" | "telegram";
  connectionId: string;
  name: string;
  identity: string | null;
  state: string;
  expectedRevision: number | null;
  linked: boolean;
  available: boolean;
};

type TelegramConnection = {
  id: string;
  name: string;
  state: string;
  revision: number;
  metadata: Record<string, unknown>;
};

type TelegramDeployment = { connectionId: string; agentId: string; state: string };

export type GrowthWhatsAppConnection = {
  id: string;
  displayName: string;
  externalAccountId: string | null;
  provider: string;
  sourceType: string;
  metadata: Record<string, unknown> | null;
};

export function telegramChannelViews(
  connections: TelegramConnection[],
  deployments: TelegramDeployment[],
  targetAgentId: string | null,
): AssistantChannelView[] {
  return connections.map((connection) => {
    const deployment = deployments.find(
      (item) =>
        item.connectionId === connection.id &&
        item.agentId === targetAgentId &&
        item.state === "active",
    );
    return {
      provider: "telegram" as const,
      connectionId: connection.id,
      name: connection.name,
      identity:
        typeof connection.metadata.botUsername === "string"
          ? `@${connection.metadata.botUsername}`
          : null,
      state: connection.state,
      expectedRevision: connection.revision,
      linked: Boolean(deployment),
      available: connection.state === "active",
    };
  });
}

export function whatsappChannelViews(
  connections: GrowthWhatsAppConnection[],
  linkedIds: ReadonlySet<string>,
): AssistantChannelView[] {
  return connections.map((connection) => {
    const eligibility = growthManagedConnectionEligibility(connection);
    const granted = eligibility.access.inbound && eligibility.access.outbound;
    const linked = linkedIds.has(connection.id);
    return {
      provider: "whatsapp" as const,
      connectionId: connection.id,
      name: connection.displayName,
      identity: connection.externalAccountId,
      state: !granted ? "permission_missing" : linked ? "linked" : "active",
      expectedRevision: null,
      linked,
      available: granted,
    };
  });
}

async function targetAgent(
  core: CoreContext,
  admin: ChannelAdminClient,
  actor: GrowthAgentActor,
  orgId: string,
): Promise<string> {
  const target = await admin(core.config, {
    version: "1",
    requestId: randomUUID(),
    operation: "assistant.target",
    actor,
    growthOrganizationId: orgId,
  });
  if (!target.targetAgentId)
    throw new ApiError(
      409,
      "assistant_target_unavailable",
      "The Growth assistant is not provisioned for this workspace",
    );
  return target.targetAgentId;
}

async function growthWhatsAppRows(core: CoreContext, orgId: string): Promise<GrowthWhatsAppConnection[]> {
  return (
    await core.pool.query<GrowthWhatsAppConnection>(
      `SELECT id,"displayName","externalAccountId",provider,"sourceType",metadata
         FROM "ExternalConnection"
        WHERE "orgId"=$1 AND provider='WHATSAPP' AND status='CONNECTED' AND "credentialStatus"='ACTIVE'
        ORDER BY "displayName"`,
      [orgId],
    )
  ).rows;
}

export async function listAssistantChannels(
  core: CoreContext,
  actor: GrowthAgentActor,
  orgId: string,
  admin: ChannelAdminClient = requestGrowthChannelAdmin,
): Promise<{ targetAgentId: string | null; channels: AssistantChannelView[] }> {
  const target = await admin(core.config, {
    version: "1",
    requestId: randomUUID(),
    operation: "assistant.target",
    actor,
    growthOrganizationId: orgId,
  });
  const targetAgentId = target.targetAgentId ?? null;
  const telegram = await admin(core.config, {
    version: "1",
    requestId: randomUUID(),
    operation: "channel.list",
    actor,
    growthOrganizationId: orgId,
  });
  await syncTelegramProjection(
    core.pool,
    orgId,
    (telegram.connections ?? []) as Parameters<typeof syncTelegramProjection>[2],
    { prune: true },
  );
  const whatsapp = await growthWhatsAppRows(core, orgId);
  const linkedWhatsAppIds = new Set(
    targetAgentId
      ? (
          await core.pool.query<{ connectionId: string }>(
            `SELECT "connectionId" FROM "GrowthAgentChannelGrant"
              WHERE "orgId"=$1 AND "agentsAgentId"=$2 AND state IN ('active','needs_attention')`,
            [orgId, targetAgentId],
          )
        ).rows.map((row) => row.connectionId)
      : [],
  );
  return {
    targetAgentId,
    channels: [
      ...whatsappChannelViews(whatsapp, linkedWhatsAppIds),
      ...telegramChannelViews(
        (telegram.connections ?? []) as TelegramConnection[],
        (telegram.deployments ?? []) as TelegramDeployment[],
        targetAgentId,
      ),
    ],
  };
}

export async function linkAssistantChannel(
  core: CoreContext,
  input: {
    actor: GrowthAgentActor;
    orgId: string;
    userId: string;
    provider: "whatsapp" | "telegram";
    connectionId: string;
    expectedRevision?: number;
  },
  admin: ChannelAdminClient = requestGrowthChannelAdmin,
): Promise<{ deployment?: unknown; grantId?: string; targetAgentId: string }> {
  const agentId = await targetAgent(core, admin, input.actor, input.orgId);
  if (input.provider === "telegram") {
    if (!input.expectedRevision)
      throw new ApiError(
        400,
        "expected_revision_required",
        "The channel revision is required",
      );
    const result = await admin(core.config, {
      version: "1",
      requestId: randomUUID(),
      operation: "channel.bind",
      actor: input.actor,
      growthOrganizationId: input.orgId,
      connectionId: input.connectionId,
      expectedRevision: input.expectedRevision,
    });
    return { deployment: result.deployment, targetAgentId: agentId };
  }

  const connection = (
    await core.pool.query<GrowthWhatsAppConnection>(
      `SELECT id,"displayName","externalAccountId",provider,"sourceType",metadata
         FROM "ExternalConnection"
        WHERE id=$1 AND "orgId"=$2 AND provider='WHATSAPP'
          AND status='CONNECTED' AND "credentialStatus"='ACTIVE'`,
      [input.connectionId, input.orgId],
    )
  ).rows[0];
  if (!connection)
    throw new ApiError(404, "connection_not_found", "WhatsApp connection not found");
  const eligibility = growthManagedConnectionEligibility(connection);
  if (!eligibility.access.inbound || !eligibility.access.outbound)
    throw new ApiError(
      409,
      "agent_channel_permission_missing",
      "Confirm messaging permissions in Growth Connections",
    );
  const existing = (
    await core.pool.query<{ id: string }>(
      `SELECT id FROM "GrowthAgentChannelGrant"
        WHERE "connectionId"=$1 AND "agentsAgentId"=$2
          AND state IN ('active','needs_attention') LIMIT 1`,
      [connection.id, agentId],
    )
  ).rows[0];
  if (existing) return { grantId: existing.id, targetAgentId: agentId };
  const providerAssetId = connection.externalAccountId;
  if (!providerAssetId)
    throw new ApiError(
      409,
      "provider_asset_missing",
      "The WhatsApp connection is missing its phone number ID",
    );
  const grantId = randomUUID();
  const intentId = randomUUID();
  const growthRequestId = randomUUID();
  const exchangeRequestId = randomUUID();
  const requestDigest = growthAgentDigest({
    grantId,
    connectionId: connection.id,
    providerAssetId,
    agentId,
    permissionRevision: eligibility.permissionRevision,
  });
  const result = await admin(core.config, {
    version: "1",
    requestId: randomUUID(),
    operation: "growth.link",
    actor: input.actor,
    growthOrganizationId: input.orgId,
    provider: "whatsapp",
    connectionId: connection.id,
    providerAssetId,
    permissionRevision: eligibility.permissionRevision,
    name: connection.displayName,
    providerMode: "meta",
    grantId,
    intentId,
    growthRequestId,
    exchangeRequestId,
  });
  if (!result.connection || !result.deployment)
    throw new ApiError(
      502,
      "agent_channel_response_invalid",
      "Agents returned an invalid channel result",
    );
  try {
    await core.pool.query(
      `INSERT INTO "GrowthAgentChannelGrant"(
         id,"orgId","connectionId",provider,"providerAssetId","agentsWorkspaceId","agentsAgentId",
         "agentsConnectionId","intentId","actorId",capabilities,"permissionRevision",state,"routeOwner",
         "requestId","requestDigest","expiresAt"
       ) VALUES($1,$2,$3,'whatsapp',$4,$5,$6,$7,$8,$9,$10::jsonb,$11,'active','agents',$12,$13,NULL)`,
      [
        grantId,
        input.orgId,
        connection.id,
        providerAssetId,
        result.connection.organizationId,
        result.deployment.agentId,
        result.connection.id,
        intentId,
        input.userId,
        JSON.stringify(["messaging.inbound", "messaging.outbound"]),
        eligibility.permissionRevision,
        growthRequestId,
        requestDigest,
      ],
    );
  } catch (error) {
    await admin(core.config, {
      version: "1",
      requestId: randomUUID(),
      operation: "growth.unlink",
      actor: input.actor,
      growthOrganizationId: input.orgId,
      connectionId: result.connection.id,
    }).catch(() => undefined);
    throw error;
  }
  return { grantId, deployment: result.deployment, targetAgentId: agentId };
}

export async function unlinkAssistantChannel(
  core: CoreContext,
  input: {
    actor: GrowthAgentActor;
    orgId: string;
    provider: "whatsapp" | "telegram";
    connectionId: string;
  },
  admin: ChannelAdminClient = requestGrowthChannelAdmin,
): Promise<{ status: string }> {
  const agentId = await targetAgent(core, admin, input.actor, input.orgId);
  if (input.provider === "telegram") {
    const result = await admin(core.config, {
      version: "1",
      requestId: randomUUID(),
      operation: "channel.unbind",
      actor: input.actor,
      growthOrganizationId: input.orgId,
      connectionId: input.connectionId,
    });
    return { status: result.status ?? "revoked" };
  }
  const grant = (
    await core.pool.query<{ id: string; agentsConnectionId: string }>(
      `SELECT id,"agentsConnectionId" FROM "GrowthAgentChannelGrant"
        WHERE "connectionId"=$1 AND "agentsAgentId"=$2
          AND state IN ('active','needs_attention') LIMIT 1`,
      [input.connectionId, agentId],
    )
  ).rows[0];
  if (!grant) return { status: "not_linked" };
  await admin(core.config, {
    version: "1",
    requestId: randomUUID(),
    operation: "growth.unlink",
    actor: input.actor,
    growthOrganizationId: input.orgId,
    connectionId: grant.agentsConnectionId,
  });
  await core.pool.query(
    `UPDATE "GrowthAgentChannelGrant"
        SET state='revoked',"routeOwner"='growth',"revokedAt"=now(),"expiresAt"=NULL,"updatedAt"=now()
      WHERE id=$1`,
    [grant.id],
  );
  return { status: "revoked" };
}
