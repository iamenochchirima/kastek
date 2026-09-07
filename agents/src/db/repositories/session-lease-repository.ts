import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../pool";

const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1000;

export type SessionLeaseStatus = "active" | "released";

export interface SessionLeaseRecord {
  id: string;
  organization_id: string;
  session_key: string;
  owner_id: string;
  run_id: string;
  status: SessionLeaseStatus;
  fencing_token: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionLeaseAcquireInput {
  organizationId: string;
  sessionKey: string;
  ownerId: string;
  runId: string;
  leaseDurationMs: number;
}

export interface SessionLeaseMutationInput {
  organizationId: string;
  sessionKey: string;
  ownerId: string;
  runId: string;
  fencingToken: string | number | bigint;
  leaseDurationMs?: number;
}

export type SessionLeaseAcquireResult =
  | { outcome: "acquired"; lease: SessionLeaseRecord }
  | { outcome: "busy"; lease: SessionLeaseRecord };

export type SessionLeaseMutationResult =
  | { outcome: "renewed"; lease: SessionLeaseRecord }
  | { outcome: "released"; lease: SessionLeaseRecord }
  | { outcome: "already_released"; lease: SessionLeaseRecord }
  | { outcome: "rejected"; reason: "not_found" | "fenced" | "expired" | "released" };

export type SessionLeaseCurrentResult =
  | { outcome: "current"; lease: SessionLeaseRecord }
  | { outcome: "rejected"; reason: "not_found" | "fenced" | "expired" | "released" };

type SessionLeaseRow = {
  id: string;
  organization_id: string;
  session_key: string;
  owner_id: string;
  run_id: string;
  status: SessionLeaseStatus;
  fencing_token: string | number | bigint;
  acquired_at: Date | string;
  heartbeat_at: Date | string;
  expires_at: Date | string;
  released_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type SessionLeaseStateRow = SessionLeaseRow & {
  is_currently_active?: boolean;
  is_currently_expired?: boolean;
};

type SessionLeaseExecutor = Pick<PoolClient, "query">;

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`SESSION_LEASE_${name.toUpperCase()}_REQUIRED`);
  return normalized;
}

function validateDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LEASE_DURATION_MS) {
    throw new Error("SESSION_LEASE_DURATION_INVALID");
  }
  return value;
}

function normalizeFencingToken(value: string | number | bigint): string {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^[1-9][0-9]*$/.test(normalized)) throw new Error("SESSION_LEASE_FENCING_TOKEN_INVALID");
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("SESSION_LEASE_FENCING_TOKEN_INVALID");
  return normalized;
}

function normalizeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapLease(row: SessionLeaseRow): SessionLeaseRecord {
  return {
    id: row.id,
    organization_id: row.organization_id,
    session_key: row.session_key,
    owner_id: row.owner_id,
    run_id: row.run_id,
    status: row.status,
    fencing_token: String(row.fencing_token),
    acquired_at: normalizeTimestamp(row.acquired_at),
    heartbeat_at: normalizeTimestamp(row.heartbeat_at),
    expires_at: normalizeTimestamp(row.expires_at),
    released_at: row.released_at === null ? null : normalizeTimestamp(row.released_at),
    created_at: normalizeTimestamp(row.created_at),
    updated_at: normalizeTimestamp(row.updated_at),
  };
}

function scope(input: SessionLeaseAcquireInput | SessionLeaseMutationInput): [string, string, string, string] {
  return [
    requiredText(input.organizationId, "ORGANIZATION_ID"),
    requiredText(input.sessionKey, "SESSION_KEY"),
    requiredText(input.ownerId, "OWNER_ID"),
    requiredText(input.runId, "RUN_ID"),
  ];
}

async function selectLease(client: PoolClient, organizationId: string, sessionKey: string): Promise<SessionLeaseStateRow | undefined> {
  const result = await client.query<SessionLeaseStateRow>(
    `SELECT *, (status = 'active' AND expires_at > now()) AS is_currently_active
     FROM agent_session_leases
     WHERE organization_id = $1 AND session_key = $2
     FOR UPDATE`,
    [organizationId, sessionKey],
  );
  return result.rows[0];
}

