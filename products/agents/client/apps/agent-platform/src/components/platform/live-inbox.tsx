import { useCallback, useEffect, useRef, useState } from "react";
import { useRouteLoaderData } from "react-router-dom";
import { MessageSquare, Search, RefreshCw, UserRound, Send, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { Session } from "@/lib/session";
import {
  listAgentCustomerConversations, listAgentHandoffs, getPlatformConversation,
  takeOverAgentConversation, sendAgentHumanMessage, addAgentPrivateNote,
  resolveAgentHandoff, continueAgentHandoff, releaseAgentHandoff,
  streamAgentConversation, streamAgentConversationFeed, listAgents,
  type AgentConversation, type ConversationResponse, type AgentHandoffQueueItem,
  type AgentDefinition,
} from "@/lib/agent-platform";

const label = (value?: string | null) => (value ?? "agent_active").replaceAll("_", " ");
const errorText = (error: unknown) => error instanceof Error ? error.message : "We couldn't load the inbox.";
export function LiveInbox() {
  const session = useRouteLoaderData("workspace") as Session;
  const actor = session.user.id;
  const canWrite = session.organizations?.find(org => org.id === session.activeOrganizationId)?.role !== "viewer";
  const [items, setItems] = useState<AgentConversation[]>([]);
  const [handoffs, setHandoffs] = useState<AgentHandoffQueueItem[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const [detail, setDetail] = useState<ConversationResponse | null>(null);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("");
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState("");
  const [assignment, setAssignment] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const cursorRef = useRef<Record<string, number>>({});
  // Keep failed writes tied to the same command; changing text creates a new one.
  const pendingWrite = useRef<{ target: string; text: string; note: boolean; key: string } | null>(null);
  const listRequest = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++listRequest.current;
    const [list, queue] = await Promise.all([
      listAgentCustomerConversations({ search, channelType: channel || undefined, agentId: agentId || undefined, limit: 200 }),
      listAgentHandoffs({ status: ["pending", "claimed"], limit: 100 }),
    ]);
    if (requestId === listRequest.current) { setItems(list.items); setHandoffs(queue.items); setLoading(false); }
  }, [search, channel, agentId]);
  const loadRef = useRef(load);
  loadRef.current = load;
  const loadDetail = useCallback(async (id: string) => {
    const result = await getPlatformConversation(id, { limit: 200 });
    if (selectedRef.current === id) setDetail(result);
  }, []);
  useEffect(() => { let active = true; listAgents().then(result => { if (active) setAgents(result.agents); }).catch(error => { if (active) setError(errorText(error)); }); return () => { active = false; }; }, []);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { await load(); } catch (error) { if (active) { setError(errorText(error)); setLoading(false); } } };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const connect = async () => {
      try {
        // The feed is a wake-up signal. Reload the authoritative list after reconnect.
        await load();
        await streamAgentConversationFeed(event => {
          if (event.event === "conversation.ready") setConnected(true);
          else void load().catch(() => {});
        }, controller.signal);
      } catch { /* The saved list remains available while reconnecting. */ }
      if (!controller.signal.aborted) { setConnected(false); timer = setTimeout(() => void connect(), 2000); }
    };
    void connect();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load]);
  useEffect(() => {
    setDetail(null); setText(""); pendingWrite.current = null;
    if (!selected) return;
    const id = selected, controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = () => loadDetail(id).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); });
    const connect = async () => {
      await refresh();
      try {
        await streamAgentConversation(id, event => {
          const sequence = Number(event.data.sequence_number);
          if (Number.isSafeInteger(sequence)) cursorRef.current[id] = Math.max(cursorRef.current[id] ?? 0, sequence);
          void refresh(); void loadRef.current().catch(() => {});
        }, controller.signal, cursorRef.current[id] ?? 0);
      } catch { /* Reconnect below, retaining the replay cursor. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => void connect(), 2000);
    };
    void connect();
    // Message notifications are hints; periodic history reload also catches missed hints.
    const fallback = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearTimeout(timer); clearInterval(fallback); };
  }, [selected, loadDetail]);
  const conversation = detail?.conversation;
  const handoff = handoffs.find(item => item.conversation.id === selected)?.handoff;
  const mine = conversation?.handoff_state === "human_owned" && conversation.assigned_actor_id === actor;
  const visible = items.filter(item => (!status || item.handoff_state === status)
    && (!assignment || (assignment === "mine" ? item.assigned_actor_id === actor : assignment === "unassigned" ? !item.assigned_actor_id : Boolean(item.assigned_actor_id) && item.assigned_actor_id !== actor)));
  async function mutate(operation: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await operation(); await load(); if (selectedRef.current) await loadDetail(selectedRef.current); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  async function send() {
    if (!selected || !text.trim() || (!note && !handoff)) return;
    const body = text.trim();
    if (!pendingWrite.current || pendingWrite.current.target !== selected || pendingWrite.current.text !== body || pendingWrite.current.note !== note)
      pendingWrite.current = { target: selected, text: body, note, key: crypto.randomUUID() };
    const command = pendingWrite.current;
    await mutate(async () => {
      if (note) await addAgentPrivateNote(selected, body, command.key);
      else {
        const result = await sendAgentHumanMessage(handoff!.id, { text: body, idempotencyKey: command.key });
        if (result.message.delivery_status === "failed" || result.message.delivery_status === "unknown") throw new Error("Reply saved but delivery failed. Retry this reply to check delivery.");
      }
      setText(""); pendingWrite.current = null;
    });
  }
  return <div className="flex min-h-[calc(100dvh-4rem)] flex-col px-5 py-6 sm:px-8">
    <div className="mb-5 flex items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">Inbox</h1><p className="mt-1 text-sm text-muted-foreground">Customer conversations across your agents.</p></div><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{connected ? "Live updates" : "Reconnecting · saved history available"}</span><Button variant="outline" size="sm" onClick={() => void mutate(load)} disabled={busy}><RefreshCw className="size-4" />Refresh</Button></div></div>
    {error && <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    <div className="mb-4 flex flex-wrap gap-2"><div className="relative min-w-52 flex-1"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={e => setSearch(e.target.value)} className="pl-9" /></div>
      <select aria-label="Agent filter" className="rounded-md border bg-background px-3 text-sm" value={agentId} onChange={e => setAgentId(e.target.value)}><option value="">All agents</option>{agents.filter(a => a.agent_audience === "customer_service").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      <select aria-label="Channel filter" className="rounded-md border bg-background px-3 text-sm" value={channel} onChange={e => setChannel(e.target.value)}><option value="">All channels</option>{[...new Set(items.map(item => item.channel_type)), "website"].filter((v,i,a) => a.indexOf(v) === i).map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Status filter" className="rounded-md border bg-background px-3 text-sm" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{["agent_active", "handoff_requested", "human_owned", "resolved"].map(value => <option key={value} value={value}>{label(value)}</option>)}</select>
      <select aria-label="Assignment filter" className="rounded-md border bg-background px-3 text-sm" value={assignment} onChange={e => setAssignment(e.target.value)}><option value="">Everyone</option><option value="mine">Assigned to me</option><option value="team">Other teammates</option><option value="unassigned">Unassigned</option></select>
    </div>
    <div className="grid flex-1 overflow-hidden rounded-xl border bg-card md:grid-cols-[300px_minmax(0,1fr)]">
      <aside aria-label="Conversation list" className="max-h-[70dvh] overflow-y-auto border-b md:border-b-0 md:border-r">
        {loading ? <p className="p-5 text-sm text-muted-foreground">Loading conversations…</p> : !visible.length ? <p className="p-5 text-sm text-muted-foreground">No customer conversations match these filters.</p> : visible.map(item => <button key={item.id} onClick={() => { setSelected(item.id); setError(null); }} className={`w-full border-b p-4 text-left hover:bg-muted/50 ${selected === item.id ? "bg-muted" : ""}`}><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{item.title || item.participant_display_name || "Website visitor"}</span>{Boolean(item.unread_count) && <span className="rounded-full bg-primary px-2 text-xs text-primary-foreground">{item.unread_count}</span>}</div><p className="mt-1 truncate text-xs text-muted-foreground">{item.last_message_preview || "New conversation"}</p><p className="mt-2 text-[11px] text-muted-foreground">{item.channel_type} · {label(item.handoff_state)}</p></button>)}
      </aside>
      <section aria-label="Selected conversation" className="flex min-h-[500px] flex-col">
        {!conversation ? <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-muted-foreground"><MessageSquare className="size-8" /><p className="text-sm">{selected ? "Loading conversation…" : "Select a conversation to read or reply."}</p></div> : <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4"><div><h2 className="font-medium">{conversation.title || "Website visitor"}</h2><p className="mt-1 text-xs text-muted-foreground">{conversation.channel_type} · {label(conversation.handoff_state)}{conversation.assigned_actor_id ? mine ? " · Assigned to you" : " · Assigned to a teammate" : ""}</p></div><div className="flex flex-wrap gap-2">{canWrite && <>
            {conversation.handoff_state !== "human_owned" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(() => takeOverAgentConversation(conversation.id, crypto.randomUUID(), conversation.handoff_state === "resolved"))}><UserRound className="size-4" />{conversation.handoff_state === "resolved" ? "Reopen" : "Take over"}</Button>}
            {mine && handoff && <><Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(() => continueAgentHandoff(handoff.id))}>Return to agent</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(() => resolveAgentHandoff(handoff.id))}>Resolve</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void mutate(() => releaseAgentHandoff(handoff.id))}>Unassign</Button></>}
          </>}</div></div>
          <div aria-label="Conversation messages" aria-live="polite" className="flex max-h-[55dvh] flex-1 flex-col gap-3 overflow-y-auto p-5">
            {detail.hasMore && <p className="text-center text-xs text-muted-foreground">Showing the latest 200 messages.</p>}
            {detail.messages.map(message => <article key={message.id} className={`max-w-[85%] rounded-xl px-4 py-3 ${message.message_type === "private_note" ? "self-start border border-amber-300/30 bg-amber-100/30" : message.direction === "inbound" ? "self-start bg-muted" : message.direction === "outbound" ? "self-end bg-primary/10" : "self-start border"}`}><p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{message.message_type === "private_note" ? "Private note · teammates only" : message.direction === "inbound" ? "Visitor" : message.provider === "kasitek-human" ? "Teammate" : message.direction === "outbound" ? "Agent" : "System"}</p><p className="whitespace-pre-wrap break-words text-sm">{typeof message.content.text === "string" ? message.content.text : `[${message.message_type}]`}</p><p className="mt-2 text-[10px] text-muted-foreground">{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{message.direction === "outbound" ? ` · ${message.delivery_status ?? "pending"}` : ""}</p></article>)}
          </div>
          {canWrite ? <div className="border-t p-4"><div className="mb-2 flex gap-2"><Button size="sm" variant={!note ? "secondary" : "ghost"} onClick={() => setNote(false)}>Reply</Button><Button size="sm" variant={note ? "secondary" : "ghost"} onClick={() => setNote(true)}><StickyNote className="size-3" />Private note</Button></div><Textarea aria-label={note ? "Private note" : "Human reply"} value={text} onChange={e => setText(e.target.value)} placeholder={note ? "Add a note for your teammates" : mine ? "Reply to the visitor" : "Take over this conversation to reply"} disabled={busy || (!note && !mine)} className="min-h-20" /><div className="mt-2 flex items-center justify-between"><p className="text-xs text-muted-foreground">{note ? "Notes stay inside your workspace." : mine ? "You own replies. Agent replies are paused." : "The backend controls who can reply."}</p><Button size="sm" disabled={busy || !text.trim() || (!note && (!mine || !handoff))} onClick={() => void send()}><Send className="size-4" />{note ? "Save note" : "Send reply"}</Button></div></div> : <p className="border-t p-4 text-sm text-muted-foreground">Your workspace role allows reading conversations.</p>}
        </>}
      </section>
    </div>
  </div>;
}
