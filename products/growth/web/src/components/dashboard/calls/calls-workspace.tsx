import { Link, useBlocker, useRevalidator } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  PhoneCall,
  Phone,
  Search,
  Plus,
  ArrowUpRight,
  X,
  MessageCircle,
} from "@/components/ui/interface-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { apiUrl } from "@/lib/server-api";
import { getPlatformBrandIcon } from "@/lib/platform-icons";
import { cn } from "@/lib/utils";
import { useBrowserCall } from "./use-browser-call";

const WhatsAppIcon = getPlatformBrandIcon("WHATSAPP") ?? MessageCircle;
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
type LoadErrors = Partial<
  Record<"calls" | "summary" | "providers" | "connections", string>
>;
const live = (call: CallRecord) =>
  ["RINGING", "CONNECTING", "ACTIVE"].includes(call.status);
const contact = (call: CallRecord) =>
  call.conversationCustomerName ||
  (call.direction === "INBOUND" ? call.fromPhone : call.toPhone);
const label = (value: string) => value.toLowerCase().replace(/_/g, " ");
const providerLabel = (value: string) =>
  value === "TWILIO"
    ? "Business phone"
    : value === "WHATSAPP"
      ? "WhatsApp"
      : label(value);
const duration = (seconds: number | null) =>
  seconds === null ? "—" : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
function time(value: string | null, full = false) {
  if (!value || Number.isNaN(Date.parse(value))) return "—";
  return new Date(value).toLocaleString(
    "en-ZA",
    full
      ? {
          day: "numeric",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        }
      : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
  );
}
function Status({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded px-1.5 py-0.5 text-[11px] capitalize",
        status === "COMPLETED" || status === "ACTIVE"
          ? "bg-status-success-soft text-status-success"
          : ["FAILED", "MISSED", "REJECTED"].includes(status)
            ? "bg-status-danger-soft text-destructive"
            : "bg-secondary text-muted-foreground",
      )}
    >
      {label(status)}
    </span>
  );
}

