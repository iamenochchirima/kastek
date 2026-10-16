import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { SessionLeaseRepository, type SessionLeaseRecord } from "../src/db/repositories/session-lease-repository";

const baseLease: SessionLeaseRecord = {
  id: "lease-1",
  organization_id: "org-1",
  session_key: "conversation:1",
  owner_id: "worker-1",
  run_id: "run-1",
  status: "active",
  fencing_token: "1",
  acquired_at: "2026-09-07T10:00:00.000Z",
  heartbeat_at: "2026-09-07T10:00:00.000Z",
  expires_at: "2026-09-07T10:01:00.000Z",
  released_at: null,
  created_at: "2026-09-07T10:00:00.000Z",
  updated_at: "2026-09-07T10:00:00.000Z",
};

function transactionalPool(rows: SessionLeaseRecord[], options: { insert?: SessionLeaseRecord; update?: SessionLeaseRecord } = {}) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT *, (status = 'active'")) return { rows: rows.map((row) => ({ ...row, is_currently_active: row.status === "active" })) };
    if (sql.includes("INSERT INTO agent_session_leases")) return { rows: options.insert ? [options.insert] : [] };
    if (sql.includes("UPDATE agent_session_leases") && sql.includes("fencing_token = CASE")) return { rows: options.update ? [options.update] : [] };
    if (sql.includes("UPDATE agent_session_leases") && sql.includes("heartbeat_at")) return { rows: options.update ? [options.update] : [] };
    if (sql.includes("UPDATE agent_session_leases") && sql.includes("status = 'released'")) return { rows: options.update ? [options.update] : [] };
    if (sql.includes("SELECT *") && sql.includes("FROM agent_session_leases")) return { rows };
    throw new Error(`Unexpected query: ${sql}`);
  });
  const client = { query: clientQuery, release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client) }, clientQuery };
}

describe("SessionLeaseRepository", () => {
  it("creates the first lease and uses an organization/session uniqueness guard", async () => {
    const created = { ...baseLease };
    const { pool, clientQuery } = transactionalPool([], { insert: created });
    const repository = new SessionLeaseRepository(pool as never);

    const result = await repository.acquire({
      organizationId: "org-1",
      sessionKey: " conversation:1 ",
      ownerId: "worker-1",
      runId: "run-1",
      leaseDurationMs: 30_000,
    });

    expect(result).toEqual({ outcome: "acquired", lease: created });
    const insert = clientQuery.mock.calls.find(([sql]) => sql.includes("INSERT INTO agent_session_leases"));
    expect(insert?.[0]).toContain("ON CONFLICT (organization_id, session_key) DO NOTHING");
    expect(insert?.[1]).toEqual(["org-1", "conversation:1", "worker-1", "run-1", 30_000]);
  });

  it("does not steal a live lease held by another run", async () => {
    const { pool, clientQuery } = transactionalPool([{ ...baseLease, owner_id: "worker-2", run_id: "run-2" }]);
    const repository = new SessionLeaseRepository(pool as never);

    const result = await repository.acquire({
      organizationId: "org-1",
      sessionKey: "conversation:1",
      ownerId: "worker-1",
      runId: "run-1",
      leaseDurationMs: 30_000,
    });

    expect(result).toMatchObject({ outcome: "busy", lease: { owner_id: "worker-2", run_id: "run-2", fencing_token: "1" } });
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("fencing_token = CASE"))).toBe(false);
  });

  it("renews and releases only with the current fencing identity", async () => {
    const renewed = { ...baseLease, heartbeat_at: "2026-09-07T10:00:30.000Z", expires_at: "2026-09-07T10:01:30.000Z" };
    const { pool, clientQuery } = transactionalPool([baseLease], { update: renewed });
    const repository = new SessionLeaseRepository(pool as never);

    const heartbeat = await repository.heartbeat({
      organizationId: "org-1",
      sessionKey: "conversation:1",
      ownerId: "worker-1",
      runId: "run-1",
      fencingToken: "1",
      leaseDurationMs: 60_000,
    });
    expect(heartbeat).toEqual({ outcome: "renewed", lease: renewed });
    expect(clientQuery.mock.calls.find(([sql]) => sql.includes("heartbeat_at"))?.[0]).toContain("fencing_token = $5::bigint");

    const released = { ...renewed, status: "released" as const, released_at: "2026-09-07T10:00:31.000Z" };
    const releasePool = transactionalPool([renewed], { update: released });
    const releaseResult = await new SessionLeaseRepository(releasePool.pool as never).release({
      organizationId: "org-1",
      sessionKey: "conversation:1",
      ownerId: "worker-1",
      runId: "run-1",
      fencingToken: "1",
    });
    expect(releaseResult).toEqual({ outcome: "released", lease: released });
  });

  it("keeps fencing monotonic when reacquiring an expired or released row", async () => {
    const stale = { ...baseLease, status: "released" as const, fencing_token: "7", released_at: "2026-09-07T10:00:00.000Z" };
    const reacquired = { ...stale, owner_id: "worker-3", run_id: "run-3", status: "active" as const, fencing_token: "8", released_at: null };
    const { pool, clientQuery } = transactionalPool([stale], { update: reacquired });
    const repository = new SessionLeaseRepository(pool as never);

    const result = await repository.acquire({
      organizationId: "org-1",
      sessionKey: "conversation:1",
      ownerId: "worker-3",
      runId: "run-3",
      leaseDurationMs: 30_000,
    });

    expect(result).toEqual({ outcome: "acquired", lease: reacquired });
    const update = clientQuery.mock.calls.find(([sql]) => sql.includes("fencing_token = CASE"));
    expect(update?.[0]).toContain("fencing_token + 1");
    expect(update?.[1]).toEqual(["org-1", "conversation:1", "worker-3", "run-3", false, 30_000]);
  });

  it("records the migration contract for tenant scope, fencing, and RLS", async () => {
    const sql = await readFile(new URL("../migrations/116_agent_session_leases.sql", import.meta.url), "utf8");
    expect(sql).toContain("UNIQUE (organization_id, session_key)");
    expect(sql).toContain("fencing_token BIGINT");
    expect(sql).toContain("kasitek_validate_run_child_scope");
    expect(sql).toContain("ALTER TABLE agent_session_leases FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE ON agent_session_leases TO kasitek_agents_runtime");
  });
});
