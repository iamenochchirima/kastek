import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { ANALYTICS_CONTRACT_KEYS, type AnalyticsContractKey } from "@kasitek-labs/contracts";

export const AGENT_SOURCE_SERVICE = "agent-platform" as const;
export const AGENT_SOURCE_ORIGIN = "kasitek://agent-platform" as const;
export const MAX_OUTBOX_BATCH_SIZE = 500;

export type RecordCategory = "event" | "observation" | "scope_definition";
export type ScopeKind = "core_organization" | "tenant_workspace" | "tenant_client";
export type AgentContractKey = Extract<AnalyticsContractKey, `agent.${string}`>;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface EventInput {
  recordId: string;
  sourceDomain: string;
  sourceStreamKey: string;
  contractName: string;
  schemaVersion: number;
  scopeKind: ScopeKind;
  scopeExternalId: string;
  subject: string;
  occurredAt: Date | string;
  attributes: Record<string, unknown>;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
}

export interface ObservationInput {
  recordId: string;
  sourceDomain: string;
  sourceStreamKey: string;
  contractName: string;
  schemaVersion: number;
  scopeKind: ScopeKind;
  scopeExternalId: string;
  provider: string;
  providerAccountRef?: string;
  connectionRef?: string;
  metricKey: string;
  numericValue: number;
  unit: string;
  reportingWindowStart: Date | string;
  reportingWindowEnd: Date | string;
  observedAt: Date | string;
  synchronizationRunId: string;
  dimensions: Record<string, unknown>;
  sourceEvidence: Record<string, unknown>;
  correlationId?: string;
  idempotencyKey?: string;
}

export interface ScopeDefinitionInput {
  recordId: string;
  sourceDomain: string;
  sourceStreamKey: string;
  contractName: string;
  schemaVersion: number;
  scopeKind: ScopeKind;
  scopeExternalId: string;
  parentScopeExternalId?: string;
  reportingTimezone: string;
  status: string;
  sourceVersion: number;
  idempotencyKey?: string;
}

export interface AnalyticsEnvelope {
  specversion: "1.0";
  id: string;
  source: typeof AGENT_SOURCE_ORIGIN;
  type: string;
  subject: string;
  time: string;
  datacontenttype: "application/json";
  dataschema: string;
  source_service: typeof AGENT_SOURCE_SERVICE;
  source_domain: string;
  record_category: RecordCategory;
  scope_kind: ScopeKind;
  scope_external_id: string;
  correlation_id?: string;
  causation_id?: string;
  idempotency_key: string;
  data: JsonObject;
}

export interface AnalyticsOutboxRecord {
  outboxId: string;
  sourceService: typeof AGENT_SOURCE_SERVICE;
  sourceDomain: string;
  sourceStreamKey: string;
  recordCategory: RecordCategory;
  recordId: string;
  contractName: string;
  schemaVersion: number;
  scopeKind: ScopeKind;
  scopeExternalId: string;
  idempotencyKey: string;
  envelope: AnalyticsEnvelope;
  payloadHash: string;
}

export type EnqueueResult =
  | { kind: "inserted"; outboxId: string; sourceSequence: string }
  | { kind: "duplicate"; outboxId: string }
  | { kind: "conflict"; outboxId: string };

export class AnalyticsProducerValidationError extends Error {
  public constructor(
    public readonly code:
      | "empty_field"
      | "invalid_contract"
      | "invalid_schema_version"
      | "invalid_scope_kind"
      | "invalid_time"
      | "invalid_json"
      | "invalid_numeric_value"
      | "invalid_observation_window"
      | "prohibited_field"
      | "identity_too_long",
    message: string,
  ) {
    super(message);
    this.name = "AnalyticsProducerValidationError";
  }
}

