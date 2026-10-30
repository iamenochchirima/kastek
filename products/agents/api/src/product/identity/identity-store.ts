import { createHash,randomBytes,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import {
executionGrantSchema,
PlatformError,
type ExecutionGrant
} from "../../contracts/contracts";


import type { Account,Organization,Session } from "../../contracts/records";
import { AuthorityStore } from "../../execution/admission/authority-store";
import { ensureOrganizationAssistantInTransaction } from "../agents/organization-assistant";

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


export class IdentityStore extends AuthorityStore {
  async requireMembership(accountId: string, organizationId: string): Promise<void> {
    await this.membership(this.pool, accountId, organizationId);
  }
  async ensureAccount(input: { issuer: string; subject: string; email: string; displayName: string }): Promise<Account> {
    return (await this.pool.query<Account>(`INSERT INTO agents_platform.accounts(id,issuer,subject,email,display_name)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,subject) DO UPDATE SET email=excluded.email,display_name=excluded.display_name
      RETURNING id,issuer,subject,email,display_name`,
    [randomUUID(), text(input.issuer, 2048), text(input.subject, 512), text(input.email, 320), text(input.displayName, 256)])).rows[0]!;
  }
  async createOrganization(accountId: string, name: string): Promise<Organization> {
    return this.transaction(async (db) => {
      if (!(await db.query("SELECT id FROM agents_platform.accounts WHERE id=$1 FOR SHARE", [accountId])).rows[0]) denied();
      const row = (await db.query<{ id: string; name: string }>("INSERT INTO agents_platform.organizations(id,name) VALUES($1,$2) RETURNING id,name", [randomUUID(), text(name, 120)])).rows[0]!;
      await db.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'owner')", [row.id, accountId]);
      await ensureOrganizationAssistantInTransaction(db, { accountId, organizationId: row.id });
      return { ...row, role: "owner" };
    });
  }
  async listOrganizations(accountId: string): Promise<Organization[]> {
    return (await this.pool.query<Organization>(`SELECT o.id,o.name,m.role FROM agents_platform.organizations o
      JOIN agents_platform.memberships m ON m.organization_id=o.id WHERE m.account_id=$1 AND m.revoked_at IS NULL ORDER BY o.created_at,o.id`, [accountId])).rows;
  }
  async ensureInitialWorkspace(accountId: string): Promise<void> {
    await this.transaction(async db => {
      if (!(await db.query("SELECT id FROM agents_platform.accounts WHERE id=$1 FOR UPDATE", [accountId])).rowCount) denied();
      // Historical membership prevents provisioning from bypassing revoked access.
      if ((await db.query("SELECT 1 FROM agents_platform.memberships WHERE account_id=$1 LIMIT 1", [accountId])).rowCount) return;
      const organizationId = randomUUID();
      await db.query("INSERT INTO agents_platform.organizations(id,name) VALUES($1,$2)", [organizationId, "My workspace"]);
      await db.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'owner')", [organizationId, accountId]);
      await ensureOrganizationAssistantInTransaction(db, { accountId, organizationId });
    });
  }
  async createSession(input: { accountId: string; providerSessionId: string; expiresAt: Date }): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Math.min(input.expiresAt.getTime(), Date.now() + 30 * 86_400_000));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new PlatformError("SESSION_EXPIRED", 401, "Fresh authentication required");
    const token = randomBytes(32).toString("base64url");
    await this.pool.query("INSERT INTO agents_platform.sessions(token_hash,account_id,provider_session_id,expires_at) VALUES($1,$2,$3,$4)", [hash(token), input.accountId, text(input.providerSessionId, 512), expiresAt]);
    return { token, expiresAt };
  }
  async getSession(token: string): Promise<Session | null> {
    const digest = tokenHash(token); if (!digest) return null;
    const row = (await this.pool.query<Account & { provider_session_id: string; expires_at: Date }>(`WITH touched AS (
      UPDATE agents_platform.sessions SET last_seen_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()
      AND last_seen_at>now()-interval '7 days' RETURNING account_id,provider_session_id,expires_at)
      SELECT a.id,a.issuer,a.subject,a.email,a.display_name,t.provider_session_id,t.expires_at
      FROM touched t JOIN agents_platform.accounts a ON a.id=t.account_id`, [digest])).rows[0];
    if (!row) return null;
    const { provider_session_id, expires_at, ...account } = row;
    return { account, providerSessionId: provider_session_id, expiresAt: expires_at };
  }
  async revokeSession(token: string): Promise<void> {
    const digest = tokenHash(token);
    if (digest) await this.pool.query("UPDATE agents_platform.sessions SET revoked_at=now() WHERE token_hash=$1", [digest]);
  }
  async revokeProviderSession(issuer: string, providerSessionId: string): Promise<void> {
    await this.pool.query(`UPDATE agents_platform.sessions s SET revoked_at=now() FROM agents_platform.accounts a
      WHERE a.id=s.account_id AND a.issuer=$1 AND s.provider_session_id=$2`, [issuer, providerSessionId]);
  }
}
