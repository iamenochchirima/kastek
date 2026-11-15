import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  growthChannelAdminResponseSchema,
  parseGrowthChannelAdminRequest,
  type GrowthChannelAdminRequest,
} from "@kasitek-labs/contracts";
import { GrowthServiceAuth, type GrowthServiceTrust } from "../../adapters/products/growth-service-auth";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { ActionScope } from "../../contracts/connections";
import { transaction } from "../../infrastructure/database";
import type { ChannelStore } from "../channels/channel-store";
import type { TelegramSetupService } from "../channels/telegram-setup";
import { recordProductServiceAssertion } from "./product-service-receipt";

export interface GrowthChannelAdminOptions {
  pool: Pool;
  trust?: GrowthServiceTrust;
  store: ChannelStore;
  telegram?: TelegramSetupService;
}

type ConnectionDto = ReturnType<typeof connectionDto>;
type DeploymentDto = ReturnType<typeof deploymentDto>;

const GROWTH_CHANNEL_SERVICE_ISSUER =
  "https://growth.kasitek.co.za/products/channel-admin";

function connectionDto(value: Awaited<ReturnType<ChannelStore["list"]>>[number]) {
  return {
    id: value.id,
    organizationId: value.organizationId,
    kind: value.kind,
    name: value.name,
    assetId: value.assetId,
    mode: value.mode,
    state: value.state,
    revision: value.revision,
    credentialRevision: value.credentialRevision,
    metadata: value.metadata,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function deploymentDto(value: Awaited<ReturnType<ChannelStore["bind"]>>) {
  return {
    id: value.id,
    organizationId: value.organizationId,
    connectionId: value.connectionId,
    agentId: value.agentId,
    versionId: value.versionId,
    state: value.state,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

async function resolveScope(
  pool: Pool,
  request: GrowthChannelAdminRequest,
): Promise<ActionScope> {
  const tenant = (
    await pool.query<{ organization_id: string }>(
      `SELECT organization_id FROM agents_platform.product_execution_tenants
        WHERE product='growth' AND tenant_id=$1 AND revoked_at IS NULL`,
      [request.growthOrganizationId],
    )
  ).rows[0];
  if (!tenant) {
    throw new PlatformError(
      "GROWTH_CHANNEL_ORGANIZATION_UNAVAILABLE",
      404,
      "The Growth organization is not linked to an Agents workspace",
    );
  }
  // Growth administrators act through one product-owned service principal per workspace.
  // A Growth user never becomes an Agents account or workspace owner from this route.
  const accountId = await transaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `growth-channel-service:${tenant.organization_id}`,
    ]);
    const subject = `channels:${tenant.organization_id}`;
    const existing = (
      await db.query<{ id: string }>(
        `SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2`,
        [GROWTH_CHANNEL_SERVICE_ISSUER, subject],
      )
    ).rows[0];
    const id =
      existing?.id ??
      (
        await db.query<{ id: string }>(
          `INSERT INTO agents_platform.accounts(id,issuer,subject,email,display_name)
            VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [
            randomUUID(),
            GROWTH_CHANNEL_SERVICE_ISSUER,
            subject,
            "channel-admin@growth.kasitek.co.za",
            "Growth channel administration",
          ],
        )
      ).rows[0]!.id;
    await db.query(
      `INSERT INTO agents_platform.memberships(organization_id,account_id,role)
        VALUES($1,$2,'owner')
        ON CONFLICT (organization_id,account_id)
        DO UPDATE SET role='owner', revoked_at=NULL, role_changed_at=now()`,
      [tenant.organization_id, id],
    );
    return id;
  });
  return { organizationId: tenant.organization_id, accountId };
}

async function growthAssistantTarget(
  pool: Pool,
  organizationId: string,
): Promise<string | undefined> {
  return (
    await pool.query<{ id: string }>(
      `SELECT id FROM agents_platform.agents
        WHERE organization_id=$1 AND offering='growth-assistant' AND deleted_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [organizationId],
    )
  ).rows[0]?.id;
}

async function requiredGrowthAssistantTarget(
  pool: Pool,
  organizationId: string,
): Promise<string> {
  const target = await growthAssistantTarget(pool, organizationId);
  if (!target)
    throw new PlatformError(
      "GROWTH_ASSISTANT_UNAVAILABLE",
      409,
      "The Growth assistant is not provisioned for this workspace",
    );
  return target;
}

async function reserveRequest(
  pool: Pool,
  request: GrowthChannelAdminRequest,
  organizationId: string,
): Promise<{ replay?: unknown }> {
  const digest = requestDigest(request);
  const reserved = await pool.query(
    `INSERT INTO agents_platform.product_request_results(
       product,request_id,organization_id,operation,request_digest)
     VALUES('growth',$1,$2,$3,$4)
     ON CONFLICT (product,request_id) DO NOTHING
     RETURNING request_id`,
    [request.requestId, organizationId, request.operation, digest],
  );
  if (reserved.rowCount) return {};
  const existing = (
    await pool.query<{ request_digest: string; response: unknown | null }>(
      `SELECT request_digest,response FROM agents_platform.product_request_results
        WHERE product='growth' AND request_id=$1`,
      [request.requestId],
    )
  ).rows[0];
  if (!existing || existing.request_digest !== digest)
    throw new PlatformError(
      "PRODUCT_REQUEST_CONFLICT",
      409,
      "This request identity was already used for different input",
    );
  if (existing.response !== null) return { replay: existing.response };
  throw new PlatformError(
    "PRODUCT_REQUEST_IN_PROGRESS",
    409,
    "This channel request is still being processed",
  );
}

async function completeRequest(
  pool: Pool,
  requestId: string,
  response: unknown,
): Promise<void> {
  await pool.query(
    `UPDATE agents_platform.product_request_results SET response=$2
      WHERE product='growth' AND request_id=$1`,
    [requestId, JSON.stringify(response)],
  );
}

async function releaseRequest(pool: Pool, requestId: string): Promise<void> {
  await pool.query(
    `DELETE FROM agents_platform.product_request_results
      WHERE product='growth' AND request_id=$1 AND response IS NULL`,
    [requestId],
  );
}

export function registerGrowthChannelAdminRoutes(
  app: FastifyInstance,
  options: GrowthChannelAdminOptions,
): void {
  const auth = options.trust ? new GrowthServiceAuth(options.trust) : undefined;

  app.post(
    "/internal/v1/products/growth/channels",
    { bodyLimit: 65_536 },
    async (request) => {
      if (!auth) {
        throw new PlatformError(
          "PRODUCT_INTEGRATION_UNAVAILABLE",
          503,
          "Growth integration is not configured",
        );
      }
      let input: GrowthChannelAdminRequest;
      try {
        input = parseGrowthChannelAdminRequest(request.body);
      } catch {
        throw new PlatformError(
          "INVALID_PRODUCT_COMMAND",
          400,
          "Check the channel request fields",
        );
      }
      const bearer = request.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_.-]+)$/,
      )?.[1];
      if (!bearer) {
        throw new PlatformError(
          "PRODUCT_SERVICE_DENIED",
          401,
          "Product service authentication is required",
        );
      }
      const verified = await auth.verify(bearer, input);
      await recordProductServiceAssertion(options.pool, "growth", verified, input);
      const scope = await resolveScope(options.pool, input);
      const reservation = await reserveRequest(
        options.pool,
        input,
        scope.organizationId,
      );
      if (reservation.replay !== undefined) {
        request.log.info(
          {
            event: "growth.channel.admin",
            operation: input.operation,
            actorIssuer: input.actor.issuer,
            actorSubject: input.actor.subject,
            organizationId: scope.organizationId,
            replayed: true,
          },
          "Growth channel administration replayed",
        );
        return growthChannelAdminResponseSchema.parse(reservation.replay);
      }

      try {
        let connection: ConnectionDto | undefined;
        let connections: ConnectionDto[] | undefined;
        let deployment: DeploymentDto | undefined;
        let deployments: DeploymentDto[] | undefined;
        let targetAgentId: string | undefined;
        let status: string | undefined;

        switch (input.operation) {
          case "telegram.connect": {
            if (!options.telegram) {
              throw new PlatformError(
                "CHANNEL_SETUP_NOT_CONFIGURED",
                503,
                "Telegram setup is unavailable",
              );
            }
            const botId = input.botToken.split(":")[0]!;
            const duplicate = (
              await options.pool.query<{ id: string }>(
                `SELECT id FROM agents_platform.channel_connections
                  WHERE organization_id=$1 AND kind='telegram' AND asset_id=$2
                    AND state<>'removed' LIMIT 1`,
                [scope.organizationId, botId],
              )
            ).rows[0];
            if (duplicate)
              throw new PlatformError(
                "TELEGRAM_BOT_ALREADY_CONNECTED",
                409,
                "This Telegram bot is already connected. Manage the existing connection.",
              );
            const result = await options.telegram.connect(scope, {
              name: input.name,
              botToken: input.botToken,
            });
            connection = connectionDto(result.connection);
            status = result.status;
            break;
          }
          case "telegram.health": {
            if (!options.telegram) {
              throw new PlatformError(
                "CHANNEL_SETUP_NOT_CONFIGURED",
                503,
                "Telegram setup is unavailable",
              );
            }
            const result = await options.telegram.health(
              scope,
              input.connectionId,
              input.expectedRevision,
            );
            connection = connectionDto(result.connection);
            status = result.status;
            break;
          }
          case "telegram.rotate": {
            if (!options.telegram) {
              throw new PlatformError(
                "CHANNEL_SETUP_NOT_CONFIGURED",
                503,
                "Telegram setup is unavailable",
              );
            }
            const result = await options.telegram.rotate(
              scope,
              input.connectionId,
              {
                expectedRevision: input.expectedRevision,
                botToken: input.botToken,
              },
            );
            connection = connectionDto(result.connection);
            status = result.status;
            break;
          }
          case "telegram.disconnect": {
            if (!options.telegram) {
              throw new PlatformError(
                "CHANNEL_SETUP_NOT_CONFIGURED",
                503,
                "Telegram setup is unavailable",
              );
            }
            const result = await options.telegram.disconnect(
              scope,
              input.connectionId,
              input.expectedRevision,
            );
            connection = connectionDto(result.connection);
            status = result.status;
            break;
          }
          case "channel.list": {
            const listed = (await options.store.list(scope)).filter(
              (item) => item.kind === "telegram",
            );
            connections = listed.map(connectionDto);
            const ids = new Set(listed.map((item) => item.id));
            deployments = (await options.store.listDeployments(scope))
              .filter((item) => ids.has(item.connectionId))
              .map(deploymentDto);
            break;
          }
          case "assistant.target": {
            targetAgentId = await growthAssistantTarget(
              options.pool,
              scope.organizationId,
            );
            break;
          }
          case "channel.bind": {
            const agentId = await requiredGrowthAssistantTarget(
              options.pool,
              scope.organizationId,
            );
            deployment = deploymentDto(
              await options.store.bind(scope, input.connectionId, {
                expectedRevision: input.expectedRevision,
                agentId,
              }),
            );
            targetAgentId = agentId;
            break;
          }
          case "channel.unbind": {
            const agentId = await requiredGrowthAssistantTarget(
              options.pool,
              scope.organizationId,
            );
            const revoked = await options.pool.query(
              `UPDATE agents_platform.channel_deployments
                SET state='revoked', revision=revision+1, updated_at=now()
                WHERE organization_id=$1 AND connection_id=$2 AND agent_id=$3 AND state='active'`,
              [scope.organizationId, input.connectionId, agentId],
            );
            status = revoked.rowCount ? "revoked" : "not_linked";
            targetAgentId = agentId;
            break;
          }
          case "growth.link": {
            const agentId = await requiredGrowthAssistantTarget(
              options.pool,
              scope.organizationId,
            );
            const pending = await options.store.beginGrowthManaged(scope, {
              kind: "whatsapp",
              name: input.name,
              providerMode: input.providerMode,
              assetId: input.providerAssetId,
              growthOrganizationId: input.growthOrganizationId,
              growthConnectionId: input.connectionId,
              permissionRevision: input.permissionRevision,
              agentId,
              intentId: input.intentId,
              requestId: input.growthRequestId,
              exchangeRequestId: input.exchangeRequestId,
              actor: { issuer: input.actor.issuer, subject: input.actor.subject },
            });
            const active = await options.store.completeGrowthManaged(
              scope,
              pending.id,
              {
                expectedRevision: pending.revision,
                grantId: input.grantId,
                growthActor: {
                  issuer: input.actor.issuer,
                  subject: input.actor.subject,
                },
                permissionRevision: input.permissionRevision,
              },
            );
            const bound = await options.store.bind(scope, active.id, {
              expectedRevision: active.revision,
              agentId,
            });
            connection = connectionDto(active);
            deployment = deploymentDto(bound);
            targetAgentId = agentId;
            break;
          }
          case "growth.unlink": {
            const current = await options.store.get(
              scope,
              input.connectionId,
            );
            connection = connectionDto(
              await options.store.disconnect(
                scope,
                input.connectionId,
                input.expectedRevision ?? current.revision,
                true,
              ),
            );
            status = "revoked";
            break;
          }
        }

        const response = growthChannelAdminResponseSchema.parse({
          version: "1",
          requestId: input.requestId,
          operation: input.operation,
          ...(connection ? { connection } : {}),
          ...(connections ? { connections } : {}),
          ...(deployment ? { deployment } : {}),
          ...(deployments ? { deployments } : {}),
          ...(targetAgentId ? { targetAgentId } : {}),
          ...(status ? { status } : {}),
        });
        await completeRequest(options.pool, input.requestId, response);
        request.log.info(
          {
            event: "growth.channel.admin",
            operation: input.operation,
            actorIssuer: input.actor.issuer,
            actorSubject: input.actor.subject,
            organizationId: scope.organizationId,
            connectionId:
              connection?.id ??
              ("connectionId" in input ? input.connectionId : undefined),
            targetAgentId,
            status,
          },
          "Growth channel administration completed",
        );
        return response;
      } catch (error) {
        await releaseRequest(options.pool, input.requestId).catch(
          () => undefined,
        );
        throw error;
      }
    },
  );
}