export function buildEvent(input: EventInput): AnalyticsOutboxRecord {
  const occurredAt = isoTime(input.occurredAt, "occurredAt");
  const attributes = validatedObject(input.attributes, "attributes");
  validateCommon(input, attributes);
  requireNonEmpty(input.subject, "subject");
  return recordFromEnvelope(input, "event", {
    specversion: "1.0",
    id: randomUUID(),
    source: AGENT_SOURCE_ORIGIN,
    type: input.contractName,
    subject: input.subject,
    time: occurredAt,
    datacontenttype: "application/json",
    dataschema: schemaUri(input.contractName, input.schemaVersion, "event"),
    source_service: AGENT_SOURCE_SERVICE,
    source_domain: input.sourceDomain,
    record_category: "event",
    scope_kind: input.scopeKind,
    scope_external_id: input.scopeExternalId,
    ...optionalReference("correlation_id", input.correlationId),
    ...optionalReference("causation_id", input.causationId),
    idempotency_key: normalizedIdempotencyKey(input.idempotencyKey, input.recordId),
    data: attributes,
  });
}

export function buildObservation(input: ObservationInput): AnalyticsOutboxRecord {
  const reportingWindowStart = isoTime(input.reportingWindowStart, "reportingWindowStart");
  const reportingWindowEnd = isoTime(input.reportingWindowEnd, "reportingWindowEnd");
  const observedAt = isoTime(input.observedAt, "observedAt");
  const start = Date.parse(reportingWindowStart);
  const end = Date.parse(reportingWindowEnd);
  if (end <= start) {
    throw new AnalyticsProducerValidationError(
      "invalid_observation_window",
      "reportingWindowEnd must be after reportingWindowStart",
    );
  }
  if (!Number.isFinite(input.numericValue)) {
    throw new AnalyticsProducerValidationError("invalid_numeric_value", "numericValue must be finite");
  }
  const dimensions = validatedObject(input.dimensions, "dimensions");
  const sourceEvidence = validatedObject(input.sourceEvidence, "sourceEvidence");
  validateCommon(input, dimensions);
  rejectProhibitedFields(sourceEvidence);
  requireNonEmpty(input.provider, "provider");
  requireNonEmpty(input.metricKey, "metricKey");
  requireNonEmpty(input.unit, "unit");
  requireNonEmpty(input.synchronizationRunId, "synchronizationRunId");

  const data: JsonObject = {
    provider: input.provider,
    metric_key: input.metricKey,
    numeric_value: input.numericValue,
    unit: input.unit,
    reporting_window_start: reportingWindowStart,
    reporting_window_end: reportingWindowEnd,
    observed_at: observedAt,
    synchronization_run_id: input.synchronizationRunId,
    dimensions,
    source_evidence: sourceEvidence,
  };
  if (input.providerAccountRef !== undefined) data.provider_account_ref = input.providerAccountRef;
  if (input.connectionRef !== undefined) data.connection_ref = input.connectionRef;

  return recordFromEnvelope(input, "observation", {
    specversion: "1.0",
    id: randomUUID(),
    source: AGENT_SOURCE_ORIGIN,
    type: input.contractName,
    subject: `metric:${input.metricKey}`,
    time: observedAt,
    datacontenttype: "application/json",
    dataschema: schemaUri(input.contractName, input.schemaVersion, "observation"),
    source_service: AGENT_SOURCE_SERVICE,
    source_domain: input.sourceDomain,
    record_category: "observation",
    scope_kind: input.scopeKind,
    scope_external_id: input.scopeExternalId,
    ...optionalReference("correlation_id", input.correlationId),
    idempotency_key: normalizedIdempotencyKey(input.idempotencyKey, input.recordId),
    data,
  });
}

