import { z } from "zod";

export const agentAdmissionOutcomeSchema = z.enum(["accepted", "queued", "limited", "rejected"]);
export type AgentAdmissionOutcome = z.infer<typeof agentAdmissionOutcomeSchema>;

/**
 * One session is serialized by the durable run coordinator. A second message
 * is accepted into the run queue while different sessions continue in
 * parallel. The queue is not an in-memory worker queue: Temporal keeps the
 * waiting workflow durable and PostgreSQL decides which run owns the turn.
 */
export const sameSessionSerializationPolicy = Object.freeze({
  version: "same-session-v2",
  mode: "queue-by-conversation" as const,
  queueing: "durable" as const,
  retryable: false as const,
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
    retryable: input.retryable ?? input.policy?.retryable ?? input.outcome === "queued",
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
  };
}
