import { verifyAdminAuthority, ADMIN_AUTHORITY_HEADER, type AdminAuthority } from '@kasitek-labs/server-support/admin-authority';
import type { FastifyRequest } from 'fastify';
import type { TenantContext } from './context.js';
import { forbidden } from './error.js';
export const adminRawBodies = new WeakMap<object, string>();
export const verifiedAdminActors = new WeakMap<object, AdminAuthority>();
export async function requireServiceAdmin(request: FastifyRequest, context: TenantContext): Promise<AdminAuthority> {
  const existing = verifiedAdminActors.get(request);
  if (existing) return existing;
  const secret = context.config.env.KASITEK_ADMIN_SERVICE_SECRET;
  const token = request.headers[ADMIN_AUTHORITY_HEADER];
  if (!secret || typeof token !== 'string') throw forbidden();
  let actor: AdminAuthority;
  try { actor = verifyAdminAuthority(token, { secret, audience: 'agency', method: request.method, path: request.url, body: adminRawBodies.get(request) }); }
  catch { throw forbidden(); }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const claimed = await context.pool.query('INSERT INTO admin_service_assertion_nonces (nonce, expires_at) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING nonce', [actor.nonce, new Date(actor.expiresAt)]);
    if (!claimed.rows[0]) throw forbidden();
    await context.pool.query('DELETE FROM admin_service_assertion_nonces WHERE expires_at < NOW()');
  }
  verifiedAdminActors.set(request, actor);
  return actor;
}
