import type {} from '@fastify/cookie';
import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { TenantContext } from './context.js';
import type {
  TenantAccessContext,
  TenantResolvedWorkspace,
  TenantWorkspaceContext,
  TenantUserSessionContext,
  TenantClientUserSessionContext,
} from './types.js';
import { unauthorized, forbidden, missing } from './error.js';
export const dbPool = (_request: FastifyRequest, context: TenantContext) =>
  context.pool;
export const appConfig = (_request: FastifyRequest, context: TenantContext) =>
  context.config;
export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export function tenantUserHasAnyRole(
  roles: string[],
  allowed: readonly string[],
): boolean {
  return allowed.some((role) => roles.includes(role));
}
export function requireTenantRoles(
  roles: string[],
  allowed: readonly string[],
): void {
  if (!tenantUserHasAnyRole(roles, allowed)) throw forbidden();
}
export async function requireActiveTenantClient(
  pool: Pool,
  workspace: string,
  client: string,
): Promise<{ name: string; status: string }> {
  const row = (
    await pool.query(
      'SELECT name,status FROM tenant_clients WHERE workspace_id=$1 AND id=$2 LIMIT 1',
      [workspace, client],
    )
  ).rows[0];
  if (!row) throw missing('tenant client not found');
  if (row.status !== 'active') throw forbidden();
  return row;
}
export async function requireClientScopedConversation(
  pool: Pool,
  workspace: string,
  client: string,
  id: string,
): Promise<void> {
  if (
    !(
      await pool.query(
        'SELECT id FROM conversations WHERE workspace_id=$1 AND tenant_client_id=$2 AND id=$3 LIMIT 1',
        [workspace, client, id],
      )
    ).rows[0]
  )
    throw missing('conversation not found');
}
export function extractBearerToken(request: FastifyRequest): string {
  const value = request.headers.authorization;
  if (
    typeof value !== 'string' ||
    !value.startsWith('Bearer ') ||
    !value.slice(7).trim()
  )
    throw unauthorized();
  return value.slice(7).trim();
}
export function extractTenantSessionToken(
  request: FastifyRequest,
  context: TenantContext,
): string {
  const value = request.cookies[context.config.session_cookie_name]?.trim();
  if (!value) throw unauthorized();
  return value;
}
export function extractClientSessionToken(
  request: FastifyRequest,
  context: TenantContext,
): string {
  const value =
    request.cookies[context.config.client_session_cookie_name]?.trim();
  if (!value) throw unauthorized();
  return value;
}
function requestHost(request: FastifyRequest): string | undefined {
  const raw =
    request.headers['x-kasitek-tenant-host'] ??
    request.headers['x-forwarded-host'] ??
    request.headers.host;
  if (typeof raw !== 'string' || !raw.trim()) return;
  return raw.trim().split(',')[0]!.trim();
}
function normalizeHost(host: string): string {
  return host
    .trim()
    .replace(/^(?:http:\/\/)+/, '')
    .replace(/^(?:https:\/\/)+/, '')
    .split(':')[0]!
    .trim()
    .replace(/[A-Z]/g, (c) => c.toLowerCase());
}
function platformSlug(host: string, base: string): string | undefined {
  host = host
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();
  base = base
    .trim()
    .replace(/^\.+|\.+$/g, '')
    .toLowerCase();
  if (!host || !base || host === base || !host.endsWith('.' + base)) return;
  const slug = host.slice(0, -base.length - 1).trim();
  return slug && !slug.includes('.') ? slug : undefined;
}
function resolved(row: Record<string, unknown>): TenantResolvedWorkspace {
  if (row.status !== 'active') throw forbidden();
  return {
    workspace_id: row.workspace_id as string,
    workspace_slug: row.workspace_slug as string,
    display_name: row.display_name as string,
  };
}
async function resolveBySlug(
  context: TenantContext,
  slug: string,
): Promise<TenantResolvedWorkspace> {
  const row = (
    await context.pool.query(
      'SELECT id AS workspace_id,slug AS workspace_slug,display_name,status FROM workspaces WHERE slug=$1 LIMIT 1',
      [slug],
    )
  ).rows[0];
  if (!row) throw missing('workspace not found');
  return resolved(row);
}
export async function resolveWorkspaceFromRequest(
  request: FastifyRequest,
  context: TenantContext,
): Promise<TenantResolvedWorkspace> {
  const raw = requestHost(request);
  if (raw) {
    const host = normalizeHost(raw);
    if (host) {
      const row = (
        await context.pool.query(
          'SELECT w.id AS workspace_id,w.slug AS workspace_slug,w.display_name,w.status FROM workspace_domains d JOIN workspaces w ON w.id=d.workspace_id WHERE lower(d.domain)=lower($1) LIMIT 1',
          [host],
        )
      ).rows[0];
      if (row) return resolved(row);
      if (context.config.platform_base_domain) {
        const slug = platformSlug(host, context.config.platform_base_domain);
        if (slug) return resolveBySlug(context, slug);
      }
    }
  }
  if (context.config.default_workspace_slug)
    return resolveBySlug(context, context.config.default_workspace_slug);
  throw missing('workspace could not be resolved from request host');
}
export async function extractWorkspaceContextFromApiKey(
  request: FastifyRequest,
  context: TenantContext,
): Promise<TenantWorkspaceContext> {
  const row = (
    await context.pool.query(
      'SELECT w.id AS workspace_id,w.slug AS workspace_slug,w.status AS workspace_status,k.scopes,k.id AS key_id,k.revoked_at,k.expires_at FROM workspace_api_keys k JOIN workspaces w ON w.id=k.workspace_id WHERE k.key_hash=$1 LIMIT 1',
      [tokenHash(extractBearerToken(request))],
    )
  ).rows[0];
  if (!row) throw unauthorized();
  if (row.workspace_status !== 'active') throw forbidden();
  if (row.revoked_at || (row.expires_at && row.expires_at <= new Date()))
    throw unauthorized();
  await context.pool.query(
    'UPDATE workspace_api_keys SET last_used_at=NOW(),updated_at=NOW() WHERE id=$1',
    [row.key_id],
  );
  return {
    workspace_id: row.workspace_id,
    workspace_slug: row.workspace_slug,
    scopes: Array.isArray(row.scopes)
      ? row.scopes.filter(
          (value: unknown): value is string => typeof value === 'string',
        )
      : [],
  };
}
export async function extractTenantUserSession(
  request: FastifyRequest,
  context: TenantContext,
): Promise<TenantUserSessionContext> {
  const token = extractTenantSessionToken(request, context),
    workspace = await resolveWorkspaceFromRequest(request, context);
  const row = (
    await context.pool.query(
      'SELECT s.workspace_id,w.slug AS workspace_slug,s.tenant_user_id,u.email,u.name,u.status AS user_status,s.id AS session_id,s.expires_at FROM tenant_sessions s JOIN tenant_users u ON u.id=s.tenant_user_id JOIN workspaces w ON w.id=s.workspace_id WHERE s.token_hash=$1 AND s.workspace_id=$2 LIMIT 1',
      [tokenHash(token), workspace.workspace_id],
    )
  ).rows[0];
  if (!row || row.user_status !== 'active' || row.expires_at <= new Date())
    throw unauthorized();
  await context.pool.query(
    'UPDATE tenant_sessions SET last_used_at=NOW(),updated_at=NOW() WHERE id=$1',
    [row.session_id],
  );
  return {
    workspace_id: row.workspace_id,
    workspace_slug: row.workspace_slug,
    tenant_user_id: row.tenant_user_id,
    email: row.email,
    name: row.name,
    roles: (
      await context.pool.query(
        'SELECT role FROM tenant_user_roles WHERE tenant_user_id=$1 ORDER BY role ASC',
        [row.tenant_user_id],
      )
    ).rows.map((row) => row.role),
  };
}
export async function extractTenantClientUserSession(
  request: FastifyRequest,
  context: TenantContext,
): Promise<TenantClientUserSessionContext> {
  const token = extractClientSessionToken(request, context),
    workspace = await resolveWorkspaceFromRequest(request, context);
  const row = (
    await context.pool.query(
      'SELECT s.workspace_id,w.slug AS workspace_slug,c.id AS tenant_client_id,c.name AS tenant_client_name,s.tenant_client_user_id,u.email,u.name,u.status AS user_status,s.id AS session_id,s.expires_at FROM tenant_client_sessions s JOIN tenant_client_users u ON u.id=s.tenant_client_user_id JOIN tenant_clients c ON c.id=s.tenant_client_id JOIN workspaces w ON w.id=s.workspace_id WHERE s.token_hash=$1 AND s.workspace_id=$2 LIMIT 1',
      [tokenHash(token), workspace.workspace_id],
    )
  ).rows[0];
  if (!row || row.user_status !== 'active' || row.expires_at <= new Date())
    throw unauthorized();
  await context.pool.query(
    'UPDATE tenant_client_sessions SET last_used_at=NOW(),updated_at=NOW() WHERE id=$1',
    [row.session_id],
  );
  return {
    workspace_id: row.workspace_id,
    workspace_slug: row.workspace_slug,
    tenant_client_id: row.tenant_client_id,
    tenant_client_name: row.tenant_client_name,
    tenant_client_user_id: row.tenant_client_user_id,
    email: row.email,
    name: row.name,
    roles: (
      await context.pool.query(
        'SELECT role FROM tenant_client_user_roles WHERE tenant_client_user_id=$1 ORDER BY role ASC',
        [row.tenant_client_user_id],
      )
    ).rows.map((row) => row.role),
  };
}
export async function extractAccessContext(
  request: FastifyRequest,
  context: TenantContext,
): Promise<TenantAccessContext> {
  if (Object.hasOwn(request.cookies, context.config.session_cookie_name)) {
    const session = await extractTenantUserSession(request, context);
    return {
      workspace_id: session.workspace_id,
      workspace_slug: session.workspace_slug,
      scopes: ['tenant:portal'],
      tenant_user_id: session.tenant_user_id,
      tenant_user_roles: session.roles,
    };
  }
  const key = await extractWorkspaceContextFromApiKey(request, context);
  return { ...key, tenant_user_id: null, tenant_user_roles: [] };
}
