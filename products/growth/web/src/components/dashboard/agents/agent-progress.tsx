import { agentFailureLabel } from "@kasitek-labs/ui/agent";
import type { GrowthAgentTask, GrowthAgentEvent } from "@/lib/growth-agents";
import { taskStateLabel } from "@/lib/growth-agents";

export function taskFailureLabel(task: GrowthAgentTask) {
  return agentFailureLabel(task.state,task.boundary?.reason??task.errorCode);
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
