import { randomUUID, createHash } from "node:crypto";
import type {
  ProducerConfig,
  EventInput,
  ObservationInput,
  ScopeDefinitionInput,
  ManifestInput,
  AnalyticsOutboxRecord,
  AnalyticsEnvelope,
  RecordCategory,
} from "@kasitek-labs/contracts";
import {
  canonicalJsonSha256,
  integer,
  wireInteger,
  timestamp,
  SerdeFloat,
} from "./json.js";
export { canonicalJsonSha256, canonicalJson } from "./json.js";
export * from "./outbox.js";
export * from "./publisher.js";
export const CORE_SOURCE_SERVICE = "core",
  TENANT_SOURCE_SERVICE = "tenant-platform",
  MAX_OUTBOX_BATCH_SIZE = 500;
export const coreProducerConfig = (): ProducerConfig => ({
  source_service: "core",
  source_namespace: "core",
  source_origin: "kasitek://core",
});
export const tenantProducerConfig = (): ProducerConfig => ({
  source_service: "tenant-platform",
  source_namespace: "tenant-platform",
  source_origin: "kasitek://tenant-platform",
});
export class ProducerValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (code: string, message: string): never => {
  throw new ProducerValidationError(code, message);
};
const byteLength = (v: string): number => Buffer.byteLength(v);
const nonEmpty = (v: string, field: string): void => {
  if (typeof v !== "string" || !v.trim())
    fail("empty_field", `${field} must not be empty`);
};
const contract = (v: string): boolean =>
  /^[a-z][a-z0-9._-]*@\+?\d+$/.test(v) &&
  BigInt(v.split("@")[1]!) > 0n &&
  BigInt(v.split("@")[1]!) <= 4294967295n;
const object = (v: unknown): void => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    fail(
      "attributes_must_be_object",
      "analytics attributes must be a JSON object",
    );
  canonicalJsonSha256(v);
};
const prohibited = new Set([
  "body",
  "content",
  "credential",
  "email",
  "password",
  "phone",
  "prompt",
  "raw_payload",
  "response",
  "secret",
  "token",
]);
export function rejectProhibitedFields(v: unknown): void {
  if (Array.isArray(v)) v.forEach(rejectProhibitedFields);
  else if (v && typeof v === "object")
    for (const [key, child] of Object.entries(v)) {
      if (prohibited.has(key.toLowerCase()))
        fail(
          "prohibited_field",
          `analytics payload contains prohibited field ${key}`,
        );
      rejectProhibitedFields(child);
    }
}
type Common = Pick<
  EventInput,
  | "record_id"
  | "source_domain"
  | "source_stream_key"
  | "contract_name"
  | "schema_version"
  | "scope_kind"
  | "scope_external_id"
  | "idempotency_key"
