"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  MessageCircle,
  PhoneCall,
  PhoneMissed,
  Search,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type CallRecord = {
  id: string;
  connectionId: string;
  conversationId: string | null;
  direction: string;
  status: string;
  fromPhone: string;
  toPhone: string;
  agentLabel: string | null;
  connectionLabel: string | null;
  conversationCustomerName: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CallSummary = {
  days: number;
  summary: {
    totalCalls: number;
    inboundCalls: number;
    outboundCalls: number;
    ringingCalls: number;
    activeCalls: number;
    completedCalls: number;
    missedCalls: number;
    failedCalls: number;
    rejectedCalls: number;
    recentCalls: number;
  };
  trend: Array<{
    day: string;
    total: number;
    inbound: number;
    missed: number;
    completed: number;
  }>;
};

type CallFilter = "all" | "live" | "missed" | "completed";

function isLiveCall(call: CallRecord) {
  return ["RINGING", "CONNECTING", "ACTIVE"].includes(call.status);
}

function formatStatus(status: string) {
  return status.toLowerCase().replace(/_/g, " ");
}

function formatDuration(seconds: number | null) {
  if (!seconds || seconds <= 0) return "-";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatCallTime(value: string | null) {
  if (!value) return "Unknown time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric" });
}

function callContact(call: CallRecord) {
  return call.conversationCustomerName || (call.direction === "INBOUND" ? call.fromPhone : call.toPhone);
}

function statusClass(status: string) {
  if (status === "ACTIVE" || status === "COMPLETED") return "bg-status-success-soft text-status-success";
  if (status === "RINGING" || status === "CONNECTING") return "bg-status-attention-soft text-status-attention";
  if (["MISSED", "FAILED", "REJECTED"].includes(status)) return "bg-status-danger-soft text-destructive";
  return "bg-secondary text-muted-foreground";
}

