import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";
import { validateClientAssertionPublicKey } from "../../auth/installation-token";

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
  mcp_scopes: Array<"mcp:read" | "mcp:write">;
  api_scopes?: Array<"api:read" | "api:write">;
  client_key_id: string | null;
  client_public_key: string | null;
}

export interface CreatedInstallationCredential {
  credential: InstallationCredentialRecord;
  secret: string;
}

export interface InstallationCredentialInventoryRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  installation_status: string;
  execution_mode: "system_hosted" | "kasitek_hosted" | "external_connected";
  agent_definition_id: string;
  agent_owner_type: string;
  agent_protected: boolean;
  status: "active" | "revoked";
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  classification: "valid_external" | "invalid_system_hosted" | "invalid_kasitek_hosted";
}

export interface CreateInstallationCredentialInput {
  organizationId: string;
  installationId: string;
  label: string;
  actorId: string;
  expiresAt?: string;
  clientKeyId?: string;
  clientPublicKey?: string;
}

const KEY_LENGTH = 32;
const ALL_MCP_SCOPES = ["mcp:read", "mcp:write"] as const;
const ALL_API_SCOPES = ["api:read", "api:write"] as const;

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

  public async create(input: CreateInstallationCredentialInput): Promise<CreatedInstallationCredential> {
    return withTransaction(this.pool, async (client) => {
      const installation = await client.query<{ id: string }>(
        `SELECT id FROM agent_installations
         WHERE id = $1 AND organization_id = $2 AND status <> 'disabled'
           AND execution_mode = 'external_connected'
         FOR UPDATE`,
        [input.installationId, input.organizationId],
      );
      if (!installation.rows[0]) throw new Error("Active external-connected installation not found");
      return createInstallationCredentialInTransaction(client, input);
    });
  }

  public async list(organizationId: string, installationId: string): Promise<InstallationCredentialRecord[]> {
    const result = await query<InstallationCredentialRecord>(
      this.pool,
      `SELECT id, installation_id, organization_id, label, status, expires_at, last_used_at, created_at, revoked_at, mcp_scopes, api_scopes, client_key_id, client_public_key
       FROM agent_installation_credentials WHERE organization_id = $1 AND installation_id = $2 ORDER BY created_at DESC`,
      [organizationId, installationId],
    );
    return result.rows;
  }

  public async inventory(input: { organizationId?: string; limit?: number } = {}): Promise<InstallationCredentialInventoryRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 500, 2_000));
    const result = await query<InstallationCredentialInventoryRecord>(
      this.pool,
      `SELECT credential.id,
              credential.organization_id,
              credential.installation_id,
              installation.status AS installation_status,
              installation.execution_mode,
              installation.agent_definition_id,
              definition.owner_type AS agent_owner_type,
              definition.protected AS agent_protected,
              credential.status,
              credential.expires_at,
              credential.last_used_at,
              credential.created_at,
              credential.revoked_at,
              credential.revoked_by,
              CASE installation.execution_mode
                WHEN 'external_connected' THEN 'valid_external'
                WHEN 'system_hosted' THEN 'invalid_system_hosted'
                ELSE 'invalid_kasitek_hosted'
              END AS classification
       FROM agent_installation_credentials credential
       JOIN agent_installations installation ON installation.id = credential.installation_id
       JOIN agent_definitions definition ON definition.id = installation.agent_definition_id
       WHERE ($1::text IS NULL OR credential.organization_id = $1)
       ORDER BY credential.created_at DESC
       LIMIT $2`,
      [input.organizationId ?? null, limit],
    );
    return result.rows;
  }

  public async authenticate(secret: string): Promise<InstallationCredentialRecord | null> {
    const candidates = await query<InstallationCredentialRecord & { secret_hash: string; installation_status: string }>(
      this.pool,
      `SELECT credential.id, credential.installation_id, credential.organization_id, credential.label, credential.status,
              credential.expires_at, credential.last_used_at, credential.created_at, credential.revoked_at, credential.mcp_scopes, credential.api_scopes, credential.client_key_id, credential.client_public_key,
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

  /** Revalidates a short-lived token's credential at request time so revocation is immediate. */
  public async getActiveForToken(input: {
    credentialId: string;
    organizationId: string;
    installationId: string;
  }): Promise<InstallationCredentialRecord | null> {
    const result = await query<InstallationCredentialRecord>(
      this.pool,
      `SELECT credential.id, credential.installation_id, credential.organization_id, credential.label,
              credential.status, credential.expires_at, credential.last_used_at, credential.created_at,
              credential.revoked_at, credential.mcp_scopes, credential.api_scopes, credential.client_key_id, credential.client_public_key
       FROM agent_installation_credentials credential
       JOIN agent_installations installation ON installation.id = credential.installation_id
       WHERE credential.id = $1 AND credential.organization_id = $2 AND credential.installation_id = $3
         AND credential.status = 'active' AND credential.revoked_at IS NULL
         AND (credential.expires_at IS NULL OR credential.expires_at > now())
         AND installation.organization_id = $2 AND installation.status = 'active'`,
      [input.credentialId, input.organizationId, input.installationId],
    );
    return result.rows[0] ?? null;
  }

  public async getActiveForClientAssertion(input: {
    credentialId: string;
    clientKeyId: string;
  }): Promise<InstallationCredentialRecord | null> {
    const result = await query<InstallationCredentialRecord>(
      this.pool,
      `SELECT credential.id, credential.installation_id, credential.organization_id, credential.label,
              credential.status, credential.expires_at, credential.last_used_at, credential.created_at,
              credential.revoked_at, credential.mcp_scopes, credential.api_scopes, credential.client_key_id,
              credential.client_public_key
       FROM agent_installation_credentials credential
       JOIN agent_installations installation ON installation.id = credential.installation_id
       WHERE credential.id = $1 AND credential.client_key_id = $2
         AND credential.status = 'active' AND credential.revoked_at IS NULL
         AND (credential.expires_at IS NULL OR credential.expires_at > now())
         AND installation.status = 'active'`,
      [input.credentialId, input.clientKeyId],
    );
    return result.rows[0] ?? null;
  }

  public async consumeClientAssertionReplay(input: { credentialId: string; jti: string; expiresAt: string }): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      await client.query(`DELETE FROM agent_client_assertion_replays WHERE expires_at <= now()`);
      const result = await client.query(
        `INSERT INTO agent_client_assertion_replays (credential_id, jti, expires_at)
         VALUES ($1, $2, $3::timestamptz)
         ON CONFLICT (credential_id, jti) DO NOTHING`,
        [input.credentialId, input.jti, input.expiresAt],
      );
      return result.rowCount === 1;
    });
  }

  public async markUsed(credentialId: string): Promise<void> {
    await query(this.pool, `UPDATE agent_installation_credentials SET last_used_at = now() WHERE id = $1`, [credentialId]);
  }

  public async revoke(input: { organizationId: string; installationId: string; credentialId: string; actorId: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE agent_installation_credentials SET status = 'revoked', revoked_at = now(), revoked_by = $4
         WHERE id = $1 AND installation_id = $2 AND organization_id = $3 AND status = 'active'`,
        [input.credentialId, input.installationId, input.organizationId, input.actorId],
      );
      if (!result.rowCount) throw new Error("Active installation credential not found");
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_installation_credential.revoked', 'agent_installation_credential', $3, $4::jsonb)`,
        [input.organizationId, input.actorId, input.credentialId, JSON.stringify({ installationId: input.installationId, executionMode: "external_connected" })],
      );
    });
  }

  public async rotate(input: { organizationId: string; installationId: string; credentialId: string; actorId: string }): Promise<CreatedInstallationCredential> {
    const secret = `ksi_${randomBytes(32).toString("base64url")}`;
    const credential = await withTransaction(this.pool, async (client) => {
      const current = await client.query<InstallationCredentialRecord>(
        `SELECT id, installation_id, organization_id, label, status, expires_at, last_used_at, created_at, revoked_at, mcp_scopes, api_scopes, client_key_id, client_public_key
         FROM agent_installation_credentials
         WHERE id = $1 AND installation_id = $2 AND organization_id = $3 AND status = 'active'
         FOR UPDATE`,
        [input.credentialId, input.installationId, input.organizationId],
      );
      const existing = current.rows[0];
      if (!existing) throw new Error("Active installation credential not found");
      await client.query(
        `UPDATE agent_installation_credentials SET status = 'revoked', revoked_at = now(), revoked_by = $4
         WHERE id = $1 AND installation_id = $2 AND organization_id = $3 AND status = 'active'`,
        [input.credentialId, input.installationId, input.organizationId, input.actorId],
      );
      const created = await client.query<InstallationCredentialRecord>(
        `INSERT INTO agent_installation_credentials
          (installation_id, organization_id, label, secret_hash, expires_at, mcp_scopes, api_scopes, client_key_id, client_public_key, created_by)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb, $7::jsonb, $8, $9, $10)
         RETURNING id, installation_id, organization_id, label, status, expires_at, last_used_at, created_at, revoked_at, mcp_scopes, api_scopes, client_key_id, client_public_key`,
        [input.installationId, input.organizationId, existing.label, hashSecret(secret), existing.expires_at, JSON.stringify(ALL_MCP_SCOPES), JSON.stringify(ALL_API_SCOPES), existing.client_key_id, existing.client_public_key, input.actorId],
      );
      await client.query(
        `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'human', $2, 'agent_installation_credential.rotated', 'agent_installation_credential', $3, $4::jsonb)`,
        [input.organizationId, input.actorId, created.rows[0]!.id, JSON.stringify({ installationId: input.installationId, executionMode: "external_connected", replacedCredentialId: input.credentialId })],
      );
      return created.rows[0]!;
    });
    return { credential, secret };
  }
}

