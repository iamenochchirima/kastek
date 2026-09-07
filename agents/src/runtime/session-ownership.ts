/**
 * Durable-session ownership seam.
 *
 * The interface deliberately separates turn admission from the execution
 * runtime. A later PostgreSQL or Temporal adapter can keep the same rules:
 * one current owner per session, ordered turns, expiring leases, and fencing
 * tokens that make stale writers fail closed.
 */

export type SessionKey = string & { readonly __sessionKey: unique symbol };
export type SessionOwnerId = string & { readonly __sessionOwnerId: unique symbol };
export type SessionTurnId = string & { readonly __sessionTurnId: unique symbol };
export type SessionFencingToken = string & { readonly __sessionFencingToken: unique symbol };

export function createSessionKey(value: string): SessionKey {
  return brandNonBlank(value, "session key") as SessionKey;
}

export function createSessionOwnerId(value: string): SessionOwnerId {
  return brandNonBlank(value, "session owner") as SessionOwnerId;
}

export function createSessionTurnId(value: string): SessionTurnId {
  return brandNonBlank(value, "session turn id") as SessionTurnId;
}

function brandNonBlank(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export type SessionTurnStatus = "queued" | "active" | "completed" | "failed";

export interface SessionTurn<TPayload> {
  readonly id: SessionTurnId;
  readonly sessionKey: SessionKey;
  readonly sequence: number;
  readonly requestedBy: SessionOwnerId;
  readonly payload: TPayload;
  readonly status: SessionTurnStatus;
  readonly enqueuedAt: number;
  readonly attempts: number;
}

export interface SessionLease {
  readonly sessionKey: SessionKey;
  readonly ownerId: SessionOwnerId;
  readonly fencingToken: SessionFencingToken;
  readonly generation: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
  readonly turnId: SessionTurnId;
}

export interface SessionLeaseRef {
  readonly sessionKey: SessionKey;
  readonly fencingToken: SessionFencingToken;
}

export interface AdmitSessionTurnInput<TPayload> {
  readonly sessionKey: SessionKey;
  readonly requestedBy: SessionOwnerId;
  readonly payload: TPayload;
  readonly turnId?: SessionTurnId;
}

export interface ClaimSessionTurnInput {
  readonly sessionKey: SessionKey;
  readonly ownerId: SessionOwnerId;
}

export interface SettleSessionTurnInput extends SessionLeaseRef {
  readonly turnId: SessionTurnId;
  readonly outcome: "completed" | "failed";
}

export const sessionAdmissionOutcomes = ["accepted", "queued", "busy", "rejected"] as const;
export type SessionAdmissionOutcome = (typeof sessionAdmissionOutcomes)[number];

export type SessionAdmissionRejectionCode =
  | "INVALID_SESSION_KEY"
  | "INVALID_REQUESTER"
  | "INVALID_OWNER"
  | "INVALID_TURN_ID"
  | "TURN_ID_REUSED";

export type SessionAdmission<TPayload> =
  | {
      readonly outcome: "accepted";
      readonly turn: SessionTurn<TPayload>;
      readonly lease: SessionLease;
      readonly queueLength: number;
    }
  | {
      readonly outcome: "queued";
      readonly turn: SessionTurn<TPayload>;
      readonly position: number;
      readonly activeOwner?: SessionOwnerId;
      readonly retryAt?: number;
    }
  | {
      readonly outcome: "busy";
      readonly reasonCode: "SESSION_BUSY" | "SESSION_QUEUE_EMPTY";
      readonly activeOwner?: SessionOwnerId;
      readonly retryAt?: number;
    }
  | {
      readonly outcome: "rejected";
      readonly reasonCode: SessionAdmissionRejectionCode;
      readonly message: string;
    };

export type SessionLeaseFailure =
  | {
      readonly outcome: "fenced";
      readonly reasonCode: "LEASE_NOT_CURRENT";
      readonly sessionKey: SessionKey;
      readonly fencingToken: SessionFencingToken;
    }
  | {
      readonly outcome: "expired";
      readonly reasonCode: "LEASE_EXPIRED";
      readonly sessionKey: SessionKey;
      readonly fencingToken: SessionFencingToken;
      readonly turnId: SessionTurnId;
    }
  | {
      readonly outcome: "rejected";
      readonly reasonCode: "TURN_MISMATCH";
      readonly message: string;
    };

export type SessionHeartbeatResult =
  | { readonly outcome: "renewed"; readonly lease: SessionLease }
  | SessionLeaseFailure;

export type SessionSettleResult<TPayload> =
  | {
      readonly outcome: "completed" | "failed";
      readonly turn: SessionTurn<TPayload>;
      readonly queueLength: number;
    }
  | SessionLeaseFailure;

export type SessionReleaseResult<TPayload> =
  | {
      readonly outcome: "released";
      readonly requeuedTurn: SessionTurn<TPayload>;
      readonly queueLength: number;
    }
  | SessionLeaseFailure;

export interface SessionSnapshot<TPayload> {
  readonly sessionKey: SessionKey;
  readonly active?: {
    readonly lease: SessionLease;
    readonly turn: SessionTurn<TPayload>;
  };
  readonly queued: readonly SessionTurn<TPayload>[];
  readonly nextSequence: number;
}

export interface SessionOwnership<TPayload> {
  /** Admit a new turn or append it to the session's FIFO queue. */
  admitTurn(input: AdmitSessionTurnInput<TPayload>): Promise<SessionAdmission<TPayload>>;
  /** Claim the oldest queued turn after the current owner releases or completes. */
  claimNext(input: ClaimSessionTurnInput): Promise<SessionAdmission<TPayload>>;
  /** Renew an unexpired lease. A stale or expired token never renews. */
  heartbeat(lease: SessionLeaseRef): Promise<SessionHeartbeatResult>;
  /** Mark the active turn terminal without allowing a stale owner to mutate it. */
  settleTurn(input: SettleSessionTurnInput): Promise<SessionSettleResult<TPayload>>;
  /** Release an active lease and put its unfinished turn back at the front. */
  releaseLease(lease: SessionLeaseRef): Promise<SessionReleaseResult<TPayload>>;
  /** Read the session state, reaping an expired owner before returning it. */
  inspect(sessionKey: SessionKey): Promise<SessionSnapshot<TPayload> | undefined>;
}
