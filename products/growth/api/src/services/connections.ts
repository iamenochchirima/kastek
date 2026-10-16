import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../error.js';
import * as sql from '../integrations/connection-sql.js';
import * as permissions from '../integrations/connection-permissions.js';
import * as analytics from '../integrations/connection-analytics.js';
import type { Metadata } from '../integrations/provider-permissions.js';
type State = analytics.ConnectionState;
type CapabilityState = {
    connection_id: string;
    provider: string;
    capability: string;
    enabled: boolean;
    updated_at: Date;
};
export interface ExternalConnection {
    id: string;
    provider: string;
    externalAccountId: string | null;
    displayName: string;
    handle: string | null;
    status: string;
    credentialStatus: string;
    healthStatus: string;
    webhookStatus: string;
    lastCheckedAt: Date | null;
    lastError: string | null;
    metadata: Metadata;
    capabilities: unknown[];
    permissions: permissions.PermissionDefinition[];
    consumers: unknown[];
    createdAt: Date;
    updatedAt: Date;
}
const notFound = (): never => { throw new ApiError(404, 'not_found', 'Connection not found'); };
async function transaction<T>(pool: Pool, work: (tx: PoolClient) => Promise<T>): Promise<T> { const tx = await pool.connect(); try {
    await tx.query('BEGIN');
    const value = await work(tx);
    await tx.query('COMMIT');
    return value;
}
catch (error) {
    await tx.query('ROLLBACK');
    throw error;
}
finally {
    tx.release();
} }
export function isMutableStatus(status: string): boolean { return ['CONNECTED', 'DISCONNECTED', 'REVOKED'].includes(status); }
async function states(tx: PoolClient, orgId: string) { return (await tx.query<State>(sql.LOAD_CONNECTION_STATES_0, [orgId])).rows; }
async function state(tx: PoolClient, orgId: string, id: string) { return (await tx.query<State>(sql.LOAD_CONNECTION_STATE_0, [orgId, id])).rows[0] ?? null; }
async function capabilityStates(tx: PoolClient, orgId: string) { return (await tx.query<CapabilityState>(sql.LOAD_CAPABILITY_STATES_0, [orgId])).rows; }
export async function syncOrgConnections(pool: Pool, orgId: string): Promise<void> { await transaction(pool, async (tx) => { const before = new Map((await states(tx, orgId)).map(v => [v.id, v])), beforeCaps = new Map((await capabilityStates(tx, orgId)).map(v => [v.connection_id + '\0' + v.capability, v])); for (const query of [sql.SYNC_WHATSAPP_0, sql.SYNC_SOCIAL_0, sql.SYNC_EMAIL_0, sql.MARK_MISSING_SOURCES_0, sql.SYNC_CAPABILITIES_0, sql.SYNC_CAPABILITIES_1])
    await tx.query(query, [orgId]); for (const next of await capabilityStates(tx, orgId)) {
    const old = beforeCaps.get(next.connection_id + '\0' + next.capability);
    if (!old || old.enabled !== next.enabled || old.provider !== next.provider)
        await analytics.capabilityLifecycle(tx, orgId, next.connection_id, next.provider, next.capability, next.enabled, next.updated_at);
} await tx.query(sql.SYNC_CONSUMERS_0, [orgId]); await tx.query(sql.SYNC_CONSUMERS_1, [orgId]); const after = await states(tx, orgId); for (const next of after) {
    const old = before.get(next.id);
    if (!old) {
        await analytics.lifecycle(tx, orgId, next, 'created');
        continue;
    }
    if (old.status !== next.status)
        await analytics.lifecycle(tx, orgId, next, analytics.lifecycleAction(next.status));
    if (old.health_status !== next.health_status || old.credential_status !== next.credential_status || old.webhook_status !== next.webhook_status || old.last_checked_at?.toISOString() !== next.last_checked_at?.toISOString())
        await analytics.health(tx, orgId, next, next.health_status === 'HEALTHY');
} await analytics.manifest(tx, orgId, after.length); }); }
function camelRow(row: Record<string, unknown>): ExternalConnection { return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), value])) as unknown as ExternalConnection; }
export function sanitizeConnectionMetadata(metadata: Metadata): Metadata { if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    return metadata; const safe = { ...metadata }; for (const key of ['permissions', 'scope', 'scopes', 'tasks', 'permissionsInspected', 'capabilityChecks', 'tokenType', 'dpopPrivateKey', 'dpopAuthorizationNonce'])
    delete safe[key]; return safe; }