export function CallsWorkspace({
  initialCalls,
  summary,
}: {
  initialCalls: CallRecord[];
  summary: CallSummary | null;
}) {
  const [filter, setFilter] = useState<CallFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);

  const filteredCalls = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return initialCalls.filter((call) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "live" && isLiveCall(call)) ||
        (filter === "missed" && call.status === "MISSED") ||
        (filter === "completed" && call.status === "COMPLETED");
      if (!matchesFilter) return false;
      if (!needle) return true;
      return [callContact(call), call.fromPhone, call.toPhone, call.connectionLabel || "", call.agentLabel || ""]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [filter, initialCalls, query]);

  const selectedCall = filteredCalls.find((call) => call.id === selectedCallId) ?? null;
  const activeCallCount = initialCalls.filter(isLiveCall).length;
  const missedCallCount = summary?.summary.missedCalls ?? initialCalls.filter((call) => call.status === "MISSED").length;

  const filters: Array<{ id: CallFilter; label: string; count: number }> = [
    { id: "all", label: "All calls", count: initialCalls.length },
    { id: "live", label: "Live", count: activeCallCount },
    { id: "missed", label: "Missed", count: missedCallCount },
    {
      id: "completed",
      label: "Completed",
      count: summary?.summary.completedCalls ?? initialCalls.filter((call) => call.status === "COMPLETED").length,
    },
  ];

  return (
    <div className="min-h-screen bg-background p-5 lg:p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Customer operations
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">Calls</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Review live, missed, and completed calls across connected providers. WhatsApp calls are available now.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <PhoneCall className="h-4 w-4 text-status-success" />
            <span>Provider-ready workspace</span>
          </div>
        </header>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <CallMetric label="All calls" value={summary?.summary.totalCalls ?? initialCalls.length} icon={PhoneCall} />
          <CallMetric label="Live now" value={activeCallCount} icon={Clock3} tone="attention" />
          <CallMetric label="Missed" value={missedCallCount} icon={PhoneMissed} tone="danger" />
          <CallMetric label="Completed" value={summary?.summary.completedCalls ?? 0} icon={CheckCircle2} tone="success" />
        </div>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-1 overflow-x-auto">
              {filters.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setFilter(item.id);
                    setSelectedCallId(null);
                  }}
                  className={cn(
                    "shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                    filter === item.id
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  {item.label} <span className="ml-1 text-xs tabular-nums text-muted-foreground">{item.count}</span>
                </button>
              ))}
            </div>
            <div className="relative w-full lg:max-w-xs">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search calls"
                className="bg-background pl-9"
              />
            </div>
          </div>

          <div className="grid min-h-[540px] lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0 divide-y divide-border">
              {filteredCalls.length === 0 ? (
                <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                    <PhoneCall className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">No calls found</p>
                  <p className="mt-1 text-sm text-muted-foreground">Try another filter or wait for a connected provider to receive a call.</p>
                </div>
              ) : (
                filteredCalls.map((call) => {
                  const inbound = call.direction === "INBOUND";
                  const DirectionIcon = inbound ? ArrowDownLeft : ArrowUpRight;
                  return (
                    <button
                      key={call.id}
                      type="button"
                      onClick={() => setSelectedCallId(call.id)}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-secondary/60",
                        selectedCallId === call.id && "bg-secondary",
                      )}
                    >
                      <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-full", inbound ? "bg-status-success-soft text-status-success" : "bg-secondary text-muted-foreground")}>
                        <DirectionIcon className="h-4 w-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-medium text-foreground">{callContact(call)}</p>
                          <Badge className={cn("border-0 px-1.5 py-0 text-[10px] capitalize", statusClass(call.status))}>
                            {formatStatus(call.status)}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {inbound ? "Inbound" : "Outbound"} via {call.connectionLabel || "connected number"}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-xs text-muted-foreground">{formatCallTime(call.startedAt || call.createdAt)}</p>
                        <p className="mt-1 text-xs tabular-nums text-muted-foreground">{formatDuration(call.durationSeconds)}</p>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <aside className="border-t border-border bg-secondary/20 p-5 lg:border-l lg:border-t-0">
              {selectedCall ? <CallDetails call={selectedCall} /> : <CallsUnopenedState />}
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}

function CallMetric({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number;
  icon: typeof PhoneCall;
  tone?: "default" | "success" | "attention" | "danger";
}) {
  const toneClass = {
    default: "bg-secondary text-muted-foreground",
    success: "bg-status-success-soft text-status-success",
    attention: "bg-status-attention-soft text-status-attention",
    danger: "bg-status-danger-soft text-destructive",
  }[tone];

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className={cn("flex h-8 w-8 items-center justify-center rounded-md", toneClass)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className="mt-4 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
    </div>
  );
}

function CallsUnopenedState() {
  return (
    <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card">
        <PhoneCall className="h-5 w-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium text-foreground">Select a call</p>
      <p className="mt-1 max-w-xs text-sm leading-6 text-muted-foreground">
        View call details and open its related conversation.
      </p>
    </div>
  );
}

function CallDetails({ call }: { call: CallRecord }) {
  const inbound = call.direction === "INBOUND";
  const DirectionIcon = inbound ? ArrowDownLeft : ArrowUpRight;

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-center gap-2">
          <div className={cn("flex h-9 w-9 items-center justify-center rounded-full", inbound ? "bg-status-success-soft text-status-success" : "bg-card text-muted-foreground")}>
            <DirectionIcon className="h-4 w-4" />
          </div>
          <Badge className={cn("border-0 capitalize", statusClass(call.status))}>{formatStatus(call.status)}</Badge>
        </div>
        <h2 className="mt-4 text-lg font-semibold text-foreground">{callContact(call)}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {inbound ? "Inbound" : "Outbound"} WhatsApp call
        </p>
      </div>

      <dl className="space-y-3 text-sm">
        <CallDetail label="Connected number" value={call.connectionLabel || "Unknown number"} />
        <CallDetail label="Started" value={formatCallTime(call.startedAt || call.createdAt)} />
        <CallDetail label="Duration" value={formatDuration(call.durationSeconds)} />
        <CallDetail label="Handled by" value={call.agentLabel || "Unassigned"} />
        {call.errorMessage ? <CallDetail label="Issue" value={call.errorMessage} danger /> : null}
      </dl>

      {call.conversationId ? (
        <Link
          href={`/inbox?conversation=${encodeURIComponent(call.conversationId)}`}
          className="flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <MessageCircle className="h-4 w-4" />
          Open conversation
          <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      ) : (
        <div className="rounded-md border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground">
          This call is not linked to a conversation yet.
        </div>
      )}
    </div>
  );
}

function CallDetail({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 break-words text-sm", danger ? "text-destructive" : "text-foreground")}>{value}</dd>
    </div>
  );
}
