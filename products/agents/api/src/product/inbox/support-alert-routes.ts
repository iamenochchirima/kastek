import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import type { InboxScope } from "./inbox-store";

export function registerSupportAlertRoutes(app: FastifyInstance, pool: Pool, resolveScope: (request: FastifyRequest) => Promise<InboxScope>) {
  const base = "/api/organizations/:organizationId/inbox-alerts";
  app.get(base, async request => {
    const scope = await resolveScope(request);
    const membership = (await pool.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL", [scope.organizationId, scope.accountId])).rowCount;
    if (!membership) throw new PlatformError("INBOX_ACCESS_DENIED", 403, "Conversation access denied");
    const rows = (await pool.query(`SELECT a.id,a.conversation_id,a.kind,a.created_at,a.acknowledged_at,c.state,c.assignee_account_id,
      (SELECT min(m.created_at) FROM agents_platform.customer_messages m JOIN agents_platform.support_waiting w ON w.task_id=a.task_id
        WHERE m.conversation_id=a.conversation_id AND m.author_kind='human' AND m.ownership_generation>=w.ownership_generation) first_human_reply_at
      FROM agents_platform.support_staff_alerts a JOIN agents_platform.customer_conversations c ON c.id=a.conversation_id AND c.organization_id=a.organization_id
      WHERE a.organization_id=$1 AND a.account_id=$2 ORDER BY a.created_at DESC,a.id DESC LIMIT 50`, [scope.organizationId, scope.accountId])).rows;
    const unread = Number((await pool.query("SELECT count(*) FROM agents_platform.support_staff_alerts WHERE organization_id=$1 AND account_id=$2 AND acknowledged_at IS NULL", [scope.organizationId, scope.accountId])).rows[0].count);
    return { unread, alerts: rows.map(row => ({ id: row.id, conversationId: row.conversation_id, kind: row.kind, createdAt: row.created_at, acknowledgedAt: row.acknowledged_at,
      state: row.state, assigneeAccountId: row.assignee_account_id, firstHumanReplyAt: row.first_human_reply_at, href: `/app/inbox?conversation=${row.conversation_id}` })) };
  });
  app.post(`${base}/:alertId/acknowledge`, async request => {
    const scope = await resolveScope(request), { alertId } = z.object({ alertId: z.uuid() }).parse(request.params);
    const row = (await pool.query(`UPDATE agents_platform.support_staff_alerts a SET acknowledged_at=coalesce(acknowledged_at,now())
      WHERE a.id=$1 AND a.organization_id=$2 AND a.account_id=$3 AND EXISTS(SELECT 1 FROM agents_platform.memberships m
        WHERE m.organization_id=a.organization_id AND m.account_id=a.account_id AND m.revoked_at IS NULL) RETURNING a.id,a.acknowledged_at`, [alertId, scope.organizationId, scope.accountId])).rows[0];
    if (!row) throw new PlatformError("INBOX_NOT_FOUND", 404, "Alert not found");
    return { id: row.id, acknowledgedAt: row.acknowledged_at };
  });
}
