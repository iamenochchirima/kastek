import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { KillSwitchRepository } from "../src/db/repositories/kill-switch-repository";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { InstallationCredentialRepository } from "../src/db/repositories/installation-credential-repository";
import { ScheduleRepository } from "../src/db/repositories/schedule-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { ChannelRepository } from "../src/db/repositories/channel-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { MemoryRepository } from "../src/db/repositories/memory-repository";
import { createOperatorCommand, approveOperatorCommand } from "../src/http/operator-commands";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("operator command lifecycle (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const killSwitches = new KillSwitchRepository(pool);
  const agents = new AgentRepository(pool);
  const installationCredentials = new InstallationCredentialRepository(pool);
  const schedules = new ScheduleRepository(pool);
  const runs = new RunRepository(pool);
  const channels = new ChannelRepository(pool);
  const conversations = new ConversationRepository(pool);
  const memory = new MemoryRepository(pool);
  const actorId = `operator-${randomUUID()}`;
  const secondActorId = `operator-${randomUUID()}`;
  const organizationId = `operator-test-${randomUUID()}`;
  let commandId = "";
  let switchId = "";

  const dependencies = {
    pool,
    runs,
    effectReceipts: undefined as never,
    killSwitches,
    agents,
    installationCredentials,
    schedules,
    channels,
    memory,
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

  it("executes dual-control installation, credential, and schedule lifecycle commands", async () => {
    const definitionId = randomUUID();
    const versionId = randomUUID();
    const installationId = randomUUID();
    const credentialId = randomUUID();
    const scheduleId = randomUUID();
    const lifecycleCommandIds: string[] = [];
    await pool.query(`INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)`, [definitionId, organizationId, "Operator lifecycle test", `operator-${definitionId}`, actorId]);
    await pool.query(`INSERT INTO agent_versions (id, agent_definition_id, version_number, status, instructions, checksum, created_by) VALUES ($1, $2, 1, 'published', 'test', $3, $4)`, [versionId, definitionId, `checksum-${versionId}`, actorId]);
    await pool.query(`INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, $5)`, [installationId, definitionId, versionId, organizationId, actorId]);
    await pool.query(`INSERT INTO agent_installation_credentials (id, installation_id, organization_id, label, secret_hash, created_by) VALUES ($1, $2, $3, 'operator test credential', 'scrypt$test$safe', $4)`, [credentialId, installationId, organizationId, actorId]);
    await pool.query(`INSERT INTO agent_schedules (id, organization_id, installation_id, expression, created_by) VALUES ($1, $2, $3, '@hourly', $4)`, [scheduleId, organizationId, installationId, actorId]);

    const runLifecycleCommand = async (commandType: "suspend_installation" | "resume_installation" | "revoke_credential" | "pause_schedule" | "resume_schedule", targetId: string) => {
      const created = await createOperatorCommand({ actorId, idempotencyKey: `${commandType}-${randomUUID()}`, command: { commandType, targetId, payload: {} }, dependencies });
      lifecycleCommandIds.push(String(created.command.id));
      expect(created.command).toMatchObject({ status: "awaiting_approval", requiredApprovals: 2 });
      return approveOperatorCommand({ actorId: secondActorId, commandId: String(created.command.id), dependencies });
    };

    expect(await runLifecycleCommand("suspend_installation", installationId)).toMatchObject({ status: "completed", result: { status: "paused", installationId } });
    expect((await pool.query<{ status: string }>("SELECT status FROM agent_installations WHERE id = $1", [installationId])).rows[0]?.status).toBe("paused");
    expect(await runLifecycleCommand("resume_installation", installationId)).toMatchObject({ status: "completed", result: { status: "active", installationId } });
    expect(await runLifecycleCommand("revoke_credential", credentialId)).toMatchObject({ status: "completed", result: { status: "revoked", credentialId } });
    expect((await pool.query<{ status: string }>("SELECT status FROM agent_installation_credentials WHERE id = $1", [credentialId])).rows[0]?.status).toBe("revoked");
    expect(await runLifecycleCommand("pause_schedule", scheduleId)).toMatchObject({ status: "completed", result: { status: "paused", scheduleId } });
    expect(await runLifecycleCommand("resume_schedule", scheduleId)).toMatchObject({ status: "completed", result: { status: "active", scheduleId } });

    await pool.query("DELETE FROM audit_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_operator_commands WHERE id = ANY($1::uuid[])", [lifecycleCommandIds]);
    await pool.query("DELETE FROM agent_schedules WHERE id = $1", [scheduleId]);
    await pool.query("DELETE FROM agent_installation_credentials WHERE id = $1", [credentialId]);
    await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [definitionId]);
  });

  it("retries terminal runs and safely replays failed delivery attempts", async () => {
    const definitionId = randomUUID();
    const versionId = randomUUID();
    const installationId = randomUUID();
    const runCommandIds: string[] = [];
    const startedRunIds: string[] = [];
    await pool.query(`INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, $3, $4, $5)`, [definitionId, organizationId, "Operator recovery test", `operator-recovery-${definitionId}`, actorId]);
    await pool.query(`INSERT INTO agent_versions (id, agent_definition_id, version_number, status, instructions, checksum, created_by) VALUES ($1, $2, 1, 'published', 'test', $3, $4)`, [versionId, definitionId, `checksum-${versionId}`, actorId]);
    await pool.query(`INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, $5)`, [installationId, definitionId, versionId, organizationId, actorId]);

    const failed = await runs.createRun(organizationId, actorId, { installationId, triggerType: "manual", input: { source: "operator-recovery" } });
    await runs.failRun(failed.id, { code: "TEST_FAILURE" });
    const assignCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `assign-run-${randomUUID()}`,
      command: { commandType: "assign_run", targetId: failed.id, payload: { assigneeId: secondActorId, expectedStatus: "failed" } },
      dependencies,
    });
    runCommandIds.push(String(assignCommand.command.id));
    const assigned = await approveOperatorCommand({ actorId: secondActorId, commandId: String(assignCommand.command.id), dependencies });
    expect(assigned).toMatchObject({ status: "completed", result: { status: "assigned", runId: failed.id, assigneeId: secondActorId } });
    expect((await pool.query<{ assignee_id: string; revision: number }>("SELECT assignee_id, revision FROM agent_operator_run_assignments WHERE run_id = $1", [failed.id])).rows[0]).toMatchObject({ assignee_id: secondActorId, revision: 1 });
    const staleRetry = await createOperatorCommand({
      actorId,
      idempotencyKey: `retry-run-stale-${randomUUID()}`,
      command: { commandType: "retry_run", targetId: failed.id, payload: { expectedStatus: "running" } },
      dependencies: { ...dependencies, startWorkflow: async () => undefined },
    });
    runCommandIds.push(String(staleRetry.command.id));
    await expect(approveOperatorCommand({ actorId: secondActorId, commandId: String(staleRetry.command.id), dependencies: { ...dependencies, startWorkflow: async () => undefined } })).rejects.toThrow("expected running");
    const retryCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `retry-run-${randomUUID()}`,
      command: { commandType: "retry_run", targetId: failed.id, payload: { expectedStatus: "failed" } },
      dependencies: { ...dependencies, startWorkflow: async (runId) => { startedRunIds.push(runId); } },
    });
    runCommandIds.push(String(retryCommand.command.id));
    expect(retryCommand.command).toMatchObject({ status: "awaiting_approval", requiredApprovals: 2 });
    const retried = await approveOperatorCommand({
      actorId: secondActorId,
      commandId: String(retryCommand.command.id),
      dependencies: { ...dependencies, startWorkflow: async (runId) => { startedRunIds.push(runId); } },
    });
    const retriedRunId = String((retried.result as { runId: string }).runId);
    expect(retried).toMatchObject({ status: "completed", result: { status: "started", sourceRunId: failed.id, runId: retriedRunId } });
    expect(startedRunIds).toEqual([retriedRunId]);
    expect((await runs.getRunById(retriedRunId))?.status).toBe("received");

    const conversation = await conversations.createConversation({ organizationId, installationId, channelType: "telegram", channelKey: "operator-recovery" });
    const message = await conversations.appendMessage({ organizationId, conversationId: conversation.id, direction: "outbound", content: { text: "replay me" }, sourceChannel: "telegram", deliveryStatus: "queued" });
    const queued = await channels.queueDelivery({ organizationId, conversationId: conversation.id, messageId: message.id, channelType: "telegram" });
    const failedDelivery = await channels.markDeliveryFailed({ organizationId, attemptId: queued.id, error: { code: "TEST_PROVIDER_FAILURE" } });
    const staleReplay = await createOperatorCommand({
      actorId,
      idempotencyKey: `replay-delivery-stale-${randomUUID()}`,
      command: { commandType: "replay_delivery", targetId: failedDelivery.id, payload: { expectedStatus: "unknown" } },
      dependencies,
    });
    runCommandIds.push(String(staleReplay.command.id));
    await expect(approveOperatorCommand({ actorId: secondActorId, commandId: String(staleReplay.command.id), dependencies })).rejects.toThrow("expected unknown");
    const replayCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `replay-delivery-${randomUUID()}`,
      command: { commandType: "replay_delivery", targetId: failedDelivery.id, payload: { expectedStatus: "failed" } },
      dependencies,
    });
    runCommandIds.push(String(replayCommand.command.id));
    const replayed = await approveOperatorCommand({ actorId: secondActorId, commandId: String(replayCommand.command.id), dependencies });
    const replayAttemptId = String((replayed.result as { deliveryAttemptId: string }).deliveryAttemptId);
    expect(replayed).toMatchObject({ status: "completed", result: { status: "queued", originalDeliveryAttemptId: failedDelivery.id, deliveryAttemptId: replayAttemptId } });
    expect((await pool.query<{ status: string; attempt_number: number }>("SELECT status, attempt_number FROM delivery_attempts WHERE id = $1", [replayAttemptId])).rows[0]).toMatchObject({ status: "queued", attempt_number: 2 });
    await expect(channels.replayDelivery({ organizationId: "different-organization", attemptId: replayAttemptId })).rejects.toThrow("Delivery attempt not found");
    const invalidReplay = await createOperatorCommand({
      actorId,
      idempotencyKey: `replay-delivery-sent-${randomUUID()}`,
      command: { commandType: "replay_delivery", targetId: replayAttemptId, payload: {} },
      dependencies,
    });
    runCommandIds.push(String(invalidReplay.command.id));
    await expect(approveOperatorCommand({ actorId: secondActorId, commandId: String(invalidReplay.command.id), dependencies })).rejects.toThrow("Only failed or explicitly unknown");

    await pool.query("UPDATE delivery_attempts SET status = 'unknown' WHERE id = $1", [replayAttemptId]);
    const unknownReplay = await createOperatorCommand({
      actorId,
      idempotencyKey: `replay-unknown-${randomUUID()}`,
      command: { commandType: "replay_delivery", targetId: replayAttemptId, payload: {} },
      dependencies,
    });
    runCommandIds.push(String(unknownReplay.command.id));
    await expect(approveOperatorCommand({ actorId: secondActorId, commandId: String(unknownReplay.command.id), dependencies })).rejects.toThrow("confirmUnknown");
    const confirmedUnknown = await createOperatorCommand({
      actorId,
      idempotencyKey: `replay-unknown-confirmed-${randomUUID()}`,
      command: { commandType: "replay_delivery", targetId: replayAttemptId, payload: { confirmUnknown: true, expectedStatus: "unknown" } },
      dependencies,
    });
    runCommandIds.push(String(confirmedUnknown.command.id));
    expect(await approveOperatorCommand({ actorId: secondActorId, commandId: String(confirmedUnknown.command.id), dependencies })).toMatchObject({ status: "completed", result: { status: "queued", originalDeliveryAttemptId: replayAttemptId } });

    const recoveryAudit = (await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action, metadata FROM audit_records
       WHERE organization_id = $1 AND resource_type = 'operator_command'
         AND action IN ('operator_command.run_retried', 'operator_command.delivery_replayed')
       ORDER BY created_at ASC`,
      [organizationId],
    )).rows;
    expect(recoveryAudit.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      "operator_command.run_retried",
      "operator_command.delivery_replayed",
    ]));
    expect(JSON.stringify(recoveryAudit)).not.toContain("replay me");

    const memoryRecord = await memory.createMemory({
      organizationId,
      agentId: definitionId,
      installationId,
      namespace: "agent_private",
      memoryType: "semantic",
      canonicalText: "operator deletion test secret-like content",
      sourceType: "explicit",
      actorId,
    });
    const deleteMemoryCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `delete-memory-${randomUUID()}`,
      command: { commandType: "delete_memory", targetId: memoryRecord.id, payload: { expectedStatus: "active" } },
      dependencies,
    });
    runCommandIds.push(String(deleteMemoryCommand.command.id));
    expect(await approveOperatorCommand({ actorId: secondActorId, commandId: String(deleteMemoryCommand.command.id), dependencies })).toMatchObject({ status: "completed", result: { status: "deleted", memoryId: memoryRecord.id } });
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_records WHERE id = $1", [memoryRecord.id])).rows[0]?.status).toBe("deleted");
    expect((await pool.query<{ status: string }>("SELECT status FROM memory_deletion_jobs WHERE target_type = 'memory' AND target_id = $1 ORDER BY created_at DESC LIMIT 1", [memoryRecord.id])).rows[0]?.status).toBe("completed");

    const exportCommand = await createOperatorCommand({
      actorId,
      idempotencyKey: `export-run-${randomUUID()}`,
      command: { commandType: "request_export", targetId: failed.id, payload: { organizationId, scopeType: "run", scopeId: failed.id } },
      dependencies,
    });
    runCommandIds.push(String(exportCommand.command.id));
    const exportResult = await approveOperatorCommand({ actorId: secondActorId, commandId: String(exportCommand.command.id), dependencies });
    const exportRequestId = String((exportResult.result as { exportRequestId: string }).exportRequestId);
    expect(exportResult).toMatchObject({ status: "completed", result: { status: "requested", exportRequestId, scopeType: "run", scopeId: failed.id } });
    expect((await pool.query<{ organization_id: string; scope_type: string; scope_id: string; status: string }>("SELECT organization_id, scope_type, scope_id, status FROM agent_export_requests WHERE id = $1", [exportRequestId])).rows[0]).toMatchObject({ organization_id: organizationId, scope_type: "run", scope_id: failed.id, status: "requested" });

    const crossOrgExport = await createOperatorCommand({
      actorId,
      idempotencyKey: `export-cross-org-${randomUUID()}`,
      command: { commandType: "request_export", targetId: failed.id, payload: { organizationId: "different-organization", scopeType: "run", scopeId: failed.id } },
      dependencies,
    });
    runCommandIds.push(String(crossOrgExport.command.id));
    await expect(approveOperatorCommand({ actorId: secondActorId, commandId: String(crossOrgExport.command.id), dependencies })).rejects.toThrow("different organization");

    await pool.query("DELETE FROM audit_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_operator_commands WHERE id = ANY($1::uuid[])", [runCommandIds]);
    await pool.query("DELETE FROM delivery_attempts WHERE message_id = $1", [message.id]);
    await pool.query("DELETE FROM messages WHERE id = $1", [message.id]);
    await pool.query("DELETE FROM conversations WHERE id = $1", [conversation.id]);
    await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_operator_run_assignments WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_deletion_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [definitionId]);
  });

  afterAll(async () => {
    if (switchId) await pool.query("DELETE FROM agent_kill_switches WHERE id = $1", [switchId]);
    if (commandId) await pool.query("DELETE FROM audit_records WHERE resource_type = 'operator_command' AND resource_id = $1", [commandId]);
    await pool.query("DELETE FROM audit_records WHERE organization_id = $1", [organizationId]);
    if (commandId) await pool.query("DELETE FROM agent_operator_commands WHERE id = $1", [commandId]);
    await pool.end();
  });
});
