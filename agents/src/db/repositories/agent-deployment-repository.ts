import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { DeployInstallationInput, DeployStagedVersionInput } from "../../domain/types";
import {
  buildInstallationDeploymentEvent,
  enqueueOutbox,
} from "../../analytics";
import { operationalLogger } from "../../telemetry/logger";

export type DeploymentTrigger = "version_published" | "version_rolled_back" | "manual" | "canary";
export type DeploymentAction = "deployed" | "rolled_back" | "failed";

export interface DeploymentInstallation {
  id: string;
  agent_definition_id: string;
  agent_version_id: string;
  organization_id: string;
  scope_type: string;
  scope_id: string;
  status: string;
  execution_mode: "system_hosted" | "kasitek_hosted" | "external_connected";
  settings: Record<string, unknown>;
  created_by: string;
  created_at: string;
  updated_at: string;
  release_mode: "pinned" | "follow_published" | "staged";
}

export interface StagedDeploymentResult {
  versionId: string;
  deployedInstallationIds: string[];
  deploymentCount: number;
}

interface DeploymentInput {
  organizationId: string;
  actorId: string;
  installationId: string;
  versionId: string;
  previousVersionId: string;
  agentDefinitionId: string;
  releaseMode: DeploymentInstallation["release_mode"];
  trigger: DeploymentTrigger;
  action?: DeploymentAction;
  actorType?: "human" | "system";
}

/**
 * Transaction-bound deployment module. The AgentRepository owns agent
 * lifecycle queries; this module owns version movement, eligibility, history,
 * audit records, and analytics for an installation.
 */
export class AgentDeploymentModule {
  public async deployFollowPublishedInstallations(
    client: PoolClient,
    input: { organizationId: string; agentId: string; versionId: string; actorId: string; trigger: "version_published" | "version_rolled_back" },
  ): Promise<number> {
    await this.assertPublishedHostedVersion(client, input.organizationId, input.agentId, input.versionId);
    const installations = await client.query<DeploymentInstallation>(
      `SELECT * FROM agent_installations
       WHERE organization_id = $1
         AND agent_definition_id = $2
         AND release_mode = 'follow_published'
         AND status <> 'disabled'
         AND agent_version_id <> $3
       FOR UPDATE`,
      [input.organizationId, input.agentId, input.versionId],
    );
    for (const installation of installations.rows) {
      await this.applyDeployment(client, {
        organizationId: input.organizationId,
        actorId: input.actorId,
        installationId: installation.id,
        versionId: input.versionId,
        previousVersionId: installation.agent_version_id,
        agentDefinitionId: input.agentId,
        releaseMode: installation.release_mode,
        trigger: input.trigger,
      });
    }
    return installations.rowCount ?? 0;
  }

  public async deployInstallation(
    client: PoolClient,
    organizationId: string,
    actorId: string,
    installationId: string,
    input: DeployInstallationInput,
  ): Promise<DeploymentInstallation> {
    const currentResult = await client.query<DeploymentInstallation>(
      `SELECT ai.*
       FROM agent_installations ai
       WHERE ai.id = $1 AND ai.organization_id = $2
       FOR UPDATE`,
      [installationId, organizationId],
    );
    const current = currentResult.rows[0];
    if (!current) throw deploymentError("Installation not found", 404, "INSTALLATION_NOT_FOUND");
    if (current.status === "disabled") {
      throw deploymentError("Disabled installations cannot be deployed", 409, "INSTALLATION_DISABLED");
    }
    if (input.expectedVersionId && current.agent_version_id !== input.expectedVersionId) {
      throw deploymentError("Installation version changed before deployment", 409, "INSTALLATION_VERSION_CONFLICT");
    }
    if (current.execution_mode !== "kasitek_hosted") {
      throw deploymentError("Only hosted organization installations can be deployed here", 403, "INSTALLATION_DEPLOYMENT_NOT_ALLOWED");
    }
    await this.assertPublishedHostedVersion(client, organizationId, current.agent_definition_id, input.versionId);
    if (current.agent_version_id === input.versionId) return current;
    return this.applyDeployment(client, {
      organizationId,
      actorId,
      installationId,
      versionId: input.versionId,
      previousVersionId: current.agent_version_id,
      agentDefinitionId: current.agent_definition_id,
      releaseMode: current.release_mode,
      trigger: "manual",
    });
  }

  public async deployStagedVersion(
    client: PoolClient,
    organizationId: string,
    actorId: string,
    agentId: string,
    versionId: string,
    input: DeployStagedVersionInput,
  ): Promise<StagedDeploymentResult> {
    await this.assertPublishedHostedVersion(client, organizationId, agentId, versionId);
    const candidates = await client.query<DeploymentInstallation>(
      `SELECT * FROM agent_installations
       WHERE organization_id = $1
         AND agent_definition_id = $2
         AND release_mode = 'staged'
         AND status <> 'disabled'
         AND agent_version_id <> $3
       ORDER BY id
       FOR UPDATE`,
      [organizationId, agentId, versionId],
    );
    const selected = selectCanaryInstallations(candidates.rows, input);
    for (const installation of selected) {
      await this.applyDeployment(client, {
        organizationId,
        actorId,
        installationId: installation.id,
        versionId,
        previousVersionId: installation.agent_version_id,
        agentDefinitionId: agentId,
        releaseMode: installation.release_mode,
        trigger: "canary",
      });
    }
    return {
      versionId,
      deployedInstallationIds: selected.map((installation) => installation.id),
      deploymentCount: selected.length,
    };
  }

