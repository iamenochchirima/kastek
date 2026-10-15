import { createId } from '@paralleldrive/cuid2';
import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { transaction } from '../db.js';
import type { TenantContext } from '../context.js';
import { TenantError, bad, forbidden, unauthorized } from '../error.js';
import { clearSessionCookie } from './auth.js';
import { clearClientSessionCookie } from './client-auth.js';
import {
  clearPartnerSessionCookie,
  hashPartnerToken,
  newPartnerToken,
  partnerCookieOptions,
  requireAgencyPartner,
  requirePartnerSameOrigin,
  recordPartnerActivity,
  setPartnerSessionCookie,
} from '../partner-session.js';

type OidcMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

type OidcClient = {
  metadata: OidcMetadata;
  jwks: ReturnType<typeof createRemoteJWKSet>;
};

const clients = new Map<string, Promise<OidcClient>>();
const FLOW_COOKIE = 'kasitek.agency.login-flow';
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

function oidcEnabled(context: TenantContext) {
  return !!context.config.partner_oidc_client_secret;
}

async function oidcClient(context: TenantContext): Promise<OidcClient> {
  if (!oidcEnabled(context))
    throw new TenantError(503, 'partner sign-in is not configured');
  const issuer = context.config.partner_oidc_issuer_url;
  let pending = clients.get(issuer);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new TenantError(503, 'identity provider unavailable');
      const raw = (await response.json()) as Partial<OidcMetadata>;
      if (
        raw.issuer !== issuer ||
        typeof raw.authorization_endpoint !== 'string' ||
        typeof raw.token_endpoint !== 'string' ||
        typeof raw.jwks_uri !== 'string'
      ) throw new TenantError(503, 'identity provider metadata is invalid');
      const metadata: OidcMetadata = {
        issuer,
        authorization_endpoint: raw.authorization_endpoint,
        token_endpoint: raw.token_endpoint,
        jwks_uri: raw.jwks_uri,
        ...(typeof raw.end_session_endpoint === 'string'
          ? { end_session_endpoint: raw.end_session_endpoint }
          : {}),
      };
      return { metadata, jwks: createRemoteJWKSet(new URL(metadata.jwks_uri)) };
    })();
    clients.set(issuer, pending);
    pending.catch(() => clients.delete(issuer));
  }
  return pending;
}

function flowCookie(context: TenantContext, value: string, clear = false) {
  return {
    ...partnerCookieOptions(context),
    path: '/',
    maxAge: clear ? 0 : 600,
    ...(clear ? { expires: new Date(0) } : {}),
    value,
  };
}

function partnerHome(context: TenantContext, path: string) {
  return `${context.config.partner_app_base_url}${path}`;
}

function safeText(value: unknown, max = 200) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

function logoutUrl(client: OidcClient, context: TenantContext) {
  const returnTo = partnerHome(context, '/login?audience=partner');
  if (!client.metadata.end_session_endpoint) return returnTo;
  const url = new URL(client.metadata.end_session_endpoint);
  url.searchParams.set('client_id', context.config.partner_oidc_client_id);
  url.searchParams.set('post_logout_redirect_uri', returnTo);
  return url.toString();
}

async function revokeProviderSessions(
  context: TenantContext,
  partner: { subject: string },
) {
  const secret = context.config.partner_oidc_admin_client_secret;
  if (!secret) throw new TenantError(503, 'all-device sign-out is not configured');
  const oidc = await oidcClient(context);
  const tokenResponse = await fetch(oidc.metadata.token_endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(
        `${context.config.partner_oidc_admin_client_id}:${secret}`,
      ).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
    signal: AbortSignal.timeout(15000),
  });
  const tokenBody = await tokenResponse.json().catch(() => null) as
    | { access_token?: unknown }
    | null;
  if (!tokenResponse.ok || typeof tokenBody?.access_token !== 'string')
    throw new TenantError(503, 'identity provider session revocation failed');
  const adminUrl = new URL(
    `/admin/realms/kasitek/users/${encodeURIComponent(partner.subject)}/logout`,
    new URL(context.config.partner_oidc_issuer_url).origin,
  );
  const response = await fetch(adminUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok && response.status !== 404)
    throw new TenantError(503, 'identity provider session revocation failed');
}

