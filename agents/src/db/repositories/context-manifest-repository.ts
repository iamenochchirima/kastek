import type { Pool } from "pg";
import { query, withTransaction } from "../pool";

export type ContextManifestFitDecision = "ready" | "compact" | "prune" | "limited" | "cannot_fit";
export type ContextManifestStatus = "fits" | "compacted" | "rejected";
export type ContextManifestComponentKind = "system" | "history" | "current_message" | "tool_results" | "tool_schemas";

export interface ContextManifestComponentAccounting {
  readonly kind: ContextManifestComponentKind;
  readonly selectedCount: number;
  readonly estimatedTokens: number;
  readonly estimatedBytes: number;
}

export interface ContextManifestRecordInput {
  readonly requestManifestId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly modelAttemptId?: string;
  readonly providerRequestId?: string;
  readonly schemaVersion?: "v1";
  readonly compactionGeneration?: number;
  readonly sourceBoundaryDigest: string;
  readonly sourceDigest: string;
  readonly manifestDigest: string;
  readonly sourceMessageCount: number;
  readonly selectedMessageCount: number;
  readonly sourceToolCount: number;
  readonly selectedToolCount: number;
  readonly estimatedInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly providerContextWindowTokens: number;
  readonly inputBudgetTokens: number;
  readonly softThresholdTokens: number;
  readonly hardLimitTokens: number;
  readonly estimatedRequestBytes: number;
  readonly components: readonly ContextManifestComponentAccounting[];
  readonly fitDecision: ContextManifestFitDecision;
  readonly status: ContextManifestStatus;
}

