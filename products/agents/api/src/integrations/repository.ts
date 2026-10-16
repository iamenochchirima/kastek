import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { query } from "../db/pool";
import type { IntegrationConnectionStatus } from "./catalog";

export interface IntegrationCredentialRecord {
  id: string;
  organization_id: string;
  integration_id: string;
  label: string;
  status: "active" | "revoked";
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

export interface IntegrationConnectionRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  integration_id: string;
  credential_id: string | null;
  status: IntegrationConnectionStatus;
  configuration: Record<string, unknown>;
  health_message: string | null;
  last_checked_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface IntegrationOAuthStateRecord {
  id: string;
  organization_id: string;
  installation_id: string;
  integration_id: string;
  redirect_uri: string;
  created_by: string;
  expires_at: string;
  flow: "native" | "mcp";
  code_verifier: string | null;
  client_id: string | null;
  client_secret: string | null;
  resource: string | null;
  authorization_endpoint: string | null;
  token_endpoint: string | null;
  agent_version_id: string | null;
}

function encryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new Error("AGENTS_CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

function encrypt(payload: string, rawKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(rawKey), iv);
  const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString("base64url")).join(".");
}

function decrypt(payload: string, rawKey: string): string {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = payload.split(".");
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error("Invalid encrypted integration credential");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(rawKey), Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]).toString("utf8");
}

export class IntegrationRepository {
  public constructor(private readonly pool: Pool, private readonly encryptionSecret?: string) {}

  public get database(): Pool {
    return this.pool;
  }

  public async listConnections(organizationId: string, installationId: string): Promise<IntegrationConnectionRecord[]> {
    const result = await query<IntegrationConnectionRecord>(this.pool, `
      SELECT * FROM integration_connections
      WHERE organization_id = $1 AND installation_id = $2 AND revoked_at IS NULL
      ORDER BY integration_id`, [organizationId, installationId]);
    return result.rows;
  }

  public async getConnection(organizationId: string, installationId: string, integrationId: string): Promise<IntegrationConnectionRecord | null> {
    const result = await query<IntegrationConnectionRecord>(this.pool, `
      SELECT * FROM integration_connections
      WHERE organization_id = $1 AND installation_id = $2 AND integration_id = $3 AND revoked_at IS NULL`, [organizationId, installationId, integrationId]);
    return result.rows[0] ?? null;
  }

  public async upsertConnection(input: {
    organizationId: string;
    installationId: string;
    integrationId: string;
    status: IntegrationConnectionStatus;
    credentialId?: string | null;
    configuration?: Record<string, unknown>;
    healthMessage?: string | null;
    actorId: string;
  }): Promise<IntegrationConnectionRecord> {
    const result = await query<IntegrationConnectionRecord>(this.pool, `
      INSERT INTO integration_connections
        (organization_id, installation_id, integration_id, credential_id, status, configuration, health_message, last_checked_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), $8)
      ON CONFLICT (installation_id, integration_id) DO UPDATE SET
        credential_id = EXCLUDED.credential_id,
        status = EXCLUDED.status,
        configuration = EXCLUDED.configuration,
        health_message = EXCLUDED.health_message,
        last_checked_at = now(),
        updated_at = now(),
        revoked_at = NULL
      RETURNING *`, [input.organizationId, input.installationId, input.integrationId, input.credentialId ?? null, input.status, JSON.stringify(input.configuration ?? {}), input.healthMessage ?? null, input.actorId]);
    return result.rows[0]!;
  }

  public async disconnect(input: { organizationId: string; installationId: string; integrationId: string }): Promise<void> {
    await query(this.pool, `UPDATE integration_connections SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE organization_id = $1 AND installation_id = $2 AND integration_id = $3 AND revoked_at IS NULL`, [input.organizationId, input.installationId, input.integrationId]);
  }

  public async storeCredential(input: { organizationId: string; integrationId: string; secret: string; label?: string; actorId: string }): Promise<IntegrationCredentialRecord> {
    if (!this.encryptionSecret) throw new Error("Credential encryption is not configured");
    if (!input.secret.trim()) throw new Error("Integration credential cannot be empty");
    const result = await query<IntegrationCredentialRecord>(this.pool, `
      INSERT INTO integration_credentials (organization_id, integration_id, label, encrypted_payload, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, organization_id, integration_id, label, status, created_by, created_at, revoked_at`, [input.organizationId, input.integrationId, input.label?.trim() || "integration credential", encrypt(input.secret.trim(), this.encryptionSecret), input.actorId]);
    return result.rows[0]!;
  }