>;
function validate(config: ProducerConfig, input: Common, data: unknown): void {
  if (!["core", "agent-platform", "tenant-platform"].includes(config.source_service))
    fail(
      "unsupported_source_service",
      `unsupported producer service ${config.source_service}`,
    );
  for (const field of [
    "record_id",
    "source_domain",
    "source_stream_key",
    "scope_external_id",
  ] as const)
    nonEmpty(input[field], field);
  if (
    !Number.isInteger(input.schema_version) ||
    input.schema_version <= 0 ||
    input.schema_version > 2147483647
  )
    fail("invalid_schema_version", "schema version must be positive");
  if (!contract(input.contract_name))
    fail(
      "invalid_contract_name",
      "contract name must match the versioned analytics contract format",
    );
  object(data);
  rejectProhibitedFields(data);
  if (
    [input.record_id, input.source_stream_key, input.scope_external_id].some(
      (v) => byteLength(v) > 512,
    )
  )
    fail("identity_too_long", "source identity exceeds the database limit");
}
function record(
  config: ProducerConfig,
  input: Common,
  category: RecordCategory,
  subject: string,
  time: string,
  data: unknown,
  optional: {
    correlation_id?: string | null;
    causation_id?: string | null;
  } = {},
): AnalyticsOutboxRecord {
  validate(config, input, data);
  const idempotency_key = input.idempotency_key ?? input.record_id;
  const envelope: AnalyticsEnvelope = {
    specversion: "1.0",
    id: randomUUID(),
    source: config.source_origin,
    type: input.contract_name,
    subject,
    time,
    datacontenttype: "application/json",
    dataschema: `https://kasitek.co.za/analytics/contracts/${input.contract_name.replace("@", "/")}/v${input.schema_version}.schema.json`,
    source_service: config.source_service,
    source_domain: input.source_domain,
    record_category: category,
    scope_kind: input.scope_kind,
    scope_external_id: input.scope_external_id,
    idempotency_key,
    data: data as AnalyticsEnvelope["data"],
  };
  for (const key of ["correlation_id", "causation_id"] as const)
    if (optional[key] != null) envelope[key] = optional[key];
  const outbox_id = `${config.source_service}:${category}:${input.record_id}`;
  if (byteLength(outbox_id) > 512)
    fail("identity_too_long", "source identity exceeds the database limit");
  return {
    outbox_id,
    source_service: config.source_service,
    source_domain: input.source_domain,
    source_stream_key: input.source_stream_key,
    record_category: category,
    record_id: input.record_id,
    contract_name: input.contract_name,
    schema_version: input.schema_version,
    scope_kind: input.scope_kind,
    scope_external_id: input.scope_external_id,
    idempotency_key,
    envelope: envelope as unknown as AnalyticsOutboxRecord["envelope"],
    payload_hash: canonicalJsonSha256(data),
  };
}
export function buildEvent(
  config: ProducerConfig,
  input: EventInput,
): AnalyticsOutboxRecord {
  nonEmpty(input.subject_type, "subject_type");
  nonEmpty(input.subject_id, "subject_id");
  return record(
    config,
    input,
    "event",
    `${input.subject_type}:${input.subject_id}`,
    timestamp(input.occurred_at),
    input.attributes,
    input,
  );
}
export function buildObservation(
  config: ProducerConfig,
  input: ObservationInput,
): AnalyticsOutboxRecord {
  for (const field of [
    "provider",
    "metric_key",
    "unit",
    "synchronization_run_id",
  ] as const)
    nonEmpty(input[field], field);
  if (
    !(input.numeric_value instanceof SerdeFloat) &&
    (typeof input.numeric_value !== "number" ||
      !Number.isFinite(input.numeric_value))
  )
    fail(
      "invalid_numeric_value",
      "numeric observation value must be a JSON number",
    );
  if (
    Date.parse(timestamp(input.reporting_window_end)) <=
    Date.parse(timestamp(input.reporting_window_start))
  )
    fail(
      "invalid_observation_window",
      "observation window must end after it starts",
    );
  object(input.dimensions);
  object(input.source_evidence);
  rejectProhibitedFields(input.source_evidence);
  const data = {
    provider: input.provider,
    provider_account_ref: input.provider_account_ref ?? null,
    connection_ref: input.connection_ref ?? null,
    metric_key: input.metric_key,
    numeric_value: input.numeric_value,
    unit: input.unit,
    reporting_window_start: timestamp(input.reporting_window_start),
    reporting_window_end: timestamp(input.reporting_window_end),
    observed_at: timestamp(input.observed_at),
    synchronization_run_id: input.synchronization_run_id,
    dimensions: input.dimensions,
    source_evidence: input.source_evidence,
  };
  return record(
    config,
    input,
    "observation",
    `metric:${input.metric_key}`,
    timestamp(input.observed_at),
    data,
    input,
  );
}
export function buildScopeDefinition(
  config: ProducerConfig,
  input: ScopeDefinitionInput,
): AnalyticsOutboxRecord {
  nonEmpty(input.reporting_timezone, "reporting_timezone");
  nonEmpty(input.status, "status");
  if (integer(input.source_version) <= 0n)
    fail("invalid_schema_version", "schema version must be positive");
  return record(
    config,
    input,
    "scope_definition",
    `scope:${input.scope_external_id}`,
    timestamp(new Date()),
    {
      scope_kind: input.scope_kind,
      scope_external_id: input.scope_external_id,
      parent_scope_external_id: input.parent_scope_external_id ?? null,
      reporting_timezone: input.reporting_timezone,
      status: input.status,
      source_version: wireInteger(input.source_version),
    },
  );
}
export function buildManifest(
  config: ProducerConfig,
  input: ManifestInput,
): AnalyticsOutboxRecord {
  if (input.contract_name !== "source.manifest@1" || input.schema_version !== 1)
    fail(
      "invalid_contract_name",
      "contract name must match the versioned analytics contract format",
    );
  if (
    integer(input.manifest_version) <= 0n ||
    integer(input.expected_refresh_seconds) <= 0n ||
    [
      input.highest_authoritative_source_sequence,
      input.approved_checkpoint_count,
    ].some((v) => v != null && integer(v) < 0n)
  )
    fail(
      "invalid_manifest_number",
      "manifest version and refresh interval must be positive",
    );
  nonEmpty(input.manifest_key, "manifest_key");
  if (
    input.record_id !==
    `manifest:${input.source_stream_key}:${input.manifest_key}:${input.manifest_version}`
  )
    fail(
      "invalid_manifest_identity",
      "manifest record identity must match its source stream, key, and version",
    );
  for (const field of [
    "supported_contracts",
    "supported_observation_contracts",
    "supported_metrics",
    "supported_dimensions",
  ] as const) {
    const values = input[field];
    if (
      values.length > 256 ||
      new Set(values).size !== values.length ||
      values.some(
        (v) =>
          byteLength(v) > 256 ||
          (field.includes("contracts")
            ? !contract(v)
            : !/^[a-z][a-z0-9_.-]+$/.test(v)),
      )
    )
      fail(
        "invalid_manifest_identifier",
        "manifest list contains an invalid identifier",
      );
  }
  if (
    input.approved_checkpoint_hash != null &&
    !/^[a-f0-9]{64}$/.test(input.approved_checkpoint_hash)
  )
    fail(
      "invalid_manifest_checkpoint_hash",
      "manifest checkpoint hash must be lowercase SHA-256 hex",
    );
  if (
    input.safe_failure_code != null &&
    !/^[a-z][a-z0-9_.-]{0,127}$/.test(input.safe_failure_code)
  )
    fail(
      "invalid_manifest_failure_code",
      "manifest safe failure code is invalid",
    );
  if (
    !["active", "disabled", "unsupported", "awaiting_instrumentation"].includes(
      input.manifest_state,
    )
  )
    fail("invalid_manifest_state", "manifest state is not supported");
  if (
    byteLength(input.manifest_key) > 512 ||
    byteLength(input.provider ?? "") > 128 ||
    byteLength(input.connection_ref ?? "") > 512
  )
    fail("identity_too_long", "source identity exceeds the database limit");
  const data: Record<string, unknown> = {};
  for (const key of [
    "manifest_key",
    "provider",
    "connection_ref",
    "supported_contracts",
    "supported_observation_contracts",
    "supported_metrics",
    "supported_dimensions",
    "approved_checkpoint_hash",
    "safe_failure_code",
    "manifest_state",
  ] as const)
    data[key] = input[key] ?? null;
  for (const key of [
    "manifest_version",
    "expected_refresh_seconds",
    "highest_authoritative_source_sequence",
    "approved_checkpoint_count",
  ] as const)
    data[key] = input[key] == null ? null : wireInteger(input[key]);
  for (const key of [
    "reliable_coverage_start",
    "last_successful_collection_at",
    "last_attempted_collection_at",
    "next_expected_at",
    "generated_at",
  ] as const)
    data[key] = input[key] == null ? null : timestamp(input[key]);
  return record(
    config,
    input,
    "manifest",
    `manifest:${input.manifest_key}`,
    timestamp(input.generated_at),
    data,
  );
}
export function nextRetryAt(
  now: Date,
  attempt: number,
  stableSeed: string,
  baseDelay = 2,
  maxDelay = 300,
  jitterWindow = 2,
): Date {
  const seed = createHash("sha256")
    .update(`${stableSeed}:${attempt}`)
    .digest()
    .readBigUInt64BE(0);
  return new Date(
    now.getTime() +
      1000 *
        (Math.min(
          baseDelay * 2 ** Math.min(Math.max(attempt - 1, 0), 16),
          maxDelay,
        ) +
          Number(seed % BigInt(jitterWindow + 1))),
  );
}
export function backfillSourceSequence(recordId: string): bigint {
  const value =
    createHash("sha256")
      .update(`kasitek.analytics.backfill:${recordId}`)
      .digest()
      .readBigUInt64BE(0) & 0x7fffffffffffffffn;
  return value === 0n ? 1n : value;
}
