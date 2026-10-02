/** Tenant-owned facts are written on the caller's existing database transaction. */
import type { PoolClient } from "pg";
import type {
  AnalyticsOutboxRecord,
  EventInput,
  ObservationInput,
  ScopeDefinitionInput,
  ManifestInput,
} from "@kasitek/contracts";
import {
  tenantProducerConfig,
  buildEvent,
  buildObservation,
  buildScopeDefinition,
  buildManifest,
  enqueueOutbox,
  type EnqueueResult,
} from "@kasitek/server-support/analytics-producer";
import { timestamp } from "@kasitek/server-support/json";
import { UtcTimestamp } from "./db.js";
export {
  applyDeliveryOutcome,
  claimOutboxBatch,
  releaseExpiredLeases,
} from "@kasitek/server-support/analytics-producer";
export const producerConfig = tenantProducerConfig;
export const enqueueRecord = (tx: PoolClient, record: AnalyticsOutboxRecord) =>
  enqueueOutbox(tx, record);
export const enqueueEvent = (tx: PoolClient, input: EventInput) =>
  enqueueRecord(tx, buildEvent(producerConfig(), input));
export const enqueueObservation = (tx: PoolClient, input: ObservationInput) =>
  enqueueRecord(tx, buildObservation(producerConfig(), input));
export const enqueueScopeDefinition = (
  tx: PoolClient,
  input: ScopeDefinitionInput,
) => enqueueRecord(tx, buildScopeDefinition(producerConfig(), input));
export const enqueueManifest = (tx: PoolClient, input: ManifestInput) =>
  enqueueRecord(tx, buildManifest(producerConfig(), input));
type Integer = number | bigint | string;
export const MANIFEST_REFRESH_SECONDS = 3600;
/** chrono::DateTime Display differs from its serde RFC3339 representation. */
export const chronoDisplay = (value: Date): string =>
  timestamp(value).replace("T", " ").replace(/Z$/, " UTC");
