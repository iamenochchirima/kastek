import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";

export const applicationScopeSchema = z.enum(["agents:read", "runs:start", "runs:read", "runs:control"]);
export type ApplicationScope = z.infer<typeof applicationScopeSchema>;
const scopeSchema = applicationScopeSchema;
const createSchema = z.strictObject({ name: z.string().trim().min(1).max(120),
  agentIds: z.array(z.uuid()).min(1).max(100).refine(ids => new Set(ids).size === ids.length),
  scopes: z.array(scopeSchema).min(1).refine(scopes => new Set(scopes).size === scopes.length) });
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
type Owner = { accountId: string; organizationId: string };
type Authorize = (db: PoolClient, owner: Owner) => Promise<void>;

export class Applications {
  constructor(private readonly pool: Pool, private readonly authorize: Authorize) {}

  async create(owner: Owner, raw: unknown) {
    const input = createSchema.parse(raw);
    const secret = `kat_${randomBytes(32).toString("base64url")}`;
    return transaction(this.pool, async db => {
      await this.authorize(db, owner);
      const agents = await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL FOR SHARE", [owner.organizationId, input.agentIds]);
      if (agents.rowCount !== input.agentIds.length) throw new PlatformError("ACCESS_DENIED", 403, "An agent is unavailable");
      const applicationId = randomUUID(), credentialId = randomUUID();
      await db.query("INSERT INTO agents_platform.applications(id,organization_id,name,agent_ids,created_by) VALUES($1,$2,$3,$4,$5)", [applicationId, owner.organizationId, input.name, input.agentIds, owner.accountId]);
      await db.query("INSERT INTO agents_platform.application_credentials(id,organization_id,application_id,secret_hash,scopes) VALUES($1,$2,$3,$4,$5)", [credentialId, owner.organizationId, applicationId, hash(secret), input.scopes]);
      return { application: { id: applicationId, name: input.name, agentIds: input.agentIds }, credential: { id: credentialId, scopes: input.scopes, secret } };
    });
  }

  async list(owner: Owner) {
    return transaction(this.pool, async db => {
      await this.authorize(db, owner);
      const rows = (await db.query(`SELECT a.id,a.name,a.agent_ids,a.created_at,a.revoked_at,
        COALESCE(json_agg(json_build_object('id',k.id,'scopes',k.scopes,'createdAt',k.created_at,'revokedAt',k.revoked_at) ORDER BY k.created_at,k.id)
          FILTER (WHERE k.id IS NOT NULL),'[]'::json) credentials
        FROM agents_platform.applications a LEFT JOIN agents_platform.application_credentials k ON k.application_id=a.id
        WHERE a.organization_id=$1 GROUP BY a.id ORDER BY a.created_at,a.id`, [owner.organizationId])).rows;
      return rows.map(row => ({ id: row.id, name: row.name, agentIds: row.agent_ids, createdAt: row.created_at, revokedAt: row.revoked_at, credentials: row.credentials }));
    });
  }

  async revoke(owner: Owner, applicationId: string) {
    z.uuid().parse(applicationId);
    return transaction(this.pool, async db => {
      await this.authorize(db, owner);
      const result = await db.query("UPDATE agents_platform.applications SET revoked_at=COALESCE(revoked_at,now()) WHERE organization_id=$1 AND id=$2 RETURNING id", [owner.organizationId, applicationId]);
      if (!result.rowCount) throw new PlatformError("NOT_FOUND", 404, "Application not found");
      return { id: applicationId };
    });
  }

