import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { query } from "../pool";
import type { ModelProvider, ModelCredentials } from "../../model/types";

export interface CredentialRecord {
  id: string;
  organization_id: string;
  provider: ModelProvider;
  label: string;
  funding_source: "user";
  status: "active" | "revoked";
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

function encryptionKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-f]{64}$/i.test(trimmed) ? Buffer.from(trimmed, "hex") : Buffer.from(trimmed, "base64");
  if (key.length !== 32) throw new Error("AGENTS_CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

function encrypt(secret: string, rawKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(rawKey), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((value) => value.toString("base64url")).join(".");
}

function decrypt(payload: string, rawKey: string): string {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = payload.split(".");
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) throw new Error("Invalid encrypted credential payload");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(rawKey), Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]).toString("utf8");
}

export class CredentialVaultRepository {
  public constructor(private readonly pool: Pool, private readonly encryptionSecret?: string) {}

  public async store(input: {
    organizationId: string;
    provider: ModelProvider;
    apiKey: string;
    label?: string;
    actorId: string;
  }): Promise<CredentialRecord> {
    if (!this.encryptionSecret) throw new Error("Credential vault encryption is not configured");
    if (!input.apiKey.trim()) throw new Error("Credential cannot be empty");
    const result = await query<CredentialRecord>(
      this.pool,
      `INSERT INTO credential_vault
        (organization_id, provider, label, encrypted_payload, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, organization_id, provider, label, funding_source, status, created_by, created_at, revoked_at`,
      [input.organizationId, input.provider, input.label?.trim() || "provider credential", encrypt(input.apiKey.trim(), this.encryptionSecret), input.actorId],
    );
    return result.rows[0]!;
  }

  public async resolve(organizationId: string, provider: ModelProvider, reference: string): Promise<ModelCredentials> {
    if (!this.encryptionSecret) throw new Error("Credential vault encryption is not configured");
    const result = await query<{ encrypted_payload: string; funding_source: "user" }>(
      this.pool,
      `SELECT encrypted_payload, funding_source FROM credential_vault
       WHERE id = $1 AND organization_id = $2 AND provider = $3 AND status = 'active'`,
      [reference, organizationId, provider],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Credential reference not found or revoked");
    return { apiKey: decrypt(row.encrypted_payload, this.encryptionSecret), fundingSource: row.funding_source, credentialReference: reference };
  }

  public async list(organizationId: string): Promise<CredentialRecord[]> {
    const result = await query<CredentialRecord>(
      this.pool,
      `SELECT id, organization_id, provider, label, funding_source, status, created_by, created_at, revoked_at
       FROM credential_vault WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return result.rows;
  }

  public async revoke(organizationId: string, id: string): Promise<void> {
    const result = await query(
      this.pool,
      `UPDATE credential_vault SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [id, organizationId],
    );
    if (!result.rowCount) throw new Error("Credential not found");
  }
}
