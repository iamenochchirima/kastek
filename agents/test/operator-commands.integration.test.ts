import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { KillSwitchRepository } from "../src/db/repositories/kill-switch-repository";
import { createOperatorCommand, approveOperatorCommand } from "../src/http/operator-commands";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("operator command lifecycle (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const killSwitches = new KillSwitchRepository(pool);
  const actorId = `operator-${randomUUID()}`;
  const secondActorId = `operator-${randomUUID()}`;
  const organizationId = `operator-test-${randomUUID()}`;
  let commandId = "";
  let switchId = "";

  const dependencies = {
    pool,
    runs: undefined as never,
    effectReceipts: undefined as never,
    killSwitches,
  };

  it("persists a dual-control command, executes once, and binds idempotency to its actor and payload", async () => {
    const first = await createOperatorCommand({
      actorId,
      idempotencyKey: `kill-switch-${randomUUID()}`,
      command: {
        commandType: "kill_switch_enable",
        targetId: "organization-scope",
        payload: { organizationId, scopeType: "organization", scopeId: organizationId, reason: "integration test" },
      },
      dependencies,
    });
    commandId = String(first.command.id);
    expect(first.replayed).toBe(false);
    expect(first.command).toMatchObject({ status: "awaiting_approval", requiredApprovals: 2, approvers: [actorId] });

    const approved = await approveOperatorCommand({ actorId: secondActorId, commandId, dependencies });
    expect(approved).toMatchObject({ status: "completed", requiredApprovals: 2, approvers: [actorId, secondActorId], result: { status: "enabled" } });
    switchId = String((approved.result as { switchId: string }).switchId);

    const replay = await createOperatorCommand({
      actorId,
      idempotencyKey: String(first.command.idempotencyKey),
      command: {
        commandType: "kill_switch_enable",
        targetId: "organization-scope",
        payload: { organizationId, scopeType: "organization", scopeId: organizationId, reason: "integration test" },
      },
      dependencies,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.command).toMatchObject({ id: commandId, status: "completed" });

    await expect(createOperatorCommand({
      actorId: secondActorId,
      idempotencyKey: String(first.command.idempotencyKey),
      command: {
        commandType: "kill_switch_enable",
        targetId: "organization-scope",
        payload: { organizationId, scopeType: "organization", scopeId: organizationId, reason: "different request" },
      },
      dependencies,
    })).rejects.toThrow("already bound");
  });

  afterAll(async () => {
    if (switchId) await pool.query("DELETE FROM agent_kill_switches WHERE id = $1", [switchId]);
    if (commandId) await pool.query("DELETE FROM audit_records WHERE resource_type = 'operator_command' AND resource_id = $1", [commandId]);
    await pool.query("DELETE FROM audit_records WHERE organization_id = $1", [organizationId]);
    if (commandId) await pool.query("DELETE FROM agent_operator_commands WHERE id = $1", [commandId]);
    await pool.end();
  });
});
