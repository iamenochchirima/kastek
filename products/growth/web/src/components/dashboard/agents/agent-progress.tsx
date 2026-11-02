import type { GrowthAgentTask, GrowthAgentEvent } from "@/lib/growth-agents";
import { taskStateLabel } from "@/lib/growth-agents";

const failures: Record<string, string> = {
  CAPACITY_WAIT_EXPIRED: "The task waited too long to start. Try a new message.",
  CHILD_OUTCOME_UNCERTAIN: "A specialist outcome could not be confirmed. Review its result before repeating work.",
  ROOT_LIMIT: "An execution limit was reached.",
  MODEL_CALL_LIMIT: "This agent reached its model request limit.",
  ROOT_MODEL_CALL_LIMIT: "This work reached its shared model request limit.",
  TOOL_CALL_LIMIT: "This agent reached its tool call limit.",
  ROOT_TOOL_CALL_LIMIT: "This work reached its shared tool call limit.",
  SPECIALIST_TASK_LIMIT: "The specialist task limit was reached.",
  ROOT_TOKEN_LIMIT: "This work reached its token allowance.",
  TASK_TOKEN_LIMIT: "This agent reached its token allowance.",
  MODEL_COST_LIMIT: "The model spending allowance was reached.",
  SPECIALIST_ALLOCATION_LIMIT: "The specialist allocation cannot cover the next operation.",
  QUOTA_EXCEEDED: "The organization usage allowance was reached.",
  ROOT_DURATION_LIMIT: "This work reached its active time allowance.",
  TASK_DURATION_LIMIT: "This agent reached its active time allowance.",
  AUTHORITY_EXPIRED: "Task access expired.",
  PRODUCT_AUTHORITY_INACTIVE: "Task access expired or was revoked.",
  CONTEXT_CAPACITY: "The next request could not fit the model context.",
  COMPACTION_INPUT_LIMIT: "The conversation could not be compacted within the model context.",
  COMPACTION_NO_PROGRESS: "Context compaction could not make room for more work.",
  MODEL_RATE_LIMITED: "The model provider is busy. Try again later.",
  CONTEXT_LIMIT: "The request exceeded the available context. Try a smaller request.",
  ORCHESTRATION_STALLED: "Progress paused after repeated unsuccessful attempts.",
  TASK_DEADLINE: "The task reached its time limit.",
  MODEL_PROVIDER_UNAVAILABLE: "The model is unavailable. Try again later.",
  MODEL_ACCESS_DENIED: "The model provider denied access to this model.",
  MODEL_REQUEST_INVALID: "The model provider rejected this request.",
  MODEL_AUTHENTICATION_FAILED: "The model provider rejected authentication.",
  MODEL_USE_DENIED: "This agent is not authorized to use the model connection.",
  INTERNAL_ERROR: "The task could not finish. Try a new message.",
  CHILD_PARTIAL_FAILURE: "Some specialist work could not finish.",
  GRANT_REVOKED: "Task access was revoked.",
};
export function taskFailureLabel(task: GrowthAgentTask) {
  const code = task.boundary?.reason ?? task.errorCode;
  if (code === "CHILD_OUTCOME_UNCERTAIN") return failures.CHILD_OUTCOME_UNCERTAIN;
  if (task.state === "uncertain" && code?.startsWith("MODEL_")) return "The model response was interrupted. Review completed work before continuing.";
  if (task.state === "uncertain") return "Outcome unknown. An action may have completed. Check its result before repeating it.";
  return code && failures[code] ? failures[code] : taskStateLabel[task.state];
}
const activityLabels: Record<string, string> = {
  "context.prepared": "Context prepared", "operation.started": "Operation started", "operation.completed": "Operation completed",
  "operation.failed": "Operation failed", "operation.uncertain": "Operation outcome unknown", "model.observed": "Model timing recorded",
  "accepted": "Request accepted", "work.updated": "Plan updated", "work.instruction_queued": "Instructions queued",
  "children.admitted": "Specialist work started", "specialists.budget_wait": "Waiting for specialist work",
  "authority.required": "Access required", "work.continued": "Work continued", "work.paused": "Work paused", "cancel_requested": "Stopping", "completed": "Completed",
  "incomplete": "Incomplete", "failed": "Failed", "cancelled": "Cancelled", "uncertain": "Outcome unknown",
};
export function activityLabel(event: GrowthAgentEvent) {
  return (event.message && event.message !== "Task updated" ? event.message : undefined) || (event.state ? taskStateLabel[event.state] : activityLabels[event.type]) || "Working";
}
