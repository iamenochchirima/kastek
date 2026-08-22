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
  UserRound,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  claimAgentHandoff,
  continueAgentHandoff,
  listAgentHandoffs,
  resolveAgentHandoff,
  type AgentHandoffQueue,
  type AgentHandoffQueueItem,
  type AgentHandoffStatus,
} from "@/lib/agent-platform";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";

type QueueView = "handoff" | "human" | "all";

const viewStatuses: Record<QueueView, AgentHandoffStatus[]> = {
  handoff: ["pending"],
  human: ["claimed"],
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
  const [selectedId, setSelectedId] = useState<string | null>(initialQueue.items[0]?.handoff.id ?? null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");

  const loadQueue = useCallback(async (nextView: QueueView = view, silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const result = await listAgentHandoffs({ status: viewStatuses[nextView], limit: 100, search: search.trim() || undefined });
      setQueue(result);
      setSelectedId((current) => result.items.some((item) => item.handoff.id === current) ? current : result.items[0]?.handoff.id ?? null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load conversations");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [search, view]);

  useEffect(() => {
    if (view === "handoff" && queue === initialQueue && !search) return;
    void loadQueue(view);
  }, [view, search]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setInterval(() => void loadQueue(view, true), 20_000);
    return () => window.clearInterval(timer);
  }, [loadQueue, view]);

  const selected = useMemo(() => queue.items.find((item) => item.handoff.id === selectedId) ?? null, [queue.items, selectedId]);

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

  const counts = {
    handoff: queue.items.filter((item) => item.handoff.status === "pending").length,
    human: queue.items.filter((item) => item.handoff.status === "claimed").length,
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
            {(["handoff", "human", "all"] as QueueView[]).map((key) => (
              <button key={key} type="button" onClick={() => setView(key)} className={`rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/40 ${view === key ? "border-primary/60 ring-1 ring-primary/20" : "border-border"}`}>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{key === "handoff" ? "Handoff requests" : key === "human" ? "Human owned" : "All activity"}</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">{key === "handoff" ? counts.handoff : key === "human" ? counts.human : queue.items.length}</p>
              </button>
            ))}
          </div>
        </MotionReveal>

        <MotionReveal delay={0.14}>
          <section className="mt-6 rounded-xl border border-border bg-card/80 p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-1 rounded-lg bg-secondary/70 p-1">
                {(["handoff", "human", "all"] as QueueView[]).map((key) => <button key={key} type="button" onClick={() => setView(key)} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${view === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{key === "handoff" ? "Handoff requests" : key === "human" ? "Human owned" : "All"}</button>)}
              </div>
              <div className="relative w-full sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search conversations" className="pl-9" /></div>
            </div>
          </section>
        </MotionReveal>

        <MotionReveal delay={0.2}>
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
            <aside className="space-y-2" aria-label="Agent conversations">
              {queue.items.length === 0 ? <EmptyQueue view={view} /> : queue.items.map((item) => (
                <button key={item.handoff.id} type="button" onClick={() => setSelectedId(item.handoff.id)} className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedId === item.handoff.id ? "border-primary/60 bg-primary/5" : "border-border bg-card hover:border-primary/30"}`}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{titleFor(item)}</p><p className="mt-1 truncate text-xs text-muted-foreground">{item.handoff.channel_type} · {timeLabel(item.handoff.created_at)}</p></div><Badge className={`shrink-0 ${statusClass(item.handoff.status)}`}>{item.handoff.status}</Badge></div>
                  <p className={`mt-3 line-clamp-2 text-xs ${priorityClass(item.handoff.priority)}`}>{item.handoff.summary}</p>
                </button>
              ))}
            </aside>

            <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6" aria-live="polite">
              {!selected ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">Select a conversation</p></div> : (
                <div>
                  <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><UserRound className="h-5 w-5 text-primary" /><h2 className="truncate text-lg font-semibold text-foreground">{titleFor(selected)}</h2></div><p className="mt-1 text-sm text-muted-foreground">{selected.handoff.channel_type} · {timeLabel(selected.handoff.created_at)}</p></div><Badge className={statusClass(selected.handoff.status)}>{selected.handoff.status}</Badge></div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Reason</p><p className="mt-1 text-sm font-medium capitalize text-foreground">{selected.handoff.reason.replaceAll("_", " ")}</p></div><div><p className="text-xs text-muted-foreground">Priority</p><p className={`mt-1 text-sm font-medium capitalize ${priorityClass(selected.handoff.priority)}`}>{selected.handoff.priority}</p></div><div><p className="text-xs text-muted-foreground">Agent</p><p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground"><Bot className="h-4 w-4 text-muted-foreground" />{selected.conversation.installation_id.slice(0, 8)}</p></div></div>
                  <div className="mt-6 space-y-4"><div className="rounded-lg border border-border bg-secondary/35 p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Handoff summary</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{selected.handoff.summary}</p></div>{selected.handoff.customer_message ? <div className="rounded-lg border border-border p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Customer message</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{selected.handoff.customer_message}</p></div> : null}</div>
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
