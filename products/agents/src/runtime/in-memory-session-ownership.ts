import { randomUUID } from "node:crypto";
import {
  type AdmitSessionTurnInput,
  type ClaimSessionTurnInput,
  type SessionAdmission,
  type SessionFencingToken,
  type SessionHeartbeatResult,
  type SessionKey,
  type SessionLease,
  type SessionLeaseRef,
  type SessionOwnership,
  type SessionOwnerId,
  type SessionAdmissionLimitCode,
  type SessionQueueMetrics,
  type SessionQueueObserver,
  type SessionQueuePolicy,
  type SessionReleaseResult,
  type SessionSettleResult,
  type SessionSnapshot,
  type SessionTurn,
  type SessionTurnId,
  type SettleSessionTurnInput,
} from "./session-ownership";

export interface InMemorySessionOwnershipOptions {
  readonly leaseTtlMs?: number;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly queuePolicy?: SessionQueuePolicy;
  readonly onQueueObservation?: SessionQueueObserver;
}

interface MutableTurn<TPayload> extends SessionTurn<TPayload> {
  status: SessionTurn<TPayload>["status"];
  attempts: number;
}

interface MutableSession<TPayload> {
  sessionKey: SessionKey;
  nextSequence: number;
  nextGeneration: number;
  active?: {
    lease: MutableLease;
    turn: MutableTurn<TPayload>;
  };
  queue: MutableTurn<TPayload>[];
  completedTurnIds: Set<string>;
  staleOwnerCount: number;
}

interface MutableLease extends SessionLease {
  heartbeatAt: number;
  expiresAt: number;
}

/**
 * A deterministic adapter for the session ownership interface.
 *
 * It models the rules that a durable adapter must preserve, but it does not
 * pretend to survive a process restart. The injected clock makes expiry and
 * fencing tests exact rather than sleep-based.
 */
export class InMemorySessionOwnership<TPayload> implements SessionOwnership<TPayload> {
  private readonly sessions = new Map<string, MutableSession<TPayload>>();
  private readonly leaseTtlMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly queuePolicy: SessionQueuePolicy;
  private readonly onQueueObservation?: SessionQueueObserver;

