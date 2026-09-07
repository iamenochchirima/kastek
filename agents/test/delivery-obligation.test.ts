import { describe, expect, it } from "vitest";
import { InMemoryDeliveryObligationCoordinator } from "../src/delivery";

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
});
