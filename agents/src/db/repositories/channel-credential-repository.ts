import type { Pool } from "pg";
import { query } from "../pool";
import { decryptChannelSecret, encryptChannelSecret } from "../channel-secret-crypto";

export interface ChannelCredentialRecord {
  id: string;
  organization_id: string;
  provider: "telegram";
  label: string;
  status: "active" | "revoked";
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

export class ChannelCredentialRepository {
  public constructor(private readonly pool: Pool, private readonly encryptionSecret?: string) {}

  public async store(input: {
    organizationId: string;
    provider: "telegram";
    secret: string;
    label?: string;
    actorId: string;
  }): Promise<ChannelCredentialRecord> {
    if (!this.encryptionSecret) throw new Error("Credential vault encryption is not configured");
    if (!input.secret.trim()) throw new Error("Channel credential cannot be empty");
    const result = await query<ChannelCredentialRecord>(
      this.pool,
      `INSERT INTO channel_credentials
        (organization_id, provider, label, encrypted_payload, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, organization_id, provider, label, status, created_by, created_at, revoked_at`,
      [input.organizationId, input.provider, input.label?.trim() || "Telegram bot credential", encryptChannelSecret(input.secret.trim(), this.encryptionSecret), input.actorId],
    );
    return result.rows[0]!;
  }

  public async resolve(organizationId: string, reference: string, provider: "telegram" = "telegram"): Promise<string> {
    if (!this.encryptionSecret) throw new Error("Credential vault encryption is not configured");
    const result = await query<{ encrypted_payload: string }>(
      this.pool,
      `SELECT encrypted_payload FROM channel_credentials
       WHERE id = $1 AND organization_id = $2 AND provider = $3 AND status = 'active'`,
      [reference, organizationId, provider],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Channel credential reference not found or revoked");
    return decryptChannelSecret(row.encrypted_payload, this.encryptionSecret);
  }

  public async revoke(organizationId: string, id: string): Promise<void> {
    const result = await query(
      this.pool,
      `UPDATE channel_credentials SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
      [id, organizationId],
    );
    if (!result.rowCount) throw new Error("Channel credential not found");
  }
}
