import { useEffect, useRef, useState } from "react";
import { AgentExecutionView, AgentSubagentModal, type AgentExecution, type AgentSubagent } from "@kasitek-labs/ui/agent";
import { api, ApiError, loadTaskDetail, message, terminal, type Task, type TaskDetail, type TaskOperation } from "./api";
import { Button } from "@/components/ui/button";
import { TaskSources } from "./cited-passages";
import { MessageContent } from "./message-content";
import { TaskActivity } from "./task-activity";
import { TaskEvents } from "./task-events";
import { taskErrorLabel } from "./task-errors";

/** Product records become shared presentation data; authority remains in the API. */
export function taskExecution(task: Task): AgentExecution {
  if (task.outputAvailability === "unavailable") return { id: task.id, state: task.state, label: "Activity unavailable", output: null };
  return {
    id: task.id, state: task.state,
    elapsedMs: terminal(task.state) && task.createdAt && task.updatedAt ? Date.parse(task.updatedAt) - Date.parse(task.createdAt) : undefined,
    label: task.errorCode ? taskErrorLabel(task.errorCode) : undefined,
    updates: task.publicUpdates?.map(update => ({ id: update.id, text: update.text, createdAt: update.createdAt })),
    operations: task.operations?.map((operation, index) => ({
      id: operation.operationId ?? operation.id ?? `${task.id}:operation:${index}`,
      label: (operation.providerOperation ?? operation.toolName ?? operation.name ?? operation.kind ?? "Operation").replaceAll("_", " "),
      state: operation.state, kind: operation.kind, startedAt: operation.startedAt,
      details: <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1"><dt>Status</dt><dd>{operation.state.replaceAll("_", " ")}</dd>{operation.transport ? <><dt>Transport</dt><dd>{operation.transport === "native_http" ? "API" : "MCP"}</dd></> : null}{operation.errorCode ? <><dt>Outcome</dt><dd>Operation could not finish.</dd></> : null}</dl>,
      detailAvailability: "available" as const,
    })),
    approach: task.orchestration?.record ?? undefined,
    children: task.children?.map(child => ({ id: child.id, name: child.agentName, state: child.state, assignment: child.assignment, createdAt: child.createdAt })),
    output: task.output,
    diagnostics: [
      { label: "Task", value: task.id },
      ...(task.versionId ? [{ label: "Configuration snapshot", value: task.versionId }] : []),
      ...(task.turnSequence ? [{ label: "Conversation turn", value: task.turnSequence }] : []),
    ],
  };
}

function withDetails(detail: TaskDetail): Task {
  return { ...detail.task, publicUpdates: detail.updates, updatesTruncated: detail.updatesTruncated, operationsNextCursor: detail.operationsNextCursor, eventsNextCursor: detail.eventsNextCursor, orchestration: detail.orchestration, canSteer: detail.canSteer,
    operations: detail.operations, events: detail.events, children: detail.children,
    resources: detail.resources, artifacts: detail.canDownloadArtifacts === false ? [] : detail.artifacts, actions: detail.actions };
}

export function TaskExecutionBody({ task, endpoint, token, onRefresh, onUnavailable }: {
  task: Task; endpoint: string; token?: string; onRefresh?: () => void; onUnavailable: (cause: unknown) => void;
}) {
  const [selection, setSelection] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const selectionScope = useRef({ endpoint, token });
  const selected = selectionScope.current.endpoint === endpoint && selectionScope.current.token === token ? selection.at(-1) : undefined;
  const selectedEndpoint = selected ? `${endpoint.slice(0, endpoint.lastIndexOf("/"))}/${encodeURIComponent(selected.id)}` : "";
  const selectionKey = selected?.id ?? "";
  useEffect(() => { setSelection([]); setSelectedTask(null); setError(""); }, [endpoint, token]);
  useEffect(() => {
    if (!selectedEndpoint) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setSelectedTask(null); setBusy(true); setError("");
    const poll = async () => {
      try {
        const result = await loadTaskDetail(selectedEndpoint, token, controller.signal);
        if (controller.signal.aborted) return;
        setSelectedTask(withDetails(result)); setBusy(false); setError("");
        timer = setTimeout(() => void poll(), terminal(result.task.state) ? 5000 : 1200);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setBusy(false);
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) { setError(message(cause)); setSelectedTask(null); return; }
        setError("Reconnecting. Showing last confirmed activity.");
        timer = setTimeout(() => void poll(), 2500);
      }
    };
    void poll();
    const refresh = () => { if (document.visibilityState === "visible") setRevision(value => value + 1); };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [selectedEndpoint, token, revision]);
  const open = (child: AgentSubagent, button: HTMLButtonElement) => {
    selectionScope.current = { endpoint, token }; trigger.current = button; setSelection([{ id: child.id, name: child.name }]);
  };
  const body = (current: Task, currentEndpoint: string, unavailable: (cause: unknown) => void, nested: boolean) => <ExecutionRecord task={current} endpoint={currentEndpoint} token={token} onUnavailable={unavailable} onRefresh={nested ? undefined : onRefresh} showStatus={!nested} onOpenSubagent={(child, button) => {
    if (nested) setSelection(previous => [...previous, { id: child.id, name: child.name }]); else open(child, button);
  }} />;
  return <>
    {body(task, endpoint, onUnavailable, false)}
    <AgentSubagentModal open={Boolean(selected)} onOpenChange={value => { if (!value) { setSelection([]); setSelectedTask(null); setError(""); } }} assignment={selectedTask?.errorCode === "EVIDENCE_UNAVAILABLE" ? undefined : selectedTask?.input} title={selected?.name ?? "Agent"} state={selectedTask?.state} elapsedMs={selectedTask ? taskExecution(selectedTask).elapsedMs : undefined}
      loading={busy} error={error} viewKey={`${endpoint}:${selectionKey}`}
      onBack={selection.length > 1 ? () => setSelection(previous => previous.slice(0, -1)) : undefined}
      onCloseAutoFocus={event => { event.preventDefault(); if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true }); }}>
      {selectedTask?.id === selectionKey ? <>

        {body(selectedTask, selectedEndpoint, cause => { setSelectedTask(null); setError(message(cause)); setRevision(value => value + 1); }, true)}
      </> : null}
    </AgentSubagentModal>
  </>;
}