export function buildScopeDefinition(input: ScopeDefinitionInput): AnalyticsOutboxRecord {
  const data: JsonObject = {
    scope_kind: input.scopeKind,
    scope_external_id: input.scopeExternalId,
    reporting_timezone: input.reportingTimezone,
    status: input.status,
    source_version: input.sourceVersion,
  };
  if (input.parentScopeExternalId !== undefined) data.parent_scope_external_id = input.parentScopeExternalId;
  validateCommon(input, data);
  requireNonEmpty(input.reportingTimezone, "reportingTimezone");
  requireNonEmpty(input.status, "status");
  if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion <= 0) {
    throw new AnalyticsProducerValidationError("invalid_schema_version", "sourceVersion must be positive");
  }

  return recordFromEnvelope(input, "scope_definition", {
    specversion: "1.0",
    id: randomUUID(),
    source: AGENT_SOURCE_ORIGIN,
    type: input.contractName,
    subject: `scope:${input.scopeExternalId}`,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    dataschema: schemaUri(input.contractName, input.schemaVersion, "scope_definition"),
    source_service: AGENT_SOURCE_SERVICE,
    source_domain: input.sourceDomain,
    record_category: "scope_definition",
    scope_kind: input.scopeKind,
    scope_external_id: input.scopeExternalId,
    idempotency_key: normalizedIdempotencyKey(input.idempotencyKey, input.recordId),
    data,
  });
}

function recordFromEnvelope(
  input: { recordId: string; sourceDomain: string; sourceStreamKey: string; schemaVersion: number; scopeKind: ScopeKind; scopeExternalId: string; idempotencyKey?: string },
  category: RecordCategory,
  envelope: AnalyticsEnvelope,
): AnalyticsOutboxRecord {
  const outboxId = `${AGENT_SOURCE_SERVICE}:${category}:${input.recordId}`;
  if (outboxId.length > 512) {
    throw new AnalyticsProducerValidationError("identity_too_long", "outbox identity exceeds 512 characters");
  }
  return {
    outboxId,
    sourceService: AGENT_SOURCE_SERVICE,
    sourceDomain: input.sourceDomain,
    sourceStreamKey: input.sourceStreamKey,
    recordCategory: category,
    recordId: input.recordId,
    contractName: envelope.type,
    schemaVersion: input.schemaVersion,
    scopeKind: input.scopeKind,
    scopeExternalId: input.scopeExternalId,
    idempotencyKey: envelope.idempotency_key,
    envelope,
    payloadHash: canonicalJsonSha256(envelope.data),
  };
}

function validateCommon(
  input: { recordId: string; sourceDomain: string; sourceStreamKey: string; contractName: string; schemaVersion: number; scopeKind: ScopeKind; scopeExternalId: string; idempotencyKey?: string },
  payload: JsonObject,
): void {
  requireNonEmpty(input.recordId, "recordId");
  requireNonEmpty(input.sourceDomain, "sourceDomain");
  requireNonEmpty(input.sourceStreamKey, "sourceStreamKey");
  requireNonEmpty(input.scopeExternalId, "scopeExternalId");
  if (!isScopeKind(input.scopeKind)) {
    throw new AnalyticsProducerValidationError("invalid_scope_kind", `Unsupported scope kind ${String(input.scopeKind)}`);
  }
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion <= 0) {
    throw new AnalyticsProducerValidationError("invalid_schema_version", "schemaVersion must be positive");
  }
  if (!/^[a-z][a-z0-9_.-]+@[0-9]+$/.test(input.contractName)) {
    throw new AnalyticsProducerValidationError("invalid_contract", "contractName must be a versioned lowercase contract");
  }
  if (input.idempotencyKey !== undefined) requireNonEmpty(input.idempotencyKey, "idempotencyKey");
  for (const [value, field, max] of [
    [input.recordId, "recordId", 512],
    [input.sourceDomain, "sourceDomain", 256],
    [input.sourceStreamKey, "sourceStreamKey", 512],
    [input.scopeExternalId, "scopeExternalId", 512],
  ] as const) {
    if (value.length > max) {
      throw new AnalyticsProducerValidationError("identity_too_long", `${field} exceeds ${max} characters`);
    }
  }
  rejectProhibitedFields(payload);
}

