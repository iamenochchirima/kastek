import * as oidc from 'openid-client';
import { ApiError } from '../error.js';
import type { CoreContext } from '../context.js';

export function setting(context: CoreContext, name: string): string {
  const value = context.config.env[name];
  if (!value) throw new ApiError(503, 'service_unavailable', `${name} is not configured`);
  return value;
}
export function unauthorized(): ApiError {
  return new ApiError(401, 'unauthorized', 'Unauthorized');
}
export function unavailable(): ApiError {
  return new ApiError(503, 'service_unavailable', 'Shared identity verification unavailable');
}
export async function provider(context: CoreContext): Promise<oidc.Configuration> {
  try {
    const issuer = new URL(setting(context, 'OIDC_ISSUER_URL'));
    const local = issuer.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname);
    if (issuer.protocol !== 'https:' && !local) throw unavailable();
    const config = await oidc.discovery(issuer, setting(context, 'OIDC_CLIENT_ID'), setting(context, 'OIDC_CLIENT_SECRET'), undefined,
      { timeout: 10, ...(local ? { execute: [oidc.allowInsecureRequests] } : {}) });
    oidc.enableNonRepudiationChecks(config);
    return config;
  } catch { throw unavailable(); }
}
export async function providerRequest(context: CoreContext, endpoint: string, fields: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${setting(context, 'OIDC_ISSUER_URL').replace(/\/$/, '')}/protocol/openid-connect/${endpoint}`, {
      method: 'POST', body: new URLSearchParams(fields), redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw unavailable(); }
  if (response.status >= 500) throw unavailable();
  let body: unknown;
  try { body = await response.json(); } catch { throw unavailable(); }
  if (!response.ok) throw unauthorized();
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw unavailable();
  return body as Record<string, unknown>;
}
