import type { PoolClient } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import type { TenantContext } from './context.js';
import { UtcTimestamp } from './db.js';
import { bad, internal, TenantError } from './error.js';
export interface WorkspaceEmailSender {
  sending_mode: string;
  sender_name: string;
  from_email: string;
  reply_to_email: string | null;
  domain_status: string;
  active_domain_id: string | null;
  active_domain: string | null;
}
export interface EmailDomainDnsRecord {
  id: string;
  record_group: string;
  record_type: string;
  record_name: string;
  record_value: string;
  record_status: string;
  ttl: string | null;
  priority: number | null;
}
export interface NewWorkspaceEmailDomain {
  provider_domain_id: string;
  domain: string;
  status: string;
  region: string | null;
  capabilities: unknown;
  verified_at: Date | null;
  records: EmailDomainDnsRecord[];
}
export interface MailTransport {
  fetch?: typeof fetch;
  baseUrl?: string;
}
const normalizeLocalPart = (value: string) => {
  let result = '',
    dash = false;
  for (const c of value.toLowerCase()) {
    if (/[a-z0-9]/.test(c)) {
      result += c;
      dash = false;
    } else if ('._-'.includes(c) && !dash) {
      result += '-';
      dash = true;
    }
  }
  return result.replace(/^-+|-+$/g, '');
};
const fallbackSenderName = (value: string) =>
  value.trim() || 'Tenant Workspace';
