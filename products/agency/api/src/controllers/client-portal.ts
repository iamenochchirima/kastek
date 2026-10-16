import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import {
  extractTenantClientUserSession,
  requireClientScopedConversation,
} from "../middleware.js";
import { missing } from "../error.js";
import { count, id } from "./read-helpers.js";
import { SQL } from "./client-portal-sql.js";
export function registerClientPortalRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get("/api/client/overview", async (request) => {
    const s = await extractTenantClientUserSession(request, context);
    const r = (
      await context.pool.query(SQL.get_overview[0], [
        s.workspace_id,
        s.tenant_client_id,
      ])
    ).rows[0];
    return {
      overview: {
        workspaceId: s.workspace_id,
        workspaceSlug: s.workspace_slug,
        tenantClientId: s.tenant_client_id,
        tenantClientName: s.tenant_client_name,
        totalUsers: count(r.total_users),
        totalConversations: count(r.total_conversations),
        openConversations: count(r.unread_or_open_conversations),
        totalMessages: count(r.total_messages),
      },
    };
  });
  app.get("/api/client/conversations", async (request) => {
    const s = await extractTenantClientUserSession(request, context);
    return {
      conversations: (
        await context.pool.query(SQL.list_conversations[0], [
          s.workspace_id,
          s.tenant_client_id,
        ])
      ).rows,
    };
  });
  app.get("/api/client/conversations/:id", async (request) => {
    const s = await extractTenantClientUserSession(request, context);
    const conversation = id(request);
    await requireClientScopedConversation(
      context.pool,
      s.workspace_id,
      s.tenant_client_id,
      conversation,
    );
    const row = (
      await context.pool.query(SQL.get_conversation[0], [
        s.workspace_id,
        s.tenant_client_id,
        conversation,
      ])
    ).rows[0];
    if (!row) throw missing("conversation not found");
    return { conversation: row };
  });
  app.get("/api/client/conversations/:id/messages", async (request) => {
    const s = await extractTenantClientUserSession(request, context);
    const conversation = id(request);
    await requireClientScopedConversation(
      context.pool,
      s.workspace_id,
      s.tenant_client_id,
      conversation,
    );
    return {
      conversationId: conversation,
      messages: (
        await context.pool.query(SQL.list_messages[0], [
          s.workspace_id,
          conversation,
        ])
      ).rows,
    };
  });
}
