import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, loadTaskDetail, message, readStored, terminal, writeStored, type Task } from "./api";
import { ErrorMessage } from "./shell";
import { TaskSources } from "./cited-passages";
import { cleanupPending, TaskActivity } from "./task-activity";

type Entry = { requestKey: string; input: string; versionId?: string; versionNumber?: number; task?: Task };
export function Chat({ endpoint, storageKey, token, versionId, versionNumber, cancellable = false }: {
  endpoint: string; storageKey: string; token?: string; versionId?: string; versionNumber?: number; cancellable?: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>(() => readStored<Entry[]>(storageKey) ?? []);
  const [savedChats, setSavedChats] = useState<{ id: string; label: string; entries: Entry[] }[]>(() => readStored(`${storageKey}.conversations`) ?? []);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const lock = useRef(false);
  const last = entries.at(-1);
  const followedId = last?.task?.id;
  const activeId = last?.task && !terminal(last.task.state) ? last.task.id : undefined;
  const unknown = Boolean(last && !last.task);
  const needsContinuation = last?.task?.state === "waiting_authority" ||
    last?.task?.state === "waiting_children" && last.task.children?.some(child => child.state === "waiting_authority");
  const conversationId = [...entries].reverse().find(entry => entry.task)?.task?.conversationId;
  function record(next: Entry[]) { setEntries(next); writeStored(storageKey, next); }
  useEffect(() => {
    if (!conversationId) return;
    let closed = false;
    const historyPath = `${endpoint.replace(/\/tasks$/, "/conversations")}/${encodeURIComponent(conversationId)}`;
    api<{ tasks: Task[] }>(historyPath, undefined, "GET", token).then(result => {
      if (closed) return;
      setEntries(current => {
        const restored = result.tasks.filter(task => task.input && task.requestKey).map(task => {
          const previous = current.find(entry => entry.task?.id === task.id);
          return { ...previous, input: task.input!, requestKey: task.requestKey!, versionId: task.versionId, task: { ...previous?.task, ...task } };
        });
        const next = [...restored, ...current.filter(entry => !entry.task && !result.tasks.some(task => task.requestKey === entry.requestKey))];
        writeStored(storageKey, next);
        return next;
      });
    }).catch(e => { if (!closed) setError(message(e)); });
    return () => { closed = true; };
  }, [conversationId, endpoint, storageKey, token]);
  useEffect(() => {
    if (!followedId) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let uncertainPolls = 0;
    const poll = async () => {
      try { const { task, events, operations, children, resources, artifacts, actions } = await loadTaskDetail(`${endpoint}/${encodeURIComponent(followedId)}`, token);
        if (closed) return;
        setEntries(current => { const next = current.map(entry => entry.task?.id === task.id ? { ...entry, task: { ...task, events: events ?? task.events, operations: operations ?? task.operations, children: children ?? task.children, resources: resources ?? task.resources, artifacts: artifacts ?? task.artifacts, actions: actions ?? task.actions } } : entry); writeStored(storageKey, next); return next; });
        setError("");
        if (terminal(task.state)) {
          if (!cleanupPending({ ...task, resources: resources ?? task.resources }) && !actions?.some(action => ["approved", "claimed", "uncertain"].includes(action.state))) return;
          if ((resources?.some(resource => resource.cleanupState === "uncertain") || actions?.some(action => action.state === "uncertain")) && ++uncertainPolls >= 3) return;
        }
      } catch (e) { if (closed) return; setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) return; }
      timer = setTimeout(() => void poll(), 1_200);
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [followedId, endpoint, storageKey, token, refreshGeneration]);
  function archiveCurrent() {
    if (!entries.length || !conversationId) return savedChats;
    const next = [{ id: conversationId, label: entries[0].input.slice(0, 70), entries }, ...savedChats.filter(chat => chat.id !== conversationId)].slice(0, 20);
    setSavedChats(next); writeStored(`${storageKey}.conversations`, next); return next;
  }
  function newConversation() { archiveCurrent(); record([]); setInput(""); setError(""); }
  function restoreConversation(id: string) { const selected = savedChats.find(chat => chat.id === id); if (!selected) return; archiveCurrent(); record(selected.entries); setInput(""); setError(""); }
  async function submit(entry: Entry, previous: Entry[]) {
    if (lock.current) return;
    lock.current = true; setSending(true); setError("");
    const next = [...previous, entry]; record(next);
    try {
      const conversationId = previous.at(-1)?.task?.conversationId;
      const { task } = await api<{ task: Task }>(endpoint, { input: entry.input, requestKey: entry.requestKey, ...(entry.versionId ? { versionId: entry.versionId } : {}), ...(conversationId ? { conversationId } : {}) }, "POST", token);
      record([...previous, { ...entry, task }]); setInput("");
    } catch (e) {
      if (e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(e.status)) record(previous);
      setError(message(e));
    }
    finally { lock.current = false; setSending(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); if (!input.trim() || activeId || unknown || sending) return;
    await submit({ input: input.trim(), requestKey: crypto.randomUUID(), versionId, versionNumber }, entries);
  }
  async function continueTask() {
    if (!activeId || continuing) return;
    setContinuing(true); setError("");
    try { const { task } = await api<{ task: Task }>(`${endpoint}/${encodeURIComponent(activeId)}/continue`, {}, "POST", token); setEntries(current => { const next = current.map(entry => entry.task?.id === task.id ? { ...entry, task: { ...entry.task, ...task } } : entry); writeStored(storageKey, next); return next; }); }
    catch (e) { setError(message(e)); } finally { setContinuing(false); }
  }
  async function cancel() {
    if (!activeId) return;
    setSending(true);
    try { const { task } = await api<{ task: Task }>(`${endpoint}/${encodeURIComponent(activeId)}/cancel`, {}, "POST", token); record(entries.map(entry => entry.task?.id === task.id ? { ...entry, task } : entry)); }
    catch (e) { setError(message(e)); } finally { setSending(false); }
  }
  return <section className="space-y-4" aria-label="Conversation">
    <div className="flex flex-wrap items-center justify-between gap-3">
      {savedChats.length ? <label className="min-w-0 max-w-full text-sm"><span className="sr-only">Saved conversations</span><select aria-label="Saved conversations" className="max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value="" disabled={sending || Boolean(activeId) || unknown} onChange={event => restoreConversation(event.target.value)}><option value="">Saved conversations</option>{savedChats.map(chat => <option key={chat.id} value={chat.id}>{chat.label}</option>)}</select></label> : <span />}
      <Button type="button" size="sm" variant="outline" onClick={newConversation} disabled={!entries.length || sending || Boolean(activeId) || unknown}>New conversation</Button>
    </div>
    <div className="min-h-48 space-y-5 rounded-lg border border-border bg-card p-4 sm:p-6" aria-live="polite">
      {!entries.length ? <p className="text-sm text-muted-foreground">Ask a question.</p> : entries.map((entry, index) => <article key={entry.requestKey} aria-label={`Turn ${entry.task?.turnSequence ?? index + 1}`} className="space-y-3">
        <div><p className="mb-1 text-xs font-medium text-muted-foreground">You</p><p className="whitespace-pre-wrap break-words text-sm">{entry.input}</p></div>
        {entry.task?.output ? <div><p className="mb-1 text-xs font-medium text-muted-foreground">Assistant</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{entry.task.output}</p></div> : null}
        {entry.task?.outputAvailability === "unavailable" ? <p className="text-sm text-muted-foreground">This response is no longer available.</p> : null}
        {entry.task && (cancellable || !entry.task.output || entry.task.state !== "completed") ? <div className="space-y-1 text-xs text-muted-foreground"><p>{entry.task.state.replaceAll("_", " ")}{entry.versionNumber ? ` · Version ${entry.versionNumber}` : ""}{entry.task.errorCode ? ` · ${entry.task.errorCode.replaceAll("_", " ").toLowerCase()}` : ""}</p><details><summary className="cursor-pointer">Task details</summary><code className="mt-2 block break-all">{entry.task.id}</code>{entry.task.turnSequence ? <p className="mt-2">Conversation turn {entry.task.turnSequence}</p> : null}{entry.task.operations?.length ? <ol className="mt-3 space-y-2" aria-label="Task operations">{entry.task.operations.map((operation, index) => <li key={operation.operationId ?? operation.id ?? index} className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-border pt-2"><span className="break-all">{operation.toolName ?? operation.name ?? operation.kind ?? "Operation"}</span><span>{operation.state.replaceAll("_", " ")}{operation.errorCode ? ` · ${operation.errorCode.replaceAll("_", " ").toLowerCase()}` : ""}</span>{operation.inputTokens != null || operation.outputTokens != null ? <span className="basis-full">{operation.inputTokens ?? 0} input tokens · {operation.outputTokens ?? 0} output tokens</span> : null}</li>)}</ol> : null}{entry.task.events?.length ? <ol className="mt-3 space-y-1" aria-label="Task history">{entry.task.events.map(event => <li key={event.sequence}>{event.kind.replaceAll("_", " ")}</li>)}</ol> : null}</details></div> : !entry.task ? <p className="text-xs text-muted-foreground">{sending ? "Submitting…" : "Request outcome unknown"}</p> : null}
        {entry.task ? <TaskSources key={entry.task.id + entry.task.output} endpoint={`${endpoint}/${encodeURIComponent(entry.task.id)}`} token={token} output={entry.task.output} /> : null}
        {entry.task ? <TaskActivity task={entry.task} onRefresh={() => setRefreshGeneration(value => value + 1)} /> : null}
      </article>)}
    </div>
    <ErrorMessage value={error} />
    {unknown && !sending ? <Button variant="outline" onClick={() => void submit(last!, entries.slice(0, -1))}>Retry request</Button> : null}
    <form onSubmit={event => void send(event)} className="space-y-3">
      <label className="block space-y-2 text-sm"><span>Message</span><Textarea value={input} onChange={event => setInput(event.target.value)} required maxLength={8_000} rows={3} placeholder="Ask a question" disabled={sending || Boolean(activeId) || unknown} /></label>
      <div className="flex flex-wrap gap-3"><Button type="submit" disabled={sending || Boolean(activeId) || unknown || !input.trim()}>{sending ? "Sending…" : "Send"}</Button>{cancellable && needsContinuation ? <Button type="button" onClick={() => void continueTask()} disabled={sending || continuing}>{continuing ? "Continuing…" : "Continue task"}</Button> : null}{cancellable && activeId ? <Button type="button" variant="outline" disabled={sending || continuing || last?.task?.state === "cancel_requested"} onClick={() => void cancel()}>Cancel task</Button> : null}</div>
    </form>
  </section>;
}
