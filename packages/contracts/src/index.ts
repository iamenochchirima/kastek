// Wire names follow the existing Rust contracts. Large integer fields use bigint or exact decimal strings internally.
export * from "./analytics-registry.js";
export * from "./growth-product-references.js";

export interface JsonFloat {
  readonly __serde_float: true;
  readonly value: number;
}
export type JsonValue =
  | JsonFloat
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type Integer = number | bigint | string;
export type Timestamp = string | Date;
export type RecordCategory =
  | "event"
  | "observation"
  | "scope_definition"
  | "manifest";
export type ScopeKind =
  | "agents_organization"
  | "core_organization"
  | "tenant_workspace"
  | "tenant_client";
export type PrincipalType = "user" | "service_identity" | "agent_installation";
export type DescendantMode = "none" | "all" | "explicit";
export const CATALOG_PATH = "/v1/metrics/catalog";
export const QUERY_PATH = "/v1/reports/query";
export const SCOPE_RESOLVE_PATH = "/internal/reporting/scopes/resolve";
export const REPORTING_AUDIENCE = "kasitek-analytics-reporting";
export const REPORTING_POLICY_VERSION = "customer-reporting-v1";
export const MAX_GRANT_SECONDS = 120;
export interface ProducerConfig {
  source_service: string;
  source_namespace: string;
  source_origin: string;
}
export interface EventInput {
  record_id: string;
  source_domain: string;
  source_stream_key: string;
  contract_name: string;
  schema_version: number;
  scope_kind: ScopeKind;
  scope_external_id: string;
  subject_type: string;
  subject_id: string;
  occurred_at: Timestamp;
  attributes: JsonValue;
  correlation_id?: string | null;
  causation_id?: string | null;
  idempotency_key?: string | null;
}
export interface ObservationInput {
  record_id: string;
  source_domain: string;
  source_stream_key: string;
  contract_name: string;
  schema_version: number;
  scope_kind: ScopeKind;
  scope_external_id: string;
  provider: string;
  provider_account_ref?: string | null;
  connection_ref?: string | null;
  metric_key: string;
  numeric_value: JsonValue;
  unit: string;
  reporting_window_start: Timestamp;
  reporting_window_end: Timestamp;
  observed_at: Timestamp;
  synchronization_run_id: string;
  dimensions: JsonValue;
  source_evidence: JsonValue;
  correlation_id?: string | null;
  idempotency_key?: string | null;
}
export interface ScopeDefinitionInput {
  record_id: string;
  source_domain: string;
  source_stream_key: string;
  contract_name: string;
  schema_version: number;
  scope_kind: ScopeKind;
  scope_external_id: string;
  parent_scope_external_id?: string | null;
  reporting_timezone: string;
  status: string;
  source_version: Integer;
  idempotency_key?: string | null;
}
export interface ManifestInput {
  record_id: string;
  source_domain: string;
  source_stream_key: string;
  contract_name: string;
  schema_version: number;
  scope_kind: ScopeKind;
  scope_external_id: string;
  manifest_key: string;
  manifest_version: Integer;
  provider?: string | null;
  connection_ref?: string | null;
  supported_contracts: string[];
  supported_observation_contracts: string[];
  supported_metrics: string[];
  supported_dimensions: string[];
  expected_refresh_seconds: Integer;
  reliable_coverage_start?: Timestamp | null;
  highest_authoritative_source_sequence?: Integer | null;
  approved_checkpoint_count?: Integer | null;
  approved_checkpoint_hash?: string | null;
  last_successful_collection_at?: Timestamp | null;
  last_attempted_collection_at?: Timestamp | null;
  safe_failure_code?: string | null;
  next_expected_at?: Timestamp | null;
  manifest_state: string;
  generated_at: Timestamp;
  idempotency_key?: string | null;
}
export interface AnalyticsEnvelope {
  specversion: string;
  id: string;
  source: string;
  type: string;
  subject: string;
  time: Timestamp;
  datacontenttype: string;
  dataschema: string;
  source_service: string;
  source_domain: string;
  record_category: RecordCategory;
  scope_kind: ScopeKind;
  scope_external_id: string;
  correlation_id?: string | null;
  causation_id?: string | null;
  idempotency_key?: string | null;
  data: JsonValue;
}
export interface AnalyticsOutboxRecord {
  outbox_id: string;
  source_service: string;
  source_domain: string;
  source_stream_key: string;
  record_category: RecordCategory;
  record_id: string;
  contract_name: string;
  schema_version: number;
  scope_kind: ScopeKind;
  scope_external_id: string;
  idempotency_key: string;
  envelope: JsonValue;
  payload_hash: string;
}
export interface OutboxRow {
  outbox_id: string;
  source_sequence: Integer;
  source_service: string;
  source_domain: string;
  source_stream_key: string;
  record_category: string;
  record_id: string;
  contract_name: string;
  schema_version: number;
  scope_kind: string;
  scope_external_id: string;
  idempotency_key: string;
  envelope: JsonValue;
  payload_hash: string;
  delivery_status: string;
  attempt_count: number;
  next_attempt_at: Timestamp;
  created_at: Timestamp;
  lease_owner?: string | null;
  lease_expires_at?: Timestamp | null;
}
export interface ReconciliationCursor {
  source_stream_key: string;
  source_domain: string;
  scope_kind: string;
  scope_external_id: string;
}
export interface OutboxReconciliationSummary {
  cursor: ReconciliationCursor;
  source_domain: string;
  source_stream_key: string;
  scope_kind: string;
  scope_external_id: string;
  source_highest_outbox_sequence: Integer;
  source_highest_delivered_sequence?: Integer | null;
  authoritative_count: Integer;
}
export interface ReconciliationRequest {
  reconciliation_run_id: string;
  producer_id: string;
  source_domain: string;
  source_stream_key: string;
  scope_kind: string;
  scope_external_id: string;
  source_highest_outbox_sequence: Integer;
  source_highest_delivered_sequence?: Integer | null;
  authoritative_count: Integer;
}
export interface ReconciliationResponse {
  reconciliation_run_id: string;
  reconciliation_status: string;
  analytics_highest_received_sequence: Integer;
  analytics_highest_contiguous_sequence: Integer;
  missing_sequence_ranges: JsonValue;
  unresolved_quarantine_count: Integer;
  analytics_count: Integer;
}
export interface SourceBackfillWork {
  job_id: string;
  source_service: string;
  source_domain: string;
  reporting_scope_id: Integer;
  root_scope_id: Integer;
  scope_external_id: string;
  requested_range_start: Timestamp;
  requested_range_end: Timestamp;
  contract_version: string;
  projection_version?: string | null;
  method: string;
  job_status: string;
  checkpoint: JsonValue;
  remaining_count?: Integer | null;
  lease_expires_at: Timestamp;
}
export interface BackfillRecord {
  source_sequence: Integer;
  record: AnalyticsOutboxRecord;
}
export interface BackfillBatchResponse {
  accepted_count: number;
  duplicate_count: number;
  rejected_count: number;
  retryable_count: number;
  acknowledgements: BackfillAcknowledgement[];
}
export interface BackfillAcknowledgement {
  record_id: string;
  source_sequence: Integer;
  status: string;
  error_code?: string | null;
}
export interface ReportingGrantInput {
  principal_id: string;
  scope_id: Integer;
  root_scope_id: Integer;
  descendant_mode: DescendantMode;
  permissions: string[];
  metric_keys: string[];
  dimension_keys: string[];
  correlation_id?: string | null;
}
export interface ScopeResolution {
  scope_id: Integer;
  scope_kind: string;
  owning_source_service: string;
  external_source_id: string;
  root_scope_id: Integer;
  parent_scope_id?: Integer | null;
  reporting_timezone: string;
}
export interface ReportQueryInput {
  range_start: Timestamp;
  range_end: Timestamp;
  timezone: string;
  interval?: string | null;
  metrics: string[];
  metric_set?: string | null;
  breakdowns: string[];
  filters: Record<string, string[]>;
  include_descendants: boolean;
  comparison?: ComparisonRequest | null;
}
export interface ReportQueryRequest {
  reporting_scope_id: Integer;
  range_start: Timestamp;
  range_end: Timestamp;
  timezone: string;
  interval?: string | null;
  metrics: string[];
  metric_set?: string | null;
  breakdowns: string[];
  filters: Record<string, string[]>;
  include_descendants: boolean;
  comparison?: ComparisonRequest | null;
}
export interface ComparisonRequest {
  kind: string;
}

export * from "./growth-agents.js";
export * from "./agent-memory.js";
export * from "./growth-agent-resources.js";
export * from "./agency-agents.js";

export * from "./admin-reporting.js";

export * from "./admin-reporting-diagnostics.js";

export * from "./growth-agent-provisioning.js";

export * from "./admin-customers.js";

export * from "./product-capabilities.js";

export * from "./product-capability-transport.js";

export * from "./operations.js";

export * from "./growth-operations.js";

export type { GrowthAgentRuntime, GrowthAgentRuntimeOperation } from "./growth-agent-runtime.js";
