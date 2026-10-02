import { dtoSchema } from './auth.js';
import type { FastifyInstance } from 'fastify';
import type { TenantContext } from '../context.js';
import { bad, unauthorized } from '../error.js';
import {
  resolveWorkspaceFromRequest,
  extractTenantUserSession,
  extractTenantClientUserSession,
} from '../middleware.js';
import {
  authenticateTenantUser,
  buildSessionCookie,
  clearSessionCookie,
  sessionPayload,
  loginInput,
  bodyText,
  deleteTenantSession,
} from './auth.js';
import {
  authenticateClientUser,
  buildClientSessionCookie,
  clearClientSessionCookie,
  clientSessionPayload,
  issueClientInvite,
  deleteClientSession,
} from './client-auth.js';
import { issueAdminInvite } from './admin-invites.js';
export function registerSessionRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.post(
    '/api/auth/session/continue',
    { schema: { body: dtoSchema(['email'], []) } },
    async (request) => {
      const workspace = await resolveWorkspaceFromRequest(request, context),
        email = bodyText(request.body, 'email')
          .trim()
          .replace(/[A-Z]/g, (c) => c.toLowerCase());
      if (!email) throw bad('email is required');
      const user = (
        await context.pool.query(
          'SELECT u.id,u.workspace_id,w.slug AS workspace_slug,w.display_name AS workspace_display_name,u.email,u.password_hash,u.status FROM tenant_users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.workspace_id=$1 AND lower(u.email)=lower($2) LIMIT 1',
          [workspace.workspace_id, email],
        )
      ).rows[0];
      if (user) {
        if (!user.password_hash.trim() || user.status !== 'active') {
          const invite = await issueAdminInvite(
            context,
            user.workspace_id,
            user.workspace_slug,
            user.workspace_display_name,
            user.id,
            user.email,
          );
          return {
            audience: 'tenant',
            nextStep: 'setup_link_sent',
            email: user.email,
            activationUrl: invite.activation_url,
            portalUrl: invite.portal_url,
            expiresAt: invite.expires_at,
          };
        }
        return { audience: 'tenant', nextStep: 'password', email: user.email };
      }
      const client = (
        await context.pool.query(
          'SELECT u.id,u.workspace_id,w.slug AS workspace_slug,u.tenant_client_id,u.email,u.password_hash,u.status FROM tenant_client_users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.workspace_id=$1 AND lower(u.email)=lower($2) LIMIT 1',
          [workspace.workspace_id, email],
        )
      ).rows[0];
      if (client) {
        if (!client.password_hash?.trim() || client.status !== 'active') {
          const invite = await issueClientInvite(
            context,
            client.workspace_id,
            client.workspace_slug,
            client.tenant_client_id,
            client.id,
            client.email,
            null,
          );
          return {
            audience: 'client',
            nextStep: 'setup_link_sent',
            email: client.email,
            activationUrl: invite.activation_url,
            portalUrl: invite.portal_url,
            expiresAt: invite.expires_at,
          };
        }
        return {
          audience: 'client',
          nextStep: 'password',
          email: client.email,
        };
      }
      return { nextStep: 'not_found' };
    },
  );
  app.post(
    '/api/auth/session/login',
    { schema: { body: dtoSchema(['email', 'password'], []) } },
    async (request, reply) => {
      const { email, password } = loginInput(request.body),
        tenant = await authenticateTenantUser(
          request,
          context,
          email,
          password,
        );
      if (tenant) {
        buildSessionCookie(reply, context.config, tenant[1]);
        clearClientSessionCookie(reply, context);
        return { audience: 'tenant', user: tenant[0] };
      }
      const client = await authenticateClientUser(
        request,
        context,
        email,
        password,
      );
      if (client) {
        buildClientSessionCookie(reply, context, client[1]);
        clearSessionCookie(reply, context.config);
        return { audience: 'client', clientUser: client[0] };
      }
      throw unauthorized();
    },
  );
  app.get('/api/auth/session', async (request) => {
    try {
      const tenant = await extractTenantUserSession(request, context);
      return { audience: 'tenant', user: sessionPayload(tenant) };
    } catch {}
    try {
      const client = await extractTenantClientUserSession(request, context);
      return { audience: 'client', clientUser: clientSessionPayload(client) };
    } catch {}
    throw unauthorized();
  });
  app.post('/api/auth/session/logout', async (request, reply) => {
    await deleteTenantSession(request, context);
    await deleteClientSession(request, context);
    clearSessionCookie(reply, context.config);
    clearClientSessionCookie(reply, context);
    return { message: 'logged out' };
  });
}
