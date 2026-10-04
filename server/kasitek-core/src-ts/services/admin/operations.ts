import { SerdeFloat } from "@kasitek-labs/server-support/json";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../../context.js";
import { ApiError } from "../../error.js";
import { AgentPlatformClient } from "../agent-platform/client.js";
import {
  extractAdmin,
  requireAdminRole,
  canExecuteOperatorCommand,
  canManageSupportAccess,
  canViewSupportAccess,
  canUseEmergencyAccess,
  type AdminUser,
} from "../../identity/admin-session.js";
import * as support from "./support-access.js";
import * as replay from "./webhook-replay.js";
import { bad, byteLength, obj, type ObjectValue } from "./common.js";
import { queryU32, queryString, typedQuery } from "../../typed-query.js";
const prefix = "/api/admin/operations";
export function registerOperatorRoutes(
  app: FastifyInstance,
  context: CoreContext,
) {
  const client = () => new AgentPlatformClient(context.config);
  async function access(
    request: FastifyRequest,
    mode = "read",
  ): Promise<AdminUser> {
    const admin = await extractAdmin(request, context);
    requireAdminRole(admin, [
      "viewer",
      "support",
      "operator",
      "security",
      "admin",
      "superadmin",
      "owner",
    ]);
    const allowed =
      mode === "command"
        ? canExecuteOperatorCommand(admin.role)
        : mode === "support-view"
          ? canViewSupportAccess(admin.role)
          : mode === "support-manage"
            ? canManageSupportAccess(admin.role)
            : true;
    if (!allowed)
      throw new ApiError(
        403,
        "forbidden",
        mode === "command"
          ? "Operator command permission is required"
          : mode === "support-view"
            ? "Support access visibility permission is required"
            : "Support access management permission is required",
      );
    return admin;
  }
  function listLimit(request: FastifyRequest) {
    const query = typedQuery<{ limit?: string }>(request.query, ["limit"]);
    return queryU32(query.limit, "limit");
  }
  function limit(raw: number | undefined, label: string, max = 500) {
    const n = raw ?? null;
    if (n != null && (n < 1 || n > max))
      bad(`${label} limit must be between 1 and ${max}`);
    return n;
  }
  function objectBody(body: unknown, message: string) {
    if (
      !body ||
      typeof body !== "object" ||
      body instanceof SerdeFloat ||
      Array.isArray(body)
    )
      bad(message);
    return body as ObjectValue;
  }
  app.get(prefix + "/runs", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorRuns(
      admin.id,
      limit(requestedLimit, "Operator run"),
    );
  });
  app.get(prefix + "/exports", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorExports(
      admin.id,
      limit(requestedLimit, "Operator export"),
    );
  });
  app.get(prefix + "/kill-switches", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorKillSwitches(
      admin.id,
      limit(requestedLimit, "Operator kill-switch"),
    );
  });
  app.get(prefix + "/feature-flags", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorFeatureFlags(
      admin.id,
      limit(requestedLimit, "Operator feature-flag"),
    );
  });
  app.get(prefix + "/audio-transcription/jobs", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorAudioTranscriptionJobs(
      admin.id,
      limit(requestedLimit, "Audio transcription job"),
    );
  });
  app.get(prefix + "/holds", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorHolds(
      admin.id,
      limit(requestedLimit, "Operator hold"),
    );
  });
  app.get(prefix + "/retention/policies", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorRetentionPolicies(
      admin.id,
      limit(requestedLimit, "Retention policy"),
    );
  });
  app.get(prefix + "/retention/legal-holds", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorLegalHolds(
      admin.id,
      limit(requestedLimit, "Legal hold"),
    );
  });
  app.get(prefix + "/effects/reconciliation", async (request) => {
    const requestedLimit = listLimit(request);
    const admin = await access(request);
    return client().operatorEffectsReconciliation(
      admin.id,
      limit(requestedLimit, "Operator reconciliation"),
    );
  });
  app.get(prefix + "/summary", async (request) => {
    const admin = await access(request);
    return client().operatorSummary(admin.id);
  });
  app.get(prefix + "/health", async (request) => {
    const admin = await access(request);
    return client().operatorHealth(admin.id);
  });
  app.get(prefix + "/notifications", async (request) => {
    const admin = await access(request);
    return client().operatorNotifications(admin.id);
  });
  app.post<{ Params: { notificationId: string } }>(
    prefix + "/notifications/:notificationId/acknowledge",
    async (request) => {
      const admin = await access(request, "command");
      const notificationId = request.params.notificationId.trim();
      if (!notificationId || byteLength(notificationId) > 240)
        bad("Operator notification id is invalid");
      return client().operatorAcknowledgeNotification(
        admin.id,
        notificationId,
      );
    },
  );
  app.get<{ Params: { organizationId: string } }>(
    prefix + "/retention/preview/:organizationId",
    async (request) => {
      const admin = await access(request),
        org = request.params.organizationId.trim();
      if (!org || byteLength(org) > 240)
        bad("Retention preview organization id is invalid");
      return client().operatorRetentionPreview(admin.id, org);
    },
  );
  app.get(prefix + "/audit", async (request) => {
    const q = typedQuery<{
        action?: string;
        resourceType?: string;
        limit?: string;
      }>(request.query, ["action", "resourceType", "limit"]),
      parsedLimit = queryU32(q.limit, "limit");
    const admin = await access(request);
    return client().operatorAudit(
      admin.id,
      q.action ?? null,
      q.resourceType ?? null,
      limit(parsedLimit, "Operator audit"),
    );
  });
  app.get(prefix + "/search", async (request) => {
    const q = typedQuery<{ q?: string; limit?: string }>(request.query, [
        "q",
        "limit",
      ]),
      term = queryString(q.q, "q", true)!.trim(),
      parsedLimit = queryU32(q.limit, "limit");
    const admin = await access(request);
    if (byteLength(term) < 2 || byteLength(term) > 160)
      bad("Operator search requires 2-160 characters");
    const requestedLimit = limit(parsedLimit, "Operator search", 200);
    return client().operatorSearch(admin.id, term, requestedLimit);
  });
  app.post(prefix + "/commands", async (request, reply) => {
    const admin = await access(request, "command"),
      key = replay.validateReplayKey(
        String(request.headers["idempotency-key"] ?? ""),
      ),
      body = objectBody(
        request.body,
        "Operator command body must be an object",
      );
    if (
      body.commandType === "kill_switch_enable" &&
      obj(body.payload).scopeType === "global" &&
      !canUseEmergencyAccess(admin.role)
    )
      throw new ApiError(
        403,
        "forbidden",
        "Global kill-switch commands require emergency owner access",
      );
    return reply
      .code(202)
      .send(await client().operatorCreateCommand(admin.id, key, body));
  });
  app.get<{ Params: { commandId: string } }>(
    prefix + "/commands/:commandId",
    async (request) => {
      const admin = await access(request);
      return client().operatorGetCommand(
        admin.id,
        request.params.commandId.trim(),
      );
    },
  );
  app.post<{ Params: { commandId: string } }>(
    prefix + "/commands/:commandId/approve",
    async (request, reply) => {
      const admin = await access(request, "command");
      return reply
        .code(202)
        .send(
          await client().operatorApproveCommand(
            admin.id,
            request.params.commandId.trim(),
          ),
        );
    },
  );
  app.get(prefix + "/webhooks/deliveries", async (request) => {
    const requestedLimit = listLimit(request);
    await access(request);
    return {
      deliveries: await replay.failedDeliveries(
        context.pool,
        limit(requestedLimit, "Webhook delivery", 100) ?? 50,
      ),
    };
  });
  app.post(prefix + "/webhooks/replays", async (request, reply) => {
    const admin = await access(request, "command");
    return reply
      .code(202)
      .send(
        await replay.createReplay(
          context.pool,
          String(request.headers["idempotency-key"] ?? ""),
          admin.id,
          obj(request.body),
        ),
      );
  });
  app.get<{ Params: { commandId: string } }>(
    prefix + "/webhooks/replays/:commandId",
    async (request) => {
      await access(request);
      return replay.getReplay(context.pool, request.params.commandId.trim());
    },
  );
  app.post<{ Params: { commandId: string } }>(
    prefix + "/webhooks/replays/:commandId/approve",
    async (request, reply) =>
      reply
        .code(202)
        .send(
          await replay.approveReplay(
            context.pool,
            request.params.commandId.trim(),
            (await access(request, "command")).id,
          ),
        ),
  );
  app.get(prefix + "/support-grants", async (request) => {
    const q = typedQuery<{ organizationId?: string }>(request.query, [
      "organizationId",
    ]);
    await access(request, "support-view");
    return {
      grants: await support.listSupportGrants(
        context.pool,
        q.organizationId?.trim() ?? null,
      ),
    };
  });
  app.post(prefix + "/support-grants", async (request, reply) =>
    reply
      .code(201)
      .send(
        await support.createSupportGrant(
          context.pool,
          await access(request, "support-manage"),
          obj(request.body),
        ),
      ),
  );
  app.post<{ Params: { grantId: string } }>(
    prefix + "/support-grants/:grantId/revoke",
    async (request) =>
      support.revokeSupportGrant(
        context.pool,
        await access(request, "support-manage"),
        request.params.grantId,
      ),
  );
  app.get<{ Params: { projectionKey: string } }>(
    prefix + "/projections/:projectionKey",
    async (request) => {
      const admin = await access(request);
      return client().operatorProjection(
        admin.id,
        request.params.projectionKey,
      );
    },
  );
  app.post(prefix + "/projections/rebuild", async (request) => {
    const admin = await access(request, "command");
    const input = objectBody(
      request.body,
      "Projection rebuild body must be an object",
    );
    return client().operatorRebuildProjections(admin.id, input);
  });
}
