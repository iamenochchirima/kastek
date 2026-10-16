import type {} from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { TenantContext } from '../context.js';
import type { TenantConfig } from '../config.js';
import { randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import bcrypt from 'bcryptjs';
import { bad, unauthorized, TenantError } from '../error.js';
import * as middleware from '../middleware.js';
export interface TenantUserPayload {
  id: string;
  workspaceId: string;
  workspaceSlug: string;
  email: string;
  name: string | null;
  roles: string[];
  agencyPartner: boolean;
}
export const newToken = () => randomBytes(48).toString('base64url');
export function cookieOptions(
  config: TenantConfig,
  client = false,
  clear = false,
) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: config.session_cookie_same_site,
    secure: config.session_cookie_secure,
    expires: new Date(
      Date.now() +
        (clear
          ? -86400000
          : (client
              ? config.client_session_ttl_hours
              : config.session_ttl_hours) * 3600000),
    ),
    ...(config.session_cookie_domain
      ? { domain: config.session_cookie_domain }
      : {}),
  };
}
export function buildSessionCookie(
  reply: FastifyReply,
  config: TenantConfig,
  value: string,
): void {
  reply.setCookie(config.session_cookie_name, value, cookieOptions(config));
}
export function clearSessionCookie(
  reply: FastifyReply,
  config: TenantConfig,
): void {
  reply.setCookie(
    config.session_cookie_name,
    '',
    cookieOptions(config, false, true),
  );
}
export function bodyText(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string') throw bad(`${key} is required`);
  return value;
}
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  // Rust bcrypt accepts 2a/2b/2x/2y and parses cost rather than requiring
  // exactly two digits. Its 2x path uses the same maintained bcrypt algorithm.
  const parts = hash.split('$').filter(Boolean);
  const cost = Number(parts[1]);
  if (
    parts.length !== 3 ||
    !['2a', '2b', '2x', '2y'].includes(parts[0]!) ||
    !/^\+?\d+$/.test(parts[1]!) ||
    !Number.isInteger(cost) ||
    cost < 4 ||
    cost > 31 ||
    !/[./A-Za-z0-9]{53}/.test(parts[2]!) ||
    parts[2]!.length !== 53
  )
    throw new TenantError(500, 'password error');
  try {
    return await bcrypt.compare(
      password,
      `$2b$${String(cost).padStart(2, '0')}$${parts[2]}`,
    );
  } catch {
    throw new TenantError(500, 'password error');
  }
}
export async function hashPassword(password: string): Promise<string> {
  try {
    return await bcrypt.hash(password, 12);
  } catch {
    throw new TenantError(500, 'password error');
  }
}
export async function insertTenantSession(
  db: Pool | PoolClient,
  context: TenantContext,
  request: FastifyRequest,
  workspaceId: string,
  userId: string,
  token: string,
): Promise<void> {
  await db.query(
    'INSERT INTO tenant_sessions (id,workspace_id,tenant_user_id,token_hash,expires_at,ip_address,user_agent,last_used_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW(),NOW())',
    [
      createId(),
      workspaceId,
      userId,
      middleware.tokenHash(token),
      new Date(Date.now() + context.config.session_ttl_hours * 3600000),
      request.raw.socket.remoteAddress ?? null,
      request.headers['user-agent'] ?? null,
    ],
  );
}
export async function tenantRoles(
  db: Pool | PoolClient,
  userId: string,
): Promise<string[]> {
  return (
    await db.query(
      'SELECT role FROM tenant_user_roles WHERE tenant_user_id=$1 ORDER BY role ASC',
      [userId],
    )
  ).rows.map((row) => row.role);
}
export async function authenticateTenantUser(
  request: FastifyRequest,
  context: TenantContext,
  email: string,
  password: string,
): Promise<[TenantUserPayload, string] | null> {
  const workspace = await middleware.resolveWorkspaceFromRequest(
    request,
    context,
  );
  const user = (
    await context.pool.query(
      'SELECT id,workspace_id,email,password_hash,name,status FROM tenant_users WHERE workspace_id=$1 AND lower(email)=lower($2) LIMIT 1',
      [workspace.workspace_id, email],
    )
  ).rows[0];
  if (
    !user ||
    user.status !== 'active' ||
    typeof user.password_hash !== 'string' ||
    !(await verifyPassword(password, user.password_hash))
  )
    return null;
  const token = newToken();
  await insertTenantSession(
    context.pool,
    context,
    request,
    workspace.workspace_id,
    user.id,
    token,
  );
  await context.pool.query(
    'UPDATE tenant_users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1',
    [user.id],
  );
  return [
    {
      id: user.id,
      workspaceId: user.workspace_id,
      workspaceSlug: workspace.workspace_slug,
      email: user.email,
      name: user.name,
      roles: await tenantRoles(context.pool, user.id),
      agencyPartner: false,
    },
    token,
  ];
}
export function sessionPayload(
  session: Awaited<ReturnType<typeof middleware.extractTenantUserSession>>,
): TenantUserPayload {
  return {
    id: session.tenant_user_id,
    workspaceId: session.workspace_id,
    workspaceSlug: session.workspace_slug,
    email: session.email,
    name: session.name,
    roles: session.roles,
    agencyPartner: session.agency_partner,
  };
}
export function loginInput(body: unknown): { email: string; password: string } {
  const email = bodyText(body, 'email')
      .trim()
      .replace(/[A-Z]/g, (c) => c.toLowerCase()),
    password = bodyText(body, 'password').trim();
  if (!email || !password) throw bad('email and password are required');
  return { email, password };
}
export async function deleteTenantSession(
  request: FastifyRequest,
  context: TenantContext,
): Promise<void> {
  let token: string;
  try {
    token = middleware.extractTenantSessionToken(request, context);
  } catch {
    return;
  }
  await context.pool.query('DELETE FROM tenant_sessions WHERE token_hash=$1', [
    middleware.tokenHash(token),
  ]);
}
export function registerAuthRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.post(
    '/api/auth/login',
    { schema: { body: dtoSchema(['email', 'password']) } },
    async (request, reply) => {
      const { email, password } = loginInput(request.body),
        result = await authenticateTenantUser(
          request,
          context,
          email,
          password,
        );
      if (!result) throw unauthorized();
      buildSessionCookie(reply, context.config, result[1]);
      return { user: result[0] };
    },
  );
  app.post('/api/auth/logout', async (request, reply) => {
    await deleteTenantSession(request, context);
    clearSessionCookie(reply, context.config);
    return { message: 'logged out' };
  });
  app.get('/api/auth/me', async (request) => ({
    user: sessionPayload(
      await middleware.extractTenantUserSession(request, context),
    ),
  }));
}

/** Serde DTO boundary: unknown fields allowed, declared fields keep their exact types. */
export function dtoSchema(
  required: readonly string[],
  optional: readonly string[] = [],
) {
  return {
    type: 'object',
    required: [...required],
    properties: Object.fromEntries([
      ...required.map((key) => [key, { type: 'string' }]),
      ...optional.map((key) => [key, { type: ['string', 'null'] }]),
    ]),
  };
}
