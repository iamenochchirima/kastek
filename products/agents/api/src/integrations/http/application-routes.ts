import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { Applications } from "../../platform/access/applications";
import { requirePermission } from "../../product/members/permissions";

export function registerApplicationRoutes(app: FastifyInstance, options: {
  pool: Pool; resolveScope(request: FastifyRequest): Promise<{ accountId: string; organizationId: string }>;
}) {
  const applications = new Applications(options.pool, async (db, owner) => {
    const membership = await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [owner.organizationId, owner.accountId]);
    if (!membership.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    await requirePermission(db, owner, "credentials.manage");
  });
  const base = "/api/organizations/:organizationId/applications";
  app.get(base, async request => ({ applications: await applications.list(await options.resolveScope(request)) }));
  app.post(base, async (request, reply) => reply.code(201).header("cache-control", "no-store").send(await applications.create(await options.resolveScope(request), request.body)));
  app.post(`${base}/:applicationId/revoke`, async request => {
    const { applicationId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid() }).parse(request.params);
    return applications.revoke(await options.resolveScope(request), applicationId);
  });
  app.post(`${base}/:applicationId/credentials`, async (request, reply) => {
    const { applicationId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid() }).parse(request.params);
    return reply.code(201).header("cache-control", "no-store").send(await applications.issueCredential(await options.resolveScope(request), applicationId, request.body));
  });
  app.post(`${base}/:applicationId/credentials/:credentialId/revoke`, async request => {
    const { applicationId, credentialId } = z.strictObject({ organizationId: z.uuid(), applicationId: z.uuid(), credentialId: z.uuid() }).parse(request.params);
    return applications.revokeCredential(await options.resolveScope(request), applicationId, credentialId);
  });
  app.get("/v1/agents", async (request, reply) => {
    const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
    if (!match) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    return reply.header("cache-control", "private, no-store").send({ agents: await applications.listAgents(match[1]!) });
  });
}
