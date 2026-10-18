import { createHash } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import {
executionGrantSchema,
PlatformError,
type AdmissionAuthority,
type ExecutionGrant
} from "../../contracts/contracts";

import { transaction } from "../../infrastructure/database";
import { assertAutomationAdmission } from "../lifecycle/automation-authority";

import type { Account,VersionRecord,WebsiteDeployment } from "../../contracts/records";

type Db=Pool|PoolClient;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function denied(): never { throw new PlatformError("ACCESS_DENIED", 403, "Access denied"); }
function absent(): never { throw new PlatformError("NOT_FOUND", 404, "Record not found"); }
function text(value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new PlatformError("INVALID_INPUT", 400, "Invalid input");
  return normalized;
}
function tokenHash(token: string): string | null { return /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token) : null; }
function grantFromRow(row: Record<string, unknown>): ExecutionGrant {
  return executionGrantSchema.parse({ id: row.id, product: row.product, organizationId: row.organization_id,
    resourceId: row.resource_id, callerClientId: row.caller_client_id, principal: row.principal, versionId: row.version_id,
    operations: row.operations, sourceRevisionIds: row.source_revision_ids, connectedToolBindingIds: row.connected_tool_binding_ids, maxInputBytes: row.max_input_bytes,
    maxOutputTokens: row.max_output_tokens, maxContextTokens: row.max_context_tokens, rootTokenLimit: row.root_token_limit, expiresAt: (row.expires_at as Date).toISOString(),
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null });
}


export class AuthorityStore {
  constructor(readonly pool:Pool) {}
  protected transaction<T>(work: (db:PoolClient)=>Promise<T>):Promise<T> { return transaction(this.pool,work); }
  protected async membership(db: Db, accountId: string, org: string): Promise<void> {
    const row = await db.query(`SELECT account_id FROM agents_platform.memberships
      WHERE account_id=$1 AND organization_id=$2 AND revoked_at IS NULL FOR SHARE`, [accountId, org]);
    if (!row.rows[0]) denied();
  }
  protected async version(db: Db, organizationId: string, versionId: string): Promise<VersionRecord> {
    return (await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND id=$2 FOR SHARE", [organizationId, versionId])).rows[0] ?? absent();
  }
  protected async insertGrant(db: Db, grant: ExecutionGrant): Promise<ExecutionGrant> {
    await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,
      version_id,operations,max_input_bytes,max_output_tokens,expires_at,revoked_at,max_context_tokens,root_token_limit,source_revision_ids,connected_tool_binding_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [grant.id, grant.product, grant.organizationId, grant.resourceId,
      grant.callerClientId, grant.principal, grant.versionId, JSON.stringify(grant.operations),
      grant.maxInputBytes, grant.maxOutputTokens, grant.expiresAt, grant.revokedAt, grant.maxContextTokens, grant.rootTokenLimit, grant.sourceRevisionIds, grant.connectedToolBindingIds]);
    return grant;
  }
  protected async assertPrincipal(db: Db, authority: AdmissionAuthority, version: VersionRecord): Promise<void> {
    if (authority.product !== "agents") denied();
    if (authority.principal.kind === "human") {
      if (authority.callerClientId !== "agents-execution" || authority.resourceId !== version.agent_id) denied();
      const account = (await db.query<Account>("SELECT * FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [authority.principal.issuer, authority.principal.subject])).rows[0];
      if (!account) denied();
      await this.membership(db, account.id, authority.organizationId);
    } else if (authority.principal.kind === "visitor") {
      if (authority.callerClientId !== "agents-website" || authority.resourceId !== authority.principal.deploymentId) denied();
      const deployment = (await db.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL FOR SHARE", [authority.organizationId, authority.principal.deploymentId])).rows[0];
      if (!deployment || deployment.version_id !== version.id || deployment.agent_id !== version.agent_id) denied();
    } else if(authority.principal.kind==="automation") await assertAutomationAdmission(db,authority,version);
    else denied();
  }
}
