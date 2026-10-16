import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { query } from "../pool";

export interface HostedAgentApiKey {
  id: string;
  organization_id: string;
  installation_id: string;
  label: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
const columns = "id, organization_id, installation_id, label, created_by, created_at, expires_at, last_used_at, revoked_at";
const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");

export class HostedAgentApiKeyRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(input: { organizationId: string; installationId: string; actorId: string; label: string; expiresAt: string }): Promise<{ key: HostedAgentApiKey; secret: string }> {
    const id = randomUUID();
    const secret = `kagent_${id}_${randomBytes(32).toString("base64url")}`;
    const result = await query<HostedAgentApiKey>(this.pool,
      `INSERT INTO hosted_agent_api_keys (id, organization_id, installation_id, label, secret_hash, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${columns}`,
      [id, input.organizationId, input.installationId, input.label, hash(secret), input.actorId, input.expiresAt]);
    return { key: result.rows[0]!, secret };
  }

  public async list(organizationId: string, installationId: string): Promise<HostedAgentApiKey[]> {
    const result = await query<HostedAgentApiKey>(this.pool,
      `SELECT ${columns} FROM hosted_agent_api_keys WHERE organization_id = $1 AND installation_id = $2 ORDER BY created_at DESC`,
      [organizationId, installationId]);
    return result.rows;
  }

  public async revoke(organizationId: string, installationId: string, keyId: string, actorId: string): Promise<boolean> {
    const result = await query(this.pool,
      `UPDATE hosted_agent_api_keys SET revoked_at = COALESCE(revoked_at, now()), revoked_by = COALESCE(revoked_by, $4)
       WHERE organization_id = $1 AND installation_id = $2 AND id = $3 RETURNING id`,
      [organizationId, installationId, keyId, actorId]);
    return Boolean(result.rows[0]);
  }

  /** Called only within the narrow operator discovery scope, never a tenant request scope. */
  public async authenticate(secret: string): Promise<HostedAgentApiKey | null> {
    const match = /^kagent_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/.exec(secret);
    if (!match) return null;
    const result = await query<HostedAgentApiKey & { secret_hash: string }>(this.pool,
      `SELECT key.* FROM hosted_agent_api_keys key
       JOIN agent_installations installation ON installation.id = key.installation_id AND installation.organization_id = key.organization_id
       JOIN agent_definitions definition ON definition.id = installation.agent_definition_id
       JOIN platform_memberships membership ON membership.account_id = key.created_by AND membership.organization_id::text = key.organization_id
       WHERE key.id = $1 AND key.revoked_at IS NULL AND key.expires_at > now()
         AND installation.status = 'active' AND installation.execution_mode = 'kasitek_hosted'
         AND definition.protected = false AND membership.revoked_at IS NULL AND membership.role <> 'viewer'`, [match[1]]);
    const candidate = result.rows[0];
    if (!candidate || !timingSafeEqual(Buffer.from(candidate.secret_hash, "hex"), Buffer.from(hash(secret), "hex"))) return null;
    // Switch to the tenant scope before updating usage; operator discovery is read-only.
    const { secret_hash: _hash, ...key } = candidate;
    return key;
  }

  public async recordUse(key: HostedAgentApiKey): Promise<void> {
    await query(this.pool, "UPDATE hosted_agent_api_keys SET last_used_at = now() WHERE id = $1 AND organization_id = $2", [key.id, key.organization_id]);
  }
}
