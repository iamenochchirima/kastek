import { describe, expect, it } from "vitest";
import { InMemorySessionOwnership } from "../src/runtime/in-memory-session-ownership";
import { createSessionKey, createSessionOwnerId } from "../src/runtime/session-ownership";

function accepted<T>(result: Awaited<ReturnType<InMemorySessionOwnership<T>["admitTurn"]>>) {
  if (result.outcome !== "accepted") throw new Error(`Expected accepted, got ${result.outcome}`);
  return result;
}

describe("session ownership", () => {
  it("accepts the first turn, queues later turns in order, and isolates different sessions", async () => {
    const coordinator = new InMemorySessionOwnership<string>({ leaseTtlMs: 100, now: () => 1_000 });
    const session = createSessionKey("conversation:one");
    const otherSession = createSessionKey("conversation:two");
    const owner = createSessionOwnerId("gateway-a");

    const first = accepted(await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "first" }));
    const second = await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "second" });
    const third = await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "third" });
    const other = accepted(await coordinator.admitTurn({ sessionKey: otherSession, requestedBy: owner, payload: "independent" }));

    expect(first.turn).toMatchObject({ sequence: 1, status: "active", payload: "first", attempts: 1 });
    expect(second).toMatchObject({ outcome: "queued", position: 1, turn: { sequence: 2, status: "queued", payload: "second" } });
    expect(third).toMatchObject({ outcome: "queued", position: 2, turn: { sequence: 3, status: "queued", payload: "third" } });
    expect(other.turn.sessionKey).toBe(otherSession);
    expect(other.lease.fencingToken).not.toBe(first.lease.fencingToken);
  });

  it("renews only the current lease and fences a stale owner after expiry recovery", async () => {
    let now = 1_000;
    const coordinator = new InMemorySessionOwnership<string>({ leaseTtlMs: 100, now: () => now });
    const session = createSessionKey("conversation:lease");
    const firstOwner = createSessionOwnerId("worker-a");
    const recoveryOwner = createSessionOwnerId("worker-b");
    const first = accepted(await coordinator.admitTurn({ sessionKey: session, requestedBy: firstOwner, payload: "in-flight" }));
    const queued = await coordinator.admitTurn({ sessionKey: session, requestedBy: firstOwner, payload: "waiting" });

    now = 1_080;
    const renewed = await coordinator.heartbeat(first.lease);
    expect(renewed).toMatchObject({ outcome: "renewed", lease: { expiresAt: 1_180 } });

    now = 1_181;
    const expired = await coordinator.heartbeat(first.lease);
    expect(expired).toMatchObject({ outcome: "expired", reasonCode: "LEASE_EXPIRED", turnId: first.turn.id });
    const recovered = accepted(await coordinator.claimNext({ sessionKey: session, ownerId: recoveryOwner }));
    expect(recovered.turn.id).toBe(first.turn.id);
    expect(recovered.turn.attempts).toBe(2);
    expect(recovered.lease.fencingToken).not.toBe(first.lease.fencingToken);
    expect(queued).toMatchObject({ outcome: "queued", turn: { payload: "waiting" } });

    await expect(coordinator.settleTurn({ ...first.lease, turnId: first.turn.id, outcome: "completed" })).resolves.toMatchObject({
      outcome: "fenced",
      reasonCode: "LEASE_NOT_CURRENT",
    });
  });

  it("settles and claims queued turns without changing FIFO order", async () => {
    const coordinator = new InMemorySessionOwnership<string>({ leaseTtlMs: 100, now: () => 1_000 });
    const session = createSessionKey("conversation:fifo");
    const submitter = createSessionOwnerId("gateway");
    const worker = createSessionOwnerId("worker");
    const first = accepted(await coordinator.admitTurn({ sessionKey: session, requestedBy: submitter, payload: "one" }));
    const second = await coordinator.admitTurn({ sessionKey: session, requestedBy: submitter, payload: "two" });
    const third = await coordinator.admitTurn({ sessionKey: session, requestedBy: submitter, payload: "three" });

    await expect(coordinator.settleTurn({ ...first.lease, turnId: first.turn.id, outcome: "completed" })).resolves.toMatchObject({
      outcome: "completed",
      turn: { sequence: 1, status: "completed" },
      queueLength: 2,
    });
    const next = accepted(await coordinator.claimNext({ sessionKey: session, ownerId: worker }));
    expect(next.turn).toMatchObject({ sequence: 2, payload: "two", status: "active" });
    await coordinator.settleTurn({ ...next.lease, turnId: next.turn.id, outcome: "failed" });
    const last = accepted(await coordinator.claimNext({ sessionKey: session, ownerId: worker }));
    expect(last.turn).toMatchObject({ sequence: 3, payload: "three", status: "active" });
    expect(second).toMatchObject({ outcome: "queued", position: 1 });
    expect(third).toMatchObject({ outcome: "queued", position: 2 });
  });

  it("requeues an unfinished turn on release and fences the released token", async () => {
    const coordinator = new InMemorySessionOwnership<string>({ leaseTtlMs: 100, now: () => 1_000 });
    const session = createSessionKey("conversation:release");
    const firstOwner = createSessionOwnerId("worker-a");
    const nextOwner = createSessionOwnerId("worker-b");
    const first = accepted(await coordinator.admitTurn({ sessionKey: session, requestedBy: firstOwner, payload: "retry-me" }));

    const released = await coordinator.releaseLease(first.lease);
    expect(released).toMatchObject({ outcome: "released", requeuedTurn: { id: first.turn.id, status: "queued" } });
    const next = accepted(await coordinator.claimNext({ sessionKey: session, ownerId: nextOwner }));
    expect(next.turn.id).toBe(first.turn.id);
    expect(next.lease.ownerId).toBe(nextOwner);
    await expect(coordinator.releaseLease(first.lease)).resolves.toMatchObject({ outcome: "fenced" });
  });

  it("returns typed busy and idempotent outcomes instead of throwing for normal contention", async () => {
    const coordinator = new InMemorySessionOwnership<string>({ leaseTtlMs: 100, now: () => 1_000 });
    const session = createSessionKey("conversation:typed");
    const owner = createSessionOwnerId("worker");
    const first = accepted(await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "one", turnId: undefined }));
    const busy = await coordinator.claimNext({ sessionKey: session, ownerId: createSessionOwnerId("other") });
    const duplicate = await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "one", turnId: first.turn.id });
    const reused = await coordinator.admitTurn({ sessionKey: session, requestedBy: createSessionOwnerId("other"), payload: "spoofed", turnId: first.turn.id });

    expect(busy).toMatchObject({ outcome: "busy", reasonCode: "SESSION_BUSY", activeOwner: owner });
    expect(duplicate).toMatchObject({ outcome: "accepted", turn: { id: first.turn.id }, lease: { fencingToken: first.lease.fencingToken } });
    expect(reused).toMatchObject({ outcome: "rejected", reasonCode: "TURN_ID_REUSED" });
  });

  it("limits new admissions at the configured queue depth without breaking idempotent retries", async () => {
    const coordinator = new InMemorySessionOwnership<string>({
      leaseTtlMs: 100,
      now: () => 1_000,
      queuePolicy: { maxDepth: 1 },
    });
    const session = createSessionKey("conversation:depth-limit");
    const owner = createSessionOwnerId("gateway");
    const first = accepted(await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "first" }));
    const queued = await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "second" });
    const limited = await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "third" });
    const retry = await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "second-retry", turnId: queued.outcome === "queued" ? queued.turn.id : undefined });

    expect(first.outcome).toBe("accepted");
    expect(queued).toMatchObject({ outcome: "queued", queueLength: 1, queueMetrics: { queueDepth: 1 } });
    expect(limited).toMatchObject({
      outcome: "limited",
      reasonCode: "QUEUE_DEPTH_LIMIT",
      queueLength: 1,
      queueMetrics: { queueDepth: 1 },
    });
    expect(retry).toMatchObject({ outcome: "queued", turn: { id: queued.outcome === "queued" ? queued.turn.id : "" } });
  });

  it("limits new admissions when the oldest queued turn exceeds the age policy", async () => {
    let now = 1_000;
    const observations: Array<{ outcome: string; metrics: { queueDepth?: number; queueAgeMs?: number } }> = [];
    const coordinator = new InMemorySessionOwnership<string>({
      leaseTtlMs: 100,
      now: () => now,
      queuePolicy: { maxAgeMs: 50 },
      onQueueObservation: (event) => observations.push({ outcome: event.outcome, metrics: event.metrics }),
    });
    const session = createSessionKey("conversation:age-limit");
    const owner = createSessionOwnerId("gateway");

    await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "first" });
    await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "waiting" });
    now = 1_050;
    const limited = await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "too-late" });
    const snapshot = await coordinator.inspect(session);

    expect(limited).toMatchObject({ outcome: "limited", reasonCode: "QUEUE_AGE_LIMIT", queueMetrics: { queueDepth: 1, queueAgeMs: 50 } });
    expect(snapshot?.queueMetrics).toMatchObject({ queueDepth: 1, queueAgeMs: 50, staleOwnerCount: 0 });
    expect(observations.at(-1)).toMatchObject({ outcome: "limited", metrics: { queueDepth: 1, queueAgeMs: 50 } });
  });

  it("records stale-owner reaping in queue metrics and observations", async () => {
    let now = 1_000;
    const observations: Array<{ event: string; reasonCode?: string; metrics: { queueDepth?: number; staleOwnerCount: number } }> = [];
    const coordinator = new InMemorySessionOwnership<string>({
      leaseTtlMs: 100,
      now: () => now,
      onQueueObservation: (event) => observations.push({ event: event.event, reasonCode: event.reasonCode, metrics: event.metrics }),
    });
    const session = createSessionKey("conversation:stale-owner");
    const owner = createSessionOwnerId("worker-a");
    const first = accepted(await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "in-flight" }));
    await coordinator.admitTurn({ sessionKey: session, requestedBy: owner, payload: "waiting" });

    now = 1_101;
    const snapshot = await coordinator.inspect(session);

    expect(snapshot?.queueMetrics).toMatchObject({ queueDepth: 2, queueAgeMs: 101, staleOwnerCount: 1 });
    expect(observations).toContainEqual(expect.objectContaining({
      event: "lease_expired",
      reasonCode: "STALE_OWNER_REAPED",
      metrics: expect.objectContaining({ queueDepth: 2, staleOwnerCount: 1 }),
    }));
    expect((await coordinator.claimNext({ sessionKey: session, ownerId: createSessionOwnerId("worker-b") }))).toMatchObject({
      outcome: "accepted",
      turn: { id: first.turn.id },
      queueMetrics: { queueDepth: 1, staleOwnerCount: 1 },
    });
  });
});
