import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TenantContext } from "../context.js";
import { createId } from "@paralleldrive/cuid2";
import { randomBytes, createHash } from "node:crypto";
import { hash } from "bcryptjs";
import { transaction } from "../db.js";
import { apiJson } from "../json.js";
import { bad, missing, forbidden, internal } from "../error.js";
import * as analytics from "../analytics.js";
import { issueAdminInvite } from "./admin-invites.js";
import {
  asciiLower,
  normalizeDomain,
  hostedWorkspaceDomain,
  verificationMessage,
  resolveIps,
  domainSchema,
  addDomain,
  setPrimaryDomain,
  removeDomain,
} from "./workspace.js";
export function normalizeReportingTimezone(value: string | null | undefined) {
  const timezone = (value ?? "UTC").trim();
  if (
    !timezone ||
    Buffer.byteLength(timezone) > 64 ||
    !/^[A-Za-z0-9/_+\-]+$/.test(timezone)
  )
    throw bad("reportingTimezone must be a valid timezone identifier");
  return timezone;
}
export function requireAdminSecret(
  request: FastifyRequest,
  context: TenantContext,
) {
  if (
    context.config.admin_secret !== null &&
    request.headers["x-admin-secret"] !== context.config.admin_secret
  )
    throw forbidden();
}
export async function resolveWorkspaceId(context: TenantContext, id: string) {
  const result = (
    await context.pool.query(
      `SELECT id FROM workspaces WHERE id=$1 OR slug=$1 LIMIT 1`,
      [id],
    )
  ).rows[0]?.id;
  if (!result) throw missing("workspace not found");
  return result as string;
}
const workspaceSelect = `SELECT w.id,w.slug,w.display_name,w.status,COUNT(DISTINCT c.id) AS client_count,w.created_at FROM workspaces w LEFT JOIN tenant_clients c ON c.workspace_id=w.id`;
const workspaceGroup = ` GROUP BY w.id,w.slug,w.display_name,w.status,w.created_at`;
const domainSelect = `SELECT id,domain,is_primary,dns_status,verified_at,created_at FROM workspace_domains`;
const domainResult = (
  context: TenantContext,
  row: Record<string, unknown>,
) => ({
  ...row,
  verification_message: verificationMessage(
    String(row.dns_status),
    String(row.domain),
    context.config.portal_host_target,
  ),
});
export async function getAdminWorkspace(context: TenantContext, id: string) {
  const row = (
    await context.pool.query(
      `${workspaceSelect} WHERE w.id=$1 OR w.slug=$1${workspaceGroup} LIMIT 1`,
      [id],
    )
  ).rows[0];
  if (!row) throw missing("workspace not found");
  const domains = (
    await context.pool.query(
      `${domainSelect} WHERE workspace_id=$1 ORDER BY is_primary DESC,created_at ASC`,
      [row.id],
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
      clientCount: BigInt(row.client_count),
      domains: domains.map((row) => row.domain),
      domainRecords: domains.map((row) => domainResult(context, row)),
      createdAt: row.created_at,
      domainVerification: {
        expectedTargetHost: context.config.portal_host_target,
        hostedDomainBase: context.config.platform_base_domain,
      },
    },
  };
}
export function registerAdminRoutes(
  app: FastifyInstance,
  context: TenantContext,
) {
  const workspace = async (r: FastifyRequest) => {
    requireAdminSecret(r, context);
    return resolveWorkspaceId(context, (r.params as { id: string }).id);
  };
  app.get("/api/admin/workspaces", async (r) => {
    requireAdminSecret(r, context);
    return {
      workspaces: (
        await context.pool.query(
          `${workspaceSelect}${workspaceGroup} ORDER BY w.created_at DESC`,
        )
      ).rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        displayName: row.display_name,
        status: row.status,
        clientCount: BigInt(row.client_count),
        createdAt: row.created_at,
      })),
    };
  });
  app.get<{ Params: { id: string } }>(
    "/api/admin/workspaces/:id",
    async (r) => {
      requireAdminSecret(r, context);
      return getAdminWorkspace(context, r.params.id);
    },
  );
  app.patch("/api/admin/workspaces/:id", async (r) => {
    const id = await workspace(r),
      body = r.body as Record<string, unknown> | null;
    if (body && typeof body.status === "string")
      await context.pool.query(
        `UPDATE workspaces SET status=$1,updated_at=NOW() WHERE id=$2`,
        [body.status, id],
      );
    if (body && typeof body.displayName === "string") {
      await context.pool.query(
        `UPDATE workspaces SET display_name=$1,updated_at=NOW() WHERE id=$2`,
        [body.displayName, id],
      );
      await context.pool.query(
        `UPDATE workspace_branding SET display_name=$1,updated_at=NOW() WHERE workspace_id=$2`,
        [body.displayName, id],
      );
    }
    return getAdminWorkspace(context, id);
  });
  app.get("/api/admin/workspaces/:id/staff", async (r) => ({
    staff: (
      await context.pool.query(
        `SELECT u.id,u.email,u.status,COALESCE(json_agg(r.role ORDER BY r.created_at) FILTER(WHERE r.role IS NOT NULL),'[]'::json) AS roles,u.created_at FROM tenant_users u LEFT JOIN tenant_user_roles r ON r.tenant_user_id=u.id WHERE u.workspace_id=$1 GROUP BY u.id,u.email,u.status,u.created_at ORDER BY u.created_at DESC`,
        [await workspace(r)],
      )
    ).rows,
  }));
  app.post<{ Body: { email: string; password: string; role?: string | null } }>(
    "/api/admin/workspaces/:id/staff",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string" },
            password: { type: "string" },
            role: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
    },
    async (r, reply) => {
      const id = await workspace(r),
        email = asciiLower(r.body.email.trim()),
        role = (r.body.role ?? "admin").trim();
      if (
        (
          await context.pool.query(
            `SELECT id FROM tenant_users WHERE workspace_id=$1 AND lower(email)=$2 LIMIT 1`,
            [id, email],
          )
        ).rows[0]
      )
        throw bad("staff user already exists in this workspace");
      const password = await hash(r.body.password.trim(), 12),
        userId = createId();
      await transaction(context.pool, async (tx) => {
        await tx.query(
          `INSERT INTO tenant_users(id,workspace_id,email,password_hash,status,created_at,updated_at) VALUES($1,$2,$3,$4,'active',NOW(),NOW())`,
          [userId, id, email, password],
        );
        await tx.query(
          `INSERT INTO tenant_user_roles(tenant_user_id,role,created_at) VALUES($1,$2,NOW())`,
          [userId, role],
        );
      });
      return reply
        .code(201)
        .send({ user: { id: userId, email, role, status: "active" } });
    },
  );
  app.delete<{ Params: { id: string; user_id: string } }>(
    "/api/admin/workspaces/:id/staff/:user_id",
    async (r) => {
      const id = await workspace(r);
      if (
        !(
          await context.pool.query(
            `DELETE FROM tenant_users WHERE id=$1 AND workspace_id=$2 RETURNING id`,
            [r.params.user_id, id],
          )
        ).rows[0]
      )
        throw missing("staff user not found");
      return { deleted: true };
    },
  );
  app.get("/api/admin/workspaces/:id/clients", async (r) => ({
    clients: (
      await context.pool.query(
        `SELECT c.id,c.name,c.slug,c.status,COUNT(DISTINCT u.id) AS user_count,c.created_at FROM tenant_clients c LEFT JOIN tenant_client_users u ON u.tenant_client_id=c.id AND u.status!='revoked' WHERE c.workspace_id=$1 GROUP BY c.id,c.name,c.slug,c.status,c.created_at ORDER BY c.created_at DESC`,
        [await workspace(r)],
      )
    ).rows.map((row) => ({ ...row, user_count: BigInt(row.user_count) })),
  }));
  app.get("/api/admin/workspaces/:id/api-keys", async (r) => ({
    apiKeys: (
      await context.pool.query(
        `SELECT id,label,key_prefix,scopes,revoked_at,created_at FROM workspace_api_keys WHERE workspace_id=$1 ORDER BY created_at DESC`,
        [await workspace(r)],
      )
    ).rows,
  }));
  app.post<{ Body: { label: string; scopes?: unknown } }>(
    "/api/admin/workspaces/:id/api-keys",
    {
      schema: {
        body: {
          type: "object",
          required: ["label"],
          properties: { label: { type: "string" }, scopes: {} },
        },
      },
    },
    async (r, reply) => {
      const workspaceId = await workspace(r),
        label = r.body.label.trim();
      if (!label) throw bad("label is required");
      const scopes = r.body.scopes ?? [
          "workspace:read",
          "clients:read",
          "portal:bootstrap",
        ],
        key = `ktnt_${randomBytes(32).toString("base64url")}`,
        prefix = key.slice(0, 12),
        hash = createHash("sha256").update(key).digest("hex"),
        id = createId();
      await context.pool.query(
        `INSERT INTO workspace_api_keys(id,workspace_id,label,key_prefix,key_hash,scopes,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,NOW(),NOW())`,
        [id, workspaceId, label, prefix, hash, apiJson(scopes)],
      );
      return reply
        .code(201)
        .send({ apiKey: { id, label, key, prefix, scopes } });
    },
  );
  app.delete<{ Params: { id: string; key_id: string } }>(
    "/api/admin/workspaces/:id/api-keys/:key_id",
    async (r) => {
      const id = await workspace(r);
      if (
        !(
          await context.pool.query(
            `UPDATE workspace_api_keys SET revoked_at=NOW(),updated_at=NOW() WHERE id=$1 AND workspace_id=$2 AND revoked_at IS NULL RETURNING id`,
            [r.params.key_id, id],
          )
        ).rows[0]
      )
        throw missing("api key not found or already revoked");
      return { revoked: true };
    },
  );
  app.get("/api/admin/workspaces/:id/domains", async (r) => ({
    domains: (
      await context.pool.query(
        `${domainSelect} WHERE workspace_id=$1 ORDER BY is_primary DESC,created_at ASC`,
        [await workspace(r)],
      )
    ).rows.map((row) => domainResult(context, row)),
    verification: {
      expected_target_host: context.config.portal_host_target,
      hosted_domain_base: context.config.platform_base_domain,
    },
  }));
  app.post<{ Body: { domain: string; makePrimary?: boolean | null } }>(
    "/api/admin/workspaces/:id/domains",
    { schema: { body: domainSchema } },
    async (r, reply) => {
      const id = await workspace(r),
        result = await addDomain(
          context,
          id,
          r.body.domain,
          r.body.makePrimary ?? false,
        ),
        d = result.domain;
      return reply
        .code(201)
        .send({
          domain: {
            id: d.id,
            domain: d.domain,
            is_primary: d.isPrimary,
            dns_status: d.dnsStatus,
            verified_at: d.verifiedAt,
            created_at: new Date(),
            verification_message: d.verificationMessage,
          },
          verification: {
            expected_target_host: context.config.portal_host_target,
            hosted_domain_base: context.config.platform_base_domain,
          },
        });
    },
  );
  app.post<{ Params: { id: string; domain_id: string } }>(
    "/api/admin/workspaces/:id/domains/:domain_id/verify",
    async (r) => {
      const id = await workspace(r),
        row = (
          await context.pool.query(
            `${domainSelect} WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
            [id, r.params.domain_id],
          )
        ).rows[0];
      if (!row) throw missing("domain not found");
      const ips = await resolveIps(row.domain);
      let status = "pending";
      if (ips.size) {
        if (context.config.portal_host_target) {
          const target = await resolveIps(context.config.portal_host_target);
          status =
            target.size && [...ips].some((ip) => target.has(ip))
              ? "verified"
              : "misconfigured";
        } else status = "verified";
      }
      await context.pool.query(
        `UPDATE workspace_domains SET dns_status=$1,verified_at=CASE WHEN $1='verified' THEN NOW() ELSE NULL END,updated_at=NOW() WHERE id=$2 AND workspace_id=$3`,
        [status, r.params.domain_id, id],
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
        verification: {
          expectedTargetHost: context.config.portal_host_target,
          hostedDomainBase: context.config.platform_base_domain,
          resolvedIps: [...ips].sort(),
        },
      };
    },
  );
  app.post<{ Params: { id: string; domain_id: string } }>(
    "/api/admin/workspaces/:id/domains/:domain_id/primary",
    async (r) =>
      setPrimaryDomain(context, await workspace(r), r.params.domain_id),
  );
  app.delete<{ Params: { id: string; domain_id: string } }>(
    "/api/admin/workspaces/:id/domains/:domain_id",
    async (r) => removeDomain(context, await workspace(r), r.params.domain_id),
  );
  app.post<{
    Body: {
      workspaceName: string;
      slug: string;
      adminEmail: string;
      primaryColor?: string | null;
      reportingTimezone?: string | null;
      domain?: string | null;
    };
  }>(
    "/api/admin/workspaces",
    {
      schema: {
        body: {
          type: "object",
          required: ["workspaceName", "slug", "adminEmail"],
          properties: Object.fromEntries(
            [
              "workspaceName",
              "slug",
              "adminEmail",
              "primaryColor",
              "reportingTimezone",
              "domain",
            ].map((key) => [
              key,
              ["primaryColor", "reportingTimezone", "domain"].includes(key)
                ? { anyOf: [{ type: "string" }, { type: "null" }] }
                : { type: "string" },
            ]),
          ),
        },
      },
    },
    async (r) => {
      requireAdminSecret(r, context);
      const b = r.body,
        name = b.workspaceName.trim(),
        slug = asciiLower(b.slug.trim()),
        email = asciiLower(b.adminEmail.trim());
      if (!name || !slug || !email)
        throw bad("workspaceName, slug, and adminEmail are required");
      if (
        (
          await context.pool.query(
            `SELECT id FROM workspaces WHERE slug=$1 LIMIT 1`,
            [slug],
          )
        ).rows[0]
      )
        throw bad(`workspace slug already exists: ${slug}`);
      const id = createId(),
        userId = createId(),
        keyId = createId(),
        key = `ktnt_${randomBytes(32).toString("base64url")}`,
        prefix = key.slice(0, 12),
        keyHash = createHash("sha256").update(key).digest("hex"),
        scopes = [
          "workspace:read",
          "workspace:write",
          "clients:read",
          "clients:write",
          "portal:bootstrap",
        ],
        time = new Date(),
        timezone = normalizeReportingTimezone(b.reportingTimezone);
      await transaction(context.pool, async (tx) => {
        await tx.query(
          `INSERT INTO workspaces(id,slug,display_name,status,reporting_timezone,created_at,updated_at) VALUES($1,$2,$3,'active',$4,NOW(),NOW())`,
          [id, slug, name, timezone],
        );
        await tx.query(
          `INSERT INTO workspace_branding(workspace_id,display_name,primary_color,custom_domain,created_at,updated_at) VALUES($1,$2,$3,$4,NOW(),NOW())`,
          [id, name, b.primaryColor ?? null, b.domain ?? null],
        );
        await tx.query(
          `INSERT INTO workspace_usage_limits(workspace_id,requests_per_month,tokens_per_month,conversations_per_month,created_at,updated_at) VALUES($1,0,0,0,NOW(),NOW())`,
          [id],
        );
        if (b.domain !== undefined && b.domain !== null)
          await tx.query(
            `INSERT INTO workspace_domains(id,workspace_id,domain,is_primary,dns_status,created_at,updated_at) VALUES($1,$2,$3,TRUE,'pending',NOW(),NOW())`,
            [createId(), id, normalizeDomain(b.domain)],
          );
        await tx.query(
          `INSERT INTO tenant_users(id,workspace_id,email,password_hash,status,created_at,updated_at) VALUES($1,$2,$3,'','invited',NOW(),NOW())`,
          [userId, id, email],
        );
        await tx.query(
          `INSERT INTO tenant_user_roles(tenant_user_id,role,created_at) VALUES($1,'owner',NOW())`,
          [userId],
        );
        await tx.query(
          `INSERT INTO workspace_api_keys(id,workspace_id,label,key_prefix,key_hash,scopes,created_at,updated_at) VALUES($1,$2,'initial-provisioning-key',$3,$4,$5,NOW(),NOW())`,
          [keyId, id, prefix, keyHash, apiJson(scopes)],
        );
        try {
          await analytics.enqueueWorkspaceScopeDefinition(
            tx,
            id,
            time.getTime(),
            timezone,
          );
        } catch (error) {
          throw internal(`analytics workspace scope enqueue failed: ${error}`);
        }
        try {
          await analytics.enqueueScopeManifest(tx, id, 1n, time);
        } catch (error) {
          throw internal(
            `analytics workspace manifest enqueue failed: ${error}`,
          );
        }
      });
      const invite = await issueAdminInvite(
        context,
        id,
        slug,
        name,
        userId,
        email,
      );
      return {
        workspace: {
          id,
          slug,
          displayName: name,
          status: "active",
          hostedDomain: hostedWorkspaceDomain(
            slug,
            context.config.platform_base_domain,
          ),
          domains: b.domain?.trim() ? [b.domain.trim()] : [],
          createdAt: time,
        },
        adminUser: { id: userId, email, role: "owner", status: "invited" },
        apiKey: { id: keyId, key, prefix },
        adminInvite: {
          activationUrl: invite.activation_url,
          portalUrl: invite.portal_url,
          emailSent: invite.email_sent,
          expiresAt: invite.expires_at,
        },
      };
    },
  );
}
