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
  getAgentConversationSummary,
  getAgentHandoff,
  getPlatformConversation,
  listAgentCustomerConversations,
  listAgentLiveConversations,
  listAgentHandoffs,
  releaseAgentHandoff,
  resolveAgentHandoff,
  sendAgentHumanMessage,
  streamAgentConversationFeed,
  streamAgentConversation,
  type AgentMessage,
  type AgentConversation,
  type AgentConversationSummary,
  type AgentHandoffQueue,
  type AgentHandoffQueueItem,
  type AgentHandoffHistoryEvent,
  type AgentHandoffPriority,
  type AgentHandoffReason,
  type AgentHandoffStatus,
} from "@/lib/agent-platform";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { AgentMessageMedia, agentMessageHasMedia } from "./agent-message-media";
import { AgentAuthorizationAction } from "./agent-authorization-action";

type QueueView = "inbox" | "mine" | "team" | "live" | "all";
type ConversationFeedState = "connecting" | "connected" | "reconnecting";

type InitialFilters = {
  view?: QueueView | "handoff" | "human";
  agentId?: string;
  installationId?: string;
  search?: string;
  channelType?: string;
  reason?: AgentHandoffReason;
  priority?: AgentHandoffPriority;
};

const viewStatuses: Record<QueueView, AgentHandoffStatus[]> = {
  inbox: ["pending"],
  mine: ["claimed"],
  team: ["claimed"],
  live: [],
  all: ["pending", "claimed", "resolved", "expired", "cancelled"],
};

const handoffReasons: Array<{ value: AgentHandoffReason; label: string }> = [
  { value: "customer_requested", label: "Customer requested" },
  { value: "agent_uncertain", label: "Agent uncertain" },
  { value: "policy_required", label: "Policy required" },
  { value: "high_value", label: "High value" },
  { value: "configured_workflow", label: "Configured workflow" },
  { value: "other", label: "Other" },
];

function statusClass(status: AgentHandoffStatus) {
  if (status === "pending") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  if (status === "claimed") return "border-status-info/30 bg-status-info-soft text-status-info";
  if (status === "resolved") return "border-status-success/30 bg-status-success-soft text-status-success";
  return "border-border bg-secondary text-muted-foreground";
}

