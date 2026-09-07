import { describe, expect, it } from "vitest";
import {
  DurableOperationCoordinator,
  InMemoryDurableOperationStore,
} from "../src/operations/durable-operation";
import { DurableSessionOperationCoordinator } from "../src/operations/session-coordination";
import type {
  SessionLeaseAcquireInput,
  SessionLeaseAcquireResult,
  SessionLeaseMutationInput,
  SessionLeaseMutationResult,
  SessionLeaseRecord,
  SessionLeaseRepository,
} from "../src/db/repositories/session-lease-repository";

const input: SessionLeaseAcquireInput = {
  organizationId: "org-1",
  sessionKey: "conversation:install-1:conversation-1",
  ownerId: "agent-run:run-1",
  runId: "run-1",
  leaseDurationMs: 60_000,
};

function fakeLeases(results: {
  current?: Array<SessionLeaseRecord | undefined>;
  acquire: SessionLeaseAcquireResult[];
  heartbeat?: SessionLeaseMutationResult[];
  release?: SessionLeaseMutationResult[];
}): SessionLeaseRepository {
  return {
    current: async () => results.current?.shift(),
    acquire: async () => results.acquire.shift() ?? { outcome: "busy", lease: {} as never },
    heartbeat: async () => results.heartbeat?.shift() ?? { outcome: "renewed", lease: {} as never },
    assertCurrent: async () => ({ outcome: "rejected", reason: "not_found" }),
    release: async () => results.release?.shift() ?? { outcome: "already_released", lease: {} as never },
    releaseForRun: async () => undefined,
  } as unknown as SessionLeaseRepository;
}

describe("durable session operation coordinator", () => {
  it("replays an acquired admission without acquiring the lease twice", async () => {
    const leases = fakeLeases({ acquire: [{ outcome: "acquired", lease: { id: "lease-1" } as never }] });
    const coordinator = new DurableSessionOperationCoordinator(
      new DurableOperationCoordinator(new InMemoryDurableOperationStore()),
      leases,
    );

    const first = await coordinator.acquire(input);
    const second = await coordinator.acquire(input);

    expect(first.outcome).toBe("acquired");
    expect(second).toEqual(first);
  });

  it("keeps a busy admission retryable instead of replaying busy forever", async () => {
    const leases = fakeLeases({
      acquire: [
        { outcome: "busy", lease: { id: "other" } as never },
        { outcome: "acquired", lease: { id: "lease-2" } as never },
      ],
    });
    const coordinator = new DurableSessionOperationCoordinator(
      new DurableOperationCoordinator(new InMemoryDurableOperationStore()),
      leases,
    );

    expect((await coordinator.acquire(input)).outcome).toBe("busy");
    expect((await coordinator.acquire(input)).outcome).toBe("acquired");
  });

  it("starts a new durable admission attempt after the fencing epoch expires", async () => {
    const staleLease = {
      status: "released",
      fencing_token: "1",
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    } as SessionLeaseRecord;
    const leases = fakeLeases({
      current: [undefined, staleLease],
      acquire: [
        { outcome: "acquired", lease: { id: "lease-1" } as never },
        { outcome: "acquired", lease: { id: "lease-2" } as never },
      ],
    });
    const coordinator = new DurableSessionOperationCoordinator(
      new DurableOperationCoordinator(new InMemoryDurableOperationStore()),
      leases,
    );

    await coordinator.acquire(input);
    const second = await coordinator.acquire(input);

    expect(second).toMatchObject({ outcome: "acquired", lease: { id: "lease-2" } });
  });

  it("coordinates heartbeat and release through durable operation records", async () => {
    const mutation: SessionLeaseMutationInput = { ...input, fencingToken: "1" };
    const leases = fakeLeases({
      acquire: [],
      heartbeat: [{ outcome: "renewed", lease: { id: "lease-1" } as never }],
      release: [{ outcome: "released", lease: { id: "lease-1" } as never }],
    });
    const coordinator = new DurableSessionOperationCoordinator(
      new DurableOperationCoordinator(new InMemoryDurableOperationStore()),
      leases,
    );

    expect((await coordinator.heartbeat(mutation)).outcome).toBe("renewed");
    expect((await coordinator.release(mutation)).outcome).toBe("released");
  });
});
