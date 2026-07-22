"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Call, Device } from "@twilio/voice-sdk";
import {
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  MessageCircle,
  type LucideIcon,
  PhoneCall,
  PhoneMissed,
  Search,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/server-api";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";

export type CallRecord = {
  id: string;
  provider: string;
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

export type CallProviderStatus = {
  providers: Array<{
    provider: string;
    configured: boolean;
    browserConfigured?: boolean;
    requiredEnvironment: string[];
  }>;
};

export type VoiceConnection = {
  id: string;
  provider: string;
  displayName: string;
  externalAccountId: string | null;
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
  providers,
  voiceConnections,
}: {
  initialCalls: CallRecord[];
  summary: CallSummary | null;
  providers: CallProviderStatus | null;
  voiceConnections: VoiceConnection[];
}) {
  const [filter, setFilter] = useState<CallFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [showVoiceSetup, setShowVoiceSetup] = useState(false);
  const [voiceNumber, setVoiceNumber] = useState("");
  const [voiceLabel, setVoiceLabel] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupPending, setSetupPending] = useState(false);
  const [showCallOptions, setShowCallOptions] = useState(false);
  const [showDialer, setShowDialer] = useState(false);
  const [dialConnectionId, setDialConnectionId] = useState(voiceConnections[0]?.id || "");
  const [dialDestination, setDialDestination] = useState("");
  const [dialError, setDialError] = useState("");
  const [callState, setCallState] = useState<"idle" | "connecting" | "active">("idle");
  const deviceRef = useRef<Device | null>(null);
  const activeCallRef = useRef<Call | null>(null);
  const router = useRouter();

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
  const twilioConfigured = providers?.providers.some((provider) => provider.provider === "TWILIO" && provider.configured) ?? false;
  const browserCallingAvailable = twilioConfigured && voiceConnections.length > 0;

  useEffect(() => {
    return () => {
      activeCallRef.current?.disconnect();
      deviceRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    if (!showCallOptions) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && callState === "idle") {
        setShowCallOptions(false);
        setShowDialer(false);
        setShowVoiceSetup(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [callState, showCallOptions]);

  async function registerVoiceNumber() {
    setSetupError("");
    if (!voiceNumber.trim()) {
      setSetupError("Enter the Twilio number in international format, for example +27115550123.");
      return;
    }

    setSetupPending(true);
    try {
      const response = await fetch(apiUrl("/api/calls/providers/twilio/connections"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber: voiceNumber, displayName: voiceLabel || undefined }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not register the business number");
      setShowVoiceSetup(false);
      setVoiceNumber("");
      setVoiceLabel("");
      router.refresh();
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "Could not register the business number");
    } finally {
      setSetupPending(false);
    }
  }

  async function startBrowserCall() {
    setDialError("");
    if (!twilioConfigured) {
      setDialError("Browser calling is not configured for this workspace yet.");
      return;
    }
    if (!dialConnectionId) {
      setDialError("Select the business number to call from.");
      return;
    }
    if (!/^\+[1-9]\d{7,14}$/.test(dialDestination.trim())) {
      setDialError("Enter the destination in international format, for example +27115550123.");
      return;
    }

    setCallState("connecting");
    try {
      const tokenResponse = await fetch(apiUrl("/api/calls/twilio/browser-token"), {
        method: "POST",
        credentials: "include",
      });
      const tokenPayload = await tokenResponse.json();
      if (!tokenResponse.ok) throw new Error(tokenPayload.error || "Could not start browser calling");

      deviceRef.current?.destroy();
      const { Device: TwilioDevice } = await import("@twilio/voice-sdk");
      const device = new TwilioDevice(tokenPayload.token);
      deviceRef.current = device;
      device.on("error", (error) => {
        setDialError(error.message || "The browser call failed");
        setCallState("idle");
      });

      const call = await device.connect({
        params: { To: dialDestination.trim(), ConnectionId: dialConnectionId },
      });
      activeCallRef.current = call;
      call.on("accept", () => {
        setCallState("active");
        router.refresh();
      });
      call.on("disconnect", () => {
        activeCallRef.current = null;
        device.destroy();
        deviceRef.current = null;
        setCallState("idle");
        router.refresh();
      });
      call.on("cancel", () => {
        activeCallRef.current = null;
        device.destroy();
        deviceRef.current = null;
        setCallState("idle");
        router.refresh();
      });
    } catch (error) {
      setDialError(error instanceof Error ? error.message : "Could not start browser calling");
      setCallState("idle");
    }
  }

  function endBrowserCall() {
    activeCallRef.current?.disconnect();
  }

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
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Customer operations
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-foreground">Calls</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Review call activity and handle customer conversations across your connected channels.
            </p>
          </div>
          <Button
            onClick={() => {
              setShowCallOptions((visible) => !visible);
              setShowDialer(false);
              setShowVoiceSetup(false);
            }}
          >
            {showCallOptions ? "Close" : "New call"}
          </Button>
        </header>

        <section className="grid overflow-hidden rounded-xl border border-border bg-card sm:grid-cols-2">
          <CallSupport
            icon={MessageCircle}
            title="WhatsApp calls"
            detail="Receive and answer customer calls from Inbox."
            state="Available"
            stateClass="text-status-success"
          />
          <CallSupport
            icon={PhoneCall}
            title="Business phone"
            detail={browserCallingAvailable ? "Place browser calls from a registered business number." : "Connect a business number to place browser calls."}
            state={browserCallingAvailable ? "Available" : "Setup needed"}
            stateClass={browserCallingAvailable ? "text-status-success" : "text-muted-foreground"}
          />
        </section>

        {showCallOptions ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
            onMouseDown={() => {
              if (callState === "idle") {
                setShowCallOptions(false);
                setShowDialer(false);
                setShowVoiceSetup(false);
              }
            }}
          >
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-call-title"
              className="w-full max-w-2xl rounded-xl border border-border bg-card shadow-2xl"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header className="flex items-start justify-between border-b border-border px-5 py-4">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Calls</p>
                  <h2 id="new-call-title" className="mt-1 text-lg font-semibold text-foreground">
                    {showDialer ? "Business phone call" : showVoiceSetup ? "Connect business number" : "Start a call"}
                  </h2>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close new call dialog"
                  disabled={callState !== "idle"}
                  onClick={() => {
                    setShowCallOptions(false);
                    setShowDialer(false);
                    setShowVoiceSetup(false);
                  }}
                >
                  <XCircle className="h-4 w-4" />
                </Button>
              </header>

              <div className="p-5">
                {!showVoiceSetup && !showDialer ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted-foreground">Choose an available calling method for this workspace.</p>
                    <button
                      type="button"
                      disabled={!browserCallingAvailable}
                      onClick={() => setShowDialer(true)}
                      className="flex w-full items-center gap-4 rounded-lg border border-border p-4 text-left transition-colors hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <div className="flex h-10 w-10 items-center justify-center rounded-md bg-secondary text-foreground"><PhoneCall className="h-5 w-5" /></div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground">Business phone</p>
                        <p className="mt-1 text-sm text-muted-foreground">Place a browser call using a registered business number.</p>
                      </div>
                      <span className={cn("text-xs font-medium", browserCallingAvailable ? "text-status-success" : "text-muted-foreground")}>
                        {browserCallingAvailable ? "Available" : "Setup needed"}
                      </span>
                    </button>
                    {!browserCallingAvailable ? (
                      <Button variant="outline" className="w-full" onClick={() => setShowVoiceSetup(true)}>
                        Connect a business number
                      </Button>
                    ) : null}
                    <Button asChild variant="outline" className="w-full">
                      <Link href="/inbox">
                        <MessageCircle className="h-4 w-4" />
                        Open WhatsApp calls in Inbox
                      </Link>
                    </Button>
                    {!browserCallingAvailable && voiceConnections.length > 0 ? (
                      <p className="text-sm text-muted-foreground">
                        The business number is registered, but browser calling still needs provider configuration. <Link className="text-foreground underline underline-offset-4" href="/connections">Manage calling</Link>.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {showVoiceSetup ? (
                  <div className="space-y-4">
                    <p className="text-sm leading-6 text-muted-foreground">Register the Twilio number that belongs to this workspace. It can be activated after the provider configuration is complete.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Input value={voiceNumber} onChange={(event) => setVoiceNumber(event.target.value)} placeholder="+27115550123" />
                      <Input value={voiceLabel} onChange={(event) => setVoiceLabel(event.target.value)} placeholder="Support line (optional)" />
                    </div>
                    {setupError ? <p className="text-sm text-destructive">{setupError}</p> : null}
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setShowVoiceSetup(false)} disabled={setupPending}>Back</Button>
                      <Button onClick={registerVoiceNumber} disabled={setupPending}>{setupPending ? "Saving..." : "Register number"}</Button>
                    </div>
                  </div>
                ) : null}

                {showDialer ? (
                  <div className="space-y-4">
                    <p className="text-sm leading-6 text-muted-foreground">Your browser will ask for microphone access before it connects the selected business number to the customer.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <select
                        value={dialConnectionId}
                        onChange={(event) => setDialConnectionId(event.target.value)}
                        className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground"
                        disabled={callState !== "idle"}
                      >
                        {voiceConnections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.displayName}{connection.externalAccountId ? ` (${connection.externalAccountId})` : ""}
                          </option>
                        ))}
                      </select>
                      <Input value={dialDestination} onChange={(event) => setDialDestination(event.target.value)} placeholder="Customer number, e.g. +27115550123" disabled={callState !== "idle"} />
                    </div>
                    {dialError ? <p className="text-sm text-destructive">{dialError}</p> : null}
                    <div className="flex justify-end gap-2">
                      {callState === "idle" ? <Button variant="outline" onClick={() => setShowDialer(false)}>Back</Button> : null}
                      {callState === "idle" ? (
                        <Button onClick={startBrowserCall}>Call</Button>
                      ) : (
                        <Button variant="destructive" onClick={endBrowserCall}>{callState === "connecting" ? "Cancel call" : "End call"}</Button>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        ) : null}

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
                          {inbound ? "Inbound" : "Outbound"} {formatProvider(call.provider)} via {call.connectionLabel || "connected number"}
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

function CallSupport({
  icon: Icon,
  title,
  detail,
  state,
  stateClass,
}: {
  icon: LucideIcon;
  title: string;
  detail: string;
  state: string;
  stateClass: string;
}) {
  return (
    <div className="flex items-start gap-3 p-4 first:border-b first:border-border sm:first:border-b-0 sm:first:border-r">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <span className={cn("text-xs font-medium", stateClass)}>{state}</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      </div>
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
          {inbound ? "Inbound" : "Outbound"} {formatProvider(call.provider)} call
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

function formatProvider(provider: string) {
  if (provider === "WHATSAPP") return "WhatsApp";
  if (provider === "TWILIO") return "business phone";
  return provider.toLowerCase().replace(/_/g, " ");
}

function CallDetail({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-1 break-words text-sm", danger ? "text-destructive" : "text-foreground")}>{value}</dd>
    </div>
  );
}
