import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export interface InstallationCredentialRecord {
  id: string;
  installation_id: string;
  organization_id: string;
  label: string;
  status: "active" | "revoked";
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedInstallationCredential {
  credential: InstallationCredentialRecord;
  secret: string;
}

const KEY_LENGTH = 32;

function hashSecret(secret: string, salt = randomBytes(16)): string {
  const derived = scryptSync(secret, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function verifySecret(secret: string, encoded: string): boolean {
  const [algorithm, saltValue, expectedValue] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltValue || !expectedValue) return false;
  const actual = scryptSync(secret, Buffer.from(saltValue, "base64url"), KEY_LENGTH);
  const expected = Buffer.from(expectedValue, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class InstallationCredentialRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(input: {
    organizationId: string;
    installationId: string;
    label: string;
    actorId: string;
    expiresAt?: string;
  }): Promise<CreatedInstallationCredential> {
    const secret = `ksi_${randomBytes(32).toString("base64url")}`;
    const credential = await withTransaction(this.pool, async (client) => {
      const installation = await client.query<{ id: string }>(
        `SELECT id FROM agent_installations WHERE id = $1 AND organization_id = $2 AND status <> 'disabled' FOR UPDATE`,
        [input.installationId, input.organizationId],
      );
      if (!installation.rows[0]) throw new Error("Active installation not found");
      const result = await client.query<InstallationCredentialRecord>(
        `INSERT INTO agent_installation_credentials
          (installation_id, organization_id, label, secret_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6)
         RETURNING id, installation_id, organization_id, label, status, expires_at, last_used_at, created_at, revoked_at`,
        [input.installationId, input.organizationId, input.label.trim(), hashSecret(secret), input.expiresAt ?? null, input.actorId],
      );
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_installation_credential.created', 'agent_installation_credential', $3, $4::jsonb)`,
        [input.organizationId, input.actorId, result.rows[0]!.id, JSON.stringify({ installationId: input.installationId, label: input.label.trim() })],
      );
      return result.rows[0]!;
    });
    return { credential, secret };
  }

  public async list(organizationId: string, installationId: string): Promise<InstallationCredentialRecord[]> {
    const result = await query<InstallationCredentialRecord>(
      this.pool,
      `SELECT id, installation_id, organization_id, label, status, expires_at, last_used_at, created_at, revoked_at
       FROM agent_installation_credentials WHERE organization_id = $1 AND installation_id = $2 ORDER BY created_at DESC`,
      [organizationId, installationId],
    );
    return result.rows;
  }

  public async authenticate(secret: string): Promise<InstallationCredentialRecord | null> {
    const candidates = await query<InstallationCredentialRecord & { secret_hash: string; installation_status: string }>(
      this.pool,
      `SELECT credential.id, credential.installation_id, credential.organization_id, credential.label, credential.status,
              credential.expires_at, credential.last_used_at, credential.created_at, credential.revoked_at,
              credential.secret_hash, installation.status AS installation_status
       FROM agent_installation_credentials credential
       JOIN agent_installations installation ON installation.id = credential.installation_id
       WHERE credential.status = 'active' AND credential.revoked_at IS NULL
         AND (credential.expires_at IS NULL OR credential.expires_at > now())
         AND installation.status = 'active'`,
    );
    const credential = candidates.rows.find((candidate) => verifySecret(secret, candidate.secret_hash));
    if (!credential) return null;
    await query(this.pool, `UPDATE agent_installation_credentials SET last_used_at = now() WHERE id = $1`, [credential.id]);
    const { secret_hash: _secretHash, installation_status: _installationStatus, ...safe } = credential;
    return safe;
  }

  public async revoke(input: { organizationId: string; installationId: string; credentialId: string; actorId: string }): Promise<void> {
    const result = await query(
      this.pool,
      `UPDATE agent_installation_credentials SET status = 'revoked', revoked_at = now(), revoked_by = $4
       WHERE id = $1 AND installation_id = $2 AND organization_id = $3 AND status = 'active'`,
      [input.credentialId, input.installationId, input.organizationId, input.actorId],
    );
    if (!result.rowCount) throw new Error("Active installation credential not found");
  }
}

export const installationCredentialHashing = { hashSecret, verifySecret };
