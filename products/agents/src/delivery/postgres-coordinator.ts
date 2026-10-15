import type { Pool } from "pg";
import { query } from "../db/pool";
import {
  createDeliveryObligationSchema,
  type CreateDeliveryObligation,
  type DeliveryClaim,
  type DeliveryObligation,
  type DeliveryObligationActionResult,
  type DeliveryObligationCoordinator,
  type DeliveryObligationState,
  type DeliveryOutcome,
} from "./contracts";

interface DeliveryObligationRow {
  id: string;
  organization_id: string;
  installation_id: string;
  run_id: string | null;
  conversation_id: string | null;
  channel: string;
  payload_ref: string;
  idempotency_key: string;
  state: DeliveryObligationState;
  claim_id: string | null;
  worker_id: string | null;
  claimed_at: string | null;
  receipt_ref: string | null;
  reason: string | null;
  reconciliation_id: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(row: DeliveryObligationRow): DeliveryObligation {
  const claim: DeliveryClaim | undefined = row.claim_id && row.worker_id && row.claimed_at
    ? { claimId: row.claim_id, workerId: row.worker_id, claimedAt: row.claimed_at }
    : undefined;
  const outcome: DeliveryOutcome | undefined = row.state === "delivered" || row.state === "failed" || row.state === "unknown"
    ? {
      kind: row.state,
      ...(row.receipt_ref ? { receiptRef: row.receipt_ref } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.reconciliation_id ? { reconciliationId: row.reconciliation_id } : {}),
      recordedAt: row.updated_at,
    }
    : undefined;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    scope: {
      organizationId: row.organization_id,
      installationId: row.installation_id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    },
    channel: row.channel,
    payloadRef: row.payload_ref,
    state: row.state,
    ...(claim ? { claim } : {}),
    ...(outcome ? { outcome } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function result(status: DeliveryObligationActionResult["status"], obligation: DeliveryObligation): DeliveryObligationActionResult {
  return { status, obligation } as DeliveryObligationActionResult;
}

/** PostgreSQL adapter for the same transition rules used by the in-memory conformance adapter. */
export class PostgresDeliveryObligationCoordinator implements DeliveryObligationCoordinator {
  public constructor(private readonly pool: Pool) {}

  public async create(input: CreateDeliveryObligation): Promise<DeliveryObligation> {
    const parsed = createDeliveryObligationSchema.parse(input);
    const inserted = await query<DeliveryObligationRow>(
      this.pool,
      `INSERT INTO agent_delivery_obligations
        (id, organization_id, installation_id, run_id, conversation_id, channel, payload_ref, idempotency_key)
       VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8)
       ON CONFLICT (organization_id, installation_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [parsed.id, parsed.scope.organizationId, parsed.scope.installationId, parsed.scope.runId ?? null, parsed.scope.conversationId ?? null, parsed.channel, parsed.payloadRef, parsed.idempotencyKey],
    );
    if (inserted.rows[0]) return hydrate(inserted.rows[0]);
    const existing = await query<DeliveryObligationRow>(
      this.pool,
      `SELECT * FROM agent_delivery_obligations
       WHERE organization_id = $1 AND installation_id = $2::uuid AND idempotency_key = $3`,
      [parsed.scope.organizationId, parsed.scope.installationId, parsed.idempotencyKey],
    );
    if (!existing.rows[0]) throw new Error("DELIVERY_OBLIGATION_CREATE_FAILED");
    return hydrate(existing.rows[0]);
  }

  public async get(id: string): Promise<DeliveryObligation | undefined> {
    const response = await query<DeliveryObligationRow>(this.pool, "SELECT * FROM agent_delivery_obligations WHERE id = $1::uuid", [id]);
    return response.rows[0] ? hydrate(response.rows[0]) : undefined;
  }

  public async claim(input: { obligationId: string; claimId: string; workerId: string }): Promise<DeliveryObligationActionResult> {
    const claimed = await query<DeliveryObligationRow>(
      this.pool,
      `UPDATE agent_delivery_obligations
       SET state = 'claimed', claim_id = $2, worker_id = $3, claimed_at = now()
       WHERE id = $1::uuid AND state = 'queued'
       RETURNING *`,
      [input.obligationId, input.claimId, input.workerId],
    );
    if (claimed.rows[0]) return result("applied", hydrate(claimed.rows[0]));
    const current = await this.get(input.obligationId);
    if (!current) throw new Error(`DELIVERY_OBLIGATION_NOT_FOUND:${input.obligationId}`);
    if (current.state === "claimed" && current.claim?.claimId === input.claimId && current.claim.workerId === input.workerId) return result("idempotent", current);
    return result(current.state === "claimed" ? "claim_conflict" : "not_claimable", current);
  }

  public async complete(input: { obligationId: string; claimId: string; receiptRef: string }): Promise<DeliveryObligationActionResult> {
    const completed = await query<DeliveryObligationRow>(
      this.pool,
      `UPDATE agent_delivery_obligations
       SET state = 'delivered', receipt_ref = $3
       WHERE id = $1::uuid AND state = 'claimed' AND claim_id = $2
       RETURNING *`,
      [input.obligationId, input.claimId, input.receiptRef],
    );
    if (completed.rows[0]) return result("applied", hydrate(completed.rows[0]));
    const current = await this.require(input.obligationId);
    if (current.state === "delivered" && current.claim?.claimId === input.claimId && current.outcome?.receiptRef === input.receiptRef) return result("idempotent", current);
    return result("not_completable", current);
  }

  public async fail(input: { obligationId: string; claimId?: string; reason: string }): Promise<DeliveryObligationActionResult> {
    const failed = await query<DeliveryObligationRow>(
      this.pool,
      `UPDATE agent_delivery_obligations
       SET state = 'failed', reason = $3
       WHERE id = $1::uuid AND state IN ('queued', 'claimed')
         AND ($2::text IS NULL OR claim_id = $2)
       RETURNING *`,
      [input.obligationId, input.claimId ?? null, input.reason],
    );
    if (failed.rows[0]) return result("applied", hydrate(failed.rows[0]));
    const current = await this.require(input.obligationId);
    if (current.state === "failed" && current.outcome?.reason === input.reason) return result("idempotent", current);
    return result("not_completable", current);
  }

  public async unknown(input: { obligationId: string; claimId?: string; reason: string }): Promise<DeliveryObligationActionResult> {
    const unknown = await query<DeliveryObligationRow>(
      this.pool,
      `UPDATE agent_delivery_obligations
       SET state = 'unknown', reason = $3
       WHERE id = $1::uuid AND state IN ('queued', 'claimed')
         AND ($2::text IS NULL OR claim_id = $2)
       RETURNING *`,
      [input.obligationId, input.claimId ?? null, input.reason],
    );
    if (unknown.rows[0]) return result("applied", hydrate(unknown.rows[0]));
    const current = await this.require(input.obligationId);
    if (current.state === "unknown" && current.outcome?.reason === input.reason) return result("idempotent", current);
    return result("not_unknown", current);
  }

  public async reconcile(input: { obligationId: string; reconciliationId: string; outcome: "delivered" | "failed"; receiptRef?: string; reason?: string }): Promise<DeliveryObligationActionResult> {
    const reconciled = await query<DeliveryObligationRow>(
      this.pool,
      `UPDATE agent_delivery_obligations
       SET state = $3, reconciliation_id = $2, receipt_ref = $4, reason = $5
       WHERE id = $1::uuid AND state = 'unknown'
       RETURNING *`,
      [input.obligationId, input.reconciliationId, input.outcome, input.receiptRef ?? null, input.reason ?? null],
    );
    if (reconciled.rows[0]) return result("applied", hydrate(reconciled.rows[0]));
    const current = await this.require(input.obligationId);
    if (current.outcome?.reconciliationId === input.reconciliationId) return result("idempotent", current);
    return result(current.state === "delivered" || current.state === "failed" ? "reconciliation_conflict" : "not_reconcilable", current);
  }

  private async require(id: string): Promise<DeliveryObligation> {
    const obligation = await this.get(id);
    if (!obligation) throw new Error(`DELIVERY_OBLIGATION_NOT_FOUND:${id}`);
    return obligation;
  }
}
