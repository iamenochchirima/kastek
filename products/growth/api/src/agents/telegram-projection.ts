import type { Pool } from "pg";
import { syncPermissionInventory } from "../integrations/connection-permissions.js";

type TelegramConnection = {
  id: string;
  organizationId: string;
  name: string;
  assetId: string | null;
  state: string;
  revision: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const activeState = (connection: TelegramConnection) =>
  connection.state === "active" && connection.metadata.setupStatus === "verified";

/**
 * Projects Agents-owned Telegram connections into Growth's connection list.
 * Growth never stores the bot token; only display and health metadata are copied.
 */
export async function syncTelegramProjection(
  pool: Pool,
  orgId: string,
  connections: TelegramConnection[],
  options: {
    prune?: boolean;
    syncPermissions?: (pool: Pool, orgId: string) => Promise<void>;
  } = {},
): Promise<void> {
  for (const connection of connections) {
    const active = activeState(connection);
    const metadata = {
      channelType: "telegram",
      agentsConnectionId: connection.id,
      agentsRevision: connection.revision,
      botId: connection.assetId,
      botUsername:
        typeof connection.metadata.botUsername === "string"
          ? connection.metadata.botUsername
          : null,
      authMethod: "telegram_bot",
      setupStatus: connection.metadata.setupStatus ?? "unverified",
      webhookStatus: active ? "verified" : "unverified",
      permissions: ["telegram_bot"],
      permissionsInspected: true,
      capabilityChecks: {
        MESSAGING_INBOUND: active,
        MESSAGING_OUTBOUND: active,
      },
    };
    await pool.query(
      `INSERT INTO "ExternalConnection" (
         id,"orgId",provider,"sourceType","sourceId","externalAccountId","displayName",handle,
         status,"credentialStatus","healthStatus","webhookStatus","lastCheckedAt",metadata,
         "createdAt","updatedAt")
       VALUES ($1,$2,'TELEGRAM','TELEGRAM',$3,$4,$5,NULL,
         $6::"ExternalConnectionStatus",$7,$8,$9,NOW(),$10::jsonb,$11,NOW())
       ON CONFLICT ("orgId","sourceType","sourceId") DO UPDATE SET
         "externalAccountId"=EXCLUDED."externalAccountId",
         "displayName"=EXCLUDED."displayName",
         status=EXCLUDED.status,
         "credentialStatus"=EXCLUDED."credentialStatus",
         "healthStatus"=EXCLUDED."healthStatus",
         "webhookStatus"=EXCLUDED."webhookStatus",
         "lastCheckedAt"=EXCLUDED."lastCheckedAt",
         metadata=EXCLUDED.metadata,
         "updatedAt"=NOW()`,
      [
        `ext_${connection.id}`,
        orgId,
        connection.id,
        connection.assetId,
        connection.name,
        active ? "CONNECTED" : "NEEDS_ATTENTION",
        active ? "ACTIVE" : "EXPIRED",
        active ? "HEALTHY" : "NEEDS_ATTENTION",
        active ? "SUBSCRIBED" : "UNKNOWN",
        JSON.stringify(metadata),
        connection.createdAt,
      ],
    );
  }
  if (options.prune) {
    const ids = connections.map((connection) => connection.id);
    await pool.query(
      `DELETE FROM "ExternalConnection"
        WHERE "orgId"=$1 AND "sourceType"='TELEGRAM' AND NOT ("sourceId" = ANY($2::text[]))`,
      [orgId, ids],
    );
  }
  await (options.syncPermissions ?? syncPermissionInventory)(pool, orgId);
}
