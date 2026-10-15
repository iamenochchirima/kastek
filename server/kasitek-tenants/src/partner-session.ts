import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TenantContext } from './context.js';
import { unauthorized } from './error.js';

export type AgencyPartner = {
  id: string;
  issuer: string;
  subject: string;
  email: string;
  display_name: string | null;
};

export const hashPartnerToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

export function newPartnerToken() {
  return randomBytes(48).toString('base64url');
}

export function partnerCookieOptions(context: TenantContext, expiresAt?: Date) {
  return {
    path: '/',
    httpOnly: true,
    secure: context.config.session_cookie_secure,
    sameSite: 'lax' as const,
    ...(expiresAt ? { expires: expiresAt } : {}),
  };
}

export function setPartnerSessionCookie(
  reply: FastifyReply,
  context: TenantContext,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(
    context.config.partner_session_cookie_name,
    token,
    partnerCookieOptions(context, expiresAt),
  );
}

export function clearPartnerSessionCookie(
  reply: FastifyReply,
  context: TenantContext,
) {
  reply.setCookie(
    context.config.partner_session_cookie_name,
    '',
    { ...partnerCookieOptions(context), expires: new Date(0), maxAge: 0 },
  );
}

export async function requireAgencyPartner(
  request: FastifyRequest,
  context: TenantContext,
): Promise<AgencyPartner> {
  const token = request.cookies[context.config.partner_session_cookie_name]?.trim();
  if (!token) throw unauthorized();
  const idleCutoff = new Date(
    Date.now() - context.config.partner_session_idle_days * 86400000,
  );
  const row = (
    await context.pool.query(
      `SELECT p.id,p.issuer,p.subject,p.email,p.display_name,s.id AS session_id
       FROM agency_partner_sessions s
       JOIN agency_partners p ON p.id=s.partner_id
       WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW()
         AND s.last_used_at>$2 AND p.status='active' AND p.email_verified=TRUE
       LIMIT 1`,
      [hashPartnerToken(token), idleCutoff],
    )
  ).rows[0];
  if (!row) throw unauthorized();
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    email: row.email,
    display_name: row.display_name,
  };
}

/** Refresh the idle timeout only after an explicit foreground user action. */
export async function recordPartnerActivity(
  request: FastifyRequest,
  context: TenantContext,
): Promise<void> {
  const token = request.cookies[context.config.partner_session_cookie_name]?.trim();
  if (!token) throw unauthorized();
  const idleCutoff = new Date(
    Date.now() - context.config.partner_session_idle_days * 86400000,
  );
  const result = await context.pool.query(
    `UPDATE agency_partner_sessions s SET last_used_at=NOW(),updated_at=NOW()
     FROM agency_partners p
     WHERE s.partner_id=p.id AND s.token_hash=$1 AND s.revoked_at IS NULL
       AND s.expires_at>NOW() AND s.last_used_at>$2
       AND p.status='active' AND p.email_verified=TRUE
     RETURNING s.id`,
    [hashPartnerToken(token), idleCutoff],
  );
  if (!result.rows[0]) throw unauthorized();
}

export function requirePartnerSameOrigin(
  request: FastifyRequest,
  context: TenantContext,
) {
  const origin = request.headers.origin;
  if (origin !== context.config.partner_app_base_url) throw unauthorized();
}
