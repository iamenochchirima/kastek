import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { missing } from "../error.js";
import { access, CONVERSATION_ROLES, id } from "./read-helpers.js";
import { SQL } from "./conversations-sql.js";
export function registerConversationsRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get("/api/conversations", async (request) => {
    const s = await access(request, context, CONVERSATION_ROLES);
    return {
      workspaceId: s.workspace_id,
      conversations: (
        await context.pool.query(SQL.list_conversations[0], [s.workspace_id])
      ).rows,
    };
  });
  app.get("/api/conversations/:id", async (request) => {
    const s = await access(request, context, CONVERSATION_ROLES);
    const row = (
      await context.pool.query(SQL.get_conversation[0], [
        s.workspace_id,
        id(request),
      ])
    ).rows[0];
    if (!row) throw missing("conversation not found");
    return { workspaceId: s.workspace_id, conversation: row };
  });
  app.get("/api/conversations/:id/messages", async (request) => {
    const s = await access(request, context, CONVERSATION_ROLES);
    const conversation = id(request);
    if (
      !(
        await context.pool.query(SQL.list_messages[0], [
          s.workspace_id,
          conversation,
        ])
      ).rows[0]
    )
      throw missing("conversation not found");
    return {
      workspaceId: s.workspace_id,
      conversationId: conversation,
      messages: (
        await context.pool.query(SQL.list_messages[1], [
          s.workspace_id,
          conversation,
        ])
      ).rows,
    };
  });
}
