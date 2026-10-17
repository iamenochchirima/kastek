import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export interface WebsiteDeploymentRecord {
  id: string;
  public_id: string;
  organization_id: string;
  source_installation_id: string;
  installation_id: string;
  channel_connection_id: string;
  status: "ACTIVE" | "PAUSED" | "REVOKED";
  allowed_origins: string[];
  configuration: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/** A website pin is independent of the source installation's later Playground edits. */
export class WebsiteDeploymentRepository {
  constructor(private readonly pool: Pool) {}

  async list(organizationId: string, sourceInstallationId: string): Promise<WebsiteDeploymentRecord[]> {
    return (await query<WebsiteDeploymentRecord>(this.pool,
      "SELECT * FROM agent_website_deployments WHERE organization_id = $1 AND source_installation_id = $2 ORDER BY created_at DESC",
      [organizationId, sourceInstallationId])).rows;
  }

  async create(input: { organizationId: string; sourceInstallationId: string; actorId: string; origins: string[]; configuration: Record<string, unknown> }): Promise<WebsiteDeploymentRecord> {
    return withTransaction(this.pool, async client => {
      const publicId = randomUUID();
      // Validate the source and its published version in the same transaction that pins it.
      // The new Live installation starts with the same ready default binding
      // used by other hosted-agent creation paths. Model credentials are checked
      // separately at execution time and are never copied from the Test target.
      const installation = await client.query<{ id: string }>(
        `INSERT INTO agent_installations
          (organization_id, agent_definition_id, agent_version_id, scope_type, scope_id,
           execution_mode, release_mode, settings, created_by)
         SELECT source.organization_id, source.agent_definition_id, source.agent_version_id,
                'organization', $4, 'kasitek_hosted', 'pinned', $5::jsonb, $3
         FROM agent_installations source
         JOIN agent_definitions definition ON definition.id = source.agent_definition_id
         JOIN agent_versions version ON version.id = source.agent_version_id
         WHERE source.id = $2 AND source.organization_id = $1 AND source.status = 'active'
           AND source.execution_mode = 'kasitek_hosted' AND definition.protected = false
           AND definition.status = 'active' AND definition.agent_audience = 'customer_service'
           AND version.status = 'published' AND version.agent_definition_id = definition.id
         RETURNING id`, [
          input.organizationId,
          input.sourceInstallationId,
          input.actorId,
          `website:${publicId}`,
          JSON.stringify({
            environment: "live",
            source: "website",
            bindingRevision: "system-default",
            bindingStatus: "ready",
          }),
        ]);
      const live = installation.rows[0];
      if (!live) throw Object.assign(new Error("Make a tested customer-service agent version available first"), { statusCode: 409 });
      await client.query("INSERT INTO agent_principals (installation_id, organization_id) VALUES ($1, $2)", [live.id, input.organizationId]);
      const connection = await client.query<{ id: string }>(
        `INSERT INTO channel_connections (organization_id, installation_id, channel_type, channel_key, metadata, created_by)
         VALUES ($1, $2, 'website', $3, '{}'::jsonb, $4) RETURNING id`, [input.organizationId, live.id, publicId, input.actorId]);
      const deployment = await client.query<WebsiteDeploymentRecord>(
        `INSERT INTO agent_website_deployments
          (public_id, organization_id, source_installation_id, installation_id, channel_connection_id, allowed_origins, configuration, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING *`,
        [publicId, input.organizationId, input.sourceInstallationId, live.id, connection.rows[0]!.id, JSON.stringify(input.origins), JSON.stringify(input.configuration), input.actorId]);
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'website.published', 'website_deployment', $3, $4::jsonb)`,
        [input.organizationId, input.actorId, deployment.rows[0]!.id, JSON.stringify({ sourceInstallationId: input.sourceInstallationId, installationId: live.id })]);
      return deployment.rows[0]!;
    });
  }

  async update(input: { organizationId: string; sourceInstallationId: string; deploymentId: string; origins?: string[]; configuration: Record<string, unknown> }): Promise<WebsiteDeploymentRecord | null> {
    return (await query<WebsiteDeploymentRecord>(this.pool,
      `UPDATE agent_website_deployments SET allowed_origins = COALESCE($4::jsonb, allowed_origins),
        configuration = configuration || $5::jsonb || jsonb_build_object('appearance',
          COALESCE(configuration->'appearance', '{}'::jsonb) || COALESCE($5::jsonb->'appearance', '{}'::jsonb)), updated_at = now()
       WHERE organization_id = $1 AND source_installation_id = $2 AND id = $3 AND status <> 'REVOKED' RETURNING *`,
      [input.organizationId, input.sourceInstallationId, input.deploymentId, input.origins ? JSON.stringify(input.origins) : null, JSON.stringify(input.configuration)])).rows[0] ?? null;
  }

  async setStatus(input: { organizationId: string; sourceInstallationId: string; deploymentId: string; status: WebsiteDeploymentRecord["status"] }): Promise<WebsiteDeploymentRecord | null> {
    return withTransaction(this.pool, async client => {
      const result = await client.query<WebsiteDeploymentRecord>(
        `UPDATE agent_website_deployments SET status = $4, updated_at = now()
         WHERE organization_id = $1 AND source_installation_id = $2 AND id = $3 AND status <> 'REVOKED' RETURNING *`,
        [input.organizationId, input.sourceInstallationId, input.deploymentId, input.status]);
      const deployment = result.rows[0];
      if (!deployment) return null;
      await client.query("UPDATE agent_installations SET status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2",
        [input.organizationId, deployment.installation_id, input.status === "ACTIVE" ? "active" : input.status === "PAUSED" ? "paused" : "disabled"]);
      await client.query("UPDATE channel_connections SET status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2",
        [input.organizationId, deployment.channel_connection_id, input.status === "ACTIVE" ? "active" : "revoked"]);
      return deployment;
    });
  }
}
