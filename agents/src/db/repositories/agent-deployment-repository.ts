import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  DeployInstallationInput,
  InstallationDeploymentPreflightInput,
  InstallationPromotionInput,
  InstallationRollbackInput,
} from "../../domain/types";
import {
  buildInstallationDeploymentEvent,
  enqueueOutbox,
} from "../../analytics";
import { operationalLogger } from "../../telemetry/logger";

export type DeploymentTrigger = "version_published" | "version_rolled_back" | "manual";
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
  release_mode: "pinned";
}

export type DeploymentPreflightBlockerCode =
  | "installation_not_live"
  | "installation_inactive"
  | "installation_deployment_not_allowed"
  | "version_not_found"
  | "version_not_published"
  | "installation_agent_mismatch"
  | "expected_version_mismatch"
  | "source_installation_not_found"
  | "source_installation_not_playground"
  | "source_candidate_mismatch"
  | "binding_not_ready";

export interface DeploymentVersionProjection {
  versionId: string;
  versionNumber: number;
  status: string;
  digest: string;
  extensionSnapshotId: string | null;
  extensionSnapshotChecksum: string | null;
}

export interface DeploymentPreflightResult {
  installationId: string;
  agentId: string;
  environment: "live";
  ready: boolean;
  status: "ready" | "blocked";
  candidate: DeploymentVersionProjection | null;
  current: DeploymentVersionProjection | null;
  sourceInstallationId: string | null;
  capabilityConfigurationDigest: string | null;
  bindingRevision: string | null;
  blockers: Array<{ code: DeploymentPreflightBlockerCode; detail: string }>;
}

export interface DeploymentActivationResult {
  status: "activated" | "already_active";
  promotionId: string;
  installation: DeploymentInstallation;
  manifest: {
    sourceInstallationId: string | null;
    targetInstallationId: string;
    candidateVersionId: string;
    candidateDigest: string;
    capabilityConfigurationDigest: string | null;
    extensionSnapshotChecksum: string | null;
    bindingRevision: string | null;
    expectedVersionId: string;
    previousVersionId: string | null;
    idempotencyKey: string;
  };
}

interface DeploymentInput {
  organizationId: string;
  actorId: string;
  installationId: string;
  versionId: string;
  previousVersionId: string;
  agentDefinitionId: string;
  trigger: DeploymentTrigger;
  action?: DeploymentAction;
  actorType?: "human" | "system";
  sourceInstallationId?: string;
  idempotencyKey?: string;
  candidateDigest?: string;
  capabilityConfigurationDigest?: string | null;
  extensionSnapshotChecksum?: string | null;
  bindingRevision?: string | null;
  previousCapabilityConfigurationSnapshot?: CapabilityConfigurationSnapshot | null;
  promotionId?: string;
}

/**
 * Installation-scoped capability state captured with deployment evidence.
 *
 * This intentionally contains only opaque credential references and
 * configuration metadata. Encrypted credential payloads never cross the
 * Playground/Live boundary and are never written into deployment history.
 */
interface CapabilityConfigurationSnapshot {
  connections: Array<{
    integrationId: string;
    credentialId: string | null;
    status: string;
    configuration: Record<string, unknown>;
    healthMessage: string | null;
    lastCheckedAt: string | null;
    createdBy: string;
  }>;
  resourceGrants: Array<{ resourceType: string; resourceId: string; grantedBy: string }>;
  connectorGrants: Array<{ connectorId: string; grantedBy: string }>;
  toolGrants: Array<{ agentVersionId: string; toolName: string; grantedBy: string }>;
}

interface DeploymentVersionRow {
  version_id: string;
  version_number: number;
  status: string;
  checksum: string;
  extension_snapshot_id: string | null;
  extension_snapshot_checksum: string | null;
  deployment_id?: string;
  deployment_action?: DeploymentAction;
  deployment_previous_version_id?: string | null;
  deployment_idempotency_key?: string | null;
  deployment_candidate_digest?: string | null;
  deployment_capability_configuration_digest?: string | null;
  deployment_previous_capability_configuration_snapshot?: unknown;
  deployment_extension_snapshot_checksum?: string | null;
  deployment_binding_revision?: string | null;
}

interface DeploymentRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  previous_agent_version_id: string | null;
  agent_version_id: string | null;
  source_installation_id: string | null;
  idempotency_key: string | null;
  candidate_digest: string | null;
  capability_configuration_digest: string | null;
  previous_capability_configuration_snapshot?: unknown;
  extension_snapshot_checksum: string | null;
  binding_revision: string | null;
}

/**
 * Transaction-bound deployment module. The AgentRepository owns agent
 * lifecycle queries; this module owns version movement, eligibility, history,
 * audit records, and analytics for an installation.
 */
