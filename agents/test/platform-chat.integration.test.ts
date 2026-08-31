import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { PlatformChatRepository } from "../src/db/repositories/platform-chat-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { ChannelRepository } from "../src/db/repositories/channel-repository";
import { KasiAiPreferenceRepository } from "../src/db/repositories/kasiai-preference-repository";
import { createActivities } from "../src/temporal/activities";
import type { KasitekCoreReadClient } from "../src/core/client";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("platform chat durability (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const conversations = new ConversationRepository(pool);
  const platformChat = new PlatformChatRepository(pool);
  const runs = new RunRepository(pool);
  const channels = new ChannelRepository(pool);
  const preferences = new KasiAiPreferenceRepository(pool);
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
      createNew: true,
      context: { route: "/campaigns" },
    });
    const retry = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "user-1",
      idempotencyKey: "client-message-1",
      message: "This retry payload must not replace the original.",
      createNew: true,
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
    expect(messages.every((message) => message.source_channel === "platform")).toBe(true);
    expect((await runs.getRun(organizationId, first.run.id))?.status).toBe("completed");
    const generatedTitle = await conversations.setGeneratedTitle({
      organizationId,
      conversationId: first.conversation.id,
      title: "Create a campaign",
    });
    expect(generatedTitle).toMatchObject({ title: "Create a campaign", title_source: "ai", title_locked: false });
  });

  it("retries a failed platform message on a new run without duplicating the inbound message", async () => {
    const first = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "retry-user",
      idempotencyKey: "retry-platform-message-1",
      message: "Retry this platform request",
      createNew: true,
    });
    await runs.transitionRun(first.run.id, "received", "queued");
    await runs.transitionRun(first.run.id, "queued", "running");
    await runs.failRun(first.run.id, { code: "test_failure", message: "The first attempt failed" });

    const retried = await platformChat.retryMessage({
      organizationId,
      runId: first.run.id,
      actorId: "retry-user",
    });
    expect(retried.created).toBe(true);
    expect(retried.message.id).toBe(first.message.id);
    expect(retried.message.run_id).toBe(first.run.id);
    expect(retried.run.id).not.toBe(first.run.id);
    expect(retried.run.causation_id).toBe(first.run.id);
    expect(retried.run.input).toEqual(first.run.input);

    const beforeCompletion = await conversations.listMessages(organizationId, first.conversation.id);
    expect(beforeCompletion).toHaveLength(1);
    expect(beforeCompletion[0]).toMatchObject({ id: first.message.id, direction: "inbound", run_id: first.run.id });

    await runs.transitionRun(retried.run.id, "received", "queued");
    await runs.transitionRun(retried.run.id, "queued", "running");
    await runs.completeRun(retried.run.id, { message: "The retry succeeded." });
    const afterCompletion = await conversations.listMessages(organizationId, first.conversation.id);
    expect(afterCompletion.map((message) => [message.direction, message.run_id, message.content.text])).toEqual([
      ["inbound", first.run.id, "Retry this platform request"],
      ["outbound", retried.run.id, "The retry succeeded."],
    ]);
  });

  it("creates another active chat without moving the channel-default pointer", async () => {
    const previous = await platformChat.resolveConversation({ organizationId, installationId, actorId: "user-1" });
    const current = await platformChat.createNewConversation({ organizationId, installationId, actorId: "user-1" });
    expect(current.conversation.id).not.toBe(previous.conversation.id);
    expect(current.conversation.is_primary).toBe(false);
    const previousActive = await conversations.getOwnedConversation(organizationId, previous.conversation.id, "user-1");
    expect(previousActive).toMatchObject({ status: "active", is_primary: true });
    const history = await conversations.listOwnerConversations(organizationId, installationId, "user-1");
    expect(history[0]?.id).toBe(current.conversation.id);
    expect(history.some((conversation) => conversation.id === previous.conversation.id && conversation.status === "active")).toBe(true);
    const renamed = await conversations.updateOwnedConversation({
      organizationId,
      conversationId: current.conversation.id,
      ownerActorId: "user-1",
      title: "Campaign planning",
      pinned: true,
      modelProvider: "openrouter",
      model: "openai/gpt-4o-mini",
    });
    expect(renamed).toMatchObject({ title: "Campaign planning", title_source: "manual", title_locked: true, pinned: true, model: "openai/gpt-4o-mini" });
    expect(await conversations.setGeneratedTitle({ organizationId, conversationId: current.conversation.id, title: "Ignored title" })).toBeNull();
    const archived = await conversations.setOwnedStatus(organizationId, current.conversation.id, "user-1", "archived");
    expect(archived.status).toBe("archived");
    const restored = await conversations.restoreOwnedConversation(organizationId, current.conversation.id, "user-1");
    expect(restored).toMatchObject({ status: "active", is_primary: false });
  });

  it("keeps a new web chat independent while another chat is still running", async () => {
    const first = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "parallel-chat-owner",
      idempotencyKey: "parallel-chat-first",
      message: "First conversation",
      createNew: true,
    });
    const second = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "parallel-chat-owner",
      idempotencyKey: "parallel-chat-second",
      message: "Independent conversation",
      createNew: true,
    });
    expect(second.conversation.id).not.toBe(first.conversation.id);
    expect(second.run.conversation_id).toBe(second.conversation.id);
    expect(first.run.status).toBe("received");
    const firstMessages = await conversations.listMessages(organizationId, first.conversation.id);
    const secondMessages = await conversations.listMessages(organizationId, second.conversation.id);
    expect(firstMessages.map((message) => message.content.text)).toEqual(["First conversation"]);
    expect(secondMessages.map((message) => message.content.text)).toEqual(["Independent conversation"]);
    await runs.transitionRun(first.run.id, "received", "queued");
    await runs.transitionRun(first.run.id, "queued", "running");
    await runs.completeRun(first.run.id, { message: "First reply" });
    await runs.transitionRun(second.run.id, "received", "queued");
    await runs.transitionRun(second.run.id, "queued", "running");
    await runs.completeRun(second.run.id, { message: "Second reply" });
  });

  it("keeps greeting-only chat titles neutral until a meaningful title exists", async () => {
    const accepted = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "greeting-title-owner",
      idempotencyKey: "greeting-title-message",
      message: "Hi",
      createNew: true,
    });
    expect(accepted.conversation).toMatchObject({ title: "New chat", title_source: "fallback" });
    await runs.transitionRun(accepted.run.id, "received", "queued");
    await runs.transitionRun(accepted.run.id, "queued", "running");
    await runs.completeRun(accepted.run.id, { message: "Hello! How can I help?" });
  });

  it("keeps KasiAi preferences scoped to the owner and installation", async () => {
    const one = await preferences.upsert(organizationId, installationId, "user-1", {
      tone: "concise",
      response_detail: "detailed",
      default_model_provider: "openrouter",
      default_model: "openai/gpt-4o-mini",
    });
    expect(one).toMatchObject({ owner_actor_id: "user-1", tone: "concise", response_detail: "detailed" });
    expect(await preferences.get(organizationId, installationId, "user-2")).toBeNull();
    const updated = await preferences.upsert(organizationId, installationId, "user-1", { use_saved_preferences: false });
    expect(updated).toMatchObject({ tone: "concise", use_saved_preferences: false });
  });

  it("routes each paired external thread into its installation-owned customer conversation", async () => {
    const current = await platformChat.resolveConversation({ organizationId, installationId, actorId: "user-1" });
    const connection = await channels.createConnection({
      organizationId,
      installationId,
      channelType: "whatsapp",
      channelKey: "kasiai-personal",
      actorId: "user-1",
    });
    const binding = await channels.bind({
      organizationId,
      installationId,
      connectionId: connection.id,
      externalIdentity: "+27820000001",
      ownerActorId: "user-1",
    });
    const accepted = await platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "event-external-1",
      providerMessageId: "wamid-external-1",
      externalIdentity: "+27820000001",
      externalConversationId: "wa-thread-1",
      messageType: "text",
      content: { text: "What is happening in my workspace?" },
    });
    expect(accepted.conversation.id).not.toBe(current.conversation.id);
    expect(accepted.conversation).toMatchObject({ conversation_kind: "customer", owner_actor_id: null, external_conversation_id: "wa-thread-1" });
    expect(accepted.userParticipant).toMatchObject({ participant_type: "customer", external_id: "whatsapp:+27820000001" });
    const customerProjection = await conversations.listInstallationConversationProjections(organizationId, installationId, { kind: "customer" });
    expect(customerProjection).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: accepted.conversation.id, participant_type: "customer", unread_count: 1, message_count: 1, last_message_preview: "What is happening in my workspace?" }),
    ]));
    expect(accepted.message).toMatchObject({ source_channel: "whatsapp", external_conversation_id: "wa-thread-1" });
    expect(accepted.run.created_by).toBe("user-1");
    const duplicate = await platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "event-external-1",
      providerMessageId: "wamid-external-1",
      externalIdentity: "+27820000001",
      externalConversationId: "wa-thread-1",
      messageType: "text",
      content: { text: "duplicate" },
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.message.id).toBe(accepted.message.id);
    await expect(platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "user-1",
      idempotencyKey: "overlapping-sidebar-message",
      message: "This must not cross the WhatsApp reply",
      conversationId: current.conversation.id,
    })).resolves.toMatchObject({ conversation: { id: current.conversation.id } });
    await runs.transitionRun(accepted.run.id, "received", "queued");
    await runs.transitionRun(accepted.run.id, "queued", "running");
    await runs.completeRun(accepted.run.id, { message: "Here is your workspace update." });
    const messages = await conversations.listMessages(organizationId, accepted.conversation.id);
    const reply = messages.find((message) => message.run_id === accepted.run.id && message.direction === "outbound");
    expect(reply).toMatchObject({ source_channel: "whatsapp", delivery_status: "queued" });
    const attempts = await pool.query("SELECT * FROM delivery_attempts WHERE message_id = $1", [reply!.id]);
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({ channel_type: "whatsapp", status: "queued" });
    const deliveries: Array<{ channelType: string; externalConversationId: string; text: string }> = [];
    const activities = createActivities(pool, {
      coreClient: {
        deliverChannelMessage: async (input: { channelType: string; externalConversationId: string; text: string }) => {
          deliveries.push(input);
          return { providerMessageId: "wamid-reply-1", status: "sent" as const };
        },
      } as unknown as KasitekCoreReadClient,
    });
    await activities.deliverRunReply({ runId: accepted.run.id });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      channelType: "whatsapp",
      externalConversationId: "wa-thread-1",
      text: "Here is your workspace update.",
    });
    const deliveredReply = (await conversations.listMessages(organizationId, accepted.conversation.id))
      .find((message) => message.id === reply!.id);
    expect(deliveredReply).toMatchObject({ delivery_status: "sent", provider_message_id: "wamid-reply-1" });
    const secondThread = await platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "event-external-2",
      providerMessageId: "wamid-external-2",
      externalIdentity: "+27820000001",
      externalConversationId: "wa-thread-2",
      messageType: "text",
      content: { text: "A separate customer thread" },
    });
    expect(secondThread.conversation.id).not.toBe(accepted.conversation.id);
    expect(secondThread.conversation.conversation_kind).toBe("customer");

    const handoffThread = await platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "event-handoff-1",
      providerMessageId: "wamid-handoff-1",
      externalIdentity: "+27820000001",
      externalConversationId: "wa-handoff-thread",
      messageType: "text",
      content: { text: "Please connect me to a person." },
    });
    expect(handoffThread.run).toBeNull();
    expect(handoffThread.handoffRequestId).toBeTruthy();
    await pool.query(
      `UPDATE conversations
       SET handoff_state = 'handoff_requested', handoff_revision = handoff_revision + 1
       WHERE id = $1 AND organization_id = $2`,
      [handoffThread.conversation.id, organizationId],
    );
    await expect(conversations.appendMessage({
      organizationId,
      conversationId: handoffThread.conversation.id,
      direction: "outbound",
      content: { text: "This agent reply must be blocked." },
      provider: "platform",
    })).rejects.toMatchObject({ code: "conversation_handoff_active", statusCode: 409 });
    expect((await conversations.listMessages(organizationId, handoffThread.conversation.id))
      .filter((message) => message.direction === "outbound")).toHaveLength(0);
    await expect(platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "event-handoff-2",
      providerMessageId: "wamid-handoff-2",
      externalIdentity: "+27820000001",
      externalConversationId: "wa-handoff-thread",
      messageType: "text",
      content: { text: "Do not start another agent run while a human owns this thread." },
    })).rejects.toMatchObject({ code: "conversation_handoff_active", statusCode: 409 });

    await channels.createConnection({
      organizationId,
      installationId,
      channelType: "whatsapp",
      channelKey: "business-public",
      actorId: "test-user",
    });
    const publicMessage = await platformChat.acceptExternalMessage({
      organizationId,
      channelType: "whatsapp",
      channelKey: "business-public",
      provider: "meta-whatsapp",
      providerEventId: "event-public-1",
      providerMessageId: "wamid-public-1",
      externalIdentity: "+27820000002",
      externalConversationId: "wa-public-thread-1",
      messageType: "text",
      content: { text: "I am a new customer" },
    });
    expect(publicMessage.conversation).toMatchObject({ conversation_kind: "customer", external_conversation_id: "wa-public-thread-1" });
    expect(publicMessage.run.created_by).toBe(`installation:${installationId}`);
    expect((await pool.query(
      `SELECT owner_actor_id FROM channel_bindings
       WHERE organization_id = $1 AND channel_connection_id = (
         SELECT id FROM channel_connections WHERE organization_id = $1 AND channel_key = 'business-public'
       ) AND external_identity = $2`,
      [organizationId, "+27820000002"],
    )).rows[0]).toMatchObject({ owner_actor_id: null });

    await channels.revokeOwnerBinding(organizationId, binding.id, "user-1");
    await expect(platformChat.acceptExternalMessage({
      organizationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "event-after-disconnect",
      providerMessageId: "wamid-after-disconnect",
      externalIdentity: "+27820000001",
      externalConversationId: "wa-thread-1",
      messageType: "text",
      content: { text: "This must not enter the conversation." },
    })).rejects.toMatchObject({ statusCode: 403, code: "channel_identity_not_paired" });
    expect((await conversations.listMessages(organizationId, accepted.conversation.id))
      .some((message) => message.provider_message_id === "wamid-after-disconnect")).toBe(false);
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

  it("owner-scopes lifecycle changes and removes conversation-derived state on deletion", async () => {
    const current = await platformChat.resolveConversation({ organizationId, installationId, actorId: "lifecycle-owner" });
    await pool.query(
      `INSERT INTO conversation_summaries
        (conversation_id, organization_id, summary, last_message_sequence)
       VALUES ($1, $2, 'derived summary', 0)`,
      [current.conversation.id, organizationId],
    );
    await pool.query(
      `INSERT INTO memory_records
        (organization_id, agent_definition_id, installation_id, conversation_id, owner_user_id, namespace, memory_type,
         canonical_text, source_type, created_by)
       VALUES ($1, $2, $3, $4, $5, 'conversation', 'working', 'temporary context', 'inferred', $5)`,
      [organizationId, agentId, installationId, current.conversation.id, "lifecycle-owner"],
    );
    await expect(conversations.setOwnedStatus(
      organizationId,
      current.conversation.id,
      "another-user",
      "deleted",
    )).rejects.toThrow("Conversation not found");
    const deleted = await conversations.setOwnedStatus(
      organizationId,
      current.conversation.id,
      "lifecycle-owner",
      "deleted",
    );
    expect(deleted).toMatchObject({ status: "deleted", is_primary: false });
    const summary = await pool.query("SELECT 1 FROM conversation_summaries WHERE conversation_id = $1", [current.conversation.id]);
    expect(summary.rows).toHaveLength(0);
    const memory = await pool.query("SELECT status, deleted_at FROM memory_records WHERE conversation_id = $1", [current.conversation.id]);
    expect(memory.rows[0].status).toBe("deleted");
    expect(memory.rows[0].deleted_at).toBeTruthy();
  });

  afterAll(async () => {
    await pool.query("DELETE FROM kasiai_user_preferences WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversation_summaries WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM delivery_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_pairing_tokens WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_handoff_requests WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_handoff_offers WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM participants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_workflow_state WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_steps WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_bindings WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_connections WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    if (versionId) await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    if (agentId) await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