export interface ContextManifestRecord extends Omit<ContextManifestRecordInput, "schemaVersion" | "components"> {
  readonly organizationId: string;
  readonly schemaVersion: "v1";
  readonly components: readonly ContextManifestComponentAccounting[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ContextManifestRow {
  organization_id: string;
  request_manifest_id: string;
  run_id: string;
  turn_id: string;
  model_attempt_id: string | null;
  provider_request_id: string | null;
  schema_version: "v1";
  compaction_generation: number;
  source_boundary_digest: string;
  source_digest: string;
  manifest_digest: string;
  source_message_count: number;
  selected_message_count: number;
  source_tool_count: number;
  selected_tool_count: number;
  estimated_input_tokens: number;
  reserved_output_tokens: number;
  safety_margin_tokens: number;
  provider_context_window_tokens: number;
  input_budget_tokens: number;
  soft_threshold_tokens: number;
  hard_limit_tokens: number;
  estimated_request_bytes: number | string;
  component_accounting: unknown;
  fit_decision: ContextManifestFitDecision;
  status: ContextManifestStatus;
  created_at: Date | string;
  updated_at: Date | string;
}

const COMPONENT_KINDS: readonly ContextManifestComponentKind[] = [
  "system",
  "history",
  "current_message",
  "tool_results",
  "tool_schemas",
];

const columns = `organization_id, request_manifest_id, run_id, turn_id,
  model_attempt_id, provider_request_id, schema_version, compaction_generation,
  source_boundary_digest, source_digest, manifest_digest, source_message_count,
  selected_message_count, source_tool_count, selected_tool_count,
  estimated_input_tokens, reserved_output_tokens, safety_margin_tokens,
  provider_context_window_tokens, input_budget_tokens, soft_threshold_tokens,
  hard_limit_tokens, estimated_request_bytes, component_accounting,
  fit_decision, status, created_at, updated_at`;

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function validateText(value: string | undefined, code: string, optional = false): void {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 240) throw new Error(code);
}

function validateDigest(value: string, code: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(code);
}

function validateCount(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function sanitizeComponents(components: readonly ContextManifestComponentAccounting[]): ContextManifestComponentAccounting[] {
  if (!Array.isArray(components) || components.length !== COMPONENT_KINDS.length) throw new Error("CONTEXT_MANIFEST_COMPONENTS_INVALID");
  const seen = new Set<string>();
  const sanitized = components.map((component) => {
    if (!COMPONENT_KINDS.includes(component?.kind) || seen.has(component.kind)) throw new Error("CONTEXT_MANIFEST_COMPONENTS_INVALID");
    seen.add(component.kind);
    validateCount(component.selectedCount, "CONTEXT_MANIFEST_COMPONENT_COUNT_INVALID");
    validateCount(component.estimatedTokens, "CONTEXT_MANIFEST_COMPONENT_TOKENS_INVALID");
    validateCount(component.estimatedBytes, "CONTEXT_MANIFEST_COMPONENT_BYTES_INVALID");
    return {
      kind: component.kind,
      selectedCount: component.selectedCount,
      estimatedTokens: component.estimatedTokens,
      estimatedBytes: component.estimatedBytes,
    };
  });
  if (seen.size !== COMPONENT_KINDS.length) throw new Error("CONTEXT_MANIFEST_COMPONENTS_INVALID");
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") > 4096) throw new Error("CONTEXT_MANIFEST_COMPONENTS_TOO_LARGE");
  return sanitized;
}

function validate(input: ContextManifestRecordInput): ContextManifestComponentAccounting[] {
  validateText(input.requestManifestId, "CONTEXT_MANIFEST_ID_REQUIRED");
  validateText(input.runId, "CONTEXT_MANIFEST_RUN_ID_REQUIRED");
  validateText(input.turnId, "CONTEXT_MANIFEST_TURN_ID_REQUIRED");
  validateText(input.modelAttemptId, "CONTEXT_MANIFEST_ATTEMPT_ID_INVALID", true);
  validateText(input.providerRequestId, "CONTEXT_MANIFEST_PROVIDER_REQUEST_ID_INVALID", true);
  if (input.schemaVersion !== undefined && input.schemaVersion !== "v1") throw new Error("CONTEXT_MANIFEST_SCHEMA_VERSION_INVALID");
  validateCount(input.compactionGeneration ?? 0, "CONTEXT_MANIFEST_GENERATION_INVALID");
  validateDigest(input.sourceBoundaryDigest, "CONTEXT_MANIFEST_SOURCE_BOUNDARY_DIGEST_INVALID");
  validateDigest(input.sourceDigest, "CONTEXT_MANIFEST_SOURCE_DIGEST_INVALID");
  validateDigest(input.manifestDigest, "CONTEXT_MANIFEST_DIGEST_INVALID");
  for (const [value, code] of [
    [input.sourceMessageCount, "CONTEXT_MANIFEST_SOURCE_MESSAGE_COUNT_INVALID"],
    [input.selectedMessageCount, "CONTEXT_MANIFEST_SELECTED_MESSAGE_COUNT_INVALID"],
    [input.sourceToolCount, "CONTEXT_MANIFEST_SOURCE_TOOL_COUNT_INVALID"],
    [input.selectedToolCount, "CONTEXT_MANIFEST_SELECTED_TOOL_COUNT_INVALID"],
    [input.estimatedInputTokens, "CONTEXT_MANIFEST_INPUT_TOKENS_INVALID"],
    [input.reservedOutputTokens, "CONTEXT_MANIFEST_OUTPUT_TOKENS_INVALID"],
    [input.safetyMarginTokens, "CONTEXT_MANIFEST_SAFETY_MARGIN_INVALID"],
    [input.providerContextWindowTokens, "CONTEXT_MANIFEST_CONTEXT_WINDOW_INVALID"],
    [input.inputBudgetTokens, "CONTEXT_MANIFEST_INPUT_BUDGET_INVALID"],
    [input.softThresholdTokens, "CONTEXT_MANIFEST_SOFT_THRESHOLD_INVALID"],
    [input.hardLimitTokens, "CONTEXT_MANIFEST_HARD_LIMIT_INVALID"],
    [input.estimatedRequestBytes, "CONTEXT_MANIFEST_REQUEST_BYTES_INVALID"],
  ] as const) validateCount(value, code);
  if (!["ready", "compact", "prune", "limited", "cannot_fit"].includes(input.fitDecision)) throw new Error("CONTEXT_MANIFEST_FIT_DECISION_INVALID");
  if (!["fits", "compacted", "rejected"].includes(input.status)) throw new Error("CONTEXT_MANIFEST_STATUS_INVALID");
  return sanitizeComponents(input.components);
}

function map(row: ContextManifestRow): ContextManifestRecord {
  if (!Array.isArray(row.component_accounting)) throw new Error("CONTEXT_MANIFEST_COMPONENTS_CORRUPT");
  return {
    organizationId: row.organization_id,
    requestManifestId: row.request_manifest_id,
    runId: row.run_id,
    turnId: row.turn_id,
    ...(row.model_attempt_id ? { modelAttemptId: row.model_attempt_id } : {}),
    ...(row.provider_request_id ? { providerRequestId: row.provider_request_id } : {}),
    schemaVersion: row.schema_version,
    compactionGeneration: row.compaction_generation,
    sourceBoundaryDigest: row.source_boundary_digest,
    sourceDigest: row.source_digest,
    manifestDigest: row.manifest_digest,
    sourceMessageCount: row.source_message_count,
    selectedMessageCount: row.selected_message_count,
    sourceToolCount: row.source_tool_count,
    selectedToolCount: row.selected_tool_count,
    estimatedInputTokens: row.estimated_input_tokens,
    reservedOutputTokens: row.reserved_output_tokens,
    safetyMarginTokens: row.safety_margin_tokens,
    providerContextWindowTokens: row.provider_context_window_tokens,
    inputBudgetTokens: row.input_budget_tokens,
    softThresholdTokens: row.soft_threshold_tokens,
    hardLimitTokens: row.hard_limit_tokens,
    estimatedRequestBytes: Number(row.estimated_request_bytes),
    components: row.component_accounting as ContextManifestComponentAccounting[],
    fitDecision: row.fit_decision,
    status: row.status,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

/** Durable, content-free projection of a model request manifest. */
export class ContextManifestRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
  ) {
    validateText(organizationId, "CONTEXT_MANIFEST_ORGANIZATION_ID_REQUIRED");
  }

  public async record(input: ContextManifestRecordInput): Promise<{ status: "created" | "replayed"; manifest: ContextManifestRecord }> {
    const components = validate(input);
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<ContextManifestRow>(
        `INSERT INTO agent_context_request_manifests (
           organization_id, request_manifest_id, run_id, turn_id,
           model_attempt_id, provider_request_id, schema_version, compaction_generation,
           source_boundary_digest, source_digest, manifest_digest,
           source_message_count, selected_message_count, source_tool_count, selected_tool_count,
           estimated_input_tokens, reserved_output_tokens, safety_margin_tokens,
           provider_context_window_tokens, input_budget_tokens, soft_threshold_tokens,
           hard_limit_tokens, estimated_request_bytes, component_accounting,
           fit_decision, status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25,$26)
         ON CONFLICT (organization_id, request_manifest_id) DO NOTHING
         RETURNING ${columns}`,
        [
          this.organizationId,
          input.requestManifestId,
          input.runId,
          input.turnId,
          input.modelAttemptId ?? null,
          input.providerRequestId ?? null,
          input.schemaVersion ?? "v1",
          input.compactionGeneration ?? 0,
          input.sourceBoundaryDigest,
          input.sourceDigest,
          input.manifestDigest,
          input.sourceMessageCount,
          input.selectedMessageCount,
          input.sourceToolCount,
          input.selectedToolCount,
          input.estimatedInputTokens,
          input.reservedOutputTokens,
          input.safetyMarginTokens,
          input.providerContextWindowTokens,
          input.inputBudgetTokens,
          input.softThresholdTokens,
          input.hardLimitTokens,
          input.estimatedRequestBytes,
          JSON.stringify(components),
          input.fitDecision,
          input.status,
        ],
      );
      if (inserted.rows[0]) return { status: "created", manifest: map(inserted.rows[0]) };
      const existing = await client.query<ContextManifestRow>(
        `SELECT ${columns}
         FROM agent_context_request_manifests
         WHERE organization_id = $1 AND request_manifest_id = $2
         FOR UPDATE`,
        [this.organizationId, input.requestManifestId],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("CONTEXT_MANIFEST_REPLAY_NOT_FOUND");
      if (row.manifest_digest !== input.manifestDigest) throw new Error("CONTEXT_MANIFEST_DIGEST_CONFLICT");
      return { status: "replayed", manifest: map(row) };
    });
  }

  public async get(requestManifestId: string): Promise<ContextManifestRecord | undefined> {
    validateText(requestManifestId, "CONTEXT_MANIFEST_ID_REQUIRED");
    const result = await query<ContextManifestRow>(
      this.pool,
      `SELECT ${columns}
       FROM agent_context_request_manifests
       WHERE organization_id = $1 AND request_manifest_id = $2`,
      [this.organizationId, requestManifestId],
    );
    return result.rows[0] ? map(result.rows[0]) : undefined;
  }

  public async listForRun(runId: string, limit = 100): Promise<ContextManifestRecord[]> {
    validateText(runId, "CONTEXT_MANIFEST_RUN_ID_REQUIRED");
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 1_000));
    const result = await query<ContextManifestRow>(
      this.pool,
      `SELECT ${columns}
       FROM agent_context_request_manifests
       WHERE organization_id = $1 AND run_id = $2
       ORDER BY created_at ASC, request_manifest_id ASC
       LIMIT $3`,
      [this.organizationId, runId, boundedLimit],
    );
    return result.rows.map(map);
  }
}
