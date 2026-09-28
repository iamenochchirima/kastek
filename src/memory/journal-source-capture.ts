import { createHash } from "node:crypto";
import type { ExecutionJournal, PersistedExecutionJournalEvent } from "../journal/contracts";
import { createEvidenceItem, evidenceDigest, type MemoryEvidenceEnvelope, type MemoryScope } from "./contracts";
import type { MemorySourceEventInput, MemorySourceEventRecord } from "../db/repositories/memory-source-event-repository";

export interface MemorySourceEventWriter {
  record(input: MemorySourceEventInput): Promise<{ status: "created" | "replayed"; event: MemorySourceEventRecord }>;
}

export type MemoryJournalScope = Omit<MemoryScope, "namespace"> & { runId?: string; turnId?: string };

export interface MemoryJournalScopeResolver {
  resolve(input: { organizationId: string; runId: string }): Promise<MemoryJournalScope>;
}

export interface MemoryJournalReplayInput {
  readonly journal: Pick<ExecutionJournal, "read">;
  readonly organizationId: string;
  readonly runId: string;
  /**
   * A caller-owned cursor can resume a bounded replay after a worker restart.
   * When omitted, the capture object reuses its in-process cursor, starting at
   * zero for a new process. Replaying from zero is safe because source writes
   * are idempotent and the journal remains the source of truth.
   */
  readonly afterSequence?: number;
  /** Maximum number of journal events to admit in one call. */
  readonly maxEvents?: number;
}

export interface MemoryJournalReplayResult {
  readonly captured: number;
  readonly replayed: number;
  readonly lastSequence: number;
  readonly hasMore: boolean;
}

/**
 * Projects the execution journal into the durable memory evidence boundary.
 * It deliberately stores only a digest of journal payloads; raw tool results,
 * credentials, and message bodies remain in their owning durable records.
 */
export class MemoryJournalSourceCapture {
  private readonly replayCursors = new Map<string, number>();

  public constructor(
    private readonly writer: MemorySourceEventWriter,
    private readonly scopes: MemoryJournalScopeResolver,
  ) {}

  public async capture(event: PersistedExecutionJournalEvent): Promise<{ status: "created" | "replayed"; eventId: string }> {
    const scope = await this.scopes.resolve({ organizationId: event.scope.organizationId, runId: event.scope.runId });
    const occurredAt = event.occurredAt;
    const payloadDigest = createHash("sha256").update(JSON.stringify(event.event)).digest("hex");
    const item = createEvidenceItem({
      id: event.id,
      actor: event.event.kind === "tool.invoked" ? "tool" : event.event.kind === "model.completed" ? "agent" : "system",
      occurredAt,
      sourceType: event.event.kind === "tool.invoked" ? "tool_result" : "workspace_state",
      rawContent: payloadDigest,
      includeContent: false,
    });
    const evidence: MemoryEvidenceEnvelope = {
      contractVersion: "memory-v2",
      scope,
      sourceEventIds: [event.id],
      items: [item],
      evidenceDigest: evidenceDigest([item]),
      redaction: "content_redacted",
      capturedAt: occurredAt,
    };
    const result = await this.writer.record({
      scope: { ...scope, runId: event.scope.runId, turnId: event.scope.operationId },
      eventType: `journal.${event.event.kind}`,
      sourceBoundary: `journal:${event.scope.runId}:${event.sequence}`,
      evidence,
      idempotencyKey: `journal:${event.scope.organizationId}:${event.id}`,
      eventSequence: event.sequence,
      channel: typeof event.event.kind === "string" && event.event.kind.includes("delivery") ? "channel" : undefined,
      extractionVersion: "capture-v2",
      occurredAt,
    });
    return { status: result.status, eventId: result.event.id };
  }

  /**
   * Reconcile the durable execution journal into the memory source boundary.
   *
   * Journal observers are intentionally non-blocking: a process can die after
   * the journal commit and before its memory projection callback finishes. A
   * later worker must therefore be able to replay the journal without relying
   * on an in-memory notification. Events are admitted strictly in sequence
   * order, and the cursor advances only after capture succeeds. A caller may
   * persist the returned cursor externally; the in-process cursor is merely an
   * efficiency hint and is reset safely on process restart.
   */
  public async replay(input: MemoryJournalReplayInput): Promise<MemoryJournalReplayResult> {
    const organizationId = requiredReplayIdentifier(input.organizationId, "organizationId");
    const runId = requiredReplayIdentifier(input.runId, "runId");
    const key = `${organizationId}:${runId}`;
    const maxEvents = boundedReplayLimit(input.maxEvents);
    let cursor = input.afterSequence === undefined
      ? (this.replayCursors.get(key) ?? 0)
      : boundedReplayCursor(input.afterSequence);
    let captured = 0;
    let replayed = 0;
    let processed = 0;
    let hasMore = false;

    while (processed < maxEvents) {
      const limit = Math.min(200, maxEvents - processed);
      const events = await input.journal.read({ organizationId, runId, afterSequence: cursor, limit });
      if (events.length === 0) break;

      let previousSequence = cursor;
      for (const event of events) {
        if (event.scope.organizationId !== organizationId || event.scope.runId !== runId) {
          throw Object.assign(new Error("Memory journal replay crossed its run scope"), { code: "MEMORY_JOURNAL_REPLAY_SCOPE_CONFLICT" });
        }
        if (!Number.isSafeInteger(event.sequence) || event.sequence <= previousSequence) {
          throw Object.assign(new Error("Memory journal replay returned a non-monotonic cursor"), { code: "MEMORY_JOURNAL_REPLAY_CURSOR_INVALID" });
        }
        const result = await this.capture(event);
        if (result.status === "created") captured += 1;
        else replayed += 1;
        processed += 1;
        cursor = event.sequence;
        previousSequence = event.sequence;
        this.replayCursors.set(key, cursor);
        if (processed >= maxEvents) break;
      }

      // A full page means there may be another page. The next loop confirms
      // that without guessing from timing or from a browser-side count.
      if (events.length < limit || processed >= maxEvents) {
        hasMore = events.length >= limit && processed >= maxEvents;
        break;
      }
    }

    return { captured, replayed, lastSequence: cursor, hasMore };
  }
}

function requiredReplayIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw Object.assign(new Error(`Memory journal replay requires ${field}`), { code: "MEMORY_JOURNAL_REPLAY_INVALID" });
  return normalized;
}

function boundedReplayCursor(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw Object.assign(new Error("Memory journal replay cursor is invalid"), { code: "MEMORY_JOURNAL_REPLAY_INVALID" });
  return value;
}

function boundedReplayLimit(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isSafeInteger(value) || value < 1) throw Object.assign(new Error("Memory journal replay limit is invalid"), { code: "MEMORY_JOURNAL_REPLAY_INVALID" });
  return Math.min(value, 10_000);
}
