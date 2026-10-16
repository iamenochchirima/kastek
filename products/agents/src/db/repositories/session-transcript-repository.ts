import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../pool";
import type { ModelMessage } from "../../model/types";
import { buildTranscriptUnits, cloneModelMessage, toolOperationIdentity, transcriptDigest, validateModelTranscript } from "../../runtime/transcript";

const ZERO_DIGEST = "0".repeat(64);

export type SessionTranscriptEntryKind =
  | "user"
  | "assistant_response"
  | "assistant_tool_call"
  | "tool_result"
  | "waiting"
  | "interruption"
  | "error"
  | "compaction_checkpoint";

export interface SessionTranscriptScope {
  organizationId: string;
  installationId: string;
  conversationId: string;
  /** Stable and explicit so future non-conversation sessions can use the same seam. */
  sessionKey?: string;
}

export interface SessionTranscriptContext {
  id: string;
  organizationId: string;
  installationId: string;
  conversationId: string;
  sessionKey: string;
  generation: number;
  headSequence: number;
  headDigest: string;
  activeCheckpointSequence: number | null;
  activeCheckpointSourceSequence: number;
  activeProjectionDigest: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionTranscriptEntry {
  id: string;
  contextId: string;
  organizationId: string;
  installationId: string;
  conversationId: string;
  generation: number;
  sequence: number;
  turnId: string;
  runId: string | null;
  kind: SessionTranscriptEntryKind;
  message: ModelMessage;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  payloadDigest: string;
  previousDigest: string;
  entryDigest: string;
  active: boolean;
  archivedAt: string | null;
  createdAt: string;
}

export interface SessionTranscriptProjection {
  context: SessionTranscriptContext;
  entries: SessionTranscriptEntry[];
  messages: ModelMessage[];
  /** Canonical transcript head used to build the provider request manifest. */
  sourceCursor: number;
  sourceDigest: string;
  activeProjectionDigest: string;
}

export interface ReadActiveTranscriptOptions {
  /**
   * Batch recovery may inspect an assistant tool-call entry before all results
   * have committed. Normal context reads must continue to reject that state.
   */
  allowIncomplete?: boolean;
}

/**
 * Resolve the historical sequence boundary for the same tail policy used by
 * the context compactor. Tool-call batches are kept atomic, so the boundary
 * always lands after the complete unit rather than between call and result.
 */
export function archiveThroughSequenceForCompaction(
  projection: SessionTranscriptProjection,
  maxRetainedMessageUnits: number,
): number | undefined {
  if (!Number.isSafeInteger(maxRetainedMessageUnits) || maxRetainedMessageUnits <= 0) {
    throw new Error("SESSION_TRANSCRIPT_RETAINED_UNITS_INVALID");
  }
  const bodyEntries = projection.entries.filter((entry) => entry.kind !== "compaction_checkpoint" && entry.message.role !== "system");
  const bodyMessages = bodyEntries.map((entry) => entry.message);
  // A pending tool round is one atomic unit whose assistant call must remain
  // visible until every result is committed. Do not archive an incomplete
  // assistant call merely because the retained-unit limit was reached.
  if (validateModelTranscript(bodyMessages).length > 0) return undefined;
  const units = buildTranscriptUnits(bodyMessages);
  if (units.length <= maxRetainedMessageUnits) return undefined;
  const retainedIndexes = new Set<number>();
  for (let index = Math.max(0, units.length - maxRetainedMessageUnits); index < units.length; index += 1) retainedIndexes.add(index);
  for (let index = units.length - 1; index >= 0; index -= 1) {
    if (units[index]?.messages.some((message) => message.role === "user")) {
      retainedIndexes.add(index);
      break;
    }
  }
  const omitted = units.filter((_unit, index) => !retainedIndexes.has(index));
  const omittedEndIndex = omitted.reduce((max, unit) => Math.max(max, unit.endIndex), -1);
  return omittedEndIndex < 0 ? undefined : bodyEntries[omittedEndIndex]?.sequence;
}

export interface AppendTranscriptEntryInput extends SessionTranscriptScope {
  generation?: number;
  turnId: string;
  runId?: string;
  kind: SessionTranscriptEntryKind;
  message: ModelMessage;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
  expectedHead?: { sequence: number; digest: string };
}

export type AppendTranscriptEntryResult =
  | { outcome: "created"; context: SessionTranscriptContext; entry: SessionTranscriptEntry }
  | { outcome: "replayed"; context: SessionTranscriptContext; entry: SessionTranscriptEntry };

export interface ActivateCompactionInput extends SessionTranscriptScope {
  generation?: number;
  operationId: string;
  turnId: string;
  runId?: string;
  checkpointMessage: ModelMessage;
  checkpointMetadata?: Record<string, unknown>;
  archiveThroughSequence: number;
  expectedHead?: { sequence: number; digest: string };
}

export type ActivateCompactionResult =
  | { outcome: "created"; projection: SessionTranscriptProjection; checkpoint: SessionTranscriptEntry }
  | { outcome: "replayed"; projection: SessionTranscriptProjection; checkpoint: SessionTranscriptEntry };

interface ContextRow {
  id: string;
  organization_id: string;
  installation_id: string;
  conversation_id: string;
  session_key: string;
  generation: string | number;
  head_sequence: string | number;
  head_digest: string;
  active_checkpoint_sequence: string | number | null;
  active_checkpoint_source_sequence: string | number;
  active_projection_digest: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EntryRow {
  id: string;
  context_id: string;
  organization_id: string;
  installation_id: string;
  conversation_id: string;
  generation: string | number;
  sequence: string | number;
  turn_id: string;
  run_id: string | null;
  entry_kind: SessionTranscriptEntryKind;
  model_message: ModelMessage;
  metadata: Record<string, unknown>;
  idempotency_key: string;
  payload_digest: string;
  previous_digest: string;
  entry_digest: string;
  is_active: boolean;
  archived_at: Date | string | null;
  created_at: Date | string;
}

function requiredText(value: string | undefined, name: string, maxLength = 300): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`SESSION_TRANSCRIPT_${name}_REQUIRED`);
  if (normalized.length > maxLength) throw new Error(`SESSION_TRANSCRIPT_${name}_TOO_LONG`);
  return normalized;
}

function positiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`SESSION_TRANSCRIPT_${name}_INVALID`);
  return value;
}

function normalizeTimestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function defaultSessionKey(input: SessionTranscriptScope): string {
  return `installation:${requiredText(input.installationId, "INSTALLATION_ID")}:conversation:${requiredText(input.conversationId, "CONVERSATION_ID")}`;
}

function normalizeScope(input: SessionTranscriptScope): Required<SessionTranscriptScope> {
  return {
    organizationId: requiredText(input.organizationId, "ORGANIZATION_ID"),
    installationId: requiredText(input.installationId, "INSTALLATION_ID"),
    conversationId: requiredText(input.conversationId, "CONVERSATION_ID"),
    sessionKey: requiredText(input.sessionKey ?? defaultSessionKey(input), "SESSION_KEY", 240),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function mapContext(row: ContextRow): SessionTranscriptContext {
  return {
    id: row.id,
    organizationId: row.organization_id,
    installationId: row.installation_id,
    conversationId: row.conversation_id,
    sessionKey: row.session_key,
    generation: Number(row.generation),
    headSequence: Number(row.head_sequence),
    headDigest: row.head_digest,
    activeCheckpointSequence: row.active_checkpoint_sequence === null ? null : Number(row.active_checkpoint_sequence),
    activeCheckpointSourceSequence: Number(row.active_checkpoint_source_sequence),
    activeProjectionDigest: row.active_projection_digest,
    createdAt: normalizeTimestamp(row.created_at)!,
    updatedAt: normalizeTimestamp(row.updated_at)!,
  };
}

function mapEntry(row: EntryRow): SessionTranscriptEntry {
  return {
    id: row.id,
    contextId: row.context_id,
    organizationId: row.organization_id,
    installationId: row.installation_id,
    conversationId: row.conversation_id,
    generation: Number(row.generation),
    sequence: Number(row.sequence),
    turnId: row.turn_id,
    runId: row.run_id,
    kind: row.entry_kind,
    message: cloneModelMessage(row.model_message),
    metadata: row.metadata ?? {},
    idempotencyKey: row.idempotency_key,
    payloadDigest: row.payload_digest,
    previousDigest: row.previous_digest,
    entryDigest: row.entry_digest,
    active: row.is_active,
    archivedAt: normalizeTimestamp(row.archived_at),
    createdAt: normalizeTimestamp(row.created_at)!,
  };
}

function payloadDigest(input: {
  generation: number;
  turnId: string;
  runId?: string;
  kind: SessionTranscriptEntryKind;
  message: ModelMessage;
  metadata: Record<string, unknown>;
}): string {
  return digest(input);
}

function entryDigest(input: {
  previousDigest: string;
  sequence: number;
  payloadDigest: string;
  idempotencyKey: string;
}): string {
  return digest(input);
}

function projectionDigest(messages: readonly ModelMessage[]): string {
  return messages.length === 0 ? ZERO_DIGEST : transcriptDigest(messages);
}

interface PendingWaitingRound {
  entry: SessionTranscriptEntry;
  operationIds: Set<string>;
}

function pendingWaitingRounds(entries: readonly SessionTranscriptEntry[]): PendingWaitingRound[] {
  const completedOperationIds = new Set(
    entries
      .filter((entry) => entry.kind === "tool_result")
      .map((entry) => toolOperationIdentity(entry.message))
      .filter((value): value is string => Boolean(value)),
  );
  return entries
    .filter((entry) => entry.kind === "waiting")
    .map((entry) => {
      const rawIds = entry.metadata.pendingOperationIds;
      const operationIds = new Set(
        Array.isArray(rawIds)
          ? rawIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          : [],
      );
      return { entry, operationIds };
    })
    .filter(({ operationIds }) => operationIds.size > 0 && [...operationIds].some((id) => !completedOperationIds.has(id)));
}

/**
 * Project only complete provider-facing rounds. A pending approval keeps its
 * audit entries, but its assistant call and any partial results stay out of
 * the next model request until every operation has a terminal result.
 */
function projectTranscriptMessages(entries: readonly SessionTranscriptEntry[]): ModelMessage[] {
  const pendingOperationIds = new Set(pendingWaitingRounds(entries).flatMap(({ operationIds }) => [...operationIds]));
  const messages: ModelMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === "waiting") continue;
    if (entry.kind === "assistant_tool_call"
      && entry.message.toolCalls?.some((call) => pendingOperationIds.has(toolOperationIdentity(call) ?? ""))) continue;
    if (entry.kind === "tool_result" && pendingOperationIds.has(toolOperationIdentity(entry.message) ?? "")) continue;
    messages.push(cloneModelMessage(entry.message));
  }
  return messages;
}

