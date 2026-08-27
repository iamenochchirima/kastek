import type { Pool } from "pg";
import { query } from "../db/pool";
import { DEFAULT_RETENTION_POLICY, RetentionRepository } from "../db/repositories/retention-repository";

export const OPERATOR_PROJECTION_KEYS = [
  "summary",
  "run_health",
  "health",
  "retention",
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

/** Keep mode metrics bounded to the three persisted execution identities. */
export function indexExecutionModes(rows: readonly { execution_mode: string; count: string }[]): Record<string, number> {
  const result: Record<string, number> = {
    system_hosted: 0,
    kasitek_hosted: 0,
    external_connected: 0,
  };
  for (const row of rows) {
    if (Object.hasOwn(result, row.execution_mode)) result[row.execution_mode] = Number(row.count);
  }
  return result;
}

async function buildPayload(pool: Pool, key: OperatorProjectionKey): Promise<Record<string, unknown>> {
  if (key === "summary" || key === "run_health") {
    const [runs, installations, definitions, effects, events, conversations, channels, approvals, executionModes] = await Promise.all([
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_runs GROUP BY status ORDER BY status"),
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_installations GROUP BY status ORDER BY status"),
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_definitions GROUP BY status ORDER BY status"),
      query<{ status: string; count: string; reconciliation_required: boolean }>(pool, "SELECT status, COUNT(*)::text AS count, reconciliation_required FROM agent_effect_receipts GROUP BY status, reconciliation_required ORDER BY status"),
      query<{ event_type: string; count: string }>(pool, "SELECT event_type, COUNT(*)::text AS count FROM agent_events GROUP BY event_type ORDER BY event_type"),
      query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM conversations WHERE status <> 'deleted'"),
      query<{ count: string }>(pool, "SELECT COUNT(*)::text AS count FROM channel_connections WHERE status <> 'revoked'"),
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_approval_records GROUP BY status ORDER BY status"),
      query<{ execution_mode: string; count: string }>(pool, "SELECT execution_mode, COUNT(*)::text AS count FROM agent_installations GROUP BY execution_mode ORDER BY execution_mode"),
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
      executionModes: indexExecutionModes(executionModes.rows),
    };
    return key === "summary" ? payload : { generatedAt: payload.generatedAt, runs: payload.runs, eventTypes: Object.fromEntries(events.rows.map((row) => [row.event_type, Number(row.count)])), executionModes: payload.executionModes };
  }

  if (key === "health") {
    const databaseStartedAt = Date.now();
    const [database, installations, credentials, providers, cost, queue, tools, effects, deliveries, approvals, audit, executionModes, audioTranscription] = await Promise.all([
      query(pool, "SELECT 1"),
      query<{ active: string }>(pool, "SELECT COUNT(*) FILTER (WHERE status = 'active')::text AS active FROM agent_installations"),
      query<{ active: string; expiring: string }>(pool, "SELECT COUNT(*) FILTER (WHERE status = 'active' AND (expires_at IS NULL OR expires_at > now()))::text AS active, COUNT(*) FILTER (WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= now() + interval '7 days')::text AS expiring FROM agent_installation_credentials"),
      query<{ provider: string; calls: string; failures: string }>(pool, `SELECT provider, COUNT(*)::text AS calls, COUNT(*) FILTER (WHERE status = 'failed')::text AS failures FROM model_calls WHERE created_at > now() - interval '24 hours' GROUP BY provider ORDER BY provider`),
      query<{ calls: string; missing: string }>(pool, "SELECT COUNT(*)::text AS calls, COUNT(*) FILTER (WHERE estimated_cost_usd IS NULL)::text AS missing FROM model_calls WHERE created_at > now() - interval '24 hours'"),
      query<{ queued: string; stale: string; running: string }>(pool, `SELECT COUNT(*) FILTER (WHERE status = 'queued')::text AS queued, COUNT(*) FILTER (WHERE status = 'queued' AND created_at < now() - interval '15 minutes')::text AS stale, COUNT(*) FILTER (WHERE status = 'running' AND updated_at < now() - interval '30 minutes')::text AS running FROM agent_runs`),
      query<{ failed: string }>(pool, "SELECT COUNT(*) FILTER (WHERE status = 'failed')::text AS failed FROM tool_invocations WHERE created_at > now() - interval '24 hours'"),
      query<{ unknown: string; executing: string }>(pool, "SELECT COUNT(*) FILTER (WHERE status = 'unknown')::text AS unknown, COUNT(*) FILTER (WHERE status = 'executing')::text AS executing FROM agent_effect_receipts"),
      query<{ failed: string; unknown: string }>(pool, "SELECT COUNT(*) FILTER (WHERE status = 'failed')::text AS failed, COUNT(*) FILTER (WHERE status = 'unknown')::text AS unknown FROM delivery_attempts WHERE created_at > now() - interval '24 hours'"),
      query<{ pending: string; expired: string }>(pool, "SELECT COUNT(*) FILTER (WHERE status = 'pending')::text AS pending, COUNT(*) FILTER (WHERE status = 'pending' AND expires_at <= now())::text AS expired FROM agent_approval_records"),
      query<{ access: string }>(pool, "SELECT COUNT(*)::text AS access FROM audit_records WHERE (action ILIKE '%support%' OR action ILIKE '%data_access%' OR resource_type = 'customer_content') AND created_at > now() - interval '24 hours'"),
      query<{ execution_mode: string; count: string }>(pool, "SELECT execution_mode, COUNT(*)::text AS count FROM agent_installations WHERE status = 'active' GROUP BY execution_mode ORDER BY execution_mode"),
      query<{ queued: string; stale: string; failed: string }>(pool, `SELECT COUNT(*) FILTER (WHERE status IN ('queued', 'processing', 'dispatching', 'retryable_failed'))::text AS queued, COUNT(*) FILTER (WHERE status IN ('queued', 'processing', 'dispatching', 'retryable_failed') AND updated_at < now() - interval '15 minutes')::text AS stale, COUNT(*) FILTER (WHERE status = 'failed' AND updated_at > now() - interval '24 hours')::text AS failed FROM audio_transcription_jobs`),
    ]);
    const status = (degraded: boolean, unavailable = false): "ready" | "degraded" | "unavailable" => unavailable ? "unavailable" : degraded ? "degraded" : "ready";
    const providerChecks = providers.rows.map((row) => {
      const calls = Number(row.calls);
      const failures = Number(row.failures);
      return { name: row.provider, status: status(failures > 0), calls24h: calls, failures24h: failures, failureRate: calls ? Number((failures / calls).toFixed(4)) : 0 };
    });
    const checks = {
      database: { status: "ready" as const, latencyMs: Date.now() - databaseStartedAt },
      auth: { status: "ready" as const, detail: "Installation token verification is enforced at the HTTP boundary." },
      credentials: { status: status(Number(credentials.rows[0]?.active ?? 0) < Number(installations.rows[0]?.active ?? 0) || Number(credentials.rows[0]?.expiring ?? 0) > 0), active: Number(credentials.rows[0]?.active ?? 0), expiring7d: Number(credentials.rows[0]?.expiring ?? 0) },
      apis: { status: "ready" as const, agent: "ready", mcp: "policy-gated", rest: "policy-gated" },
      modelProviders: { status: status(providerChecks.some((provider) => provider.status !== "ready")), providers: providerChecks },
      temporal: { status: "unknown", detail: "Worker heartbeat is verified by the Temporal deployment, not this database projection." },
      redis: { status: "unknown", detail: "Cross-instance replay and TTL checks are verified by the Redis release gate." },
      queuesWorkers: { status: status(Number(queue.rows[0]?.stale ?? 0) > 0 || Number(queue.rows[0]?.running ?? 0) > 0), queued: Number(queue.rows[0]?.queued ?? 0), staleQueued: Number(queue.rows[0]?.stale ?? 0), staleRunning: Number(queue.rows[0]?.running ?? 0) },
      tools: { status: status(Number(tools.rows[0]?.failed ?? 0) > 0), failed24h: Number(tools.rows[0]?.failed ?? 0) },
      effects: { status: status(Number(effects.rows[0]?.unknown ?? 0) > 0), unknown: Number(effects.rows[0]?.unknown ?? 0), executing: Number(effects.rows[0]?.executing ?? 0) },
      webhooksDelivery: { status: status(Number(deliveries.rows[0]?.failed ?? 0) > 0 || Number(deliveries.rows[0]?.unknown ?? 0) > 0), failed24h: Number(deliveries.rows[0]?.failed ?? 0), unknown24h: Number(deliveries.rows[0]?.unknown ?? 0) },
      approvals: { status: status(Number(approvals.rows[0]?.expired ?? 0) > 0), pending: Number(approvals.rows[0]?.pending ?? 0), expiredPending: Number(approvals.rows[0]?.expired ?? 0) },
      cost: { status: status(Number(cost.rows[0]?.missing ?? 0) > 0), calls24h: Number(cost.rows[0]?.calls ?? 0), missingEstimates24h: Number(cost.rows[0]?.missing ?? 0) },
      rateLimits: { status: "ready" as const, detail: "Gateway rate limits are enforced at the edge and are intentionally not persisted with customer data." },
      suspiciousAccess: { status: status(Number(audit.rows[0]?.access ?? 0) > 0), events24h: Number(audit.rows[0]?.access ?? 0) },
      executionModes: { status: "ready" as const, active: indexExecutionModes(executionModes.rows) },
      audioTranscription: { status: status(Number(audioTranscription.rows[0]?.stale ?? 0) > 0), queued: Number(audioTranscription.rows[0]?.queued ?? 0), stale: Number(audioTranscription.rows[0]?.stale ?? 0), failed24h: Number(audioTranscription.rows[0]?.failed ?? 0), providerConfigured: Boolean(process.env.ELEVENLABS_API_KEY?.trim()) },
    };
    const degradedChecks = Object.values(checks).filter((check) => check.status === "degraded" || check.status === "unavailable").length;
    return { generatedAt: new Date().toISOString(), overallStatus: degradedChecks ? "degraded" : "ready", checks, degradedChecks };
  }

  if (key === "retention") {
    const retention = new RetentionRepository(pool);
    const [audit, events, messages, runs, memory, attachments, deletionJobs, exports, holds, policies, legalHolds] = await Promise.all([
      query<{ count: string; oldest: string | null }>(pool, "SELECT COUNT(*)::text AS count, MIN(created_at)::text AS oldest FROM audit_records"),
      query<{ count: string; oldest: string | null }>(pool, "SELECT COUNT(*)::text AS count, MIN(created_at)::text AS oldest FROM agent_events"),
      query<{ count: string; oldest: string | null }>(pool, "SELECT COUNT(*)::text AS count, MIN(created_at)::text AS oldest FROM messages"),
      query<{ count: string; oldest: string | null }>(pool, "SELECT COUNT(*)::text AS count, MIN(created_at)::text AS oldest FROM agent_runs"),
      query<{ active: string; expired: string; deleted: string }>(pool, "SELECT COUNT(*) FILTER (WHERE status = 'active')::text AS active, COUNT(*) FILTER (WHERE status = 'expired')::text AS expired, COUNT(*) FILTER (WHERE status = 'deleted')::text AS deleted FROM memory_records"),
      query<{ total: string; expired: string }>(pool, "SELECT COUNT(*)::text AS total, COUNT(*) FILTER (WHERE retention_expires_at IS NOT NULL AND retention_expires_at <= now())::text AS expired FROM agent_attachment_references"),
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM memory_deletion_jobs GROUP BY status ORDER BY status"),
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM agent_export_requests GROUP BY status ORDER BY status"),
      query<{ active: string }>(pool, "SELECT COUNT(*)::text AS active FROM agent_operator_holds WHERE status = 'active' AND expires_at > now()"),
      retention.listPolicies(500),
      retention.listLegalHolds(500),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      policy: { version: "agent-lifecycle-v1", defaults: DEFAULT_RETENTION_POLICY, configuredOrganizations: policies.length, redaction: "projection fields are allow-listed; payloads and secrets are excluded", deletion: "explicit jobs only", export: "dual-control request queue", backupRestore: "external deployment gate", legalHold: "scoped legal-hold table with release audit" },
      datasets: [
        { key: "audit_records", count: Number(audit.rows[0]?.count ?? 0), oldestAt: audit.rows[0]?.oldest ?? null, immutable: true },
        { key: "agent_events", count: Number(events.rows[0]?.count ?? 0), oldestAt: events.rows[0]?.oldest ?? null, immutable: false },
        { key: "messages", count: Number(messages.rows[0]?.count ?? 0), oldestAt: messages.rows[0]?.oldest ?? null, immutable: false },
        { key: "agent_runs", count: Number(runs.rows[0]?.count ?? 0), oldestAt: runs.rows[0]?.oldest ?? null, immutable: false },
        { key: "memory_records", active: Number(memory.rows[0]?.active ?? 0), expired: Number(memory.rows[0]?.expired ?? 0), deleted: Number(memory.rows[0]?.deleted ?? 0), immutable: false },
        { key: "attachments", total: Number(attachments.rows[0]?.total ?? 0), expired: Number(attachments.rows[0]?.expired ?? 0), immutable: false },
      ],
      deletionJobs: Object.fromEntries(deletionJobs.rows.map((row) => [row.status, Number(row.count)])),
      exportRequests: Object.fromEntries(exports.rows.map((row) => [row.status, Number(row.count)])),
      activeIncidentHolds: Number(holds.rows[0]?.active ?? 0),
      configuredPolicies: policies.map((policy) => ({ organizationId: policy.organization_id, revision: policy.revision, memoryDays: policy.memory_days, conversationDays: policy.conversation_days, eventDays: policy.event_days, auditDays: policy.audit_days, attachmentDays: policy.attachment_days, updatedAt: policy.updated_at })),
      legalHolds: legalHolds.map((hold) => ({ id: hold.id, organizationId: hold.organization_id, scopeType: hold.scope_type, scopeId: hold.scope_id, status: hold.status, expiresAt: hold.expires_at, revision: hold.revision })),
    };
  }

  if (key === "usage_cost") {
    const result = await query<{ calls: string; total: string; tokens: string }>(pool, "SELECT COUNT(*)::text AS calls, COALESCE(SUM(estimated_cost_usd), 0)::text AS total, COALESCE(SUM(total_tokens), 0)::text AS tokens FROM model_calls");
    return { generatedAt: new Date().toISOString(), modelCalls: Number(result.rows[0]?.calls ?? 0), estimatedCostUsd: result.rows[0]?.total ?? "0", totalTokens: Number(result.rows[0]?.tokens ?? 0) };
  }

  if (key === "delivery_health") {
    const [result, failures] = await Promise.all([
      query<{ status: string; count: string }>(pool, "SELECT status, COUNT(*)::text AS count FROM delivery_attempts GROUP BY status ORDER BY status"),
      query<{ id: string; organization_id: string; status: string; attempt_number: number; created_at: string }>(pool, `SELECT id::text, organization_id, status, attempt_number, created_at
        FROM delivery_attempts
        WHERE status IN ('failed', 'unknown')
        ORDER BY created_at DESC
        LIMIT 50`),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      deliveries: Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)])),
      failedAttempts: failures.rows.map((row) => ({ id: row.id, organizationId: row.organization_id, status: row.status, attemptNumber: row.attempt_number, createdAt: row.created_at })),
    };
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
    if (key === "health") await emitHealthNotifications(pool, payload);
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

async function emitHealthNotifications(pool: Pool, payload: Record<string, unknown>): Promise<void> {
  const checks = payload.checks && typeof payload.checks === "object" && !Array.isArray(payload.checks)
    ? payload.checks as Record<string, unknown>
    : {};
  for (const [name, rawCheck] of Object.entries(checks)) {
    if (!rawCheck || typeof rawCheck !== "object" || Array.isArray(rawCheck)) continue;
    const check = rawCheck as Record<string, unknown>;
    if (check.status !== "degraded" && check.status !== "unavailable") continue;
    const detail = typeof check.detail === "string" ? check.detail : `${name} reported a degraded state.`;
    await query(pool, `INSERT INTO agent_operator_notifications (event_key, severity, kind, title, body, metadata) VALUES ($1, 'critical', 'dependency_degraded', $2, $3, $4::jsonb) ON CONFLICT (event_key) DO NOTHING`, [`health:${name}:${check.status}:${new Date().toISOString().slice(0, 10)}`, `${name} dependency degraded`, detail, JSON.stringify({ dependency: name, status: check.status })]);
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
