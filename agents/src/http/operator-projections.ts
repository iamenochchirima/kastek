import type { Pool } from "pg";
import { query } from "../db/pool";

export const OPERATOR_PROJECTION_KEYS = [
  "summary",
  "run_health",
  "health",
  "usage_cost",
  "delivery_health",
  "provider_workers",
  "alerts",
  "projection_lag",
] as const;

export type OperatorProjectionKey = typeof OPERATOR_PROJECTION_KEYS[number];

function isProjectionKey(value: string): value is OperatorProjectionKey {
  return (OPERATOR_PROJECTION_KEYS as readonly string[]).includes(value);
}

async function buildPayload(pool: Pool, key: OperatorProjectionKey): Promise<Record<string, unknown>> {
  if (key === "summary" || key === "run_health") {
    const [runs, installations, definitions, effects, events, conversations, channels, approvals] = await Promise.all([
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_runs GROUP BY status ORDER BY status"),
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_installations GROUP BY status ORDER BY status"),
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_definitions GROUP BY status ORDER BY status"),
      query<{ status: string; count: string; reconciliation_required: boolean }>(pool, "SELECT status, COUNT(*)::text AS count, reconciliation_required FROM agent_effect_receipts GROUP BY status, reconciliation_required ORDER BY status"),
      query<{ event_type: string; count: string }>(pool, "SELECT event_type, COUNT(*)::text AS count FROM agent_events GROUP BY event_type ORDER BY event_type"),
      query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM conversations WHERE status <> 'deleted'"),
      query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM channel_connections WHERE status <> 'revoked'"),
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_approval_records GROUP BY status ORDER BY status"),
    ]);
    const payload = {
      generatedAt: new Date().toISOString(),
      runs: Object.fromEntries(runs.rows.map((row) => [row.status, Number(row.count)])),
      installations: Object.fromEntries(installations.rows.map((row) => [row.status, Number(row.count)])),
      definitions: Object.fromEntries(definitions.rows.map((row) => [row.status, Number(row.count)])),
      effects: effects.rows.map((row) => ({ status: row.status, count: Number(row.count), reconciliationRequired: row.reconciliation_required })),
      conversations: Number(conversations.rows[0]?.count ?? 0),
      channels: Number(channels.rows[0]?.count ?? 0),
      approvals: Object.fromEntries(approvals.rows.map((row) => [row.status, Number(row.count)])),
    };
    return key === "summary" ? payload : { generatedAt: payload.generatedAt, runs: payload.runs, eventTypes: Object.fromEntries(events.rows.map((row) => [row.event_type, Number(row.count)])) };
  }

  if (key === "health") {
    const startedAt = Date.now();
    await query(pool, "SELECT 1");
    return { generatedAt: new Date().toISOString(), database: { status: "ready", latencyMs: Date.now() - startedAt }, agentApi: { status: "ready" } };
  }

  if (key === "usage_cost") {
    const result = await query<{ calls: string; total: string; tokens: string }>(pool, "SELECT COUNT(*)::text AS calls, COALESCE(SUM(estimated_cost_usd), 0)::text AS total, COALESCE(SUM(total_tokens), 0)::text AS tokens FROM model_calls");
    return { generatedAt: new Date().toISOString(), modelCalls: Number(result.rows[0]?.calls ?? 0), estimatedCostUsd: result.rows[0]?.total ?? "0", totalTokens: Number(result.rows[0]?.tokens ?? 0) };
  }

  if (key === "delivery_health") {
    const result = await query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM delivery_attempts GROUP BY status ORDER BY status");
    return { generatedAt: new Date().toISOString(), deliveries: Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)])) };
  }

  if (key === "provider_workers") {
    const [effects, providers] = await Promise.all([
      query<{ executing: string; unknown: string }>(pool, "SELECT COUNT(*) FILTER (WHERE status = 'executing')::text AS executing, COUNT(*) FILTER (WHERE status = 'unknown')::text AS unknown FROM agent_effect_receipts"),
      query<{ provider: string; status: string; count: string }>(pool, "SELECT provider, status, COUNT(*)::text AS count FROM model_calls GROUP BY provider, status ORDER BY provider, status"),
    ]);
    const providerStates = Object.fromEntries(
      providers.rows.reduce<Map<string, Record<string, number>>>((groups, row) => {
        const state = groups.get(row.provider) ?? {};
        state[row.status] = Number(row.count);
        groups.set(row.provider, state);
        return groups;
      }, new Map()),
    );
    return {
      generatedAt: new Date().toISOString(),
      worker: { status: "agent-managed" },
      providers: providerStates,
      effects: { executing: Number(effects.rows[0]?.executing ?? 0), unknown: Number(effects.rows[0]?.unknown ?? 0) },
    };
  }

  if (key === "projection_lag") {
    const result = await query<{ projection_key: string; updated_at: string }>(pool, "SELECT projection_key, updated_at FROM agent_operator_projections ORDER BY projection_key");
    const now = Date.now();
    return { generatedAt: new Date().toISOString(), projections: result.rows.map((row) => ({ projectionKey: row.projection_key, updatedAt: row.updated_at, ageSeconds: Math.max(0, Math.round((now - new Date(row.updated_at).getTime()) / 1000)) })) };
  }

  const [reconciliation, failedRuns, queuedRuns, auditFailures, failedDeliveries, failedModelCalls, providerFailures, credentialRevocations, dataAccessEvents] = await Promise.all([
    query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM agent_effect_receipts WHERE reconciliation_required = true"),
    query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM agent_runs WHERE status = 'failed' AND updated_at > now() - interval '24 hours'"),
    query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM agent_runs WHERE status = 'queued' AND created_at < now() - interval '15 minutes'"),
    query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM audit_records WHERE action LIKE '%failed%' AND created_at > now() - interval '24 hours'"),
    query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM delivery_attempts WHERE status IN ('failed', 'unknown') AND created_at > now() - interval '24 hours'"),
    query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM model_calls WHERE status = 'failed' AND created_at > now() - interval '24 hours'"),
    query<{ provider: string; count: string }>(pool, "SELECT provider, COUNT(*)::text AS count FROM model_calls WHERE status = 'failed' AND created_at > now() - interval '24 hours' GROUP BY provider ORDER BY provider"),
    query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM audit_records WHERE action LIKE 'agent_installation_credential.%' AND action IN ('agent_installation_credential.revoked', 'agent_installation_credential.rotated') AND created_at > now() - interval '24 hours'"),
    query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM audit_records WHERE (action ILIKE '%support%' OR action ILIKE '%data_access%' OR resource_type = 'customer_content') AND created_at > now() - interval '24 hours'"),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    reconciliationRequired: Number(reconciliation.rows[0]?.count ?? 0),
    failedRunsLast24h: Number(failedRuns.rows[0]?.count ?? 0),
    queuedRunsOver15m: Number(queuedRuns.rows[0]?.count ?? 0),
    failedAuditEventsLast24h: Number(auditFailures.rows[0]?.count ?? 0),
    failedDeliveriesLast24h: Number(failedDeliveries.rows[0]?.count ?? 0),
    failedModelCallsLast24h: Number(failedModelCalls.rows[0]?.count ?? 0),
    providerFailuresLast24h: Object.fromEntries(providerFailures.rows.map((row) => [row.provider, Number(row.count)])),
    credentialRevocationsLast24h: Number(credentialRevocations.rows[0]?.count ?? 0),
    dataAccessEventsLast24h: Number(dataAccessEvents.rows[0]?.count ?? 0),
  };
}

