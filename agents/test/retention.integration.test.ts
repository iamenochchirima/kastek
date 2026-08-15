import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { RetentionRepository } from "../src/db/repositories/retention-repository";
import { createOperatorCommand, approveOperatorCommand } from "../src/http/operator-commands";
import { KillSwitchRepository } from "../src/db/repositories/kill-switch-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("retention and legal-hold controls (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const retention = new RetentionRepository(pool);
  const killSwitches = new KillSwitchRepository(pool);
  const organizationId = `retention-${randomUUID()}`;
  const actorId = `retention-operator-${randomUUID()}`;
  const secondActorId = `retention-operator-${randomUUID()}`;
  const commandDependencies = { pool, retention, killSwitches, runs: undefined as never, effectReceipts: undefined as never };
  let memoryId = "";
  let holdId = "";
  const commandIds: string[] = [];

  it("keeps held data out of retention, then expires and queues it after release", async () => {
    const policy = await retention.setPolicy({ organizationId, memoryDays: 30, conversationDays: 30, eventDays: 30, auditDays: 365, attachmentDays: 7, actorId });
    expect(policy).toMatchObject({ organization_id: organizationId, memory_days: 30, revision: 1 });
    const memory = await pool.query<{ id: string }>(
      `INSERT INTO memory_records (organization_id, namespace, memory_type, canonical_text, source_type, created_by, status)
       VALUES ($1, 'organization_shared', 'semantic', 'old retention record', 'explicit', $2, 'active') RETURNING id`,
      [organizationId, actorId],
    );
    memoryId = memory.rows[0]!.id;
    await pool.query("UPDATE memory_records SET created_at = now() - interval '60 days' WHERE id = $1", [memoryId]);

    const holdCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `legal-hold-${randomUUID()}`,
      command: { commandType: "create_legal_hold", targetId: organizationId, payload: { organizationId, scopeType: "organization", scopeId: organizationId, reason: "preserve for investigation" } },
      dependencies: commandDependencies,
    });
    commandIds.push(String(holdCommand.command.id));
    const createdHold = await approveOperatorCommand({ actorId: secondActorId, commandId: String(holdCommand.command.id), dependencies: commandDependencies });
    holdId = String((createdHold.result as { legalHoldId: string }).legalHoldId);
    expect(createdHold).toMatchObject({ status: "completed", result: { status: "active", legalHoldId: holdId } });
    expect((await retention.preview(organizationId)).eligible).toMatchObject({ memory: 0 });
    expect(await retention.applyMemoryRetention(organizationId, actorId)).toEqual({ expired: 0, skippedByHold: 1 });

    const releaseCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `legal-release-${randomUUID()}`,
      command: { commandType: "release_legal_hold", targetId: holdId, payload: { expectedOrganizationId: organizationId, expectedStatus: "active" } },
      dependencies: commandDependencies,
    });
    commandIds.push(String(releaseCommand.command.id));
    expect(await approveOperatorCommand({ actorId: secondActorId, commandId: String(releaseCommand.command.id), dependencies: commandDependencies })).toMatchObject({ status: "completed", result: { status: "released", legalHoldId: holdId } });
    expect((await retention.preview(organizationId)).eligible).toMatchObject({ memory: 1 });
    const applyCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `retention-apply-${randomUUID()}`,
      command: { commandType: "apply_retention_policy", targetId: organizationId, payload: { expectedOrganizationId: organizationId } },
      dependencies: commandDependencies,
    });
    commandIds.push(String(applyCommand.command.id));
    const applied = await approveOperatorCommand({ actorId: secondActorId, commandId: String(applyCommand.command.id), dependencies: commandDependencies });
    expect(applied).toMatchObject({ status: "completed", result: { status: "applied", expired: 1 } });
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_records WHERE id = $1", [memoryId])).rows[0]?.status).toBe("expired");
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE target_id = $1 ORDER BY created_at DESC LIMIT 1", [memoryId])).rows[0]?.status).toBe("queued");

    const audit = await pool.query<{ id: string }>(
      "SELECT id::text FROM audit_records WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1",
      [organizationId],
    );
    const auditId = audit.rows[0]?.id;
    expect(auditId).toBeTruthy();
    await expect(pool.query("UPDATE audit_records SET action = 'tampered' WHERE id = $1", [auditId])).rejects.toThrow("append-only");
    await expect(pool.query("DELETE FROM audit_records WHERE id = $1", [auditId])).rejects.toThrow("append-only");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_operator_commands WHERE id = ANY($1::uuid[])", [commandIds]);
    await pool.query("DELETE FROM memory_deletion_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_legal_holds WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_retention_policies WHERE organization_id = $1", [organizationId]);
    await pool.end();
  });
});
