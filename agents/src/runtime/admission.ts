import { z } from "zod";

export const agentAdmissionOutcomeSchema = z.enum(["accepted", "queued", "limited", "rejected"]);
export type AgentAdmissionOutcome = z.infer<typeof agentAdmissionOutcomeSchema>;

/**
 * The first-chunk policy is explicit: an active conversation is rejected and
 * retried by the caller. Durable queueing is intentionally a later session
 * coordination chunk, so it cannot be mistaken for an accidental 409.
 */
export const sameSessionSerializationPolicy = Object.freeze({
  version: "same-session-v1",
  mode: "reject-active-run" as const,
  queueing: "deferred" as const,
  retryable: true as const,
});

export interface AgentAdmissionDecision {
  outcome: AgentAdmissionOutcome;
  policy?: typeof sameSessionSerializationPolicy;
  retryable: boolean;
  reasonCode?: string;
}

export function admissionDecision(input: {
  outcome: AgentAdmissionOutcome;
  reasonCode?: string;
  retryable?: boolean;
  policy?: typeof sameSessionSerializationPolicy;
}): AgentAdmissionDecision {
  return {
    outcome: input.outcome,
    retryable: input.retryable ?? input.outcome === "queued",
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
  };
}

