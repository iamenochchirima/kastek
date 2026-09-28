import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";
import { CUSTOMER_SERVICE_HANDOFF_TOOL, LEGACY_CUSTOMER_SERVICE_HANDOFF_TOOL } from "../../system/hosted-agent-defaults";
import { listIntegrations } from "../../integrations/catalog";

export interface ToolGrantRecord {
  id: string;
  organization_id: string;
  agent_version_id: string;
  installation_id: string | null;
  tool_name: string;
  granted_by: string;
  created_at: string;
  revoked_at: string | null;
}

type Executor = Pool | PoolClient;

export class ToolGrantRepository {
  public constructor(private readonly pool: Pool) {}

  public async grantVersionTool(input: {
    organizationId: string;
    agentId: string;
    versionId: string;
    toolName: string;
    actorId: string;
  }): Promise<ToolGrantRecord> {
    return this.grant({ ...input, installationId: undefined });
  }

  public async grantInstallationTool(input: {
    organizationId: string;
    installationId: string;
    toolName: string;
    actorId: string;
  }): Promise<ToolGrantRecord> {
    return withTransaction(this.pool, async (client) => {
      const installation = await client.query<{ agent_version_id: string; agent_definition_id: string }>(
        `SELECT agent_version_id, agent_definition_id FROM agent_installations
         WHERE id = $1 AND organization_id = $2`,
        [input.installationId, input.organizationId],
      );
      const target = installation.rows[0];
      if (!target) throw new Error("Installation not found");
      return this.grantWithExecutor(client, {
        organizationId: input.organizationId,
        agentId: target.agent_definition_id,
        versionId: target.agent_version_id,
        installationId: input.installationId,
        toolName: input.toolName,
        actorId: input.actorId,
      });
    });
  }