export async function workspaceEventCount(
  tx: PoolClient,
  streamKey: string,
): Promise<bigint> {
  return BigInt(
    (
      await tx.query(
        `SELECT COUNT(*)::bigint FROM analytics_outbox WHERE source_service='tenant-platform' AND source_stream_key=$1 AND record_category='event'`,
        [streamKey],
      )
    ).rows[0].count,
  );
}
const domains = {
  scopes: {
    key: "tenant.scopes",
    contracts: ["tenant.scope.definition@1"],
    metrics: [],
    dimensions: [],
  },
  clients: {
    key: "tenant.clients",
    contracts: ["tenant.scope.definition@1", "tenant.client.lifecycle@1"],
    metrics: ["tenant.clients.lifecycle_events"],
    dimensions: ["tenant_client", "client_lifecycle_action", "status"],
  },
  leads: {
    key: "tenant.leads",
    contracts: ["tenant.lead.lifecycle@1"],
    metrics: ["tenant.leads.lifecycle_events"],
    dimensions: [
      "tenant_client",
      "lead_action",
      "lead_status",
      "lead_source",
      "lead_score_band",
      "lead_reason_code",
      "lead_actor_type",
    ],
  },
  assignments: {
    key: "tenant.assignments",
    contracts: ["tenant.client.assignment@1"],
    metrics: ["tenant.client.assignment_events"],
    dimensions: [
      "tenant_client",
      "assignment_action",
      "assignment_role",
      "status",
    ],
  },
};
function addSeconds(value: Date, seconds: number): Date {
  const fraction = timestamp(value).match(/\.(\d+)Z$/)?.[1];
  const shifted = new Date(value.getTime() + seconds * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, fraction ? `.${fraction}Z` : "Z");
  return new UtcTimestamp(shifted, true);
}
async function domainManifest(
  tx: PoolClient,
  workspace: string,
  domain: keyof typeof domains,
  count: Integer,
  collected: Date,
): Promise<EnqueueResult> {
  const def = domains[domain],
    stream = `workspace:${workspace}:${domain}`,
    version = Math.max(
      1,
      Math.floor(collected.getTime() / 1000 / MANIFEST_REFRESH_SECONDS),
    );
  return enqueueManifest(tx, {
    record_id: `manifest:${stream}:${def.key}:${version}`,
    source_domain: domain,
    source_stream_key: stream,
    contract_name: "source.manifest@1",
    schema_version: 1,
    scope_kind: "tenant_workspace",
    scope_external_id: workspace,
    manifest_key: def.key,
    manifest_version: version,
    provider: null,
    connection_ref: null,
    supported_contracts: def.contracts,
    supported_observation_contracts: [],
    supported_metrics: def.metrics,
    supported_dimensions: def.dimensions,
    expected_refresh_seconds: MANIFEST_REFRESH_SECONDS,
    reliable_coverage_start: null,
    highest_authoritative_source_sequence: null,
    approved_checkpoint_count: count,
    approved_checkpoint_hash: null,
    last_successful_collection_at: collected,
    last_attempted_collection_at: collected,
    safe_failure_code: null,
    next_expected_at: addSeconds(collected, MANIFEST_REFRESH_SECONDS),
    manifest_state: "active",
    generated_at: collected,
    idempotency_key: null,
  });
}
export const enqueueScopeManifest = (
  tx: PoolClient,
  workspace: string,
  count: Integer,
  collected: Date,
) => domainManifest(tx, workspace, "scopes", count, collected);
export const enqueueClientManifest = (
  tx: PoolClient,
  workspace: string,
  count: Integer,
  collected: Date,
) => domainManifest(tx, workspace, "clients", count, collected);
export const enqueueLeadManifest = (
  tx: PoolClient,
  workspace: string,
  count: Integer,
  collected: Date,
) => domainManifest(tx, workspace, "leads", count, collected);
export const enqueueAssignmentManifest = (
  tx: PoolClient,
  workspace: string,
  count: Integer,
  collected: Date,
) => domainManifest(tx, workspace, "assignments", count, collected);
export function enqueueWorkspaceScopeDefinition(
  tx: PoolClient,
  workspace: string,
  version: Integer,
  timezone: string,
) {
  const id = `tenant-scope:workspace:${workspace}:${version}`;
  return enqueueScopeDefinition(tx, {
    record_id: id,
    source_domain: "scopes",
    source_stream_key: `workspace:${workspace}:scopes`,
    contract_name: "tenant.scope.definition@1",
    schema_version: 1,
    scope_kind: "tenant_workspace",
    scope_external_id: workspace,
    parent_scope_external_id: null,
    reporting_timezone: timezone,
    status: "active",
    source_version: version,
    idempotency_key: id,
  });
}
export function enqueueClientScopeDefinition(
  tx: PoolClient,
  workspace: string,
  client: string,
  version: Integer,
  timezone: string,
  status: string,
) {
  const id = `tenant-scope:client:${client}:${version}`;
  return enqueueScopeDefinition(tx, {
    record_id: id,
    source_domain: "scopes",
    source_stream_key: `workspace:${workspace}:scopes`,
    contract_name: "tenant.scope.definition@1",
    schema_version: 1,
    scope_kind: "tenant_client",
    scope_external_id: client,
    parent_scope_external_id: workspace,
    reporting_timezone: timezone,
    status,
    source_version: version,
    idempotency_key: id,
  });
}
function event(
  tx: PoolClient,
  workspace: string,
  domain: string,
  id: string,
  scope: "tenant_workspace" | "tenant_client",
  external: string,
  contract: string,
  subjectType: string,
  subjectId: string,
  time: Date,
  attributes: Record<string, string>,
) {
  return enqueueEvent(tx, {
    record_id: id,
    source_domain: domain,
    source_stream_key: `workspace:${workspace}:${domain}`,
    contract_name: contract,
    schema_version: 1,
    scope_kind: scope,
    scope_external_id: external,
    subject_type: subjectType,
    subject_id: subjectId,
    occurred_at: time,
    attributes: { ...attributes, occurred_at: timestamp(time) },
    correlation_id: null,
    causation_id: null,
    idempotency_key: id,
  });
}
export function enqueueClientLifecycle(
  tx: PoolClient,
  workspace: string,
  client: string,
  action: string,
  status: string,
  time: Date,
) {
  return event(
    tx,
    workspace,
    "clients",
    `tenant-client:${client}:lifecycle:${action}:${chronoDisplay(time)}`,
    "tenant_workspace",
    workspace,
    "tenant.client.lifecycle@1",
    "tenant_client",
    client,
    time,
    { tenant_client_id: client, action, status },
  );
}
export function enqueueClientAssignmentLifecycle(
  tx: PoolClient,
  workspace: string,
  client: string,
  user: string,
  assignment: string,
  action: string,
  status: string,
  role: string,
  history: string,
  time: Date,
) {
  return event(
    tx,
    workspace,
    "assignments",
    `tenant-assignment:${assignment}:history:${history}`,
    "tenant_workspace",
    workspace,
    "tenant.client.assignment@1",
    "tenant_client_assignment",
    assignment,
    time,
    {
      tenant_client_id: client,
      tenant_user_id: user,
      action,
      status,
      assignment_role: role,
    },
  );
}
export function enqueueLeadCreated(
  tx: PoolClient,
  workspace: string,
  client: string,
  lead: string,
  source: string,
  scoreBand: string,
  time: Date,
) {
  return event(
    tx,
    workspace,
    "leads",
    `tenant-lead:${lead}:created`,
    "tenant_client",
    client,
    "tenant.lead.lifecycle@1",
    "tenant_lead",
    lead,
    time,
    {
      lead_id: lead,
      tenant_client_id: client,
      action: "created",
      status: "new",
      source,
      score_band: scoreBand,
    },
  );
}
export function enqueueLeadStatusChanged(
  tx: PoolClient,
  workspace: string,
  client: string,
  lead: string,
  previous: string,
  status: string,
  reason: string,
  actor: string,
  source: string,
  scoreBand: string,
  history: string,
  time: Date,
) {
  return event(
    tx,
    workspace,
    "leads",
    `tenant-lead:${lead}:status:${history}`,
    "tenant_client",
    client,
    "tenant.lead.lifecycle@1",
    "tenant_lead",
    lead,
    time,
    {
      lead_id: lead,
      tenant_client_id: client,
      action: "status_changed",
      status,
      previous_status: previous,
      reason_code: reason,
      actor_type: actor,
      source,
      score_band: scoreBand,
    },
  );
}
