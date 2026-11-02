import type { FastifyInstance } from "fastify";
import { createId } from "@paralleldrive/cuid2";
import type { TenantContext } from "../context.js";
import type { TenantUserSessionContext } from "../types.js";
import { transaction } from "../db.js";
import { bad, missing, internal } from "../error.js";
import * as middleware from "../middleware.js";
import * as analytics from "../analytics.js";
import { issueClientInvite } from "./client-auth.js";
import { asciiLower } from "./workspace.js";
import { normalizeReportingTimezone } from "./admin.js";
export function normalizeSlug(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export function normalizeAssignmentRole(input: string | null | undefined) {
  const role = asciiLower((input ?? "member").trim());
  if (!["owner", "admin", "member", "viewer"].includes(role))
    throw bad("assignmentRole must be owner, admin, member, or viewer");
  return role;
}
const manage = (roles: string[]) =>
  middleware.requireTenantRoles(roles, ["owner", "admin", "account_manager"]);
export async function provisionClientUserInvite(
  context: TenantContext,
  workspaceId: string,
  slug: string,
  clientId: string,
  inputEmail: string,
  name: string | null,
  role: string,
  actor: string | null,
) {
  await middleware.requireActiveTenantClient(
    context.pool,
    workspaceId,
    clientId,
  );
  const email = asciiLower(inputEmail.trim());
  if (!email) throw bad("email is required");
  if (
    (
      await context.pool.query(
        `SELECT id FROM tenant_client_users WHERE tenant_client_id=$1 AND lower(email)=lower($2) AND status='active' LIMIT 1`,
        [clientId, email],
      )
    ).rows.length
  )
    throw bad("client user is already active");
  const user = (
    await context.pool.query(
      `INSERT INTO tenant_client_users(id,workspace_id,tenant_client_id,email,name,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'invited',NOW(),NOW()) ON CONFLICT(tenant_client_id,email) DO UPDATE SET name=EXCLUDED.name,status='invited',updated_at=NOW() RETURNING id`,
      [createId(), workspaceId, clientId, email, name?.trim() || null],
    )
  ).rows[0]!;
  await context.pool.query(
    `INSERT INTO tenant_client_user_roles(tenant_client_user_id,role,created_at) VALUES($1,$2,NOW()) ON CONFLICT(tenant_client_user_id,role) DO NOTHING`,
    [user.id, role],
  );
  await context.pool.query(
    `UPDATE tenant_client_invites SET revoked_at=NOW(),updated_at=NOW() WHERE tenant_client_user_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [user.id],
  );
  return {
    userId: user.id as string,
    invite: await issueClientInvite(
      context,
      workspaceId,
      slug,
      clientId,
      user.id,
      email,
      actor,
    ),
  };
}
async function clientEvents(
  tx: import("pg").PoolClient,
  workspace: string,
  client: string,
  timezone: string,
  status: string,
  action: string,
) {
  const now = new Date();
  try {
    await analytics.enqueueClientScopeDefinition(
      tx,
      workspace,
      client,
      now.getTime(),
      timezone,
      status,
    );
  } catch (e) {
    throw internal(`analytics client scope enqueue failed: ${e}`);
  }
  try {
    await analytics.enqueueClientLifecycle(
      tx,
      workspace,
      client,
      action,
      status,
      now,
    );
  } catch (e) {
    throw internal(`analytics client lifecycle enqueue failed: ${e}`);
  }
  const count = await analytics.workspaceEventCount(
    tx,
    `workspace:${workspace}:clients`,
  );
  try {
    await analytics.enqueueClientManifest(tx, workspace, count, now);
  } catch (e) {
    throw internal(`analytics client manifest enqueue failed: ${e}`);
  }
}
export async function changeClientStatus(
  context: TenantContext,
  workspace: string,
  client: string,
  input: string,
) {
  const requested = asciiLower(input.trim()),
    status = requested === "deleted" ? "archived" : requested;
  if (!["active", "suspended", "archived"].includes(status))
    throw bad("status must be active, suspended, or archived");
  return transaction(context.pool, (tx) => changeClientStatusInTransaction(tx, workspace, client, requested));
}

/** Caller owns the transaction so state, lifecycle outbox and command receipt commit together. */
export async function changeClientStatusInTransaction(
  tx: import("pg").PoolClient,
  workspace: string,
  client: string,
  input: string,
) {
  const requested = asciiLower(input.trim()), status = requested === "deleted" ? "archived" : requested;
  if (!["active", "suspended", "archived"].includes(status)) throw bad("status must be active, suspended, or archived");

  const row = (
    await tx.query(
      `SELECT c.status,COALESCE(c.reporting_timezone,w.reporting_timezone) AS timezone FROM tenant_clients c JOIN workspaces w ON w.id=c.workspace_id WHERE c.id=$1 AND c.workspace_id=$2 FOR UPDATE`,
      [client, workspace],
    )
  ).rows[0];
  if (!row) throw missing("tenant client not found");
  if (row.status === status)
    return { clientId: client, status: requested, changed: false };
  await tx.query(
    `UPDATE tenant_clients SET status=$1,updated_at=NOW() WHERE id=$2 AND workspace_id=$3`,
    [status, client, workspace],
  );
  await clientEvents(
    tx,
    workspace,
    client,
    row.timezone,
    status === "archived" ? "deleted" : status,
    status === "active"
      ? "activated"
      : status === "archived"
        ? "deleted"
        : "suspended",
  );
  return { clientId: client, status: requested, changed: true };
}

async function assignmentEvents(
  tx: import("pg").PoolClient,
  session: TenantUserSessionContext,
  client: string,
  user: string,
  id: string,
  action: string,
  status: string,
  role: string,
) {
  const history = createId(),
    now = new Date();
  await tx.query(
    `INSERT INTO tenant_client_assignment_history(id,workspace_id,tenant_client_id,tenant_user_id,assignment_id,action,assignment_role,actor_tenant_user_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      history,
      session.workspace_id,
      client,
      user,
      id,
      action,
      role,
      session.tenant_user_id,
      now,
    ],
  );
  try {
    await analytics.enqueueClientAssignmentLifecycle(
      tx,
      session.workspace_id,
      client,
      user,
      id,
      action,
      status,
      role,
      history,
      now,
    );
  } catch (e) {
    throw internal(`analytics assignment enqueue failed: ${e}`);
  }
  const count = await analytics.workspaceEventCount(
    tx,
    `workspace:${session.workspace_id}:assignments`,
  );
  try {
    await analytics.enqueueAssignmentManifest(
      tx,
      session.workspace_id,
      count,
      now,
    );
  } catch (e) {
    throw internal(`analytics assignment manifest enqueue failed: ${e}`);
  }
}
export async function assignClientUser(
  context: TenantContext,
  session: TenantUserSessionContext,
  client: string,
  inputUser: string,
  inputRole: string | null,
) {
  const user = inputUser.trim();
  if (!user) throw bad("tenantUserId is required");
  const role = normalizeAssignmentRole(inputRole);
  return transaction(context.pool, async (tx) => {
    if (
      !(
        await tx.query(
          `SELECT 1 FROM tenant_clients WHERE id=$1 AND workspace_id=$2 AND status<>'archived'`,
          [client, session.workspace_id],
        )
      ).rows.length
    )
      throw missing("active tenant client not found");
    if (
      !(
        await tx.query(
          `SELECT 1 FROM tenant_users WHERE id=$1 AND workspace_id=$2 AND status='active'`,
          [user, session.workspace_id],
        )
      ).rows.length
    )
      throw missing("active workspace staff member not found");
    const old = (
      await tx.query(
        `SELECT id,status,assignment_role FROM tenant_client_assignments WHERE workspace_id=$1 AND tenant_client_id=$2 AND tenant_user_id=$3 FOR UPDATE`,
        [session.workspace_id, client, user],
      )
    ).rows[0];
    let id: string, action: string;
    if (!old) {
      id = createId();
      action = "assigned";
      await tx.query(
        `INSERT INTO tenant_client_assignments(id,workspace_id,tenant_client_id,tenant_user_id,assignment_role,status) VALUES($1,$2,$3,$4,$5,'active')`,
        [id, session.workspace_id, client, user, role],
      );
    } else if (old.status === "revoked") {
      id = old.id;
      action = "assigned";
      await tx.query(
        `UPDATE tenant_client_assignments SET assignment_role=$1,status='active',revoked_at=NULL,assigned_at=NOW(),updated_at=NOW() WHERE id=$2`,
        [role, id],
      );
    } else if (old.assignment_role === role)
      return {
        tenantClientId: client,
        tenantUserId: user,
        assignmentRole: role,
        status: "active",
        changed: false,
      };
    else {
      id = old.id;
      action = "role_changed";
      await tx.query(
        `UPDATE tenant_client_assignments SET assignment_role=$1,updated_at=NOW() WHERE id=$2`,
        [role, id],
      );
    }
    await assignmentEvents(
      tx,
      session,
      client,
      user,
      id,
      action,
      "active",
      role,
    );
    return {
      tenantClientId: client,
      tenantUserId: user,
      assignmentId: id,
      action,
      assignmentRole: role,
      status: "active",
      changed: true,
    };
  });
}
export async function removeClientAssignment(
  context: TenantContext,
  session: TenantUserSessionContext,
  client: string,
  user: string,
) {
  return transaction(context.pool, async (tx) => {
    const old = (
      await tx.query(
        `SELECT id,status,assignment_role FROM tenant_client_assignments WHERE workspace_id=$1 AND tenant_client_id=$2 AND tenant_user_id=$3 FOR UPDATE`,
        [session.workspace_id, client, user],
      )
    ).rows[0];
    if (!old) throw missing("client assignment not found");
    if (old.status === "revoked")
      return {
        tenantClientId: client,
        tenantUserId: user,
        status: "revoked",
        changed: false,
      };
    await tx.query(
      `UPDATE tenant_client_assignments SET status='revoked',revoked_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [old.id],
    );
    await assignmentEvents(
      tx,
      session,
      client,
      user,
      old.id,
      "unassigned",
      "revoked",
      old.assignment_role,
    );
    return {
      tenantClientId: client,
      tenantUserId: user,
      assignmentId: old.id,
      action: "unassigned",
      status: "revoked",
      changed: true,
    };
  });
}
const nullable = { anyOf: [{ type: "string" }, { type: "null" }] };
const bodySchema = (required: string[], optional: string[] = []) => ({
  type: "object",
  required,
  properties: Object.fromEntries([
    ...required.map((k) => [k, { type: "string" }]),
    ...optional.map((k) => [k, nullable]),
  ]),
});
export function registerClientsRoutes(
  app: FastifyInstance,
  context: TenantContext,
) {
  app.get("/api/clients", async (r) => {
    const s = await middleware.extractTenantUserSession(r, context);
    const clients = (
      await context.pool.query(
        `SELECT c.id,c.name,c.slug,c.status,COUNT(DISTINCT u.id)::bigint AS user_count,c.external_ref,c.metadata,c.created_at,c.updated_at FROM tenant_clients c LEFT JOIN tenant_client_users u ON u.workspace_id=c.workspace_id AND u.tenant_client_id=c.id WHERE c.workspace_id=$1 GROUP BY c.id,c.name,c.slug,c.status,c.external_ref,c.metadata,c.created_at,c.updated_at ORDER BY c.updated_at DESC,c.created_at DESC`,
        [s.workspace_id],
      )
    ).rows.map((row) => ({ ...row, user_count: BigInt(row.user_count) }));
    return { workspaceId: s.workspace_id, clients };
  });
  app.post<{
    Body: {
      name: string;
      adminEmail: string;
      slug?: string | null;
      external_ref?: string | null;
      reportingTimezone?: string | null;
    };
  }>(
    "/api/clients",
    {
      schema: {
        body: bodySchema(
          ["name", "adminEmail"],
          ["slug", "external_ref", "reportingTimezone"],
        ),
      },
    },
    async (r) => {
      const s = await middleware.extractTenantUserSession(r, context);
      manage(s.roles);
      const b = r.body,
        name = b.name.trim(),
        slug = (b.slug ? normalizeSlug(b.slug) : "") || normalizeSlug(name),
        email = asciiLower(b.adminEmail.trim());
      if (!name || !slug) throw bad("name and slug are required");
      if (!email || !email.includes("@") || email.includes(" "))
        throw bad("adminEmail must be a valid email address");
      const timezone = normalizeReportingTimezone(b.reportingTimezone ?? null),
        id = createId();
      await transaction(context.pool, async (tx) => {
        try {
          await tx.query(
            `INSERT INTO tenant_clients(id,workspace_id,name,slug,external_ref,reporting_timezone,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
            [
              id,
              s.workspace_id,
              name,
              slug,
              b.external_ref?.trim() || null,
              timezone,
            ],
          );
        } catch {
          throw bad("client slug already exists for this workspace");
        }
        await clientEvents(
          tx,
          s.workspace_id,
          id,
          timezone,
          "active",
          "created",
        );
      });
      const { invite } = await provisionClientUserInvite(
        context,
        s.workspace_id,
        s.workspace_slug,
        id,
        email,
        null,
        "owner",
        s.tenant_user_id,
      );
      return {
        client: {
          id,
          workspaceId: s.workspace_id,
          name,
          slug,
          externalRef: b.external_ref ?? null,
          status: "active",
        },
        adminInvite: {
          email,
          emailSent: invite.email_sent,
          activationUrl: invite.activation_url,
          portalUrl: invite.portal_url,
          expiresAt: invite.expires_at,
        },
      };
    },
  );
  app.patch<{ Params: { id: string }; Body: { status: string } }>(
    "/api/clients/:id/status",
    { schema: { body: bodySchema(["status"]) } },
    async (r) => {
      const s = await middleware.extractTenantUserSession(r, context);
      manage(s.roles);
      return changeClientStatus(
        context,
        s.workspace_id,
        r.params.id,
        r.body.status,
      );
    },
  );
  app.get<{ Params: { id: string } }>("/api/clients/:id/users", async (r) => {
    const s = await middleware.extractTenantUserSession(r, context);
    manage(s.roles);
    return {
      workspaceId: s.workspace_id,
      tenantClientId: r.params.id,
      users: (
        await context.pool.query(
          `SELECT id,tenant_client_id,email,name,status,created_at,updated_at FROM tenant_client_users WHERE workspace_id=$1 AND tenant_client_id=$2 ORDER BY updated_at DESC,created_at DESC`,
          [s.workspace_id, r.params.id],
        )
      ).rows,
    };
  });
  app.post<{
    Params: { id: string };
    Body: { email: string; name?: string | null; role?: string | null };
  }>(
    "/api/clients/:id/invites",
    { schema: { body: bodySchema(["email"], ["name", "role"]) } },
    async (r) => {
      const s = await middleware.extractTenantUserSession(r, context);
      manage(s.roles);
      const email = asciiLower(r.body.email.trim()),
        role = asciiLower((r.body.role ?? "member").trim());
      const { userId, invite } = await provisionClientUserInvite(
        context,
        s.workspace_id,
        s.workspace_slug,
        r.params.id,
        email,
        r.body.name ?? null,
        role,
        s.tenant_user_id,
      );
      return {
        invite: {
          id: invite.invite_id,
          tenantClientId: r.params.id,
          tenantClientUserId: userId,
          email,
          role,
          expiresAt: invite.expires_at,
          activationUrl: invite.activation_url,
          portalUrl: invite.portal_url,
          emailSent: invite.email_sent,
        },
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/clients/:id/assignments",
    async (r) => {
      const s = await middleware.extractTenantUserSession(r, context);
      manage(s.roles);
      if (
        !(
          await context.pool.query(
            `SELECT 1 FROM tenant_clients WHERE id=$1 AND workspace_id=$2`,
            [r.params.id, s.workspace_id],
          )
        ).rows.length
      )
        throw missing("tenant client not found");
      return {
        workspaceId: s.workspace_id,
        tenantClientId: r.params.id,
        assignments: (
          await context.pool.query(
            `SELECT a.id,a.tenant_user_id,u.email,u.name,a.assignment_role,a.status,a.assigned_at,a.revoked_at,a.created_at,a.updated_at FROM tenant_client_assignments a JOIN tenant_users u ON u.id=a.tenant_user_id WHERE a.workspace_id=$1 AND a.tenant_client_id=$2 ORDER BY a.status ASC,a.updated_at DESC,a.created_at DESC`,
            [s.workspace_id, r.params.id],
          )
        ).rows,
      };
    },
  );
  app.post<{
    Params: { id: string };
    Body: { tenantUserId: string; assignmentRole?: string | null };
  }>(
    "/api/clients/:id/assignments",
    { schema: { body: bodySchema(["tenantUserId"], ["assignmentRole"]) } },
    async (r) => {
      const s = await middleware.extractTenantUserSession(r, context);
      manage(s.roles);
      return assignClientUser(
        context,
        s,
        r.params.id,
        r.body.tenantUserId,
        r.body.assignmentRole ?? null,
      );
    },
  );
  app.delete<{ Params: { id: string; tenant_user_id: string } }>(
    "/api/clients/:id/assignments/:tenant_user_id",
    async (r) => {
      const s = await middleware.extractTenantUserSession(r, context);
      manage(s.roles);
      return removeClientAssignment(
        context,
        s,
        r.params.id,
        r.params.tenant_user_id,
      );
    },
  );
}
