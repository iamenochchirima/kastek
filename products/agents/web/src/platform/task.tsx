import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { api, ApiError, message, organizationPath, terminal, type Task, type TaskDetail } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { cleanupPending, TaskActivity } from "./task-activity";

export function TaskPage() {
  const { taskId = "" } = useParams();
  const { organizationId } = useWorkspace();
  const endpoint = `${organizationPath(organizationId)}/tasks/${encodeURIComponent(taskId)}`;
  const [task, setTask] = useState<Task | null>(null), [error, setError] = useState("");
  const [generation, setGeneration] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => {
    let closed = false, unknownPolls = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const detail = await api<TaskDetail>(endpoint);
        if (closed) return;
        const current = { ...detail.task, operations: detail.operations, events: detail.events, children: detail.children, resources: detail.resources, artifacts: detail.artifacts, actions: detail.actions };
        setTask(current); setError("");
        const uncertain = current.state === "uncertain" || current.resources?.some(resource => resource.cleanupState === "uncertain") || current.actions?.some(action => action.state === "uncertain");
        if (uncertain && ++unknownPolls >= 3) return;
        if (terminal(current.state) && !cleanupPending(current) && !current.actions?.some(action => ["approved", "claimed"].includes(action.state))) return;
      } catch (e) { if (closed) return; setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) return; }
      timer = setTimeout(() => void poll(), 1200);
    }
    void poll(); return () => { closed = true; clearTimeout(timer); };
  }, [endpoint, generation]);
  async function control(action: "cancel" | "continue") {
    setBusy(true); setError("");
    try { await api(`${endpoint}/${action}`, {}); setGeneration(value => value + 1); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const continuation = task?.state === "waiting_authority" || task?.state === "waiting_children" && task.children?.some(child => child.state === "waiting_authority");
  return <section className="max-w-3xl space-y-6"><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold tracking-tight">Task</h1><Button variant="outline" size="sm" onClick={() => setGeneration(value => value + 1)}>Refresh status</Button></div><ErrorMessage value={error} />{!task && !error ? <Loading /> : task ? <><div className="space-y-2"><p className="text-sm">{task.state.replaceAll("_", " ")}</p><code className="block break-all text-xs text-muted-foreground">{task.id}</code>{task.errorCode ? <p className="text-sm text-muted-foreground">{task.errorCode.replaceAll("_", " ").toLowerCase()}</p> : null}</div>{task.input ? <p className="whitespace-pre-wrap break-words text-sm">{task.input}</p> : null}{task.output ? <p className="whitespace-pre-wrap break-words text-sm leading-6">{task.output}</p> : null}<TaskActivity task={task} onRefresh={() => setGeneration(value => value + 1)} />{!terminal(task.state) ? <div className="flex flex-wrap gap-2">{continuation ? <Button disabled={busy} onClick={() => void control("continue")}>Continue task</Button> : null}<Button variant="outline" disabled={busy || task.state === "cancel_requested"} onClick={() => void control("cancel")}>Cancel task</Button></div> : null}</> : null}</section>;
}
