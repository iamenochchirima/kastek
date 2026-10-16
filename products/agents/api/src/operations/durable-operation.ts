import { createHash } from "node:crypto";

/**
 * The common lifecycle for work whose provider side effect may outlive the
 * worker that started it. The operation key is the replay boundary; callers
 * must never generate a new key merely because an activity was retried.
 */
export type DurableOperationKind =
  | "model"
  | "native_tool"
  | "mcp"
  | "plugin"
  | "child"
  | "approval"
  | "delivery"
  | "context"
  | "session";

export type DurableOperationStatus =
  | "proposed"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "unknown";

export interface DurableOperationIdentity {
  organizationId: string;
  installationId?: string;
  runId?: string;
  sessionKey?: string;
  kind: DurableOperationKind;
  operationKey: string;
  requestFingerprint: string;
}

export interface DurableOperationRecord extends DurableOperationIdentity {
  id: string;
  status: DurableOperationStatus;
  attempt: number;
  providerRequestId?: string;
  responseReceipt?: Record<string, unknown>;
  error?: { code: string; message: string; retryable?: boolean };
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type DurableOperationPreparation =
  | { outcome: "new"; operation: DurableOperationRecord }
  | { outcome: "completed"; operation: DurableOperationRecord }
  | { outcome: "unknown"; operation: DurableOperationRecord }
  | { outcome: "in_progress"; operation: DurableOperationRecord };

export interface DurableOperationStore {
  prepare(input: DurableOperationIdentity & { metadata?: Record<string, unknown> }): Promise<DurableOperationPreparation>;
  markRunning(input: { operationId: string; providerRequestId?: string }): Promise<DurableOperationRecord>;
  complete(input: { operationId: string; responseReceipt?: unknown }): Promise<DurableOperationRecord>;
  fail(input: { operationId: string; error: { code: string; message: string; retryable?: boolean } }): Promise<DurableOperationRecord>;
  interrupt(input: { operationId: string; error?: { code: string; message: string } }): Promise<DurableOperationRecord>;
  markUnknown(input: { operationId: string; error: { code: string; message: string } }): Promise<DurableOperationRecord>;
  reconcile(input: { operationId: string; outcome: "completed" | "failed"; responseReceipt?: unknown; error?: { code: string; message: string } }): Promise<DurableOperationRecord>;
  get(operationId: string): Promise<DurableOperationRecord | undefined>;
}

export class DurableOperationConflict extends Error {
  public readonly code = "DURABLE_OPERATION_IDENTITY_CONFLICT";

  public constructor(message = "Operation key was reused for a different request") {
    super(message);
    this.name = "DurableOperationConflict";
  }
}

export class DurableOperationCoordinator {
  public constructor(private readonly store: DurableOperationStore) {}

  public prepare(input: DurableOperationIdentity & { metadata?: Record<string, unknown> }): Promise<DurableOperationPreparation> {
    return this.store.prepare(input);
  }

  public markRunning(input: { operationId: string; providerRequestId?: string }): Promise<DurableOperationRecord> {
    return this.store.markRunning(input);
  }

  public complete(input: { operationId: string; responseReceipt?: unknown }): Promise<DurableOperationRecord> {
    return this.store.complete(input);
  }

  public fail(input: { operationId: string; error: { code: string; message: string; retryable?: boolean } }): Promise<DurableOperationRecord> {
    return this.store.fail(input);
  }

  public interrupt(input: { operationId: string; error?: { code: string; message: string } }): Promise<DurableOperationRecord> {
    return this.store.interrupt(input);
  }

  public markUnknown(input: { operationId: string; error: { code: string; message: string } }): Promise<DurableOperationRecord> {
    return this.store.markUnknown(input);
  }

  public reconcile(input: { operationId: string; outcome: "completed" | "failed"; responseReceipt?: unknown; error?: { code: string; message: string } }): Promise<DurableOperationRecord> {
    return this.store.reconcile(input);
  }

  public get(operationId: string): Promise<DurableOperationRecord | undefined> {
    return this.store.get(operationId);
  }
}

function now(): string {
  return new Date().toISOString();
}

function operationId(identity: DurableOperationIdentity): string {
  return createHash("sha256")
    .update(`${identity.organizationId}:${identity.kind}:${identity.operationKey}`)
    .digest("hex");
}

function boundedRecord(value: unknown, maxBytes = 64 * 1024): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value ?? {});
  if (Buffer.byteLength(json, "utf8") > maxBytes) throw new Error("DURABLE_OPERATION_RECEIPT_TOO_LARGE");
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value };
  return value as Record<string, unknown>;
}

