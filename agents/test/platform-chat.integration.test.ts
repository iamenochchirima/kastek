import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { PlatformChatRepository } from "../src/db/repositories/platform-chat-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { ChannelRepository } from "../src/db/repositories/channel-repository";
import { HandoffRepository } from "../src/db/repositories/handoff-repository";
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
  const handoffs = new HandoffRepository(pool);
  const preferences = new KasiAiPreferenceRepository(pool);
  const organizationId = `platform-chat-${randomUUID()}`;
  let agentId = "";
  let versionId = "";
  let installationId = "";
  let customerAgentId = "";
  let customerVersionId = "";

  beforeAll(async () => {
    const agent = await agents.createAgent(organizationId, "test-user", { name: "Platform chat test", agentAudience: "customer_service" });
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

  it("keeps the persisted conversation model when an old client sends an override", async () => {
    const first = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "model-override-owner",
      idempotencyKey: "model-override-first",
      message: "Use the initial model",
      createNew: true,
      modelProvider: "openrouter",
      model: "initial-model",
    });
    await runs.transitionRun(first.run.id, "received", "queued");
    await runs.transitionRun(first.run.id, "queued", "running");
    await runs.completeRun(first.run.id, { message: "Initial response" });

    const second = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "model-override-owner",
      idempotencyKey: "model-override-second",
      message: "Use the selected model",
      conversationId: first.conversation.id,
      modelProvider: "openai",
      model: "selected-model",
    });

    expect(second.run).toMatchObject({
      resolved_model_provider: "openrouter",
      resolved_model: "initial-model",
    });
    expect(second.conversation).toMatchObject({
      model_provider: "openrouter",
      model: "initial-model",
    });
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

  it("serializes simultaneous messages for one conversation and preserves the accepted transcript", async () => {
    const first = await platformChat.acceptMessage({
      organizationId,
      installationId,
      actorId: "ordering-owner",
      idempotencyKey: "ordering-seed-message",
      message: "Seed message",
      createNew: true,
    });
    await runs.transitionRun(first.run.id, "received", "queued");
    await runs.transitionRun(first.run.id, "queued", "running");
    await runs.completeRun(first.run.id, { message: "Seed reply" });

    const attempts = await Promise.allSettled([
      platformChat.acceptMessage({
        organizationId,
        installationId,
        actorId: "ordering-owner",
        idempotencyKey: "ordering-message-a",
        message: "Message A",
        conversationId: first.conversation.id,
      }),
      platformChat.acceptMessage({
        organizationId,
        installationId,
        actorId: "ordering-owner",
        idempotencyKey: "ordering-message-b",
        message: "Message B",
        conversationId: first.conversation.id,
      }),
    ]);
    const accepted = attempts.filter((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof platformChat.acceptMessage>>> => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ statusCode: 409, code: "conversation_busy" });

    const messages = await conversations.listMessages(organizationId, first.conversation.id);
    expect(messages.map((message) => message.content.text)).toEqual(["Seed message", "Seed reply", accepted[0]!.value.message.content.text]);
    await runs.transitionRun(accepted[0]!.value.run.id, "received", "queued");
    await runs.transitionRun(accepted[0]!.value.run.id, "queued", "running");
    await runs.completeRun(accepted[0]!.value.run.id, { message: "Ordered reply" });
  });

  it("rolls back a busy channel delivery so provider redelivery preserves order", async () => {
    const connection = await channels.createConnection({
      organizationId,
      installationId,
      channelType: "whatsapp",
      channelKey: "ordering-channel",
      actorId: "test-user",
    });
    await channels.bind({
      organizationId,
      installationId,
      connectionId: connection.id,
      externalIdentity: "+27820000009",
      ownerActorId: "test-user",
    });

    const first = await platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "ordering-event-1",
      providerMessageId: "ordering-provider-message-1",
      externalIdentity: "+27820000009",
      externalConversationId: "ordering-thread",
      messageType: "text",
      content: { text: "First channel message" },
    });
    await expect(platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "ordering-event-2",
      providerMessageId: "ordering-provider-message-2",
      externalIdentity: "+27820000009",
      externalConversationId: "ordering-thread",
      messageType: "text",
      content: { text: "Second channel message" },
    })).rejects.toMatchObject({ statusCode: 409, code: "conversation_busy" });

    expect((await conversations.listMessages(organizationId, first.conversation.id))
      .some((message) => message.provider_message_id === "ordering-provider-message-2")).toBe(false);
    await runs.transitionRun(first.run.id, "received", "queued");
    await runs.transitionRun(first.run.id, "queued", "running");
    await runs.completeRun(first.run.id, { message: "First channel reply" });

    const redelivery = await platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "ordering-event-2",
      providerMessageId: "ordering-provider-message-2",
      externalIdentity: "+27820000009",
      externalConversationId: "ordering-thread",
      messageType: "text",
      content: { text: "Second channel message" },
    });
    expect(redelivery.created).toBe(true);
    const ordered = (await conversations.listMessages(organizationId, first.conversation.id))
      .filter((message) => message.direction === "inbound");
    expect(ordered.map((message) => message.content.text)).toEqual(["First channel message", "Second channel message"]);
    expect(ordered[1]!.sequence_number).toBe(String(Number(ordered[0]!.sequence_number) + 2));
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
    const handoffMessages = (await conversations.listMessages(organizationId, handoffThread.conversation.id))
      .filter((message) => message.direction === "outbound");
    expect(handoffMessages).toHaveLength(1);
    expect(handoffMessages[0]).toMatchObject({
      content: { text: "Absolutely — I’ve sent your request to our team. A team member will reply here as soon as possible." },
      delivery_status: "queued",
      source_channel: "whatsapp",
    });
    expect(handoffThread.handoffAcknowledgement).toMatchObject({
      message: { id: handoffMessages[0]!.id },
      deliveryAttemptId: expect.any(String),
    });
    const activeHandoff = await platformChat.acceptExternalMessage({
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
    });
    expect(activeHandoff).toMatchObject({
      created: false,
      handoffActive: true,
      handoffRequestId: handoffThread.handoffRequestId,
      handoffAcknowledgement: { deliveryAttemptId: expect.any(String) },
    });

    await handoffs.claim({ organizationId, handoffId: handoffThread.handoffRequestId!, actorId: "operator-1" });
    const resolvedHandoff = await handoffs.resolve({ organizationId, handoffId: handoffThread.handoffRequestId!, actorId: "operator-1", resolution: "Customer interaction completed" });
    expect(resolvedHandoff.conversation).toMatchObject({ handoff_state: "resolved", assigned_actor_id: null });
    const reopenedThread = await platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "whatsapp",
      provider: "meta-whatsapp",
      providerEventId: "event-handoff-after-resolve",
      providerMessageId: "wamid-handoff-after-resolve",
      externalIdentity: "+27820000001",
      externalConversationId: "wa-handoff-thread",
      messageType: "text",
      content: { text: "I have one more question." },
    });
    expect(reopenedThread).toMatchObject({ created: true, conversation: { id: handoffThread.conversation.id, handoff_state: "agent_active" } });
    expect(reopenedThread.run).toBeTruthy();

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

  it("routes the same external identity independently for personal and public connections", async () => {
    const customerAgent = await agents.createAgent(organizationId, "test-user", {
      name: "Customer channel test",
      agentAudience: "customer_service",
    });
    customerAgentId = customerAgent.id;
    const customerVersion = await agents.createVersion(organizationId, "test-user", customerAgent.id, {
      instructions: "Answer customer questions briefly.",
      configuration: {},
      policy: {},
    });
    customerVersionId = customerVersion.id;
    await agents.publishVersion(organizationId, "test-user", customerAgent.id, customerVersion.id);
    const customerInstallation = await agents.createInstallation(organizationId, "test-user", {
      agentVersionId: customerVersion.id,
      scopeType: "organization",
      scopeId: organizationId,
      settings: {},
    });

    const telegramUser = "5251104155";
    const personalConnection = await channels.createConnection({
      organizationId,
      installationId,
      channelType: "telegram",
      channelKey: "bot:personal-routing-test",
      metadata: { routing: "private" },
      actorId: "test-user",
    });
    await channels.bind({
      organizationId,
      installationId,
      connectionId: personalConnection.id,
      externalIdentity: telegramUser,
      ownerActorId: "test-user",
    });
    const personalAccepted = await platformChat.acceptExternalMessage({
      organizationId,
      installationId,
      channelType: "telegram",
      channelKey: personalConnection.channel_key,
      provider: "telegram",
      providerEventId: "telegram-update-117-personal",
      providerMessageId: "117",
      externalIdentity: telegramUser,
      externalConversationId: "routing-personal-thread",
      messageType: "text",
      content: { text: "A personal message" },
    });
    expect(personalAccepted.created).toBe(true);
    const publicConnection = await channels.createConnection({
      organizationId,
      installationId: customerInstallation.id,
      channelType: "telegram",
      channelKey: "bot:public-routing-test",
      metadata: { routing: "public" },
      actorId: "test-user",
    });

    const accepted = await platformChat.acceptExternalMessage({
      organizationId,
      installationId: customerInstallation.id,
      channelType: "telegram",
      channelKey: publicConnection.channel_key,
      provider: "telegram",
      providerEventId: "telegram-update-117-public",
      providerMessageId: "117",
      externalIdentity: telegramUser,
      externalConversationId: "routing-public-thread",
      messageType: "text",
      content: { text: "A public customer message" },
    });

    expect(accepted.created).toBe(true);
    expect(accepted.conversation.conversation_kind).toBe("customer");
    expect(accepted.run.created_by).toBe(`installation:${customerInstallation.id}`);
    const bindings = await pool.query<{ channel_connection_id: string; owner_actor_id: string | null }>(
      `SELECT channel_connection_id, owner_actor_id
       FROM channel_bindings
       WHERE organization_id = $1 AND channel_type = 'telegram' AND external_identity = $2
       ORDER BY channel_connection_id`,
      [organizationId, telegramUser],
    );
    expect(bindings.rows).toEqual(expect.arrayContaining([
      { channel_connection_id: personalConnection.id, owner_actor_id: "test-user" },
      { channel_connection_id: publicConnection.id, owner_actor_id: null },
    ]));
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
    expect(memory.rows).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM kasiai_user_preferences WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_consolidation_jobs WHERE organization_id = $1", [organizationId]);
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
    await pool.query("DELETE FROM agent_delivery_obligations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM memory_records WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_bindings WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM channel_connections WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_tool_grants WHERE organization_id = $1", [organizationId]);
    if (versionId) await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    if (agentId) await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    if (customerVersionId) await pool.query("DELETE FROM agent_versions WHERE id = $1", [customerVersionId]);
    if (customerAgentId) await pool.query("DELETE FROM agent_definitions WHERE id = $1", [customerAgentId]);
    await pool.end();
  });
});
