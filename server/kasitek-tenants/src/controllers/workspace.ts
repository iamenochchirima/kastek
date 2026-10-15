import type { FastifyInstance } from "fastify";
import type { PoolClient, QueryResultRow } from "pg";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { hash } from "bcryptjs";
import { createId } from "@paralleldrive/cuid2";
import type { TenantContext } from "../context.js";
import type { TenantAccessContext } from "../types.js";
import { transaction } from "../db.js";
import { bad, forbidden, missing } from "../error.js";
import * as middleware from "../middleware.js";
import { issueAdminInvite } from "./admin-invites.js";
export const asciiLower = (s: string) =>
  s.replace(/[A-Z]/g, (c) => c.toLowerCase());
export function hostedWorkspaceDomain(slug: string, base: string | null) {
  const value = base?.trim().replace(/^\.+|\.+$/g, "");
  return value ? `${slug}.${asciiLower(value)}` : null;
}
export function normalizeDomain(value: string) {
  const normalized = asciiLower(value.trim())
    .replace(/^http:\/\//, "")
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "")
    .split("/")[0]!
    .trim();
  if (!normalized) throw bad("domain is required");
  if (normalized.includes(" ") || !normalized.includes("."))
    throw bad("domain must be a valid hostname");
  return normalized;
}
export function verificationMessage(
  status: string,
  domain: string,
  target: string | null,
) {
  if (target) {
    if (status === "verified")
      return `${domain} resolves to the shared portal target ${target}.`;
    if (status === "misconfigured")
      return `${domain} resolves publicly, but it does not currently point to the shared portal target ${target}.`;
    if (status === "pending")
      return `${domain} does not resolve to the shared portal target ${target} yet.`;
  }
  if (status === "verified") return `${domain} resolves publicly.`;
  if (status === "misconfigured")
    return `${domain} resolves publicly, but verification could not confirm the expected platform target.`;
  return `${domain} is not reachable in DNS yet.`;
}
export async function resolveIps(host: string) {
  try {
    return new Set(
      (await lookup(host, { all: true })).map((row) => row.address),
    );
  } catch {
    return new Set<string>();
  }
}
export async function syncWorkspaceCustomDomain(
  tx: PoolClient,
  workspaceId: string,
) {
  const primary =
    (
      await tx.query(
        `SELECT domain FROM workspace_domains WHERE workspace_id=$1 AND is_primary=TRUE ORDER BY created_at ASC LIMIT 1`,
        [workspaceId],
      )
    ).rows[0]?.domain ?? null;
  await tx.query(
    `UPDATE workspace_branding SET custom_domain=$1,updated_at=NOW() WHERE workspace_id=$2`,
    [primary, workspaceId],
  );
}
const staffSelect = `SELECT u.id,u.email,u.name,u.status,COALESCE(json_agg(r.role ORDER BY r.created_at) FILTER(WHERE r.role IS NOT NULL),'[]'::json) AS roles,u.created_at,u.last_login_at FROM tenant_users u LEFT JOIN tenant_user_roles r ON r.tenant_user_id=u.id`;
const staffGroup = ` GROUP BY u.id,u.email,u.name,u.status,u.created_at,u.last_login_at`;
export const staffView = (row: QueryResultRow) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  status: row.status,
  roles: row.roles,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
});
export function normalizeStaffRole(value: string | null | undefined) {
  const role = asciiLower((value ?? "admin").trim());
  if (!role) throw bad("role is required");
  if (
    !["owner", "admin", "account_manager", "support", "viewer"].includes(role)
  )
    throw bad("invalid staff role");
  return role;
}
export function normalizeStaffEmail(value: string) {
  const email = asciiLower(value.trim());
  if (!email) throw bad("email is required");
  if (!email.includes("@")) throw bad("email must be valid");
  return email;
}
export async function listStaff(context: TenantContext, workspaceId: string) {
  return {
    staff: (
      await context.pool.query(
        `${staffSelect} WHERE u.workspace_id=$1${staffGroup} ORDER BY u.created_at DESC`,
        [workspaceId],
      )
    ).rows.map(staffView),
  };
}
export async function addStaff(
  context: TenantContext,
  access: TenantAccessContext,
  body: { email: string; name?: string | null; role?: string | null },
) {
  const email = normalizeStaffEmail(body.email),
    role = normalizeStaffRole(body.role),
    name = body.name?.trim() || null;
  const existing = (
    await context.pool.query(
      `${staffSelect} WHERE u.workspace_id=$1 AND lower(u.email)=lower($2)${staffGroup} LIMIT 1`,
      [access.workspace_id, email],
    )
  ).rows[0];
  if (
    existing &&
    (
      await context.pool.query(
        `SELECT 1 FROM agency_partner_memberships WHERE workspace_id=$1 AND tenant_user_id=$2 LIMIT 1`,
        [access.workspace_id, existing.id],
      )
    ).rowCount
  )
    throw forbidden();
  let userId: string;
  if (
    existing &&
    existing.status === "active" &&
    Array.isArray(existing.roles)
  ) {
    await context.pool.query(
      `INSERT INTO tenant_user_roles(tenant_user_id,role,created_at) VALUES($1,$2,NOW()) ON CONFLICT DO NOTHING`,
      [existing.id, role],
    );
    return {
      status: 200,
      body: { staff: staffView(existing), inviteSent: false },
    };
  }
  const password = await hash(randomBytes(24).toString("base64url"), 12);
  if (existing) {
    userId = existing.id;
    await context.pool.query(
      `UPDATE tenant_users SET name=COALESCE($1,name),password_hash=$2,status='pending',updated_at=NOW() WHERE id=$3 AND workspace_id=$4`,
      [name, password, userId, access.workspace_id],
    );
    await context.pool.query(
      `DELETE FROM tenant_user_roles WHERE tenant_user_id=$1`,
      [userId],
    );
  } else {
    userId = createId();
    await context.pool.query(
      `INSERT INTO tenant_users(id,workspace_id,email,password_hash,name,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'pending',NOW(),NOW())`,
      [userId, access.workspace_id, email, password, name],
    );
  }
  await context.pool.query(
    `INSERT INTO tenant_user_roles(tenant_user_id,role,created_at) VALUES($1,$2,NOW())`,
    [userId, role],
  );
  const workspace =
    (
      await context.pool.query(
        `SELECT display_name FROM workspaces WHERE id=$1 LIMIT 1`,
        [access.workspace_id],
      )
    ).rows[0]?.display_name ?? access.workspace_slug;
  const issued = await issueAdminInvite(
    context,
    access.workspace_id,
    access.workspace_slug,
    workspace,
    userId,
    email,
  );
  const invite = {
    activationUrl: issued.activation_url,
    portalUrl: issued.portal_url,
    emailSent: issued.email_sent,
    expiresAt: issued.expires_at,
  };
  const staff = (
    await context.pool.query(
      `${staffSelect} WHERE u.id=$1${staffGroup} LIMIT 1`,
      [userId],
    )
  ).rows[0]!;
  return {
    status: 201,
    body: { staff: staffView(staff), invite, inviteSent: invite.emailSent },
  };
}
export async function removeStaff(
  context: TenantContext,
  workspaceId: string,
  userId: string,
  actorId: string | null,
) {
  if (actorId === userId) throw bad("you cannot remove your own account");
  const target = (
    await context.pool.query(
      `SELECT
         EXISTS(SELECT 1 FROM tenant_user_roles WHERE tenant_user_id=$1 AND role='owner') AS is_owner,
         EXISTS(SELECT 1 FROM agency_partner_memberships WHERE workspace_id=$2 AND tenant_user_id=$1) AS is_primary_partner`,
      [userId, workspaceId],
    )
  ).rows[0];
  if (target.is_owner || target.is_primary_partner)
    throw bad("owner access must be transferred before this account can be removed");
  if (
    !(
      await context.pool.query(
        `DELETE FROM tenant_users WHERE id=$1 AND workspace_id=$2 RETURNING id`,
        [userId, workspaceId],
      )
    ).rows[0]
  )
    throw missing("staff user not found");
  return { deleted: true };
}
const domainSelect = `SELECT id,domain,is_primary,dns_status,verified_at,created_at FROM workspace_domains`;
const PUBLIC_PORTAL_FEATURES = new Set([
  "dashboard", "clients", "leads", "content", "reporting", "nurturing",
  "aeo", "voice", "reviews", "adcreative",
]);
function publicWidgetConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  if (typeof source.tagline === "string") safe.tagline = source.tagline.trim().slice(0, 160);
  if (source.features && typeof source.features === "object" && !Array.isArray(source.features)) {
    const features = Object.fromEntries(Object.entries(source.features)
      .filter(([key, enabled]) => PUBLIC_PORTAL_FEATURES.has(key) && typeof enabled === "boolean"));
    if (Object.keys(features).length) safe.features = features;
  }
  if (Array.isArray(source.enabledModules)) {
    const modules = source.enabledModules.filter((item): item is string =>
      typeof item === "string" && PUBLIC_PORTAL_FEATURES.has(item));
    if (modules.length) safe.enabledModules = [...new Set(modules)];
  }
  return safe;
}
export function domainView(context: TenantContext, row: QueryResultRow) {
  return {
    id: row.id,
    domain: row.domain,
    isPrimary: row.is_primary,
    dnsStatus: row.dns_status,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    verificationMessage: verificationMessage(
      row.dns_status,
      row.domain,
      context.config.portal_host_target,
    ),
  };
}
export async function listDomains(
  context: TenantContext,
  workspaceId: string,
  slug: string,
) {
  return {
    hostedDomain: hostedWorkspaceDomain(
      slug,
      context.config.platform_base_domain,
    ),
    domains: (
      await context.pool.query(
        `${domainSelect} WHERE workspace_id=$1 ORDER BY is_primary DESC,created_at ASC`,
        [workspaceId],
      )
    ).rows.map((row) => domainView(context, row)),
    verification: {
      expectedTargetHost: context.config.portal_host_target,
      hostedDomainBase: context.config.platform_base_domain,
    },
  };
}
export async function addDomain(
  context: TenantContext,
  workspaceId: string,
  input: string,
  makePrimary: boolean,
) {
  const domain = normalizeDomain(input);
  if (
    (
      await context.pool.query(
        `SELECT id FROM workspace_domains WHERE lower(domain)=lower($1) LIMIT 1`,
        [domain],
      )
    ).rows[0]
  )
    throw bad("domain already exists");
  const id = createId();
  const primary = await transaction(context.pool, async (tx) => {
    const count = (
      await tx.query(
        `SELECT COUNT(*) AS count FROM workspace_domains WHERE workspace_id=$1`,
        [workspaceId],
      )
    ).rows[0].count;
    const primary = makePrimary || BigInt(count) === 0n;
    if (primary)
      await tx.query(
        `UPDATE workspace_domains SET is_primary=FALSE,updated_at=NOW() WHERE workspace_id=$1`,
        [workspaceId],
      );
    await tx.query(
      `INSERT INTO workspace_domains(id,workspace_id,domain,is_primary,dns_status,created_at,updated_at) VALUES($1,$2,$3,$4,'pending',NOW(),NOW())`,
      [id, workspaceId, domain, primary],
    );
    await syncWorkspaceCustomDomain(tx, workspaceId);
    return primary;
  });
  return {
    domain: {
      id,
      domain,
      isPrimary: primary,
      dnsStatus: "pending",
      verifiedAt: null,
      verificationMessage: verificationMessage(
        "pending",
        domain,
        context.config.portal_host_target,
      ),
    },
  };
}
export async function verifyDomain(
  context: TenantContext,
  workspaceId: string,
  domainId: string,
  resolve = resolveIps,
) {
  const row = (
    await context.pool.query(
      `${domainSelect} WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
      [workspaceId, domainId],
    )
  ).rows[0];
  if (!row) throw missing("domain not found");
  const ips = await resolve(row.domain);
  let status = "pending";
  if (ips.size) {
    if (context.config.portal_host_target) {
      const targets = await resolve(context.config.portal_host_target);
      status =
        targets.size && [...ips].some((ip) => targets.has(ip))
          ? "verified"
          : "misconfigured";
    } else status = "verified";
  }
  await context.pool.query(
    `UPDATE workspace_domains SET dns_status=$1,verified_at=CASE WHEN $1='verified' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$2 AND workspace_id=$3`,
    [status, domainId, workspaceId],
  );
  return {
    domain: {
      id: row.id,
      domain: row.domain,
      isPrimary: row.is_primary,
      dnsStatus: status,
      verifiedAt: status === "verified" ? new Date() : null,
      verificationMessage: verificationMessage(
        status,
        row.domain,
        context.config.portal_host_target,
      ),
    },
  };
}
export async function setPrimaryDomain(
  context: TenantContext,
  workspaceId: string,
  id: string,
) {
  await transaction(context.pool, async (tx) => {
    if (
      !(
        await tx.query(
          `SELECT id FROM workspace_domains WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
          [workspaceId, id],
        )
      ).rows[0]
    )
      throw missing("domain not found");
    await tx.query(
      `UPDATE workspace_domains SET is_primary=FALSE,updated_at=NOW() WHERE workspace_id=$1`,
      [workspaceId],
    );
    await tx.query(
      `UPDATE workspace_domains SET is_primary=TRUE,updated_at=NOW() WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, id],
    );
    await syncWorkspaceCustomDomain(tx, workspaceId);
  });
  return { updated: true };
}
export async function removeDomain(
  context: TenantContext,
  workspaceId: string,
  id: string,
) {
  await transaction(context.pool, async (tx) => {
    const row = (
      await tx.query(
        `${domainSelect} WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
        [workspaceId, id],
      )
    ).rows[0];
    if (!row) throw missing("domain not found");
    await tx.query(
      `DELETE FROM workspace_domains WHERE id=$1 AND workspace_id=$2`,
      [id, workspaceId],
    );
    if (row.is_primary) {
      const next = (
        await tx.query(
          `SELECT id FROM workspace_domains WHERE workspace_id=$1 ORDER BY created_at ASC LIMIT 1`,
          [workspaceId],
        )
      ).rows[0]?.id;
      if (next)
        await tx.query(
          `UPDATE workspace_domains SET is_primary=TRUE,updated_at=NOW() WHERE id=$1 AND workspace_id=$2`,
          [next, workspaceId],
        );
    }
    await syncWorkspaceCustomDomain(tx, workspaceId);
  });
  return { deleted: true };
}
export const staffSchema = {
  type: "object",
  required: ["email"],
  properties: {
    email: { type: "string" },
    name: { anyOf: [{ type: "string" }, { type: "null" }] },
    role: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};
export const domainSchema = {
  type: "object",
  required: ["domain"],
  properties: {
    domain: { type: "string" },
    makePrimary: { anyOf: [{ type: "boolean" }, { type: "null" }] },
  },
};
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  context: TenantContext,
) {
  const access = async (
    request: Parameters<typeof middleware.extractAccessContext>[0],
    admin: boolean,
  ) => {
    const result = await middleware.extractAccessContext(request, context);
    if (admin)
      middleware.requireTenantRoles(result.tenant_user_roles, [
        "owner",
        "admin",
      ]);
    else if (result.tenant_user_id !== null)
      middleware.requireTenantRoles(result.tenant_user_roles, [
        "owner",
        "admin",
        "account_manager",
        "viewer",
        "support",
      ]);
    return result;
  };
  const requirePartnerDomainSetup = (request: Parameters<typeof middleware.extractAccessContext>[0]) => {
    if (middleware.hasAgencyPartnerCookie(request, context))
      throw forbidden();
  };
  app.get("/api/workspace", async (request) => {
    const a = await access(request, false),
      row = (
        await context.pool.query(
          `SELECT id,slug,display_name,status FROM workspaces WHERE id=$1 LIMIT 1`,
          [a.workspace_id],
        )
      ).rows[0];
    if (!row) throw missing("workspace not found");
    const domains = (
      await context.pool.query(
        `SELECT domain,is_primary FROM workspace_domains WHERE workspace_id=$1 ORDER BY is_primary DESC,domain ASC`,
        [a.workspace_id],
      )
    ).rows;
    return {
      workspace: {
        id: row.id,
        slug: row.slug,
        displayName: row.display_name,
        status: row.status,
        hostedDomain: hostedWorkspaceDomain(
          row.slug,
          context.config.platform_base_domain,
        ),
        domains: domains.map((row) => ({
          domain: row.domain,
          isPrimary: row.is_primary,
        })),
        domainVerification: {
          expectedTargetHost: context.config.portal_host_target,
          hostedDomainBase: context.config.platform_base_domain,
        },
        scopes: a.scopes,
        tenantUserId: a.tenant_user_id,
        tenantUserRoles: a.tenant_user_roles,
      },
    };
  });
  app.get("/api/workspace/branding", async (request) => {
    const a = await access(request, false),
      b = (
        await context.pool.query(
          `SELECT workspace_id,display_name,primary_color,secondary_color,logo_url,widget_config FROM workspace_branding WHERE workspace_id=$1 LIMIT 1`,
          [a.workspace_id],
        )
      ).rows[0],
      customDomain =
        (
          await context.pool.query(
            `SELECT domain FROM workspace_domains WHERE workspace_id=$1 ORDER BY is_primary DESC,domain ASC LIMIT 1`,
            [a.workspace_id],
          )
        ).rows[0]?.domain ?? null;
    return {
      branding: {
        workspaceId: b?.workspace_id ?? a.workspace_id,
        displayName: b?.display_name ?? a.workspace_slug,
        primaryColor: b?.primary_color ?? null,
        secondaryColor: b?.secondary_color ?? null,
        logoUrl: b?.logo_url ?? null,
        customDomain,
        widgetConfig: b?.widget_config ?? {},
      },
    };
  });
  app.get("/api/public/tenant-context", async (request) => {
    const w = await middleware.resolveWorkspaceFromRequest(request, context),
      b = (
        await context.pool.query(
          `SELECT workspace_id,display_name,primary_color,secondary_color,logo_url,widget_config FROM workspace_branding WHERE workspace_id=$1 LIMIT 1`,
          [w.workspace_id],
        )
      ).rows[0];
    return {
      workspace: {
        id: w.workspace_id,
        slug: w.workspace_slug,
        displayName: w.display_name,
      },
      branding: b
        ? {
            displayName: b.display_name,
            primaryColor: b.primary_color,
            secondaryColor: b.secondary_color,
            logoUrl: b.logo_url,
            widgetConfig: publicWidgetConfig(b.widget_config),
          }
        : null,
    };
  });
  app.get("/api/workspace/staff", async (request) =>
    listStaff(context, (await access(request, true)).workspace_id),
  );
  app.post<{
    Body: { email: string; name?: string | null; role?: string | null };
  }>(
    "/api/workspace/staff",
    { schema: { body: staffSchema } },
    async (request, reply) => {
      const a = await access(request, true);
      if (
        middleware.hasAgencyPartnerCookie(request, context) &&
        normalizeStaffRole(request.body.role) === 'owner'
      ) throw forbidden();
      const result = await addStaff(
        context,
        a,
        request.body,
      );
      return reply.code(result.status).send(result.body);
    },
  );
  app.delete<{ Params: { user_id: string } }>(
    "/api/workspace/staff/:user_id",
    async (request) => {
      const a = await access(request, true);
      return removeStaff(
        context,
        a.workspace_id,
        request.params.user_id,
        a.tenant_user_id,
      );
    },
  );
  app.get("/api/workspace/domains", async (request) => {
    const a = await access(request, true);
    return listDomains(context, a.workspace_id, a.workspace_slug);
  });
  app.post<{ Body: { domain: string; makePrimary?: boolean | null } }>(
    "/api/workspace/domains",
    { schema: { body: domainSchema } },
    async (request, reply) => {
      const a = await access(request, true);
      requirePartnerDomainSetup(request);
      return reply.code(201).send(await addDomain(
        context,
        a.workspace_id,
        request.body.domain,
        request.body.makePrimary ?? false,
      ));
    },
  );
  app.post<{ Params: { domain_id: string } }>(
    "/api/workspace/domains/:domain_id/verify",
    async (request) => {
      const a = await access(request, true);
      requirePartnerDomainSetup(request);
      return verifyDomain(context, a.workspace_id, request.params.domain_id);
    },
  );
  app.post<{ Params: { domain_id: string } }>(
    "/api/workspace/domains/:domain_id/primary",
    async (request) => {
      const a = await access(request, true);
      requirePartnerDomainSetup(request);
      return setPrimaryDomain(context, a.workspace_id, request.params.domain_id);
    },
  );
  app.delete<{ Params: { domain_id: string } }>(
    "/api/workspace/domains/:domain_id",
    async (request) => {
      const a = await access(request, true);
      requirePartnerDomainSetup(request);
      return removeDomain(context, a.workspace_id, request.params.domain_id);
    },
  );
}