function normalizeIdentity(input: DurableOperationIdentity): DurableOperationIdentity {
  const organizationId = input.organizationId.trim();
  const operationKey = input.operationKey.trim();
  const requestFingerprint = input.requestFingerprint.trim();
  if (!organizationId || !operationKey || !requestFingerprint) throw new Error("DURABLE_OPERATION_IDENTITY_INVALID");
  if (operationKey.length > 240 || requestFingerprint.length > 240) throw new Error("DURABLE_OPERATION_IDENTITY_INVALID");
  return {
    ...input,
    organizationId,
    operationKey,
    requestFingerprint,
    ...(input.installationId ? { installationId: input.installationId.trim() } : {}),
    ...(input.runId ? { runId: input.runId.trim() } : {}),
    ...(input.sessionKey ? { sessionKey: input.sessionKey.trim() } : {}),
  };
}

/** A deterministic fingerprint for request envelopes that excludes credentials. */
export function fingerprintOperationRequest(value: unknown): string {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)]));
    }
    return input;
  };
  return createHash("sha256").update(JSON.stringify(stable(value ?? null))).digest("hex");
}

/**
 * In-memory conformance adapter. It is deliberately strict so unit tests catch
 * replay and lifecycle mistakes before a PostgreSQL integration run exists.
 */
export class InMemoryDurableOperationStore implements DurableOperationStore {
  private readonly records = new Map<string, DurableOperationRecord>();

  async prepare(input: DurableOperationIdentity & { metadata?: Record<string, unknown> }): Promise<DurableOperationPreparation> {
    const identity = normalizeIdentity(input);
    const id = operationId(identity);
    const existing = this.records.get(id);
    if (existing) {
      if (existing.requestFingerprint !== identity.requestFingerprint
        || existing.organizationId !== identity.organizationId
        || existing.operationKey !== identity.operationKey
        || existing.kind !== identity.kind) throw new DurableOperationConflict();
      if (existing.status === "completed") return { outcome: "completed", operation: existing };
      if (existing.status === "unknown") return { outcome: "unknown", operation: existing };
      if (existing.status === "running" || existing.status === "proposed") return { outcome: "in_progress", operation: existing };
      const restarted = { ...existing, status: "proposed" as const, error: undefined, updatedAt: now() };
      this.records.set(id, restarted);
      return { outcome: "new", operation: restarted };
    }
    const created: DurableOperationRecord = {
      ...identity,
      id,
      status: "proposed",
      attempt: 0,
      metadata: { ...(input.metadata ?? {}) },
      createdAt: now(),
      updatedAt: now(),
    };
    this.records.set(id, created);
    return { outcome: "new", operation: created };
  }

  async markRunning(input: { operationId: string; providerRequestId?: string }): Promise<DurableOperationRecord> {
    const record = this.require(input.operationId);
    if (record.status === "completed") return record;
    if (record.status === "unknown") throw new Error("DURABLE_OPERATION_OUTCOME_UNKNOWN");
    const updated = { ...record, status: "running" as const, attempt: record.attempt + 1, updatedAt: now(), ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}) };
    this.records.set(record.id, updated);
    return updated;
  }

  async complete(input: { operationId: string; responseReceipt?: unknown }): Promise<DurableOperationRecord> {
    const record = this.require(input.operationId);
    if (record.status === "completed") return record;
    const updated = { ...record, status: "completed" as const, responseReceipt: boundedRecord(input.responseReceipt), error: undefined, completedAt: now(), updatedAt: now() };
    this.records.set(record.id, updated);
    return updated;
  }

  async fail(input: { operationId: string; error: { code: string; message: string; retryable?: boolean } }): Promise<DurableOperationRecord> {
    const record = this.require(input.operationId);
    const updated = { ...record, status: "failed" as const, error: input.error, completedAt: now(), updatedAt: now() };
    this.records.set(record.id, updated);
    return updated;
  }

  async interrupt(input: { operationId: string; error?: { code: string; message: string } }): Promise<DurableOperationRecord> {
    const record = this.require(input.operationId);
    const updated = { ...record, status: "interrupted" as const, error: input.error, updatedAt: now() };
    this.records.set(record.id, updated);
    return updated;
  }

  async markUnknown(input: { operationId: string; error: { code: string; message: string } }): Promise<DurableOperationRecord> {
    const record = this.require(input.operationId);
    const updated = { ...record, status: "unknown" as const, error: input.error, updatedAt: now() };
    this.records.set(record.id, updated);
    return updated;
  }

  async reconcile(input: { operationId: string; outcome: "completed" | "failed"; responseReceipt?: unknown; error?: { code: string; message: string } }): Promise<DurableOperationRecord> {
    const record = this.require(input.operationId);
    if (record.status !== "unknown") throw new Error("DURABLE_OPERATION_NOT_PENDING_RECONCILIATION");
    return input.outcome === "completed"
      ? this.complete({ operationId: input.operationId, responseReceipt: input.responseReceipt })
      : this.fail({ operationId: input.operationId, error: input.error ?? { code: "OPERATION_RECONCILED_FAILED", message: "Provider operation failed" } });
  }

  async get(operationIdValue: string): Promise<DurableOperationRecord | undefined> {
    return this.records.get(operationIdValue);
  }

  private require(id: string): DurableOperationRecord {
    const record = this.records.get(id);
    if (!record) throw new Error("DURABLE_OPERATION_NOT_FOUND");
    return record;
  }
}
