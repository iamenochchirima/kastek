import type { Pool } from "pg";
import { query } from "../pool";

export type AttachmentScanStatus = "pending" | "clean" | "quarantined" | "failed";

export interface AttachmentReference {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string | null;
  object_key: string;
  sha256: string;
  mime_type: string;
  size_bytes: number;
  scan_status: AttachmentScanStatus;
  retention_expires_at: string | null;
  created_at: string;
  scanned_at: string | null;
}

export class AttachmentRepository {
  public constructor(private readonly pool: Pool) {}

  public async create(input: { organizationId: string; installationId: string; runId?: string; objectKey: string; sha256: string; mimeType: string; sizeBytes: number; retentionExpiresAt?: string }): Promise<AttachmentReference> {
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error("Attachment hash must be SHA-256 hex");
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) || input.mimeType.length > 160) throw new Error("Attachment MIME type is invalid");
    if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new Error("Attachment size is invalid");
    const result = await query<AttachmentReference>(this.pool, `INSERT INTO agent_attachment_references (organization_id, installation_id, run_id, object_key, sha256, mime_type, size_bytes, scan_status, retention_expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8) ON CONFLICT (organization_id, object_key) DO UPDATE SET sha256 = EXCLUDED.sha256, mime_type = EXCLUDED.mime_type, size_bytes = EXCLUDED.size_bytes RETURNING *`, [input.organizationId, input.installationId, input.runId ?? null, input.objectKey, input.sha256, input.mimeType, input.sizeBytes, input.retentionExpiresAt ?? null]);
    return result.rows[0]!;
  }

  public async setScanStatus(organizationId: string, id: string, status: Exclude<AttachmentScanStatus, "pending">): Promise<void> {
    await query(this.pool, `UPDATE agent_attachment_references SET scan_status = $3, scanned_at = now() WHERE organization_id = $1 AND id = $2`, [organizationId, id, status]);
  }

  public async getClean(organizationId: string, id: string): Promise<AttachmentReference | null> {
    const result = await query<AttachmentReference>(this.pool, `SELECT * FROM agent_attachment_references WHERE organization_id = $1 AND id = $2 AND scan_status = 'clean' AND (retention_expires_at IS NULL OR retention_expires_at > now())`, [organizationId, id]);
    return result.rows[0] ?? null;
  }
}
