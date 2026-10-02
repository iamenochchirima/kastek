import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { transaction } from "../db.js";
import { bad, missing } from "../error.js";
import * as middleware from "../middleware.js";
import * as mail from "../mail.js";
import { asciiLower, normalizeDomain } from "./workspace.js";
export const emailSenderView = (sender: mail.WorkspaceEmailSender) => ({
  sendingMode: sender.sending_mode,
  senderName: sender.sender_name,
  fromEmail: sender.from_email,
  replyToEmail: sender.reply_to_email,
  domainStatus: sender.domain_status,
  activeDomainId: sender.active_domain_id,
  activeDomain: sender.active_domain,
});
export function normalizeLocalPart(input: string | null | undefined) {
  let result = "",
    dash = false;
  for (const c of (input ?? "no-reply").toLowerCase()) {
    if (/[a-z0-9]/.test(c)) {
      result += c;
      dash = false;
    } else if ("._-".includes(c) && !dash) {
      result += "-";
      dash = true;
    }
  }
  return result.replace(/^-+|-+$/g, "") || "no-reply";
}
export function normalizeOptionalEmail(input: string | null | undefined) {
  const value = input?.trim() || null;
  if (value && (!value.includes("@") || value.includes(" ")))
    throw bad("reply-to email must be valid");
  return value ? asciiLower(value) : null;
}
async function displayName(context: TenantContext, id: string) {
  const row = (
    await context.pool.query(
      `SELECT display_name FROM workspaces WHERE id=$1 LIMIT 1`,
      [id],
    )
  ).rows[0];
  if (!row) throw missing("workspace not found");
  return row.display_name as string;
}
async function ensureSettings(
  context: TenantContext,
  id: string,
  name: string,
) {
  await context.pool.query(
    `INSERT INTO workspace_email_settings(workspace_id,sender_name,created_at,updated_at) VALUES($1,$2,NOW(),NOW()) ON CONFLICT(workspace_id) DO NOTHING`,
    [id, name],
  );
}
export async function loadEmailSettings(
  context: TenantContext,
  id: string,
  slug: string,
) {
  const name = await displayName(context, id);
  await ensureSettings(context, id, name);
  const s = (
    await context.pool.query(
      `SELECT workspace_id,sending_mode,sender_name,reply_to_email,shared_sender_local_part,custom_domain_id,created_at,updated_at FROM workspace_email_settings WHERE workspace_id=$1 LIMIT 1`,
      [id],
    )
  ).rows[0]!;
  const domains = (
    await context.pool.query(
      `SELECT id,provider,provider_domain_id,domain,status,verified_at,created_at,updated_at FROM workspace_email_domains WHERE workspace_id=$1 ORDER BY created_at DESC`,
      [id],
    )
  ).rows;
  const records = (
    await context.pool.query(
      `SELECT id,email_domain_id,record_group,record_type,record_name,record_value,record_status,ttl,priority FROM workspace_email_domain_records WHERE email_domain_id IN(SELECT id FROM workspace_email_domains WHERE workspace_id=$1) ORDER BY record_group ASC,record_name ASC`,
      [id],
    )
  ).rows;
  return {
    email: {
      resendConfigured: context.config.resend_api_key !== null,
      sharedDomain: context.config.shared_email_domain,
      platformFromEmail: mail.platformFromEmail(context),
      sender: emailSenderView(
        await mail.resolveWorkspaceEmailSender(context, id, slug, name),
      ),
      settings: {
        workspaceId: s.workspace_id,
        sendingMode: s.sending_mode,
        senderName: s.sender_name,
        replyToEmail: s.reply_to_email,
        sharedSenderLocalPart: s.shared_sender_local_part,
        customDomainId: s.custom_domain_id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      },
      customDomains: domains.map((d) => ({
        id: d.id,
        provider: d.provider,
        providerDomainId: d.provider_domain_id,
        domain: d.domain,
        status: d.status,
        verifiedAt: d.verified_at,
        createdAt: d.created_at,
        updatedAt: d.updated_at,
        records: records
          .filter((r) => r.email_domain_id === d.id)
          .map((r) => ({
            id: r.id,
            recordGroup: r.record_group,
            recordType: r.record_type,
            recordName: r.record_name,
            recordValue: r.record_value,
            recordStatus: r.record_status,
            ttl: r.ttl,
            priority: r.priority,
          })),
      })),
    },
  };
}
const schema = (required: string[], optional: string[] = []) => ({
  type: "object",
  required,
  properties: Object.fromEntries([
    ...required.map((k) => [k, { type: "string" }]),
    ...optional.map((k) => [
      k,
      { anyOf: [{ type: "string" }, { type: "null" }] },
    ]),
  ]),
});
export function registerEmailSettingsRoutes(
  app: FastifyInstance,
  context: TenantContext,
  transport: mail.MailTransport = {},
) {
  const access = async (r: import("fastify").FastifyRequest) => {
    const a = await middleware.extractAccessContext(r, context);
    middleware.requireTenantRoles(a.tenant_user_roles, ["owner", "admin"]);
    return a;
  };
  app.get("/api/workspace/email-sending", async (r) => {
    const a = await access(r);
    return loadEmailSettings(context, a.workspace_id, a.workspace_slug);
  });
  app.put<{
    Body: {
      sendingMode: string;
      senderName?: string | null;
      replyToEmail?: string | null;
      sharedSenderLocalPart?: string | null;
      customDomainId?: string | null;
    };
  }>(
    "/api/workspace/email-sending",
    {
      schema: {
        body: schema(
          ["sendingMode"],
          [
            "senderName",
            "replyToEmail",
            "sharedSenderLocalPart",
            "customDomainId",
          ],
        ),
      },
    },
    async (r) => {
      const a = await access(r),
        b = r.body,
        name = await displayName(context, a.workspace_id);
      await ensureSettings(context, a.workspace_id, name);
      const mode = asciiLower(b.sendingMode.trim()),
        domain = b.customDomainId?.trim() || null;
      if (!["shared", "custom"].includes(mode))
        throw bad("sending mode must be shared or custom");
      if (mode === "custom") {
        if (!domain)
          throw bad(
            "select a verified custom domain before switching to custom sending",
          );
        if (
          (
            await context.pool.query(
              `SELECT status FROM workspace_email_domains WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
              [a.workspace_id, domain],
            )
          ).rows[0]?.status !== "verified"
        )
          throw bad("custom sending requires a verified domain");
      }
      await context.pool.query(
        `UPDATE workspace_email_settings SET sending_mode=$1,sender_name=$2,reply_to_email=$3,shared_sender_local_part=$4,custom_domain_id=$5,updated_at=NOW() WHERE workspace_id=$6`,
        [
          mode,
          b.senderName?.trim() || null,
          normalizeOptionalEmail(b.replyToEmail),
          normalizeLocalPart(b.sharedSenderLocalPart),
          domain,
          a.workspace_id,
        ],
      );
      return loadEmailSettings(context, a.workspace_id, a.workspace_slug);
    },
  );
  app.post<{ Body: { domain: string } }>(
    "/api/workspace/email-sending/domains",
    { schema: { body: schema(["domain"]) } },
    async (r) => {
      const a = await access(r),
        domain = normalizeDomain(r.body.domain);
      if (
        (
          await context.pool.query(
            `SELECT id FROM workspace_email_domains WHERE lower(domain)=lower($1) LIMIT 1`,
            [domain],
          )
        ).rows.length
      )
        throw bad("email domain already exists");
      const result = await mail.createResendDomain(context, domain, transport);
      await transaction(context.pool, (tx) =>
        mail.persistWorkspaceEmailDomain(tx, a.workspace_id, null, result),
      );
      return loadEmailSettings(context, a.workspace_id, a.workspace_slug);
    },
  );
  app.post<{ Params: { domain_id: string } }>(
    "/api/workspace/email-sending/domains/:domain_id/verify",
    async (r) => {
      const a = await access(r),
        domain = (
          await context.pool.query(
            `SELECT id,provider_domain_id FROM workspace_email_domains WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
            [a.workspace_id, r.params.domain_id],
          )
        ).rows[0];
      if (!domain) throw missing("email domain not found");
      const result = await mail.verifyResendDomain(
        context,
        domain.provider_domain_id,
        transport,
      );
      await transaction(context.pool, async (tx) => {
        const status = await mail.persistWorkspaceEmailDomain(
          tx,
          a.workspace_id,
          domain.id,
          result,
        );
        if (status !== "verified")
          await tx.query(
            `UPDATE workspace_email_settings SET sending_mode='shared',updated_at=NOW() WHERE workspace_id=$1 AND custom_domain_id=$2 AND sending_mode='custom'`,
            [a.workspace_id, domain.id],
          );
      });
      return loadEmailSettings(context, a.workspace_id, a.workspace_slug);
    },
  );
  app.delete<{ Params: { domain_id: string } }>(
    "/api/workspace/email-sending/domains/:domain_id",
    async (r) => {
      const a = await access(r),
        domain = (
          await context.pool.query(
            `SELECT id,provider_domain_id FROM workspace_email_domains WHERE workspace_id=$1 AND id=$2 LIMIT 1`,
            [a.workspace_id, r.params.domain_id],
          )
        ).rows[0];
      if (!domain) throw missing("email domain not found");
      await mail.deleteResendDomain(
        context,
        domain.provider_domain_id,
        transport,
      );
      await transaction(context.pool, async (tx) => {
        await tx.query(
          `UPDATE workspace_email_settings SET sending_mode=CASE WHEN custom_domain_id=$2 THEN 'shared' ELSE sending_mode END,custom_domain_id=CASE WHEN custom_domain_id=$2 THEN NULL ELSE custom_domain_id END,updated_at=NOW() WHERE workspace_id=$1`,
          [a.workspace_id, domain.id],
        );
        await tx.query(
          `DELETE FROM workspace_email_domains WHERE workspace_id=$1 AND id=$2`,
          [a.workspace_id, domain.id],
        );
      });
      return loadEmailSettings(context, a.workspace_id, a.workspace_slug);
    },
  );
  app.post<{ Body: { to: string } }>(
    "/api/workspace/email-sending/test",
    { schema: { body: schema(["to"]) } },
    async (r) => {
      const a = await access(r),
        name = await displayName(context, a.workspace_id),
        sender = await mail.resolveWorkspaceEmailSender(
          context,
          a.workspace_id,
          a.workspace_slug,
          name,
        ),
        to = asciiLower(r.body.to.trim());
      if (!to.includes("@") || to.includes(" "))
        throw bad("recipient email must be valid");
      await mail.sendEmail(
        context,
        sender,
        [to],
        `KasiTek email sending test for ${name}`,
        `This is a test email from ${name}.\n\nCurrent sender: ${sender.sender_name} <${sender.from_email}>\nMode: ${sender.sending_mode}\n`,
        `<p>This is a test email from <strong>${name}</strong>.</p><p>Current sender: <strong>${sender.sender_name}</strong> &lt;${sender.from_email}&gt;<br/>Mode: ${sender.sending_mode}</p>`,
        transport,
      );
      return { sent: true, to, sender: emailSenderView(sender) };
    },
  );
}
