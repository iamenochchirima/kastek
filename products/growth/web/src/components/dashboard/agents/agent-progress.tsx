import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { growthAgents, taskStateLabel, type GrowthAgentTask, type GrowthAgentEvent } from "@/lib/growth-agents";

export function AgentProgress({ task }: { task: GrowthAgentTask }) {
  const record = task.orchestration?.record;
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [output, setOutput] = useState("");
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const load = async (child: { id: string; name: string }, offset = 0) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setSelected(child); setBusy(true); setError(null);
    if (!offset) { setOutput(""); setNextOffset(null); }
    try {
      const result = await growthAgents.specialistResult(task.id, child.id, offset, abort.signal);
      if (!abort.signal.aborted) { setOutput(previous => offset ? previous + (result.output || "") : result.output || ""); setNextOffset(result.nextOffset); if (!result.available) setError("Result is unavailable."); }
    } catch { if (!abort.signal.aborted) { setOutput(""); setNextOffset(null); setError("Unable to open this result."); } }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  if (!record && !task.children?.length) return null;
  return <><section aria-label="Work progress" className="min-w-0 rounded-lg border border-border p-3 text-sm">
    {record ? <details open><summary className="cursor-pointer font-medium">Work progress</summary><div className="mt-3 space-y-3">
      <p className="whitespace-pre-wrap break-words">{record.objective}</p>
      {record.steps.length ? <ol aria-label="Work steps" className="space-y-2">{record.steps.map(step => <li key={step.id} className="flex flex-wrap justify-between gap-x-3 gap-y-1"><span className="min-w-0 break-words">{step.title}</span><span className="text-xs text-muted-foreground">{step.state.replaceAll("_", " ")}</span></li>)}</ol> : null}
      {record.questions.length ? <div className="space-y-1"><h3 className="text-xs font-medium text-muted-foreground">Open questions</h3><ul className="list-inside list-disc space-y-1">{record.questions.map((question, index) => <li key={index} className="break-words">{question}</li>)}</ul></div> : null}
    </div></details> : null}
    {task.children?.length ? <section aria-label="Specialist work" className={record ? "mt-3 border-t border-border pt-3" : ""}><h3 className="mb-2 text-xs font-medium text-muted-foreground">Specialists</h3><ul className="space-y-2">{task.children.map(child => <li key={child.id} className="flex flex-wrap justify-between gap-x-3 gap-y-1"><span className="min-w-0 break-words">{child.name}</span><div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{taskStateLabel[child.state]}</span>{["completed", "incomplete", "failed", "cancelled", "uncertain", "refused"].includes(child.state) ? <Button variant="ghost" size="sm" aria-label={`View ${child.name} result`} onClick={() => void load(child)}>View result</Button> : null}</div></li>)}</ul></section> : null}
  </section><Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) { controller.current?.abort(); setSelected(null); setOutput(""); setError(null); setBusy(false); } }}><DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden sm:max-w-2xl"><DialogHeader><DialogTitle>{selected?.name} result</DialogTitle><DialogDescription className="sr-only">Specialist work</DialogDescription></DialogHeader><div className="min-h-0 space-y-4 overflow-y-auto">{output ? <p className="whitespace-pre-wrap break-words text-sm">{output}</p> : null}{busy ? <p role="status" className="text-sm text-muted-foreground">Loading result…</p> : null}{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}{nextOffset !== null ? <Button variant="outline" disabled={busy} onClick={() => selected && void load(selected, nextOffset)}>Load more</Button> : null}</div></DialogContent></Dialog></>;
}

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
  "accepted": "Request accepted", "work.updated": "Plan updated", "work.instruction_queued": "Instructions queued",
  "children.admitted": "Specialist work started", "specialists.budget_wait": "Waiting for specialist work",
  "authority.required": "Access required", "work.continued": "Work continued", "work.paused": "Work paused", "cancel_requested": "Stopping", "completed": "Completed",
  "incomplete": "Incomplete", "failed": "Failed", "cancelled": "Cancelled", "uncertain": "Outcome unknown",
};
export function activityLabel(event: GrowthAgentEvent) {
  return (event.message && event.message !== "Task updated" ? event.message : undefined) || (event.state ? taskStateLabel[event.state] : activityLabels[event.type]) || "Working";
}
