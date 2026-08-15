import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { ApprovalRepository } from "../src/db/repositories/approval-repository";
import { ChannelRepository } from "../src/db/repositories/channel-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { EffectReceiptRepository } from "../src/db/repositories/effect-receipt-repository";
import { InstallationGrantRepository } from "../src/db/repositories/installation-grant-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { RunStepRepository } from "../src/db/repositories/run-step-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("hosted template lifecycle (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const grants = new InstallationGrantRepository(pool);
  const channels = new ChannelRepository(pool);
  const conversations = new ConversationRepository(pool);
  const runs = new RunRepository(pool);
  const steps = new RunStepRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const effects = new EffectReceiptRepository(pool);
  const organizationId = `template-lifecycle-${randomUUID()}`;
  const actorId = "template-lifecycle-user";

  it("installs, tests, publishes, connects, approves, effects, delivers, and rolls back", async () => {
    const installed = await agents.installTemplate({
      organizationId,
      actorId,
      templateKey: "lead-intake",
      settings: { tone: "concise" },
    });
    expect(installed.created).toBe(true);
    expect(installed.version.status).toBe("published");
    expect(installed.installation.status).toBe("active");

    const connection = await channels.createConnection({
      organizationId,
      installationId: installed.installation.id,
      channelType: "telegram",
      channelKey: `template-${randomUUID()}`,
      metadata: { scenario: "template-lifecycle" },
      actorId,
    });
    await grants.grantConnector({
      organizationId,
      installationId: installed.installation.id,
      connectorId: "telegram",
      actorId,
    });
    expect(await grants.effective(organizationId, installed.installation.id)).toMatchObject({ connectors: ["telegram"] });

    const pairing = await channels.issuePairingToken({
      organizationId,
      installationId: installed.installation.id,
      connectionId: connection.id,
      actorId,
      ttlSeconds: 120,
    });
    const binding = await channels.consumePairingToken({
      organizationId,
      token: pairing.token!,
      externalIdentity: "telegram-customer-42",
    });
    expect(binding).toMatchObject({
      installation_id: installed.installation.id,
      channel_connection_id: connection.id,
      external_identity: "telegram-customer-42",
      status: "active",
    });

    const conversation = await conversations.createConversation({
      organizationId,
      installationId: installed.installation.id,
      channelType: connection.channel_type,
      channelKey: connection.channel_key,
      externalConversationId: "telegram-thread-42",
      title: "Template lifecycle",
    });
    const inbound = await conversations.appendMessage({
      organizationId,
      conversationId: conversation.id,
      direction: "inbound",
      content: { text: "I need help with a new quote" },
      provider: "telegram",
      providerMessageId: `telegram-${randomUUID()}`,
      sourceChannel: "telegram",
      sourceConnectionId: connection.id,
      sourceBindingId: binding.id,
      externalConversationId: "telegram-thread-42",
    });
    expect(inbound.source_binding_id).toBe(binding.id);

    const run = await runs.createRun(organizationId, actorId, {
      installationId: installed.installation.id,
      conversationId: conversation.id,
      triggerType: "message",
      idempotencyKey: `template-run-${randomUUID()}`,
      input: { messageId: inbound.id, message: "I need help with a new quote" },
    });
    expect(run.created).toBe(true);
    await runs.transitionRun(run.id, "received", "queued", { source: "template-test" });
    await runs.transitionRun(run.id, "queued", "running", { source: "template-test" });

    const contextStep = await steps.startStep({
      runId: run.id,
      organizationId,
      stepType: "context",
      input: { channel: "telegram", template: "lead-intake" },
    });
    await steps.finishStep({ stepId: contextStep.id, status: "completed", output: { inboundMessageId: inbound.id } });
    const testStep = await steps.startStep({
      runId: run.id,
      organizationId,
      stepType: "policy",
      input: { scenario: "template-lifecycle" },
    });
    await steps.finishStep({ stepId: testStep.id, status: "completed", output: { allowed: true } });
    await runs.appendEvent({
      organizationId,
      runId: run.id,
      installationId: installed.installation.id,
      eventType: "template.tested",
      payload: { templateKey: "lead-intake", channelType: "telegram", messageId: inbound.id },
    });

    const capability = "test.publish";
    const capabilityVersion = "1.0.0";
    const argumentsHash = "a".repeat(64);
    const providerToolCallId = `template-effect-${randomUUID()}`;
    const permittedEffectKey = `${run.id}:${providerToolCallId}`;
    const effectIdempotencyKey = `${run.id}:${capability}:${argumentsHash}`;
    const previewRevision = argumentsHash;
    const policyRevision = "template-policy-v1";
    await runs.transitionRun(run.id, "running", "awaiting_approval", { providerToolCallId, capability });
    await effects.reserve({
      organizationId,
      installationId: installed.installation.id,
      runId: run.id,
      providerToolCallId,
      capability,
      capabilityVersion,
      argumentsHash,
      idempotencyKey: effectIdempotencyKey,
    });
    await approvals.createPending({
      organizationId,
      installationId: installed.installation.id,
      runId: run.id,
      providerToolCallId,
      capability,
      capabilityVersion,
      argumentsHash,
      resourceSnapshot: { connector: "telegram", externalIdentity: binding.external_identity },
      previewRevision,
      policyRevision,
      permittedEffectKey,
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const decision = await approvals.decide({
      organizationId,
      runId: run.id,
      providerToolCallId,
      argumentsHash,
      decision: "approved",
      approvedBy: actorId,
    });
    expect(decision.accepted).toBe(true);
    await approvals.consumeAndStartEffect({
      organizationId,
      installationId: installed.installation.id,
      runId: run.id,
      providerToolCallId,
      capability,
      capabilityVersion,
      argumentsHash,
      resourceSnapshot: { connector: "telegram", externalIdentity: binding.external_identity },
      previewRevision,
      policyRevision,
      permittedEffectKey,
      effectIdempotencyKey,
    });
    await effects.markSucceededByKey(organizationId, effectIdempotencyKey, { providerMessageId: "template-effect-receipt" });
    expect((await effects.listForRun(organizationId, run.id))[0]).toMatchObject({ status: "succeeded", reconciliation_required: false });
    const effectStep = await steps.startStep({ runId: run.id, organizationId, stepType: "tool", input: { capability } });
    await steps.finishStep({ stepId: effectStep.id, status: "completed", output: { providerReceiptId: "template-effect-receipt" } });
    await runs.appendEvent({
      organizationId,
      runId: run.id,
      installationId: installed.installation.id,
      eventType: "template.effect_succeeded",
      payload: { capability, effectIdempotencyKey },
    });
    await runs.transitionRun(run.id, "awaiting_approval", "running", { effectIdempotencyKey });
    const completed = await runs.completeRun(run.id, { message: "A team member will follow up with your quote request." });
    expect(completed.status).toBe("completed");

    const outbound = (await conversations.listMessages(organizationId, conversation.id)).find((message) => message.run_id === run.id && message.direction === "outbound");
    expect(outbound).toBeDefined();
    const delivery = await channels.queueDelivery({
      organizationId,
      conversationId: conversation.id,
      messageId: outbound!.id,
      channelType: "telegram",
    });
    await channels.claimDelivery(organizationId, delivery.id);
    const delivered = await channels.markDelivered({
      organizationId,
      attemptId: delivery.id,
      providerMessageId: "telegram-response-42",
    });
    expect(delivered).toMatchObject({ status: "sent", provider_message_id: "telegram-response-42" });

    const versionTwo = await agents.createVersion(organizationId, actorId, installed.agent.id, {
      instructions: "Lead intake v2",
      configuration: {},
      policy: { allowedTools: ["platform.current_time"] },
    });
    await agents.publishVersion(organizationId, actorId, installed.agent.id, versionTwo.id);
    expect((await agents.getVersion(organizationId, installed.version.id))?.status).toBe("retired");
    const rolledBack = await agents.rollbackVersion(organizationId, actorId, installed.agent.id, installed.version.id);
    expect(rolledBack.id).toBe(installed.version.id);
    expect((await agents.getVersion(organizationId, versionTwo.id))?.status).toBe("retired");

    const events = await runs.listEvents(organizationId, run.id);
    expect(events.map((event) => event.event_type)).toEqual(expect.arrayContaining(["run.received", "run.queued", "run.running", "run.awaiting_approval", "template.tested", "template.effect_succeeded", "run.completed"]));
    expect((await steps.listSteps(organizationId, run.id)).map((step) => step.status)).toEqual(["completed", "completed", "completed"]);
  });

  beforeAll(async () => {
    await pool.query("SELECT 1");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM delivery_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_approval_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_effect_receipts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_steps WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("UPDATE messages SET run_id = NULL WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM participants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_pairing_tokens WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_bindings WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_connections WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installation_connector_grants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_tool_grants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id IN (SELECT id FROM agent_definitions WHERE organization_id = $1)", [organizationId]);
    await pool.query("DELETE FROM agent_definitions WHERE organization_id = $1", [organizationId]);
    await pool.end();
  });
});
