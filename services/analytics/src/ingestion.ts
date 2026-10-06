import { RequestExtractionError } from "./error.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { canonicalJson, SerdeFloat } from "@kasitek-labs/server-support/json";
import { validateEnvelope, validateRegisteredContract } from "./registry.js";
import { enqueueFact, hourlyWindow } from "./projections.js";
import {
  canonicalPayloadSha256,
  validateSha256Hex,
  normalizedTime,
  timestampNanos,
  addSeconds,
  type RecordCategory,
  type ScopeBinding,
} from "./records.js";
import { SQL } from "./ingestion-sql.js";
import type { AnalyticsContext } from "./context.js";
export const INGESTION_PATH = "/internal/ingest/v1/batch",
  MAX_BATCH_RECORDS = 500,
  MAX_BATCH_BYTES = 8 * 1024 * 1024,
  MAX_RECORD_BYTES = 1024 * 1024;
export interface AuthenticatedProducer {
  source_service: string;
  producer_id: string;
}
export interface IngestionCredential extends AuthenticatedProducer {
  token_sha256: string;
}
export class IngestionAuthenticator {
  constructor(private credentials: IngestionCredential[]) {}
  authenticate(
    request: Pick<FastifyRequest, "headers">,
  ): AuthenticatedProducer {
    const header = request.headers.authorization;
    if (typeof header !== "string") throw new Error("MissingBearer");
    if (!header.startsWith("Bearer ") || !header.slice(7).trim())
      throw new Error("InvalidBearer");
    const digest = createHash("sha256")
      .update(header.slice(7).trim())
      .digest("hex");
    const credential = this.credentials.find((c) => {
      const a = Buffer.from(c.token_sha256),
        b = Buffer.from(digest);
      return a.length === b.length && timingSafeEqual(a, b);
    });
    if (!credential) throw new Error("InvalidBearer");
    return {
      source_service: credential.source_service,
      producer_id: credential.producer_id,
    };
  }
}
export interface RepairContext {
  failure_id: bigint;
  transform_version: string;
}
export interface IngestionRecord {
  producer_id: string;
  source_stream_key: string;
  source_sequence: bigint;
  record_category: RecordCategory;
  record_id: string;
  contract_name: string;
  schema_version: number;
  scope_kind: string;
  scope_external_id: string;
  payload_hash: string;
  envelope: unknown;
}
export interface IngestionBatchRequest {
  records: IngestionRecord[];
  backfill_job_id?: string | null;
}
export interface IngestionAcknowledgement {
  record_id: string;
  source_sequence: bigint;
  status: "accepted" | "duplicate" | "rejected" | "retryable";
  error_code?: string;
}
export interface IngestionBatchResponse {
  accepted_count: number;
  duplicate_count: number;
  rejected_count: number;
  retryable_count: number;
  acknowledgements: IngestionAcknowledgement[];
}
export class ValidationFailure extends Error {
  constructor(
    public code: string,
    public class_:
      | "permanent"
      | "retryable"
      | "identity_conflict"
      | "privacy" = "permanent",
  ) {
    super(code);
  }
}
const fail = (
  code: string,
  class_:
    | "permanent"
    | "retryable"
    | "identity_conflict"
    | "privacy" = "permanent",
): never => {
  throw new ValidationFailure(code, class_);
};
export const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  !(v instanceof SerdeFloat)
    ? (v as Record<string, unknown>)
    : null;
export function asI64(v: unknown): bigint | null {
  if (
    typeof v !== "bigint" &&
    (typeof v !== "number" || !Number.isSafeInteger(v))
  )
    return null;
  const n = BigInt(v);
  return n >= -(1n << 63n) && n <= (1n << 63n) - 1n ? n : null;
}
const optionalText = (v: Record<string, unknown>, key: string) =>
  typeof v[key] === "string" && (v[key] as string).trim()
    ? (v[key] as string)
    : null;
const requiredText = (v: Record<string, unknown>, key: string) =>
  optionalText(v, key) ?? fail("invalid_observation");
const requiredTime = (v: Record<string, unknown>, key: string) =>
  normalizedTime(v[key]) ?? fail("invalid_observation_time");
const optionalTime = (v: Record<string, unknown>, key: string) =>
  v[key] == null
    ? null
    : (normalizedTime(v[key]) ?? fail("invalid_manifest_time"));