export class AgentDeploymentModule {
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
    if (!["kasitek_hosted", "system_hosted"].includes(current.execution_mode)) {
      throw deploymentError("External-connected installations are not managed by hosted deployment", 403, "INSTALLATION_DEPLOYMENT_NOT_ALLOWED");
    }
    // Manual deployment may select a published or retired immutable version.
    await this.assertDeployableHostedVersion(client, organizationId, current.agent_definition_id, input.versionId);
    if (current.agent_version_id === input.versionId) return current;
    return this.applyDeployment(client, {
      organizationId,
      actorId,
      installationId,
      versionId: input.versionId,
      previousVersionId: current.agent_version_id,
      agentDefinitionId: current.agent_definition_id,
      trigger: "manual",
    });
  }

  private async getCapabilityConfigurationDigest(
    client: PoolClient,
    organizationId: string,
    installationId: string,
    versionId: string,
  ): Promise<string> {
    const result = await client.query<{ digest: string }>(
      `SELECT md5(COALESCE(string_agg(entry, '|' ORDER BY entry), '')) AS digest
       FROM (
         SELECT concat('connection:', integration_id, ':', COALESCE(credential_id::text, ''), ':', status, ':', configuration::text) AS entry
         FROM integration_connections
         WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
         UNION ALL
         SELECT concat('resource:', resource_type, ':', resource_id) AS entry
         FROM agent_installation_resource_grants
         WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
         UNION ALL
         SELECT concat('connector:', connector_id) AS entry
         FROM agent_installation_connector_grants
         WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
         UNION ALL
         SELECT concat('tool:', tool_name) AS entry
         FROM agent_tool_grants
         WHERE organization_id = $1 AND installation_id = $2
           AND agent_version_id = $3 AND revoked_at IS NULL
       ) capability_entries`,
      [organizationId, installationId, versionId],
    );
    return result.rows[0]?.digest ?? "d41d8cd98f00b204e9800998ecf8427e";
  }

  private async captureCapabilityConfiguration(
    client: PoolClient,
    organizationId: string,
    installationId: string,
  ): Promise<CapabilityConfigurationSnapshot> {
    const connections = await client.query<{
      integration_id: string;
      credential_id: string | null;
      status: string;
      configuration: unknown;
      health_message: string | null;
      last_checked_at: string | Date | null;
      created_by: string;
    }>(
      `SELECT integration_id, credential_id, status, configuration,
              health_message, last_checked_at, created_by
       FROM integration_connections
       WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
       ORDER BY integration_id`,
      [organizationId, installationId],
    );
    const resourceGrants = await client.query<{
      resource_type: string;
      resource_id: string;
      granted_by: string;
    }>(
      `SELECT resource_type, resource_id, granted_by
       FROM agent_installation_resource_grants
       WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
       ORDER BY resource_type, resource_id`,
      [organizationId, installationId],
    );
    const connectorGrants = await client.query<{
      connector_id: string;
      granted_by: string;
    }>(
      `SELECT connector_id, granted_by
       FROM agent_installation_connector_grants
       WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
       ORDER BY connector_id`,
      [organizationId, installationId],
    );
    const toolGrants = await client.query<{
      agent_version_id: string;
      tool_name: string;
      granted_by: string;
    }>(
      `SELECT agent_version_id, tool_name, granted_by
       FROM agent_tool_grants
       WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
       ORDER BY agent_version_id, tool_name`,
      [organizationId, installationId],
    );
    return {
      connections: connections.rows.map((connection) => ({
        integrationId: connection.integration_id,
        credentialId: connection.credential_id,
        status: connection.status,
        configuration: asRecord(connection.configuration),
        healthMessage: connection.health_message,
        lastCheckedAt: connection.last_checked_at instanceof Date
          ? connection.last_checked_at.toISOString()
          : connection.last_checked_at,
        createdBy: connection.created_by,
      })),
      resourceGrants: resourceGrants.rows.map((grant) => ({
        resourceType: grant.resource_type,
        resourceId: grant.resource_id,
        grantedBy: grant.granted_by,
      })),
      connectorGrants: connectorGrants.rows.map((grant) => ({
        connectorId: grant.connector_id,
        grantedBy: grant.granted_by,
      })),
      toolGrants: toolGrants.rows.map((grant) => ({
        agentVersionId: grant.agent_version_id,
        toolName: grant.tool_name,
        grantedBy: grant.granted_by,
      })),
    };
  }

  private async restoreCapabilityConfiguration(
    client: PoolClient,
    organizationId: string,
    installationId: string,
    snapshot: CapabilityConfigurationSnapshot,
  ): Promise<void> {
    await client.query(
      `UPDATE integration_connections
       SET status = 'revoked', revoked_at = now(), updated_at = now()
       WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL`,
      [organizationId, installationId],
    );
    for (const connection of snapshot.connections) {
      await client.query(
        `INSERT INTO integration_connections
           (organization_id, installation_id, integration_id, credential_id, status,
            configuration, health_message, last_checked_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
         ON CONFLICT (installation_id, integration_id) DO UPDATE SET
           credential_id = EXCLUDED.credential_id,
           status = EXCLUDED.status,
           configuration = EXCLUDED.configuration,
           health_message = EXCLUDED.health_message,
           last_checked_at = EXCLUDED.last_checked_at,
           created_by = EXCLUDED.created_by,
           updated_at = now(),
           revoked_at = NULL`,
        [
          organizationId,
          installationId,
          connection.integrationId,
          connection.credentialId,
          connection.status,
          JSON.stringify(connection.configuration),
          connection.healthMessage,
          connection.lastCheckedAt,
          connection.createdBy,
        ],
      );
    }

    await client.query(
      `UPDATE agent_installation_resource_grants
       SET revoked_at = now()
       WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL`,
      [organizationId, installationId],
    );
    for (const grant of snapshot.resourceGrants) {
      await client.query(
        `INSERT INTO agent_installation_resource_grants
           (organization_id, installation_id, resource_type, resource_id, granted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (installation_id, resource_type, resource_id) DO UPDATE SET
           granted_by = EXCLUDED.granted_by,
           revoked_at = NULL`,
        [organizationId, installationId, grant.resourceType, grant.resourceId, grant.grantedBy],
      );
    }

    await client.query(
      `UPDATE agent_installation_connector_grants
       SET revoked_at = now()
       WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL`,
      [organizationId, installationId],
    );
    for (const grant of snapshot.connectorGrants) {
      await client.query(
        `INSERT INTO agent_installation_connector_grants
           (organization_id, installation_id, connector_id, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (installation_id, connector_id) DO UPDATE SET
           granted_by = EXCLUDED.granted_by,
           revoked_at = NULL`,
        [organizationId, installationId, grant.connectorId, grant.grantedBy],
      );
    }

    await client.query(
      `UPDATE agent_tool_grants
       SET revoked_at = now()
       WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL`,
      [organizationId, installationId],
    );
    for (const grant of snapshot.toolGrants) {
      await client.query(
        `INSERT INTO agent_tool_grants
           (organization_id, agent_version_id, installation_id, tool_name, granted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
           WHERE revoked_at IS NULL
         DO UPDATE SET granted_by = EXCLUDED.granted_by`,
        [organizationId, grant.agentVersionId, installationId, grant.toolName, grant.grantedBy],
      );
    }
  }

  /**
   * Validate a Live target without changing a version pointer. This is the
   * shared read contract for Studio/Core preflight and promotion admission.
   */
  public async preflightInstallation(
    client: PoolClient,
    organizationId: string,
    installationId: string,
    input: InstallationDeploymentPreflightInput,
  ): Promise<DeploymentPreflightResult> {
    const installationResult = await client.query<DeploymentInstallation>(
      `SELECT * FROM agent_installations
       WHERE id = $1 AND organization_id = $2
       FOR SHARE`,
      [installationId, organizationId],
    );
    const installation = installationResult.rows[0];
    if (!installation) throw deploymentError("Installation not found", 404, "INSTALLATION_NOT_FOUND");

    const settings = installation.settings ?? {};
    const environment = settings.environment === "playground" ? "playground" : "live";
    const blockers: Array<{ code: DeploymentPreflightBlockerCode; detail: string }> = [];
    if (environment !== "live") blockers.push({ code: "installation_not_live", detail: "Promotion targets must be Live installations." });
    if (installation.status !== "active") blockers.push({ code: "installation_inactive", detail: `The Live installation is ${installation.status}.` });
    if (installation.execution_mode === "external_connected") blockers.push({ code: "installation_deployment_not_allowed", detail: "External-connected installations are not managed by hosted promotion." });
    const bindingStatus = typeof settings.bindingStatus === "string" ? settings.bindingStatus : undefined;
    const bindingRevision = typeof settings.bindingRevision === "string" ? settings.bindingRevision : undefined;
    if (!bindingRevision || (bindingStatus && !["ready", "healthy", "connected"].includes(bindingStatus))) {
      blockers.push({ code: "binding_not_ready", detail: "Required Live resource bindings are not ready for this candidate." });
    }
    if (input.expectedVersionId && installation.agent_version_id !== input.expectedVersionId) {
      blockers.push({ code: "expected_version_mismatch", detail: "The Live installation changed after the preflight was requested." });
    }

    const currentResult = await client.query<DeploymentVersionRow>(
      `SELECT version.id AS version_id, version.version_number, version.status,
              version.checksum, version.extension_snapshot_id,
              snapshot.checksum AS extension_snapshot_checksum
       FROM agent_versions version
       LEFT JOIN agent_extension_snapshots snapshot ON snapshot.id = version.extension_snapshot_id
       WHERE version.id = $1 AND version.agent_definition_id = $2`,
      [installation.agent_version_id, installation.agent_definition_id],
    );
    const current = currentResult.rows[0] ? projectDeploymentVersion(currentResult.rows[0]) : null;

    const candidateResult = await client.query<DeploymentVersionRow & { owner_type: string; protected: boolean }>(
      `SELECT version.id AS version_id, version.version_number, version.status,
              version.checksum, version.extension_snapshot_id,
              snapshot.checksum AS extension_snapshot_checksum,
              definition.owner_type, definition.protected
       FROM agent_versions version
       JOIN agent_definitions definition ON definition.id = version.agent_definition_id
       LEFT JOIN agent_extension_snapshots snapshot ON snapshot.id = version.extension_snapshot_id
       WHERE version.id = $3
         AND version.agent_definition_id = $4
         AND version.status IN ('published', 'retired')
         AND (
           definition.organization_id = $1
           OR (
             definition.owner_type = 'system' AND definition.protected = TRUE
             AND EXISTS (
               SELECT 1 FROM agent_installations visible
               WHERE visible.id = $2 AND visible.organization_id = $1
                 AND visible.agent_definition_id = definition.id
             )
           )
         )
       FOR SHARE OF version`,
      [organizationId, installationId, input.versionId, installation.agent_definition_id],
    );
    const candidate = candidateResult.rows[0] ? projectDeploymentVersion(candidateResult.rows[0]) : null;
    if (!candidate) {
      const versionExists = await client.query<{ id: string; agent_definition_id: string; status: string }>(
        "SELECT id, agent_definition_id, status FROM agent_versions WHERE id = $1",
        [input.versionId],
      );
      blockers.push(versionExists.rows[0]?.agent_definition_id !== installation.agent_definition_id
        ? { code: "installation_agent_mismatch", detail: "The candidate belongs to a different agent." }
        : versionExists.rows[0]?.status !== "published"
          ? { code: "version_not_published", detail: "Only published or retired immutable versions can be deployed." }
          : { code: "version_not_found", detail: "The candidate version is not available to this organization." });
    }

    let sourceInstallationId: string | null = input.sourceInstallationId ?? null;
    let capabilityConfigurationDigest: string | null = null;
    if (input.sourceInstallationId) {
      const sourceResult = await client.query<DeploymentInstallation>(
        `SELECT * FROM agent_installations
         WHERE id = $1 AND organization_id = $2
         FOR SHARE`,
        [input.sourceInstallationId, organizationId],
      );
      const source = sourceResult.rows[0];
      if (!source) {
        blockers.push({ code: "source_installation_not_found", detail: "The Playground source installation was not found." });
      } else {
        const sourceEnvironment = source.settings?.environment === "playground" ? "playground" : "live";
        if (sourceEnvironment !== "playground") blockers.push({ code: "source_installation_not_playground", detail: "Promotion evidence must come from a Playground installation." });
        if (source.agent_definition_id !== installation.agent_definition_id) blockers.push({ code: "installation_agent_mismatch", detail: "The Playground source belongs to a different agent." });
        if (source.agent_version_id !== input.versionId) blockers.push({ code: "source_candidate_mismatch", detail: "The Playground source is not pinned to the selected candidate." });
        if (sourceEnvironment === "playground" && source.agent_definition_id === installation.agent_definition_id && source.agent_version_id === input.versionId) {
          capabilityConfigurationDigest = await this.getCapabilityConfigurationDigest(client, organizationId, source.id, input.versionId);
        }
      }
    }

    return {
      installationId,
      agentId: installation.agent_definition_id,
      environment: "live",
      ready: blockers.length === 0,
      status: blockers.length ? "blocked" : "ready",
      candidate,
      current,
      sourceInstallationId,
      capabilityConfigurationDigest,
      bindingRevision: bindingRevision ?? null,
      blockers,
    };
  }

  /**
   * Atomically activate the exact candidate that was tested in Playground.
   * The target pointer and immutable deployment evidence are committed in one
   * transaction, and idempotency prevents a retried request from changing a
   * newer Live release.
   */
  public async promoteInstallation(
    client: PoolClient,
    organizationId: string,
    actorId: string,
    installationId: string,
    input: InstallationPromotionInput,
  ): Promise<DeploymentActivationResult> {
    const targetResult = await client.query<DeploymentInstallation>(
      `SELECT * FROM agent_installations
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [installationId, organizationId],
    );
    if (!targetResult.rows[0]) throw deploymentError("Installation not found", 404, "INSTALLATION_NOT_FOUND");
    const prior = await client.query<DeploymentRecord>(
      `SELECT * FROM agent_installation_deployments
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
       ORDER BY created_at DESC LIMIT 1`,
      [organizationId, installationId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].agent_version_id !== input.versionId || prior.rows[0].previous_agent_version_id !== input.expectedVersionId) {
        throw deploymentError("Promotion idempotency key was already used for another release", 409, "PROMOTION_IDEMPOTENCY_CONFLICT");
      }
      const current = await client.query<DeploymentInstallation>(
        "SELECT * FROM agent_installations WHERE id = $1 AND organization_id = $2",
        [installationId, organizationId],
      );
      if (!current.rows[0]) throw deploymentError("Installation not found", 404, "INSTALLATION_NOT_FOUND");
      if (current.rows[0].agent_version_id !== input.versionId) throw deploymentError("Live installation changed after promotion", 409, "INSTALLATION_VERSION_CONFLICT");
      return {
        status: "already_active",
        promotionId: prior.rows[0].id,
        installation: current.rows[0],
        manifest: {
          sourceInstallationId: prior.rows[0].source_installation_id ?? input.sourceInstallationId,
          targetInstallationId: installationId,
          candidateVersionId: input.versionId,
          candidateDigest: prior.rows[0].candidate_digest ?? "",
          capabilityConfigurationDigest: prior.rows[0].capability_configuration_digest ?? null,
          extensionSnapshotChecksum: prior.rows[0].extension_snapshot_checksum ?? null,
          bindingRevision: prior.rows[0].binding_revision ?? null,
          expectedVersionId: input.expectedVersionId,
          previousVersionId: prior.rows[0].previous_agent_version_id,
          idempotencyKey: input.idempotencyKey,
        },
      };
    }

    const preflight = await this.preflightInstallation(client, organizationId, installationId, input);
    if (!preflight.ready || !preflight.candidate) {
      throw Object.assign(
        deploymentError("Live promotion preflight is blocked", 409, "PROMOTION_PREFLIGHT_BLOCKED"),
        { preflight },
      );
    }

    // Playground is the source of truth for the candidate's configured
    // capabilities. Keep the existing opaque credential references and copy
    // only the installation-scoped connection/grant records in this
    // transaction; secret payloads, conversations, runs, and test data never
    // cross the promotion boundary.
    const previousCapabilityConfigurationSnapshot = await this.captureCapabilityConfiguration(
      client,
      organizationId,
      installationId,
    );
    await this.mirrorPlaygroundCapabilityConfiguration(client, {
      organizationId,
      sourceInstallationId: input.sourceInstallationId,
      targetInstallationId: installationId,
      candidateVersionId: input.versionId,
    });
    const promotedCapabilityConfigurationDigest = await this.getCapabilityConfigurationDigest(
      client,
      organizationId,
      installationId,
      input.versionId,
    );
    if (promotedCapabilityConfigurationDigest !== preflight.capabilityConfigurationDigest) {
      throw deploymentError(
        "Live capability configuration does not match the tested Playground snapshot",
        409,
        "PROMOTION_CAPABILITY_CONFIGURATION_MISMATCH",
      );
    }

    const installation = await this.applyDeployment(client, {
      organizationId,
      actorId,
      installationId,
      versionId: input.versionId,
      previousVersionId: preflight.current?.versionId ?? input.expectedVersionId,
      agentDefinitionId: preflight.agentId,
      trigger: "manual",
      action: "deployed",
      sourceInstallationId: input.sourceInstallationId,
      idempotencyKey: input.idempotencyKey,
      candidateDigest: preflight.candidate.digest,
      capabilityConfigurationDigest: promotedCapabilityConfigurationDigest,
      previousCapabilityConfigurationSnapshot,
      extensionSnapshotChecksum: preflight.candidate.extensionSnapshotChecksum,
      bindingRevision: preflight.bindingRevision,
      promotionId: randomUUID(),
    });
    const deployment = await client.query<DeploymentRecord>(
      `SELECT * FROM agent_installation_deployments
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
       ORDER BY created_at DESC LIMIT 1`,
      [organizationId, installationId, input.idempotencyKey],
    );
    const record = deployment.rows[0];
    const promotionId = record?.id ?? randomUUID();
    return {
      status: "activated",
      promotionId,
      installation,
      manifest: {
        sourceInstallationId: input.sourceInstallationId,
        targetInstallationId: installationId,
        candidateVersionId: input.versionId,
        candidateDigest: preflight.candidate.digest,
        capabilityConfigurationDigest: promotedCapabilityConfigurationDigest,
        extensionSnapshotChecksum: preflight.candidate.extensionSnapshotChecksum,
        bindingRevision: preflight.bindingRevision,
        expectedVersionId: input.expectedVersionId,
        previousVersionId: preflight.current?.versionId ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    };
  }

  private async mirrorPlaygroundCapabilityConfiguration(
    client: PoolClient,
    input: {
      organizationId: string;
      sourceInstallationId: string;
      targetInstallationId: string;
      candidateVersionId: string;
    },
  ): Promise<void> {
    // Connections reference organization-scoped encrypted credentials. The
    // reference is reused; the encrypted secret is never selected or copied.
    await client.query(
      `UPDATE integration_connections target_connection
       SET status = 'revoked', revoked_at = now(), updated_at = now()
       WHERE target_connection.organization_id = $1
         AND target_connection.installation_id = $2
         AND target_connection.revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM integration_connections source_connection
           WHERE source_connection.organization_id = $1
             AND source_connection.installation_id = $3
             AND source_connection.integration_id = target_connection.integration_id
             AND source_connection.revoked_at IS NULL
         )`,
      [input.organizationId, input.targetInstallationId, input.sourceInstallationId],
    );
    await client.query(
      `INSERT INTO integration_connections
         (organization_id, installation_id, integration_id, credential_id, status,
          configuration, health_message, last_checked_at, created_by)
       SELECT source_connection.organization_id, $2, source_connection.integration_id,
              source_connection.credential_id, source_connection.status,
              source_connection.configuration, source_connection.health_message,
              source_connection.last_checked_at, source_connection.created_by
       FROM integration_connections source_connection
       WHERE source_connection.organization_id = $1
         AND source_connection.installation_id = $3
         AND source_connection.revoked_at IS NULL
       ON CONFLICT (installation_id, integration_id) DO UPDATE SET
         credential_id = EXCLUDED.credential_id,
         status = EXCLUDED.status,
         configuration = EXCLUDED.configuration,
         health_message = EXCLUDED.health_message,
         last_checked_at = EXCLUDED.last_checked_at,
         updated_at = now(),
         revoked_at = NULL`,
      [input.organizationId, input.targetInstallationId, input.sourceInstallationId],
    );

    // Resource and connector grants are installation-scoped. Mirror the
    // active Playground set exactly so removed Playground grants do not remain
    // callable in Live after promotion.
    await client.query(
      `UPDATE agent_installation_resource_grants target_grant
       SET revoked_at = now()
       WHERE target_grant.organization_id = $1
         AND target_grant.installation_id = $2
         AND target_grant.revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_installation_resource_grants source_grant
           WHERE source_grant.organization_id = $1
             AND source_grant.installation_id = $3
             AND source_grant.resource_type = target_grant.resource_type
             AND source_grant.resource_id = target_grant.resource_id
             AND source_grant.revoked_at IS NULL
         )`,
      [input.organizationId, input.targetInstallationId, input.sourceInstallationId],
    );
    await client.query(
      `INSERT INTO agent_installation_resource_grants
         (organization_id, installation_id, resource_type, resource_id, granted_by)
       SELECT source_grant.organization_id, $2, source_grant.resource_type,
              source_grant.resource_id, source_grant.granted_by
       FROM agent_installation_resource_grants source_grant
       WHERE source_grant.organization_id = $1
         AND source_grant.installation_id = $3
         AND source_grant.revoked_at IS NULL
       ON CONFLICT (installation_id, resource_type, resource_id) DO UPDATE SET
         granted_by = EXCLUDED.granted_by,
         revoked_at = NULL`,
      [input.organizationId, input.targetInstallationId, input.sourceInstallationId],
    );
    await client.query(
      `UPDATE agent_installation_connector_grants target_grant
       SET revoked_at = now()
       WHERE target_grant.organization_id = $1
         AND target_grant.installation_id = $2
         AND target_grant.revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_installation_connector_grants source_grant
           WHERE source_grant.organization_id = $1
             AND source_grant.installation_id = $3
             AND source_grant.connector_id = target_grant.connector_id
             AND source_grant.revoked_at IS NULL
         )`,
      [input.organizationId, input.targetInstallationId, input.sourceInstallationId],
    );
    await client.query(
      `INSERT INTO agent_installation_connector_grants
         (organization_id, installation_id, connector_id, granted_by)
       SELECT source_grant.organization_id, $2, source_grant.connector_id,
              source_grant.granted_by
       FROM agent_installation_connector_grants source_grant
       WHERE source_grant.organization_id = $1
         AND source_grant.installation_id = $3
         AND source_grant.revoked_at IS NULL
       ON CONFLICT (installation_id, connector_id) DO UPDATE SET
         granted_by = EXCLUDED.granted_by,
         revoked_at = NULL`,
      [input.organizationId, input.targetInstallationId, input.sourceInstallationId],
    );

    // Version-level grants travel with the immutable candidate. Only
    // installation-specific grants need to be mirrored here.
    await client.query(
      `UPDATE agent_tool_grants target_grant
       SET revoked_at = now()
       WHERE target_grant.organization_id = $1
         AND target_grant.installation_id = $2
         AND target_grant.agent_version_id = $3
         AND target_grant.revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM agent_tool_grants source_grant
           WHERE source_grant.organization_id = $1
             AND source_grant.installation_id = $4
             AND source_grant.agent_version_id = $3
             AND source_grant.tool_name = target_grant.tool_name
             AND source_grant.revoked_at IS NULL
         )`,
      [input.organizationId, input.targetInstallationId, input.candidateVersionId, input.sourceInstallationId],
    );
    await client.query(
      `INSERT INTO agent_tool_grants
         (organization_id, agent_version_id, installation_id, tool_name, granted_by)
       SELECT source_grant.organization_id, source_grant.agent_version_id, $2,
              source_grant.tool_name, source_grant.granted_by
       FROM agent_tool_grants source_grant
       WHERE source_grant.organization_id = $1
         AND source_grant.installation_id = $3
         AND source_grant.agent_version_id = $4
         AND source_grant.revoked_at IS NULL
       ON CONFLICT (agent_version_id, COALESCE(installation_id, '00000000-0000-0000-0000-000000000000'::uuid), tool_name)
         WHERE revoked_at IS NULL
       DO UPDATE SET granted_by = EXCLUDED.granted_by`,
      [input.organizationId, input.targetInstallationId, input.sourceInstallationId, input.candidateVersionId],
    );
  }

  /**
   * Restore the previous successful target pointer without changing
   * publication state or touching Playground installations.
   */
  public async rollbackInstallation(
    client: PoolClient,
    organizationId: string,
    actorId: string,
    installationId: string,
    input: InstallationRollbackInput,
  ): Promise<DeploymentActivationResult> {
    const currentResult = await client.query<DeploymentInstallation>(
      `SELECT * FROM agent_installations
       WHERE id = $1 AND organization_id = $2
       FOR UPDATE`,
      [installationId, organizationId],
    );
    const current = currentResult.rows[0];
    if (!current) throw deploymentError("Installation not found", 404, "INSTALLATION_NOT_FOUND");
    if (current.settings?.environment === "playground") throw deploymentError("Playground installations cannot be rolled back from Live", 409, "INSTALLATION_NOT_LIVE");
    if (input.expectedVersionId && current.agent_version_id !== input.expectedVersionId) throw deploymentError("Live installation changed before rollback", 409, "INSTALLATION_VERSION_CONFLICT");

    const targetResult = input.targetVersionId
      ? await client.query<DeploymentVersionRow>(
        `SELECT version.id AS version_id, version.version_number, version.status,
                version.checksum, version.extension_snapshot_id,
                snapshot.checksum AS extension_snapshot_checksum
         FROM agent_versions version
         LEFT JOIN agent_extension_snapshots snapshot ON snapshot.id = version.extension_snapshot_id
         WHERE version.id = $1 AND version.agent_definition_id = $2
           AND version.status IN ('published', 'retired')`,
        [input.targetVersionId, current.agent_definition_id],
      )
      : await client.query<DeploymentVersionRow>(
        `SELECT version.id AS version_id, version.version_number, version.status,
                version.checksum, version.extension_snapshot_id,
                snapshot.checksum AS extension_snapshot_checksum,
                deployment.id AS deployment_id,
                deployment.action AS deployment_action,
                deployment.previous_agent_version_id AS deployment_previous_version_id,
                deployment.idempotency_key AS deployment_idempotency_key,
                deployment.candidate_digest AS deployment_candidate_digest,
                deployment.capability_configuration_digest AS deployment_capability_configuration_digest,
                deployment.previous_capability_configuration_snapshot AS deployment_previous_capability_configuration_snapshot,
                deployment.extension_snapshot_checksum AS deployment_extension_snapshot_checksum,
                deployment.binding_revision AS deployment_binding_revision
         FROM agent_installation_deployments deployment
         JOIN agent_versions version ON version.id = deployment.previous_agent_version_id
         LEFT JOIN agent_extension_snapshots snapshot ON snapshot.id = version.extension_snapshot_id
         WHERE deployment.organization_id = $1 AND deployment.installation_id = $2
           AND deployment.agent_version_id = $3 AND deployment.outcome = 'success'
           AND deployment.previous_agent_version_id IS NOT NULL
         ORDER BY deployment.created_at DESC LIMIT 1`,
        [organizationId, installationId, current.agent_version_id],
      );
    const target = targetResult.rows[0];
    if (!target) throw deploymentError("No tested rollback target is available", 409, "ROLLBACK_TARGET_UNAVAILABLE");
    if (!input.idempotencyKey && !input.targetVersionId && target.deployment_action === "rolled_back" && target.deployment_idempotency_key) {
      return {
        status: "already_active",
        promotionId: target.deployment_id ?? randomUUID(),
        installation: current,
        manifest: {
          sourceInstallationId: null,
          targetInstallationId: installationId,
          candidateVersionId: current.agent_version_id,
          candidateDigest: target.deployment_candidate_digest ?? "",
          capabilityConfigurationDigest: target.deployment_capability_configuration_digest ?? null,
          extensionSnapshotChecksum: target.deployment_extension_snapshot_checksum ?? null,
          bindingRevision: target.deployment_binding_revision ?? null,
          expectedVersionId: input.expectedVersionId ?? target.deployment_previous_version_id ?? current.agent_version_id,
          previousVersionId: target.deployment_previous_version_id ?? null,
          idempotencyKey: target.deployment_idempotency_key,
        },
      };
    }
    const rollbackIdempotencyKey = input.idempotencyKey
      ?? `rollback:${installationId}:${current.agent_version_id}:${target.version_id}`;
    const prior = await client.query<DeploymentRecord>(
      `SELECT * FROM agent_installation_deployments
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
       ORDER BY created_at DESC LIMIT 1`,
      [organizationId, installationId, rollbackIdempotencyKey],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].agent_version_id !== target.version_id || current.agent_version_id !== target.version_id) {
        throw deploymentError("Rollback idempotency key was already used for another release", 409, "ROLLBACK_IDEMPOTENCY_CONFLICT");
      }
      return {
        status: "already_active",
        promotionId: prior.rows[0].id,
        installation: current,
        manifest: {
          sourceInstallationId: prior.rows[0].source_installation_id,
          targetInstallationId: installationId,
          candidateVersionId: target.version_id,
          candidateDigest: prior.rows[0].candidate_digest ?? target.checksum,
          capabilityConfigurationDigest: prior.rows[0].capability_configuration_digest ?? null,
          extensionSnapshotChecksum: prior.rows[0].extension_snapshot_checksum ?? target.extension_snapshot_checksum ?? null,
          bindingRevision: prior.rows[0].binding_revision ?? (typeof current.settings?.bindingRevision === "string" ? current.settings.bindingRevision : null),
          expectedVersionId: input.expectedVersionId ?? current.agent_version_id,
          previousVersionId: prior.rows[0].previous_agent_version_id,
          idempotencyKey: rollbackIdempotencyKey,
        },
      };
    }
    if (target.version_id === current.agent_version_id) {
      const capabilityConfigurationDigest = await this.getCapabilityConfigurationDigest(
        client,
        organizationId,
        installationId,
        target.version_id,
      );
      return {
        status: "already_active",
        promotionId: randomUUID(),
        installation: current,
        manifest: {
          sourceInstallationId: null,
          targetInstallationId: installationId,
          candidateVersionId: target.version_id,
          candidateDigest: target.checksum,
          capabilityConfigurationDigest,
          extensionSnapshotChecksum: target.extension_snapshot_checksum ?? null,
          bindingRevision: typeof current.settings?.bindingRevision === "string" ? current.settings.bindingRevision : null,
          expectedVersionId: input.expectedVersionId ?? current.agent_version_id,
          previousVersionId: current.agent_version_id,
          idempotencyKey: rollbackIdempotencyKey,
        },
      };
    }
    let previousCapabilityConfigurationSnapshot = normalizeCapabilityConfigurationSnapshot(
      target.deployment_previous_capability_configuration_snapshot,
    );
    if (!previousCapabilityConfigurationSnapshot) {
      const deploymentEvidence = await client.query<{ previous_capability_configuration_snapshot: unknown }>(
        `SELECT previous_capability_configuration_snapshot
         FROM agent_installation_deployments
         WHERE organization_id = $1 AND installation_id = $2
           AND agent_version_id = $3 AND previous_agent_version_id = $4
           AND outcome = 'success'
         ORDER BY created_at DESC LIMIT 1`,
        [organizationId, installationId, current.agent_version_id, target.version_id],
      );
      previousCapabilityConfigurationSnapshot = normalizeCapabilityConfigurationSnapshot(
        deploymentEvidence.rows[0]?.previous_capability_configuration_snapshot,
      );
    }
    if (!previousCapabilityConfigurationSnapshot) {
      throw deploymentError(
        "Rollback cannot restore the target capability configuration because this deployment has no capability snapshot",
        409,
        "ROLLBACK_CONFIGURATION_UNAVAILABLE",
      );
    }
    const currentCapabilityConfigurationSnapshot = await this.captureCapabilityConfiguration(
      client,
      organizationId,
      installationId,
    );
    await this.restoreCapabilityConfiguration(
      client,
      organizationId,
      installationId,
      previousCapabilityConfigurationSnapshot,
    );
    const restoredCapabilityConfigurationDigest = await this.getCapabilityConfigurationDigest(
      client,
      organizationId,
      installationId,
      target.version_id,
    );
    const installation = await this.applyDeployment(client, {
      organizationId,
      actorId,
      installationId,
      versionId: target.version_id,
      previousVersionId: current.agent_version_id,
      agentDefinitionId: current.agent_definition_id,
      trigger: "version_rolled_back",
      action: "rolled_back",
      idempotencyKey: rollbackIdempotencyKey,
      candidateDigest: target.checksum,
      capabilityConfigurationDigest: restoredCapabilityConfigurationDigest,
      previousCapabilityConfigurationSnapshot: currentCapabilityConfigurationSnapshot,
      extensionSnapshotChecksum: target.extension_snapshot_checksum,
      bindingRevision: typeof current.settings?.bindingRevision === "string" ? current.settings.bindingRevision : null,
      promotionId: randomUUID(),
    });
    const deployment = await client.query<DeploymentRecord>(
      `SELECT * FROM agent_installation_deployments
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
       ORDER BY created_at DESC LIMIT 1`,
      [organizationId, installationId, rollbackIdempotencyKey],
    );
    const promotionId = deployment.rows[0]?.id ?? randomUUID();
    return {
      status: "activated",
      promotionId,
      installation,
      manifest: {
        sourceInstallationId: null,
        targetInstallationId: installationId,
        candidateVersionId: target.version_id,
        candidateDigest: target.checksum,
        capabilityConfigurationDigest: restoredCapabilityConfigurationDigest,
        extensionSnapshotChecksum: target.extension_snapshot_checksum ?? null,
        bindingRevision: typeof current.settings?.bindingRevision === "string" ? current.settings.bindingRevision : null,
        expectedVersionId: input.expectedVersionId ?? current.agent_version_id,
        previousVersionId: current.agent_version_id,
        idempotencyKey: rollbackIdempotencyKey,
      },
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

  private async assertDeployableHostedVersion(
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
         AND ad.status = 'active'
         AND av.status IN ('published', 'retired')
         AND (
           (ad.organization_id = $3 AND ad.owner_type = 'organization' AND ad.protected = FALSE)
           OR (
             ad.owner_type = 'system' AND ad.protected = TRUE
             AND EXISTS (
               SELECT 1 FROM agent_installations visible
               WHERE visible.organization_id = $3
                 AND visible.agent_definition_id = ad.id
                 AND visible.execution_mode = 'system_hosted'
             )
           )
         )
       FOR SHARE OF av`,
      [versionId, agentId, organizationId],
    );
    if (!target.rows[0]) throw deploymentError("Deployable agent version not found", 404, "AGENT_VERSION_NOT_FOUND");
  }

  private async applyDeployment(client: PoolClient, input: DeploymentInput): Promise<DeploymentInstallation> {
    const previousCapabilityConfigurationSnapshot = input.previousCapabilityConfigurationSnapshot
      ?? await this.captureCapabilityConfiguration(client, input.organizationId, input.installationId);
    const updated = await client.query<DeploymentInstallation>(
      `UPDATE agent_installations
       SET agent_version_id = $2,
           release_mode = 'pinned',
           updated_at = now()
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
         agent_version_id, release_mode, action, trigger, outcome, actor_type, actor_id,
         source_installation_id, idempotency_key, candidate_digest,
         capability_configuration_digest, previous_capability_configuration_snapshot,
         extension_snapshot_checksum, binding_revision, promotion_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'success', $9, $10,
               $11, $12, $13, $14, $15::jsonb, $16, $17, $18)`,
      [
        input.organizationId,
        installation.id,
        input.agentDefinitionId,
        input.previousVersionId,
        input.versionId,
        "pinned",
        action,
        input.trigger,
        input.actorType ?? "human",
        input.actorId,
        input.sourceInstallationId ?? null,
        input.idempotencyKey ?? null,
        input.candidateDigest ?? null,
        input.capabilityConfigurationDigest ?? null,
        JSON.stringify(previousCapabilityConfigurationSnapshot),
        input.extensionSnapshotChecksum ?? null,
        input.bindingRevision ?? null,
        input.promotionId ?? null,
      ],
    );
    await client.query(
      `INSERT INTO audit_records
        (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, $3, 'agent_installation.version_deployed', 'agent_installation', $4, $5::jsonb)`,
      [input.organizationId, input.actorType ?? "human", input.actorId, installation.id, JSON.stringify({
        agentId: input.agentDefinitionId,
        previousVersionId: input.previousVersionId,
        versionId: input.versionId,
        releaseMode: "pinned",
        trigger: input.trigger,
      })],
    );
    await enqueueOutbox(client, buildInstallationDeploymentEvent({
      installationId: installation.id,
      organizationId: input.organizationId,
      agentDefinitionId: input.agentDefinitionId,
      agentVersionId: input.versionId,
      previousAgentVersionId: input.previousVersionId,
      releaseMode: "pinned",
      action,
      trigger: input.trigger,
      outcome: "success",
      actorType: input.actorType ?? "human",
      occurredAt: installation.updated_at,
    }));
    return installation;
  }
}