/**
 * Creates a one-time installation credential on an existing transaction.
 * External-agent aggregate provisioning uses this boundary so the identity,
 * grants, credential, and audit record commit or roll back together.
 */
export async function createInstallationCredentialInTransaction(
  client: PoolClient,
  input: CreateInstallationCredentialInput,
): Promise<CreatedInstallationCredential> {
  const clientKeyId = input.clientKeyId?.trim() || null;
  const clientPublicKey = input.clientPublicKey?.trim() || null;
  if ((clientKeyId === null) !== (clientPublicKey === null)) throw new Error("Client key id and public key must be provided together");
  if (clientPublicKey) validateClientAssertionPublicKey(clientPublicKey);
  const secret = `ksi_${randomBytes(32).toString("base64url")}`;
  const result = await client.query<InstallationCredentialRecord>(
    `INSERT INTO agent_installation_credentials
      (installation_id, organization_id, label, secret_hash, expires_at, mcp_scopes, api_scopes, client_key_id, client_public_key, created_by)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::jsonb, $7::jsonb, $8, $9, $10)
     RETURNING id, installation_id, organization_id, label, status, expires_at, last_used_at, created_at, revoked_at, mcp_scopes, api_scopes, client_key_id, client_public_key`,
    [input.installationId, input.organizationId, input.label.trim(), hashSecret(secret), input.expiresAt ?? null, JSON.stringify(ALL_MCP_SCOPES), JSON.stringify(ALL_API_SCOPES), clientKeyId, clientPublicKey, input.actorId],
  );
  await client.query(
    `INSERT INTO audit_records (organization_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     VALUES ($1, 'human', $2, 'agent_installation_credential.created', 'agent_installation_credential', $3, $4::jsonb)`,
    [input.organizationId, input.actorId, result.rows[0]!.id, JSON.stringify({ installationId: input.installationId, executionMode: "external_connected", label: input.label.trim() })],
  );
  return { credential: result.rows[0]!, secret };
}

export const installationCredentialHashing = { hashSecret, verifySecret };
