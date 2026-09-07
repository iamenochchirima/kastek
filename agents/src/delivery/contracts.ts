import { z } from "zod";

const identifier = z.string().trim().min(1).max(240);

/**
 * Delivery is an external obligation, not a property of agent-run completion.
 * A run may complete while one or more obligations remain claimed, unknown, or
 * awaiting reconciliation.
 */
export type DeliveryObligationState = "queued" | "claimed" | "delivered" | "failed" | "unknown" | "cancelled";

export interface DeliveryObligationScope {
  readonly organizationId: string;
  readonly installationId: string;
  readonly runId?: string;
  readonly conversationId?: string;
  readonly correlationId?: string;
}

export interface DeliveryObligation {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly scope: DeliveryObligationScope;
  readonly channel: string;
  /** A durable reference only; channel payload is owned by the delivery adapter. */
  readonly payloadRef: string;
  readonly state: DeliveryObligationState;
  readonly claim?: DeliveryClaim;
  readonly outcome?: DeliveryOutcome;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryClaim {
  readonly claimId: string;
  readonly workerId: string;
  readonly claimedAt: string;
}

export interface DeliveryOutcome {
  readonly kind: "delivered" | "failed" | "unknown";
  readonly recordedAt: string;
  readonly receiptRef?: string;
  readonly reason?: string;
  readonly reconciliationId?: string;
}

export const createDeliveryObligationSchema = z.object({
  id: identifier,
  idempotencyKey: identifier,
  scope: z.object({
    organizationId: identifier,
    installationId: identifier,
    runId: identifier.optional(),
    conversationId: identifier.optional(),
    correlationId: identifier.optional(),
  }).strict(),
  channel: identifier,
  payloadRef: identifier,
}).strict();

export type CreateDeliveryObligation = z.infer<typeof createDeliveryObligationSchema>;

export type DeliveryObligationActionResult =
  | { readonly status: "applied"; readonly obligation: DeliveryObligation }
  | { readonly status: "idempotent"; readonly obligation: DeliveryObligation }
  | { readonly status: "not_claimable" | "claim_conflict" | "not_completable" | "not_unknown" | "not_reconcilable" | "reconciliation_conflict"; readonly obligation: DeliveryObligation };

/**
 * The delivery-obligation seam. This deliberately has no run-state methods:
 * callers can durably manage delivery after the originating run has ended.
 */
export interface DeliveryObligationCoordinator {
  create(input: CreateDeliveryObligation): Promise<DeliveryObligation>;
  get(id: string): Promise<DeliveryObligation | undefined>;
  claim(input: { obligationId: string; claimId: string; workerId: string }): Promise<DeliveryObligationActionResult>;
  complete(input: { obligationId: string; claimId: string; receiptRef: string }): Promise<DeliveryObligationActionResult>;
  unknown(input: { obligationId: string; claimId?: string; reason: string }): Promise<DeliveryObligationActionResult>;
  reconcile(input: { obligationId: string; reconciliationId: string; outcome: "delivered" | "failed"; receiptRef?: string; reason?: string }): Promise<DeliveryObligationActionResult>;
}