export function CallsWorkspace({
  initialCalls: loadedCalls,
  summary,
  providers,
  voiceConnections,
  errors = {},
}: {
  initialCalls: CallRecord[];
  summary: CallSummary | null;
  providers: CallProviderStatus | null;
  voiceConnections: VoiceConnection[];
  errors?: LoadErrors;
}) {
  const [previousCalls, setPreviousCalls] = useState(loadedCalls);
  useEffect(() => {
    if (!errors.calls) setPreviousCalls(loadedCalls);
  }, [loadedCalls, errors.calls]);
  const initialCalls = errors.calls ? previousCalls : loadedCalls;
  const revalidator = useRevalidator();
  const browserCall = useBrowserCall(() => {
    void revalidator.revalidate();
  });
  const blocker = useBlocker(browserCall.busy);
  const [filter, setFilter] = useState<CallFilter>("all");
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("all");
  const [number, setNumber] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [smallScreen, setSmallScreen] = useState(false);
  const [dialog, setDialog] = useState<"options" | "register" | "dial" | null>(
    null,
  );
  const [voiceNumber, setVoiceNumber] = useState("");
  const [voiceLabel, setVoiceLabel] = useState("");
  const [setupPending, setSetupPending] = useState(false);
  const [setupError, setSetupError] = useState("");
  const [dialConnection, setDialConnection] = useState(
    voiceConnections[0]?.id || "",
  );
  const [destination, setDestination] = useState("");
  const [dialError, setDialError] = useState("");
  const [localConnection, setLocalConnection] =
    useState<VoiceConnection | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const rowOpener = useRef<HTMLElement | null>(null);
  const pendingRegistration = useRef(false);
  const connections = useMemo(
    () =>
      localConnection &&
      !voiceConnections.some((item) => item.id === localConnection.id)
        ? [...voiceConnections, localConnection]
        : voiceConnections,
    [voiceConnections, localConnection],
  );
  const twilio = providers?.providers.find(
    (item) => item.provider === "TWILIO",
  );
  const ready = Boolean(
    twilio?.browserConfigured &&
    connections.length &&
    !errors.connections &&
    !errors.providers,
  );
  const readiness =
    errors.providers || errors.connections
      ? "Status unavailable"
      : ready
        ? "Connected"
        : connections.length
          ? "Browser setup needed"
          : "Not connected";
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1279px)");
    const update = () => setSmallScreen(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!connections.some((item) => item.id === dialConnection))
      setDialConnection(connections[0]?.id || "");
  }, [connections, dialConnection]);
  useEffect(() => {
    if (selectedId && !initialCalls.some((item) => item.id === selectedId))
      setSelectedId(null);
  }, [initialCalls, selectedId]);
  const scope = useMemo(
    () =>
      initialCalls.filter(
        (item) =>
          (direction === "all" || item.direction === direction) &&
          (number === "all" || item.connectionId === number) &&
          [
            contact(item),
            item.fromPhone,
            item.toPhone,
            item.connectionLabel,
            item.agentLabel,
            item.provider,
          ]
            .join(" ")
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
      ),
    [initialCalls, direction, number, query],
  );
  const tabs: { id: CallFilter; title: string; count: number }[] = [
    { id: "all", title: "All calls", count: scope.length },
    { id: "live", title: "Live", count: scope.filter(live).length },
    {
      id: "missed",
      title: "Missed",
      count: scope.filter((item) => item.status === "MISSED").length,
    },
    {
      id: "completed",
      title: "Completed",
      count: scope.filter((item) => item.status === "COMPLETED").length,
    },
  ];
  const calls = scope.filter(
    (item) =>
      filter === "all" ||
      (filter === "live" && live(item)) ||
      item.status === filter.toUpperCase(),
  );
  const selected = initialCalls.find((item) => item.id === selectedId);
  const numbers = Array.from(
    new Map(
      initialCalls.map((item) => [
        item.connectionId,
        item.connectionLabel || item.connectionId,
      ]),
    ).entries(),
  );
  function open(value: "options" | "register" | "dial", element?: HTMLElement) {
    if (element) opener.current = element;
    setDialog(value);
  }
  async function register() {
    if (pendingRegistration.current) return;
    setSetupError("");
    if (!/^\+[1-9]\d{7,14}$/.test(voiceNumber.trim())) {
      setSetupError("Enter an international number, for example +27115550123.");
      return;
    }
    pendingRegistration.current = true;
    setSetupPending(true);
    try {
      const response = await fetch(
        apiUrl("/api/calls/providers/twilio/connections"),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phoneNumber: voiceNumber.trim(),
            displayName: voiceLabel.trim() || undefined,
          }),
        },
      );
      const payload = await response.json();
      if (!response.ok)
        throw new Error(payload.error || "Could not register number");
      const connection = payload.connection ?? payload;
      if (connection.id) {
        setLocalConnection({
          id: connection.id,
          provider: "TWILIO",
          displayName: connection.displayName || voiceLabel || voiceNumber,
          externalAccountId: connection.phoneNumber || voiceNumber,
        });
        setDialConnection(connection.id);
      }
      toast.success("Number registered");
      setVoiceNumber("");
      setVoiceLabel("");
      setDialog("options");
      void revalidator.revalidate();
    } catch (error) {
      setSetupError(
        error instanceof Error ? error.message : "Could not register number",
      );
    } finally {
      pendingRegistration.current = false;
      setSetupPending(false);
    }
  }
  function start() {
    setDialError("");
    if (!ready) {
      setDialError("Browser calling is unavailable.");
      return;
    }
    if (!dialConnection) {
      setDialError("Select a business number.");
      return;
    }
    if (!/^\+[1-9]\d{7,14}$/.test(destination.trim())) {
      setDialError("Enter an international number, for example +27115550123.");
      return;
    }
    void browserCall.start(dialConnection, destination.trim());
  }
  const callStateLabel = {
    idle: "Ready",
    microphone: "Requesting microphone",
    connecting: "Connecting",
    active: "Active call",
    ended: "Call ended",
    failed: "Call failed",
  }[browserCall.state];
  const retry = (
    <Button
      size="sm"
      variant="outline"
      disabled={revalidator.state !== "idle"}
      onClick={() => {
        void revalidator.revalidate();
      }}
    >
      {revalidator.state !== "idle" ? "Retrying…" : "Retry"}
    </Button>
  );
  return (
    <div className="min-h-full bg-background">
      <div
        className={cn(
          "grid min-h-[calc(100dvh-56px)]",
          selected && "xl:grid-cols-[minmax(0,1fr)_320px]",
        )}
      >
        <main className="min-w-0 px-4 py-5 md:px-6">
          <header className="flex items-center justify-between gap-3">
            <h1 className="text-[26px] font-semibold tracking-tight">Calls</h1>
            <Button
              onClick={(event) =>
                open(browserCall.busy ? "dial" : "options", event.currentTarget)
              }
            >
              <Plus className="size-4" />
              New call
            </Button>
          </header>
          <div className="my-5 flex flex-wrap items-center gap-x-6 gap-y-3 text-xs text-muted-foreground">
            <Link
              to="/inbox"
              className="flex min-h-8 items-center gap-2 hover:text-foreground"
            >
              <WhatsAppIcon className="size-4 text-emerald-600" />
              WhatsApp · Inbox calling
            </Link>
            <button
              className="flex min-h-8 items-center gap-2 hover:text-foreground"
              onClick={(event) => open("options", event.currentTarget)}
            >
              <Phone className="size-4 text-primary" />
              Business phone · {readiness}
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  ready ? "bg-status-success" : "bg-muted-foreground",
                )}
              />
            </button>
          </div>
          {browserCall.busy && (
            <div
              className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/50 p-3"
              role="status"
            >
              <span className="flex items-center gap-2 text-sm">
                <PhoneCall className="size-4 text-primary" />
                {callStateLabel} · {destination}
                {browserCall.state === "active" && (
                  <span className="tabular-nums">
                    {duration(browserCall.seconds)}
                  </span>
                )}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog("dial")}
                >
                  Show call
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    browserCall.state === "active"
                      ? setConfirmEnd(true)
                      : browserCall.end()
                  }
                >
                  {browserCall.state === "active" ? "End call" : "Cancel call"}
                </Button>
              </div>
            </div>
          )}
          {Object.entries(errors)
            .filter(([, value]) => value)
            .map(([key, value]) => (
              <div
                key={key}
                role="alert"
                className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
              >
                <span>
                  {key === "calls"
                    ? "Call history"
                    : key === "summary"
                      ? "Call summary"
                      : key === "providers"
                        ? "Calling status"
                        : "Business numbers"}
                  : {value}
                </span>
                {retry}
              </div>
            ))}
          <div
            className="flex gap-5 overflow-x-auto border-b border-border"
            aria-label="Call status"
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                aria-pressed={filter === tab.id}
                onClick={() => setFilter(tab.id)}
                className={cn(
                  "min-h-11 shrink-0 border-b-2 px-0.5 text-sm",
                  filter === tab.id
                    ? "border-primary font-medium text-primary"
                    : "border-transparent text-muted-foreground",
                )}
              >
                {tab.title}
                <span className="ml-2 rounded bg-secondary px-1.5 text-[11px] tabular-nums text-muted-foreground">
                  {tab.count}
                </span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2 py-3">
            <div className="relative min-w-0 basis-full sm:basis-auto sm:w-56">
              <Search className="absolute left-2.5 top-3 size-4 text-muted-foreground" />
              <Input
                aria-label="Search calls"
                placeholder="Search calls…"
                className="pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Select value={direction} onValueChange={setDirection}>
              <SelectTrigger
                aria-label="Call direction"
                className="min-w-0 flex-1 sm:w-40 sm:flex-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All directions</SelectItem>
                <SelectItem value="INBOUND">Inbound</SelectItem>
                <SelectItem value="OUTBOUND">Outbound</SelectItem>
              </SelectContent>
            </Select>
            <Select value={number} onValueChange={setNumber}>
              <SelectTrigger
                aria-label="Connected number"
                className="min-w-0 flex-1 sm:w-44 sm:flex-none"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All numbers</SelectItem>
                {numbers.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {calls.length ? (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[680px] text-left text-xs">
                <thead className="h-9 bg-secondary/50 text-muted-foreground">
                  <tr>
                    {[
                      "Contact",
                      "Direction",
                      "Number",
                      "Status",
                      "Duration",
                      "Started",
                      "Handled by",
                    ].map((name) => (
                      <th key={name} className="px-3 font-medium">
                        {name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {calls.map((item) => (
                    <tr
                      key={item.id}
                      className={cn(
                        "h-14 border-t border-border hover:bg-secondary/40",
                        selectedId === item.id && "bg-primary/8",
                      )}
                    >
                      <td className="max-w-48 px-3">
                        <button
                          onClick={(event) => {
                            rowOpener.current = event.currentTarget;
                            setSelectedId(item.id);
                          }}
                          className="min-h-11 max-w-full truncate text-left font-medium hover:text-primary"
                        >
                          {contact(item)}
                        </button>
                      </td>
                      <td className="px-3">
                        <span className="flex items-center gap-1.5 capitalize">
                          <ArrowUpRight
                            className={cn(
                              "size-3.5",
                              item.direction === "INBOUND" &&
                                "rotate-180 text-primary",
                            )}
                          />
                          {label(item.direction)}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3">
                        <span className="flex items-center gap-1.5">
                          {item.provider === "WHATSAPP" ? (
                            <WhatsAppIcon className="size-3.5 text-emerald-600" />
                          ) : (
                            <Phone className="size-3.5 text-primary" />
                          )}
                          {item.direction === "INBOUND"
                            ? item.fromPhone
                            : item.toPhone}
                        </span>
                      </td>
                      <td className="px-3">
                        <Status status={item.status} />
                      </td>
                      <td className="whitespace-nowrap px-3 tabular-nums">
                        {duration(item.durationSeconds)}
                      </td>
                      <td className="whitespace-nowrap px-3 text-muted-foreground">
                        {time(item.startedAt || item.createdAt)}
                      </td>
                      <td className="max-w-32 truncate px-3 text-muted-foreground">
                        {item.agentLabel || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !errors.calls && (
              <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-sm">
                <PhoneCall className="size-6 text-muted-foreground" />
                <p>
                  {initialCalls.length ? "No matching calls" : "No calls yet"}
                </p>
                {initialCalls.length ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setFilter("all");
                      setQuery("");
                      setDirection("all");
                      setNumber("all");
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={(event) => open("options", event.currentTarget)}
                  >
                    New call
                  </Button>
                )}
              </div>
            )
          )}
          {summary && (
            <p className="mt-3 text-xs text-muted-foreground">
              {summary.summary.totalCalls} calls in the last {summary.days} days
              · History shown: {initialCalls.length}
            </p>
          )}
        </main>
        {selected && !smallScreen && (
          <aside className="border-l border-border p-5">
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-sm font-semibold">Call details</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close call details"
                onClick={() => {
                  setSelectedId(null);
                  rowOpener.current?.focus();
                }}
              >
                <X className="size-4" />
              </Button>
            </div>
            <CallDetails call={selected} />
          </aside>
        )}
      </div>
      <Sheet
        open={Boolean(selected && smallScreen)}
        onOpenChange={(value) => {
          if (!value) setSelectedId(null);
        }}
      >
        <SheetContent
          className="w-full max-w-[360px] p-5"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            rowOpener.current?.focus();
          }}
        >
          <SheetTitle>Call details</SheetTitle>
          {selected && <CallDetails call={selected} />}
        </SheetContent>
      </Sheet>
      <Dialog
        open={dialog !== null}
        onOpenChange={(value) => {
          if (!value && !setupPending) setDialog(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          <DialogTitle>
            {dialog === "register"
              ? "Connect business number"
              : dialog === "dial"
                ? "Business phone call"
                : "New call"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Choose a calling method or register a business number.
          </DialogDescription>
          {dialog === "options" && (
            <div className="space-y-3">
              <button
                className="flex w-full items-center gap-3 rounded-md border border-border p-3 text-left"
                disabled={!ready}
                onClick={() => setDialog("dial")}
              >
                <Phone className="size-5 text-primary" />
                <span className="flex-1 text-sm font-medium">
                  Business phone
                </span>
                <span className="text-xs text-muted-foreground">
                  {readiness}
                </span>
              </button>
              <Button variant="outline" className="w-full" asChild>
                <Link to="/inbox">
                  <WhatsAppIcon className="size-4 text-emerald-600" />
                  WhatsApp calls in Inbox
                </Link>
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => setDialog("register")}
              >
                Connect business number
              </Button>
              {!ready && (
                <p className="text-xs text-muted-foreground">
                  {connections.length
                    ? "The number is registered. Browser calling needs provider configuration."
                    : "Register a Twilio number to use business calling."}{" "}
                  <Link className="underline" to="/connections">
                    Manage connections
                  </Link>
                </p>
              )}
            </div>
          )}
          {dialog === "register" && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void register();
              }}
            >
              <label className="block space-y-2 text-sm">
                <span>Business number</span>
                <Input
                  value={voiceNumber}
                  onChange={(event) => setVoiceNumber(event.target.value)}
                  placeholder="+27115550123"
                  type="tel"
                  autoComplete="tel"
                  disabled={setupPending}
                  aria-invalid={Boolean(setupError)}
                />
              </label>
              <label className="block space-y-2 text-sm">
                <span>Label (optional)</span>
                <Input
                  value={voiceLabel}
                  onChange={(event) => setVoiceLabel(event.target.value)}
                  disabled={setupPending}
                />
              </label>
              {setupError && (
                <p role="alert" className="text-sm text-destructive">
                  {setupError}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={setupPending}
                  onClick={() => setDialog("options")}
                >
                  Back
                </Button>
                <Button disabled={setupPending}>
                  {setupPending ? "Registering…" : "Register number"}
                </Button>
              </div>
            </form>
          )}
          {dialog === "dial" && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                start();
              }}
            >
              <div className="space-y-2">
                <label htmlFor="call-account" className="text-sm">
                  Business number
                </label>
                <Select
                  value={dialConnection}
                  onValueChange={setDialConnection}
                  disabled={browserCall.busy}
                >
                  <SelectTrigger id="call-account" className="w-full">
                    <SelectValue placeholder="Select number" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.displayName}
                        {item.externalAccountId
                          ? ` (${item.externalAccountId})`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <label className="block space-y-2 text-sm">
                <span>Phone number</span>
                <Input
                  type="tel"
                  autoComplete="tel"
                  placeholder="+27115550123"
                  value={destination}
                  onChange={(event) => setDestination(event.target.value)}
                  disabled={browserCall.busy}
                />
              </label>
              <p role="status" className="text-sm text-muted-foreground">
                {callStateLabel}
                {browserCall.state === "active"
                  ? ` · ${duration(browserCall.seconds)}`
                  : ""}
              </p>
              {(dialError || browserCall.error) && (
                <p role="alert" className="text-sm text-destructive">
                  {dialError || browserCall.error}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialog(null)}
                >
                  {browserCall.busy ? "Minimize" : "Cancel"}
                </Button>
                {browserCall.busy ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() =>
                      browserCall.state === "active"
                        ? setConfirmEnd(true)
                        : browserCall.end()
                    }
                  >
                    {browserCall.state === "active"
                      ? "End call"
                      : "Cancel call"}
                  </Button>
                ) : (
                  <Button disabled={!ready}>
                    <Phone className="size-4" />
                    Call
                  </Button>
                )}
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmEnd || blocker.state === "blocked"}
        onOpenChange={(value) => {
          if (!value) {
            setConfirmEnd(false);
            if (blocker.state === "blocked") blocker.reset();
          }
        }}
      >
        <DialogContent>
          <DialogTitle>
            {blocker.state === "blocked" ? "Leave this call?" : "End call?"}
          </DialogTitle>
          <DialogDescription>
            The current call will be disconnected.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setConfirmEnd(false);
                if (blocker.state === "blocked") blocker.reset();
              }}
            >
              Keep call
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                browserCall.end();
                setConfirmEnd(false);
                if (blocker.state === "blocked") blocker.proceed();
              }}
            >
              End call
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function CallDetails({ call }: { call: CallRecord }) {
  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-5">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 break-words text-sm font-semibold">
            {contact(call)}
          </h3>
          <Status status={call.status} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {call.direction === "INBOUND" ? call.fromPhone : call.toPhone}
        </p>
      </div>
      <dl className="space-y-4 text-xs">
        {[
          ["Direction", label(call.direction)],
          ["Provider", providerLabel(call.provider)],
          ["Connected number", call.connectionLabel || "—"],
          ["From", call.fromPhone],
          ["To", call.toPhone],
          ["Started", time(call.startedAt || call.createdAt, true)],
          ["Answered", time(call.answeredAt, true)],
          ["Ended", time(call.endedAt, true)],
          ["Duration", duration(call.durationSeconds)],
          ["Handled by", call.agentLabel || "Unassigned"],
        ].map(([title, value]) => (
          <div
            className="grid grid-cols-[110px_minmax(0,1fr)] gap-3"
            key={title}
          >
            <dt className="text-muted-foreground">{title}</dt>
            <dd className="break-words capitalize">{value}</dd>
          </div>
        ))}
      </dl>
      {(call.errorCode || call.errorMessage) && (
        <p className="break-words rounded-md bg-status-danger-soft p-3 text-xs text-destructive">
          {[call.errorCode, call.errorMessage].filter(Boolean).join(" · ")}
        </p>
      )}
      {call.conversationId && (
        <Button asChild variant="outline" className="w-full">
          <Link
            to={`/inbox?conversation=${encodeURIComponent(call.conversationId)}`}
          >
            <MessageCircle className="size-4" />
            Open conversation
          </Link>
        </Button>
      )}
    </div>
  );
}
