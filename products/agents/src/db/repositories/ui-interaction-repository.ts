import type { Pool } from "pg";
import { query } from "../pool";

export interface UiInteractionReceipt {
  organization_id: string;
  installation_id: string;
  idempotency_key: string;
  actor_id: string;
  conversation_id: string;
  message_id: string;
  block_id: string;
  action_id: string;
  event_key: string;
  values: Record<string, unknown>;
  run_id: string | null;
  status: "started" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
}

export class UiInteractionRepository {
  public constructor(private readonly pool: Pool) {}

  public async claim(input: Omit<UiInteractionReceipt, "run_id" | "status" | "created_at" | "completed_at">): Promise<{ created: boolean; receipt: UiInteractionReceipt }> {
    const inserted = await query<UiInteractionReceipt>(
      this.pool,
      `INSERT INTO agent_ui_interaction_receipts
        (organization_id, installation_id, idempotency_key, actor_id, conversation_id, message_id, block_id, action_id, event_key, "values")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (organization_id, installation_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [input.organization_id, input.installation_id, input.idempotency_key, input.actor_id, input.conversation_id, input.message_id, input.block_id, input.action_id, input.event_key, JSON.stringify(input.values)],
    );
    if (inserted.rows[0]) return { created: true, receipt: inserted.rows[0] };
    const existing = await query<UiInteractionReceipt>(
      this.pool,
      `SELECT * FROM agent_ui_interaction_receipts
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3
       LIMIT 1`,
      [input.organization_id, input.installation_id, input.idempotency_key],
    );
    if (!existing.rows[0]) throw new Error("UI interaction receipt could not be read");
    return { created: false, receipt: existing.rows[0] };
  }

  public async complete(input: { organizationId: string; installationId: string; idempotencyKey: string; runId: string }): Promise<void> {
    await query(
      this.pool,
      `UPDATE agent_ui_interaction_receipts
       SET status = 'completed', run_id = $4, completed_at = now()
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3 AND status = 'started'`,
      [input.organizationId, input.installationId, input.idempotencyKey, input.runId],
    );
  }

  public async fail(input: { organizationId: string; installationId: string; idempotencyKey: string }): Promise<void> {
    await query(
      this.pool,
      `UPDATE agent_ui_interaction_receipts
       SET status = 'failed', completed_at = now()
       WHERE organization_id = $1 AND installation_id = $2 AND idempotency_key = $3 AND status = 'started'`,
      [input.organizationId, input.installationId, input.idempotencyKey],
    );
  }
}
