import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type {
  DeployInstallationInput,
  DeployStagedVersionInput,
  InstallationDeploymentPreflightInput,
  InstallationPromotionInput,
  InstallationRollbackInput,
} from "../../domain/types";
import {
  buildInstallationDeploymentEvent,
  enqueueOutbox,
} from "../../analytics";
import { operationalLogger } from "../../telemetry/logger";
import { recordAgentVersionDeployment } from "../../telemetry/spans";

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
  releaseMode: DeploymentInstallation["release_mode"];
  trigger: DeploymentTrigger;
  action?: DeploymentAction;
  actorType?: "human" | "system";
  sourceInstallationId?: string;
  idempotencyKey?: string;
  candidateDigest?: string;
  extensionSnapshotChecksum?: string | null;
  bindingRevision?: string | null;
  promotionId?: string;
  pinTarget?: boolean;
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
  extension_snapshot_checksum: string | null;
  binding_revision: string | null;
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
       FOR UPDATE`,
      [input.organizationId, input.agentId],
    );
    const mismatches = installations.rows.filter((installation) => installation.agent_version_id !== input.versionId);
    const matches = installations.rows.length - mismatches.length;
    recordAgentVersionDeployment({ outcome: "matched", releaseMode: "follow_published", count: matches });
    recordAgentVersionDeployment({ outcome: "mismatch", releaseMode: "follow_published", count: mismatches.length });
    if (!mismatches.length) return 0;

    const rolloutFlags = await client.query<{ scope_type: "global" | "organization" | "installation"; scope_id: string; enabled: boolean }>(
      `SELECT scope_type, scope_id, enabled
       FROM agent_operator_feature_flags
       WHERE flag_key = 'agent_version_deployment_enabled'
         AND expires_at > now()
         AND (
           scope_type = 'global'
           OR (scope_type = 'organization' AND scope_id = $1)
           OR (scope_type = 'installation' AND organization_id = $1 AND scope_id = ANY($2::text[]))
         )`,
      [input.organizationId, mismatches.map((installation) => installation.id)],
    );
    const enabledByScope = new Map(rolloutFlags.rows.map((flag) => [`${flag.scope_type}:${flag.scope_id}`, flag.enabled]));
    const organizationEnabled = enabledByScope.get(`organization:${input.organizationId}`)
      ?? enabledByScope.get("global:global")
      ?? true;
    let deployed = 0;
    for (const installation of mismatches) {
      const enabled = enabledByScope.get(`installation:${installation.id}`) ?? organizationEnabled;
      if (!enabled) {
        recordAgentVersionDeployment({ outcome: "blocked", releaseMode: "follow_published" });
        operationalLogger.warn({
          event: "agent.installation.deployment.blocked",
          organization_id: input.organizationId,
          installation_id: installation.id,
          agent_definition_id: input.agentId,
          target_agent_version_id: input.versionId,
          error_code: "AGENT_VERSION_DEPLOYMENT_FLAG_DISABLED",
        }, "Automatic agent version deployment is disabled");
        continue;
      }
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
      deployed += 1;
      recordAgentVersionDeployment({ outcome: "deployed", releaseMode: "follow_published" });
    }
    return deployed;
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
    if (!["kasitek_hosted", "system_hosted"].includes(current.execution_mode)) {
      throw deploymentError("External-connected installations are not managed by hosted deployment", 403, "INSTALLATION_DEPLOYMENT_NOT_ALLOWED");
    }
    // Manual deployment may intentionally select a retired immutable version
    // so the operator can reproduce or test an earlier candidate in
    // Playground. Automatic follow-published and staged rollouts remain
    // published-only through assertPublishedHostedVersion.
    await this.assertDeployableHostedVersion(client, organizationId, current.agent_definition_id, input.versionId);
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
    const installation = await this.applyDeployment(client, {
      organizationId,
      actorId,
      installationId,
      versionId: input.versionId,
      previousVersionId: preflight.current?.versionId ?? input.expectedVersionId,
      agentDefinitionId: preflight.agentId,
      releaseMode: "pinned",
      trigger: "manual",
      action: "deployed",
      pinTarget: true,
      sourceInstallationId: input.sourceInstallationId,
      idempotencyKey: input.idempotencyKey,
      candidateDigest: preflight.candidate.digest,
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
        extensionSnapshotChecksum: preflight.candidate.extensionSnapshotChecksum,
        bindingRevision: preflight.bindingRevision,
        expectedVersionId: input.expectedVersionId,
        previousVersionId: preflight.current?.versionId ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    };
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
          extensionSnapshotChecksum: prior.rows[0].extension_snapshot_checksum ?? target.extension_snapshot_checksum ?? null,
          bindingRevision: prior.rows[0].binding_revision ?? (typeof current.settings?.bindingRevision === "string" ? current.settings.bindingRevision : null),
          expectedVersionId: input.expectedVersionId ?? current.agent_version_id,
          previousVersionId: prior.rows[0].previous_agent_version_id,
          idempotencyKey: rollbackIdempotencyKey,
        },
      };
    }
    if (target.version_id === current.agent_version_id) return {
      status: "already_active",
      promotionId: randomUUID(),
      installation: current,
      manifest: {
        sourceInstallationId: null,
        targetInstallationId: installationId,
        candidateVersionId: target.version_id,
        candidateDigest: target.checksum,
        extensionSnapshotChecksum: target.extension_snapshot_checksum ?? null,
        bindingRevision: typeof current.settings?.bindingRevision === "string" ? current.settings.bindingRevision : null,
        expectedVersionId: input.expectedVersionId ?? current.agent_version_id,
        previousVersionId: current.agent_version_id,
        idempotencyKey: rollbackIdempotencyKey,
      },
    };
    const installation = await this.applyDeployment(client, {
      organizationId,
      actorId,
      installationId,
      versionId: target.version_id,
      previousVersionId: current.agent_version_id,
      agentDefinitionId: current.agent_definition_id,
      releaseMode: current.release_mode,
      trigger: "version_rolled_back",
      action: "rolled_back",
      idempotencyKey: rollbackIdempotencyKey,
      candidateDigest: target.checksum,
      extensionSnapshotChecksum: target.extension_snapshot_checksum,
      bindingRevision: typeof current.settings?.bindingRevision === "string" ? current.settings.bindingRevision : null,
      pinTarget: true,
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
        extensionSnapshotChecksum: target.extension_snapshot_checksum ?? null,
        bindingRevision: typeof current.settings?.bindingRevision === "string" ? current.settings.bindingRevision : null,
        expectedVersionId: input.expectedVersionId ?? current.agent_version_id,
        previousVersionId: current.agent_version_id,
        idempotencyKey: rollbackIdempotencyKey,
      },
    };
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
    const updated = await client.query<DeploymentInstallation>(
      `UPDATE agent_installations
       SET agent_version_id = $2,
           release_mode = CASE WHEN $6::boolean THEN 'pinned' ELSE release_mode END,
           updated_at = now()
       WHERE id = $1 AND organization_id = $3 AND agent_definition_id = $4 AND agent_version_id = $5
       RETURNING *`,
      [input.installationId, input.versionId, input.organizationId, input.agentDefinitionId, input.previousVersionId, input.pinTarget === true],
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
    const effectiveReleaseMode = input.pinTarget ? "pinned" : input.releaseMode;
    await client.query(
      `INSERT INTO agent_installation_deployments
        (organization_id, installation_id, agent_definition_id, previous_agent_version_id,
         agent_version_id, release_mode, action, trigger, outcome, actor_type, actor_id,
         source_installation_id, idempotency_key, candidate_digest,
         extension_snapshot_checksum, binding_revision, promotion_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'success', $9, $10,
               $11, $12, $13, $14, $15, $16)`,
      [
        input.organizationId,
        installation.id,
        input.agentDefinitionId,
        input.previousVersionId,
        input.versionId,
        effectiveReleaseMode,
        action,
        input.trigger,
        input.actorType ?? "human",
        input.actorId,
        input.sourceInstallationId ?? null,
        input.idempotencyKey ?? null,
        input.candidateDigest ?? null,
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
        releaseMode: effectiveReleaseMode,
        trigger: input.trigger,
      })],
    );
    await enqueueOutbox(client, buildInstallationDeploymentEvent({
      installationId: installation.id,
      organizationId: input.organizationId,
      agentDefinitionId: input.agentDefinitionId,
      agentVersionId: input.versionId,
      previousAgentVersionId: input.previousVersionId,
      releaseMode: effectiveReleaseMode,
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
