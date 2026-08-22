"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Bot,
  Check,
  CircleAlert,
  Clock3,
  Inbox,
  Loader2,
  MessageSquare,
  RefreshCw,
  Search,
  Send,
  Square,
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  claimAgentHandoff,
  cancelAgentRun,
  continueAgentHandoff,
  getPlatformConversation,
  listAgentLiveConversations,
  listAgentHandoffs,
  resolveAgentHandoff,
  sendAgentHumanMessage,
  type AgentMessage,
  type AgentHandoffQueue,
  type AgentHandoffQueueItem,
  type AgentHandoffPriority,
  type AgentHandoffStatus,
} from "@/lib/agent-platform";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";

type QueueView = "handoff" | "human" | "live" | "all";

const viewStatuses: Record<QueueView, AgentHandoffStatus[]> = {
  handoff: ["pending"],
  human: ["claimed"],
  live: [],
  all: ["pending", "claimed", "resolved", "expired", "cancelled"],
};

function statusClass(status: AgentHandoffStatus) {
  if (status === "pending") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  if (status === "claimed") return "border-status-info/30 bg-status-info-soft text-status-info";
  if (status === "resolved") return "border-status-success/30 bg-status-success-soft text-status-success";
  return "border-border bg-secondary text-muted-foreground";
}

function priorityClass(priority: AgentHandoffQueueItem["handoff"]["priority"]) {
  if (priority === "urgent") return "text-destructive";
  if (priority === "high") return "text-status-attention";
  return "text-muted-foreground";
}

function timeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function titleFor(item: AgentHandoffQueueItem) {
  return item.conversation.participant_display_name || item.conversation.title || "Customer conversation";
}

function EmptyQueue({ view }: { view: QueueView }) {
  const label = view === "handoff" ? "No handoff requests" : view === "human" ? "No human-owned conversations" : "No handoff activity";
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border px-5 text-center">
      <Inbox className="h-6 w-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium text-foreground">{label}</p>
    </div>
  );
}