export class SessionLeaseRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * Acquire the one lease for an organization/session pair. A live lease held
   * by another owner is returned as busy. Reacquisition after expiry or release
   * increments the fencing token; renewal by the same live owner keeps it.
   */
  public async acquire(input: SessionLeaseAcquireInput): Promise<SessionLeaseAcquireResult> {
    const [organizationId, sessionKey, ownerId, runId] = scope(input);
    const leaseDurationMs = validateDuration(input.leaseDurationMs);

    return withTransaction(this.pool, async (client) => {
      let current = await selectLease(client, organizationId, sessionKey);
      if (!current) {
        const inserted = await client.query<SessionLeaseRow>(
          `INSERT INTO agent_session_leases
             (organization_id, session_key, owner_id, run_id, expires_at)
           VALUES ($1, $2, $3, $4, now() + ($5::double precision * interval '1 millisecond'))
           ON CONFLICT (organization_id, session_key) DO NOTHING
           RETURNING *`,
          [organizationId, sessionKey, ownerId, runId, leaseDurationMs],
        );
        if (inserted.rows[0]) return { outcome: "acquired", lease: mapLease(inserted.rows[0]) };
        current = await selectLease(client, organizationId, sessionKey);
      }

      if (!current) throw new Error("SESSION_LEASE_ACQUIRE_RACE");
      const ownsLiveLease = current.is_currently_active === true
        && current.owner_id === ownerId
        && current.run_id === runId;
      if (current.is_currently_active === true && !ownsLiveLease) {
        return { outcome: "busy", lease: mapLease(current) };
      }

      const updated = await client.query<SessionLeaseRow>(
        `UPDATE agent_session_leases
         SET owner_id = $3,
             run_id = $4,
             status = 'active',
             fencing_token = CASE WHEN $5 THEN fencing_token ELSE fencing_token + 1 END,
             acquired_at = CASE WHEN $5 THEN acquired_at ELSE now() END,
             heartbeat_at = now(),
             expires_at = now() + ($6::double precision * interval '1 millisecond'),
             released_at = NULL,
             updated_at = now()
         WHERE organization_id = $1 AND session_key = $2
         RETURNING *`,
        [organizationId, sessionKey, ownerId, runId, ownsLiveLease, leaseDurationMs],
      );
      const lease = updated.rows[0];
      if (!lease) throw new Error("SESSION_LEASE_ACQUIRE_FAILED");
      return { outcome: "acquired", lease: mapLease(lease) };
    });
  }

  /** Renew only the current, unexpired lease identified by its fencing token. */
  public async heartbeat(input: SessionLeaseMutationInput): Promise<SessionLeaseMutationResult> {
    const [organizationId, sessionKey, ownerId, runId] = scope(input);
    const fencingToken = normalizeFencingToken(input.fencingToken);
    const leaseDurationMs = validateDuration(input.leaseDurationMs ?? 30_000);

    return withTransaction(this.pool, async (client) => {
      const renewed = await client.query<SessionLeaseRow>(
        `UPDATE agent_session_leases
         SET heartbeat_at = now(),
             expires_at = now() + ($6::double precision * interval '1 millisecond'),
             updated_at = now()
         WHERE organization_id = $1
           AND session_key = $2
           AND owner_id = $3
           AND run_id = $4
           AND fencing_token = $5::bigint
           AND status = 'active'
           AND expires_at > now()
         RETURNING *`,
        [organizationId, sessionKey, ownerId, runId, fencingToken, leaseDurationMs],
      );
      if (renewed.rows[0]) return { outcome: "renewed", lease: mapLease(renewed.rows[0]) };
      return { outcome: "rejected", reason: await this.mutationRejection(client, organizationId, sessionKey, ownerId, runId, fencingToken) };
    });
  }

  /**
   * Check the lease immediately before a session-owned write. This is the
   * fencing assertion that prevents a worker which resumed after expiry from
   * publishing a stale result.
   */
  public async assertCurrent(input: SessionLeaseMutationInput): Promise<SessionLeaseCurrentResult> {
    const [organizationId, sessionKey, ownerId, runId] = scope(input);
    const fencingToken = normalizeFencingToken(input.fencingToken);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<SessionLeaseRow>(
        `SELECT * FROM agent_session_leases
         WHERE organization_id = $1 AND session_key = $2
         FOR UPDATE`,
        [organizationId, sessionKey],
      );
      const row = result.rows[0];
      if (!row) return { outcome: "rejected", reason: "not_found" };
      if (row.owner_id !== ownerId || row.run_id !== runId || String(row.fencing_token) !== fencingToken) {
        return { outcome: "rejected", reason: "fenced" };
      }
      if (row.status === "released") return { outcome: "rejected", reason: "released" };
      if (new Date(row.expires_at).getTime() <= Date.now()) return { outcome: "rejected", reason: "expired" };
      return { outcome: "current", lease: mapLease(row) };
    });
  }

  /** Release only the lease that still carries the caller's fencing token. */
  public async release(input: SessionLeaseMutationInput): Promise<SessionLeaseMutationResult> {
    const [organizationId, sessionKey, ownerId, runId] = scope(input);
    const fencingToken = normalizeFencingToken(input.fencingToken);

    return withTransaction(this.pool, async (client) => {
      const released = await client.query<SessionLeaseRow>(
        `UPDATE agent_session_leases
         SET status = 'released',
             released_at = now(),
             expires_at = now(),
             updated_at = now()
         WHERE organization_id = $1
           AND session_key = $2
           AND owner_id = $3
           AND run_id = $4
           AND fencing_token = $5::bigint
           AND status = 'active'
         RETURNING *`,
        [organizationId, sessionKey, ownerId, runId, fencingToken],
      );
      if (released.rows[0]) return { outcome: "released", lease: mapLease(released.rows[0]) };

      const current = await client.query<SessionLeaseRow>(
        `SELECT *
         FROM agent_session_leases
         WHERE organization_id = $1 AND session_key = $2
         FOR UPDATE`,
        [organizationId, sessionKey],
      );
      const lease = current.rows[0];
      if (lease && lease.owner_id === ownerId && lease.run_id === runId && String(lease.fencing_token) === fencingToken && lease.status === "released") {
        return { outcome: "already_released", lease: mapLease(lease) };
      }
      return { outcome: "rejected", reason: await this.mutationRejection(client, organizationId, sessionKey, ownerId, runId, fencingToken) };
    });
  }

  /** Release a run-owned lease inside an existing repository transaction. */
  public async releaseForRun(executor: SessionLeaseExecutor, organizationId: string, runId: string): Promise<void> {
    await executor.query(
      `UPDATE agent_session_leases
       SET status = 'released',
           released_at = now(),
           expires_at = now(),
           updated_at = now()
       WHERE organization_id = $1 AND run_id = $2 AND status = 'active'`,
      [requiredText(organizationId, "ORGANIZATION_ID"), requiredText(runId, "RUN_ID")],
    );
  }

  private async mutationRejection(
    client: PoolClient,
    organizationId: string,
    sessionKey: string,
    ownerId: string,
    runId: string,
    fencingToken: string,
  ): Promise<"not_found" | "fenced" | "expired" | "released"> {
    const result = await client.query<SessionLeaseStateRow>(
      `SELECT *, (expires_at <= now()) AS is_currently_expired
       FROM agent_session_leases
       WHERE organization_id = $1 AND session_key = $2
       FOR UPDATE`,
      [organizationId, sessionKey],
    );
    const current = result.rows[0];
    if (!current) return "not_found";
    if (current.owner_id !== ownerId || current.run_id !== runId || String(current.fencing_token) !== fencingToken) return "fenced";
    if (current.status === "released") return "released";
    return current.is_currently_expired === true ? "expired" : "fenced";
  }
}
