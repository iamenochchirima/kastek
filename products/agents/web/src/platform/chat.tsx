import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, loadTaskDetail, message, readStored, terminal, writeStored, type Task } from "./api";
import { ArrowUp, Bot, User } from "lucide-react";
import { MessageContent } from "./message-content";
import { ErrorMessage } from "./shell";
import { TaskSources } from "./cited-passages";
import { cleanupPending, TaskActivity } from "./task-activity";

type SavedChat = { id: string; label: string; entries: Entry[] };
type Entry = { requestKey: string; input: string; versionId?: string; versionNumber?: number; task?: Task };
function restorable(entries: Entry[]): Entry[] {
  return entries.map(entry => ({ ...entry, input: entry.task ? "" : entry.input, task: entry.task ? {
    id: entry.task.id, state: entry.task.state, output: null, errorCode: null,
    conversationId: entry.task.conversationId, requestKey: entry.requestKey, turnSequence: entry.task.turnSequence,
    versionId: entry.task.versionId,
  } : undefined }));
}
export function Chat({ endpoint, storageKey, token, versionId, versionNumber, initialConversationId, expectedAgentId, onPendingChanged, onConversationReady, onPinnedVersion, view = "chat", cancellable = false }: {
  endpoint: string; storageKey: string; token?: string; versionId?: string; versionNumber?: number; cancellable?: boolean; initialConversationId?: string; expectedAgentId?: string; onPendingChanged?: (pending: boolean) => void; onConversationReady?: (conversationId: string) => void; onPinnedVersion?: (id: string) => void; view?: "chat" | "activity";
}) {
  const [entries, setEntries] = useState<Entry[]>(() => restorable(readStored<Entry[]>(storageKey) ?? []));
  const [savedChats, setSavedChats] = useState<SavedChat[]>(() => (readStored<SavedChat[]>(`${storageKey}.conversations`) ?? []).map(chat => ({ ...chat, entries: restorable(chat.entries) })));
  const [input, setInput] = useState(() => readStored<string>(`${storageKey}.draft`) ?? "");
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(Boolean(initialConversationId));
  const [accessDenied, setAccessDenied] = useState(false);
  const [historyGeneration, setHistoryGeneration] = useState(0);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const lock = useRef(false);
  const mounted = useRef(true);
  const pinnedVersion = useRef(onPinnedVersion);
  pinnedVersion.current = onPinnedVersion;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const last = entries.at(-1);
  const followedId = last?.task?.id;
  const activeId = last?.task && !terminal(last.task.state) ? last.task.id : undefined;
  const unknown = Boolean(last && !last.task);
  useEffect(() => { onPendingChanged?.(unknown); }, [unknown, onPendingChanged]);
  const needsContinuation = last?.task?.state === "waiting_authority" ||
    last?.task?.state === "waiting_children" && last.task.children?.some(child => child.state === "waiting_authority");
  const conversationId = initialConversationId ?? [...entries].reverse().find(entry => entry.task)?.task?.conversationId;
  function record(next: Entry[]) { setEntries(next); writeStored(storageKey, restorable(next)); }
  async function hydrateTurns(tasks: Task[], live: () => boolean) {
    // A visible history page contains at most100 turns; limit concurrent detail reads.
    for (let offset = 0; offset < tasks.length && live(); offset += 4) {
      await Promise.all(tasks.slice(offset, offset + 4).map(async task => {
        try { const detail = await loadTaskDetail(`${endpoint}/${encodeURIComponent(task.id)}`, token); if (!live()) return;
          setEntries(current => current.map(entry => entry.task?.id === task.id ? { ...entry, task: { ...detail.task, events: detail.events, operations: detail.operations, children: detail.children, resources: detail.resources, artifacts: detail.canDownloadArtifacts === false ? [] : detail.artifacts, actions: detail.actions } } : entry));
        } catch (e) { if (!live()) return; if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setEntries([]); setAccessDenied(true); } setError(message(e)); }
      }));
    }
  }
  const hydrateRef = useRef(hydrateTurns); hydrateRef.current = hydrateTurns;
  useEffect(() => {
    if (!conversationId) return;
    let closed = false;
    const historyPath = `${endpoint.replace(/\/tasks$/, "/conversations")}/${encodeURIComponent(conversationId)}`;
    api<{ tasks: Task[]; nextCursor?: string | null; conversation?: { agentId: string; versionId: string; versionNumber: number } }>(historyPath, undefined, "GET", token).then(result => {
      if (closed) return;
      if (expectedAgentId && result.conversation?.agentId && result.conversation.agentId !== expectedAgentId) { setAccessDenied(true); setEntries([]); setHistoryLoading(false); setError("This conversation belongs to another agent."); return; }
      setAccessDenied(false);
      setHistoryCursor(result.nextCursor ?? null); setHistoryLoading(false);
      if (result.conversation?.versionId) pinnedVersion.current?.(result.conversation.versionId); else if (result.tasks[0]?.versionId) pinnedVersion.current?.(result.tasks[0].versionId);
      setEntries(current => {
        const restored = result.tasks.filter(task => task.input && task.requestKey).map(task => {
          const previous = current.find(entry => entry.task?.id === task.id);
          return { ...previous, input: task.input!, requestKey: task.requestKey!, versionId: task.versionId, task: { ...previous?.task, ...task } };
        });
        const next = [...restored, ...current.filter(entry => !entry.task && !result.tasks.some(task => task.requestKey === entry.requestKey))];
        writeStored(storageKey, restorable(next));
        return next;
      });
      void hydrateRef.current(result.tasks, () => !closed);
    }).catch(e => { if (!closed) { setError(message(e)); setHistoryLoading(false); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setEntries([]); setAccessDenied(true); } } });
    return () => { closed = true; };
  }, [conversationId, endpoint, storageKey, token, expectedAgentId, historyGeneration]);
  useEffect(() => {
    if (!followedId) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let uncertainPolls = 0;
    const poll = async () => {
      try { const { task, events, operations, children, resources, artifacts, actions } = await loadTaskDetail(`${endpoint}/${encodeURIComponent(followedId)}`, token);
        if (closed) return;
        setEntries(current => { const next = current.map(entry => entry.task?.id === task.id ? { ...entry, task: { ...task, events: events ?? task.events, operations: operations ?? task.operations, children: children ?? task.children, resources: resources ?? task.resources, artifacts: artifacts ?? task.artifacts, actions: actions ?? task.actions } } : entry); writeStored(storageKey, restorable(next)); return next; });
        setError("");
        if (terminal(task.state)) {
          if (!cleanupPending({ ...task, resources: resources ?? task.resources }) && !actions?.some(action => ["approved", "claimed", "uncertain"].includes(action.state))) return;
          if ((resources?.some(resource => resource.cleanupState === "uncertain") || actions?.some(action => action.state === "uncertain")) && ++uncertainPolls >= 3) return;
        }
      } catch (e) { if (closed) return; setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setEntries([]); setAccessDenied(true); return; } }
      timer = setTimeout(() => void poll(), 1_200);
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [followedId, endpoint, storageKey, token, refreshGeneration]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") { setHistoryGeneration(value => value + 1); setRefreshGeneration(value => value + 1); } };
    window.addEventListener("focus", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  async function loadMoreHistory() {
    if (!historyCursor || !conversationId || historyLoading || accessDenied) return;
    setHistoryLoading(true);
    try { const result = await api<{ tasks: Task[]; nextCursor: string | null }>(`${endpoint.replace(/\/tasks$/, "/conversations")}/${encodeURIComponent(conversationId)}?cursor=${encodeURIComponent(historyCursor)}`, undefined, "GET", token); setEntries(current => { const merged = [...result.tasks.filter(task => task.requestKey && task.input && !current.some(entry => entry.task?.id === task.id)).map(task => ({ input: task.input!, requestKey: task.requestKey!, versionId: task.versionId, task })), ...current]; writeStored(storageKey, restorable(merged)); return merged; }); setHistoryCursor(result.nextCursor); void hydrateRef.current(result.tasks, () => mounted.current); }
    catch (e) { setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { setEntries([]); setAccessDenied(true); } }
    finally { setHistoryLoading(false); }
  }
  function archiveCurrent() {
    if (!entries.length || !conversationId) return savedChats;
    const next = [{ id: conversationId, label: entries[0].input.slice(0, 70), entries: restorable(entries) }, ...savedChats.filter(chat => chat.id !== conversationId)].slice(0, 20);
    setSavedChats(next); writeStored(`${storageKey}.conversations`, next); return next;
  }
  function newConversation() { archiveCurrent(); record([]); setInput(""); setError(""); }
  function restoreConversation(id: string) { const selected = savedChats.find(chat => chat.id === id); if (!selected) return; archiveCurrent(); record(restorable(selected.entries)); setInput(""); setError(""); }
  async function submit(entry: Entry, previous: Entry[]) {
    if (lock.current) return;
    lock.current = true; setSending(true); setError("");
    const next = [...previous, entry]; record(next);
    try {
      const conversationId = previous.at(-1)?.task?.conversationId;
      const { task } = await api<{ task: Task }>(endpoint, { input: entry.input, requestKey: entry.requestKey, ...(entry.versionId ? { versionId: entry.versionId } : {}), ...(conversationId ? { conversationId } : {}) }, "POST", token);
      record([...previous, { ...entry, task }]); setInput(""); writeStored(`${storageKey}.draft`, ""); if (mounted.current) onConversationReady?.(task.conversationId);
    } catch (e) {
      if (e instanceof ApiError && [400, 401, 403, 404, 409, 413, 422, 429].includes(e.status)) record(previous);
      setError(message(e));
    }
    finally { lock.current = false; setSending(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault(); if (!input.trim() || activeId || unknown || sending || historyLoading || accessDenied) return;
    await submit({ input: input.trim(), requestKey: crypto.randomUUID(), versionId, versionNumber }, entries);
  }
  async function continueTask() {
    if (!activeId || continuing) return;
    setContinuing(true); setError("");
    try { const { task } = await api<{ task: Task }>(`${endpoint}/${encodeURIComponent(activeId)}/continue`, {}, "POST", token); setEntries(current => { const next = current.map(entry => entry.task?.id === task.id ? { ...entry, task: { ...entry.task, ...task } } : entry); writeStored(storageKey, restorable(next)); return next; }); }
    catch (e) { setError(message(e)); } finally { setContinuing(false); }
  }
  async function cancel() {
    if (!activeId) return;
    setSending(true);
    try { const { task } = await api<{ task: Task }>(`${endpoint}/${encodeURIComponent(activeId)}/cancel`, {}, "POST", token); record(entries.map(entry => entry.task?.id === task.id ? { ...entry, task } : entry)); }
    catch (e) { setError(message(e)); } finally { setSending(false); }
  }
  return <section className={`chat-workspace ${view === "activity" ? "chat-activity-view" : ""}`} aria-label="Conversation">
    {!cancellable ? <div className="flex flex-wrap items-center justify-between gap-3">
      {savedChats.length ? <label className="min-w-0 max-w-full text-sm"><span className="sr-only">Saved conversations</span><select aria-label="Saved conversations" className="max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value="" disabled={sending || Boolean(activeId) || unknown || historyLoading || accessDenied} onChange={event => restoreConversation(event.target.value)}><option value="">Saved conversations</option>{savedChats.map(chat => <option key={chat.id} value={chat.id}>{chat.label}</option>)}</select></label> : <span />}
      <Button type="button" size="sm" variant="outline" onClick={newConversation} disabled={!entries.length || sending || Boolean(activeId) || unknown}>New conversation</Button>
    </div> : null}
    <div className="chat-messages" aria-live="polite" aria-busy={historyLoading}>
      {!entries.length ? <div className="chat-empty"><span className="agent-welcome-icon"><Bot size={28} /></span><h2>{historyLoading ? "Loading conversation…" : "How can I help?"}</h2><p>{historyLoading ? "" : "Send a message to get started."}</p></div> : entries.map((entry, index) => <article key={entry.requestKey} aria-label={`Turn ${entry.task?.turnSequence ?? index + 1}`} className="chat-turn space-y-4">
        <div className="chat-user-message"><User size={17} className="message-avatar" /><div><p className="mb-1 text-xs font-medium text-muted-foreground">You</p><p className="whitespace-pre-wrap break-words text-sm">{entry.input}</p></div></div>
        {entry.task?.output ? <div className="chat-assistant-message"><span className="assistant-mark"><Bot size={17} /></span><div className="min-w-0 flex-1"><p className="mb-2 text-xs font-medium text-muted-foreground">Assistant</p><MessageContent text={entry.task.output} /></div></div> : null}
        {entry.task?.outputAvailability === "unavailable" ? <p className="text-sm text-muted-foreground">This response is no longer available.</p> : null}
        {entry.task && (cancellable || !entry.task.output || entry.task.state !== "completed") ? <div className="space-y-1 text-xs text-muted-foreground"><p>{entry.task.state.replaceAll("_", " ")}{entry.versionNumber ? ` · Version ${entry.versionNumber}` : ""}{entry.task.errorCode ? ` · ${entry.task.errorCode.replaceAll("_", " ").toLowerCase()}` : ""}</p><details><summary className="cursor-pointer">Task details</summary><code className="mt-2 block break-all">{entry.task.id}</code>{entry.task.turnSequence ? <p className="mt-2">Conversation turn {entry.task.turnSequence}</p> : null}{entry.task.operations?.length ? <ol className="mt-3 space-y-2" aria-label="Task operations">{entry.task.operations.map((operation, index) => <li key={operation.operationId ?? operation.id ?? index} className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-border pt-2"><span className="break-all">{operation.toolName ?? operation.name ?? operation.kind ?? "Operation"}</span><span>{operation.state.replaceAll("_", " ")}{operation.errorCode ? ` · ${operation.errorCode.replaceAll("_", " ").toLowerCase()}` : ""}</span>{operation.inputTokens != null || operation.outputTokens != null ? <span className="basis-full">{operation.inputTokens ?? 0} input tokens · {operation.outputTokens ?? 0} output tokens</span> : null}</li>)}</ol> : null}{entry.task.events?.length ? <ol className="mt-3 space-y-1" aria-label="Task history">{entry.task.events.map(event => <li key={event.sequence}>{event.kind.replaceAll("_", " ")}</li>)}</ol> : null}</details></div> : !entry.task ? <p className="text-xs text-muted-foreground">{sending ? "Submitting…" : "Request outcome unknown"}</p> : null}
        {entry.task ? <TaskSources key={`${entry.task.id}.${entry.task.output}.${historyGeneration}`} endpoint={`${endpoint}/${encodeURIComponent(entry.task.id)}`} token={token} output={entry.task.output} /> : null}
        {entry.task ? <TaskActivity task={entry.task} onRefresh={() => setRefreshGeneration(value => value + 1)} /> : null}
      </article>)}
      {historyCursor ? <Button variant="outline" size="sm" onClick={() => void loadMoreHistory()} disabled={historyLoading}>{historyLoading ? "Loading…" : "Older messages"}</Button> : null}
    </div>
    <div className="chat-feedback">{cancellable && conversationId ? <Button variant="ghost" size="sm" onClick={() => { setHistoryGeneration(value => value + 1); setRefreshGeneration(value => value + 1); }}>Refresh conversation</Button> : null}<ErrorMessage value={error} />
    {unknown && !sending ? <Button variant="outline" onClick={() => void submit(last!, entries.slice(0, -1))}>Retry request</Button> : null}
    </div>
    {view === "chat" ? <form onSubmit={event => void send(event)} className="chat-composer">
      <label className="block space-y-2 text-sm"><span className="sr-only">Message</span><Textarea value={input} onChange={event => { setInput(event.target.value); writeStored(`${storageKey}.draft`, event.target.value); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} required maxLength={8_000} rows={3} placeholder="Message your agent…" disabled={sending || Boolean(activeId) || unknown || historyLoading || accessDenied} /></label>
      <div className="flex flex-wrap gap-3"><Button type="submit" aria-label="Send message" className="chat-send" disabled={sending || Boolean(activeId) || unknown || historyLoading || accessDenied || !input.trim()}>{sending ? "Sending…" : <><ArrowUp size={17} /><span>Send</span></>}</Button>{cancellable && needsContinuation ? <Button type="button" onClick={() => void continueTask()} disabled={sending || continuing}>{continuing ? "Continuing…" : "Continue task"}</Button> : null}{cancellable && activeId ? <Button type="button" variant="outline" disabled={sending || continuing || last?.task?.state === "cancel_requested"} onClick={() => void cancel()}>Cancel task</Button> : null}</div>
    </form> : null}
  </section>;
}