export function workspacePortalUrl(
  context: TenantContext,
  slug: string,
): string | null {
  const config = context.config,
    base = config.platform_base_domain
      ?.trim()
      .replace(/^\.+|\.+$/g, '')
      .replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (base) {
    const host = `${slug}.${base}`,
      protocol =
        host === 'localhost' ||
        host.endsWith('.local') ||
        host.startsWith('127.') ||
        /^[0-9.]*$/.test(host)
          ? 'http'
          : 'https';
    return `${protocol}://${host.replace(/^\/+|\/+$/g, '')}`;
  }
  return config.app_base_url?.replace(/\/+$/, '') ?? null;
}
export function platformFromEmail(context: TenantContext): string {
  const value = context.config.resend_from_email.trim(),
    start = value.lastIndexOf('<'),
    end = value.lastIndexOf('>');
  return start >= 0 && start < end ? value.slice(start + 1, end).trim() : value;
}
async function providerFetch(
  context: TenantContext,
  method: string,
  path: string,
  body: unknown,
  options: MailTransport,
): Promise<Response> {
  if (!context.config.resend_api_key)
    throw bad('Resend is not configured for this environment');
  try {
    return await (options.fetch ?? fetch)(
      (options.baseUrl ?? 'https://api.resend.com') + path,
      {
        method,
        headers: {
          authorization: `Bearer ${context.config.resend_api_key}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
    );
  } catch {
    throw new TenantError(500, 'request error');
  }
}
async function resendRequest(
  context: TenantContext,
  method: string,
  path: string,
  body: unknown,
  options: MailTransport,
): Promise<any> {
  const response = await providerFetch(context, method, path, body, options);
  if (response.ok) {
    try {
      return await response.json();
    } catch {
      throw new TenantError(500, 'request error');
    }
  }
  let parsed: any;
  try {
    parsed = JSON.parse(await response.text());
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      ['message', 'error'].some(
        (key) => parsed[key] != null && typeof parsed[key] !== 'string',
      )
    )
      parsed = undefined;
  } catch {}
  const message =
    typeof parsed?.message === 'string'
      ? parsed.message
      : typeof parsed?.error === 'string'
        ? parsed.error
        : `Resend request failed with status ${response.status} ${response.statusText}`;
  throw [400, 401, 403, 404, 409, 422].includes(response.status)
    ? bad(message)
    : internal(message);
}
function domainResponse(value: any): NewWorkspaceEmailDomain {
  if (
    !value ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.status !== 'string' ||
    !Array.isArray(value.records)
  )
    throw new TenantError(500, 'request error');
  for (const record of value.records) {
    if (
      !record ||
      ['record', 'type', 'name', 'value', 'status'].some(
        (key) => typeof record[key] !== 'string',
      ) ||
      (record.ttl != null && typeof record.ttl !== 'string') ||
      (record.priority != null &&
        (!Number.isInteger(record.priority) ||
          record.priority < -2147483648 ||
          record.priority > 2147483647))
    )
      throw new TenantError(500, 'request error');
  }
  for (const key of ['region', 'verified_at'])
    if (value[key] != null && typeof value[key] !== 'string')
      throw new TenantError(500, 'request error');
  if (
    value.capabilities != null &&
    (typeof value.capabilities !== 'object' ||
      Array.isArray(value.capabilities) ||
      ['sending', 'receiving'].some(
        (key) =>
          value.capabilities[key] != null &&
          typeof value.capabilities[key] !== 'string',
      ))
  )
    throw new TenantError(500, 'request error');
  if (
    value.verified_at &&
    !/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(
      value.verified_at,
    )
  )
    throw new TenantError(500, 'request error');
  let verified: Date | null;
  try {
    verified = value.verified_at
      ? new UtcTimestamp(value.verified_at, true)
      : value.status === 'verified'
        ? new Date()
        : null;
  } catch {
    throw new TenantError(500, 'request error');
  }
  return {
    provider_domain_id: value.id,
    domain: value.name,
    status: value.status,
    region: value.region ?? null,
    capabilities: value.capabilities
      ? {
          sending: value.capabilities.sending ?? null,
          receiving: value.capabilities.receiving ?? null,
        }
      : {},
    verified_at: verified,
    records: value.records.map((r: any) => ({
      id: createId(),
      record_group: r.record,
      record_type: r.type,
      record_name: r.name,
      record_value: r.value,
      record_status: r.status,
      ttl: r.ttl ?? null,
      priority: r.priority ?? null,
    })),
  };
}
export async function createResendDomain(
  context: TenantContext,
  domain: string,
  options: MailTransport = {},
): Promise<NewWorkspaceEmailDomain> {
  return domainResponse(
    (
      await resendRequest(
        context,
        'POST',
        '/domains',
        { name: domain, region: 'eu-west-1' },
        options,
      )
    ).data,
  );
}
export async function retrieveResendDomain(
  context: TenantContext,
  id: string,
  options: MailTransport = {},
): Promise<NewWorkspaceEmailDomain> {
  return domainResponse(
    (await resendRequest(context, 'GET', `/domains/${id}`, undefined, options))
      .data,
  );
}
export async function verifyResendDomain(
  context: TenantContext,
  id: string,
  options: MailTransport = {},
): Promise<NewWorkspaceEmailDomain> {
  await resendRequest(
    context,
    'POST',
    `/domains/${id}/verify`,
    undefined,
    options,
  );
  return retrieveResendDomain(context, id, options);
}
export async function deleteResendDomain(
  context: TenantContext,
  id: string,
  options: MailTransport = {},
): Promise<void> {
  await resendRequest(context, 'DELETE', `/domains/${id}`, undefined, options);
}
export async function persistWorkspaceEmailDomain(
  tx: PoolClient,
  workspaceId: string,
  existingId: string | null,
  domain: NewWorkspaceEmailDomain,
): Promise<string> {
  const id = existingId ?? createId();
  await tx.query(
    `INSERT INTO workspace_email_domains (id,workspace_id,provider,provider_domain_id,domain,status,region,capabilities,verified_at,last_synced_at,created_at,updated_at) VALUES ($1,$2,'resend',$3,$4,$5,$6,$7,$8,NOW(),NOW(),NOW()) ON CONFLICT(id) DO UPDATE SET provider_domain_id=EXCLUDED.provider_domain_id,domain=EXCLUDED.domain,status=EXCLUDED.status,region=EXCLUDED.region,capabilities=EXCLUDED.capabilities,verified_at=EXCLUDED.verified_at,last_synced_at=NOW(),updated_at=NOW()`,
    [
      id,
      workspaceId,
      domain.provider_domain_id,
      domain.domain,
      domain.status,
      domain.region,
      JSON.stringify(domain.capabilities),
      domain.verified_at,
    ],
  );
  await tx.query(
    'DELETE FROM workspace_email_domain_records WHERE email_domain_id=$1',
    [id],
  );
  for (const r of domain.records)
    await tx.query(
      'INSERT INTO workspace_email_domain_records (id,email_domain_id,record_group,record_type,record_name,record_value,record_status,ttl,priority,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())',
      [
        r.id,
        id,
        r.record_group,
        r.record_type,
        r.record_name,
        r.record_value,
        r.record_status,
        r.ttl,
        r.priority,
      ],
    );
  return domain.status;
}
export async function resolveWorkspaceEmailSender(
  context: TenantContext,
  workspaceId: string,
  slug: string,
  name: string,
): Promise<WorkspaceEmailSender> {
  let settings = (
    await context.pool.query(
      'SELECT workspace_id,sending_mode,sender_name,reply_to_email,shared_sender_local_part,custom_domain_id FROM workspace_email_settings WHERE workspace_id=$1 LIMIT 1',
      [workspaceId],
    )
  ).rows[0];
  if (!settings) {
    await context.pool.query(
      'INSERT INTO workspace_email_settings (workspace_id,sender_name,created_at,updated_at) VALUES ($1,$2,NOW(),NOW()) ON CONFLICT(workspace_id) DO NOTHING',
      [workspaceId, name],
    );
    settings = {
      sending_mode: 'shared',
      sender_name: name,
      reply_to_email: null,
      shared_sender_local_part: 'no-reply',
      custom_domain_id: null,
    };
  }
  const sender_name = fallbackSenderName(settings.sender_name ?? name);
  if (settings.sending_mode === 'custom' && settings.custom_domain_id) {
    const row = (
      await context.pool.query(
        "SELECT id,domain,status,verified_at AT TIME ZONE 'UTC' AS verified_at FROM workspace_email_domains WHERE workspace_id=$1 AND id=$2 LIMIT 1",
        [workspaceId, settings.custom_domain_id],
      )
    ).rows[0];
    if (row?.status === 'verified')
      return {
        sending_mode: 'custom',
        sender_name,
        from_email: `${normalizeLocalPart(settings.shared_sender_local_part) || 'no-reply'}@${row.domain}`,
        reply_to_email: settings.reply_to_email,
        domain_status: row.status,
        active_domain_id: row.id,
        active_domain: row.domain,
      };
  }
  return {
    sending_mode: 'shared',
    sender_name,
    from_email: `${normalizeLocalPart(slug) || 'workspace'}-${normalizeLocalPart(settings.shared_sender_local_part) || 'no-reply'}@${context.config.shared_email_domain}`,
    reply_to_email: settings.reply_to_email,
    domain_status: 'shared',
    active_domain_id: null,
    active_domain: context.config.shared_email_domain,
  };
}
export async function sendEmail(
  context: TenantContext,
  sender: WorkspaceEmailSender,
  to: string[],
  subject: string,
  text: string,
  html: string,
  options: MailTransport = {},
): Promise<void> {
  const response = await providerFetch(
    context,
    'POST',
    '/emails',
    {
      from: `${sender.sender_name} <${sender.from_email}>`,
      to,
      reply_to: sender.reply_to_email,
      subject,
      text,
      html,
    },
    options,
  );
  if (response.status !== 200 && response.status !== 201)
    throw internal('Failed to send email');
}

export async function sendClientInviteEmail(
  context: TenantContext,
  workspace_id: string,
  workspace_slug: string,
  workspace_name: string,
  to: string,
  _tenant_client_name: string,
  activation_url: string,
  portal_url: string | null,
  expires_at: Date,
  options: MailTransport = {},
): Promise<boolean> {
  if (!context.config.resend_api_key) return false;
  const expires_label =
      expires_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    portal_line = portal_url ? `Portal link: ${portal_url}\n` : '',
    portal_html = portal_url
      ? `<p><strong>Portal link:</strong> <a href="${portal_url}">${portal_url}</a></p>`
      : '';
  const text = `Verify your email to finish setting up your access.

Open the link below to confirm this address and create your password.

Verify link:
${activation_url}

${portal_line}What happens next:
1. Verify your email
2. Create your password
3. Sign in and start using the portal

This link expires on ${expires_label}.
`;
  const html = `<p><strong>Verify your email to finish setting up your access.</strong></p><p>Open the link below to confirm this address and create your password.</p><p><a href="${activation_url}">Verify email</a></p>${portal_html}<p><strong>What happens next:</strong></p><ol><li>Verify your email</li><li>Create your password</li><li>Sign in and start using the portal</li></ol><p>This link expires on ${expires_label}.</p>`;
  const sender = await resolveWorkspaceEmailSender(
    context,
    workspace_id,
    workspace_slug,
    workspace_name,
  );
  await sendEmail(
    context,
    sender,
    [to],
    `Verify your email for ${workspace_name}`,
    text,
    html,
    options,
  );
  return true;
}

export async function sendTenantAdminInviteEmail(
  context: TenantContext,
  to: string,
  workspace_name: string,
  activation_url: string,
  portal_url: string | null,
  expires_at: Date,
  options: MailTransport = {},
): Promise<boolean> {
  if (!context.config.resend_api_key) return false;
  const expires_label =
      expires_at.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
    portal_line = portal_url ? `Portal link: ${portal_url}\n` : '',
    portal_html = portal_url
      ? `<p><strong>Portal link:</strong> <a href="${portal_url}">${portal_url}</a></p>`
      : '';
  const text = `Verify your email to finish setting up your admin access.

Open the link below to confirm this address and create your password.

Verify link:
${activation_url}

${portal_line}What happens next:
1. Verify your email
2. Create your password
3. Sign in and complete portal setup
4. Start onboarding clients

This link expires on ${expires_label}.
`;
  const html = `<p><strong>Verify your email to finish setting up your admin access.</strong></p><p>Open the link below to confirm this address and create your password.</p><p><a href="${activation_url}">Verify email</a></p>${portal_html}<p><strong>What happens next:</strong></p><ol><li>Verify your email</li><li>Create your password</li><li>Sign in and complete portal setup</li><li>Start onboarding clients</li></ol><p>This link expires on ${expires_label}.</p>`;
  const response = await providerFetch(
    context,
    'POST',
    '/emails',
    {
      from: context.config.resend_from_email,
      to: [to],
      subject: `Verify your email to access ${workspace_name}`,
      text,
      html,
    },
    options,
  );
  if (response.status !== 200 && response.status !== 201)
    throw internal('Failed to send tenant admin invite email');
  return true;
}
