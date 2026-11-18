import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  assertRuntimeAvailable, connectedToolAuthorityIds, executionGrantSchema, PlatformError, requestDigest,
  sourceAuthorityIds, type AdmissionAuthority, type AgentConfiguration, type ExecutionGrant,
} from "../../contracts/contracts";
import type { AdmitTaskInput, TaskRecord, VersionRecord } from "../../contracts/records";
import { contextGrantCeiling } from "../../execution/models/settings";
import { transaction } from "../../infrastructure/database";

type AdmissionPort = {
  createGrantInTransaction(db: PoolClient, input: { accountId: string; grant: ExecutionGrant }): Promise<ExecutionGrant>;
  admitTaskInTransaction(db: PoolClient, input: AdmitTaskInput): Promise<{ task: TaskRecord; replayed: boolean }>;
};

/** Admit a member run against the current agent version, atomically with its grant. */
export async function admitMemberRun(options: {
  pool: Pool;
  store: AdmissionPort;
  assertServices(configuration: AgentConfiguration): Promise<void>;
  grantOperations(configuration: AgentConfiguration): ExecutionGrant["operations"];
  onAdmitted?(db: PoolClient, result: { task: TaskRecord; replayed: boolean }): Promise<void>;
}, input: {
  accountId: string;
  authority: AdmissionAuthority;
  message: string;
  requestKey: string;
  conversationId?: string;
  evaluationRootTokenLimit?: number;
}): Promise<{ task: TaskRecord; replayed: boolean }> {
  const { authority } = input;
  const org = authority.organizationId;
  if (authority.product !== "agents" || authority.principal.kind !== "human") {
    throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
  }
  return transaction(options.pool, async db => {
    if (!(await db.query("SELECT 1 FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [org])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [org, input.accountId])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    const existing = (await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE product=$1 AND organization_id=$2
      AND caller_client_id=$3 AND resource_id=$4 AND request_key=$5`, [authority.product, org, authority.callerClientId, authority.resourceId, input.requestKey])).rows[0];
    if (existing) {
      const digest = requestDigest({ authority, versionId: existing.version_id, input: input.message, conversationId: input.conversationId ?? null, evaluationTrialId: null, channelBinding: null });
      if (existing.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "The request key was used for different input");
      if ((await db.query("SELECT deleted_at FROM agents_platform.conversations WHERE id=$1", [existing.conversation_id])).rows[0]?.deleted_at) throw new PlatformError("CONVERSATION_DELETED", 403, "Conversation is unavailable");
      const result = { task: existing, replayed: true };
      await options.onAdmitted?.(db, result);
      return result;
    }
    if (input.evaluationRootTokenLimit) throw new PlatformError("EVALUATION_SCOPE_REQUIRED", 403, "A trial is required for this allocation");
    const version = (await db.query<VersionRecord>(`SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a
      ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE v.organization_id=$1 AND v.agent_id=$2 ORDER BY v.number DESC LIMIT 1`, [org, authority.resourceId])).rows[0];
    if (!version) throw new PlatformError("CONFIGURATION_UNAVAILABLE", 409, "Save the agent settings before chatting");
    assertRuntimeAvailable(version.configuration);
    await options.assertServices(version.configuration);
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: options.grantOperations(version.configuration),
      sourceRevisionIds: sourceAuthorityIds(version.configuration), connectedToolBindingIds: connectedToolAuthorityIds(version.configuration),
      maxInputBytes: version.configuration.model.maxInputBytes, maxOutputTokens: version.configuration.model.maxOutputTokens,
      maxContextTokens: contextGrantCeiling(version.configuration), expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), revokedAt: null });
    await options.store.createGrantInTransaction(db, { accountId: input.accountId, grant });
    const result = await options.store.admitTaskInTransaction(db, { authority, grantId: grant.id, versionId: version.id, input: input.message,
      requestKey: input.requestKey, conversationId: input.conversationId, configurationMode: "current" });
    await options.onAdmitted?.(db, result);
    return result;
  });
}
