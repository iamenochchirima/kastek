import "./management.css";
import "./workspace-surfaces.css";
import { PiArrowLeft as ArrowLeft } from "react-icons/pi";
import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { api, ApiError, loadTaskDetail, message, organizationPath, terminal, type Task } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { cleanupPending } from "./task-activity";
import { TaskExecutionBody } from "./execution-view";
import { AgentMessage } from "@kasitek-labs/ui/agent";

export function TaskPage() {
  const { taskId = "" } = useParams(), { organizationId } = useWorkspace();
  const endpoint = `${organizationPath(organizationId)}/tasks/${encodeURIComponent(taskId)}`;
  return <TaskDetailPage key={endpoint} endpoint={endpoint} />;
}
function TaskDetailPage({ endpoint }: { endpoint: string }) {
  const [task, setTask] = useState<Task | null>(null), [error, setError] = useState("");
  const [canControl, setCanControl] = useState(false);
  const [generation, setGeneration] = useState(0), [busy, setBusy] = useState(false);
  useEffect(() => {
    let closed = false, unknownPolls = 0;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const detail = await loadTaskDetail(endpoint);
        if (closed) return;
        const current = { ...detail.task, publicUpdates: detail.updates, updatesTruncated: detail.updatesTruncated, operationsNextCursor: detail.operationsNextCursor, eventsNextCursor: detail.eventsNextCursor, operations: detail.operations, events: detail.events, children: detail.children, resources: detail.resources, artifacts: detail.canDownloadArtifacts === false ? [] : detail.artifacts, actions: detail.actions };
        setTask(current); setCanControl(detail.canControl !== false); setError("");
        const uncertain = current.state === "uncertain" || current.resources?.some(resource => resource.cleanupState === "uncertain") || current.actions?.some(action => action.state === "uncertain");
        if (uncertain && ++unknownPolls >= 3) return;
        if (terminal(current.state) && !cleanupPending(current) && !current.actions?.some(action => ["approved", "claimed"].includes(action.state))) return;
      } catch (e) { if (closed) return; setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setTask(null); setCanControl(false); return; } }
      timer = setTimeout(() => void poll(), 1200);
    }
    void poll(); return () => { closed = true; clearTimeout(timer); };
  }, [endpoint, generation]);
  useEffect(() => { const refresh = () => { if (document.visibilityState === "visible") setGeneration(value => value + 1); }; window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh); return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); }; }, []);
  async function control(action: "cancel" | "continue") {
    setBusy(true); setError("");
    try { await api(`${endpoint}/${action}`, {}); setGeneration(value => value + 1); }
    catch (e) { setError(message(e)); if (e instanceof ApiError && [401,403,404].includes(e.status)) { setTask(null); setCanControl(false); } } finally { setBusy(false); }
  }
  const continuation = task?.state === "waiting_authority" || task?.state === "waiting_children" && task.children?.some(child => child.state === "waiting_authority");
  return <section className="management-page max-w-4xl space-y-6"><Link to="/app/tasks" className="task-detail-back"><ArrowLeft size={14} aria-hidden="true" /> Tasks</Link><div className="management-header"><h1>Task activity</h1><Button variant="outline" size="sm" onClick={() => setGeneration(value => value + 1)}>Refresh status</Button></div><ErrorMessage value={error} />{!task && !error ? <Loading /> : task ? <>{task.input ? <AgentMessage role="user" text={task.input} /> : null}<TaskExecutionBody task={task} endpoint={endpoint} onRefresh={() => setGeneration(value => value + 1)} onUnavailable={cause => { setGeneration(value => value + 1); if (cause instanceof ApiError && [401,403,404].includes(cause.status)) { setTask(null); setCanControl(false); setError(message(cause)); } else setTask(current => current ? { ...current, output: null, outputAvailability: "unavailable", children: [], artifacts: [], actions: [] } : null); }} />{canControl && !terminal(task.state) ? <div className="flex flex-wrap gap-2">{continuation ? <Button disabled={busy} onClick={() => void control("continue")}>Continue task</Button> : null}<Button variant="outline" disabled={busy || task.state === "cancel_requested"} onClick={() => void control("cancel")}>{task.state === "cancel_requested" ? "Cancellation requested" : "Cancel task"}</Button></div> : null}</> : null}</section>;
}
