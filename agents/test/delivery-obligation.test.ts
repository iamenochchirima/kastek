import { describe, expect, it, vi } from "vitest";
import { InMemoryDeliveryObligationCoordinator, PostgresDeliveryObligationCoordinator } from "../src/delivery";

function createInput(id = "delivery-1") {
  return {
    id,
    idempotencyKey: "reply-1",
    scope: {
      organizationId: "org-a",
      installationId: "installation-a",
      runId: "run-a",
      conversationId: "conversation-a",
    },
    channel: "web",
    payloadRef: "message:reply-1",
  };
}

describe("delivery obligation foundation", () => {
  it("creates an obligation independently of run completion and deduplicates creation", async () => {
    const coordinator = new InMemoryDeliveryObligationCoordinator();
    const first = await coordinator.create(createInput());
    const replay = await coordinator.create({ ...createInput("delivery-other"), idempotencyKey: "reply-1" });

    expect(first).toMatchObject({ id: "delivery-1", state: "queued", scope: { runId: "run-a" } });
    expect(replay).toEqual(first);
  });

  it("claims once and makes same-claim retries idempotent", async () => {
    const coordinator = new InMemoryDeliveryObligationCoordinator();
    await coordinator.create(createInput());

    await expect(coordinator.claim({ obligationId: "delivery-1", claimId: "claim-a", workerId: "worker-a" }))
      .resolves.toMatchObject({ status: "applied", obligation: { state: "claimed" } });
    await expect(coordinator.claim({ obligationId: "delivery-1", claimId: "claim-a", workerId: "worker-a" }))
      .resolves.toMatchObject({ status: "idempotent", obligation: { state: "claimed" } });
    await expect(coordinator.claim({ obligationId: "delivery-1", claimId: "claim-b", workerId: "worker-b" }))
      .resolves.toMatchObject({ status: "claim_conflict" });
  });

  it("completes with a receipt exactly once", async () => {
    const coordinator = new InMemoryDeliveryObligationCoordinator();
    await coordinator.create(createInput());
    await coordinator.claim({ obligationId: "delivery-1", claimId: "claim-a", workerId: "worker-a" });

    await expect(coordinator.complete({ obligationId: "delivery-1", claimId: "claim-a", receiptRef: "gateway:42" }))
      .resolves.toMatchObject({ status: "applied", obligation: { state: "delivered", outcome: { receiptRef: "gateway:42" } } });
    await expect(coordinator.complete({ obligationId: "delivery-1", claimId: "claim-a", receiptRef: "gateway:42" }))
      .resolves.toMatchObject({ status: "idempotent", obligation: { state: "delivered" } });
  });

  it("records uncertain delivery and reconciles it idempotently", async () => {
    const coordinator = new InMemoryDeliveryObligationCoordinator();
    await coordinator.create(createInput());
    await coordinator.claim({ obligationId: "delivery-1", claimId: "claim-a", workerId: "worker-a" });

    await expect(coordinator.unknown({ obligationId: "delivery-1", claimId: "claim-a", reason: "gateway timeout" }))
      .resolves.toMatchObject({ status: "applied", obligation: { state: "unknown" } });
    await expect(coordinator.reconcile({ obligationId: "delivery-1", reconciliationId: "check-1", outcome: "delivered", receiptRef: "gateway:42" }))
      .resolves.toMatchObject({ status: "applied", obligation: { state: "delivered" } });
    await expect(coordinator.reconcile({ obligationId: "delivery-1", reconciliationId: "check-1", outcome: "delivered", receiptRef: "gateway:42" }))
      .resolves.toMatchObject({ status: "idempotent", obligation: { state: "delivered" } });
  });

  it("records terminal delivery failure separately from an uncertain send", async () => {
    const coordinator = new InMemoryDeliveryObligationCoordinator();
    await coordinator.create(createInput());
    await coordinator.claim({ obligationId: "delivery-1", claimId: "claim-a", workerId: "worker-a" });

    await expect(coordinator.fail({ obligationId: "delivery-1", claimId: "claim-a", reason: "invalid recipient" }))
      .resolves.toMatchObject({ status: "applied", obligation: { state: "failed", outcome: { kind: "failed" } } });
  });

  it("hydrates the PostgreSQL adapter from the durable row shape", async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [{
      id: "11111111-1111-4111-8111-111111111111",
      organization_id: "org-a",
      installation_id: "22222222-2222-4222-8222-222222222222",
      run_id: "33333333-3333-4333-8333-333333333333",
      conversation_id: "44444444-4444-4444-8444-444444444444",
      channel: "web",
      payload_ref: "message-1",
      idempotency_key: "reply-1",
      state: "queued",
      claim_id: null,
      worker_id: null,
      claimed_at: null,
      receipt_ref: null,
      reason: null,
      reconciliation_id: null,
      created_at: "2026-09-07T00:00:00.000Z",
      updated_at: "2026-09-07T00:00:00.000Z",
    }] }) };
    const coordinator = new PostgresDeliveryObligationCoordinator(pool as never);

    await expect(coordinator.create({
      ...createInput("11111111-1111-4111-8111-111111111111"),
      scope: {
        organizationId: "org-a",
        installationId: "22222222-2222-4222-8222-222222222222",
        runId: "33333333-3333-4333-8333-333333333333",
        conversationId: "44444444-4444-4444-8444-444444444444",
      },
      payloadRef: "message-1",
    })).resolves.toMatchObject({ state: "queued", scope: { organizationId: "org-a" } });
  });
});