  /**
   * Remove installation-scoped activation for a disconnected integration.
   * Version-level policy grants remain untouched; reconnecting the provider
   * can safely activate its bundle again on the current installation.
   */
  public async revokeInstallationTools(input: {
    organizationId: string;
    installationId: string;
    toolNames: readonly string[];
    actorId: string;
  }): Promise<number> {
    const toolNames = [...new Set(input.toolNames.map((name) => name.trim()).filter(Boolean))];
    if (!toolNames.length) return 0;
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE agent_tool_grants
         SET revoked_at = now()
         WHERE organization_id = $1 AND installation_id = $2
           AND tool_name = ANY($3::text[]) AND revoked_at IS NULL`,
        [input.organizationId, input.installationId, toolNames],
      );
      if (result.rowCount) {
        await client.query(
          `INSERT INTO audit_records
            (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           VALUES ($1, 'human', $2, 'agent_installation_tools.revoked', 'agent_installation', $3, $4::jsonb)`,
          [input.organizationId, input.actorId, input.installationId, JSON.stringify({ toolNames })],
        );
      }
      return result.rowCount ?? 0;
    });
  }

  private async grant(input: {
    organizationId: string;
    agentId: string;
    versionId: string;
    installationId?: string;
    toolName: string;
    actorId: string;
  }): Promise<ToolGrantRecord> {
    return withTransaction(this.pool, (client) => this.grantWithExecutor(client, input));
  }

  private async grantWithExecutor(executor: Executor, input: {
    organizationId: string;
    agentId: string;
    versionId: string;
    installationId?: string;
    toolName: string;
    actorId: string;
  }): Promise<ToolGrantRecord> {
    const version = await executor.query<{ id: string; agent_audience: "personal" | "customer_service" }>(
      `SELECT av.id, ad.agent_audience FROM agent_versions av
       JOIN agent_definitions ad ON ad.id = av.agent_definition_id
       WHERE av.id = $1 AND ad.id = $2 AND ad.organization_id = $3`,
      [input.versionId, input.agentId, input.organizationId],
    );
    if (!version.rows[0]) throw new Error("Agent version not found");
    if ([CUSTOMER_SERVICE_HANDOFF_TOOL, LEGACY_CUSTOMER_SERVICE_HANDOFF_TOOL].includes(input.toolName.trim()) && version.rows[0].agent_audience !== "customer_service") {
      throw new Error("Customer handoff capability requires a customer-service agent");
    }
    const result = await executor.query<ToolGrantRecord>(
      `INSERT INTO agent_tool_grants
        (organization_id, agent_version_id, installation_id, tool_name, granted_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
         WHERE revoked_at IS NULL
       DO UPDATE SET revoked_at = NULL, granted_by = EXCLUDED.granted_by
       RETURNING *`,
      [input.organizationId, input.versionId, input.installationId ?? null, input.toolName.trim(), input.actorId],
    );
    return result.rows[0]!;
  }

  public async revoke(input: {
    organizationId: string;
    grantId: string;
    actorId: string;
  }): Promise<void> {
    const result = await query(
      this.pool,
      `UPDATE agent_tool_grants SET revoked_at = now()
       WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL`,
      [input.grantId, input.organizationId],
    );
    if (!result.rowCount) throw new Error("Tool grant not found");
    await query(
      this.pool,
      `INSERT INTO audit_records
        (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, 'human', $2, 'agent_tool_grant.revoked', 'agent_tool_grant', $3, '{}'::jsonb)`,
      [input.organizationId, input.actorId, input.grantId],
    );
  }

  public async listForVersion(organizationId: string, versionId: string): Promise<ToolGrantRecord[]> {
    const result = await query<ToolGrantRecord>(
      this.pool,
      `SELECT * FROM agent_tool_grants
       WHERE organization_id = $1 AND agent_version_id = $2
       ORDER BY created_at ASC`,
      [organizationId, versionId],
    );
    return result.rows;
  }

  public async effectiveTools(
    organizationId: string,
    versionId: string,
    installationId: string,
  ): Promise<Set<string>> {
    const result = await query<{ tool_name: string }>(
      this.pool,
      `SELECT DISTINCT effective.tool_name
       FROM (
         SELECT grants.tool_name
         FROM agent_tool_grants grants
         JOIN agent_versions version ON version.id = grants.agent_version_id
         JOIN agent_definitions agent ON agent.id = version.agent_definition_id
         WHERE grants.agent_version_id = $2 AND grants.revoked_at IS NULL AND (
           (
             grants.organization_id = $1
             AND (grants.installation_id IS NULL OR grants.installation_id = $3)
           ) OR (
             agent.owner_type = 'system' AND agent.protected = TRUE
             AND grants.organization_id = agent.organization_id
             AND grants.installation_id IS NULL
           )
       )) effective`,
      [organizationId, versionId, installationId],
    );
    const effective = new Set(result.rows.map((row) => row.tool_name));

    // Integration capability bundles are owned by the catalog, not by this
    // persistence repository. Resolve connected connector ids here and map
    // them through the same catalog used by the connect routes and runtime.
    // This prevents a second hand-maintained SQL bundle list from drifting.
    const connected = await query<{ connector_id: string }>(
      this.pool,
      `SELECT DISTINCT connector.connector_id
       FROM integration_connections connection
       JOIN agent_installation_connector_grants connector
         ON connector.organization_id = connection.organization_id
        AND connector.installation_id = connection.installation_id
        AND connector.connector_id = connection.integration_id
        AND connector.revoked_at IS NULL
       WHERE connection.organization_id = $1
         AND connection.installation_id = $2
         AND connection.status = 'connected'
         AND connection.revoked_at IS NULL`,
      [organizationId, installationId],
    );
    const integrations = new Map(listIntegrations().map((entry) => [entry.id, entry]));
    for (const row of connected.rows) {
      const integration = integrations.get(row.connector_id);
      if (integration?.kind !== "tool") continue;
      for (const toolName of integration.capabilityNames) effective.add(toolName);
    }

    // KasiTek's built-in integrations are available to every active hosted
    // installation. Keep this in the catalog as well, rather than repeating
    // the native bundle in SQL.
    const installation = await query<{ status: string }>(
      this.pool,
      `SELECT status FROM agent_installations
       WHERE id = $1 AND organization_id = $2`,
      [installationId, organizationId],
    );
    if (installation.rows[0]?.status === "active") {
      for (const integration of integrations.values()) {
        if (integration.kind === "tool" && integration.auth === "internal") {
          for (const toolName of integration.capabilityNames) effective.add(toolName);
        }
      }
    }
    return effective;
  }
}