function assertExpectedHead(context: SessionTranscriptContext, expectedHead: { sequence: number; digest: string } | undefined): void {
  if (!expectedHead) return;
  if (!Number.isSafeInteger(expectedHead.sequence) || expectedHead.sequence < 0 || !/^[0-9a-f]{64}$/i.test(expectedHead.digest)) {
    throw new Error("SESSION_TRANSCRIPT_EXPECTED_HEAD_INVALID");
  }
  if (context.headSequence !== expectedHead.sequence || context.headDigest !== expectedHead.digest) {
    throw new Error("SESSION_TRANSCRIPT_HEAD_CONFLICT");
  }
}

async function selectContext(client: PoolClient, scope: Required<SessionTranscriptScope>, lock = false): Promise<ContextRow | undefined> {
  const result = await client.query<ContextRow>(
    `SELECT *
     FROM agent_session_contexts
     WHERE organization_id = $1 AND installation_id = $2 AND conversation_id = $3
     ${lock ? "FOR UPDATE" : ""}`,
    [scope.organizationId, scope.installationId, scope.conversationId],
  );
  return result.rows[0];
}

async function ensureContext(client: PoolClient, scope: Required<SessionTranscriptScope>): Promise<ContextRow> {
  const result = await client.query<ContextRow>(
    `INSERT INTO agent_session_contexts
       (organization_id, installation_id, conversation_id, session_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, installation_id, conversation_id)
     DO UPDATE SET updated_at = now()
     RETURNING *`,
    [scope.organizationId, scope.installationId, scope.conversationId, scope.sessionKey],
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await selectContext(client, scope, true);
  if (!existing) throw new Error("SESSION_TRANSCRIPT_CONTEXT_NOT_FOUND");
  return existing;
}

async function selectEntryByIdempotency(client: PoolClient, contextId: string, idempotencyKey: string, lock = false): Promise<EntryRow | undefined> {
  const result = await client.query<EntryRow>(
    `SELECT *
     FROM agent_session_transcript_entries
     WHERE context_id = $1 AND idempotency_key = $2
     ${lock ? "FOR UPDATE" : ""}`,
    [contextId, idempotencyKey],
  );
  return result.rows[0];
}

async function selectProjection(
  client: PoolClient,
  row: ContextRow,
  verifyStoredDigest = true,
  allowIncomplete = false,
): Promise<SessionTranscriptProjection> {
  const context = mapContext(row);
  const checkpointResult = context.activeCheckpointSequence === null
    ? { rows: [] as EntryRow[] }
    : await client.query<EntryRow>(
      `SELECT *
       FROM agent_session_transcript_entries
       WHERE context_id = $1 AND generation = $2 AND sequence = $3
         AND entry_kind = 'compaction_checkpoint' AND is_active = true`,
      [context.id, context.generation, context.activeCheckpointSequence],
    );
  const tailResult = await client.query<EntryRow>(
    `SELECT *
     FROM agent_session_transcript_entries
     WHERE context_id = $1 AND generation = $2 AND is_active = true
       AND entry_kind <> 'compaction_checkpoint'
       AND sequence > $3
     ORDER BY sequence ASC`,
    [context.id, context.generation, context.activeCheckpointSourceSequence],
  );
  const checkpointSequenceResult = await client.query<{ sequence: string | number }>(
    `SELECT sequence
     FROM agent_session_transcript_entries
     WHERE context_id = $1 AND generation = $2
       AND entry_kind = 'compaction_checkpoint'
       AND sequence > $3 AND sequence <= $4
     ORDER BY sequence ASC`,
    [context.id, context.generation, context.activeCheckpointSourceSequence, context.headSequence],
  );
  const checkpointSequences = new Set(checkpointSequenceResult.rows.map((entry) => Number(entry.sequence)));
  const checkpoint = checkpointResult.rows[0] ? mapEntry(checkpointResult.rows[0]) : undefined;
  if (context.activeCheckpointSequence !== null && !checkpoint) throw new Error("SESSION_TRANSCRIPT_CHECKPOINT_MISSING");
  if (context.activeCheckpointSequence === null && context.activeCheckpointSourceSequence !== 0) {
    throw new Error("SESSION_TRANSCRIPT_CHECKPOINT_CURSOR_INVALID");
  }
  if (checkpoint && (checkpoint.sequence <= context.activeCheckpointSourceSequence || checkpoint.sequence > context.headSequence)) {
    throw new Error("SESSION_TRANSCRIPT_CHECKPOINT_CURSOR_INVALID");
  }
  const entries = [
    ...(checkpoint ? [checkpoint] : []),
    ...tailResult.rows.map(mapEntry),
  ];
  const expectedTailStart = context.activeCheckpointSourceSequence + 1;
  let expectedSequence = expectedTailStart;
  for (const entry of entries.filter((candidate) => candidate.kind !== "compaction_checkpoint")) {
    while (checkpointSequences.has(expectedSequence)) expectedSequence += 1;
    if (entry.sequence !== expectedSequence) throw new Error("SESSION_TRANSCRIPT_SEQUENCE_GAP");
    expectedSequence += 1;
  }
  while (checkpointSequences.has(expectedSequence)) expectedSequence += 1;
  if (expectedSequence - 1 !== context.headSequence) throw new Error("SESSION_TRANSCRIPT_SEQUENCE_GAP");
  const waitingRounds = pendingWaitingRounds(entries);
  const messages = projectTranscriptMessages(entries);
  if (verifyStoredDigest) {
    const issues = validateModelTranscript(messages.filter((message) => message.role !== "system"));
    const onlyMissingResults = issues.length > 0 && issues.every((issue) => issue.code === "missing_tool_result");
    if (issues.length > 0 && !(allowIncomplete && onlyMissingResults)) throw new Error("SESSION_TRANSCRIPT_PROJECTION_INVALID");
    if (waitingRounds.length > 0 && !allowIncomplete) throw new Error("SESSION_TRANSCRIPT_PROJECTION_PENDING");
  }
  const computedProjectionDigest = projectionDigest(messages);
  if (context.activeProjectionDigest !== computedProjectionDigest) {
    throw new Error("SESSION_TRANSCRIPT_PROJECTION_DIGEST_MISMATCH");
  }
  return {
    context,
    entries,
    messages,
    sourceCursor: context.headSequence,
    sourceDigest: context.headDigest,
    activeProjectionDigest: context.activeProjectionDigest,
  };
}

export class SessionTranscriptRepository {
  public constructor(private readonly pool: Pool) {}

  public async getOrCreate(input: SessionTranscriptScope): Promise<SessionTranscriptContext> {
    const scope = normalizeScope(input);
    return withTransaction(this.pool, async (client) => mapContext(await ensureContext(client, scope)));
  }

  public async readActive(
    input: SessionTranscriptScope,
    options: ReadActiveTranscriptOptions = {},
  ): Promise<SessionTranscriptProjection> {
    const scope = normalizeScope(input);
    return withTransaction(this.pool, async (client) => {
      const context = await selectContext(client, scope);
      if (!context) {
        const created = await ensureContext(client, scope);
        return selectProjection(client, created, true, options.allowIncomplete === true);
      }
      return selectProjection(client, context, true, options.allowIncomplete === true);
    });
  }

  public async append(input: AppendTranscriptEntryInput): Promise<AppendTranscriptEntryResult> {
    const scope = normalizeScope(input);
    const turnId = requiredText(input.turnId, "TURN_ID", 240);
    const idempotencyKey = requiredText(input.idempotencyKey, "IDEMPOTENCY_KEY", 300);
    const generation = positiveInteger(input.generation, "GENERATION");
    const metadata = input.metadata ?? {};
    const message = cloneModelMessage(input.message);
    const runId = input.runId?.trim() || undefined;

    return withTransaction(this.pool, async (client) => {
      const contextRow = await ensureContext(client, scope);
      const context = mapContext(contextRow);
      const resolvedGeneration = generation ?? context.generation;
      const existing = await selectEntryByIdempotency(client, context.id, idempotencyKey, true);
      const payload = payloadDigest({ generation: resolvedGeneration, turnId, ...(runId ? { runId } : {}), kind: input.kind, message, metadata });
      if (existing) {
        if (existing.payload_digest !== payload) throw new Error("SESSION_TRANSCRIPT_IDEMPOTENCY_CONFLICT");
        return { outcome: "replayed", context, entry: mapEntry(existing) };
      }
      if (generation !== undefined && context.generation !== generation) throw new Error("SESSION_TRANSCRIPT_GENERATION_CONFLICT");
      assertExpectedHead(context, input.expectedHead);
      const currentProjection = await selectProjection(client, contextRow, false, input.kind === "waiting");
      const nextSequence = context.headSequence + 1;
      const nextEntryDigest = entryDigest({
        previousDigest: context.headDigest,
        sequence: nextSequence,
        payloadDigest: payload,
        idempotencyKey,
      });
      const inserted = await client.query<EntryRow>(
        `INSERT INTO agent_session_transcript_entries
          (context_id, organization_id, installation_id, conversation_id, generation, sequence,
           turn_id, run_id, entry_kind, model_message, metadata, idempotency_key, payload_digest,
           previous_digest, entry_digest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15)
         RETURNING *`,
        [
          context.id,
          scope.organizationId,
          scope.installationId,
          scope.conversationId,
          context.generation,
          nextSequence,
          turnId,
          runId ?? null,
          input.kind,
          JSON.stringify(message),
          JSON.stringify(metadata),
          idempotencyKey,
          payload,
          context.headDigest,
          nextEntryDigest,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("SESSION_TRANSCRIPT_APPEND_FAILED");
      const nextMessages = projectTranscriptMessages([
        ...currentProjection.entries,
        mapEntry(row),
      ]);
      const updated = await client.query<ContextRow>(
        `UPDATE agent_session_contexts
         SET head_sequence = $4,
             head_digest = $5,
             active_projection_digest = $6,
             updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND generation = $3
         RETURNING *`,
        [context.id, scope.organizationId, context.generation, nextSequence, nextEntryDigest, projectionDigest(nextMessages)],
      );
      if (!updated.rows[0]) throw new Error("SESSION_TRANSCRIPT_HEAD_UPDATE_FAILED");
      return { outcome: "created", context: mapContext(updated.rows[0]), entry: mapEntry(row) };
    });
  }

  public async activateCompaction(input: ActivateCompactionInput): Promise<ActivateCompactionResult> {
    const scope = normalizeScope(input);
    const operationId = requiredText(input.operationId, "OPERATION_ID", 240);
    const turnId = requiredText(input.turnId, "TURN_ID", 240);
    const generation = positiveInteger(input.generation, "GENERATION");
    if (!Number.isSafeInteger(input.archiveThroughSequence) || input.archiveThroughSequence < 0) {
      throw new Error("SESSION_TRANSCRIPT_ARCHIVE_CURSOR_INVALID");
    }
    if (input.checkpointMessage.role !== "system") throw new Error("SESSION_TRANSCRIPT_CHECKPOINT_MUST_BE_SYSTEM");
    const checkpointKey = `compaction:${operationId}`;
    const metadata = {
      ...(input.checkpointMetadata ?? {}),
      operationId,
      sourceSequence: input.archiveThroughSequence,
    };
    const message = cloneModelMessage(input.checkpointMessage);

    return withTransaction(this.pool, async (client) => {
      const contextRow = await ensureContext(client, scope);
      const context = mapContext(contextRow);
      const resolvedGeneration = generation ?? context.generation;
      const existing = await selectEntryByIdempotency(client, context.id, checkpointKey, true);
      const payload = payloadDigest({ generation: resolvedGeneration, turnId, ...(input.runId?.trim() ? { runId: input.runId.trim() } : {}), kind: "compaction_checkpoint", message, metadata });
      if (existing) {
        if (existing.payload_digest !== payload) throw new Error("SESSION_TRANSCRIPT_COMPACTION_CONFLICT");
        return { outcome: "replayed", projection: await selectProjection(client, contextRow), checkpoint: mapEntry(existing) };
      }
      if (generation !== undefined && context.generation !== generation) throw new Error("SESSION_TRANSCRIPT_GENERATION_CONFLICT");
      if (input.archiveThroughSequence > context.headSequence) throw new Error("SESSION_TRANSCRIPT_ARCHIVE_CURSOR_AHEAD");
      if (input.archiveThroughSequence < context.activeCheckpointSourceSequence) throw new Error("SESSION_TRANSCRIPT_ARCHIVE_CURSOR_REGRESSION");
      assertExpectedHead(context, input.expectedHead);
      const nextSequence = context.headSequence + 1;
      const nextEntryDigest = entryDigest({
        previousDigest: context.headDigest,
        sequence: nextSequence,
        payloadDigest: payload,
        idempotencyKey: checkpointKey,
      });
      await client.query(
        `UPDATE agent_session_transcript_entries
         SET is_active = false, archived_at = COALESCE(archived_at, now())
         WHERE context_id = $1 AND generation = $2
           AND is_active = true
           AND (sequence <= $3 OR entry_kind = 'compaction_checkpoint')`,
        [context.id, context.generation, input.archiveThroughSequence],
      );
      const inserted = await client.query<EntryRow>(
        `INSERT INTO agent_session_transcript_entries
          (context_id, organization_id, installation_id, conversation_id, generation, sequence,
           turn_id, run_id, entry_kind, model_message, metadata, idempotency_key, payload_digest,
           previous_digest, entry_digest, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'compaction_checkpoint', $9::jsonb, $10::jsonb, $11, $12, $13, $14, true)
         RETURNING *`,
        [
          context.id,
          scope.organizationId,
          scope.installationId,
          scope.conversationId,
          context.generation,
          nextSequence,
          turnId,
          input.runId?.trim() || null,
          JSON.stringify(message),
          JSON.stringify(metadata),
          checkpointKey,
          payload,
          context.headDigest,
          nextEntryDigest,
        ],
      );
      const checkpointRow = inserted.rows[0];
      if (!checkpointRow) throw new Error("SESSION_TRANSCRIPT_COMPACTION_APPEND_FAILED");
      const tailResult = await client.query<EntryRow>(
        `SELECT *
         FROM agent_session_transcript_entries
         WHERE context_id = $1 AND generation = $2 AND is_active = true
           AND entry_kind <> 'compaction_checkpoint' AND sequence > $3
         ORDER BY sequence ASC`,
        [context.id, context.generation, input.archiveThroughSequence],
      );
      // Build the digest through the same projection as readActive(). The
      // active tail can contain waiting markers or an incomplete tool round;
      // hashing raw rows here makes the just-activated checkpoint fail its
      // own integrity check on the first retry.
      const activeMessages = projectTranscriptMessages([
        mapEntry(checkpointRow),
        ...tailResult.rows.map(mapEntry),
      ]);
      const activeDigest = projectionDigest(activeMessages);
      const updated = await client.query<ContextRow>(
        `UPDATE agent_session_contexts
         SET head_sequence = $4,
             head_digest = $5,
             active_checkpoint_sequence = $4,
             active_checkpoint_source_sequence = $6,
             active_projection_digest = $7,
             updated_at = now()
         WHERE id = $1 AND organization_id = $2 AND generation = $3
         RETURNING *`,
        [context.id, scope.organizationId, context.generation, nextSequence, nextEntryDigest, input.archiveThroughSequence, activeDigest],
      );
      if (!updated.rows[0]) throw new Error("SESSION_TRANSCRIPT_COMPACTION_ACTIVATION_FAILED");
      return {
        outcome: "created",
        // Activation may happen while a waiting marker or incomplete tool
        // round remains in the active tail. The stored digest is still based
        // on the canonical provider projection; return that recovery view so
        // the next read can enforce the normal completeness boundary.
        projection: await selectProjection(client, updated.rows[0], true, true),
        checkpoint: mapEntry(checkpointRow),
      };
    });
  }

  public async startNewGeneration(input: SessionTranscriptScope & { expectedGeneration?: number }): Promise<SessionTranscriptContext> {
    const scope = normalizeScope(input);
    return withTransaction(this.pool, async (client) => {
      const contextRow = await ensureContext(client, scope);
      const context = mapContext(contextRow);
      if (input.expectedGeneration !== undefined && context.generation !== input.expectedGeneration) {
        throw new Error("SESSION_TRANSCRIPT_GENERATION_CONFLICT");
      }
      await client.query(
        `UPDATE agent_session_transcript_entries
         SET is_active = false, archived_at = COALESCE(archived_at, now())
         WHERE context_id = $1 AND is_active = true`,
        [context.id],
      );
      const updated = await client.query<ContextRow>(
        `UPDATE agent_session_contexts
         SET generation = generation + 1,
             head_sequence = 0,
             head_digest = $3,
             active_checkpoint_sequence = NULL,
             active_checkpoint_source_sequence = 0,
             active_projection_digest = $3,
             updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING *`,
        [context.id, scope.organizationId, ZERO_DIGEST],
      );
      if (!updated.rows[0]) throw new Error("SESSION_TRANSCRIPT_GENERATION_RESET_FAILED");
      return mapContext(updated.rows[0]);
    });
  }

  /** Test/support hook for a transaction owner that already holds the context lock. */
  public async readActiveMessages(input: SessionTranscriptScope): Promise<ModelMessage[]> {
    const projection = await this.readActive(input);
    return projection.messages.map(cloneModelMessage);
  }
}
