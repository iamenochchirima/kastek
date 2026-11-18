import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { requirePermission } from "../../platform/access/permissions";

/** A workspace owner may share only a connection they personally control. */
export function registerApplicationConnectionSharing(app: FastifyInstance, options: {
  pool: Pool; resolveScope(request: FastifyRequest): Promise<ActionScope>;
}) {
  const path = "/api/organizations/:organizationId/connections/:connectionId/application-sharing";
  const params = z.strictObject({ organizationId: z.uuid(), connectionId: z.uuid() });
  async function inspect(request: FastifyRequest, change?: { enabled: boolean; policyRevision: number }) {
    const scope = await options.resolveScope(request), { connectionId } = params.parse(request.params);
    return transaction(options.pool, async db => {
      await requirePermission(db, scope, "credentials.manage");
      const row = (await db.query(`SELECT c.id,c.account_id,c.state,c.expires_at,c.profile_id,c.policy_revision,
        c.application_shared_policy_revision,p.sharing provider_sharing
        FROM agents_platform.connections c LEFT JOIN agents_platform.native_provider_connections p ON p.connection_id=c.id
        WHERE c.id=$1 AND c.organization_id=$2 FOR UPDATE OF c`, [connectionId, scope.organizationId])).rows[0];
      if (!row || row.account_id !== scope.accountId) throw new PlatformError("NOT_FOUND", 404, "Connection not found");
      if (change) {
        if (row.policy_revision !== change.policyRevision) throw new PlatformError("CONNECTION_REVISION_CONFLICT", 409, "Connection permissions changed");
        if (change.enabled && (row.state !== "active" || new Date(row.expires_at).getTime() <= Date.now() ||
          row.profile_id === "report-delivery-v1" || row.provider_sharing != null && row.provider_sharing !== "organization_service"))
          throw new PlatformError("CONNECTION_SHARING_UNAVAILABLE", 409, "Connection is not available for applications");
        await db.query("UPDATE agents_platform.connections SET application_shared_policy_revision=$2 WHERE id=$1", [connectionId, change.enabled ? row.policy_revision : null]);
        row.application_shared_policy_revision = change.enabled ? row.policy_revision : null;
      }
      return { enabled: row.state === "active" && new Date(row.expires_at).getTime() > Date.now() &&
        row.application_shared_policy_revision === row.policy_revision && (row.provider_sharing == null || row.provider_sharing === "organization_service"),
        policyRevision: row.policy_revision };
    });
  }
  app.get(path, request => inspect(request));
  app.put(path, request => inspect(request, z.strictObject({ enabled: z.boolean(), policyRevision: z.number().int().positive() }).parse(request.body)));
}
