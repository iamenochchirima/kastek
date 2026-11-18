import type { Pool, PoolClient } from "pg";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { PlatformError } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";

/** Resolve custody of an explicitly shared connection; the executing principal remains the application. */
export async function applicationConnectionCustodian(db: Pool | PoolClient, execution: Execution, binding: CapabilityBinding): Promise<string> {
  if (execution.task.principal.kind !== "application" || !binding.connection || binding.policy.effect !== "read")
    throw new PlatformError("CONNECTED_SCOPE_DENIED", 403, "Connected resource is outside the task's authorized scope");
  const row = (await db.query(`SELECT c.account_id FROM agents_platform.connections c
    JOIN agents_platform.capability_bindings b ON b.connection_id=c.id AND b.organization_id=c.organization_id AND b.account_id=c.account_id
    JOIN agents_platform.memberships m ON m.organization_id=c.organization_id AND m.account_id=c.account_id AND m.revoked_at IS NULL
    LEFT JOIN agents_platform.native_provider_connections p ON p.connection_id=c.id
    WHERE c.id=$1 AND c.organization_id=$2 AND b.id=$3 AND b.digest=$4 AND c.policy_revision=$5
      AND c.application_shared_policy_revision=c.policy_revision AND c.state='active' AND c.expires_at>now()
      AND (p.connection_id IS NULL OR p.sharing='organization_service') FOR SHARE OF c,b,m`,
  [binding.connection.id, execution.task.organization_id, binding.id, binding.digest, binding.connection.policyRevision])).rows[0];
  if (!row) throw new PlatformError("CONNECTED_SCOPE_DENIED", 403, "Connected resource is outside the task's authorized scope");
  return row.account_id;
}