function AgentTranscriptMessage({ message, onRetry, retrying = false, deliveryError }: { message: AgentMessage; onRetry?: () => void; retrying?: boolean; deliveryError?: string }) {
  const text = typeof message.content?.text === "string" ? message.content.text : "";
  const isInbound = message.direction === "inbound";

  return (
    <div className={`flex ${isInbound ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[86%] rounded-xl px-3 py-2 text-sm ${isInbound ? "bg-secondary text-foreground" : "bg-primary text-primary-foreground"}`}>
        <AgentMessageMedia message={message} />
        {text ? <p className="whitespace-pre-wrap leading-5">{text}</p> : !agentMessageHasMedia(message) ? <p className="whitespace-pre-wrap leading-5">{message.message_type}</p> : null}
        <AgentAuthorizationAction message={message} />
        <div className={`mt-1 flex items-center gap-1.5 text-[10px] ${isInbound ? "text-muted-foreground" : "text-primary-foreground/70"}`}>
          <span>{messageAttribution(message)} · {timeLabel(message.created_at)}</span>
          {!isInbound && message.delivery_status && message.delivery_status !== "local" ? <span>· {message.delivery_status}</span> : null}
        </div>
        {!isInbound && message.delivery_status === "failed" && onRetry ? <Button type="button" variant="ghost" size="sm" className="mt-1 h-6 px-1.5 text-[11px] text-current hover:bg-black/10" disabled={retrying} onClick={onRetry}>{retrying ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}Retry</Button> : null}
        {!isInbound && message.delivery_status === "failed" ? <p className="mt-1 text-[11px] text-current/80">{deliveryError ?? "Delivery failed"}</p> : null}
      </div>
    </div>
  );
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

function channelLabel(channelType: string) {
  switch (channelType.toLowerCase()) {
    case "facebook":
    case "messenger":
      return "Messenger";
    case "instagram":
      return "Instagram";
    case "website":
      return "Website Chat";
    case "platform":
      return "Platform";
    case "whatsapp":
      return "WhatsApp";
    case "telegram":
      return "Telegram";
    case "discord":
      return "Discord";
    default:
      return channelType.replaceAll("_", " ");
  }
}

function handoffSourceLabel(source: AgentHandoffQueueItem["handoff"]["request_source"]): string {
  if (source === "customer_confirmed") return "Customer confirmation";
  if (source === "customer_direct") return "Customer request";
  if (source === "operator") return "Operator";
  return "Legacy request";
}

function messageAttribution(message: AgentMessage) {
  if (message.participant_type === "customer" || message.direction === "inbound") return message.participant_display_name || "Customer";
  if (message.provider === "kasitek-human" || message.participant_type === "staff") return message.participant_display_name || "Human";
  if (message.participant_type === "system" || message.direction === "system") return "System";
  return message.participant_display_name || "Agent";
}

function handoffEventLabel(event: AgentHandoffHistoryEvent) {
  if (event.event_type === "conversation.human_message.sent") return "Human message";
  const action = event.event_type.replace("conversation.handoff.", "").replaceAll("_", " ");
  return action.charAt(0).toUpperCase() + action.slice(1);
}

function CustomerConversationDetail({
  conversation,
  messages,
  activeRuns,
  transcriptLoading,
  busy,
  onStop,
  badgeLabel = "Customer",
}: {
  conversation: AgentConversation;
  messages: AgentMessage[];
  activeRuns: Array<{ id: string; status: string }>;
  transcriptLoading: boolean;
  busy: string | null;
  onStop: () => void;
  badgeLabel?: string;
}) {
  return (
    <div>
      <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><UserRound className="h-5 w-5 text-primary" /><h2 className="truncate text-lg font-semibold text-foreground">{conversation.participant_display_name || conversation.title || "Customer conversation"}</h2></div>
          <p className="mt-1 text-sm text-muted-foreground">{channelLabel(conversation.channel_type)} · {timeLabel(conversation.last_message_at || conversation.updated_at)}</p>
        </div>
        <Badge className="border-status-success/30 bg-status-success-soft text-status-success">{badgeLabel}</Badge>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">Channel</p><p className="mt-1 text-sm font-medium text-foreground">{channelLabel(conversation.channel_type)}</p></div>
        <div><p className="text-xs text-muted-foreground">Messages</p><p className="mt-1 text-sm font-medium text-foreground">{conversation.message_count ?? 0}</p></div>
        <div><p className="text-xs text-muted-foreground">Agent</p><p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground"><Bot className="h-4 w-4 text-muted-foreground" />{conversation.installation_id.slice(0, 8)}</p></div>
      </div>
      {activeRuns.length ? <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-info/30 bg-status-info-soft px-3 py-2 text-sm text-status-info"><span className="flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-current" />Agent run active · {activeRuns[0]?.status.replaceAll("_", " ")}</span><Button type="button" size="sm" variant="outline" className="h-7 border-status-info/30 bg-transparent text-status-info hover:bg-status-info/10" disabled={busy !== null} onClick={onStop}>{busy === `stop:${activeRuns[0]?.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1.5 h-3.5 w-3.5" />}Stop agent</Button></div> : null}
      <div className="mt-6 rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Transcript</p>{transcriptLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}</div>{messages.length ? <div className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto pr-1">{messages.map((message) => <AgentTranscriptMessage key={message.id} message={message} />)}</div> : <p className="mt-4 text-sm text-muted-foreground">{transcriptLoading ? "Loading transcript…" : "No messages recorded."}</p>}</div>
    </div>
  );
}

function EmptyQueue({ view }: { view: QueueView }) {
  const label = view === "inbox" ? "No requests waiting" : view === "mine" ? "No conversations assigned to you" : view === "team" ? "No team assignments" : view === "live" ? "No live conversations" : "No customer conversations";
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-border px-5 text-center">
      <Inbox className="h-6 w-6 text-muted-foreground" />
      <p className="mt-3 text-sm font-medium text-foreground">{label}</p>
    </div>
  );
}

