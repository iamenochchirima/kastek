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
});
