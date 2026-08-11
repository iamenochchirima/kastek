import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { ChannelRepository } from "../src/db/repositories/channel-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("channel routing contracts (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const channels = new ChannelRepository(pool);
  const conversations = new ConversationRepository(pool);
  const organizationId = `channel-test-${randomUUID()}`;
  let agentId = "";
  let versionId = "";
  let installationId = "";
  let conversationId = "";

  it("creates a connection, binding, participant, and deduplicated delivery contract", async () => {
    const agent = await agents.createAgent(organizationId, "test-user", { name: "Channel test" });
    agentId = agent.id;
    const version = await agents.createVersion(organizationId, "test-user", agent.id, { instructions: "test", configuration: {}, policy: {} });
    versionId = version.id;
    await agents.publishVersion(organizationId, "test-user", agent.id, version.id);
    const installation = await agents.createInstallation(organizationId, "test-user", { agentVersionId: version.id, scopeType: "organization", scopeId: organizationId, settings: {} });
    installationId = installation.id;
    const connection = await channels.createConnection({ organizationId, installationId, channelType: "platform", channelKey: "sidebar", actorId: "test-user" });
    const binding = await channels.bind({ organizationId, installationId, connectionId: connection.id, externalIdentity: "user:test" });
    expect(binding.channel_type).toBe("platform");
    const conversation = await conversations.createConversation({ organizationId, installationId, channelType: "platform", channelKey: "sidebar", externalConversationId: "conversation:test" });
    conversationId = conversation.id;
    const participant = await conversations.createParticipant({ organizationId, conversationId, participantType: "user", externalId: "user:test", displayName: "Test" });
    const message = await conversations.appendMessage({ organizationId, conversationId, participantId: participant.id, direction: "outbound", content: { text: "hello" }, provider: "platform", providerMessageId: "message:test" });
    const attempt = await channels.queueDelivery({ organizationId, conversationId, messageId: message.id, channelType: "platform" });
    expect(attempt.status).toBe("queued");
  });

  beforeAll(async () => { await pool.query("SELECT 1"); });

  afterAll(async () => {
    await pool.query("DELETE FROM delivery_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_bindings WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_connections WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM participants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    if (versionId) await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    if (agentId) await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