export function AgentConversationsPageClient({ initialQueue, initialCustomerConversations = [], initialSummary, initialFilters }: { initialQueue: AgentHandoffQueue; initialCustomerConversations?: AgentConversation[]; initialSummary?: AgentConversationSummary; initialFilters?: InitialFilters }) {
  const initialView = initialFilters?.view === "handoff" ? "inbox" : initialFilters?.view === "human" ? "mine" : initialFilters?.view ?? "all";
  const [view, setView] = useState<QueueView>(initialView);
  const [queue, setQueue] = useState(initialQueue);
  const [customerQueue, setCustomerQueue] = useState<AgentConversation[]>(initialCustomerConversations);
  const [liveQueue, setLiveQueue] = useState<Array<{ conversation: AgentConversation }>>([]);
  const [summary, setSummary] = useState<AgentConversationSummary>(initialSummary ?? { all: 0, live: 0, inbox: 0, mine: 0, team: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(initialQueue.items[0]?.handoff.id ?? null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(initialCustomerConversations[0]?.id ?? null);
  const [selectedLiveId, setSelectedLiveId] = useState<string | null>(null);
  const [search, setSearch] = useState(initialFilters?.search ?? "");
  const [priority, setPriority] = useState<AgentHandoffPriority | "">(initialFilters?.priority ?? "");
  const [channelType, setChannelType] = useState(initialFilters?.channelType ?? "");
  const [reason, setReason] = useState<AgentHandoffReason | "">(initialFilters?.reason ?? "");
  const [agentId] = useState(initialFilters?.agentId);
  const [installationId] = useState(initialFilters?.installationId);
  const [queueCursor, setQueueCursor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [activeRuns, setActiveRuns] = useState<Array<{ id: string; status: string }>>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [handoffHistory, setHandoffHistory] = useState<AgentHandoffHistoryEvent[]>([]);
  const [messageErrors, setMessageErrors] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState(search);
  const [feedState, setFeedState] = useState<ConversationFeedState>("connecting");

  const summaryFilters = useMemo(() => ({
    agentId,
    installationId,
    channelType: channelType === "messenger" ? "facebook" : channelType || undefined,
    search: searchQuery.trim() || undefined,
  }), [agentId, channelType, installationId, searchQuery]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const loadSummary = useCallback(async (silent = false) => {
    try {
      const result = await getAgentConversationSummary(summaryFilters);
      setSummary(result);
    } catch (cause) {
      if (!silent) setError(cause instanceof Error ? cause.message : "Unable to load conversation counts");
    }
  }, [summaryFilters]);

  const loadQueue = useCallback(async (nextView: QueueView = view, silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      if (nextView === "live") {
        const result = await listAgentLiveConversations({ agentId, installationId, channelType: channelType === "messenger" ? "facebook" : channelType || undefined, limit: 100, search: searchQuery.trim() || undefined });
        setLiveQueue(result.items);
        setSelectedLiveId((current) => result.items.some((item) => item.conversation.id === current) ? current : result.items[0]?.conversation.id ?? null);
      } else if (nextView === "all") {
        const result = await listAgentCustomerConversations({ agentId, installationId, channelType: channelType === "messenger" ? "facebook" : channelType || undefined, limit: 100, search: searchQuery.trim() || undefined });
        setCustomerQueue(result.items);
        setSelectedCustomerId((current) => result.items.some((item) => item.id === current) ? current : result.items[0]?.id ?? null);
      } else {
        const result = await listAgentHandoffs({
          agentId,
          installationId,
          status: viewStatuses[nextView],
          assignment: nextView === "mine" || nextView === "team" ? nextView : undefined,
          limit: 100,
          search: searchQuery.trim() || undefined,
          priority: priority || undefined,
          channelType: channelType || undefined,
          reason: reason || undefined,
          cursor: queueCursor,
        });
        setQueue(result);
        setSelectedId((current) => result.items.some((item) => item.handoff.id === current) ? current : result.items[0]?.handoff.id ?? null);
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load conversations");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [agentId, channelType, installationId, priority, queueCursor, reason, searchQuery, view]);

  useEffect(() => {
    void loadQueue(view);
  }, [loadQueue, view]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    const controller = new AbortController();
    let reconnectTimer: number | undefined;
    let stopped = false;
    const connect = async (): Promise<void> => {
      setFeedState("connecting");
      try {
        await streamAgentConversationFeed(() => {
          setFeedState("connected");
          void loadQueue(view, true);
          void loadSummary(true);
        }, controller.signal);
      } catch {
        if (stopped || controller.signal.aborted) return;
      }
      if (!stopped && !controller.signal.aborted) {
        setFeedState("reconnecting");
        reconnectTimer = window.setTimeout(() => void connect(), 1_000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      controller.abort();
    };
  }, [loadQueue, loadSummary, view]);

  const selected = useMemo(() => queue.items.find((item) => item.handoff.id === selectedId) ?? null, [queue.items, selectedId]);
  const selectedCustomer = useMemo(() => customerQueue.find((item) => item.id === selectedCustomerId) ?? null, [customerQueue, selectedCustomerId]);
  const selectedLive = useMemo(() => liveQueue.find((item) => item.conversation.id === selectedLiveId) ?? null, [liveQueue, selectedLiveId]);
  const activeConversationId = view === "live" ? selectedLive?.conversation.id : view === "all" ? selectedCustomer?.id : selected?.conversation.id;

  useEffect(() => {
    if (!activeConversationId) {
      setMessages([]);
      setActiveRuns([]);
      setHandoffHistory([]);
      setMessageErrors({});
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

  useEffect(() => {
    if (view === "live" || view === "all" || !selectedId) {
      setHandoffHistory([]);
      return;
    }
    let cancelled = false;
    void getAgentHandoff(selectedId)
      .then((result) => {
        if (!cancelled) setHandoffHistory(result.history ?? []);
      })
      .catch(() => {
        if (!cancelled) setHandoffHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, view]);

  useEffect(() => {
    if (!activeConversationId) return;
    const controller = new AbortController();
    const refreshConversation = () => {
      void getPlatformConversation(activeConversationId, { limit: 100 })
        .then((result) => {
          if (controller.signal.aborted) return;
          setMessages(result.messages ?? []);
          setActiveRuns((result.activeRuns ?? []).map((run) => ({ id: run.id, status: run.status })));
        })
        .catch(() => undefined);
      void loadQueue(view, true);
      void loadSummary(true);
    };
    void streamAgentConversation(activeConversationId, refreshConversation, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [activeConversationId, loadQueue, loadSummary, view]);

  function resetQueuePosition() {
    setQueueCursor(undefined);
  }

  function changeView(nextView: QueueView) {
    resetQueuePosition();
    setView(nextView);
  }

  async function mutate(id: string, action: "claim" | "continue" | "resolve" | "release") {
    setBusy(`${action}:${id}`);
    try {
      const result = action === "claim" ? await claimAgentHandoff(id) : action === "continue" ? await continueAgentHandoff(id, resolution.trim() || undefined) : action === "resolve" ? await resolveAgentHandoff(id, resolution.trim() || undefined) : await releaseAgentHandoff(id, resolution.trim() || undefined);
      setResolution("");
      const nextView = action === "claim" ? "mine" : action === "release" ? "inbox" : "all";
      if (nextView === "all") setSelectedCustomerId(result.conversation.id);
      setView(nextView);
      await Promise.all([loadQueue(nextView), loadSummary()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update handoff");
    } finally {
      setBusy(null);
    }
  }

  async function sendMessage(textOverride?: string, idempotencyKeyOverride?: string, optimisticIdOverride?: string) {
    if (!selected) return;
    const text = (textOverride ?? messageDraft).trim();
    if (!text) return;
    const idempotencyKey = idempotencyKeyOverride ?? crypto.randomUUID();
    const optimisticId = optimisticIdOverride ?? `optimistic:${idempotencyKey}`;
    const optimisticMessage: AgentMessage = {
      id: optimisticId,
      conversation_id: selected.conversation.id,
      direction: "outbound",
      message_type: "text",
      content: { text },
      sequence_number: `pending:${Date.now()}`,
      created_at: new Date().toISOString(),
      provider: "kasitek-human",
      provider_message_id: idempotencyKey,
      participant_type: "staff",
      participant_display_name: "You",
      source_channel: selected.conversation.channel_type,
      external_conversation_id: selected.conversation.external_conversation_id,
      delivery_status: "sending",
    };
    if (!optimisticIdOverride) {
      setMessages((current) => [...current, optimisticMessage]);
      setMessageDraft("");
    } else {
      setMessages((current) => current.map((message) => message.id === optimisticId ? { ...message, delivery_status: "sending" } : message));
    }
    setBusy(`message:${selected.handoff.id}`);
    try {
      const result = await sendAgentHumanMessage(selected.handoff.id, { text, idempotencyKey });
      const deliveryStatus = (result.delivery?.status ?? result.message.delivery_status ?? "local") as AgentMessage["delivery_status"];
      const savedMessage: AgentMessage = { ...result.message, delivery_status: deliveryStatus };
      setMessages((current) => current.map((message) => message.id === optimisticId ? savedMessage : message));
      if (deliveryStatus === "failed") setMessageErrors((current) => ({ ...current, [result.message.id]: result.delivery?.error?.message ?? "Message could not be delivered" }));
      else setMessageErrors((current) => { const next = { ...current }; delete next[optimisticId]; delete next[result.message.id]; return next; });
      const latest = await getPlatformConversation(selected.conversation.id, { limit: 100 });
      setMessages(latest.messages ?? []);
      setActiveRuns((latest.activeRuns ?? []).map((run) => ({ id: run.id, status: run.status })));
      await loadQueue(view, true);
      await loadSummary(true);
    } catch (cause) {
      setMessages((current) => current.map((message) => message.id === optimisticId ? { ...message, delivery_status: "failed" } : message));
      setMessageErrors((current) => ({ ...current, [optimisticId]: cause instanceof Error ? cause.message : "Message could not be delivered" }));
      setError(cause instanceof Error ? cause.message : "Unable to send message");
    } finally {
      setBusy(null);
    }
  }

  function retryMessage(message: AgentMessage) {
    const text = typeof message.content?.text === "string" ? message.content.text : "";
    const idempotencyKey = message.provider_message_id;
    if (!text || !idempotencyKey) return;
    setMessageErrors((current) => { const next = { ...current }; delete next[message.id]; return next; });
    void sendMessage(text, idempotencyKey, message.id);
  }

  async function stopAgentRun() {
    const runId = activeRuns[0]?.id;
    if (!runId || !activeConversationId) return;
    setBusy(`stop:${runId}`);
    try {
      await cancelAgentRun(runId, "Stopped by operator");
      const latest = await getPlatformConversation(activeConversationId, { limit: 100 });
      setMessages(latest.messages ?? []);
      setActiveRuns((latest.activeRuns ?? []).map((run) => ({ id: run.id, status: run.status })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to stop agent run");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1440px]">
        <PageHeader>
          <PageHeaderContent>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Customer</p>
            <PageHeaderTitle>Live Chat</PageHeaderTitle>
            <PageHeaderDescription>Customer conversations that need operator attention.</PageHeaderDescription>
          </PageHeaderContent>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
              <span className={`h-2 w-2 rounded-full ${feedState === "connected" ? "bg-status-success" : feedState === "reconnecting" ? "bg-status-attention" : "bg-muted-foreground animate-pulse"}`} />
              {feedState === "connected" ? "Live updates" : feedState === "reconnecting" ? "Reconnecting" : "Connecting"}
            </span>
            <Button type="button" variant="outline" onClick={() => { void loadQueue(view); void loadSummary(); }} disabled={refreshing}>
              {refreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
          </div>
        </PageHeader>

        {error ? <div className="mt-6 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"><CircleAlert className="h-4 w-4 shrink-0" />{error}</div> : null}

        <MotionReveal delay={0.14}>
          <section className="mt-6 rounded-xl border border-border bg-card/80 p-3 sm:p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-1 rounded-lg bg-secondary/70 p-1">
                {(["inbox", "mine", "team", "all"] as QueueView[]).map((key) => {
                  const label = key === "inbox" ? "Inbox" : key === "mine" ? "Mine" : key === "team" ? "Team" : "All";
                  const count = key === "inbox" ? summary.inbox : key === "mine" ? summary.mine : key === "team" ? summary.team : summary.all;
                  return <button key={key} type="button" onClick={() => changeView(key)} className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${view === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}><span>{label}</span><span className={`min-w-4 rounded-full px-1.5 text-center text-[10px] leading-4 ${view === key ? "bg-secondary text-foreground" : "bg-background/70 text-muted-foreground"}`}>{count}</span></button>;
                })}
              </div>
              <div className="flex w-full flex-wrap gap-2 sm:w-auto"><div className="relative min-w-0 flex-1 sm:w-56"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => { setSearch(event.target.value); resetQueuePosition(); }} placeholder="Search conversations" className="pl-9" /></div><select aria-label="Channel" value={channelType} onChange={(event) => { setChannelType(event.target.value); resetQueuePosition(); }} className="h-9 rounded-md border border-border bg-background px-2.5 text-xs text-foreground"><option value="">All channels</option><option value="platform">Platform</option><option value="whatsapp">WhatsApp</option><option value="telegram">Telegram</option><option value="messenger">Messenger</option><option value="instagram">Instagram</option></select>{view !== "all" ? <><select aria-label="Reason" value={reason} onChange={(event) => { setReason(event.target.value as AgentHandoffReason | ""); resetQueuePosition(); }} className="h-9 rounded-md border border-border bg-background px-2.5 text-xs text-foreground"><option value="">All reasons</option>{handoffReasons.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><select aria-label="Priority" value={priority} onChange={(event) => { setPriority(event.target.value as AgentHandoffPriority | ""); resetQueuePosition(); }} className="h-9 rounded-md border border-border bg-background px-2.5 text-xs text-foreground"><option value="">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option></select></> : null}</div>
            </div>
          </section>
        </MotionReveal>

        <MotionReveal delay={0.2}>
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
            <aside className="space-y-2" aria-label="Agent conversations">
              {view === "live" ? (liveQueue.length === 0 ? <EmptyQueue view="live" /> : liveQueue.map((item) => (
                <button key={item.conversation.id} type="button" onClick={() => setSelectedLiveId(item.conversation.id)} className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedLiveId === item.conversation.id ? "border-primary/60 bg-primary/5" : "border-border bg-card hover:border-primary/30"}`}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{item.conversation.participant_display_name || item.conversation.title || "Customer conversation"}</p><p className="mt-1 truncate text-xs text-muted-foreground">{channelLabel(item.conversation.channel_type)} · {timeLabel(item.conversation.last_message_at || item.conversation.updated_at)}</p></div><Badge className="shrink-0 border-status-info/30 bg-status-info-soft text-status-info">Live</Badge></div>
                  <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{item.conversation.last_message_preview || "No messages yet."}</p>
                </button>
              ))) : view === "all" ? (customerQueue.length === 0 ? <EmptyQueue view="all" /> : customerQueue.map((item) => (
                <button key={item.id} type="button" onClick={() => setSelectedCustomerId(item.id)} className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedCustomerId === item.id ? "border-primary/60 bg-primary/5" : "border-border bg-card hover:border-primary/30"}`}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{item.participant_display_name || item.title || "Customer conversation"}</p><p className="mt-1 truncate text-xs text-muted-foreground">{channelLabel(item.channel_type)} · {timeLabel(item.last_message_at || item.updated_at)}</p></div><Badge className="shrink-0 border-status-success/30 bg-status-success-soft text-status-success">Active</Badge></div>
                  <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{item.last_message_preview || "No messages yet."}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">{item.message_count ?? 0} messages{item.unread_count ? ` · ${item.unread_count} unread` : ""}</p>
                </button>
              ))) : (queue.items.length === 0 ? <EmptyQueue view={view} /> : queue.items.map((item) => (
                <button key={item.handoff.id} type="button" onClick={() => setSelectedId(item.handoff.id)} className={`w-full rounded-xl border p-4 text-left transition-colors ${selectedId === item.handoff.id ? "border-primary/60 bg-primary/5" : "border-border bg-card hover:border-primary/30"}`}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold text-foreground">{titleFor(item)}</p><p className="mt-1 truncate text-xs text-muted-foreground">{channelLabel(item.handoff.channel_type)} · {timeLabel(item.handoff.created_at)}</p></div><Badge className={`shrink-0 ${statusClass(item.handoff.status)}`}>{item.handoff.status}</Badge></div>
                  <p className={`mt-3 line-clamp-2 text-xs ${priorityClass(item.handoff.priority)}`}>{item.handoff.summary}</p>
                </button>
              )))}
            </aside>

            <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6" aria-live="polite">
              {view === "live" ? (!selectedLive ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">Select a live conversation</p></div> : (
                <CustomerConversationDetail conversation={selectedLive.conversation} messages={messages} activeRuns={activeRuns} transcriptLoading={transcriptLoading} busy={busy} onStop={() => void stopAgentRun()} badgeLabel="Live" />
              )) : view === "all" ? (!selectedCustomer ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">Select a customer conversation</p></div> : <CustomerConversationDetail conversation={selectedCustomer} messages={messages} activeRuns={activeRuns} transcriptLoading={transcriptLoading} busy={busy} onStop={() => void stopAgentRun()} />) : !selected ? <div className="flex min-h-64 flex-col items-center justify-center text-center"><MessageSquare className="h-7 w-7 text-muted-foreground" /><p className="mt-3 text-sm text-muted-foreground">Select a conversation</p></div> : (
                <div>
                  <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><UserRound className="h-5 w-5 text-primary" /><h2 className="truncate text-lg font-semibold text-foreground">{titleFor(selected)}</h2></div><p className="mt-1 text-sm text-muted-foreground">{channelLabel(selected.handoff.channel_type)} · {timeLabel(selected.handoff.created_at)}</p></div><Badge className={statusClass(selected.handoff.status)}>{selected.handoff.status}</Badge></div>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><div><p className="text-xs text-muted-foreground">Reason</p><p className="mt-1 text-sm font-medium capitalize text-foreground">{selected.handoff.reason.replaceAll("_", " ")}</p></div><div><p className="text-xs text-muted-foreground">Priority</p><p className={`mt-1 text-sm font-medium capitalize ${priorityClass(selected.handoff.priority)}`}>{selected.handoff.priority}</p></div><div><p className="text-xs text-muted-foreground">Source</p><p className="mt-1 text-sm font-medium text-foreground">{handoffSourceLabel(selected.handoff.request_source)}</p></div><div><p className="text-xs text-muted-foreground">Agent</p><p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground"><Bot className="h-4 w-4 text-muted-foreground" />{selected.conversation.installation_id.slice(0, 8)}</p></div></div>
                  {activeRuns.length ? <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-info/30 bg-status-info-soft px-3 py-2 text-sm text-status-info"><span className="flex items-center gap-2"><span className="h-2 w-2 animate-pulse rounded-full bg-current" />Agent run active · {activeRuns[0]?.status.replaceAll("_", " ")}</span><Button type="button" size="sm" variant="outline" className="h-7 border-status-info/30 bg-transparent text-status-info hover:bg-status-info/10" disabled={busy !== null} onClick={() => void stopAgentRun()}>{busy === `stop:${activeRuns[0]?.id}` ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1.5 h-3.5 w-3.5" />}Stop agent</Button></div> : null}
                  <div className="mt-6 space-y-4"><div className="rounded-lg border border-border bg-secondary/35 p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Handoff summary</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{selected.handoff.summary}</p></div>{selected.handoff.customer_message ? <div className="rounded-lg border border-border p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Customer message</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">{selected.handoff.customer_message}</p></div> : null}</div>
                  {handoffHistory.length ? <div className="mt-6 rounded-lg border border-border p-4"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Handoff history</p><ol className="mt-4 space-y-3">{handoffHistory.map((event) => <li key={event.id} className="flex items-start justify-between gap-3 text-sm"><div className="min-w-0"><p className="font-medium text-foreground">{handoffEventLabel(event)}</p><p className="text-xs text-muted-foreground">{event.actor_id || event.actor_type}</p></div><time className="shrink-0 text-xs text-muted-foreground">{timeLabel(event.created_at)}</time></li>)}</ol></div> : null}
                  <div className="mt-6 rounded-lg border border-border p-4"><div className="flex items-center justify-between gap-3"><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Transcript</p>{transcriptLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}</div>{messages.length ? <div className="mt-4 max-h-[32rem] space-y-3 overflow-y-auto pr-1">{messages.map((message) => <AgentTranscriptMessage key={message.id} message={message} onRetry={view === "mine" ? () => retryMessage(message) : undefined} retrying={busy === `message:${selected.handoff.id}`} deliveryError={messageErrors[message.id]} />)}</div> : <p className="mt-4 text-sm text-muted-foreground">{transcriptLoading ? "Loading transcript…" : "No messages recorded."}</p>}</div>
                  {selected.handoff.status === "claimed" && view === "mine" ? <div className="sticky bottom-4 z-10 mt-4 rounded-lg border border-border bg-card p-4 shadow-lg"><label htmlFor="human-message" className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Reply to customer</label><Textarea id="human-message" value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} placeholder="Write a reply" className="mt-3 min-h-20 resize-y bg-background" disabled={busy !== null} /><div className="mt-3 flex justify-end"><Button type="button" disabled={busy !== null || !messageDraft.trim()} onClick={() => void sendMessage()}>{busy === `message:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}{busy === `message:${selected.handoff.id}` ? "Sending…" : "Send reply"}</Button></div></div> : null}
                  {selected.handoff.status === "claimed" && view === "mine" ? <div className="mt-6 rounded-lg border border-border bg-secondary/20 p-4"><p className="text-sm font-medium text-foreground">Finish this conversation</p><p className="mt-1 text-xs text-muted-foreground">Choose what should happen after you are done.</p><label htmlFor="handoff-resolution" className="sr-only">Optional note</label><Textarea id="handoff-resolution" value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="Optional note" className="mt-3 min-h-20" /><div className="mt-3 flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={busy !== null} onClick={() => void mutate(selected.handoff.id, "release")}>{busy === `release:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}Return to queue</Button><Button type="button" variant="outline" disabled={busy !== null} onClick={() => void mutate(selected.handoff.id, "continue")}>{busy === `continue:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Clock3 className="mr-2 h-4 w-4" />}Resume agent</Button><Button type="button" disabled={busy !== null} onClick={() => void mutate(selected.handoff.id, "resolve")}>{busy === `resolve:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}Resolve conversation</Button></div></div> : null}
                  {selected.handoff.status === "claimed" && view === "team" ? <div className="mt-6 rounded-lg border border-status-info/30 bg-status-info-soft p-4 text-sm text-status-info">Assigned to another operator{selected.handoff.claimed_by ? ` · ${selected.handoff.claimed_by}` : ""}.</div> : null}
                  {selected.handoff.status === "pending" ? <div className="mt-6"><Button type="button" disabled={busy !== null} onClick={() => void mutate(selected.handoff.id, "claim")}>{busy === `claim:${selected.handoff.id}` ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UserRound className="mr-2 h-4 w-4" />}Take over</Button></div> : null}
                </div>
              )}
            </section>
          </div>
          {view !== "live" && queue.nextCursor ? <div className="mt-4 flex justify-end"><Button type="button" variant="outline" onClick={() => setQueueCursor(queue.nextCursor ?? undefined)} disabled={refreshing}>Next page</Button></div> : null}
        </MotionReveal>
      </div>
    </div>
  );
}
