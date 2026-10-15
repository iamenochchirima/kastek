import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { createId } from "@paralleldrive/cuid2";
import { transaction } from "../db.js";
import { bad, missing, internal } from "../error.js";
import * as middleware from "../middleware.js";
import * as analytics from "../analytics.js";
const roles = ["owner", "admin", "account_manager", "sales_manager", "support"];
export const analyticsSource = (source: string) =>
  ["voice", "whatsapp", "instagram", "web_chat", "email", "manual"].includes(
    source,
  )
    ? source
    : "other";
export const scoreBand = (score: number) =>
  score <= 49 ? "low" : score <= 74 ? "medium" : "high";
export function calculateScore(
  source: string,
  phone: boolean,
  company: boolean,
  notes: boolean,
) {
  return Math.min(
    100,
    Math.max(
      0,
      (
        {
          voice: 85,
          whatsapp: 78,
          instagram: 64,
          web_chat: 72,
          email: 60,
        } as Record<string, number>
      )[source] ?? 50,
    ) +
      (phone ? 10 : 0) +
      (company ? 8 : 0) +
      (notes ? 4 : 0),
  );
}
export function normalizeLeadStatus(value: string) {
  const status = value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (
    !["new", "qualified", "converted", "lost", "disqualified"].includes(status)
  )
    throw bad(
      "status must be new, qualified, converted, lost, or disqualified",
    );
  return status;
}
export function normalizeLeadReason(status: string, value: string | null) {
  const reason = (
    value ??
    (
      {
        new: "reopened",
        qualified: "qualified",
        converted: "converted",
        lost: "lost",
        disqualified: "disqualified",
      } as Record<string, string>
    )[status] ??
    "manual_update"
  )
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (
    ![
      "qualified",
      "converted",
      "lost",
      "disqualified",
      "reopened",
      "manual_update",
    ].includes(reason)
  )
    throw bad("reasonCode must be a bounded lead status reason");
  return reason;
}
const select = `SELECT l.id,l.tenant_client_id,c.name AS tenant_client_name,l.name,l.email,l.phone,l.company,l.source,l.status,l.score,l.notes,l.created_at,l.updated_at FROM tenant_leads l JOIN tenant_clients c ON c.id=l.tenant_client_id`;
const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const optional = (s: string | null | undefined) => s?.trim() || null;
export async function changeLeadStatus(
  context: TenantContext,
  workspaceId: string,
  clientId: string | null,
  leadId: string,
  requested: string,
  reasonCode: string | null,
  actorType: string,
  userId: string | null,
  clientUserId: string | null,
) {
  const status = normalizeLeadStatus(requested),
    reason = normalizeLeadReason(status, reasonCode);
  return transaction(context.pool, async (tx) => {
    const lead = (
      await tx.query(
        `SELECT status,tenant_client_id,source,score FROM tenant_leads WHERE id=$1 AND workspace_id=$2 AND ($3::TEXT IS NULL OR tenant_client_id=$3) FOR UPDATE`,
        [leadId, workspaceId, clientId],
      )
    ).rows[0];
    if (!lead) throw missing("lead not found");
    if (lead.status === status)
      return { tenantClientId: lead.tenant_client_id, status, changed: false };
    const historyId = createId(),
      time = new Date();
    await tx.query(
      `INSERT INTO tenant_lead_status_history(id,workspace_id,tenant_client_id,lead_id,from_status,to_status,reason_code,actor_type,changed_by_tenant_user_id,changed_by_client_user_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        historyId,
        workspaceId,
        lead.tenant_client_id,
        leadId,
        lead.status,
        status,
        reason,
        actorType,
        userId,
        clientUserId,
        time,
      ],
    );
    await tx.query(
      `UPDATE tenant_leads SET status=$1,updated_at=$2 WHERE id=$3 AND workspace_id=$4`,
      [status, time, leadId, workspaceId],
    );
    try {
      await analytics.enqueueLeadStatusChanged(
        tx,
        workspaceId,
        lead.tenant_client_id,
        leadId,
        lead.status,
        status,
        reason,
        actorType,
        analyticsSource(lead.source),
        scoreBand(lead.score),
        historyId,
        time,
      );
    } catch (error) {
      throw internal(`analytics lead status enqueue failed: ${error}`);
    }
    const count = await analytics.workspaceEventCount(
      tx,
      `workspace:${workspaceId}:leads`,
    );
    try {
      await analytics.enqueueLeadManifest(tx, workspaceId, count, time);
    } catch (error) {
      throw internal(`analytics lead manifest enqueue failed: ${error}`);
    }
    return { tenantClientId: lead.tenant_client_id, status, changed: true };
  });
}
async function stats(
  context: TenantContext,
  workspaceId: string,
  clientId: string | null,
) {
  const clause = `workspace_id=$1${clientId === null ? "" : " AND tenant_client_id=$2"}`,
    params = clientId === null ? [workspaceId] : [workspaceId, clientId];
  const row = (
    await context.pool.query(
      `SELECT COUNT(*) AS total_leads,COUNT(*) FILTER(WHERE status='qualified') AS qualified_leads,COUNT(*) FILTER(WHERE status='converted') AS converted_leads FROM tenant_leads WHERE ${clause}`,
      params,
    )
  ).rows[0];
  const byStatus = (
    await context.pool.query(
      `SELECT status,COUNT(*) AS count FROM tenant_leads WHERE ${clause} GROUP BY status ORDER BY count DESC,status ASC`,
      params,
    )
  ).rows;
  const result: Record<string, unknown> = {
    total: BigInt(row.total_leads),
    qualified: BigInt(row.qualified_leads),
    converted: BigInt(row.converted_leads),
    byStatus: byStatus.map((row) => ({ ...row, count: BigInt(row.count) })),
  };
  if (clientId === null) {
    const raw = (
      await context.pool.query(
        `SELECT DATE(created_at AT TIME ZONE 'UTC') AS date,COUNT(*) AS count FROM tenant_leads WHERE workspace_id=$1 AND created_at>=NOW()-INTERVAL '6 days' GROUP BY date ORDER BY date ASC`,
        [workspaceId],
      )
    ).rows;
    result.weeklyTrend = Array.from({ length: 7 }, (_, offset) => {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - (6 - offset));
      const day = date.toISOString().slice(0, 10);
      return {
        date: `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}`,
        count: BigInt(raw.find((row) => row.date === day)?.count ?? 0),
      };
    });
  }
  return { stats: result };
}
const statusSchema = {
  type: "object",
  required: ["status"],
  properties: {
    status: { type: "string" },
    reasonCode: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};
export function registerLeadsRoutes(
  app: FastifyInstance,
  context: TenantContext,
) {
  app.get("/api/leads", async (request) => {
    const session = await middleware.extractTenantUserSession(request, context);
    middleware.requireTenantRoles(session.roles, roles);
    return {
      leads: (
        await context.pool.query(
          `${select} WHERE l.workspace_id=$1 ORDER BY l.created_at DESC`,
          [session.workspace_id],
        )
      ).rows,
    };
  });
  app.get("/api/leads/stats", async (request) => {
    const session = await middleware.extractTenantUserSession(request, context);
    middleware.requireTenantRoles(session.roles, roles);
    return stats(context, session.workspace_id, null);
  });
  app.post<{
    Body: {
      tenantClientId: string;
      name: string;
      email: string;
      source: string;
      phone?: string | null;
      company?: string | null;
      notes?: string | null;
    };
  }>(
    "/api/leads",
    {
      schema: {
        body: {
          type: "object",
          required: ["tenantClientId", "name", "email", "source"],
          properties: Object.fromEntries(
            [
              "tenantClientId",
              "name",
              "email",
              "source",
              "phone",
              "company",
              "notes",
            ].map((key) => [
              key,
              ["phone", "company", "notes"].includes(key)
                ? { anyOf: [{ type: "string" }, { type: "null" }] }
                : { type: "string" },
            ]),
          ),
        },
      },
    },
    async (request) => {
      const session = await middleware.extractTenantUserSession(
        request,
        context,
      );
      middleware.requireTenantRoles(session.roles, roles);
      const b = request.body,
        name = b.name.trim(),
        email = asciiLower(b.email.trim()),
        source = asciiLower(b.source.trim()),
        clientId = b.tenantClientId.trim();
      if (!clientId || !name || !email)
        throw bad("tenantClientId, name, and email are required");
      let client;
      try {
        client = await middleware.requireActiveTenantClient(
          context.pool,
          session.workspace_id,
          clientId,
        );
      } catch {
        throw bad("tenant client not found");
      }
      const phone = optional(b.phone),
        company = optional(b.company),
        notes = optional(b.notes),
        score = calculateScore(
          source,
          phone !== null,
          company !== null,
          notes !== null,
        ),
        id = createId();
      await transaction(context.pool, async (tx) => {
        await tx.query(
          `INSERT INTO tenant_leads(id,workspace_id,tenant_client_id,created_by_tenant_user_id,name,email,phone,company,source,status,score,notes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'new',$10,$11,NOW(),NOW())`,
          [
            id,
            session.workspace_id,
            clientId,
            session.tenant_user_id,
            name,
            email,
            phone,
            company,
            source,
            score,
            notes,
          ],
        );
        try {
          await analytics.enqueueLeadCreated(
            tx,
            session.workspace_id,
            clientId,
            id,
            analyticsSource(source),
            scoreBand(score),
            new Date(),
          );
        } catch (error) {
          throw internal(`analytics lead event enqueue failed: ${error}`);
        }
        const count = await analytics.workspaceEventCount(
          tx,
          `workspace:${session.workspace_id}:leads`,
        );
        try {
          await analytics.enqueueLeadManifest(
            tx,
            session.workspace_id,
            count,
            new Date(),
          );
        } catch (error) {
          throw internal(`analytics lead manifest enqueue failed: ${error}`);
        }
      });
      return {
        lead: {
          id,
          tenantClientId: clientId,
          tenantClientName: client.name,
          name,
          email,
          phone,
          company,
          source,
          status: "new",
          score,
          notes,
        },
      };
    },
  );
  app.patch<{
    Params: { id: string };
    Body: { status: string; reasonCode?: string | null };
  }>(
    "/api/leads/:id/status",
    { schema: { body: statusSchema } },
    async (request) => {
      const session = await middleware.extractTenantUserSession(
        request,
        context,
      );
      middleware.requireTenantRoles(session.roles, roles);
      return changeLeadStatus(
        context,
        session.workspace_id,
        null,
        request.params.id,
        request.body.status,
        request.body.reasonCode ?? null,
        "tenant_user",
        session.tenant_user_id,
        null,
      );
    },
  );
  app.get("/api/client/leads", async (request) => {
    const session = await middleware.extractTenantClientUserSession(
      request,
      context,
    );
    return {
      tenantClientId: session.tenant_client_id,
      leads: (
        await context.pool.query(
          `${select} WHERE l.workspace_id=$1 AND l.tenant_client_id=$2 ORDER BY l.created_at DESC`,
          [session.workspace_id, session.tenant_client_id],
        )
      ).rows,
    };
  });
  app.get("/api/client/leads/stats", async (request) => {
    const session = await middleware.extractTenantClientUserSession(
      request,
      context,
    );
    return stats(context, session.workspace_id, session.tenant_client_id);
  });
  app.patch<{
    Params: { id: string };
    Body: { status: string; reasonCode?: string | null };
  }>(
    "/api/client/leads/:id/status",
    { schema: { body: statusSchema } },
    async (request) => {
      const session = await middleware.extractTenantClientUserSession(
        request,
        context,
      );
      return changeLeadStatus(
        context,
        session.workspace_id,
        session.tenant_client_id,
        request.params.id,
        request.body.status,
        request.body.reasonCode ?? null,
        "client_user",
        null,
        session.tenant_client_user_id,
      );
    },
  );
}