export async function rebuildOperatorProjections(pool: Pool, keys: string[] = [...OPERATOR_PROJECTION_KEYS]): Promise<Array<Record<string, unknown>>> {
  const uniqueKeys = [...new Set(keys)];
  if (!uniqueKeys.length || uniqueKeys.some((key) => !isProjectionKey(key))) throw Object.assign(new Error("Unknown operator projection key"), { statusCode: 400 });
  const projections: Array<Record<string, unknown>> = [];
  for (const rawKey of uniqueKeys) {
    const key = rawKey as OperatorProjectionKey;
    const payload = await buildPayload(pool, key);
    const result = await query<{ projection_key: string; revision: string; payload: Record<string, unknown>; generated_at: string; updated_at: string }>(pool, `INSERT INTO agent_operator_projections (projection_key, revision, payload, generated_at, updated_at) VALUES ($1, 1, $2::jsonb, now(), now()) ON CONFLICT (projection_key) DO UPDATE SET revision = agent_operator_projections.revision + 1, payload = EXCLUDED.payload, generated_at = EXCLUDED.generated_at, updated_at = now() RETURNING projection_key, revision::text, payload, generated_at, updated_at`, [key, JSON.stringify(payload)]);
    const row = result.rows[0]!;
    projections.push({ projectionKey: row.projection_key, revision: Number(row.revision), payload: row.payload, generatedAt: row.generated_at, updatedAt: row.updated_at });
    if (key === "alerts") await emitAlertNotifications(pool, payload);
  }
  return projections;
}

export type OperatorNotificationSeed = { eventKey: string; severity: "warning" | "critical"; kind: string; title: string; body: string; metadata: Record<string, unknown> };

