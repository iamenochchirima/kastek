import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { generateToken } from '@kasitek-labs/server-support/crypto';
import { ApiError } from '../error.js';
import { PERMISSION_DEFINITIONS } from './permission-definitions.js';
import { adapterFor, authMode, providerName, capability, requiredScopes, type Metadata, type ProviderAdapter } from './provider-permissions.js';
export interface PermissionDefinition {
    key: string;
    group: string;
    label: string;
    description: string;
    state: string;
    requestable: boolean;
    reasonCode: string | null;
    authMode: string | null;
    verificationSource: string | null;
}
export interface PermissionSnapshot {
    definition: PermissionDefinition;
    providerPermission: string | null;
}
export interface ConnectionAccessContext {
    id: string;
    sourceType: string;
    sourceId: string;
    provider: string;
    displayName: string;
    handle: string | null;
    metadata: Metadata;
}
export interface AuthorizationAttempt {
    id: string;
    connectionId: string;
    provider: string;
    authMode: string;
    target: string;
    state: string;
    requestedCapabilities: string[];
}
const allowed = new Set<string>(PERMISSION_DEFINITIONS.map(v => v.key));
const bad = (message: string): never => { throw new ApiError(400, 'bad_request', message); };
export function normalizeRequestedCapabilities(value?: string | null): string[] { return [...new Set((value ?? '').split(',').map(v => v.trim().toUpperCase()).filter(v => allowed.has(v)))]; }
export function parseRequestedCapabilities(value?: string | null): string[] { const supplied = (value ?? '').split(',').map(v => v.trim()).filter(Boolean); if (!supplied.length)
    bad('At least one access capability is required'); if (supplied.some(v => !allowed.has(v.toUpperCase())))
    bad('The access request contains an unsupported capability'); return normalizeRequestedCapabilities(value); }
function metadataValues(metadata: Metadata, key: string): string[] { const v = metadata?.[key]; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? v.split(/[, ]/).map(x => x.trim()).filter(Boolean) : []; }
function targetCheck(metadata: Metadata, adapter: ProviderAdapter, key: string): boolean | null { const checks = metadata?.capabilityChecks; const value = checks && typeof checks === 'object' ? (checks as Record<string, unknown>)[key] : null; if (typeof value === 'boolean')
    return value; if (value && typeof value === 'object' && typeof (value as Record<string, unknown>).ok === 'boolean')
    return (value as {
        ok: boolean;
    }).ok; if (adapter !== 'LinkedInOrganization' || typeof metadata?.role !== 'string')
    return null; const role = metadata.role.toUpperCase(); if (['SOCIAL_PUBLISH', 'MEDIA_PUBLISH', 'COMMENTS_MANAGE'].includes(key))
    return ['ADMINISTRATOR', 'CONTENT_ADMIN', 'CONTENT_ADMINISTRATOR', 'DIRECT_SPONSORED_CONTENT_POSTER'].includes(role); return key === 'SOCIAL_ANALYTICS' ? role === 'ADMINISTRATOR' : null; }