  private async assertPublishedHostedVersion(
    client: PoolClient,
    organizationId: string,
    agentId: string,
    versionId: string,
  ): Promise<void> {
    const target = await client.query(
      `SELECT 1
       FROM agent_versions av
       JOIN agent_definitions ad ON ad.id = av.agent_definition_id
       WHERE av.id = $1 AND av.agent_definition_id = $2
         AND ad.organization_id = $3 AND ad.owner_type = 'organization' AND ad.protected = FALSE
         AND av.status = 'published'
       FOR SHARE OF av`,
      [versionId, agentId, organizationId],
    );
    if (!target.rows[0]) throw deploymentError("Published agent version not found", 404, "AGENT_VERSION_NOT_FOUND");
  }

  private async applyDeployment(client: PoolClient, input: DeploymentInput): Promise<DeploymentInstallation> {
    const updated = await client.query<DeploymentInstallation>(
      `UPDATE agent_installations
       SET agent_version_id = $2, updated_at = now()
       WHERE id = $1 AND organization_id = $3 AND agent_definition_id = $4 AND agent_version_id = $5
       RETURNING *`,
      [input.installationId, input.versionId, input.organizationId, input.agentDefinitionId, input.previousVersionId],
    );
    const installation = updated.rows[0];
    if (!installation) {
      operationalLogger.warn({
        event: "agent.installation.deployment.failed",
        organization_id: input.organizationId,
        installation_id: input.installationId,
        agent_definition_id: input.agentDefinitionId,
        target_agent_version_id: input.versionId,
        error_code: "INSTALLATION_VERSION_CONFLICT",
      }, "Installation version changed before deployment");
      throw deploymentError("Installation version changed before deployment", 409, "INSTALLATION_VERSION_CONFLICT");
    }
    const action = input.action ?? (input.trigger === "version_rolled_back" ? "rolled_back" : "deployed");
    await client.query(
      `INSERT INTO agent_installation_deployments
        (organization_id, installation_id, agent_definition_id, previous_agent_version_id,
         agent_version_id, release_mode, action, trigger, outcome, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'success', $9, $10)`,
      [input.organizationId, installation.id, input.agentDefinitionId, input.previousVersionId, input.versionId, input.releaseMode, action, input.trigger, input.actorType ?? "human", input.actorId],
    );
    await client.query(
      `INSERT INTO audit_records
        (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, 'agent_installation.version_deployed', 'agent_installation', $4, $5::jsonb)`,
      [input.organizationId, input.actorType ?? "human", input.actorId, installation.id, JSON.stringify({
        agentId: input.agentDefinitionId,
        previousVersionId: input.previousVersionId,
        versionId: input.versionId,
        releaseMode: input.releaseMode,
        trigger: input.trigger,
      })],
    );
    await enqueueOutbox(client, buildInstallationDeploymentEvent({
      installationId: installation.id,
      organizationId: input.organizationId,
      agentDefinitionId: input.agentDefinitionId,
      agentVersionId: input.versionId,
      previousAgentVersionId: input.previousVersionId,
      releaseMode: input.releaseMode,
      action,
      trigger: input.trigger,
      outcome: "success",
      actorType: input.actorType ?? "human",
      occurredAt: installation.updated_at,
    }));
    return installation;
  }
}

function selectCanaryInstallations(
  candidates: DeploymentInstallation[],
  input: DeployStagedVersionInput,
): DeploymentInstallation[] {
  if (input.installationIds) {
    const requested = new Set(input.installationIds);
    if (requested.size !== input.installationIds.length) {
      throw deploymentError("Duplicate staged installation IDs are not allowed", 400, "STAGED_INSTALLATION_IDS_INVALID");
    }
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const selected = input.installationIds.map((id) => byId.get(id));
    if (selected.some((installation) => !installation)) {
      throw deploymentError("Every staged installation must belong to this agent and organization", 409, "STAGED_INSTALLATION_NOT_ELIGIBLE");
    }
    return selected as DeploymentInstallation[];
  }
  const percentage = input.percentage!;
  const selected = candidates.filter((candidate) => {
    const bucket = Number.parseInt(createHash("sha256").update(candidate.id).digest("hex").slice(0, 8), 16) % 100;
    return bucket < percentage;
  });
  if (selected.length === 0 && candidates.length > 0) return [candidates[0]!];
  return selected;
}

function deploymentError(message: string, statusCode: number, code: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}
