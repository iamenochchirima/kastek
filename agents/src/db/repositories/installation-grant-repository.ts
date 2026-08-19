import type { Pool } from "pg";
import { query } from "../pool";

export class InstallationGrantRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * KasiAi is a protected, workspace-hosted platform agent. Its tool allowlist
   * is already release-managed, so record-level grants must not silently turn
   * its organization-scoped platform tools into an empty installation scope.
   * External and user-owned installations remain explicitly resource-scoped.
   */
  public async isResourceScopeUnconstrained(organizationId: string, installationId: string): Promise<boolean> {
    const result = await query<{ unconstrained: boolean }>(this.pool, `
        SELECT EXISTS (
        SELECT 1
        FROM agent_installations ai
        JOIN agent_definitions ad ON ad.id = ai.agent_definition_id
        WHERE ai.organization_id = $1
          AND ai.id = $2
          AND (
            (
              ai.execution_mode = 'system_hosted'
              AND ad.owner_type = 'system'
              AND ad.protected = TRUE
              AND ad.slug = 'kasiai'
            )
            OR ai.settings ->> 'developerApiKeyId' IS NOT NULL
          )
      ) AS unconstrained`, [organizationId, installationId]);
    return result.rows[0]?.unconstrained === true;
  }

  public async grantResource(input: { organizationId: string; installationId: string; resourceType: string; resourceId: string; actorId: string }): Promise<void> {
    const result = await query(this.pool, `INSERT INTO agent_installation_resource_grants (organization_id, installation_id, resource_type, resource_id, granted_by)
      SELECT $1, $2, $3, $4, $5 WHERE EXISTS (SELECT 1 FROM agent_installations WHERE id = $2 AND organization_id = $1)
      ON CONFLICT (installation_id, resource_type, resource_id) DO UPDATE SET revoked_at = NULL`, [input.organizationId, input.installationId, input.resourceType.trim(), input.resourceId.trim(), input.actorId]);
    if (!result.rowCount) throw new Error("Installation not found");
  }

  public async grantConnector(input: { organizationId: string; installationId: string; connectorId: string; actorId: string }): Promise<void> {
    const result = await query(this.pool, `INSERT INTO agent_installation_connector_grants (organization_id, installation_id, connector_id, granted_by)
      SELECT $1, $2, $3, $4 WHERE EXISTS (SELECT 1 FROM agent_installations WHERE id = $2 AND organization_id = $1)
      ON CONFLICT (installation_id, connector_id) DO UPDATE SET revoked_at = NULL`, [input.organizationId, input.installationId, input.connectorId.trim(), input.actorId]);
    if (!result.rowCount) throw new Error("Installation not found");
  }

  public async effective(organizationId: string, installationId: string): Promise<{ resources: Array<{ resourceType: string; resourceId: string }>; connectors: string[] }> {
    const [resources, connectors] = await Promise.all([
      query<{ resource_type: string; resource_id: string }>(this.pool, `SELECT resource_type, resource_id FROM agent_installation_resource_grants WHERE organization_id=$1 AND installation_id=$2 AND revoked_at IS NULL`, [organizationId, installationId]),
      query<{ connector_id: string }>(this.pool, `SELECT connector_id FROM agent_installation_connector_grants WHERE organization_id=$1 AND installation_id=$2 AND revoked_at IS NULL`, [organizationId, installationId]),
    ]);
    return { resources: resources.rows.map((row) => ({ resourceType: row.resource_type, resourceId: row.resource_id })), connectors: connectors.rows.map((row) => row.connector_id) };
  }
}