async function createPartnerSession(
  request: FastifyRequest,
  context: TenantContext,
  claims: JWTPayload,
) {
  const issuer = context.config.partner_oidc_issuer_url;
  const subject = safeText(claims.sub, 255);
  const email = safeText(claims.email, 320)?.toLowerCase() ?? null;
  const displayName = safeText(claims.name, 200) ?? (
    [safeText(claims.given_name, 100), safeText(claims.family_name, 100)]
      .filter(Boolean).join(' ') || null
  );
  if (!subject || !email || claims.email_verified !== true) throw forbidden();

  const token = newPartnerToken();
  const partnerId = createId();
  const sessionId = createId();
  const expiresAt = new Date(
    Date.now() + context.config.partner_session_absolute_days * 86400000,
  );
  const partner = await transaction(context.pool, async (tx) => {
    const account = (await tx.query(
      `INSERT INTO agency_partners(id,issuer,subject,email,email_verified,display_name,status,created_at,updated_at)
       VALUES($1,$2,$3,$4,TRUE,$5,'active',NOW(),NOW())
       ON CONFLICT (issuer,subject) DO UPDATE SET email=EXCLUDED.email,email_verified=TRUE,
         display_name=EXCLUDED.display_name,updated_at=NOW()
       WHERE agency_partners.status='active'
       RETURNING id,issuer,subject,email,display_name`,
      [partnerId, issuer, subject, email, displayName],
    )).rows[0];
    if (!account) throw forbidden();
    await tx.query(
      `INSERT INTO agency_partner_sessions(id,partner_id,token_hash,provider_sid,expires_at,last_used_at,ip_address,user_agent,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,NOW(),$6,$7,NOW(),NOW())`,
      [
        sessionId,
        account.id,
        hashPartnerToken(token),
        safeText(claims.sid, 255),
        expiresAt,
        request.raw.socket.remoteAddress ?? null,
        request.headers['user-agent'] ?? null,
      ],
    );
    return account;
  });
  return { partner, token, expiresAt };
}

