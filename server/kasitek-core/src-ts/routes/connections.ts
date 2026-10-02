import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { extractUser, resolveActiveOrgId } from '../identity/session.js';
import { requireAdmin } from '../services/orgs.js';
import * as connections from '../services/connections.js';
import * as permissions from '../integrations/connection-permissions.js';
import { authMode } from '../integrations/provider-permissions.js';

export function registerConnectionRoutes(app: FastifyInstance, context: CoreContext): void {
  async function scope(request: FastifyRequest, admin = false): Promise<string> {
    const user = await extractUser(request, context);
    const orgId = await resolveActiveOrgId(request, context, user.id);
    if (admin) await requireAdmin(context.pool, orgId, user.id);
    return orgId;
  }

  app.get('/api/connections', async request => ({
    connections: await connections.listConnections(context.pool, await scope(request)),
  }));

  app.patch<{ Params: { id: string } }>('/api/connections/:id/status', async request => {
    const orgId = await scope(request, true);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ApiError(400, 'bad_request', 'Invalid request');
    }
    const raw = (body as { status?: unknown }).status;
    if (raw != null && typeof raw !== 'string') {
      throw new ApiError(400, 'bad_request', 'Invalid request');
    }
    const status = typeof raw === 'string' ? raw.trim() : '';
    if (!status) throw new ApiError(400, 'bad_request', 'Status is required');
    return {
      connection: await connections.updateStatus(context.pool, orgId, request.params.id, status),
    };
  });

  app.get<{ Params: { id: string } }>('/api/connections/:id/access', async request => {
    const orgId = await scope(request, true);
    await connections.syncOrgConnections(context.pool, orgId);
    return permissions.getAccessSnapshot(context.pool, orgId, request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { capabilities?: string } }>(
    '/api/connections/:id/access/request',
    async (request, reply) => {
      const orgId = await scope(request, true);
      await connections.syncOrgConnections(context.pool, orgId);
      if (request.query.capabilities !== undefined && typeof request.query.capabilities !== 'string') {
        throw new ApiError(400, 'bad_request', 'Invalid request');
      }
      const requested = permissions.parseRequestedCapabilities(request.query.capabilities);
      const plan = await permissions.planAccessRequest(context.pool, orgId, request.params.id, requested);
      const id = encodeURIComponent(plan.context.id);
      const query = `connectionId=${id}&capabilities=${encodeURIComponent(requested.join(','))}`;
      let location: string;
      switch (plan.context.provider.toUpperCase()) {
        case 'FACEBOOK':
          location = `/api/social/oauth/meta/start?target=facebook&${query}`;
          break;
        case 'INSTAGRAM':
          location = authMode(plan.adapter) === 'instagram_login'
            ? `/api/social/oauth/instagram/start?${query}`
            : `/api/social/oauth/meta/start?target=instagram&${query}`;
          break;
        case 'THREADS':
        case 'TIKTOK':
        case 'LINKEDIN':
        case 'X':
          location = `/api/social/oauth/${plan.context.provider.toLowerCase()}/start?${query}`;
          break;
        case 'BLUESKY':
          if (plan.context.handle === null) {
            throw new ApiError(400, 'bad_request', 'This Bluesky connection has no login handle');
          }
          location = `/api/social/oauth/bluesky/start?handle=${encodeURIComponent(plan.context.handle)}&${query}`;
          break;
        case 'WHATSAPP':
          location = `${context.config.frontendUrl.replace(/\/+$/, '')}/connections?access=required&provider=whatsapp&${query}`;
          break;
        default:
          throw new ApiError(400, 'bad_request', 'Access requests are not available for this provider yet');
      }
      return reply.code(302).header('Location', location).send();
    },
  );
}
