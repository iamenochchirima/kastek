import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { providerRequest, setting, unauthorized } from './provider.js';
export const USER_SESSION_COOKIE = 'kasitek_session';
export const ACTIVE_ORG_COOKIE = 'kasitek_active_org';
export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export interface UserRecord {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  image: string | null;
  emailVerified: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export function requireOrigin(
  request: FastifyRequest,
  context: CoreContext,
): void {
  let expected: string;
  try {
    expected = new URL(context.config.frontendUrl).origin;
  } catch {
    throw new ApiError(
      503,
      'service_unavailable',
      'Frontend origin is not configured',
    );
  }
  if (request.headers.origin !== expected)
    throw new ApiError(403, 'forbidden', 'Invalid request origin');
}
export function interactiveActivity(
  request: Pick<FastifyRequest, 'method' | 'url' | 'headers'>,
): boolean {
  const path = request.url.split('?')[0]!;
  return (
    request.headers['x-kasitek-background'] !== '1' &&
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    path !== '/api/auth/me' &&
    !path.includes('/realtime') &&
    !path.includes('/notifications')
  );
}
export async function checkSession(
  request: FastifyRequest,
  context: CoreContext,
  hash: string,
): Promise<string> {
  const db = await context.pool.connect();
  try {
    await db.query('BEGIN');
    const raw = Number(context.config.env.OIDC_REVOCATION_CHECK_SECONDS ?? 300);
    const seconds = Math.max(
      1,
      Math.min(300, Number.isFinite(raw) ? raw : 300),
    );
    const result = await db.query<{
      userId: string;
      refreshToken: string;
      check: boolean;
      refresh: boolean;
    }>(
      `SELECT "userId","refreshToken", "identityCheckedAt" < NOW()-make_interval(secs=>$2) AS check, "providerRefreshedAt" < NOW()-make_interval(secs=>$2) AS refresh FROM "Session" WHERE "sessionToken"=$1 AND expires>NOW() AND "lastActivityAt">NOW()-INTERVAL '7 days' FOR UPDATE`,
      [hash, seconds],
    );
    const session = result.rows[0];
    if (!session) throw unauthorized();
    const interactive = interactiveActivity(request);
    const refresh = interactive && session.refresh;
    if (session.check || refresh) {
      let body: Record<string, unknown>;
      try {
        body = await providerRequest(
          context,
          refresh ? 'token' : 'token/introspect',
          {
            ...(refresh
              ? {
                  grant_type: 'refresh_token',
                  refresh_token: session.refreshToken,
                }
              : {
                  token: session.refreshToken,
                  token_type_hint: 'refresh_token',
                }),
            client_id: setting(context, 'OIDC_CLIENT_ID'),
            client_secret: setting(context, 'OIDC_CLIENT_SECRET'),
          },
        );
        if (!refresh && body.active !== true) throw unauthorized();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await db.query('DELETE FROM "Session" WHERE "sessionToken"=$1', [
            hash,
          ]);
          await db.query('COMMIT');
        }
        throw error;
      }
      // Rust rejects malformed successful refresh tokens without committing session deletion.
      if (refresh && typeof body.refresh_token !== 'string')
        throw unauthorized();
      if (refresh)
        await db.query(
          'UPDATE "Session" SET "refreshToken"=$2,"identityCheckedAt"=NOW(),"providerRefreshedAt"=NOW() WHERE "sessionToken"=$1',
          [hash, body.refresh_token],
        );
      else
        await db.query(
          'UPDATE "Session" SET "identityCheckedAt"=NOW() WHERE "sessionToken"=$1',
          [hash],
        );
    }
    if (interactive)
      await db.query(
        'UPDATE "Session" SET "lastActivityAt"=NOW() WHERE "sessionToken"=$1',
        [hash],
      );
    await db.query('COMMIT');
    return session.userId;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
export async function extractUserAllowUnverified(
  request: FastifyRequest,
  context: CoreContext,
): Promise<UserRecord> {
  const cookie = request.cookies[USER_SESSION_COOKIE];
  if (cookie && !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
    requireOrigin(request, context);
  const bearer = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7).trim()
    : undefined;
  const token = cookie ?? bearer;
  if (!token) throw unauthorized();
  const id = await checkSession(request, context, sha256(token));
  const result = await context.pool.query<UserRecord>(
    'SELECT id,name,email,phone,image,"emailVerified","createdAt","updatedAt" FROM "User" WHERE id=$1',
    [id],
  );
  if (!result.rows[0]) throw unauthorized();
  return result.rows[0];
}
export async function extractUser(
  request: FastifyRequest,
  context: CoreContext,
): Promise<UserRecord> {
  const user = await extractUserAllowUnverified(request, context);
  if (!user.emailVerified)
    throw new ApiError(
      403,
      'forbidden',
      'Verify your email before accessing your workspace',
    );
  return user;
}
export function activeOrgCookie(request: FastifyRequest): string | undefined {
  return request.cookies[ACTIVE_ORG_COOKIE]?.trim() || undefined;
}
export async function resolveActiveOrgId(
  request: FastifyRequest,
  context: CoreContext,
  userId: string,
): Promise<string> {
  const preferred = activeOrgCookie(request);
  const result = preferred
    ? await context.pool.query<{ orgId: string }>(
        'SELECT "orgId" FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=$2',
        [preferred, userId],
      )
    : await context.pool.query<{ orgId: string }>(
        'SELECT m."orgId" FROM "OrganizationMember" m JOIN "Organization" o ON o.id=m."orgId" WHERE m."userId"=$1 ORDER BY o."createdAt" ASC LIMIT 1',
        [userId],
      );
  if (!result.rows[0])
    throw new ApiError(
      403,
      'forbidden',
      preferred
        ? 'Insufficient permissions'
        : 'No organisation is available for this user',
    );
  return result.rows[0].orgId;
}
