import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, message, readStored, terminal, writeStored, type Task } from "./api";
import { ErrorMessage } from "./shell";

type Entry = { requestKey: string; input: string; versionId?: string; versionNumber?: number; task?: Task };
export function Chat({ endpoint, storageKey, token, versionId, versionNumber, cancellable = false }: {
  endpoint: string; storageKey: string; token?: string; versionId?: string; versionNumber?: number; cancellable?: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>(() => readStored<Entry[]>(storageKey) ?? []);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const last = entries.at(-1);
  const followedId = last?.task?.id;
  const activeId = last?.task && !terminal(last.task.state) ? last.task.id : undefined;
  const unknown = Boolean(last && !last.task);
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
          return { ...previous, input: task.input!, requestKey: task.requestKey!, versionId: task.versionId, task: previous?.task ?? task };
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
    const poll = async () => {
      try { const { task } = await api<{ task: Task }>(`${endpoint}/${encodeURIComponent(followedId)}`, undefined, "GET", token);
        if (closed) return;
        setEntries(current => { const next = current.map(entry => entry.task?.id === task.id ? { ...entry, task } : entry); writeStored(storageKey, next); return next; });
        setError("");
        if (terminal(task.state)) return;
      } catch (e) { if (closed) return; setError(message(e)); if (e instanceof ApiError && [401, 403, 404].includes(e.status)) return; }
      timer = setTimeout(() => void poll(), 1_200);
    };
    void poll();
    return () => { closed = true; clearTimeout(timer); };
  }, [followedId, endpoint, storageKey, token]);
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
  async function cancel() {
    if (!activeId) return;
    setSending(true);
    try { const { task } = await api<{ task: Task }>(`${endpoint}/${encodeURIComponent(activeId)}/cancel`, {}, "POST", token); record(entries.map(entry => entry.task?.id === task.id ? { ...entry, task } : entry)); }
    catch (e) { setError(message(e)); } finally { setSending(false); }
  }
  return <section className="space-y-4" aria-label="Conversation">
    <div className="min-h-48 space-y-5 rounded-lg border border-border bg-card p-4 sm:p-6" aria-live="polite">
      {!entries.length ? <p className="text-sm text-muted-foreground">Ask a question.</p> : entries.map(entry => <div key={entry.requestKey} className="space-y-3">
        <div><p className="mb-1 text-xs font-medium text-muted-foreground">You</p><p className="whitespace-pre-wrap break-words text-sm">{entry.input}</p></div>
        {entry.task?.output ? <div><p className="mb-1 text-xs font-medium text-muted-foreground">Assistant</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{entry.task.output}</p></div> : null}
        {entry.task && (cancellable || !entry.task.output || entry.task.state !== "completed") ? <div className="space-y-1 text-xs text-muted-foreground"><p>{entry.task.state.replaceAll("_", " ")}{entry.versionNumber ? ` · Version ${entry.versionNumber}` : ""}{entry.task.errorCode ? ` · ${entry.task.errorCode.replaceAll("_", " ").toLowerCase()}` : ""}</p><details><summary className="cursor-pointer">Task details</summary><code className="mt-2 block break-all">{entry.task.id}</code></details></div> : !entry.task ? <p className="text-xs text-muted-foreground">{sending ? "Submitting…" : "Request outcome unknown"}</p> : null}
      </div>)}
    </div>
    <ErrorMessage value={error} />
    {unknown && !sending ? <Button variant="outline" onClick={() => void submit(last!, entries.slice(0, -1))}>Retry request</Button> : null}
    <form onSubmit={event => void send(event)} className="space-y-3">
      <label className="block space-y-2 text-sm"><span>Message</span><Textarea value={input} onChange={event => setInput(event.target.value)} required maxLength={8_000} rows={3} placeholder="Ask a question" disabled={sending || Boolean(activeId) || unknown} /></label>
      <div className="flex gap-3"><Button type="submit" disabled={sending || Boolean(activeId) || unknown || !input.trim()}>{sending ? "Sending…" : "Send"}</Button>{cancellable && activeId ? <Button type="button" variant="outline" disabled={sending || last?.task?.state === "cancel_requested"} onClick={() => void cancel()}>Cancel task</Button> : null}</div>
    </form>
  </section>;
}
