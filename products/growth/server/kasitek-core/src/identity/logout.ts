import type { webcrypto } from 'node:crypto';
import {
  decodeProtectedHeader,
  importJWK,
  compactVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { SerdeFloat } from '@kasitek-labs/server-support/json';
import { parseSerdeValueJson } from '../json.js';
import type { CoreContext } from '../context.js';
import {
  providerRequest,
  setting,
  unauthorized,
  unavailable,
} from './provider.js';
export function validateLogoutEvent(
  claims: JWTPayload,
  issuer: string,
  now = Math.floor(Date.now() / 1000),
): void {
  const events = claims.events as Record<string, unknown> | undefined;
  const event = events?.['http://schemas.openid.net/event/backchannel-logout'];
  if (
    claims.iss !== issuer ||
    claims.nonce != null ||
    typeof claims.iat !== 'number' ||
    !Number.isSafeInteger(claims.iat) ||
    [claims.sid, claims.sub].some(
      (value) => value != null && typeof value !== 'string',
    ) ||
    claims.iat > now + 30 ||
    claims.iat < now - 300 ||
    typeof claims.jti !== 'string' ||
    !claims.jti ||
    (!(typeof claims.sid === 'string' && claims.sid) &&
      !(typeof claims.sub === 'string' && claims.sub)) ||
    !event ||
    typeof event !== 'object' ||
    Array.isArray(event)
  )
    throw unauthorized();
}
export async function verifyLogoutToken(
  token: string,
  key: webcrypto.CryptoKey | JWTVerifyGetKey,
  issuer: string,
  audience: string,
): Promise<JWTPayload> {
  try {
    const verified = await compactVerify(token, key, { algorithms: ['RS256'] });
    const value = parseSerdeValueJson(
      new TextDecoder('utf-8', { fatal: true }).decode(verified.payload),
    );
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Object.hasOwn(value, 'aud')
    )
      throw unauthorized();
    const claims = value as JWTPayload;
    // jsonwebtoken 9 validates a parsed audience, optional expiry with 60s leeway,
    // and does not validate nbf. Keep its defaults rather than adding JWT requirements.
    const aud = claims.aud;
    if (
      typeof aud === 'string'
        ? aud !== audience
        : Array.isArray(aud) &&
          aud.every((item) => typeof item === 'string') &&
          !aud.includes(audience)
    )
      throw unauthorized();
    const exp = claims.exp as unknown;
    let expiry: bigint | undefined;
    if (typeof exp === 'bigint' && exp >= 0n && exp < 1n << 64n) expiry = exp;
    else {
      const number =
        exp instanceof SerdeFloat
          ? exp.value
          : typeof exp === 'number'
            ? exp
            : NaN;
      if (Number.isFinite(number) && number >= 0 && number < 2 ** 64)
        expiry = BigInt(Math.round(number));
    }
    if (
      expiry !== undefined &&
      expiry < BigInt(Math.floor(Date.now() / 1000) - 60)
    )
      throw unauthorized();
    validateLogoutEvent(claims, issuer);
    return claims;
  } catch {
    throw unauthorized();
  }
}
export async function backchannelLogout(
  context: CoreContext,
  token: string,
): Promise<void> {
  const issuer = setting(context, 'OIDC_ISSUER_URL');
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw unauthorized();
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    throw unauthorized();
  let jwks: { keys: Record<string, unknown>[] };
  try {
    const response = await fetch(
      `${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`,
      { redirect: 'error', signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) throw unavailable();
    jwks = (await response.json()) as typeof jwks;
    if (
      !jwks ||
      !Array.isArray(jwks.keys) ||
      jwks.keys.some(
        (key) => !key || typeof key !== 'object' || Array.isArray(key),
      )
    )
      throw unavailable();
  } catch {
    throw unavailable();
  }
  const jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) throw unauthorized();
  let key: webcrypto.CryptoKey;
  try {
    const imported = await importJWK(jwk, 'RS256');
    if (imported instanceof Uint8Array) throw unauthorized();
    key = imported;
  } catch {
    throw unauthorized();
  }
  const claims = await verifyLogoutToken(
    token,
    key,
    issuer,
    setting(context, 'OIDC_CLIENT_ID'),
  );
  const db = await context.pool.connect();
  try {
    await db.query('BEGIN');
    const replay = await db.query(
      'INSERT INTO "OidcLogoutReplay" (jti,expires) VALUES ($1,NOW()+INTERVAL \'10 minutes\') ON CONFLICT DO NOTHING',
      [claims.jti],
    );
    if (replay.rowCount !== 1) throw unauthorized();
    if (typeof claims.sid === 'string' && claims.sid)
      await db.query('DELETE FROM "Session" WHERE "providerSid"=$1', [
        claims.sid,
      ]);
    else
      await db.query(
        'DELETE FROM "Session" WHERE "userId" IN (SELECT "userId" FROM "ExternalIdentity" WHERE issuer=$1 AND subject=$2)',
        [issuer, claims.sub],
      );
    await db.query('DELETE FROM "OidcLogoutReplay" WHERE expires<NOW()');
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}
export async function logoutAll(
  context: CoreContext,
  userId: string,
): Promise<void> {
  const issuer = setting(context, 'OIDC_ISSUER_URL');
  const identity = await context.pool.query<{ subject: string }>(
    'SELECT subject FROM "ExternalIdentity" WHERE issuer=$1 AND "userId"=$2',
    [issuer, userId],
  );
  if (!identity.rows[0]) throw unauthorized();
  let tokens: Record<string, unknown>;
  try {
    tokens = await providerRequest(context, 'token', {
      grant_type: 'client_credentials',
      client_id: setting(context, 'OIDC_ADMIN_CLIENT_ID'),
      client_secret: setting(context, 'OIDC_ADMIN_CLIENT_SECRET'),
    });
  } catch {
    throw unavailable();
  }
  if (typeof tokens.access_token !== 'string') throw unavailable();
  try {
    const response = await fetch(
      `${issuer.replace('/realms/', '/admin/realms/')}/users/${encodeURIComponent(identity.rows[0].subject)}/logout`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens.access_token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) throw unavailable();
  } catch {
    throw unavailable();
  }
  await context.pool.query('DELETE FROM "Session" WHERE "userId"=$1', [userId]);
}
