import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { ADMIN_SESSION_COOKIE, adminCookieOptions, adminProfile, authenticateAdmin, extractAdmin, resolveAdminContext } from '../identity/admin-session.js';
import { changeAdminPassword, requestAdminPasswordReset, resetAdminPassword } from '../services/admin-auth.js';

function body(request: FastifyRequest): Record<string, unknown> {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new ApiError(400, 'bad_request', 'Invalid request');
  return request.body as Record<string, unknown>;
}
function string(value: unknown, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, 'bad_request', 'Invalid request');
    return undefined;
  }
  if (typeof value !== 'string') throw new ApiError(400, 'bad_request', 'Invalid request');
  return value;
}

export function registerAdminAuthRoutes(app: FastifyInstance, context: CoreContext): void {
  app.post('/api/admin/login', async (request, reply) => {
    const values = body(request);
    const admin = await authenticateAdmin(context, string(values.email, true)!, string(values.password, true)!);
    return reply.setCookie(ADMIN_SESSION_COOKIE, admin.id, adminCookieOptions(context)).send(adminProfile(admin));
  });
  app.post('/api/admin/logout', async (_request, reply) => reply.clearCookie(ADMIN_SESSION_COOKIE, adminCookieOptions(context)).send({ message: 'Logged out' }));
  app.get('/api/admin/me', async request => {
    await resolveAdminContext(request, context);
    return adminProfile(await extractAdmin(request, context));
  });
  app.post('/api/admin/forgot-password', async request => {
    const values = body(request);
    await requestAdminPasswordReset(context, string(values.email));
    return { message: 'If an admin account exists for that email, a reset link has been sent.' };
  });
  app.post('/api/admin/reset-password', async request => {
    const values = body(request);
    const email = string(values.email), token = string(values.token), password = string(values.password);
    await resetAdminPassword(context, { ...(email === undefined ? {} : { email }), ...(token === undefined ? {} : { token }), ...(password === undefined ? {} : { password }) });
    return { message: 'Password reset successfully.' };
  });
  app.patch('/api/admin/password', async request => {
    const admin = await extractAdmin(request, context);
    const values = body(request);
    await changeAdminPassword(context, admin, string(values.currentPassword), string(values.nextPassword));
    return { message: 'Password updated.' };
  });
}
