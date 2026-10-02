import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { extractUser, resolveActiveOrgId } from '../identity/session.js';
import { extractAdmin, requireAdminRole } from '../identity/admin-session.js';
import * as access from '../services/early-access.js';

const nullableString = { type: ['string', 'null'] };
const optionalPackage = { type: 'object', properties: { packageKey: nullableString } };
type IdParams = { id: string };
type TokenParams = { token: string };
export async function registerEarlyAccessRoutes(app: FastifyInstance, core: CoreContext): Promise<void> {
  const operator = async (request: FastifyRequest): Promise<string> => {
    const admin = await extractAdmin(request, core);
    requireAdminRole(admin, ['superadmin', 'admin']);
    return admin.id;
  };
  const requireSelfService = () => {
    if (!access.selfServiceEnabled(core)) throw new ApiError(409, 'conflict', 'Early-access self-service is temporarily unavailable');
  };
  app.get('/api/early-access/status', async (request) => {
    const user = await extractUser(request, core);
    const orgId = await resolveActiveOrgId(request, core, user.id);
    return { earlyAccess: await access.statusForOrg(core.pool, orgId) };
  });
  app.get<{ Params: TokenParams }>('/api/early-access/invitations/:token', async (request) => {
    requireSelfService();
    return { invitation: await access.signupInvitationPreview(core.pool, request.params.token) };
  });
  app.post<{ Params: TokenParams; Body: { organizationId?: string | null; workspaceName?: string | null } }>(
    '/api/early-access/invitations/:token/activate', { schema: { body: { type: 'object', properties: {
      organizationId: nullableString, workspaceName: nullableString,
    } } } }, async (request) => {
      requireSelfService();
      const user = await extractUser(request, core);
      return { application: await access.activateInvitation(core, request.params.token, user.id, request.body) };
    });
  const prefix = '/api/admin/early-access';
  app.get<{ Querystring: { status?: string; search?: string; cohort?: string; limit?: string } }>(prefix, async (request) => {
    await operator(request);
    const query = request.query;
    for (const value of Object.values(query)) if (typeof value !== 'string') throw new ApiError(400, 'bad_request', 'Invalid request');
    let limit: bigint | undefined;
    if (query.limit !== undefined) {
      if (!/^[+-]?\d+$/.test(query.limit)) throw new ApiError(400, 'bad_request', 'Invalid request');
      limit = BigInt(query.limit);
      if (limit < -9223372036854775808n || limit > 9223372036854775807n) throw new ApiError(400, 'bad_request', 'Invalid request');
    }
    return { applications: await access.listApplications(core.pool, { ...query, limit }) };
  });
  app.get<{ Params: IdParams }>(`${prefix}/:id`, async (request) => {
    await operator(request);
    return access.getApplication(core.pool, request.params.id);
  });
  app.post<{ Params: IdParams; Body: { reason?: string | null } }>(`${prefix}/:id/reject`, {
    schema: { body: { type: 'object', properties: { reason: nullableString } } },
  }, async (request) => ({ application: await access.rejectApplication(core.pool, request.params.id, await operator(request), request.body) }));
  app.post<{ Params: IdParams; Body: { packageKey?: string | null } }>(`${prefix}/:id/approve`, {
    schema: { body: optionalPackage },
  }, async (request) => ({ application: await access.approveApplication(core, request.params.id, await operator(request), request.body) }));
  app.post<{ Body: { applicationIds: string[]; packageKey?: string | null } }>(`${prefix}/batch-approve`, {
    schema: { body: { type: 'object', required: ['applicationIds'], properties: {
      applicationIds: { type: 'array', items: { type: 'string' } }, packageKey: nullableString,
    } } },
  }, async (request) => access.batchApprove(core, await operator(request), request.body));
  app.post<{ Params: IdParams }>(`${prefix}/:id/resend`, async (request) => ({
    application: await access.resendInvitation(core, request.params.id, await operator(request)),
  }));
  const reason = (body: unknown) => body && typeof body === 'object' && !Array.isArray(body)
    && typeof (body as Record<string, unknown>).reason === 'string' ? (body as { reason: string }).reason : '';
  app.post<{ Params: IdParams; Body: unknown }>(`${prefix}/:id/restore`, async (request) => ({
    application: await access.restoreApplication(core, request.params.id, await operator(request), reason(request.body)),
  }));
  app.post<{ Params: IdParams; Body: unknown }>(`${prefix}/:id/revoke`, async (request) => ({
    application: await access.revokeApplication(core.pool, request.params.id, await operator(request), reason(request.body)),
  }));
}