export function permissionSnapshots(provider: string, metadata: Metadata = null): PermissionSnapshot[] { provider = provider.toUpperCase(); const permissions = metadataValues(metadata, 'permissions'), scopes = metadataValues(metadata, 'scope'), tasks = metadataValues(metadata, 'tasks'); const inspected = metadata?.permissionsInspected === true; const mode = typeof metadata?.authMethod === 'string' ? metadata.authMethod : ['FACEBOOK', 'INSTAGRAM'].includes(provider) ? 'meta_login' : null; const adapter = adapterFor(provider, mode, metadata); const verificationSource = permissions.length ? 'oauth_permissions' : tasks.length ? 'provider_tasks' : scopes.length ? 'oauth_scope' : inspected ? 'oauth_permission_inspection' : null; return PERMISSION_DEFINITIONS.map(def => { const rule = capability(adapter, def.key), providerGrant = rule.grants.some(v => permissions.includes(v) || scopes.includes(v) || tasks.includes(v)), target = targetCheck(metadata, adapter, def.key), granted = rule.requiresTargetCheck ? providerGrant && target === true : providerGrant || target === true; const state = !rule.supported ? 'UNSUPPORTED' : granted ? 'GRANTED' : rule.requiresTargetCheck && target === null ? 'UNKNOWN' : metadata?.requiresAppReview === true ? 'REQUIRES_PROVIDER_APPROVAL' : !permissions.length && !scopes.length && !tasks.length && !inspected ? 'UNKNOWN' : rule.requestable ? 'REQUESTABLE' : 'NOT_GRANTED'; const reasonCode = !rule.supported ? adapter === 'InstagramDirect' ? 'direct_instagram_login_unsupported' : 'provider_capability_unsupported' : ['REQUESTABLE', 'NOT_GRANTED'].includes(state) ? 'missing_provider_permission' : state === 'UNKNOWN' ? 'provider_permission_unavailable' : state === 'REQUIRES_PROVIDER_APPROVAL' ? 'provider_approval_required' : null; return { definition: { ...def, state, requestable: rule.requestable && !granted && state !== 'REQUIRES_PROVIDER_APPROVAL', reasonCode, authMode: mode, verificationSource }, providerPermission: rule.providerPermission }; }); }
export function effectiveRequestedCapabilities(requested: string[], snapshots: PermissionSnapshot[]): string[] { return [...new Set([...requested, ...snapshots.filter(v => v.definition.state === 'GRANTED').map(v => v.definition.key)])]; }
export function isAuthorizationError(error: unknown): boolean { return error instanceof ApiError && (error.code === 'unauthorized' || error.code === 'forbidden' || error.code === 'bad_request' && ['permission', 'oauth', 'unauthor', 'forbidden', 'access token', 'scope'].some(v => error.message.toLowerCase().includes(v))); }
export function metaScopesForRequest(target: string, requested: string[]): string[] { const instagram = target.toLowerCase() === 'instagram'; return requested.length ? requiredScopes(instagram ? 'MetaInstagram' : 'MetaFacebook', requested) : instagram ? ['instagram_basic', 'instagram_content_publish', 'instagram_manage_messages', 'instagram_manage_comments', 'instagram_manage_insights'] : ['pages_show_list', 'pages_manage_metadata', 'business_management', 'pages_read_engagement', 'pages_manage_posts', 'pages_messaging', 'pages_manage_engagement', 'read_insights', 'instagram_basic']; }
export function instagramScopesForRequest(requested: string[]): string[] { return requested.length ? requiredScopes('InstagramDirect', requested) : ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_messages', 'instagram_business_manage_comments', 'instagram_business_manage_insights']; }
export async function syncPermissionInventory(pool: Pool, orgId: string): Promise<void> { const { rows } = await pool.query<{
    id: string;
    provider: string;
    metadata: Metadata;
}>('SELECT id,provider,metadata FROM "ExternalConnection" WHERE "orgId"=$1', [orgId]); const tx = await pool.connect(); try {
    await tx.query('BEGIN');
    for (const row of rows) {
        await tx.query('DELETE FROM "ExternalConnectionPermission" WHERE "connectionId"=$1', [row.id]);
        for (const snapshot of permissionSnapshots(row.provider, row.metadata)) {
            const d = snapshot.definition;
            await tx.query('INSERT INTO "ExternalConnectionPermission" (id,"connectionId",key,"providerPermission",state,requestable,"reasonCode","authMode","verificationSource","observedAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW(),NOW())', [createId(), row.id, d.key, snapshot.providerPermission, d.state, d.requestable, d.reasonCode, d.authMode, d.verificationSource]);
        }
    }
    await tx.query('COMMIT');
}
catch (error) {
    await tx.query('ROLLBACK');
    throw error;
}
finally {
    tx.release();
} }
export async function getConnectionAccessContext(pool: Pool, orgId: string, id: string): Promise<ConnectionAccessContext> { const { rows } = await pool.query<ConnectionAccessContext>('SELECT id,"sourceType","sourceId",provider,"displayName",handle,metadata FROM "ExternalConnection" WHERE id=$1 AND "orgId"=$2 LIMIT 1', [id, orgId]); if (!rows[0])
    throw new ApiError(404, 'not_found', 'Connection not found'); return rows[0]; }
export async function getAccessSnapshot(pool: Pool, orgId: string, id: string) { await syncPermissionInventory(pool, orgId); const row = await getConnectionAccessContext(pool, orgId, id); return { connectionId: row.id, provider: row.provider.toUpperCase(), displayName: row.displayName, handle: row.handle, authMode: typeof row.metadata?.authMethod === 'string' ? row.metadata.authMethod : authMode(adapterFor(row.provider, null, row.metadata)), permissions: permissionSnapshots(row.provider, row.metadata).map(v => v.definition) }; }
export async function planAccessRequest(pool: Pool, orgId: string, id: string, requested: string[]) { if (!requested.length)
    bad('At least one access capability is required'); const context = await getConnectionAccessContext(pool, orgId, id); if (!['SOCIAL', 'WHATSAPP'].includes(context.sourceType))
    bad('Access requests are not available for this connection type'); const adapter = adapterFor(context.provider, typeof context.metadata?.authMethod === 'string' ? context.metadata.authMethod : null, context.metadata); if (providerName(adapter) === 'UNKNOWN')
    bad('Access requests are not available for this provider yet'); const snapshots = permissionSnapshots(context.provider, context.metadata); for (const key of requested) {
    const snapshot = snapshots.find(v => v.definition.key === key);
    if (!snapshot)
        bad('The access request contains an unsupported capability');
    if (!snapshot!.definition.requestable)
        bad(`Access capability ${key} cannot be requested (${snapshot!.definition.reasonCode ?? 'unsupported_access_request'})`);
} return { context, adapter, effectiveCapabilities: effectiveRequestedCapabilities(requested, snapshots) }; }
export function authorizationRequirement(provider: string, metadata: Metadata, key: string) { const d = permissionSnapshots(provider, metadata).find(v => v.definition.key === key)?.definition; if (!d || d.state === 'GRANTED')
    return null; return { code: 'authorization_required', provider: provider.toUpperCase(), requiredCapabilities: [key], requestable: d.requestable, authMode: d.authMode, reasonCode: d.reasonCode ?? 'missing_provider_permission', remediation: 'connections_access' }; }
export async function createAuthorizationAttempt(pool: Pool, orgId: string, userId: string, connectionId: string, provider: string, mode: string, target: string, requestedCapabilities: string[], state = generateToken(32)): Promise<AuthorizationAttempt> { const id = createId(); await pool.query('INSERT INTO "ExternalConnectionAuthorizationAttempt" (id,"connectionId","orgId","userId",provider,"authMode",target,state,"requestedCapabilities",status,"expiresAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,\'STARTED\',$10,NOW(),NOW())', [id, connectionId, orgId, userId, provider, mode, target, state, requestedCapabilities, new Date(Date.now() + 600000)]); return { id, connectionId, provider, authMode: mode, target, state, requestedCapabilities }; }
export async function findAuthorizationAttempt(pool: Pool, orgId: string, userId: string, state: string): Promise<AuthorizationAttempt | null> { return (await pool.query<AuthorizationAttempt>('SELECT id,"connectionId",provider,"authMode",target,state,"requestedCapabilities" FROM "ExternalConnectionAuthorizationAttempt" WHERE state=$1 AND "orgId"=$2 AND "userId"=$3 AND status=\'STARTED\' AND "expiresAt">NOW()', [state, orgId, userId])).rows[0] ?? null; }
export async function finishAuthorizationAttempt(pool: Pool, id: string, status: string, failureCode: string | null): Promise<void> { await pool.query('UPDATE "ExternalConnectionAuthorizationAttempt" SET status=$1,"failureCode"=$2,"completedAt"=NOW(),"updatedAt"=NOW() WHERE id=$3', [status, failureCode, id]); }