  public async resolveCredential(organizationId: string, credentialId: string): Promise<string> {
    if (!this.encryptionSecret) throw new Error("Credential encryption is not configured");
    const result = await query<{ encrypted_payload: string }>(this.pool, `SELECT encrypted_payload FROM integration_credentials WHERE id = $1 AND organization_id = $2 AND status = 'active'`, [credentialId, organizationId]);
    const payload = result.rows[0]?.encrypted_payload;
    if (!payload) throw new Error("Integration credential not found or revoked");
    return decrypt(payload, this.encryptionSecret);
  }

  public async replaceCredential(organizationId: string, credentialId: string, secret: string): Promise<void> {
    if (!this.encryptionSecret) throw new Error("Credential encryption is not configured");
    if (!secret.trim()) throw new Error("Integration credential cannot be empty");
    await query(this.pool, `UPDATE integration_credentials SET encrypted_payload = $1 WHERE organization_id = $2 AND id = $3 AND status = 'active'`, [encrypt(secret.trim(), this.encryptionSecret), organizationId, credentialId]);
  }

  public async listCredentialMetadata(organizationId: string): Promise<IntegrationCredentialRecord[]> {
    const result = await query<IntegrationCredentialRecord>(this.pool, `SELECT id, organization_id, integration_id, label, status, created_by, created_at, revoked_at FROM integration_credentials WHERE organization_id = $1 ORDER BY created_at DESC`, [organizationId]);
    return result.rows;
  }

  public async revokeCredential(organizationId: string, credentialId: string): Promise<void> {
    await query(this.pool, `UPDATE integration_credentials SET status = 'revoked', revoked_at = now() WHERE organization_id = $1 AND id = $2 AND status = 'active'`, [organizationId, credentialId]);
  }

  public async createOAuthState(input: {
    organizationId: string;
    installationId: string;
    integrationId: string;
    stateHash: string;
    redirectUri: string;
    createdBy: string;
    expiresAt: string;
    flow?: "native" | "mcp";
    codeVerifier?: string;
    clientId?: string;
    clientSecret?: string;
    resource?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    agentVersionId?: string;
  }): Promise<void> {
    const encryptedClientSecret = input.clientSecret
      ? (() => {
        if (!this.encryptionSecret) throw new Error("Credential encryption is not configured");
        return encrypt(input.clientSecret, this.encryptionSecret);
      })()
      : null;
    await query(this.pool, `INSERT INTO integration_oauth_states
      (organization_id, installation_id, integration_id, state_hash, redirect_uri, created_by,
       expires_at, flow, code_verifier, client_id, encrypted_client_secret, resource,
       authorization_endpoint, token_endpoint, agent_version_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10, $11, $12, $13, $14, $15)`, [
      input.organizationId,
      input.installationId,
      input.integrationId,
      input.stateHash,
      input.redirectUri,
      input.createdBy,
      input.expiresAt,
      input.flow ?? "native",
      input.codeVerifier ?? null,
      input.clientId ?? null,
      encryptedClientSecret,
      input.resource ?? null,
      input.authorizationEndpoint ?? null,
      input.tokenEndpoint ?? null,
      input.agentVersionId ?? null,
    ]);
  }

  public async consumeOAuthState(stateHash: string): Promise<IntegrationOAuthStateRecord | null> {
    const result = await query<IntegrationOAuthStateRecord & { encrypted_client_secret: string | null }>(this.pool, `DELETE FROM integration_oauth_states WHERE state_hash = $1 AND expires_at > now() RETURNING id, organization_id, installation_id, integration_id, redirect_uri, created_by, expires_at, flow, code_verifier, client_id, encrypted_client_secret, resource, authorization_endpoint, token_endpoint, agent_version_id`, [stateHash]);
    const row = result.rows[0];
    if (!row) return null;
    const { encrypted_client_secret: encryptedClientSecret, ...state } = row;
    return {
      ...state,
      client_secret: encryptedClientSecret
        ? (() => {
          if (!this.encryptionSecret) throw new Error("Credential encryption is not configured");
          return decrypt(encryptedClientSecret, this.encryptionSecret);
        })()
        : null,
    };
  }
}