export function AgentConversationsPageClient({ initialQueue }: { initialQueue: AgentHandoffQueue }) {
  const [view, setView] = useState<QueueView>("handoff");
  const [queue, setQueue] = useState(initialQueue);
  const [liveQueue, setLiveQueue] = useState<Array<{ conversation: AgentHandoffQueueItem["conversation"]; run: { id: string; status: string; installation_id: string; agent_definition_id: string; created_at: string; updated_at: string; trigger_type: string } }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialQueue.items[0]?.handoff.id ?? null);
  const [selectedLiveId, setSelectedLiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [priority, setPriority] = useState<AgentHandoffPriority | "">("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [activeRuns, setActiveRuns] = useState<Array<{ id: string; status: string }>>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  const loadQueue = useCallback(async (nextView: QueueView = view, silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      if (nextView === "live") {
        const result = await listAgentLiveConversations({ limit: 100, search: search.trim() || undefined });
        setLiveQueue(result.items);
        setSelectedLiveId((current) => result.items.some((item) => item.conversation.id === current) ? current : result.items[0]?.conversation.id ?? null);
      } else {
        const result = await listAgentHandoffs({ status: viewStatuses[nextView], limit: 100, search: search.trim() || undefined, priority: priority || undefined });
        setQueue(result);
        setSelectedId((current) => result.items.some((item) => item.handoff.id === current) ? current : result.items[0]?.handoff.id ?? null);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load conversations");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [priority, search, view]);

  useEffect(() => {
    void loadQueue(view);
  }, [loadQueue, view]);

  useEffect(() => {
    const timer = window.setInterval(() => void loadQueue(view, true), 20_000);
    return () => window.clearInterval(timer);
  }, [loadQueue, view]);

  const selected = useMemo(() => queue.items.find((item) => item.handoff.id === selectedId) ?? null, [queue.items, selectedId]);
  const selectedLive = useMemo(() => liveQueue.find((item) => item.conversation.id === selectedLiveId) ?? null, [liveQueue, selectedLiveId]);
  const activeConversationId = view === "live" ? selectedLive?.conversation.id : selected?.conversation.id;

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      setActiveRuns([]);
      return;
    }
    let cancelled = false;
    setTranscriptLoading(true);
    void getPlatformConversation(activeConversationId, { limit: 100 })
      .then((result) => {
        if (cancelled) return;
        setMessages(result.messages ?? []);
        setActiveRuns((result.activeRuns ?? []).map((run) => ({ id: run.id, status: run.status })));
      })
      .catch(() => {
        if (!cancelled) {
          setMessages([]);
          setActiveRuns([]);
        }
      })
      .finally(() => {
        if (!cancelled) setTranscriptLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeConversationId]);

  async function mutate(id: string, action: "claim" | "continue" | "resolve") {
    setBusy(`${action}:${id}`);
    try {
      if (action === "claim") await claimAgentHandoff(id);
      if (action === "continue") await continueAgentHandoff(id, resolution.trim() || undefined);
      if (action === "resolve") await resolveAgentHandoff(id, resolution.trim() || undefined);
      setResolution("");
      await loadQueue(view);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update handoff");
    } finally {
      setBusy(null);
    }
  }

  async function sendMessage() {
    if (!selected || !messageDraft.trim()) return;
    setBusy(`message:${selected.handoff.id}`);
    try {
      await sendAgentHumanMessage(selected.handoff.id, { text: messageDraft.trim(), idempotencyKey: crypto.randomUUID() });
      setMessageDraft("");
      const latest = await getPlatformConversation(selected.conversation.id, { limit: 100 });
      setMessages(latest.messages ?? []);
      setActiveRuns((latest.activeRuns ?? []).map((run) => ({ id: run.id, status: run.status })));
      await loadQueue(view, true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to send message");
    } finally {
      setBusy(null);
    }
  }

  async function stopAgentRun() {
    const runId = activeRuns[0]?.id;
    if (!runId || !selected) return;
    setBusy(`stop:${runId}`);
    try {
      await cancelAgentRun(runId, "Stopped by operator during human handoff");
      const latest = await getPlatformConversation(selected.conversation.id, { limit: 100 });
      setMessages(latest.messages ?? []);
      setActiveRuns((latest.activeRuns ?? []).map((run) => ({ id: run.id, status: run.status })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to stop agent run");
    } finally {
      setBusy(null);
    }
  }

  const counts = {
    handoff: queue.items.filter((item) => item.handoff.status === "pending").length,
    human: queue.items.filter((item) => item.handoff.status === "claimed").length,
    live: liveQueue.length,
  };

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1440px]">
        <PageHeader>
          <PageHeaderContent>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
            <PageHeaderTitle>Agent conversations</PageHeaderTitle>
            <PageHeaderDescription>Customer conversations that need operator attention.</PageHeaderDescription>
          </PageHeaderContent>
          <Button type="button" variant="outline" onClick={() => void loadQueue(view)} disabled={refreshing}>
            {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh
          </Button>
        </PageHeader>

        {error ? <div className="mt-6 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"><CircleAlert className="h-4 w-4 shrink-0" />{error}</div> : null}

        <MotionReveal delay={0.08}>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            {(["handoff", "human", "live", "all"] as QueueView[]).map((key) => (
              <button key={key} type="button" onClick={() => setView(key)} className={`rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 ${view === key ? "border-primary/60 ring-1 ring-primary/20" : "border-border"}`}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{key === "handoff" ? "Handoff requests" : key === "human" ? "Human owned" : key === "live" ? "Agent live" : "All activity"}</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{key === "handoff" ? counts.handoff : key === "human" ? counts.human : key === "live" ? counts.live : queue.items.length}</p>
              </button>
            ))}
          </div>
        </MotionReveal>

        <MotionReveal delay={0.14}>
          <section className="mt-6 rounded-xl border border-border bg-card/80 p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-1 rounded-lg bg-secondary/70 p-1">
                {(["handoff", "human", "live", "all"] as QueueView[]).map((key) => <button key={key} type="button" onClick={() => setView(key)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${view === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{key === "handoff" ? "Handoff requests" : key === "human" ? "Human owned" : key === "live" ? "Agent live" : "All"}</button>)}
              </div>
              <div className="flex w-full gap-2 sm:w-auto"><div className="relative min-w-0 flex-1 sm:w-56"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" className="pl-9" /></div><select aria-label="Priority" value={priority} onChange={(event) => setPriority(event.target.value as AgentHandoffPriority | "")} className="h-9 rounded-md border border-border bg-background px-2.5 text-xs text-foreground"><option value="">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option></select></div>
            </div>
          </section>
        </MotionReveal>

        <MotionReveal delay={0.2}>
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
            <aside className="space-y-2" aria-label="Agent conversations">
              {view === "live" ? (liveQueue.length === 0 ? <EmptyQueue view="all" /> : liveQueue.map((item) => (
                <button key={item.conversation.id} type="button" onClick={() => setSelectedLiveId(item.conversation.id)} className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedLiveId === item.conversation.id ? "border-primary/60 bg-primary/5" : "border-border bg-card hover:border-primary/30"}`}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{item.conversation.participant_display_name || item.conversation.title || "Customer conversation"}</p><p className="mt-1 truncate text-xs text-muted-foreground">{item.conversation.channel_type} · {timeLabel(item.run.updated_at)}</p></div><Badge className="shrink-0 border-status-info/30 bg-status-info-soft text-status-info">{item.run.status.replaceAll("_", " ")}</Badge></div>
                  <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{item.conversation.last_message_preview || "Agent is processing this conversation."}</p>
                </button>
              ))) : (queue.items.length === 0 ? <EmptyQueue view={view} /> : queue.items.map((item) => (
                <button key={item.handoff.id} type="button" onClick={() => setSelectedId(item.handoff.id)} className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedId === item.handoff.id ? "border-primary/60 bg-primary/5" : "border-border bg-card hover:border-primary/30"}`}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{titleFor(item)}</p><p className="mt-1 truncate text-xs text-muted-foreground">{item.handoff.channel_type} · {timeLabel(item.handoff.created_at)}</p></div><Badge className={`shrink-0 ${statusClass(item.handoff.status)}`}>{item.handoff.status}</Badge></div>
                  <p className={`mt-3 line-clamp-2 text-xs ${priorityClass(item.handoff.priority)}`}>{item.handoff.summary}</p>
                </button>
              )))}
            </aside>

            <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6" aria-live="polite">
              {view === "live" ? (!selectedLive ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">Select a live conversation</p></div> : (
                <div><div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><Bot className="h-5 w-5 text-primary" /><h2 className="truncate text-lg font-semibold text-foreground">{selectedLive.conversation.participant_display_name || selectedLive.conversation.title || "Customer conversation"}</h2></div><p className="mt-1 text-sm text-muted-foreground">{selectedLive.conversation.channel_type} · {timeLabel(selectedLive.run.updated_at)}</p></div><Badge className="border-status-info/30 bg-status-info-soft text-status-info">Agent live</Badge></div><div className="mt-5 rounded-lg border border-status-info/30 bg-status-info-soft px-3 py-2 text-sm text-status-info"><span className="flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-current" />Run {selectedLive.run.status.replaceAll("_", " ")}</span></div><div className="mt-6 rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Transcript</p>{transcriptLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}</div>{messages.length ? <div className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto pr-1">{messages.map((message) => { const text = typeof message.content?.text === "string" ? message.content.text : message.message_type; const isInbound = message.direction === "inbound"; return <div key={message.id} className={`flex ${isInbound ? "justify-start" : "justify-end"}`}><div className={`max-w-[86%] rounded-xl px-3 py-2 text-sm ${isInbound ? "bg-secondary text-foreground" : "bg-primary text-primary-foreground"}`}><p className="whitespace-pre-wrap leading-5">{text}</p><p className={`mt-1 text-[10px] ${isInbound ? "text-muted-foreground" : "text-primary-foreground/70"}`}>{isInbound ? "Customer" : message.direction === "system" ? "System" : "Agent"} · {timeLabel(message.created_at)}</p></div></div>; })}</div> : <p className="mt-4 text-sm text-muted-foreground">{transcriptLoading ? "Loading transcript…" : "No messages recorded."}</p>}</div></div>
              )) : !selected ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">Select a conversation</p></div> : (
                <div>
                  <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><UserRound className="h-5 w-5 text-primary" /><h2 className="truncate text-lg font-semibold text-foreground">{titleFor(selected)}</h2></div><p className="mt-1 text-sm text-muted-foreground">{selected.handoff.channel_type} · {timeLabel(selected.handoff.created_at)}</p></div><Badge className={statusClass(selected.handoff.status)}>{selected.handoff.status}</Badge></div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Reason</p><p className="mt-1 text-sm font-medium capitalize text-foreground">{selected.handoff.reason.replaceAll("_", " ")}</p></div><div><p className="text-xs text-muted-foreground">Priority</p><p className={`mt-1 text-sm font-medium capitalize ${priorityClass(selected.handoff.priority)}`}>{selected.handoff.priority}</p></div><div><p className="text-xs text-muted-foreground">Agent</p><p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground"><Bot className="h-4 w-4 text-muted-foreground" />{selected.conversation.installation_id.slice(0, 8)}</p></div></div>
                  {activeRuns.length ? <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-info/30 bg-status-info-soft px-3 py-2 text-sm text-status-info"><span className="flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-current" />Agent run active · {activeRuns[0]?.status.replaceAll("_", " ")}</span><Button type="button" size="sm" variant="outline" className="h-7 border-status-info/30 bg-transparent text-status-info hover:bg-status-info/10" disabled={busy !== null} onClick={() => void stopAgentRun()}>{busy === `stop:${activeRuns[0]?.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1.5 h-3.5 w-3.5" />}Stop agent</Button></div> : null}
                  <div className="mt-6 space-y-4"><div className="rounded-lg border border-border bg-secondary/35 p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Handoff summary</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{selected.handoff.summary}</p></div>{selected.handoff.customer_message ? <div className="rounded-lg border border-border p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Customer message</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{selected.handoff.customer_message}</p></div> : null}</div>
                  <div className="mt-6 rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Transcript</p>{transcriptLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}</div>{messages.length ? <div className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto pr-1">{messages.map((message) => { const text = typeof message.content?.text === "string" ? message.content.text : message.message_type; const isInbound = message.direction === "inbound"; return <div key={message.id} className={`flex ${isInbound ? "justify-start" : "justify-end"}`}><div className={`max-w-[86%] rounded-xl px-3 py-2 text-sm ${isInbound ? "bg-secondary text-foreground" : "bg-primary text-primary-foreground"}`}><p className="whitespace-pre-wrap leading-5">{text}</p><p className={`mt-1 text-[10px] ${isInbound ? "text-muted-foreground" : "text-primary-foreground/70"}`}>{isInbound ? "Customer" : message.direction === "system" ? "System" : "Agent"} · {timeLabel(message.created_at)}</p></div></div>; })}</div> : <p className="mt-4 text-sm text-muted-foreground">{transcriptLoading ? "Loading transcript…" : "No messages recorded."}</p>}</div>
                  {selected.handoff.status === "claimed" ? <div className="mt-4 rounded-lg border border-border bg-secondary/20 p-4"><label htmlFor="human-message" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Message customer</label><Textarea id="human-message" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} placeholder="Write a reply" className="mt-3 min-h-24 resize-y bg-background" disabled={busy !== null} /><div className="mt-3 flex justify-end"><Button type="button" disabled={busy !== null || !messageDraft.trim()} onClick={() => void sendMessage()}>{busy === `message:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}Send message</Button></div></div> : null}
                  {selected.handoff.status === "claimed" ? <div className="mt-6"><label htmlFor="handoff-resolution" className="text-sm font-medium text-foreground">Resolution note</label><Textarea id="handoff-resolution" value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="Optional note" className="mt-2 min-h-24" /><div className="mt-3 flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy !== null} onClick={() => void mutate(selected.handoff.id, "continue")}>{busy === `continue:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock3 className="mr-2 h-4 w-4" />}Continue with agent</Button><Button type="button" disabled={busy !== null} onClick={() => void mutate(selected.handoff.id, "resolve")}>{busy === `resolve:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}Resolve</Button></div></div> : null}
                  {selected.handoff.status === "pending" ? <div className="mt-6"><Button type="button" disabled={busy !== null} onClick={() => void mutate(selected.handoff.id, "claim")}>{busy === `claim:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserRound className="mr-2 h-4 w-4" />}Take over</Button></div> : null}
                </div>
              )}
            </section>
          </div>
        </MotionReveal>
      </div>
    </div>
  );
}
