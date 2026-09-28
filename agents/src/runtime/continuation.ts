import type { AgentLoopResult } from "./loop";

/**
 * The durable boundary between one harness turn and its workflow owner.
 *
 * The loop may retain model-facing messages for the next turn, but callers do
 * not infer lifecycle state from arbitrary fields on that result. This union
 * is deliberately small enough for Temporal, HTTP, graph, and child callers
 * to make the same transition decision.
 */
export type AgentHarnessContinuation =
  | { readonly status: "completed"; readonly result: AgentLoopResult }
  | { readonly status: "waiting"; readonly reason: "approval" | "human" | "external_event"; readonly waitingFor?: string; readonly result: AgentLoopResult }
  | { readonly status: "limited"; readonly code: string; readonly result: AgentLoopResult }
  | { readonly status: "failed"; readonly code: string; readonly result: AgentLoopResult }
  | { readonly status: "cancelled"; readonly reason?: string }
  | { readonly status: "reconciliation_required"; readonly code: string; readonly result: AgentLoopResult };

const reconciliationCodes = new Set([
  "EFFECT_OUTCOME_UNKNOWN",
  "MODEL_OUTCOME_UNKNOWN",
  "DELIVERY_OUTCOME_UNKNOWN",
  "EFFECT_RECONCILIATION_REQUIRED",
]);

/** Convert a loop result into the only continuation vocabulary workflow owners use. */
export function continuationFromLoopResult(result: AgentLoopResult): AgentHarnessContinuation {
  if (result.status === "completed") return { status: "completed", result };
  if (result.status === "awaiting_approval") return { status: "waiting", reason: "approval", waitingFor: result.waitingFor, result };
  if (result.status === "awaiting_human") return { status: "waiting", reason: "human", waitingFor: result.waitingFor, result };
  if (result.status === "awaiting_external_event") return { status: "waiting", reason: "external_event", waitingFor: result.waitingFor, result };
  if (result.status === "limited") return { status: "limited", code: result.error?.code ?? "HARNESS_LIMIT_REACHED", result };
  const code = result.error?.code ?? "HARNESS_TURN_FAILED";
  if (reconciliationCodes.has(code)) return { status: "reconciliation_required", code, result };
  return { status: "failed", code, result };
}