function validatedObject(value: unknown, field: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new AnalyticsProducerValidationError("invalid_json", `${field} must be a JSON object`);
  }
  return value;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.entries(value).every(([key, child]) => key.length > 0 && isJsonValue(child));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function rejectProhibitedFields(value: JsonValue): void {
  const prohibited = new Set([
    "body",
    "content",
    "credential",
    "email",
    "error_message",
    "password",
    "phone",
    "phone_number",
    "prompt",
    "raw_payload",
    "response",
    "secret",
    "token",
  ]);
  const stack: JsonValue[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || current === null || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (prohibited.has(key.toLowerCase())) {
        throw new AnalyticsProducerValidationError("prohibited_field", `Analytics payload contains prohibited field ${key}`);
      }
      stack.push(child);
    }
  }
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AnalyticsProducerValidationError("empty_field", `${field} must not be empty`);
  }
}

function normalizedIdempotencyKey(value: string | undefined, fallback: string): string {
  const result = value ?? fallback;
  requireNonEmpty(result, "idempotencyKey");
  if (result.length > 512) {
    throw new AnalyticsProducerValidationError("identity_too_long", "idempotencyKey exceeds 512 characters");
  }
  return result;
}

function optionalReference(key: "correlation_id" | "causation_id", value: string | undefined): Partial<AnalyticsEnvelope> {
  if (value === undefined) return {};
  requireNonEmpty(value, key);
  return { [key]: value };
}

function isoTime(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AnalyticsProducerValidationError("invalid_time", `${field} must be a valid date-time`);
  }
  return date.toISOString();
}

function isScopeKind(value: ScopeKind): value is ScopeKind {
  return ["core_organization", "tenant_workspace", "tenant_client"].includes(value);
}

function schemaUri(contractName: string, schemaVersion: number, category: RecordCategory): string {
  const name = contractName.slice(0, contractName.lastIndexOf("@"));
  const parts = name.split(".");
  const domain = parts.shift() ?? name;
  const resource = (parts.join("_") || domain).replace(/[^a-z0-9_-]/g, "_");
  const directory = category === "event" ? "events" : category === "observation" ? "observations" : "scope_definitions";
  return `https://kasitek.co.za/analytics/contracts/${directory}/${domain}/${resource}/v${schemaVersion}.schema.json`;
}

export function canonicalJsonSha256(value: JsonValue): string {
  const canonical = canonicalize(value);
  const digest = createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
  return digest;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const result: JsonObject = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]!);
  return result;
}

export async function enqueueOutbox(client: PoolClient, record: AnalyticsOutboxRecord): Promise<EnqueueResult> {
  const inserted = await client.query<{ outbox_id: string; source_sequence: string }>(
    `INSERT INTO analytics_outbox
      (outbox_id, source_service, source_domain, source_stream_key, record_category,
       record_id, contract_name, schema_version, scope_kind, scope_external_id,
       idempotency_key, envelope, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
     ON CONFLICT (source_service, record_category, record_id) DO NOTHING
     RETURNING outbox_id, source_sequence`,
    [
      record.outboxId,
      record.sourceService,
      record.sourceDomain,
      record.sourceStreamKey,
      record.recordCategory,
      record.recordId,
      record.contractName,
      record.schemaVersion,
      record.scopeKind,
      record.scopeExternalId,
      record.idempotencyKey,
      JSON.stringify(record.envelope),
      record.payloadHash,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { kind: "inserted", outboxId: created.outbox_id, sourceSequence: created.source_sequence };

  const existing = await client.query<{ outbox_id: string; payload_hash: string }>(
    `SELECT outbox_id, payload_hash
     FROM analytics_outbox
     WHERE source_service = $1 AND record_category = $2 AND record_id = $3`,
    [record.sourceService, record.recordCategory, record.recordId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("Analytics outbox duplicate disappeared before it could be read");
  return row.payload_hash === record.payloadHash
    ? { kind: "duplicate", outboxId: row.outbox_id }
    : { kind: "conflict", outboxId: row.outbox_id };
}

export function isRegisteredAgentContract(contractName: string): contractName is AgentContractKey {
  return (ANALYTICS_CONTRACT_KEYS as readonly string[]).includes(contractName) && contractName.startsWith("agent.");
}

export function schemaUriForTesting(contractName: string, schemaVersion: number, category: RecordCategory): string {
  return schemaUri(contractName, schemaVersion, category);
}