export function registerPartnerAuthRoutes(
  app: FastifyInstance,
  context: TenantContext,
) {
  app.get<{ Querystring: { provider?: string; returnTo?: string; intent?: string } }>(
    '/api/partner/auth/start',
    async (request, reply) => {
      const oidc = await oidcClient(context);
      const provider = request.query.provider;
      const requestedReturnPath = request.query.returnTo;
      if (provider && provider !== 'google') throw bad('unsupported sign-in provider');
      const intent = request.query.intent;
      if (intent !== undefined && intent !== 'register') throw bad('unsupported sign-in intent');
      const returnPath = typeof requestedReturnPath === 'string' &&
        /^\/portal\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(requestedReturnPath)
        ? requestedReturnPath
        : '/app/businesses';
      const state = newPartnerToken();
      const nonce = newPartnerToken();
      const codeVerifier = newPartnerToken();
      const browserToken = newPartnerToken();
      const challenge = createHash('sha256').update(codeVerifier).digest('base64url');
      await context.pool.query('DELETE FROM agency_partner_auth_flows WHERE expires_at<=NOW()');
      await context.pool.query(
        `INSERT INTO agency_partner_auth_flows(state_hash,browser_token_hash,nonce,code_verifier,redirect_uri,return_path,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,NOW()+INTERVAL '10 minutes')`,
        [
          hashPartnerToken(state),
          hashPartnerToken(browserToken),
          nonce,
          codeVerifier,
          context.config.partner_oidc_redirect_uri,
          returnPath,
        ],
      );
      const authorize = new URL(oidc.metadata.authorization_endpoint);
      authorize.searchParams.set('client_id', context.config.partner_oidc_client_id);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('scope', 'openid profile email');
      authorize.searchParams.set('redirect_uri', context.config.partner_oidc_redirect_uri);
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('nonce', nonce);
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      if (intent === 'register' && !provider) authorize.searchParams.set('prompt', 'create');
      if (provider === 'google') authorize.searchParams.set('kc_idp_hint', 'google');
      const cookie = flowCookie(context, browserToken);
      reply.setCookie(FLOW_COOKIE, cookie.value, cookie);
      return reply.redirect(authorize.toString(), 302);
    },
  );

  app.get<{
    Querystring: { state?: string; code?: string; error?: string };
  }>('/api/partner/auth/callback', async (request, reply) => {
    const { state, code, error } = request.query;
    const browserToken = request.cookies[FLOW_COOKIE]?.trim();
    if (!state || !browserToken) throw unauthorized();
    const flow = (await context.pool.query(
      `DELETE FROM agency_partner_auth_flows
       WHERE state_hash=$1 AND browser_token_hash=$2 AND expires_at>NOW()
       RETURNING nonce,code_verifier,redirect_uri,return_path`,
      [hashPartnerToken(state), hashPartnerToken(browserToken)],
    )).rows[0];
    const expiredCookie = flowCookie(context, '', true);
    reply.setCookie(FLOW_COOKIE, expiredCookie.value, expiredCookie);
    if (!flow) throw unauthorized();
    if (error || !code) return reply.redirect(partnerHome(context, '/login?audience=partner&error=signin_cancelled'));

    const oidc = await oidcClient(context);
    const tokenResponse = await fetch(oidc.metadata.token_endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(
          `${context.config.partner_oidc_client_id}:${context.config.partner_oidc_client_secret}`,
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: flow.redirect_uri,
        code_verifier: flow.code_verifier,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const tokenBody = await tokenResponse.json().catch(() => null) as
      | { id_token?: unknown }
      | null;
    if (!tokenResponse.ok || typeof tokenBody?.id_token !== 'string')
      throw unauthorized();
    const verified = await jwtVerify(tokenBody.id_token, oidc.jwks, {
      issuer: oidc.metadata.issuer,
      audience: context.config.partner_oidc_client_id,
      algorithms: ['RS256', 'PS256', 'ES256'],
      clockTolerance: 5,
    });
    if (verified.payload.nonce !== flow.nonce) throw unauthorized();
    const { partner, token, expiresAt } = await createPartnerSession(request, context, verified.payload);
    clearSessionCookie(reply, context.config);
    clearClientSessionCookie(reply, context);
    setPartnerSessionCookie(reply, context, token, expiresAt);
    const businessCount = Number((await context.pool.query(
      'SELECT COUNT(*) AS count FROM agency_partner_memberships WHERE partner_id=$1',
      [partner.id],
    )).rows[0]?.count ?? 0);
    let destination = businessCount ? '/app/businesses' : '/onboarding';
    const requestedPortal = /^\/portal\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/.exec(flow.return_path);
    if (requestedPortal && businessCount) {
      const owned = (await context.pool.query(
        `SELECT 1 FROM agency_partner_memberships m JOIN workspaces w ON w.id=m.workspace_id
         WHERE m.partner_id=$1 AND w.slug=$2 AND w.status='active' LIMIT 1`,
        [partner.id, requestedPortal[1]],
      )).rows[0];
      if (owned) destination = flow.return_path;
    }
    return reply.redirect(partnerHome(context, destination));
  });

  app.get('/api/partner/auth/me', async (request) => {
    const partner = await requireAgencyPartner(request, context);
    return {
      partner: { id: partner.id, email: partner.email, display_name: partner.display_name },
      accountUrl: `${context.config.partner_oidc_issuer_url}/account/`,
    };
  });

  app.post('/api/partner/auth/activity', async (request, reply) => {
    requirePartnerSameOrigin(request, context);
    await recordPartnerActivity(request, context);
    return reply.code(204).send();
  });

  app.post('/api/partner/auth/logout', async (request, reply) => {
    requirePartnerSameOrigin(request, context);
    const token = request.cookies[context.config.partner_session_cookie_name]?.trim();
    if (token) await context.pool.query(
      'UPDATE agency_partner_sessions SET revoked_at=NOW(),updated_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL',
      [hashPartnerToken(token)],
    );
    clearPartnerSessionCookie(reply, context);
    const oidc = oidcEnabled(context) ? await oidcClient(context) : null;
    return { logoutUrl: oidc ? logoutUrl(oidc, context) : partnerHome(context, '/login') };
  });

  app.post('/api/partner/auth/logout-all', async (request, reply) => {
    requirePartnerSameOrigin(request, context);
    const partner = await requireAgencyPartner(request, context);
    await revokeProviderSessions(context, partner);
    await context.pool.query(
      'UPDATE agency_partner_sessions SET revoked_at=NOW(),updated_at=NOW() WHERE partner_id=$1 AND revoked_at IS NULL',
      [partner.id],
    );
    clearPartnerSessionCookie(reply, context);
    return { logoutUrl: partnerHome(context, '/login?audience=partner') };
  });

  app.post<{ Body: { logout_token?: string } }>(
    '/api/partner/auth/backchannel-logout',
    async (request, reply) => {
      const body = request.body as { logout_token?: unknown } | undefined;
      const token = typeof body?.logout_token === 'string' ? body.logout_token : null;
      if (!token) throw bad('logout_token is required');
      const oidc = await oidcClient(context);
      const verified = await jwtVerify(token, oidc.jwks, {
        issuer: oidc.metadata.issuer,
        audience: context.config.partner_oidc_client_id,
        algorithms: ['RS256', 'PS256', 'ES256'],
        clockTolerance: 5,
      });
      const payload = verified.payload;
      const events = payload.events;
      if (
        !payload.jti || payload.nonce !== undefined || !events ||
        typeof events !== 'object' || !Object.hasOwn(events, LOGOUT_EVENT) ||
        (!payload.sid && !payload.sub)
      ) throw unauthorized();
      if (payload.sid) {
        await context.pool.query(
          'UPDATE agency_partner_sessions SET revoked_at=NOW(),updated_at=NOW() WHERE provider_sid=$1 AND revoked_at IS NULL',
          [payload.sid],
        );
      } else {
        await context.pool.query(
          `UPDATE agency_partner_sessions s SET revoked_at=NOW(),updated_at=NOW()
           FROM agency_partners p WHERE p.id=s.partner_id AND p.issuer=$1 AND p.subject=$2 AND s.revoked_at IS NULL`,
          [oidc.metadata.issuer, payload.sub],
        );
      }
      return reply.code(204).send();
    },
  );
}