function ExecutionRecord({ task, endpoint, token, onUnavailable, onRefresh, onOpenSubagent, showStatus = true }: {
  task: Task; endpoint: string; token?: string; onUnavailable: (cause: unknown) => void; onRefresh?: () => void; showStatus?: boolean;
  onOpenSubagent: (child: AgentSubagent, button: HTMLButtonElement) => void;
}) {
  const [observed, setObserved] = useState<{ endpoint: string; token?: string; operations: TaskOperation[] }>({ endpoint, token, operations: [] });
  const [history, setHistory] = useState<{ operations: TaskOperation[]; next: string | null } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => { generation.current++; setHistory(null); setError(""); return () => { controller.current?.abort(); }; }, [endpoint, token]);
  useEffect(() => { if (task.outputAvailability === "unavailable") { generation.current++; controller.current?.abort(); setHistory(null); setBusy(false); } }, [task.outputAvailability]);
  const next = task.outputAvailability === "unavailable" ? null : history ? history.next : task.operationsNextCursor;
  useEffect(() => {
    setObserved(previous => {
      if (task.outputAvailability === "unavailable") return { endpoint, token, operations: [] };
      const entries = new Map<string, TaskOperation>();
      for (const operation of [...(previous.endpoint === endpoint && previous.token === token ? previous.operations : []), ...(task.operations ?? [])]) entries.set(operation.operationId ?? operation.id ?? String(entries.size), operation);
      return { endpoint, token, operations: [...entries.values()].slice(-1000) };
    });
  }, [endpoint, token, task.operations, task.outputAvailability]);
  const retained = observed.endpoint === endpoint && observed.token === token && task.outputAvailability !== "unavailable" ? observed.operations : [];
  const merged = new Map<string, TaskOperation>();
  for (const operation of [...(task.outputAvailability !== "unavailable" ? history?.operations ?? [] : []), ...retained, ...(task.operations ?? [])]) merged.set(operation.operationId ?? operation.id ?? String(merged.size), operation);
  async function earlier() {
    if (!next || busy) return;
    const expected = generation.current, abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      const detail = await api<TaskDetail>(`${endpoint}?${new URLSearchParams({ operationsCursor: next })}`, undefined, "GET", token, abort.signal);
      if (abort.signal.aborted || generation.current !== expected) return;
      if (detail.task.outputAvailability === "unavailable") { setHistory(null); onUnavailable(new Error("Activity unavailable")); return; }
      setHistory(previous => ({ operations: [...(detail.operations ?? []), ...(previous?.operations ?? [])], next: detail.operationsNextCursor ?? null }));
    } catch (cause) {
      if (abort.signal.aborted || generation.current !== expected) return;
      setError(message(cause)); if (cause instanceof ApiError && [401,403,404].includes(cause.status)) { setHistory(null); onUnavailable(cause); }
    } finally { if (generation.current === expected && !abort.signal.aborted) setBusy(false); }
  }
  return <AgentExecutionView execution={taskExecution({ ...task, operations: [...merged.values()] })} showContext showStatus={showStatus} onOpenSubagent={onOpenSubagent} renderOutput={text => <MessageContent text={text} />}>
    {!showStatus && task.errorCode ? <p className="text-sm text-muted-foreground" role="status">{taskErrorLabel(task.errorCode)}</p> : null}
    {next ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void earlier()}>{busy ? "Loading…" : "Earlier activity"}</Button> : null}
    {error ? <p role="alert" className="text-xs text-muted-foreground">{error}</p> : null}
    {task.updatesTruncated ? <p className="text-xs text-muted-foreground">Showing recent updates.</p> : null}
    {task.outputAvailability === "unavailable" ? <p className="text-sm text-muted-foreground">This response is no longer available.</p> : null}
    <TaskSources key={task.id + task.output} endpoint={endpoint} token={token} output={task.output} onUnavailable={cause => { setHistory(null); onUnavailable(cause); }} />
    <TaskActivity task={task} onRefresh={onRefresh} readOnly={!showStatus} />
    <TaskEvents endpoint={endpoint} token={token} initial={task.events ?? []} initialCursor={task.eventsNextCursor ?? null} onUnavailable={onUnavailable} />
  </AgentExecutionView>;
}