  public constructor(options: InMemorySessionOwnershipOptions = {}) {
    const leaseTtlMs = options.leaseTtlMs ?? 30_000;
    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new TypeError("leaseTtlMs must be a finite positive number");
    }
    this.leaseTtlMs = leaseTtlMs;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.queuePolicy = normalizeQueuePolicy(options.queuePolicy);
    this.onQueueObservation = options.onQueueObservation;
  }

  public async admitTurn(input: AdmitSessionTurnInput<TPayload>): Promise<SessionAdmission<TPayload>> {
    const sessionKey = normalizeIdentity(input.sessionKey);
    const requester = normalizeIdentity(input.requestedBy);
    if (!sessionKey) {
      return { outcome: "rejected", reasonCode: "INVALID_SESSION_KEY", message: "Session key is required" };
    }
    if (!requester) {
      return { outcome: "rejected", reasonCode: "INVALID_REQUESTER", message: "Turn requester is required" };
    }

    const now = this.readNow();
    const state = this.stateFor(sessionKey);
    this.reapExpired(state, now);
    const requestedTurnId = input.turnId === undefined ? this.nextId("turn") : normalizeIdentity(input.turnId);
    if (!requestedTurnId) {
      return { outcome: "rejected", reasonCode: "INVALID_TURN_ID", message: "Turn id is required" };
    }

    const existing = this.findOpenTurn(state, requestedTurnId);
    if (existing) {
      if (existing.requestedBy !== requester) {
        return { outcome: "rejected", reasonCode: "TURN_ID_REUSED", message: `Turn ${requestedTurnId} belongs to another requester` };
      }
      if (state.active?.turn.id === requestedTurnId && state.active) {
        const result = this.accepted(state.active.turn, state.active.lease, state.queue.length, now, state);
        this.observe(state, "admission", result.outcome, now);
        return result;
      }
      const result = this.queued(existing, state, now);
      this.observe(state, "admission", result.outcome, now);
      return result;
    }
    if (state.completedTurnIds.has(requestedTurnId)) {
      this.observe(state, "admission", "rejected", now, "TURN_ID_REUSED");
      return { outcome: "rejected", reasonCode: "TURN_ID_REUSED", message: `Turn ${requestedTurnId} has already settled` };
    }

    if (state.active || state.queue.length > 0) {
      const limit = this.queueLimit(state, now);
      if (limit) {
        const result = this.limited(state, now, limit);
        this.observe(state, "admission", result.outcome, now, result.reasonCode);
        return result;
      }
    }

    const turn: MutableTurn<TPayload> = {
      id: requestedTurnId as SessionTurnId,
      sessionKey: sessionKey as SessionKey,
      sequence: state.nextSequence++,
      requestedBy: requester as SessionOwnerId,
      payload: input.payload,
      status: "queued",
      enqueuedAt: now,
      attempts: 0,
    };
    if (state.active || state.queue.length > 0) {
      state.queue.push(turn);
      const result = this.queued(turn, state, now);
      this.observe(state, "admission", result.outcome, now);
      return result;
    }

    const lease = this.activate(state, turn, requester as SessionOwnerId, now);
    const result = this.accepted(turn, lease, state.queue.length, now, state);
    this.observe(state, "admission", result.outcome, now);
    return result;
  }

  public async claimNext(input: ClaimSessionTurnInput): Promise<SessionAdmission<TPayload>> {
    const sessionKey = normalizeIdentity(input.sessionKey);
    const ownerId = normalizeIdentity(input.ownerId);
    if (!sessionKey) {
      return { outcome: "rejected", reasonCode: "INVALID_SESSION_KEY", message: "Session key is required" };
    }
    if (!ownerId) {
      return { outcome: "rejected", reasonCode: "INVALID_OWNER", message: "Session owner is required" };
    }

    const now = this.readNow();
    const state = this.sessions.get(sessionKey);
    if (!state) {
      return { outcome: "busy", reasonCode: "SESSION_QUEUE_EMPTY" };
    }
    this.reapExpired(state, now);
    if (state.active) {
      const result = {
        outcome: "busy" as const,
        reasonCode: "SESSION_BUSY" as const,
        activeOwner: state.active.lease.ownerId,
        retryAt: state.active.lease.expiresAt,
      };
      this.observe(state, "claim", result.outcome, now, result.reasonCode);
      return result;
    }
    const turn = state.queue.shift();
    if (!turn) {
      const result = { outcome: "busy" as const, reasonCode: "SESSION_QUEUE_EMPTY" as const };
      this.observe(state, "claim", result.outcome, now, result.reasonCode);
      return result;
    }
    const lease = this.activate(state, turn, ownerId as SessionOwnerId, now);
    const result = this.accepted(turn, lease, state.queue.length, now, state);
    this.observe(state, "claim", result.outcome, now);
    return result;
  }

  public async heartbeat(lease: SessionLeaseRef): Promise<SessionHeartbeatResult> {
    const state = this.sessions.get(normalizeIdentity(lease.sessionKey));
    if (!state?.active || state.active.lease.fencingToken !== lease.fencingToken) {
      return this.fenced(lease);
    }
    const now = this.readNow();
    if (now >= state.active.lease.expiresAt) {
      const expired = state.active.lease;
      this.reapExpired(state, now);
      return this.expired(expired);
    }
    state.active.lease.heartbeatAt = now;
    state.active.lease.expiresAt = now + this.leaseTtlMs;
    const result = { outcome: "renewed" as const, lease: snapshotLease(state.active.lease) };
    this.observe(state, "heartbeat", "accepted", now);
    return result;
  }

  public async settleTurn(input: SettleSessionTurnInput): Promise<SessionSettleResult<TPayload>> {
    const state = this.sessions.get(normalizeIdentity(input.sessionKey));
    if (!state?.active || state.active.lease.fencingToken !== input.fencingToken) {
      return this.fenced(input);
    }
    const now = this.readNow();
    if (now >= state.active.lease.expiresAt) {
      const expired = state.active.lease;
      this.reapExpired(state, now);
      return this.expired(expired);
    }
    if (state.active.turn.id !== input.turnId) {
      return { outcome: "rejected", reasonCode: "TURN_MISMATCH", message: "Lease does not own the requested turn" };
    }

    const turn = state.active.turn;
    turn.status = input.outcome;
    state.completedTurnIds.add(turn.id);
    state.active = undefined;
    this.observe(state, "settle", "accepted", now);
    return { outcome: input.outcome, turn: snapshotTurn(turn), queueLength: state.queue.length };
  }

  public async releaseLease(lease: SessionLeaseRef): Promise<SessionReleaseResult<TPayload>> {
    const state = this.sessions.get(normalizeIdentity(lease.sessionKey));
    if (!state?.active || state.active.lease.fencingToken !== lease.fencingToken) {
      return this.fenced(lease);
    }
    const now = this.readNow();
    if (now >= state.active.lease.expiresAt) {
      const expired = state.active.lease;
      this.reapExpired(state, now);
      return this.expired(expired);
    }

    const turn = state.active.turn;
    turn.status = "queued";
    state.queue.unshift(turn);
    state.active = undefined;
    const result = { outcome: "released" as const, requeuedTurn: snapshotTurn(turn), queueLength: state.queue.length };
    this.observe(state, "release", "queued", now);
    return result;
  }

  public async inspect(sessionKey: SessionKey): Promise<SessionSnapshot<TPayload> | undefined> {
    const normalized = normalizeIdentity(sessionKey);
    const state = this.sessions.get(normalized);
    if (!state) return undefined;
    const now = this.readNow();
    this.reapExpired(state, now);
    return {
      sessionKey: normalized as SessionKey,
      ...(state.active ? { active: { lease: snapshotLease(state.active.lease), turn: snapshotTurn(state.active.turn) } } : {}),
      queued: state.queue.map(snapshotTurn),
      nextSequence: state.nextSequence,
      queueMetrics: this.metrics(state, now),
    };
  }

  private stateFor(sessionKey: string): MutableSession<TPayload> {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;
    const created: MutableSession<TPayload> = {
      sessionKey: sessionKey as SessionKey,
      nextSequence: 1,
      nextGeneration: 0,
      queue: [],
      completedTurnIds: new Set(),
      staleOwnerCount: 0,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  private activate(state: MutableSession<TPayload>, turn: MutableTurn<TPayload>, ownerId: SessionOwnerId, now: number): MutableLease {
    turn.status = "active";
    turn.attempts += 1;
    const lease: MutableLease = {
      sessionKey: turn.sessionKey,
      ownerId,
      fencingToken: this.nextId("lease") as SessionFencingToken,
      generation: ++state.nextGeneration,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + this.leaseTtlMs,
      turnId: turn.id,
    };
    state.active = { lease, turn };
    return lease;
  }

  private reapExpired(state: MutableSession<TPayload>, now: number): void {
    if (!state.active || now < state.active.lease.expiresAt) return;
    const turn = state.active.turn;
    turn.status = "queued";
    state.queue.unshift(turn);
    state.active = undefined;
    state.staleOwnerCount += 1;
    this.observe(state, "lease_expired", "queued", now, "STALE_OWNER_REAPED");
  }

  private findOpenTurn(state: MutableSession<TPayload>, turnId: string): MutableTurn<TPayload> | undefined {
    if (state.active?.turn.id === turnId) return state.active.turn;
    return state.queue.find((turn) => turn.id === turnId);
  }

  private accepted(turn: MutableTurn<TPayload>, lease: MutableLease, queueLength: number, now: number, state: MutableSession<TPayload>): SessionAdmission<TPayload> {
    return { outcome: "accepted", turn: snapshotTurn(turn), lease: snapshotLease(lease), queueLength, queueMetrics: this.metrics(state, now) };
  }

  private queued(turn: MutableTurn<TPayload>, state: MutableSession<TPayload>, now: number): SessionAdmission<TPayload> {
    const position = state.queue.findIndex((queued) => queued.id === turn.id) + 1;
    return {
      outcome: "queued",
      turn: snapshotTurn(turn),
      position: Math.max(position, 1),
      ...(state.active ? { activeOwner: state.active.lease.ownerId, retryAt: state.active.lease.expiresAt } : {}),
      queueLength: state.queue.length,
      queueMetrics: this.metrics(state, now),
    };
  }

  private limited(state: MutableSession<TPayload>, now: number, reasonCode: SessionAdmissionLimitCode): Extract<SessionAdmission<TPayload>, { outcome: "limited" }> {
    const metrics = this.metrics(state, now);
    return {
      outcome: "limited",
      reasonCode,
      message: reasonCode === "QUEUE_DEPTH_LIMIT"
        ? "Session queue depth limit reached"
        : "Session queue age limit reached",
      queueLength: state.queue.length,
      queueMetrics: metrics,
      ...(state.active ? { retryAt: state.active.lease.expiresAt } : {}),
    };
  }

  private queueLimit(state: MutableSession<TPayload>, now: number): SessionAdmissionLimitCode | undefined {
    if (this.queuePolicy.maxDepth !== undefined && state.queue.length >= this.queuePolicy.maxDepth) return "QUEUE_DEPTH_LIMIT";
    if (this.queuePolicy.maxAgeMs !== undefined && state.queue.length > 0 && (this.metrics(state, now).queueAgeMs ?? 0) >= this.queuePolicy.maxAgeMs) {
      return "QUEUE_AGE_LIMIT";
    }
    return undefined;
  }

  private metrics(state: MutableSession<TPayload>, now: number): SessionQueueMetrics {
    const oldest = state.queue.reduce<number | undefined>(
      (current, turn) => current === undefined ? turn.enqueuedAt : Math.min(current, turn.enqueuedAt),
      undefined,
    );
    return {
      queueDepth: state.queue.length,
      ...(oldest === undefined ? {} : { oldestQueuedAt: oldest }),
      queueAgeMs: oldest === undefined ? 0 : Math.max(0, now - oldest),
      staleOwnerCount: state.staleOwnerCount,
      ...(state.active ? { activeOwner: state.active.lease.ownerId, activeExpiresAt: state.active.lease.expiresAt } : {}),
    };
  }

  private observe(
    state: MutableSession<TPayload>,
    event: Parameters<NonNullable<SessionQueueObserver>>[0]["event"],
    outcome: Parameters<NonNullable<SessionQueueObserver>>[0]["outcome"],
    now: number,
    reasonCode?: string,
  ): void {
    if (!this.onQueueObservation) return;
    try {
      this.onQueueObservation({
        event,
        sessionKey: state.sessionKey,
        outcome,
        ...(reasonCode ? { reasonCode } : {}),
        metrics: this.metrics(state, now),
      });
    } catch {
      // Telemetry must never change session ownership or admission behaviour.
    }
  }

  private fenced(lease: SessionLeaseRef): Extract<SessionHeartbeatResult, { outcome: "fenced" }> {
    return {
      outcome: "fenced",
      reasonCode: "LEASE_NOT_CURRENT",
      sessionKey: lease.sessionKey,
      fencingToken: lease.fencingToken,
    };
  }

  private expired(lease: SessionLease): Extract<SessionHeartbeatResult, { outcome: "expired" }> {
    return {
      outcome: "expired",
      reasonCode: "LEASE_EXPIRED",
      sessionKey: lease.sessionKey,
      fencingToken: lease.fencingToken,
      turnId: lease.turnId,
    };
  }

  private nextId(prefix: string): string {
    const generated = this.idFactory().trim();
    if (!generated) throw new Error("Session ownership id factory returned an empty id");
    return `${prefix}:${generated}`;
  }

  private readNow(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error("Session ownership clock returned a non-finite value");
    return now;
  }
}

function normalizeQueuePolicy(policy: SessionQueuePolicy | undefined): SessionQueuePolicy {
  if (!policy) return {};
  if (policy.maxDepth !== undefined && (!Number.isSafeInteger(policy.maxDepth) || policy.maxDepth < 0)) {
    throw new TypeError("queuePolicy.maxDepth must be a non-negative safe integer");
  }
  if (policy.maxAgeMs !== undefined && (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0)) {
    throw new TypeError("queuePolicy.maxAgeMs must be a positive safe integer");
  }
  return { ...policy };
}

function normalizeIdentity(value: string): string {
  return typeof value === "string" ? value.trim() : "";
}

function snapshotTurn<TPayload>(turn: MutableTurn<TPayload>): SessionTurn<TPayload> {
  return { ...turn };
}

function snapshotLease(lease: MutableLease): SessionLease {
  return { ...lease };
}
