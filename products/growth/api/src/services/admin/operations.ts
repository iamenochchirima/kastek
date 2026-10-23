import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../../context.js";
import { ApiError } from "../../error.js";
import {
  extractAdmin,
  requireAdminRole,
  canExecuteOperatorCommand,
  canManageSupportAccess,
  canViewSupportAccess,
  type AdminUser,
} from "../../identity/admin-session.js";
import * as support from "./support-access.js";
import * as replay from "./webhook-replay.js";
import { bad, obj } from "./common.js";
import { queryU32, typedQuery } from "../../typed-query.js";
const prefix = "/api/admin/operations";
export function registerOperatorRoutes(
  app: FastifyInstance,
  context: CoreContext,
) {
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
}