export function buildOperatorAlertNotificationSeeds(payload: Record<string, unknown>): OperatorNotificationSeed[] {
  const reconciliation = Number(payload.reconciliationRequired ?? 0);
  const failedRuns = Number(payload.failedRunsLast24h ?? 0);
  const queuedRuns = Number(payload.queuedRunsOver15m ?? 0);
  const failedDeliveries = Number(payload.failedDeliveriesLast24h ?? 0);
  const failedModelCalls = Number(payload.failedModelCallsLast24h ?? 0);
  const credentialRevocations = Number(payload.credentialRevocationsLast24h ?? 0);
  const dataAccessEvents = Number(payload.dataAccessEventsLast24h ?? 0);
  const providerFailures = payload.providerFailuresLast24h && typeof payload.providerFailuresLast24h === "object"
    ? Object.entries(payload.providerFailuresLast24h as Record<string, unknown>).filter(([, count]) => Number(count) > 0)
    : [];
  const notifications: OperatorNotificationSeed[] = [];
  if (reconciliation > 0) notifications.push({ eventKey: `reconciliation:${reconciliation}`, severity: "critical", kind: "duplicate_effect", title: "Effect reconciliation required", body: `${reconciliation} effect receipt(s) require operator reconciliation.`, metadata: { count: reconciliation } });
  if (failedRuns > 0) notifications.push({ eventKey: `failed-runs:24h:${failedRuns}`, severity: "warning", kind: "stuck_run", title: "Failed runs need review", body: `${failedRuns} run(s) failed in the last 24 hours.`, metadata: { count: failedRuns } });
  if (queuedRuns > 0) notifications.push({ eventKey: `queued-runs:15m:${queuedRuns}`, severity: "warning", kind: "queue_backlog", title: "Queued runs are aging", body: `${queuedRuns} run(s) have remained queued for more than 15 minutes.`, metadata: { count: queuedRuns } });
  if (failedDeliveries > 0) notifications.push({ eventKey: `delivery-failures:24h:${failedDeliveries}`, severity: "warning", kind: "webhook_storm", title: "Delivery failures need review", body: `${failedDeliveries} delivery attempt(s) failed or have unknown outcome in the last 24 hours.`, metadata: { count: failedDeliveries } });
  if (failedModelCalls > 0) notifications.push({ eventKey: `model-failures:24h:${failedModelCalls}`, severity: "critical", kind: "model_outage", title: "Model failures need review", body: `${failedModelCalls} model call(s) failed in the last 24 hours.`, metadata: { count: failedModelCalls } });
  for (const [provider, count] of providerFailures) notifications.push({ eventKey: `provider-failure:${provider}:24h:${count}`, severity: "critical", kind: "provider_outage", title: `${provider} provider failures`, body: `${Number(count)} ${provider} model call(s) failed in the last 24 hours.`, metadata: { provider, count: Number(count) } });
  if (credentialRevocations > 0) notifications.push({ eventKey: `credential-revocations:24h:${credentialRevocations}`, severity: "critical", kind: "credential_compromise", title: "Credential revocations need review", body: `${credentialRevocations} installation credential revocation or rotation event(s) occurred in the last 24 hours.`, metadata: { count: credentialRevocations } });
  if (dataAccessEvents > 0) notifications.push({ eventKey: `data-access:24h:${dataAccessEvents}`, severity: "critical", kind: "data_access", title: "Sensitive data access needs review", body: `${dataAccessEvents} support or sensitive-data access event(s) occurred in the last 24 hours.`, metadata: { count: dataAccessEvents } });
  return notifications;
}

async function emitAlertNotifications(pool: Pool, payload: Record<string, unknown>): Promise<void> {
  for (const notification of buildOperatorAlertNotificationSeeds(payload)) {
    await query(pool, `INSERT INTO agent_operator_notifications (event_key, severity, kind, title, body, metadata) VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (event_key) DO NOTHING`, [notification.eventKey, notification.severity, notification.kind, notification.title, notification.body, JSON.stringify(notification.metadata)]);
  }
}

export async function listOperatorNotifications(pool: Pool): Promise<Array<Record<string, unknown>>> {
  const result = await query(pool, `SELECT id, event_key AS "eventKey", severity, kind, title, body, status, created_at AS "createdAt", acknowledged_at AS "acknowledgedAt" FROM agent_operator_notifications ORDER BY created_at DESC LIMIT 100`);
  return result.rows;
}

export async function acknowledgeOperatorNotification(pool: Pool, notificationId: string): Promise<Record<string, unknown>> {
  const result = await query(pool, `UPDATE agent_operator_notifications SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1 AND status = 'unread' RETURNING id, event_key AS "eventKey", severity, kind, title, body, status, created_at AS "createdAt", acknowledged_at AS "acknowledgedAt"`, [notificationId]);
  if (!result.rows[0]) throw Object.assign(new Error("Operator notification not found or already acknowledged"), { statusCode: 404 });
  return result.rows[0];
}

export async function getOperatorProjection(pool: Pool, key: string): Promise<Record<string, unknown>> {
  if (!isProjectionKey(key)) throw Object.assign(new Error("Unknown operator projection key"), { statusCode: 400 });
  const result = await query<{ projection_key: string; revision: string; payload: Record<string, unknown>; generated_at: string; updated_at: string }>(pool, "SELECT projection_key, revision::text, payload, generated_at, updated_at FROM agent_operator_projections WHERE projection_key = $1", [key]);
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Operator projection has not been built"), { statusCode: 404 });
  return { projectionKey: row.projection_key, revision: Number(row.revision), payload: row.payload, generatedAt: row.generated_at, updatedAt: row.updated_at };
}
