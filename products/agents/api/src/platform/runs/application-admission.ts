import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { assertRuntimeAvailable, connectedToolAuthorityIds, executionGrantSchema, PlatformError, requestDigest,
  sourceAuthorityIds, type AdmissionAuthority, type AgentConfiguration, type ExecutionGrant } from "../../contracts/contracts";
import type { AdmitTaskInput, TaskRecord, VersionRecord } from "../../contracts/records";
import { contextGrantCeiling } from "../../execution/models/settings";
import { assertApplicationAuthority } from "../../execution/admission/application-authority";
import { transaction } from "../../infrastructure/database";

type Port = {
  createApplicationGrantInTransaction(db: PoolClient, input: { grant: ExecutionGrant }): Promise<ExecutionGrant>;
  admitTaskInTransaction(db: PoolClient, input: AdmitTaskInput): Promise<{ task: TaskRecord; replayed: boolean }>;
};

export async function admitApplicationRun(options: { pool: Pool; store: Port;
  assertServices(configuration: AgentConfiguration): Promise<void>;
  grantOperations(configuration: AgentConfiguration): ExecutionGrant["operations"];
}, input: { organizationId: string; applicationId: string; credentialId: string; agentId: string;
  message: string; requestId: string; conversationId?: string }): Promise<{ task: TaskRecord; replayed: boolean }> {
  const authority: AdmissionAuthority = { product: "agents", organizationId: input.organizationId,
    resourceId: input.agentId, callerClientId: "agents-application",
    principal: { kind: "application", applicationId: input.applicationId, credentialId: input.credentialId } };
  const requestKey = `application:${input.applicationId}:${input.requestId}`;
  return transaction(options.pool, async db => {
    if (!(await db.query("SELECT 1 FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [input.organizationId])).rowCount)
      throw new PlatformError("ACCESS_DENIED", 403, "Application access is unavailable");
    await assertApplicationAuthority(db, authority, input.agentId);
    const existing = (await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE product='agents' AND organization_id=$1
      AND caller_client_id='agents-application' AND resource_id=$2 AND request_key=$3`, [input.organizationId, input.agentId, requestKey])).rows[0];
    if (existing) {
      const originalAuthority = { ...authority, principal: existing.principal };
      const digest = requestDigest({ authority: originalAuthority, versionId: existing.version_id, input: input.message,
        conversationId: input.conversationId ?? null, evaluationTrialId: null, channelBinding: null });
      if (existing.principal.kind !== "application" || existing.principal.applicationId !== input.applicationId || existing.request_digest !== digest)
        throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "The request key was used for different input");
      if ((await db.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1", [existing.conversation_id])).rows[0]?.deleted_at)
        throw new PlatformError("CONVERSATION_DELETED", 403, "Conversation is unavailable");
      return { task: existing, replayed: true };
    }
    const version = (await db.query<VersionRecord>(`SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a
      ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE v.organization_id=$1 AND v.agent_id=$2 AND a.deleted_at IS NULL
      ORDER BY v.number DESC LIMIT 1`, [input.organizationId, input.agentId])).rows[0];
    if (!version) throw new PlatformError("CONFIGURATION_UNAVAILABLE", 409, "Agent configuration is unavailable");
    assertRuntimeAvailable(version.configuration);
    await options.assertServices(version.configuration);
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: options.grantOperations(version.configuration), sourceRevisionIds: sourceAuthorityIds(version.configuration),
      connectedToolBindingIds: connectedToolAuthorityIds(version.configuration), maxInputBytes: version.configuration.model.maxInputBytes,
      maxOutputTokens: version.configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(version.configuration),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), revokedAt: null });
    await options.store.createApplicationGrantInTransaction(db, { grant });
    return options.store.admitTaskInTransaction(db, { authority, grantId: grant.id, versionId: version.id, input: input.message,
      requestKey, conversationId: input.conversationId, configurationMode: "current" });
  });
}
