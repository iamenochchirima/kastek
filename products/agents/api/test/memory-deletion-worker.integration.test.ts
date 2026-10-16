import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryDeletionJobRepository } from "../src/db/repositories/memory-deletion-job-repository";
import { MemoryDeletionWorker } from "../src/memory/deletion-worker";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("memory deletion worker (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const jobs = new MemoryDeletionJobRepository(pool);
  const organizationId = `memory-deletion-${randomUUID()}`;
  const actorId = "memory-deletion-test";
  const jobIds: string[] = [];

  it("claims due work concurrently, retries each lease, and completes it idempotently", async () => {
    const targetA = randomUUID();
    const targetB = randomUUID();
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO memory_deletion_jobs (organization_id, requested_by, target_type, target_id, status, next_attempt_at)
       VALUES ($1, $2, 'memory', $3, 'queued', now()), ($1, $2, 'memory', $4, 'queued', now())
       RETURNING id::text`,
      [organizationId, actorId, targetA, targetB],
    );
    jobIds.push(...inserted.rows.map((row) => row.id));

    const [first, second] = await Promise.all([
      jobs.claimDue("deletion-a", 1, 120_000, organizationId),
      jobs.claimDue("deletion-b", 1, 120_000, organizationId),
    ]);
    expect(first.length + second.length).toBe(2);
    const claimed = first[0] ?? second[0];
    const otherClaimed = first[0]?.id === claimed?.id ? second[0] : first[0];
    expect(claimed?.status).toBe("running");
    expect(otherClaimed?.status).toBe("running");
    expect(new Set([claimed?.lease_owner, otherClaimed?.lease_owner]).size).toBe(2);
    expect(claimed?.attempt_count).toBe(1);
    expect(otherClaimed?.attempt_count).toBe(1);

    await expect(jobs.markRetryable({
      jobId: claimed!.id,
      workerId: claimed!.lease_owner!,
      error: { code: "TEST_RETRY", message: "bounded" },
      maxAttempts: 3,
      retryAfterMs: 1_000,
    })).resolves.toBe("queued");
    await expect(jobs.markCompleted({
      jobId: otherClaimed!.id,
      workerId: otherClaimed!.lease_owner!,
      counts: { memoryCount: 0, conversationCount: 0, knowledgeChunkCount: 0 },
    })).resolves.toBe(true);
    await pool.query("UPDATE memory_deletion_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [claimed!.id]);

    const reclaimed = await jobs.claimDue("deletion-c", 1, 120_000, organizationId);
    expect(reclaimed).toHaveLength(1);
    await expect(jobs.markCompleted({
      jobId: reclaimed[0]!.id,
      workerId: "deletion-c",
      counts: { memoryCount: 0, conversationCount: 0, knowledgeChunkCount: 0 },
    })).resolves.toBe(true);
    await expect(jobs.markCompleted({
      jobId: reclaimed[0]!.id,
      workerId: "deletion-c",
      counts: { memoryCount: 0, conversationCount: 0, knowledgeChunkCount: 0 },
    })).resolves.toBe(false);

    const workerJob = await pool.query<{ id: string }>(
      `INSERT INTO memory_deletion_jobs (organization_id, requested_by, target_type, target_id, status, next_attempt_at)
       VALUES ($1, $2, 'memory', $3, 'queued', now()) RETURNING id::text`,
      [organizationId, actorId, randomUUID()],
    );
    jobIds.push(workerJob.rows[0]!.id);
    const worker = new MemoryDeletionWorker(pool, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      retryMaxDelayMs: 10_000,
      holdRetryMs: 60_000,
    }, { workerId: "deletion-worker-test" });
    await expect(worker.runOnce(organizationId)).resolves.toBe(1);
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE id = $1", [workerJob.rows[0]!.id])).rows[0]?.status).toBe("completed");
  });

  it("does not claim held work while an organization legal hold is active", async () => {
    const holdId = randomUUID();
    const job = await pool.query<{ id: string }>(
      `INSERT INTO memory_deletion_jobs (organization_id, requested_by, target_type, target_id, status, next_attempt_at)
       VALUES ($1, $2, 'organization', $1, 'held', now()) RETURNING id::text`,
      [organizationId, actorId],
    );
    jobIds.push(job.rows[0]!.id);
    await pool.query(
      `INSERT INTO agent_legal_holds (id, organization_id, scope_type, scope_id, reason, created_by)
       VALUES ($1, $2, 'organization', $2, 'preserve deletion test', $3)`,
      [holdId, organizationId, actorId],
    );
    try {
      await expect(jobs.claimDue("deletion-held", 10, 120_000, organizationId)).resolves.toHaveLength(0);
    } finally {
      await pool.query("DELETE FROM agent_legal_holds WHERE id = $1", [holdId]);
    }
  });

  afterAll(async () => {
    await pool.query("DELETE FROM memory_deletion_jobs WHERE id = ANY($1::uuid[])", [jobIds]);
    await pool.end();
  });
});
