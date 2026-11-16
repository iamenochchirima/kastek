import { randomUUID } from "node:crypto";
import type { GrowthAgentChannelEvent } from "@kasitek-labs/contracts";
import { ApiError } from "../error.js";
import type { CoreContext } from "../context.js";
import { GrowthAgentClient } from "./client.js";
import { sendGrowthAgentChannelMessage } from "./channel-links.js";
import { growthAgentActor } from "./security.js";

const TERMINAL_TASK_STATES = new Set([
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "uncertain",
  "refused",
]);

type AssistantGrant = {
  grantId: string;
  orgId: string;
  agentsWorkspaceId: string;
  agentsAgentId: string;
  agentsConnectionId: string;
  actorId: string;
  provider: "whatsapp" | "facebook" | "instagram";
  providerAssetId: string;
};

type AssistantLogger = {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
};

async function conversationFor(
  core: CoreContext,
  grant: AssistantGrant,
  event: GrowthAgentChannelEvent,
  client: GrowthAgentClient,
): Promise<string> {
  const existing = (
    await core.pool.query<{ conversationId: string }>(
      `SELECT "conversationId" FROM "GrowthAgentChannelConversation"
        WHERE "grantId"=$1 AND "externalConversationId"=$2`,
      [grant.grantId, event.externalConversationId],
    )
  ).rows[0]?.conversationId;
  const created = existing
    ? null
    : await client.command(
        { tenantId: grant.orgId, actor: growthAgentActor(core.config, grant.actorId) },
        "conversations.create",
        { featureId: "assistant" },
      );
  const conversationId = existing ?? created!.conversation.id;
  await core.pool.query(
    `INSERT INTO "GrowthAgentChannelConversation"(
       id,"orgId","grantId","externalConversationId","conversationId","createdAt","updatedAt")
     VALUES($1,$2,$3,$4,$5,now(),now())
     ON CONFLICT ("grantId","externalConversationId") DO UPDATE SET
       "conversationId"=excluded."conversationId","updatedAt"=now()`,
    [randomUUID(), grant.orgId, grant.grantId, event.externalConversationId, conversationId],
  );
  return conversationId;
}

/**
 * Runs a Growth assistant turn as the Growth member who linked the channel, then delivers
 * the reply through the existing Growth-managed provider send path. Channel senders never
 * inherit a staff principal directly; the linked member's current Growth permissions apply.
 */
export async function runGrowthAssistantChannelEvent(
  core: CoreContext,
  grant: AssistantGrant,
  event: GrowthAgentChannelEvent,
  logger: AssistantLogger = console,
): Promise<void> {
  if (grant.provider !== "whatsapp")
    throw new ApiError(503, "ASSISTANT_CHANNEL_UNSUPPORTED", "This assistant channel is not available yet");
  const text = event.text?.trim();
  if (!text) return;
  const client = new GrowthAgentClient(core.config);
  const scope = { tenantId: grant.orgId, actor: growthAgentActor(core.config, grant.actorId) };
  let conversationId = await conversationFor(core, grant, event, client);
  let submitted;
  try {
    submitted = await client.command(scope, "turns.submit", { conversationId, text });
  } catch (error) {
    if (!(error instanceof Error) || !/not found|unavailable|conversation/i.test(error.message))
      throw error;
    await core.pool.query(
      `DELETE FROM "GrowthAgentChannelConversation" WHERE "grantId"=$1 AND "externalConversationId"=$2`,
      [grant.grantId, event.externalConversationId],
    );
    conversationId = await conversationFor(core, grant, event, client);
    submitted = await client.command(scope, "turns.submit", { conversationId, text });
  }
  let task = submitted.task;
  const deadline = Date.now() + 60_000;
  while (!TERMINAL_TASK_STATES.has(task.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    task = (await client.command(scope, "tasks.get", { taskId: task.id })).task;
  }
  if (task.state === "waiting_review") {
    await sendGrowthAgentChannelMessage(
      core,
      {
        version: "1",
        requestId: randomUUID(),
        operation: "message.send",
        actor: scope.actor,
        workspaceId: grant.agentsWorkspaceId,
        agentId: grant.agentsAgentId,
        deliveryId: randomUUID(),
        grantId: grant.grantId,
        agentsConnectionId: grant.agentsConnectionId,
        provider: grant.provider,
        providerAssetId: grant.providerAssetId,
        message: {
          recipientId: event.senderId,
          text: "This request needs review in Growth before I can complete it.",
        },
      },
      grant.actorId,
    );
    logger.info({
      event: "growth.agent_channel.assistant.review",
      grant_id: grant.grantId,
      task_id: task.id,
    });
    return;
  }
  if (task.state !== "completed" || !task.output?.trim())
    throw new ApiError(503, "ASSISTANT_CHANNEL_INCOMPLETE", "The Growth assistant could not complete the message");
  await sendGrowthAgentChannelMessage(
    core,
    {
      version: "1",
      requestId: randomUUID(),
      operation: "message.send",
      actor: scope.actor,
      workspaceId: grant.agentsWorkspaceId,
      agentId: grant.agentsAgentId,
      deliveryId: randomUUID(),
      grantId: grant.grantId,
      agentsConnectionId: grant.agentsConnectionId,
      provider: grant.provider,
      providerAssetId: grant.providerAssetId,
      message: {
        recipientId: event.senderId,
        text: task.output,
        ...(event.providerMessageId
          ? { replyToProviderMessageId: event.providerMessageId }
          : {}),
      },
    },
    grant.actorId,
  );
  logger.info({
    event: "growth.agent_channel.assistant.delivered",
    grant_id: grant.grantId,
    task_id: task.id,
  });
}