function deploymentError(message: string, statusCode: number, code: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

function projectDeploymentVersion(row: DeploymentVersionRow): DeploymentVersionProjection {
  return {
    versionId: row.version_id,
    versionNumber: Number(row.version_number),
    status: row.status,
    digest: row.checksum,
    extensionSnapshotId: row.extension_snapshot_id ?? null,
    extensionSnapshotChecksum: row.extension_snapshot_checksum ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeCapabilityConfigurationSnapshot(value: unknown): CapabilityConfigurationSnapshot | null {
  if (typeof value === "string") {
    try {
      return normalizeCapabilityConfigurationSnapshot(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.connections)
    || !Array.isArray(record.resourceGrants)
    || !Array.isArray(record.connectorGrants)
    || !Array.isArray(record.toolGrants)) return null;
  return {
    connections: record.connections.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.integrationId !== "string" || typeof row.status !== "string" || typeof row.createdBy !== "string") return [];
      return [{
        integrationId: row.integrationId,
        credentialId: typeof row.credentialId === "string" ? row.credentialId : null,
        status: row.status,
        configuration: asRecord(row.configuration),
        healthMessage: typeof row.healthMessage === "string" ? row.healthMessage : null,
        lastCheckedAt: typeof row.lastCheckedAt === "string" ? row.lastCheckedAt : null,
        createdBy: row.createdBy,
      }];
    }),
    resourceGrants: record.resourceGrants.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.resourceType !== "string" || typeof row.resourceId !== "string" || typeof row.grantedBy !== "string") return [];
      return [{ resourceType: row.resourceType, resourceId: row.resourceId, grantedBy: row.grantedBy }];
    }),
    connectorGrants: record.connectorGrants.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.connectorId !== "string" || typeof row.grantedBy !== "string") return [];
      return [{ connectorId: row.connectorId, grantedBy: row.grantedBy }];
    }),
    toolGrants: record.toolGrants.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const row = entry as Record<string, unknown>;
      if (typeof row.agentVersionId !== "string" || typeof row.toolName !== "string" || typeof row.grantedBy !== "string") return [];
      return [{ agentVersionId: row.agentVersionId, toolName: row.toolName, grantedBy: row.grantedBy }];
    }),
  };
}
