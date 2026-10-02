import { dtoSchema } from './auth.js';
const SQL = [
  '\n        SELECT\n            i.id,\n            i.workspace_id,\n            w.slug AS workspace_slug,\n            w.display_name AS workspace_display_name,\n            i.tenant_client_id,\n            c.name AS tenant_client_name,\n            i.tenant_client_user_id,\n            i.email AS invite_email,\n            u.name AS user_name,\n            i.revoked_at AS revoked_at,\n            i.accepted_at AS accepted_at,\n            i.expires_at AS expires_at\n        FROM tenant_client_invites i\n        JOIN tenant_client_users u ON u.id = i.tenant_client_user_id\n        JOIN tenant_clients c ON c.id = i.tenant_client_id\n        JOIN workspaces w ON w.id = i.workspace_id\n        WHERE i.token_hash = $1\n          AND i.workspace_id = $2\n        LIMIT 1\n        ',
  '\n        UPDATE tenant_client_invites\n        SET revoked_at = NOW(), updated_at = NOW()\n        WHERE tenant_client_user_id = $1\n          AND accepted_at IS NULL\n          AND revoked_at IS NULL\n        ',
  '\n        INSERT INTO tenant_client_invites (\n            id,\n            workspace_id,\n            tenant_client_id,\n            tenant_client_user_id,\n            email,\n            token_hash,\n            invited_by_tenant_user_id,\n            expires_at,\n            created_at,\n            updated_at\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())\n        ',
  '\n        SELECT\n            i.id,\n            i.workspace_id,\n            w.slug AS workspace_slug,\n            w.display_name AS workspace_display_name,\n            i.tenant_client_id,\n            c.name AS tenant_client_name,\n            i.tenant_client_user_id,\n            i.email AS invite_email,\n            u.name AS user_name,\n            i.revoked_at AS revoked_at,\n            i.accepted_at AS accepted_at,\n            i.expires_at AS expires_at\n        FROM tenant_client_invites i\n        JOIN tenant_client_users u ON u.id = i.tenant_client_user_id\n        JOIN tenant_clients c ON c.id = i.tenant_client_id\n        JOIN workspaces w ON w.id = i.workspace_id\n        WHERE i.id = $1\n        LIMIT 1\n        ',
  '\n        SELECT\n            u.id,\n            u.workspace_id,\n            u.tenant_client_id,\n            c.name AS tenant_client_name,\n            u.email,\n            u.password_hash,\n            u.name,\n            u.status\n        FROM tenant_client_users u\n        JOIN tenant_clients c ON c.id = u.tenant_client_id\n        WHERE u.workspace_id = $1 AND lower(u.email) = lower($2)\n        LIMIT 1\n        ',
  '\n        INSERT INTO tenant_client_sessions (\n            id,\n            workspace_id,\n            tenant_client_id,\n            tenant_client_user_id,\n            token_hash,\n            expires_at,\n            ip_address,\n            user_agent,\n            last_used_at,\n            created_at,\n            updated_at\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW())\n        ',
  '\n        UPDATE tenant_client_users\n        SET last_login_at = NOW(), updated_at = NOW()\n        WHERE id = $1\n        ',
  '\n        SELECT role\n        FROM tenant_client_user_roles\n        WHERE tenant_client_user_id = $1\n        ORDER BY role ASC\n        ',
  "\n        UPDATE tenant_client_users\n        SET\n            password_hash = $1,\n            name = $2,\n            status = 'active',\n            updated_at = NOW()\n        WHERE id = $3\n        ",
  '\n        UPDATE tenant_client_invites\n        SET accepted_at = NOW(), updated_at = NOW()\n        WHERE id = $1\n        ',
  '\n        SELECT role\n        FROM tenant_client_user_roles\n        WHERE tenant_client_user_id = $1\n        ORDER BY role ASC\n        ',
  '\n        INSERT INTO tenant_client_sessions (\n            id,\n            workspace_id,\n            tenant_client_id,\n            tenant_client_user_id,\n            token_hash,\n            expires_at,\n            ip_address,\n            user_agent,\n            last_used_at,\n            created_at,\n            updated_at\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW(), NOW())\n        ',
] as const;
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { TenantContext } from '../context.js';
import { createId } from '@paralleldrive/cuid2';
import { bad, unauthorized } from '../error.js';
import * as middleware from '../middleware.js';
import { workspacePortalUrl, sendClientInviteEmail } from '../mail.js';
import {
  newToken,
  cookieOptions,
  clearSessionCookie,
  loginInput,
  bodyText,
  hashPassword,
  verifyPassword,
} from './auth.js';
export interface IssuedClientInvite {
  invite_id: string;
  activation_url: string | null;
  portal_url: string | null;
  email_sent: boolean;
  expires_at: Date;
}
export interface ClientUserPayload {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  tenantClientId: string;
  tenantClientName: string;
  email: string;
  name: string | null;
  roles: string[];
}
export function buildClientSessionCookie(
  reply: FastifyReply,
  context: TenantContext,
  value: string,
): void {
  reply.setCookie(
    context.config.client_session_cookie_name,
    value,
    cookieOptions(context.config, true),
  );
}
export function clearClientSessionCookie(
  reply: FastifyReply,
  context: TenantContext,
): void {
  reply.setCookie(
    context.config.client_session_cookie_name,
    '',
    cookieOptions(context.config, true, true),
  );
}
async function findInvite(
  request: FastifyRequest,
  context: TenantContext,
  token: string,
) {
  const workspace = await middleware.resolveWorkspaceFromRequest(
    request,
    context,
  );
  return (
    await context.pool.query(SQL[0], [
      middleware.tokenHash(token),
      workspace.workspace_id,
    ])
  ).rows[0];
}
export async function issueClientInvite(
  context: TenantContext,
  workspaceId: string,
  slug: string,
  clientId: string,
  userId: string,
  email: string,
  invitedBy: string | null,
): Promise<IssuedClientInvite> {
  await context.pool.query(SQL[1], [userId]);
  const invite_id = createId(),
    token = newToken(),
    expires_at = new Date(
      Date.now() + context.config.invite_ttl_hours * 3600000,
    ),
    portal_url = workspacePortalUrl(context, slug),
    activation_url = portal_url
      ? `${portal_url.replace(/\/+$/, '')}/activate?token=${token}`
      : null;
  await context.pool.query(SQL[2], [
    invite_id,
    workspaceId,
    clientId,
    userId,
    email,
    middleware.tokenHash(token),
    invitedBy,
    expires_at,
  ]);
  const info = (await context.pool.query(SQL[3], [invite_id])).rows[0];
  const email_sent = activation_url
    ? await sendClientInviteEmail(
        context,
        workspaceId,
        slug,
        info.workspace_display_name,
        email,
        info.tenant_client_name,
        activation_url,
        portal_url,
        expires_at,
      )
    : false;
  return { invite_id, activation_url, portal_url, email_sent, expires_at };
}
async function clientRoles(
  context: TenantContext,
  id: string,
): Promise<string[]> {
  return (
    await context.pool.query(
      'SELECT role FROM tenant_client_user_roles WHERE tenant_client_user_id=$1 ORDER BY role ASC',
      [id],
    )
  ).rows.map((r) => r.role);
}
async function insertClientSession(
  request: FastifyRequest,
  context: TenantContext,
  workspace: string,
  client: string,
  user: string,
  token: string,
): Promise<void> {
  await context.pool.query(
    `INSERT INTO tenant_client_sessions (id,workspace_id,tenant_client_id,tenant_client_user_id,token_hash,expires_at,ip_address,user_agent,last_used_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW(),NOW())`,
    [
      createId(),
      workspace,
      client,
      user,
      middleware.tokenHash(token),
      new Date(Date.now() + context.config.client_session_ttl_hours * 3600000),
      request.raw.socket.remoteAddress ?? null,
      request.headers['user-agent'] ?? null,
    ],
  );
}
export async function authenticateClientUser(
  request: FastifyRequest,
  context: TenantContext,
  email: string,
  password: string,
): Promise<[ClientUserPayload, string] | null> {
  const workspace = await middleware.resolveWorkspaceFromRequest(
      request,
      context,
    ),
    user = (await context.pool.query(SQL[4], [workspace.workspace_id, email]))
      .rows[0];
  if (
    !user ||
    user.password_hash === null ||
    user.status !== 'active' ||
    !(await verifyPassword(password, user.password_hash))
  )
    return null;
  const token = newToken();
  await insertClientSession(
    request,
    context,
    workspace.workspace_id,
    user.tenant_client_id,
    user.id,
    token,
  );
  await context.pool.query(
    'UPDATE tenant_client_users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1',
    [user.id],
  );
  return [
    {
      id: user.id,
      workspaceId: user.workspace_id,
      workspaceSlug: workspace.workspace_slug,
      tenantClientId: user.tenant_client_id,
      tenantClientName: user.tenant_client_name,
      email: user.email,
      name: user.name,
      roles: await clientRoles(context, user.id),
    },
    token,
  ];
}
export function clientSessionPayload(
  session: Awaited<
    ReturnType<typeof middleware.extractTenantClientUserSession>
  >,
): ClientUserPayload {
  return {
    id: session.tenant_client_user_id,
    workspaceId: session.workspace_id,
    workspaceSlug: session.workspace_slug,
    tenantClientId: session.tenant_client_id,
    tenantClientName: session.tenant_client_name,
    email: session.email,
    name: session.name,
    roles: session.roles,
  };
}
export async function deleteClientSession(
  request: FastifyRequest,
  context: TenantContext,
): Promise<void> {
  let token: string;
  try {
    token = middleware.extractClientSessionToken(request, context);
  } catch {
    return;
  }
  await context.pool.query(
    'DELETE FROM tenant_client_sessions WHERE token_hash=$1',
    [middleware.tokenHash(token)],
  );
}
export function registerClientAuthRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get('/api/client-auth/invite', async (request) => {
    const token = bodyText(request.query, 'token').trim();
    if (!token) throw bad('token is required');
    const i = await findInvite(request, context, token);
    if (!i) throw unauthorized();
    return {
      invite: {
        workspaceId: i.workspace_id,
        workspaceSlug: i.workspace_slug,
        workspaceDisplayName: i.workspace_display_name,
        tenantClientId: i.tenant_client_id,
        tenantClientName: i.tenant_client_name,
        tenantClientUserId: i.tenant_client_user_id,
        email: i.invite_email,
        name: i.user_name,
        expiresAt: i.expires_at,
        isValid: !i.revoked_at && !i.accepted_at && i.expires_at > new Date(),
        acceptedAt: i.accepted_at,
        revokedAt: i.revoked_at,
      },
    };
  });
  app.post(
    '/api/client-auth/accept-invite',
    { schema: { body: dtoSchema(['token', 'password'], ['name']) } },
    async (request, reply) => {
      const token = bodyText(request.body, 'token').trim(),
        password = bodyText(request.body, 'password').trim();
      if (!token || !password) throw bad('token and password are required');
      const i = await findInvite(request, context, token);
      if (!i || i.revoked_at || i.accepted_at || i.expires_at <= new Date())
        throw unauthorized();
      const input = request.body as { name?: unknown };
      if (input.name != null && typeof input.name !== 'string')
        throw bad('invalid name');
      const name =
        (typeof input.name === 'string' ? input.name.trim() : null) ||
        i.user_name;
      const hash = await hashPassword(password);
      await context.pool.query(
        `UPDATE tenant_client_users SET password_hash=$1,name=$2,status='active',updated_at=NOW() WHERE id=$3`,
        [hash, name, i.tenant_client_user_id],
      );
      await context.pool.query(
        'UPDATE tenant_client_invites SET accepted_at=NOW(),updated_at=NOW() WHERE id=$1',
        [i.id],
      );
      const roles = await clientRoles(context, i.tenant_client_user_id),
        tokenValue = newToken();
      await insertClientSession(
        request,
        context,
        i.workspace_id,
        i.tenant_client_id,
        i.tenant_client_user_id,
        tokenValue,
      );
      clearSessionCookie(reply, context.config);
      buildClientSessionCookie(reply, context, tokenValue);
      return {
        audience: 'client',
        clientUser: {
          id: i.tenant_client_user_id,
          workspaceId: i.workspace_id,
          workspaceSlug: i.workspace_slug,
          tenantClientId: i.tenant_client_id,
          tenantClientName: i.tenant_client_name,
          email: i.invite_email,
          name,
          roles,
        },
      };
    },
  );
  app.post(
    '/api/client-auth/login',
    { schema: { body: dtoSchema(['email', 'password'], []) } },
    async (request, reply) => {
      const input = loginInput(request.body),
        result = await authenticateClientUser(
          request,
          context,
          input.email,
          input.password,
        );
      if (!result) throw unauthorized();
      buildClientSessionCookie(reply, context, result[1]);
      clearSessionCookie(reply, context.config);
      return { clientUser: result[0] };
    },
  );
  app.post('/api/client-auth/logout', async (request, reply) => {
    await deleteClientSession(request, context);
    clearClientSessionCookie(reply, context);
    return { message: 'logged out' };
  });
  app.get('/api/client-auth/me', async (request) => ({
    clientUser: clientSessionPayload(
      await middleware.extractTenantClientUserSession(request, context),
    ),
  }));
}
