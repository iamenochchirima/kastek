import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractAdmin, requireAdminRole } from "../identity/admin-session.js";
import * as access from "../services/admin/launch-access.js";
export function registerAdminLaunchAccessRoutes(
  app: FastifyInstance,
  core: CoreContext,
) {
  const authorize = async (request: FastifyRequest, roles: string[]) =>
    requireAdminRole(await extractAdmin(request, core), roles);
  app.get("/api/admin/access", async (request) => {
    await authorize(request, ["superadmin", "admin", "viewer"]);
    return { access: await access.listLaunchAccess(core) };
  });
  app.post<{ Body: access.LaunchUserRequest }>(
    "/api/admin/access",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "email", "workspaceName"],
          properties: {
            name: { type: "string" },
            email: { type: "string" },
            workspaceName: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      await authorize(request, ["superadmin", "admin"]);
      return reply
        .code(201)
        .send(await access.provisionLaunchUser(core, request.body));
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/access/:id/resend",
    async (request) => {
      await authorize(request, ["superadmin", "admin"]);
      return access.resendLaunchAccess(core, request.params.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/access/:id/revoke",
    async (request) => {
      await authorize(request, ["superadmin", "admin"]);
      return access.revokeLaunchAccess(core, request.params.id);
    },
  );
}
