import {
  createDeliveryObligationSchema,
  type CreateDeliveryObligation,
  type DeliveryClaim,
  type DeliveryObligation,
  type DeliveryObligationActionResult,
  type DeliveryObligationCoordinator,
  type DeliveryOutcome,
} from "./contracts";

type MutableDeliveryObligation = DeliveryObligation;

/**
 * Process-local conformance adapter. It keeps transition and idempotency rules
 * in one place so durable adapters can be tested against the same interface.
 */
export class InMemoryDeliveryObligationCoordinator implements DeliveryObligationCoordinator {
  private readonly obligations = new Map<string, MutableDeliveryObligation>();
  private readonly idempotency = new Map<string, string>();

  async create(input: CreateDeliveryObligation): Promise<DeliveryObligation> {
    const parsed = createDeliveryObligationSchema.parse(input);
    const key = `${parsed.scope.organizationId}:${parsed.scope.installationId}:${parsed.idempotencyKey}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.obligations.get(existingId);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const obligation: DeliveryObligation = {
      ...parsed,
      state: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.obligations.set(obligation.id, obligation);
    this.idempotency.set(key, obligation.id);
    return obligation;
  }

  async get(id: string): Promise<DeliveryObligation | undefined> {
    return this.obligations.get(id);
  }

  async claim(input: { obligationId: string; claimId: string; workerId: string }): Promise<DeliveryObligationActionResult> {
    const obligation = this.require(input.obligationId);
    if (obligation.state === "claimed" && obligation.claim?.claimId === input.claimId && obligation.claim.workerId === input.workerId) {
      return this.idempotent(obligation);
    }
    if (obligation.state === "claimed") return this.result("claim_conflict", obligation);
    if (obligation.state !== "queued") return this.result("not_claimable", obligation);
    const claim: DeliveryClaim = { claimId: input.claimId, workerId: input.workerId, claimedAt: new Date().toISOString() };
    return this.applied(this.replace(obligation, { state: "claimed", claim }));
  }

  async complete(input: { obligationId: string; claimId: string; receiptRef: string }): Promise<DeliveryObligationActionResult> {
    const obligation = this.require(input.obligationId);
    if (obligation.state === "delivered" && obligation.claim?.claimId === input.claimId && obligation.outcome?.receiptRef === input.receiptRef) {
      return this.idempotent(obligation);
    }
    if (obligation.state !== "claimed" || obligation.claim?.claimId !== input.claimId) return this.result("not_completable", obligation);
    const outcome: DeliveryOutcome = { kind: "delivered", receiptRef: input.receiptRef, recordedAt: new Date().toISOString() };
    return this.applied(this.replace(obligation, { state: "delivered", outcome }));
  }

  async fail(input: { obligationId: string; claimId?: string; reason: string }): Promise<DeliveryObligationActionResult> {
    const obligation = this.require(input.obligationId);
    if (obligation.state === "failed" && obligation.outcome?.reason === input.reason) return this.idempotent(obligation);
    if (obligation.state !== "queued" && obligation.state !== "claimed") return this.result("not_completable", obligation);
    if (obligation.state === "claimed" && obligation.claim?.claimId !== input.claimId) return this.result("not_completable", obligation);
    const outcome: DeliveryOutcome = { kind: "failed", reason: input.reason, recordedAt: new Date().toISOString() };
    return this.applied(this.replace(obligation, { state: "failed", outcome }));
  }

  async unknown(input: { obligationId: string; claimId?: string; reason: string }): Promise<DeliveryObligationActionResult> {
    const obligation = this.require(input.obligationId);
    if (obligation.state === "unknown" && obligation.outcome?.reason === input.reason) return this.idempotent(obligation);
    if (obligation.state !== "queued" && (obligation.state !== "claimed" || obligation.claim?.claimId !== input.claimId)) {
      return this.result("not_unknown", obligation);
    }
    const outcome: DeliveryOutcome = { kind: "unknown", reason: input.reason, recordedAt: new Date().toISOString() };
    return this.applied(this.replace(obligation, { state: "unknown", outcome }));
  }

  async reconcile(input: { obligationId: string; reconciliationId: string; outcome: "delivered" | "failed"; receiptRef?: string; reason?: string }): Promise<DeliveryObligationActionResult> {
    const obligation = this.require(input.obligationId);
    if (obligation.outcome?.reconciliationId === input.reconciliationId) return this.idempotent(obligation);
    if (obligation.state !== "unknown") {
      return this.result(obligation.state === "delivered" || obligation.state === "failed" ? "reconciliation_conflict" : "not_reconcilable", obligation);
    }
    const outcome: DeliveryOutcome = {
      kind: input.outcome,
      ...(input.receiptRef ? { receiptRef: input.receiptRef } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      reconciliationId: input.reconciliationId,
      recordedAt: new Date().toISOString(),
    };
    return this.applied(this.replace(obligation, { state: input.outcome, outcome }));
  }

  private require(id: string): MutableDeliveryObligation {
    const obligation = this.obligations.get(id);
    if (!obligation) throw new Error(`DELIVERY_OBLIGATION_NOT_FOUND:${id}`);
    return obligation;
  }

  private replace(obligation: MutableDeliveryObligation, update: Partial<DeliveryObligation>): DeliveryObligation {
    const next: DeliveryObligation = { ...obligation, ...update, updatedAt: new Date().toISOString() };
    this.obligations.set(next.id, next);
    return next;
  }

  private applied(obligation: DeliveryObligation): DeliveryObligationActionResult {
    return { status: "applied", obligation };
  }

  private idempotent(obligation: DeliveryObligation): DeliveryObligationActionResult {
    return { status: "idempotent", obligation };
  }

  private result(status: Exclude<DeliveryObligationActionResult["status"], "applied" | "idempotent">, obligation: DeliveryObligation): DeliveryObligationActionResult {
    return { status, obligation } as DeliveryObligationActionResult;
  }
}