  async assignAgents(owner: Owner, applicationId: string, raw: unknown) {
    z.uuid().parse(applicationId);
    const { agentIds } = z.strictObject({ agentIds: z.array(z.uuid()).max(100)
      .refine(ids => new Set(ids).size === ids.length) }).parse(raw);
    return transaction(this.pool, async db => {
      await this.authorize(db, owner);
      const application = await db.query("SELECT id FROM agents_platform.applications WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL FOR UPDATE", [owner.organizationId, applicationId]);
      if (!application.rowCount) throw new PlatformError("NOT_FOUND", 404, "Application not found");
      const agents = await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL FOR SHARE", [owner.organizationId, agentIds]);
      if (agents.rowCount !== agentIds.length) throw new PlatformError("ACCESS_DENIED", 403, "An agent is unavailable");
      await db.query("UPDATE agents_platform.applications SET agent_ids=$3 WHERE organization_id=$1 AND id=$2", [owner.organizationId, applicationId, agentIds]);
      return { id: applicationId, agentIds };
    });
  }

  async issueCredential(owner: Owner, applicationId: string, raw: unknown) {
    z.uuid().parse(applicationId);
    const input = z.strictObject({ scopes: z.array(scopeSchema).min(1).refine(scopes => new Set(scopes).size === scopes.length) }).parse(raw);
    const secret = `kat_${randomBytes(32).toString("base64url")}`;
    return transaction(this.pool, async db => {
      await this.authorize(db, owner);
      const application = await db.query("SELECT id FROM agents_platform.applications WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL FOR SHARE", [owner.organizationId, applicationId]);
      if (!application.rowCount) throw new PlatformError("NOT_FOUND", 404, "Application not found");
      const id = randomUUID();
      await db.query("INSERT INTO agents_platform.application_credentials(id,organization_id,application_id,secret_hash,scopes) VALUES($1,$2,$3,$4,$5)", [id, owner.organizationId, applicationId, hash(secret), input.scopes]);
      return { credential: { id, scopes: input.scopes, secret } };
    });
  }

  async revokeCredential(owner: Owner, applicationId: string, credentialId: string) {
    z.uuid().parse(applicationId); z.uuid().parse(credentialId);
    return transaction(this.pool, async db => {
      await this.authorize(db, owner);
      const result = await db.query("UPDATE agents_platform.application_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE organization_id=$1 AND application_id=$2 AND id=$3 RETURNING id", [owner.organizationId, applicationId, credentialId]);
      if (!result.rowCount) throw new PlatformError("NOT_FOUND", 404, "Credential not found");
      return { id: credentialId };
    });
  }

  async listAgents(secret: string) {
    if (!/^kat_[A-Za-z0-9_-]{43}$/.test(secret)) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    const rows = (await this.pool.query(`SELECT a.id,a.name FROM agents_platform.application_credentials k
      JOIN agents_platform.applications app ON app.id=k.application_id AND app.organization_id=k.organization_id
      LEFT JOIN agents_platform.agents a ON a.organization_id=app.organization_id AND a.id=ANY(app.agent_ids) AND a.deleted_at IS NULL
      WHERE k.secret_hash=$1 AND k.revoked_at IS NULL AND app.revoked_at IS NULL AND 'agents:read'=ANY(k.scopes)
      ORDER BY a.name,a.id`, [hash(secret)])).rows;
    if (!rows.length) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    return rows.filter(row => row.id !== null).map(row => ({ id: row.id, name: row.name }));
  }

  async authenticate(secret: string, scope: ApplicationScope) {
    if (!/^kat_[A-Za-z0-9_-]{43}$/.test(secret)) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    const result = await this.pool.query<{ organization_id: string; application_id: string; credential_id: string }>(`SELECT k.organization_id,k.application_id,k.id credential_id
      FROM agents_platform.application_credentials k JOIN agents_platform.applications app
        ON app.id=k.application_id AND app.organization_id=k.organization_id
      WHERE k.secret_hash=$1 AND k.revoked_at IS NULL AND app.revoked_at IS NULL AND $2=ANY(k.scopes)`, [hash(secret), scope]);
    const row = result.rows[0];
    if (!row) throw new PlatformError("INVALID_CREDENTIAL", 401, "Invalid application credential");
    return { organizationId: row.organization_id, applicationId: row.application_id, credentialId: row.credential_id };
  }
}
