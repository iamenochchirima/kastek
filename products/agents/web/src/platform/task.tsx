import "./management.css";
import { Link } from "react-router-dom";
import { TaskEvents } from "./task-events";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { api, ApiError, loadTaskDetail, message, organizationPath, terminal, type Task } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { TaskSources } from "./cited-passages";
import { cleanupPending, TaskActivity } from "./task-activity";

export function TaskPage() {
  const { taskId = "" } = useParams(), { organizationId } = useWorkspace();
  const endpoint = `${organizationPath(organizationId)}/tasks/${encodeURIComponent(taskId)}`;
  return <TaskDetailPage key={endpoint} endpoint={endpoint} />;
}
function TaskDetailPage({ endpoint }: { endpoint: string }) {
  const [task, setTask] = useState<Task | null>(null), [error, setError] = useState("");
  const [canControl, setCanControl] = useState(false);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => {
    let closed = false, unknownPolls = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const detail = await loadTaskDetail(endpoint);
        if (closed) return;
        const current = { ...detail.task, operations: detail.operations, events: detail.events, children: detail.children, resources: detail.resources, artifacts: detail.canDownloadArtifacts === false ? [] : detail.artifacts, actions: detail.actions };
        setTask(current); setCanControl(detail.canControl !== false); setEventsCursor(detail.eventsNextCursor ?? null); setError("");
        const uncertain = current.state === "uncertain" || current.resources?.some(resource => resource.cleanupState === "uncertain") || current.actions?.some(action => action.state === "uncertain");
        if (uncertain && ++unknownPolls >= 3) return;
        if (terminal(current.state) && !cleanupPending(current) && !current.actions?.some(action => ["approved", "claimed"].includes(action.state))) return;
      } catch (e) { if (closed) return; setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setTask(null); setCanControl(false); return; } }
      timer = setTimeout(() => void poll(), 1200);
    }
    void poll(); return () => { closed = true; clearTimeout(timer); };
  }, [endpoint, generation]);
  async function control(action: "cancel" | "continue") {
    setBusy(true); setError("");
    try { await api(`${endpoint}/${action}`, {}); setGeneration(value => value + 1); }
    catch (e) { setError(message(e)); if (e instanceof ApiError && [401,403,404].includes(e.status)) { setTask(null); setCanControl(false); } } finally { setBusy(false); }
  }
  const continuation = task?.state === "waiting_authority" || task?.state === "waiting_children" && task.children?.some(child => child.state === "waiting_authority");
  return <section className="management-page max-w-4xl space-y-6"><Link to="/app/tasks" className="inline-block text-xs text-muted-foreground hover:text-foreground">← Tasks</Link><div className="management-header"><h1>Task activity</h1><Button variant="outline" size="sm" onClick={() => setGeneration(value => value + 1)}>Refresh status</Button></div><ErrorMessage value={error} />{!task && !error ? <Loading /> : task ? <><div className="space-y-2"><span className="task-state" data-state={task.state}>{task.state.replaceAll("_", " ")}</span>{task.errorCode ? <p className="text-sm text-muted-foreground">{task.errorCode.replaceAll("_", " ").toLowerCase()}</p> : null}</div>{task.input ? <div className="rounded-xl bg-muted/60 px-4 py-3"><h2 className="mb-2 text-xs font-medium text-muted-foreground">Request</h2><p className="whitespace-pre-wrap break-words text-sm leading-6">{task.input}</p></div> : null}{task.output ? <div className="space-y-2"><h2 className="text-xs font-medium text-muted-foreground">Response</h2><p className="whitespace-pre-wrap break-words text-sm leading-7">{task.output}</p></div> : null}{task.outputAvailability === "unavailable" ? <p className="text-sm text-muted-foreground">This response is no longer available.</p> : null}<TaskSources key={task.id + task.output} endpoint={endpoint} output={task.output} /><TaskActivity task={task} onRefresh={() => setGeneration(value => value + 1)} />{canControl && !terminal(task.state) ? <div className="flex flex-wrap gap-2">{continuation ? <Button disabled={busy} onClick={() => void control("continue")}>Continue task</Button> : null}<Button variant="outline" disabled={busy || task.state === "cancel_requested"} onClick={() => void control("cancel")}>{task.state === "cancel_requested" ? "Cancellation requested" : "Cancel task"}</Button></div> : null}<TaskEvents endpoint={endpoint} initial={task.events ?? []} initialCursor={eventsCursor} onUnavailable={cause => { setTask(null); setCanControl(false); setError(message(cause)); }} /><details className="border-t border-border pt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Task details</summary><code className="mt-3 block break-all">{task.id}</code></details></> : null}</section>;
}
