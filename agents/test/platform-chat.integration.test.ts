import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { PlatformChatRepository } from "../src/db/repositories/platform-chat-repository";
import { RunRepository } from "../src/db/repositories/run-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("platform chat durability (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const conversations = new ConversationRepository(pool);
  const platformChat = new PlatformChatRepository(pool);
  const runs = new RunRepository(pool);
  const organizationId = `platform-chat-${randomUUID()}`;
  let agentId = "";
  let versionId = "";
  let installationId = "";

  beforeAll(async () => {
    const agent = await agents.createAgent(organizationId, "test-user", { name: "Platform chat test" });
    agentId = agent.id;
    const version = await agents.createVersion(organizationId, "test-user", agent.id, {
      instructions: "Answer briefly.",
      configuration: {},
      policy: {},
    });
    versionId = version.id;
    await agents.publishVersion(organizationId, "test-user", agent.id, version.id);
    const installation = await agents.createInstallation(organizationId, "test-user", {
      agentVersionId: version.id,
      scopeType: "organization",
      scopeId: organizationId,
      settings: {},
    });
    installationId = installation.id;
  });

  it("atomically accepts, deduplicates, and completes a platform message", async () => {
    const first = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "user-1",
      idempotencyKey: "client-message-1",
      message: "Where do I create a campaign?",
      context: { route: "/campaigns" },
    });
    const retry = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "user-1",
      idempotencyKey: "client-message-1",
      message: "This retry payload must not replace the original.",
    });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.run.id).toBe(first.run.id);
    expect(retry.message.id).toBe(first.message.id);
    expect(first.run.input).toMatchObject({ message: "Where do I create a campaign?", context: { route: "/campaigns" } });

    await runs.transitionRun(first.run.id, "received", "queued");
    await runs.transitionRun(first.run.id, "queued", "running");
    await runs.completeRun(first.run.id, { message: "Open Campaigns and select Create campaign." });
    const messages = await conversations.listMessages(organizationId, first.conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => [message.direction, message.content.text, message.run_id])).toEqual([
      ["inbound", "Where do I create a campaign?", first.run.id],
      ["outbound", "Open Campaigns and select Create campaign.", first.run.id],
    ]);
    expect((await runs.getRun(organizationId, first.run.id))?.status).toBe("completed");
  });

  it("keeps each platform user in a separate conversation", async () => {
    const userOne = await platformChat.resolveConversation({ organizationId, installationId, actorId: "user-1" });
    const userTwo = await platformChat.resolveConversation({ organizationId, installationId, actorId: "user-2" });
    expect(userOne.conversation.id).not.toBe(userTwo.conversation.id);
    expect(userOne.userParticipant.external_id).toBe("user-1");
    expect(userTwo.userParticipant.external_id).toBe("user-2");
    await expect(platformChat.resolveConversation({
      organizationId: "another-organization",
      installationId,
      actorId: "user-1",
    })).rejects.toThrow("Active installation not found");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM conversation_summaries WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM participants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_workflow_state WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    if (versionId) await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    if (agentId) await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