const positive = (v: Record<string, unknown>, key: string) => {
  const n = asI64(v[key]);
  return n !== null && n > 0n ? n : fail("invalid_manifest_number");
};
const nonnegative = (v: Record<string, unknown>, key: string) => {
  if (v[key] == null) return null;
  const n = asI64(v[key]);
  return n !== null && n >= 0n ? n : fail("invalid_manifest_number");
};
const isMetric = (v: string) => /^[a-z][a-z0-9_.-]+$/.test(v);
const isContract = (v: string) => {
  const m = /^([a-z][a-z0-9_.-]*)@([+]?[0-9]+)$/.exec(v);
  return m !== null && BigInt(m[2]!) > 0n && BigInt(m[2]!) <= 4294967295n;
};
function identifiers(
  v: Record<string, unknown>,
  key: string,
  versioned: boolean,
): string[] {
  const list = v[key];
  if (!Array.isArray(list) || list.length > 256)
    fail("invalid_manifest_identifiers");
  const output: string[] = [];
  for (const value of list as unknown[]) {
    if (
      typeof value !== "string" ||
      Buffer.byteLength(value) > 256 ||
      !(versioned ? isContract(value) : isMetric(value)) ||
      output.includes(value)
    )
      return fail("invalid_manifest_identifiers");
    output.push(value);
  }
  return output;
}
export function containsProhibitedField(value: unknown): boolean {
  const forbidden = [
    "prompt",
    "response",
    "phone_number",
    "email",
    "credential",
    "token",
    "access_token",
    "refresh_token",
  ];
  const object = asObject(value);
  if (object)
    return Object.entries(object).some(
      ([key, val]) => forbidden.includes(key) || containsProhibitedField(val),
    );
  return Array.isArray(value) && value.some(containsProhibitedField);
}
export function recordSourceDomain(record: IngestionRecord): string {
  const value = asObject(record.envelope)?.source_domain;
  return typeof value === "string" ? value : "";
}
interface ValidatedRecord {
  payload: Record<string, unknown>;
  occurred_at: string;
  origin: string;
  correlation_id: string | null;
  causation_id: string | null;
  idempotency_key: string | null;
}
export function validateRecord(
  record: IngestionRecord,
  authenticated: AuthenticatedProducer,
): ValidatedRecord {
  try {
    validateSha256Hex(record.payload_hash);
  } catch {
    fail("invalid_payload_hash");
  }
  try {
    validateEnvelope(record.envelope);
  } catch {
    fail("invalid_envelope");
  }
  const envelope = asObject(record.envelope) ?? fail("invalid_envelope");
  const text = (key: string) =>
    optionalText(envelope, key) ?? fail("invalid_envelope");
  if (
    text("source_service") !== authenticated.source_service ||
    text("source_domain") !== recordSourceDomain(record) ||
    text("type") !== record.contract_name ||
    text("scope_kind") !== record.scope_kind ||
    text("scope_external_id") !== record.scope_external_id
  )
    fail("envelope_identity_mismatch", "identity_conflict");
  const category = envelope.record_category;
  if (
    !["event", "observation", "scope_definition", "manifest"].includes(
      String(category),
    )
  )
    fail("invalid_record_category");
  if (category !== record.record_category)
    fail("record_category_mismatch", "identity_conflict");
  const version = record.contract_name.slice(
    record.contract_name.lastIndexOf("@") + 1,
  );
  if (
    !/^[+-]?\d+$/.test(version) ||
    BigInt(version) !== BigInt(record.schema_version)
  )
    fail("schema_version_mismatch");
  const data =
    asObject(envelope.data) ??
    fail(envelope.data === undefined ? "invalid_envelope" : "invalid_data");
  let hash = "";
  try {
    hash = canonicalPayloadSha256(data);
  } catch {
    fail("invalid_payload");
  }
  if (hash !== record.payload_hash)
    fail("payload_hash_mismatch", "identity_conflict");
  if (containsProhibitedField(data)) fail("prohibited_field", "privacy");
  if (category === "event")
    try {
      validateRegisteredContract(record.contract_name, data);
    } catch {
      fail("contract_invalid");
    }
  if (
    category === "manifest" &&
    (record.contract_name !== "source.manifest@1" ||
      record.schema_version !== 1)
  )
    fail("contract_invalid");
  const occurred_at =
      normalizedTime(envelope.time) ?? fail("invalid_event_time"),
    origin = text("source");
  let payload: Record<string, unknown>;
  if (category === "event") {
    const subject = text("subject");
    let index = subject.indexOf(":");
    if (index < 0) index = subject.indexOf("/");
    if (index <= 0 || index === subject.length - 1) fail("invalid_subject");
    payload = {
      event_type: record.contract_name,
      subject_type: subject.slice(0, index),
      subject_id: subject.slice(index + 1),
      attributes: data,
    };
  } else if (category === "observation") {
    const raw = data.numeric_value;
    const numeric_value =
      raw instanceof SerdeFloat
        ? raw.value
        : typeof raw === "number" || typeof raw === "bigint"
          ? Number(raw)
          : NaN;
    if (!Number.isFinite(numeric_value)) fail("invalid_numeric_value");
    payload = {
      provider: requiredText(data, "provider"),
      provider_account_ref: optionalText(data, "provider_account_ref"),
      connection_ref: optionalText(data, "connection_ref"),
      metric_key: requiredText(data, "metric_key"),
      numeric_value,
      unit: requiredText(data, "unit"),
      reporting_window_start: requiredTime(data, "reporting_window_start"),
      reporting_window_end: requiredTime(data, "reporting_window_end"),
      observed_at: requiredTime(data, "observed_at"),
      synchronization_run_id: requiredText(data, "synchronization_run_id"),
      dimensions:
        asObject(data.dimensions) ?? fail("invalid_observation_object"),
      source_evidence:
        asObject(data.source_evidence) ?? fail("invalid_observation_object"),
    };
    if (!isMetric(payload.metric_key as string)) fail("invalid_metric_key");
    if (
      timestampNanos(payload.reporting_window_end as string) <=
      timestampNanos(payload.reporting_window_start as string)
    )
      fail("invalid_observation_window");
  } else if (category === "scope_definition") {
    const source_version = asI64(data.source_version);
    if (source_version === null || source_version <= 0n)
      fail("invalid_scope_version");
    payload = {
      parent_scope_external_id: optionalText(data, "parent_scope_external_id"),
      reporting_timezone: requiredText(data, "reporting_timezone"),
      status: requiredText(data, "status"),
      source_version,
    };
    if (
      optionalText(data, "scope_kind") !== record.scope_kind ||
      optionalText(data, "scope_external_id") !== record.scope_external_id
    )
      fail("scope_definition_identity_mismatch", "identity_conflict");
  } else {
    const manifest_key = requiredText(data, "manifest_key"),
      manifest_version = positive(data, "manifest_version"),
      provider = optionalText(data, "provider") ?? "",
      connection_ref = optionalText(data, "connection_ref") ?? "";
    const approved_checkpoint_hash = optionalText(
      data,
      "approved_checkpoint_hash",
    );
    if (approved_checkpoint_hash !== null)
      try {
        validateSha256Hex(approved_checkpoint_hash);
      } catch {
        fail("invalid_manifest_checkpoint_hash");
      }
    const safe_failure_code = optionalText(data, "safe_failure_code");
    if (
      safe_failure_code !== null &&
      (Buffer.byteLength(safe_failure_code) > 128 ||
        !/^[a-z][a-z0-9_.-]*$/.test(safe_failure_code))
    )
      fail("invalid_manifest_failure_code");
    const manifest_state = requiredText(data, "manifest_state");
    if (
      ![
        "active",
        "disabled",
        "unsupported",
        "awaiting_instrumentation",
      ].includes(manifest_state)
    )
      fail("invalid_manifest_state");
    payload = {
      manifest_key,
      manifest_version,
      provider,
      connection_ref,
      supported_contracts: identifiers(data, "supported_contracts", true),
      supported_observation_contracts: identifiers(
        data,
        "supported_observation_contracts",
        true,
      ),
      supported_metrics: identifiers(data, "supported_metrics", false),
      supported_dimensions: identifiers(data, "supported_dimensions", false),
      expected_refresh_seconds: positive(data, "expected_refresh_seconds"),
      reliable_coverage_start: optionalTime(data, "reliable_coverage_start"),
      highest_authoritative_source_sequence: nonnegative(
        data,
        "highest_authoritative_source_sequence",
      ),
      approved_checkpoint_count: nonnegative(data, "approved_checkpoint_count"),
      approved_checkpoint_hash,
      last_successful_collection_at: optionalTime(
        data,
        "last_successful_collection_at",
      ),
      last_attempted_collection_at: optionalTime(
        data,
        "last_attempted_collection_at",
      ),
      safe_failure_code,
      next_expected_at: optionalTime(data, "next_expected_at"),
      manifest_state,
    };
    if (
      record.record_id !==
        `manifest:${record.source_stream_key}:${manifest_key}:${manifest_version}` ||
      Buffer.byteLength(manifest_key) > 512 ||
      Buffer.byteLength(provider) > 128 ||
      Buffer.byteLength(connection_ref) > 512
    )
      fail("manifest_identity_mismatch", "identity_conflict");
    if (
      timestampNanos(requiredTime(data, "generated_at")) !==
      timestampNanos(occurred_at)
    )
      fail("manifest_time_mismatch", "identity_conflict");
  }
  return {
    payload,
    occurred_at,
    origin,
    correlation_id: optionalText(envelope, "correlation_id"),
    causation_id: optionalText(envelope, "causation_id"),
    idempotency_key: optionalText(envelope, "idempotency_key"),
  };
}
export async function resolveScope(
  tx: PoolClient,
  _authenticated: AuthenticatedProducer,
  scopeKind: string,
  externalId: string,
): Promise<{ binding: ScopeBinding }> {
  let row;
  try {
    row = (await tx.query(SQL.resolve_scope, [scopeKind, externalId])).rows[0];
  } catch {
    fail("analytics_unavailable", "retryable");
  }
  if (!row) fail("scope_not_ready", "retryable");
  if (row.status === "deleted") fail("scope_unavailable");
  return {
    binding: {
      reporting_scope_id: BigInt(row.scope_id),
      root_scope_id: BigInt(row.root_scope_id),
    },
  };
}
export interface GapRange {
  start: bigint;
  end: bigint;
}
export function advanceCursor(
  received: bigint,
  _contiguous: bigint,
  ranges: GapRange[],
  sequence: bigint,
): [bigint, bigint, GapRange[]] {
  if (sequence > received) {
    if (sequence > received + 1n)
      ranges = [...ranges, { start: received + 1n, end: sequence - 1n }];
    received = sequence;
  }
  const reduced: GapRange[] = [];
  for (const range of ranges) {
    if (sequence < range.start || sequence > range.end) {
      reduced.push(range);
      continue;
    }
    if (range.start < sequence)
      reduced.push({ start: range.start, end: sequence - 1n });
    if (sequence < range.end)
      reduced.push({ start: sequence + 1n, end: range.end });
  }
  reduced.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: GapRange[] = [];
  for (const range of reduced) {
    if (range.start > range.end) continue;
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1n) {
      if (range.end > last.end) last.end = range.end;
    } else merged.push({ ...range });
  }
  return [received, merged[0] ? merged[0].start - 1n : received, merged];
}
async function updateCursor(
  tx: PoolClient,
  a: AuthenticatedProducer,
  r: IngestionRecord,
): Promise<void> {
  await tx.query(SQL.update_cursor, [
    r.producer_id,
    a.source_service,
    recordSourceDomain(r),
    r.source_stream_key,
  ]);
  const row = (
    await tx.query(SQL.update_cursor_2, [r.producer_id, r.source_stream_key])
  ).rows[0]!;
  let ranges: GapRange[] = [];
  try {
    if (!Array.isArray(row.known_gap_ranges)) throw Error();
    ranges = row.known_gap_ranges.map((v: unknown) => {
      const obj = asObject(v);
      const start = asI64(obj?.start),
        end = asI64(obj?.end);
      if (start === null || end === null) throw Error();
      return { start, end };
    });
  } catch {}
  const [received, contiguous, gaps] = advanceCursor(
    BigInt(row.highest_received_sequence),
    BigInt(row.highest_contiguous_sequence),
    ranges,
    r.source_sequence,
  );
  await tx.query(SQL.update_cursor_3, [
    r.producer_id,
    r.source_stream_key,
    received,
    contiguous,
    canonicalJson(gaps),
  ]);
}
async function applyScopeDefinition(
  tx: PoolClient,
  a: AuthenticatedProducer,
  r: IngestionRecord,
  p: Record<string, unknown>,
): Promise<void> {
  try {
    const kind = (await tx.query(SQL.apply_scope_definition, [r.scope_kind]))
      .rows[0];
    if (!kind) fail("scope_kind_unknown");
    if (!kind.active || kind.owner_source_service !== a.source_service)
      fail("scope_owner_not_authorized");
    let parent: bigint | null = null;
    if (kind.parent_scope_kind == null && p.parent_scope_external_id == null) {
    } else if (
      kind.parent_scope_kind != null &&
      p.parent_scope_external_id != null
    ) {
      const row = (
        await tx.query(SQL.apply_scope_definition_2, [
          kind.owner_source_service,
          kind.parent_scope_kind,
          p.parent_scope_external_id,
        ])
      ).rows[0];
      if (!row) fail("scope_not_ready", "retryable");
      parent = BigInt(row.scope_id);
    } else fail("scope_parent_invalid");
    const existing = (
      await tx.query(SQL.apply_scope_definition_3, [
        kind.owner_source_service,
        r.scope_kind,
        r.scope_external_id,
      ])
    ).rows[0];
    if (existing) {
      const current =
        existing.parent_scope_id == null
          ? null
          : BigInt(existing.parent_scope_id);
      if (current !== parent) fail("scope_reparent_required");
      if ((p.source_version as bigint) > BigInt(existing.source_version))
        await tx.query(SQL.apply_scope_definition_4, [
          p.status,
          p.reporting_timezone,
          p.source_version,
          existing.scope_id,
        ]);
    } else
      await tx.query(SQL.apply_scope_definition_5, [
        r.scope_kind,
        kind.owner_source_service,
        r.scope_external_id,
        parent,
        p.status,
        p.reporting_timezone,
        p.source_version,
      ]);
    await tx.query(SQL.apply_scope_definition_6, [
      r.producer_id,
      a.source_service,
      recordSourceDomain(r),
      r.source_stream_key,
      r.source_sequence,
      r.record_id,
      r.contract_name,
      r.schema_version,
      r.scope_kind,
      r.scope_external_id,
      p.source_version,
      r.payload_hash,
    ]);
  } catch (error) {
    if (error instanceof ValidationFailure) throw error;
    fail("analytics_unavailable", "retryable");
  }
}
export function parseRepairContext(
  request: Pick<FastifyRequest, "headers">,
): RepairContext | null {
  const read = (key: string) =>
    typeof request.headers[key] === "string"
      ? (request.headers[key] as string).trim() || null
      : null;
  const raw = read("x-analytics-repair-failure-id"),
    version = read("x-analytics-repair-transform-version");
  if (raw === null && version === null) return null;
  if (raw === null || version === null)
    return fail("incomplete_repair_context");
  if (
    !/^[+]?\d+$/.test(raw) ||
    BigInt(raw) <= 0n ||
    BigInt(raw) > (1n << 63n) - 1n
  )
    fail("invalid_repair_failure_id");
  if (Buffer.byteLength(version) > 128 || !/^[a-zA-Z0-9._-]+$/.test(version))
    fail("invalid_repair_transform_version");
  return { failure_id: BigInt(raw), transform_version: version };
}
async function validateRepairContext(
  tx: PoolClient,
  a: AuthenticatedProducer,
  r: IngestionRecord,
  repair: RepairContext,
): Promise<void> {
  let authorized;
  try {
    authorized = (
      await tx.query(SQL.validate_repair_context, [
        repair.failure_id,
        a.producer_id,
        a.source_service,
        recordSourceDomain(r),
        r.source_stream_key,
        r.source_sequence,
        r.record_category,
        r.record_id,
      ])
    ).rows[0]?.exists;
  } catch {
    fail("analytics_unavailable");
  }
  if (!authorized) fail("repair_not_authorized");
}
async function releaseQuarantine(
  tx: PoolClient,
  a: AuthenticatedProducer,
  r: IngestionRecord,
  repair: RepairContext,
): Promise<void> {
  const updated = await tx.query(SQL.release_quarantine, [
    repair.failure_id,
    repair.transform_version,
    a.producer_id,
    a.source_service,
    r.source_stream_key,
    r.source_sequence,
    r.record_category,
    r.record_id,
  ]);
  if (updated.rowCount !== 1)
    throw Error("quarantine release identity changed");
  const work = await tx.query(SQL.release_quarantine_2, [
    repair.failure_id,
    repair.transform_version,
    a.producer_id,
  ]);
  if (work.rowCount !== 1) throw Error("quarantine release work lease changed");
}
const bounded = (v: string, length: number) =>
  v.trim() !== "" && Buffer.byteLength(v) <= length;
