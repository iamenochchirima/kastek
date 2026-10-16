import { randomBytes } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import type { FastifyInstance, FastifyReply } from 'fastify';
import * as oidc from 'openid-client';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { provider, setting, unauthorized } from '../identity/provider.js';
import { USER_SESSION_COOKIE, sha256, extractUser, requireOrigin } from '../identity/session.js';
import { backchannelLogout, logoutAll } from '../identity/logout.js';
import { typedQuery } from '../typed-query.js';
import {
  requiredFormField,
  requireUrlencodedForm,
  URLENCODED_FORM_BODY_LIMIT,
} from '../urlencoded-form.js';
export function safeReturnPath(value: string): boolean { return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\x00-\x1f\x7f]/.test(value); }
export function authenticationDeadline(authTime: unknown, now = Date.now()): Date {
  if (typeof authTime !== 'number' || !Number.isFinite(authTime) || authTime * 1000 > now + 30_000 || authTime * 1000 + 30 * 86400_000 <= now) throw unauthorized();
  return new Date(authTime * 1000 + 30 * 86400_000);
}
function cookieOptions(context: CoreContext, login = false) {
  return { path: login ? '/api/auth' : '/', httpOnly: true, secure: context.config.environment.toLowerCase() === 'production', sameSite: 'lax' as const, maxAge: login ? 600 : 30 * 86400 };
}
function clearLogin(reply: FastifyReply, context: CoreContext): void { reply.clearCookie('kasitek_login', cookieOptions(context, true)); }
export async function registerAuthRoutes(app: FastifyInstance, context: CoreContext): Promise<void> {
  app.get<{ Querystring: { returnTo?: string; screen?: string } }>('/api/auth/login', async (request, reply) => {
    const query = typedQuery<{ returnTo?: string; screen?: string }>(
      request.query,
      ['returnTo', 'screen'],
    );
    const returnTo = query.returnTo ?? '/';
    if (!safeReturnPath(returnTo)) throw new ApiError(400, 'bad_request', 'Invalid return path');
    const config = await provider(context);
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const browser = randomBytes(32).toString('base64url');
    const parameters: Record<string, string> = { redirect_uri: setting(context, 'OIDC_REDIRECT_URI'), scope: 'openid email profile', code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce, max_age: '2592000' };
    const existing = request.cookies[USER_SESSION_COOKIE];
    if (existing) {
      const valid = await context.pool.query<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM "Session" WHERE "sessionToken"=$1 AND expires>NOW() AND "lastActivityAt">NOW()-INTERVAL \'7 days\')', [sha256(existing)]);
      if (!valid.rows[0]?.exists) parameters.prompt = 'login';
    }
    const url = oidc.buildAuthorizationUrl(config, parameters);
    if (query.screen === 'signup') {
      if (!url.pathname.endsWith('/auth')) throw new ApiError(503, 'service_unavailable', 'Unsupported registration endpoint');
      url.pathname = url.pathname.slice(0, -5) + '/registrations';
    }
    await context.pool.query('DELETE FROM "OidcTransaction" WHERE expires<NOW()');
    await context.pool.query('INSERT INTO "OidcTransaction" (state,"browserHash",nonce,verifier,"returnTo",expires) VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL \'10 minutes\')', [sha256(state), sha256(browser), nonce, verifier, returnTo]);
    reply.header('Cache-Control', 'no-store').setCookie('kasitek_login', browser, cookieOptions(context, true));
    return reply.redirect(url.href);
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>('/api/auth/callback', async (request, reply) => {
    const query = typedQuery<{ state?: string; code?: string; error?: string }>(
      request.query,
      ['state', 'code', 'error'],
    );
    reply.header('Cache-Control', 'no-store');
    try {
      const browser = request.cookies.kasitek_login;
      const state = query.state;
      if (!browser || !state) throw unauthorized();
      const transactions = await context.pool.query<{ nonce: string; verifier: string; returnTo: string }>('DELETE FROM "OidcTransaction" WHERE state=$1 AND "browserHash"=$2 AND expires>NOW() RETURNING nonce,verifier,"returnTo"', [sha256(state), sha256(browser)]);
      const tx = transactions.rows[0];
      if (!tx) throw unauthorized();
      clearLogin(reply, context);
      if (query.error) return reply.redirect(`${context.config.frontendUrl.replace(/\/$/, '')}/auth-error?code=LOGIN_CANCELLED`);
      if (!query.code) throw unauthorized();
      const config = await provider(context);
      const callback = new URL(setting(context, 'OIDC_REDIRECT_URI'));
      callback.search = new URL(request.url, 'http://internal.invalid').search;
      const tokens = await oidc.authorizationCodeGrant(config, callback, { pkceCodeVerifier: tx.verifier, expectedState: state, expectedNonce: tx.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims || !tokens.id_token || !tokens.refresh_token || !claims.sub || claims.email_verified !== true || typeof claims.email !== 'string') throw unauthorized();
      const expires = authenticationDeadline(claims.auth_time);
      const issuer = setting(context, 'OIDC_ISSUER_URL');
      const db = await context.pool.connect();
      let token: string;
      try {
        await db.query('BEGIN');
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${issuer}:${claims.sub}`]);
        const identity = await db.query<{ userId: string }>('SELECT "userId" FROM "ExternalIdentity" WHERE issuer=$1 AND subject=$2', [issuer, claims.sub]);
        const userId = identity.rows[0]?.userId ?? createId();
        if (!identity.rows[0]) {
          try { await db.query('INSERT INTO "User" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,NOW(),NOW(),NOW())', [userId, typeof claims.name === 'string' ? claims.name : null, claims.email]); }
          catch { throw new ApiError(409, 'conflict', 'This email belongs to another identity; manage login methods in your existing account'); }
          await db.query('INSERT INTO "ExternalIdentity" (issuer,subject,"userId") VALUES ($1,$2,$3)', [issuer, claims.sub, userId]);
        }
        try { await db.query('UPDATE "User" SET email=$2,"emailVerified"=NOW(),"updatedAt"=NOW() WHERE id=$1', [userId, claims.email]); }
        catch { throw new ApiError(409, 'conflict', 'Email is already used by another identity'); }
        token = randomBytes(32).toString('base64url');
        await db.query('INSERT INTO "Session" (id,"sessionToken","userId",expires,"lastActivityAt","identityCheckedAt","refreshToken","idToken","providerSid") VALUES ($1,$2,$3,$7,NOW(),NOW(),$4,$5,$6)', [createId(), sha256(token), userId, tokens.refresh_token, tokens.id_token, typeof claims.sid === 'string' ? claims.sid : null, expires]);
        await db.query('COMMIT');
        request.log.info({ event: 'auth.login.success', userId }, 'Shared login completed');
      } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
      reply.setCookie(USER_SESSION_COOKIE, token!, cookieOptions(context));
      return reply.redirect(`${context.config.frontendUrl.replace(/\/$/, '')}${tx.returnTo}`);
    } catch (error) {
      const code = error instanceof ApiError && error.status === 503 ? 'IDENTITY_UNAVAILABLE' : 'LOGIN_FAILED';
      request.log.warn({ event: 'auth.callback.failed', errorCode: code }, 'Shared login callback failed');
      clearLogin(reply, context);
      return reply.redirect(`${context.config.frontendUrl.replace(/\/$/, '')}/auth-error?code=${code}`);
    }
  });
  app.get('/api/auth/me', async (request, reply) => reply.header('Cache-Control', 'no-store').send({ user: await extractUser(request, context) }));
  app.get('/api/auth/account', async (request, reply) => {
    await extractUser(request, context);
    return reply.header('Cache-Control', 'no-store').redirect(`${setting(context, 'OIDC_ISSUER_URL').replace(/\/$/, '')}/account/`);
  });
  app.post('/api/auth/activity', async (request, reply) => { requireOrigin(request, context); await extractUser(request, context); return reply.code(204).send(); });
  for (const all of [false, true]) app.post(all ? '/api/auth/logout-all' : '/api/auth/logout', async (request, reply) => {
    requireOrigin(request, context);
    const cookie = request.cookies[USER_SESSION_COOKIE];
    if (!cookie) throw unauthorized();
    const hash = sha256(cookie);
    const sessions = await context.pool.query<{ userId: string; idToken: string }>('SELECT "userId","idToken" FROM "Session" WHERE "sessionToken"=$1', [hash]);
    const session = sessions.rows[0];
    if (!session) throw unauthorized();
    if (all) await logoutAll(context, session.userId);
    else await context.pool.query('DELETE FROM "Session" WHERE "sessionToken"=$1', [hash]);
    const url = new URL(`${setting(context, 'OIDC_ISSUER_URL').replace(/\/$/, '')}/protocol/openid-connect/logout`);
    url.search = new URLSearchParams({ id_token_hint: session.idToken, client_id: setting(context, 'OIDC_CLIENT_ID'), post_logout_redirect_uri: `${context.config.frontendUrl.replace(/\/$/, '')}/login` }).toString();
    return reply.header('Cache-Control', 'no-store').clearCookie(USER_SESSION_COOKIE, cookieOptions(context)).send({ redirectUrl: url.href });
  });
  app.post('/api/auth/backchannel-logout', {
    bodyLimit: URLENCODED_FORM_BODY_LIMIT,
    onRequest: async (request) => {
      requireUrlencodedForm(request);
    },
  }, async (request, reply) => {
    const token = requiredFormField(request, 'logout_token');
    await backchannelLogout(context, token);
    return reply.code(200).send();
  });
}
