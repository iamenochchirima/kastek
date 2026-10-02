import type { webcrypto } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { CoreContext } from '../context.js';
import { providerRequest, setting, unauthorized, unavailable } from './provider.js';
export function validateLogoutEvent(claims: JWTPayload, issuer: string, now = Math.floor(Date.now() / 1000)): void {
  const events = claims.events as Record<string, unknown> | undefined;
  const event = events?.['http://schemas.openid.net/event/backchannel-logout'];
  if (claims.iss !== issuer || claims.nonce !== undefined || typeof claims.iat !== 'number'
    || claims.iat > now + 30 || claims.iat < now - 300 || typeof claims.jti !== 'string' || !claims.jti
    || (!(typeof claims.sid === 'string' && claims.sid) && !(typeof claims.sub === 'string' && claims.sub))
    || !event || typeof event !== 'object' || Array.isArray(event)) throw unauthorized();
}
export async function verifyLogoutToken(token: string, key: webcrypto.CryptoKey | JWTVerifyGetKey, issuer: string, audience: string): Promise<JWTPayload> {
  try {
    const result = await jwtVerify(token, key, { issuer, audience, algorithms: ['RS256'], clockTolerance: 30 });
    validateLogoutEvent(result.payload, issuer);
    return result.payload;
  } catch { throw unauthorized(); }
}
export async function backchannelLogout(context: CoreContext, token: string): Promise<void> {
  const issuer = setting(context, 'OIDC_ISSUER_URL');
  const jwks = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`), { timeoutDuration: 10_000 });
  const claims = await verifyLogoutToken(token, jwks, issuer, setting(context, 'OIDC_CLIENT_ID'));
  const db = await context.pool.connect();
  try {
    await db.query('BEGIN');
    const replay = await db.query('INSERT INTO "OidcLogoutReplay" (jti,expires) VALUES ($1,NOW()+INTERVAL \'10 minutes\') ON CONFLICT DO NOTHING', [claims.jti]);
    if (replay.rowCount !== 1) throw unauthorized();
    if (typeof claims.sid === 'string' && claims.sid) await db.query('DELETE FROM "Session" WHERE "providerSid"=$1', [claims.sid]);
    else await db.query('DELETE FROM "Session" WHERE "userId" IN (SELECT "userId" FROM "ExternalIdentity" WHERE issuer=$1 AND subject=$2)', [issuer, claims.sub]);
    await db.query('DELETE FROM "OidcLogoutReplay" WHERE expires<NOW()');
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
export async function logoutAll(context: CoreContext, userId: string): Promise<void> {
  const issuer = setting(context, 'OIDC_ISSUER_URL');
  const identity = await context.pool.query<{ subject: string }>('SELECT subject FROM "ExternalIdentity" WHERE issuer=$1 AND "userId"=$2', [issuer, userId]);
  if (!identity.rows[0]) throw unauthorized();
  const tokens = await providerRequest(context, 'token', {
    grant_type: 'client_credentials', client_id: setting(context, 'OIDC_ADMIN_CLIENT_ID'), client_secret: setting(context, 'OIDC_ADMIN_CLIENT_SECRET'),
  });
  if (typeof tokens.access_token !== 'string') throw unavailable();
  try {
    const response = await fetch(`${issuer.replace('/realms/', '/admin/realms/')}/users/${encodeURIComponent(identity.rows[0].subject)}/logout`, {
      method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw unavailable();
  } catch { throw unavailable(); }
  await context.pool.query('DELETE FROM "Session" WHERE "userId"=$1', [userId]);
}
