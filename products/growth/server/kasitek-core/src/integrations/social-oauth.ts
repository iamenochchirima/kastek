import { generateToken, sha256Base64Url } from '@kasitek-labs/server-support/crypto';
import { createId } from '@paralleldrive/cuid2';
import type { CoreConfig } from '../config.js';
import { ApiError } from '../error.js';
import { requiredScopes } from './provider-permissions.js';
import { metaScopesForRequest, instagramScopesForRequest } from './connection-permissions.js';
export function socialAppUrl(config: CoreConfig): string { return config.publicApiUrl.replace(/\/+$/, ''); }
export function requiredEnv(config: CoreConfig, name: string): string { const value = config.rawEnv[name]; if (value === undefined)
    throw new ApiError(500, 'internal_error', `${name} is required`); return value; }
export function instagramAppId(config: CoreConfig): string { try {
    return requiredEnv(config, 'AUTH_INSTAGRAM_APP_ID');
}
catch {
    throw new ApiError(500, 'internal_error', 'AUTH_INSTAGRAM_APP_ID is required for direct Instagram Login; use the Instagram App ID from the Instagram API setup, not the Meta App ID');
} }
export function instagramAppSecret(config: CoreConfig): string { try {
    return requiredEnv(config, 'AUTH_INSTAGRAM_APP_SECRET');
}
catch {
    throw new ApiError(500, 'internal_error', 'AUTH_INSTAGRAM_APP_SECRET is required for direct Instagram Login');
} }
const encode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, v => `%${v.charCodeAt(0).toString(16).toUpperCase()}`);
export function buildUrl(base: string, params: [
    string,
    string
][]): string { return base + '?' + params.map(([k, v]) => `${encode(k)}=${encode(v)}`).join('&'); }
export function createXOAuthState() { const verifier = generateToken(48); return { state: generateToken(24), verifier, challenge: sha256Base64Url(verifier) }; }
export const createLinkedinOAuthState = () => createId().replaceAll('-', '');
export const createMetaOAuthState = createLinkedinOAuthState, createInstagramOAuthState = createLinkedinOAuthState, createThreadsOAuthState = createLinkedinOAuthState, createTiktokOAuthState = createLinkedinOAuthState;
export function linkedinOrganizationScopesConfigured(config: CoreConfig): boolean { return (config.rawEnv.AUTH_LINKEDIN_SCOPES ?? '').split(/\s+/).some(v => ['r_organization_admin', 'w_organization_social'].includes(v)); }
export function threadsScopesForRequest(config: CoreConfig, requested: string[]): string[] { if (!requested.length)
    return (config.rawEnv.AUTH_THREADS_SCOPES ?? 'threads_basic,threads_content_publish').split(/[, ]/).map(v => v.trim()).filter(Boolean); const scopes = requiredScopes('Threads', requested); if (!scopes.includes('threads_basic'))
    scopes.unshift('threads_basic'); return scopes; }
export function tiktokScopesForRequest(requested: string[]): string[] { if (!requested.length)
    return ['user.info.basic']; const scopes = requiredScopes('TikTok', requested); if (!scopes.includes('user.info.basic'))
    scopes.unshift('user.info.basic'); return scopes; }
export function buildXAuthorizeUrl(config: CoreConfig, state: string, challenge: string, requested: string[] = []): string { const scopes = requested.length ? requiredScopes('X', requested) : null; if (scopes)
    for (const baseline of ['tweet.read', 'users.read', 'offline.access'])
        if (!scopes.includes(baseline))
            scopes.push(baseline); return buildUrl('https://twitter.com/i/oauth2/authorize', [['response_type', 'code'], ['client_id', requiredEnv(config, 'AUTH_X_CLIENT_ID')], ['redirect_uri', `${socialAppUrl(config)}/api/social/oauth/x/callback`], ['scope', scopes?.join(' ') ?? config.rawEnv.AUTH_X_SCOPES ?? 'tweet.read tweet.write users.read offline.access'], ['state', state], ['code_challenge', challenge], ['code_challenge_method', 'S256']]); }
export function buildThreadsAuthorizeUrl(config: CoreConfig, state: string, requested: string[] = []): string { return buildUrl('https://www.threads.com/oauth/authorize', [['client_id', requiredEnv(config, 'AUTH_THREADS_APP_ID')], ['redirect_uri', `${socialAppUrl(config)}/api/social/oauth/threads/callback`], ['scope', threadsScopesForRequest(config, requested).join(',')], ['response_type', 'code'], ['state', state]]); }
export function buildTiktokAuthorizeUrl(config: CoreConfig, state: string, requested: string[] = []): string { return buildUrl('https://www.tiktok.com/v2/auth/authorize/', [['client_key', requiredEnv(config, 'AUTH_TIKTOK_CLIENT_KEY')], ['redirect_uri', `${socialAppUrl(config)}/api/social/oauth/tiktok/callback`], ['scope', tiktokScopesForRequest(requested).join(',')], ['response_type', 'code'], ['state', state]]); }
export function buildLinkedinAuthorizeUrl(config: CoreConfig, state: string, requested: string[] = [], organization = false): string { let scopes: string[]; if (!requested.length) {
    scopes = (config.rawEnv.AUTH_LINKEDIN_SCOPES ?? '').split(/\s+/).filter(Boolean);
    for (const baseline of ['openid', 'profile', 'email', 'w_member_social'])
        if (!scopes.includes(baseline))
            scopes.push(baseline);
}
else {
    scopes = requiredScopes(organization ? 'LinkedInOrganization' : 'LinkedInMember', requested);
    for (const baseline of ['openid', 'profile', 'email'])
        if (!scopes.includes(baseline))
            scopes.unshift(baseline);
} return buildUrl('https://www.linkedin.com/oauth/v2/authorization', [['response_type', 'code'], ['client_id', requiredEnv(config, 'AUTH_LINKEDIN_CLIENT_ID')], ['redirect_uri', `${socialAppUrl(config)}/api/social/oauth/linkedin/callback`], ['state', state], ['scope', scopes.join(' ')]]); }
export function buildMetaAuthorizeUrl(config: CoreConfig, state: string, target = 'facebook', requested: string[] = []): string { return buildUrl('https://www.facebook.com/v23.0/dialog/oauth', [['client_id', requiredEnv(config, 'AUTH_META_APP_ID')], ['redirect_uri', `${socialAppUrl(config)}/api/social/oauth/meta/callback`], ['state', state], ['response_type', 'code'], ['scope', !requested.length ? config.rawEnv.AUTH_META_SCOPES ?? metaScopesForRequest(target, []).join(',') : metaScopesForRequest(target, requested).join(',')]]); }
export function buildInstagramAuthorizeUrl(config: CoreConfig, state: string, requested: string[] = []): string { return buildUrl('https://www.instagram.com/oauth/authorize', [['force_reauth', 'true'], ['client_id', instagramAppId(config)], ['redirect_uri', `${socialAppUrl(config)}/api/social/oauth/instagram/callback`], ['response_type', 'code'], ['scope', !requested.length ? config.rawEnv.AUTH_INSTAGRAM_SCOPES ?? instagramScopesForRequest([]).join(',') : instagramScopesForRequest(requested).join(',')], ['state', state]]); }