async function recordFailure(
  tx: PoolClient,
  r: IngestionRecord,
  a: AuthenticatedProducer,
  failure: ValidationFailure,
  binding: ScopeBinding | null,
  override: string | null = null,
): Promise<void> {
  const fallback = `invalid:${createHash("sha256").update(serializeRecord(r)).digest("hex")}`,
    domain =
      override !== null && bounded(override, 256)
        ? override
        : bounded(recordSourceDomain(r), 256)
          ? recordSourceDomain(r)
          : "unknown",
    stream = bounded(r.source_stream_key, 512) ? r.source_stream_key : fallback,
    id = bounded(r.record_id, 512) ? r.record_id : fallback;
  const hash = /^[a-f0-9]{64}$/.test(r.payload_hash) ? r.payload_hash : null;
  const updated = await tx.query(SQL.record_failure_with_source_domain, [
    r.producer_id,
    r.record_category,
    id,
    hash,
    failure.code,
  ]);
  if ((updated.rowCount ?? 0) > 0) return;
  await tx.query(SQL.record_failure_with_source_domain_2, [
    r.producer_id,
    a.source_service,
    domain,
    stream,
    r.source_sequence >= 0n ? r.source_sequence : null,
    r.record_category,
    id,
    binding?.reporting_scope_id ?? null,
    binding?.root_scope_id ?? null,
    r.schema_version > 0 ? r.schema_version : null,
    hash,
    failure.class_,
    failure.code,
  ]);
}
async function validateBackfillJob(
  tx: PoolClient,
  job: string,
  a: AuthenticatedProducer,
  sourceDomain: string,
): Promise<string> {
  let row;
  try {
    row = (await tx.query(SQL.validate_backfill_job, [job])).rows[0];
  } catch {
    fail("analytics_unavailable", "retryable");
  }
  if (
    !row ||
    row.source_service !== a.source_service ||
    row.source_domain !== sourceDomain ||
    row.job_status !== "running"
  )
    fail("backfill_not_authorized");
  return row.source_domain;
}
async function updateBackfillCount(
  tx: PoolClient,
  a: AuthenticatedProducer,
  job: string,
  r: IngestionRecord,
  accepted: boolean,
): Promise<void> {
  const receipt = await tx.query(SQL.record_backfill_outcome, [
    job,
    a.producer_id,
    recordSourceDomain(r),
    r.source_stream_key,
    r.source_sequence,
    r.record_category,
    r.record_id,
    accepted ? "accepted" : "rejected",
    a.source_service,
  ]);
  if (!receipt.rowCount) return;
  const column = accepted ? "accepted_count" : "rejected_count";
  const row = (
    await tx.query(SQL.update_backfill_count.replaceAll("{column}", column), [
      job,
    ])
  ).rows[0];
  if (!row) throw Error("backfill missing");
  if (
    row.job_status === "completed" &&
    ["source_reconstruction", "provider_history_import"].includes(row.method)
  ) {
    const rejected = BigInt(row.rejected_count);
    await tx.query(SQL.insert_backfill_coverage_checkpoint, [
      a.producer_id,
      a.source_service,
      row.source_domain,
      row.reporting_scope_id,
      row.root_scope_id,
      row.requested_range_start instanceof Date
        ? row.requested_range_start.toISOString()
        : row.requested_range_start,
      row.requested_range_end instanceof Date
        ? row.requested_range_end.toISOString()
        : row.requested_range_end,
      row.scanned_count,
      row.accepted_count,
      rejected,
      rejected === 0n ? "available" : "partial",
      rejected === 0n
        ? row.requested_range_end instanceof Date
          ? row.requested_range_end.toISOString()
          : row.requested_range_end
        : null,
      job,
      row.completed_at instanceof Date
        ? row.completed_at.toISOString()
        : (row.completed_at ?? new Date().toISOString()),
    ]);
  }
}
async function rejectedOutcome(
  tx: PoolClient,
  r: IngestionRecord,
  a: AuthenticatedProducer,
  failure: ValidationFailure,
  binding: ScopeBinding | null,
  job: string | null,
  override: string | null = null,
): Promise<void> {
  await recordFailure(tx, r, a, failure, binding, override);
  if (job !== null && failure.class_ !== "retryable")
    await updateBackfillCount(tx, a, job, r, false);
}
async function authorizedRejection(
  tx: PoolClient,
  r: IngestionRecord,
  a: AuthenticatedProducer,
  failure: ValidationFailure,
  binding: ScopeBinding | null,
  job: string | null,
): Promise<string> {
  let domain: null | string = null;
  if (job !== null) {
    try {
      domain = await validateBackfillJob(tx, job, a, recordSourceDomain(r));
    } catch (error) {
      if (!(error instanceof ValidationFailure)) throw error;
      await recordFailure(tx, r, a, error, binding);
      return error.code;
    }
  }
  await rejectedOutcome(tx, r, a, failure, binding, job, domain);
  return failure.code;
}
/** serde serializes this DTO in declaration order; the envelope Value itself sorts keys. */
function serializeRecord(r: IngestionRecord): string {
  return (
    "{" +
    Object.entries({
      producer_id: r.producer_id,
      source_stream_key: r.source_stream_key,
      source_sequence: r.source_sequence,
      record_category: r.record_category,
      record_id: r.record_id,
      contract_name: r.contract_name,
      schema_version: r.schema_version,
      scope_kind: r.scope_kind,
      scope_external_id: r.scope_external_id,
      payload_hash: r.payload_hash,
      envelope: r.envelope,
    })
      .map(([key, value]) => JSON.stringify(key) + ":" + canonicalJson(value))
      .join(",") +
    "}"
  );
}
function manifestAvailability(p: Record<string, unknown>): string {
  if (p.manifest_state === "disabled") return "unavailable";
  if (p.manifest_state === "unsupported") return "unsupported";
  if (p.manifest_state === "awaiting_instrumentation")
    return "not_instrumented";
  if (p.manifest_state === "active") {
    if (p.safe_failure_code != null)
      return p.last_successful_collection_at != null ? "stale" : "unavailable";
    return p.approved_checkpoint_count != null
      ? "available"
      : "not_instrumented";
  }
  return "unavailable";
}
async function insertManifest(
  tx: PoolClient,
  r: IngestionRecord,
  a: AuthenticatedProducer,
  v: ValidatedRecord,
  b: ScopeBinding,
): Promise<void> {
  const p = v.payload;
  const row = (
    await tx.query(SQL.ingest_record, [
      r.producer_id,
      a.source_service,
      recordSourceDomain(r),
      r.source_stream_key,
      p.manifest_key,
      p.manifest_version,
      b.reporting_scope_id,
      b.root_scope_id,
      ...[
        "provider",
        "connection_ref",
        "supported_contracts",
        "supported_observation_contracts",
        "supported_metrics",
        "supported_dimensions",
        "expected_refresh_seconds",
        "reliable_coverage_start",
        "highest_authoritative_source_sequence",
        "approved_checkpoint_count",
        "approved_checkpoint_hash",
        "last_successful_collection_at",
        "last_attempted_collection_at",
        "safe_failure_code",
        "next_expected_at",
        "manifest_state",
      ].map((key) => p[key]),
      r.payload_hash,
      v.occurred_at,
    ])
  ).rows[0]!;
  for (const metric of p.supported_metrics as string[])
    await tx.query(SQL.update_manifest_source_state, [
      r.producer_id,
      a.source_service,
      recordSourceDomain(r),
      r.source_stream_key,
      b.reporting_scope_id,
      b.root_scope_id,
      p.provider,
      p.connection_ref,
      metric,
      manifestAvailability(p),
      p.reliable_coverage_start,
      p.last_successful_collection_at,
      p.expected_refresh_seconds,
      p.next_expected_at,
      p.safe_failure_code,
      r.source_sequence,
      row.manifest_id,
    ]);
  const start = (p.last_successful_collection_at ?? v.occurred_at) as string;
  const end =
    typeof p.next_expected_at === "string" &&
    timestampNanos(p.next_expected_at) > timestampNanos(start)
      ? p.next_expected_at
      : addSeconds(start, p.expected_refresh_seconds as bigint);
  const coverage = ["disabled", "unsupported"].includes(
    p.manifest_state as string,
  )
    ? "unavailable"
    : p.safe_failure_code != null
      ? p.last_successful_collection_at != null
        ? "stale"
        : "unavailable"
      : p.manifest_state === "active" && p.approved_checkpoint_count != null
        ? "available"
        : "unknown";
  await tx.query(SQL.insert_source_manifest_coverage_checkpoint, [
    r.producer_id,
    a.source_service,
    recordSourceDomain(r),
    b.reporting_scope_id,
    b.root_scope_id,
    "source",
    start,
    end,
    p.approved_checkpoint_count,
    p.approved_checkpoint_count ?? 0n,
    coverage,
    row.manifest_id,
    v.occurred_at,
  ]);
}
async function insertFact(
  tx: PoolClient,
  r: IngestionRecord,
  a: AuthenticatedProducer,
  v: ValidatedRecord,
  b: ScopeBinding,
  backfilled: boolean,
): Promise<void> {
  const p = v.payload;
  let row;
  if (r.record_category === "event") {
    row = (
      await tx.query(SQL.ingest_record_2, [
        r.producer_id,
        a.source_service,
        recordSourceDomain(r),
        r.source_stream_key,
        r.source_sequence,
        r.record_id,
        p.event_type,
        r.schema_version,
        b.reporting_scope_id,
        b.root_scope_id,
        p.subject_type,
        p.subject_id,
        v.occurred_at,
        v.origin,
        v.correlation_id,
        v.causation_id,
        v.idempotency_key,
        canonicalJson(p.attributes),
        r.payload_hash,
        backfilled,
      ])
    ).rows[0]!;
  } else {
    row = (
      await tx.query(SQL.ingest_record_3, [
        r.producer_id,
        a.source_service,
        recordSourceDomain(r),
        r.source_stream_key,
        r.source_sequence,
        r.record_id,
        r.schema_version,
        b.reporting_scope_id,
        b.root_scope_id,
        ...[
          "provider",
          "provider_account_ref",
          "connection_ref",
          "metric_key",
          "numeric_value",
          "unit",
          "reporting_window_start",
          "reporting_window_end",
          "observed_at",
          "synchronization_run_id",
        ].map((key) => p[key]),
        canonicalJson(p.dimensions),
        canonicalJson(p.source_evidence),
        r.payload_hash,
        backfilled,
      ])
    ).rows[0]!;
    await tx.query(SQL.update_observation_state, [
      r.producer_id,
      a.source_service,
      recordSourceDomain(r),
      r.source_stream_key,
      b.reporting_scope_id,
      b.root_scope_id,
      p.provider,
      p.connection_ref ?? "",
      p.metric_key,
      p.observed_at,
      r.source_sequence,
    ]);
  }
  const window =
    r.record_category === "event"
      ? hourlyWindow(new Date(v.occurred_at))
      : [
          new PreciseDate(p.reporting_window_start as string),
          new PreciseDate(p.reporting_window_end as string),
        ];
  await enqueueFact(tx, {
    fact_kind: r.record_category as "event" | "observation",
    ...b,
    source_storage_id: BigInt(row.storage_id),
    source_window_start: window[0]!,
    source_window_end: window[1]!,
  });
}
class PreciseDate extends Date {
  constructor(private value: string) {
    super(value);
  }
  override toISOString(): string {
    return this.value;
  }
  override toJSON(): string {
    return this.value;
  }
}
export async function ingestBatch(
  pool: Pool,
  a: AuthenticatedProducer,
  batch: IngestionBatchRequest,
): Promise<IngestionBatchResponse> {
  return ingestBatchWithRepair(pool, a, batch, null);
}
export async function ingestBatchWithRepair(
  pool: Pool,
  a: AuthenticatedProducer,
  batch: IngestionBatchRequest,
  repair: RepairContext | null = null,
): Promise<IngestionBatchResponse> {
  const acknowledgements: IngestionAcknowledgement[] = [];
  for (const r of batch.records)
    acknowledgements.push(
      await ingestRecord(pool, a, batch.backfill_job_id ?? null, repair, r),
    );
  return {
    accepted_count: acknowledgements.filter((a) => a.status === "accepted")
      .length,
    duplicate_count: acknowledgements.filter((a) => a.status === "duplicate")
      .length,
    rejected_count: acknowledgements.filter((a) => a.status === "rejected")
      .length,
    retryable_count: acknowledgements.filter((a) => a.status === "retryable")
      .length,
    acknowledgements,
  };
}
async function ingestRecord(
  pool: Pool,
  a: AuthenticatedProducer,
  job: string | null,
  repair: RepairContext | null,
  r: IngestionRecord,
): Promise<IngestionAcknowledgement> {
  const ack = (
    status: IngestionAcknowledgement["status"],
    code?: string,
  ): IngestionAcknowledgement => ({
    record_id: r.record_id,
    source_sequence: r.source_sequence,
    status,
    ...(code ? { error_code: code } : {}),
  });
  if (r.producer_id !== a.producer_id)
    return ack("rejected", "producer_not_authorized");
  let structural: string | null = null;
  if (
    r.source_sequence <= 0n ||
    !r.source_stream_key.trim() ||
    !r.record_id.trim() ||
    !r.contract_name.trim() ||
    r.schema_version <= 0
  )
    structural = "invalid_record_identity";
  else
    try {
      if (Buffer.byteLength(serializeRecord(r)) > MAX_RECORD_BYTES)
        structural = "record_too_large";
    } catch {
      structural = "record_too_large";
    }
  let v: ValidatedRecord | undefined, failure: ValidationFailure | undefined;
  if (!structural)
    try {
      v = validateRecord(r, a);
    } catch (error) {
      failure =
        error instanceof ValidationFailure
          ? error
          : new ValidationFailure("invalid_payload");
    }
  let tx: PoolClient | undefined,
    committed = false;
  try {
    tx = await pool.connect();
    await tx.query("BEGIN");
    const producer = (await tx.query(SQL.load_producer, [r.producer_id]))
      .rows[0];
    if (!producer) return ack("rejected", "producer_not_registered");
    if (!producer.active || producer.source_service !== a.source_service)
      return ack("rejected", "producer_not_authorized");
    if (!structural && repair !== null) {
      try {
        await validateRepairContext(tx, a, r, repair);
      } catch (error) {
        return ack(
          "rejected",
          error instanceof ValidationFailure
            ? error.code
            : "analytics_unavailable",
        );
      }
    }
    if (structural || failure) {
      const code = await authorizedRejection(
        tx,
        r,
        a,
        failure ?? new ValidationFailure(structural!),
        null,
        job,
      );
      await tx.query("COMMIT");
      committed = true;
      return ack("rejected", code);
    }
    v = v!;
    for (const [list, expected, code] of [
      [
        producer.permitted_record_categories,
        r.record_category,
        "record_category_not_permitted",
      ],
      [
        producer.permitted_scope_kinds,
        r.scope_kind,
        "scope_kind_not_permitted",
      ],
    ] as const) {
      if (!Array.isArray(list) || !list.includes(expected)) {
        const rejection = await authorizedRejection(
          tx,
          r,
          a,
          new ValidationFailure(code),
          null,
          job,
        );
        await tx.query("COMMIT");
        committed = true;
        return ack("rejected", rejection);
      }
    }
    const data = asObject(asObject(r.envelope)?.data);
    const existing = (
      await tx.query(SQL.find_existing_identity, [
        r.producer_id,
        r.source_stream_key,
        r.record_id,
        r.source_sequence,
        r.record_category,
        typeof data?.manifest_key === "string" ? data.manifest_key : null,
        asI64(data?.manifest_version),
      ])
    ).rows[0];
    if (existing) {
      if (
        existing.record_category === r.record_category &&
        existing.record_id === r.record_id &&
        existing.payload_hash === r.payload_hash
      ) {
        if (job !== null) await updateBackfillCount(tx, a, job, r, true);
        if (repair !== null) await releaseQuarantine(tx, a, r, repair);
        await tx.query("COMMIT");
        committed = true;
        return ack("duplicate");
      }
      try {
        await recordFailure(
          tx,
          r,
          a,
          new ValidationFailure("identity_conflict", "identity_conflict"),
          null,
        );
        await tx.query("COMMIT");
        committed = true;
      } catch {}
      return ack("rejected", "identity_conflict");
    }
    if (job !== null) {
      try {
        await validateBackfillJob(tx, job, a, recordSourceDomain(r));
      } catch (error) {
        const f =
          error instanceof ValidationFailure
            ? error
            : new ValidationFailure("analytics_unavailable", "retryable");
        try {
          await recordFailure(tx, r, a, f, null);
          await tx.query("COMMIT");
          committed = true;
        } catch {}
        return ack("rejected", f.code);
      }
    }
    if (r.record_category === "scope_definition") {
      try {
        await applyScopeDefinition(tx, a, r, v.payload);
      } catch (error) {
        if (!(error instanceof ValidationFailure)) throw error;
        await rejectedOutcome(tx, r, a, error, null, job);
        await tx.query("COMMIT");
        committed = true;
        return ack(
          error.class_ === "retryable" ? "retryable" : "rejected",
          error.code,
        );
      }
    } else {
      let binding: ScopeBinding;
      try {
        binding = (await resolveScope(tx, a, r.scope_kind, r.scope_external_id))
          .binding;
      } catch (error) {
        if (!(error instanceof ValidationFailure)) throw error;
        await rejectedOutcome(tx, r, a, error, null, job);
        await tx.query("COMMIT");
        committed = true;
        return ack(
          error.class_ === "retryable" ? "retryable" : "rejected",
          error.code,
        );
      }
      if (r.record_category === "manifest")
        await insertManifest(tx, r, a, v, binding);
      else await insertFact(tx, r, a, v, binding, job !== null);
    }
    if (job === null) await updateCursor(tx, a, r);
    else await updateBackfillCount(tx, a, job, r, true);
    if (repair !== null) await releaseQuarantine(tx, a, r, repair);
    await tx.query("COMMIT");
    committed = true;
    return ack("accepted");
  } catch {
    return ack("retryable", "analytics_unavailable");
  } finally {
    if (tx) {
      if (!committed)
        try {
          await tx.query("ROLLBACK");
        } catch {}
      tx.release();
    }
  }
}
/** Typed serde DTO extraction remains separate from business validation and generic envelope Value. */
export function strictObject(
  value: unknown,
  keys: string[],
): Record<string, unknown> {
  const object = asObject(value);
  if (!object || Object.keys(object).some((key) => !keys.includes(key)))
    throw new RequestExtractionError("json");
  return object;
}
export function dtoString(
  object: Record<string, unknown>,
  key: string,
  optional = false,
): string | null {
  const value = object[key];
  if (optional && value == null) return null;
  if (typeof value !== "string") throw new RequestExtractionError("json");
  return value;
}
export function dtoI64(
  object: Record<string, unknown>,
  key: string,
  optional = false,
): bigint | null {
  if (optional && object[key] == null) return null;
  const value = asI64(object[key]);
  if (value === null) throw new RequestExtractionError("json");
  return value;
}
export function parseIngestionBatch(value: unknown): IngestionBatchRequest {
  const body = strictObject(value, ["records", "backfill_job_id"]);
  if (!Array.isArray(body.records)) throw new RequestExtractionError("json");
  const records = body.records.map((raw) => {
    const r = strictObject(raw, [
      "producer_id",
      "source_stream_key",
      "source_sequence",
      "record_category",
      "record_id",
      "contract_name",
      "schema_version",
      "scope_kind",
      "scope_external_id",
      "payload_hash",
      "envelope",
    ]);
    const category = dtoString(r, "record_category")!;
    if (
      !["event", "observation", "scope_definition", "manifest"].includes(
        category,
      ) ||
      !Object.hasOwn(r, "envelope")
    )
      throw new RequestExtractionError("json");
    const version = dtoI64(r, "schema_version")!;
    if (version < -2147483648n || version > 2147483647n)
      throw new RequestExtractionError("json");
    return {
      producer_id: dtoString(r, "producer_id")!,
      source_stream_key: dtoString(r, "source_stream_key")!,
      source_sequence: dtoI64(r, "source_sequence")!,
      record_category: category as RecordCategory,
      record_id: dtoString(r, "record_id")!,
      contract_name: dtoString(r, "contract_name")!,
      schema_version: Number(version),
      scope_kind: dtoString(r, "scope_kind")!,
      scope_external_id: dtoString(r, "scope_external_id")!,
      payload_hash: dtoString(r, "payload_hash")!,
      envelope: r.envelope,
    };
  });
  return { records, backfill_job_id: dtoString(body, "backfill_job_id", true) };
}
export function registerIngestionRoutes(
  app: FastifyInstance,
  context: AnalyticsContext,
): void {
  const auth = new IngestionAuthenticator(context.config.ingestion_credentials);
  app.post(INGESTION_PATH, async (request, reply) => {
    const batch = parseIngestionBatch(request.body);
    let producer: AuthenticatedProducer;
    try {
      producer = auth.authenticate(request);
    } catch {
      return reply.code(401).header("www-authenticate", "Bearer").send();
    }
    if (!batch.records.length || batch.records.length > MAX_BATCH_RECORDS)
      return reply
        .code(400)
        .send({ error: "invalid_batch_size", max_records: MAX_BATCH_RECORDS });
    let repair: RepairContext | null;
    try {
      repair = parseRepairContext(request);
    } catch (error) {
      return reply.code(400).send({
        error:
          error instanceof ValidationFailure
            ? error.code
            : "invalid_repair_context",
      });
    }
    if (repair && batch.records.length !== 1)
      return reply.code(400).send({ error: "repair_requires_single_record" });
    return ingestBatchWithRepair(context.pool, producer, batch, repair);
  });
}