export async function listConnections(pool: Pool, orgId: string): Promise<ExternalConnection[]> { await syncOrgConnections(pool, orgId); await permissions.syncPermissionInventory(pool, orgId); return (await pool.query(sql.LIST_CONNECTIONS_0, [orgId])).rows.map(row => { const connection = camelRow(row); connection.permissions = permissions.permissionSnapshots(connection.provider, connection.metadata).map(v => v.definition); connection.metadata = sanitizeConnectionMetadata(connection.metadata); return connection; }); }
export async function updateStatus(pool: Pool, orgId: string, id: string, status: string): Promise<ExternalConnection> { if (!isMutableStatus(status))
    throw new ApiError(400, 'bad_request', 'Status must be CONNECTED, DISCONNECTED, or REVOKED'); await transaction(pool, async (tx) => { const previous = (await tx.query<{
    status: string;
}>(sql.UPDATE_STATUS_0, [id, orgId])).rows[0]; if (!previous)
    notFound(); const source = (await tx.query<{
    sourceType: string;
    sourceId: string;
}>(sql.UPDATE_STATUS_1, [status === 'CONNECTED' ? null : status, status, id, orgId])).rows[0]; if (!source)
    notFound(); if (source!.sourceType === 'SOCIAL')
    await tx.query(sql.UPDATE_STATUS_2, [status === 'REVOKED' ? 'NEEDS_REAUTH' : status, source!.sourceId, orgId]); if (source!.sourceType === 'EMAIL') {
    await tx.query(sql.UPDATE_STATUS_3, [status, source!.sourceId, orgId]);
    await tx.query(sql.UPDATE_STATUS_4, [status, source!.sourceId, orgId]);
} if (previous!.status !== status) {
    const next = await state(tx, orgId, id);
    if (!next)
        notFound();
    await analytics.lifecycle(tx, orgId, next!, analytics.lifecycleAction(status));
} }); return (await listConnections(pool, orgId)).find(v => v.id === id) ?? notFound(); }
export async function updateStatusByIdentity(pool: Pool, orgId: string, provider: string, displayName: string, handle: string | null, status: string) { const rows = (await pool.query<{
    id: string;
}>(sql.UPDATE_STATUS_BY_IDENTITY_0, [orgId, provider.trim(), displayName.trim(), handle?.trim() || null])).rows; if (!rows.length)
    notFound(); if (rows.length > 1)
    throw new ApiError(400, 'bad_request', 'Multiple connections match; specify the account handle'); return updateStatus(pool, orgId, rows[0]!.id, status); }
export async function sourceIsConnected(pool: Pool, orgId: string, sourceType: string, sourceId: string): Promise<boolean> { return (await pool.query<{
    exists: boolean;
}>(sql.SOURCE_IS_CONNECTED_0, [orgId, sourceType, sourceId])).rows[0]!.exists; }
export async function recordSourceHealth(pool: Pool, orgId: string, sourceType: string, sourceId: string, healthy: boolean, webhookStatus: string | null, error: string | null): Promise<void> { await syncOrgConnections(pool, orgId); await recordSyncedSourceHealth(pool, orgId, sourceType, sourceId, healthy, webhookStatus, error); }
export function providerSyncFailureClass(error: ApiError): string { return ({ unauthorized: 'authentication', unsupported_principal: 'authorization', forbidden: 'authorization', rate_limited: 'rate_limited', service_unavailable: 'provider_unavailable', bad_gateway: 'provider_unavailable', gateway_timeout: 'provider_unavailable', bad_request: 'provider_rejected', not_found: 'not_found', internal_error: 'internal' } as Record<string, string>)[error.code] ?? 'unknown'; }
export async function recordProviderSyncOutcome(pool: Pool, orgId: string, sourceId: string, provider: string, operation: string, attemptId: string, outcome: string, failureClass: string, durationMs: number): Promise<void> { await transaction(pool, async (tx) => { const id = `ext_${sourceId}`, time = new Date(); await analytics.syncAttempt(tx, orgId, id, provider, attemptId, operation, outcome, failureClass, Math.min(86400000, Math.max(0, durationMs)), time); if (failureClass === 'rate_limited')
    await analytics.rateLimit(tx, orgId, id, provider, operation, time); }); }
export function healthIncidentTransition(previous: string | null, healthy: boolean): [
    string,
    string
] | null { return previous === 'NEEDS_ATTENTION' && healthy ? ['resolved', 'provider_health_recovered'] : previous !== 'NEEDS_ATTENTION' && !healthy ? ['opened', 'provider_health_failed'] : null; }
export async function recordSyncedSourceHealth(pool: Pool, orgId: string, sourceType: string, sourceId: string, healthy: boolean, webhookStatus: string | null, error: string | null): Promise<void> { await transaction(pool, async (tx) => { const previous = (await tx.query<{
    healthStatus: string;
}>(sql.RECORD_SYNCED_SOURCE_HEALTH_0, [orgId, sourceType, sourceId])).rows[0]; const next = (await tx.query<State>(sql.RECORD_SYNCED_SOURCE_HEALTH_1, [healthy ? 'HEALTHY' : 'NEEDS_ATTENTION', webhookStatus, error, healthy, orgId, sourceType, sourceId])).rows[0]; if (next) {
    const transition = healthIncidentTransition(previous?.healthStatus ?? null, healthy);
    if (transition)
        await analytics.incident(tx, orgId, next, ...transition);
    await analytics.health(tx, orgId, next, healthy);
} }); }
