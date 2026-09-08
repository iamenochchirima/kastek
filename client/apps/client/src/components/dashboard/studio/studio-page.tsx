"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Activity,
  Bot,
  Check,
  CircleDot,
  Gauge,
  FlaskConical,
  LoaderCircle,
  MessageCircle,
  Plus,
  Rocket,
  Save,
  Send,
  Settings2,
  SlidersHorizontal,
  ShieldCheck,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  createAgentVersion,
  cancelAgentRun,
  createNewPlatformConversation,
  deployAgentInstallation,
  ensureKasiAiPlayground,
  getPlatformConversation,
  getAgentRun,
  getAgentRunTimeline,
  listAgentVersions,
  publishAgentVersion,
  resolvePlatformConversation,
  sendPlatformMessage,
  streamAgentRun,
  type AgentMessage,
  type AgentDefinition,
  type AgentJournalEvent,
  type AgentRuntimeTelemetry,
  type AgentSpecInput,
  type AgentStreamEvent,
  type AgentVersion,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";

type StudioPageProps = {
  initialAgents: AgentDefinition[];
  initialAgentId?: string;
  agentsUnavailable?: boolean;
  surface?: "studio" | "playground";
};

type TraceStatus = "pending" | "running" | "complete" | "error";

type TraceNode = {
  id: string;
  eventId?: string;
  journalSequence?: number;
  snapshotRevision?: number;
  event: string;
  label: string;
  detail: string;
  status: TraceStatus;
  sequence: number;
  data: Record<string, unknown>;
};

type ChatMessage = {
  id: string;
  text: string;
  direction: "user" | "agent" | "system";
  createdAt?: string;
  pending?: boolean;
};

function chatMessageFromAgent(message: AgentMessage): ChatMessage {
  const text = typeof message.content?.text === "string"
    ? message.content.text
    : message.message_type === "text"
      ? JSON.stringify(message.content)
      : message.message_type;
  const direction = message.direction === "outbound"
    ? "agent"
    : message.direction === "system"
      ? "system"
      : "user";
  return { id: message.id, text, direction, createdAt: message.created_at };
}

const terminalStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

function eventLabel(event: string, data: Record<string, unknown>) {
  const name = typeof data.name === "string" ? data.name : "";
  if (event === "run.received") return "Input";
  if (event.includes("context")) return "Context";
  if (event.includes("model")) return "Model";
  if (event.includes("tool")) return name ? `Tool: ${name}` : "Tool";
  if (event.includes("approval")) return "Approval";
  if (event.includes("human") || event.includes("handoff")) return "Handoff";
  if (event.includes("completed")) return "Completed";
  if (event.includes("cancelled")) return "Cancelled";
  if (event.includes("expired")) return "Expired";
  if (event.includes("failed")) return "Failed";
  return event.replace(/^run\./, "").replace(/^agent\./, "").replaceAll("_", " ");
}

function eventDetail(event: string, data: Record<string, unknown>) {
  const name = typeof data.name === "string" ? data.name : "";
  if (event.includes("tool") && name) return name;
  if (event.includes("approval")) return "Waiting for a decision";
  if (event.includes("context")) return "State and workspace context";
  if (event.includes("model")) return "Model turn";
  return event;
}

function eventStatus(event: string): TraceStatus {
  if (event.includes("failed") || event.includes("error")) return "error";
  if (event.includes("completed") || event.includes("cancelled") || event.includes("expired")) return "complete";
  return "running";
}

function nodeFromEvent(event: AgentStreamEvent): TraceNode {
  const sequence = Number(event.data.sequence_number);
  const safeSequence = Number.isSafeInteger(sequence) ? sequence : Date.now();
  return {
    id: `${event.event}-${safeSequence}`,
    event: event.event,
    label: eventLabel(event.event, event.data),
    detail: eventDetail(event.event, event.data),
    status: eventStatus(event.event),
    sequence: safeSequence,
    data: event.data,
  };
}

function nodesFromJournalEvents(events: AgentJournalEvent[], snapshotRevision?: number) {
  return events
    .filter((event) => event.event?.kind === "harness.turn" && typeof event.event.data?.type === "string")
    .map((event) => {
      const payload = event.event?.data?.payload ?? {};
      const node = nodeFromEvent({ event: event.event?.data?.type ?? "event", data: { ...payload, sequence_number: event.sequence } });
      return {
        ...node,
        id: event.id,
        eventId: event.id,
        journalSequence: event.sequence,
        snapshotRevision,
        data: {
          ...node.data,
          event_id: event.id,
          journal_sequence: event.sequence,
          snapshot_revision: snapshotRevision,
          occurred_at: event.occurredAt,
        },
      };
    })
    .sort((left, right) => left.sequence - right.sequence);
}

function nodesFromRunEvents(events: Array<{ event_type?: string; payload?: Record<string, unknown>; sequence_number?: number | string }>) {
  return events
    .map((event) => nodeFromEvent({
      event: event.event_type ?? "event",
      data: { ...(event.payload ?? {}), sequence_number: event.sequence_number },
    }))
    .sort((left, right) => left.sequence - right.sequence);
}

function statusLabel(status: string) {
  if (status === "active") return "Active";
  if (status === "paused") return "Paused";
  if (status === "disabled") return "Disabled";
  if (status === "archived") return "Archived";
  return "Draft";
}

function statusClass(status: string) {
  if (status === "active") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "paused") return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "bg-muted text-muted-foreground";
}

function SectionEyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{children}</p>;
}

function displayNumber(value: number | undefined, suffix = "") {
  return value === undefined || !Number.isFinite(value) ? "—" : `${Math.round(value).toLocaleString()}${suffix}`;
}

function displayDuration(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s`;
}

function displayTimestamp(value: string | undefined) {
  if (!value) return "—";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "—" : timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function RuntimeStatusRow({ telemetry, detailsOpen, onToggleDetails }: { telemetry: AgentRuntimeTelemetry | null; detailsOpen: boolean; onToggleDetails: () => void }) {
  if (!telemetry) return null;
  const contextValue = `${telemetry.context.tokens === undefined ? "—" : telemetry.context.tokens.toLocaleString()} / ${telemetry.context.contextWindowTokens === undefined ? "—" : telemetry.context.contextWindowTokens.toLocaleString()}`;
  const latency = telemetry.modelAttempt?.latencyMs ?? telemetry.rolling.latencyMs;
  return (
    <div className="border-b border-border bg-background/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><Activity className="size-3.5 text-primary" />Runtime</span>
        <span className="text-muted-foreground">Context <strong className="font-medium text-foreground">{contextValue}</strong></span>
        <span className="text-muted-foreground">Use <strong className="font-medium text-foreground">{displayNumber(telemetry.context.utilizationPercent, "%")}</strong></span>
        <span className="text-muted-foreground">Latency <strong className="font-medium text-foreground">{displayDuration(latency)}</strong></span>
        <span className="text-muted-foreground">Turn <strong className="font-medium text-foreground">{displayDuration(telemetry.turn.elapsedMs)}</strong></span>
        <button type="button" className="ml-auto inline-flex items-center gap-1 text-primary hover:text-primary/80" aria-expanded={detailsOpen} onClick={onToggleDetails}>{detailsOpen ? "Hide" : "Details"}<span aria-hidden="true">{detailsOpen ? "−" : "+"}</span></button>
      </div>
      {detailsOpen ? <RuntimeTelemetryDetail telemetry={telemetry} /> : null}
    </div>
  );
}

function RuntimeTelemetryDetail({ telemetry }: { telemetry: AgentRuntimeTelemetry }) {
  const manifest = telemetry.context.manifest;
  const latestCompaction = telemetry.context.latestCompaction;
  return (
    <div className="mt-3 grid gap-2 border-t border-border pt-3 text-[11px] sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-card/70 p-2.5">
        <div className="flex items-center gap-1.5 font-medium text-foreground"><Gauge className="size-3.5 text-primary" />Context</div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Basis</dt><dd className="text-right text-foreground">{telemetry.context.basis}</dd>
          <dt>Pressure</dt><dd className="text-right text-foreground">{telemetry.context.pressure ?? "—"}</dd>
          <dt>Decision</dt><dd className="text-right text-foreground">{telemetry.context.decision ?? "—"}</dd>
          <dt>Reserve</dt><dd className="text-right text-foreground">{displayNumber(telemetry.context.reservedOutputTokens)}</dd>
          <dt>Safety</dt><dd className="text-right text-foreground">{displayNumber(telemetry.context.safetyMarginTokens)}</dd>
          <dt>Soft / hard</dt><dd className="text-right text-foreground">{displayNumber(telemetry.context.softThresholdTokens)} / {displayNumber(telemetry.context.hardLimitTokens)}</dd>
          <dt>Capability</dt><dd className="truncate text-right text-foreground">{telemetry.context.capabilitySource ?? "—"}</dd>
          <dt>Reason</dt><dd className="truncate text-right text-foreground">{typeof latestCompaction?.reason === "string" ? latestCompaction.reason : telemetry.modelAttempt?.errorCode ?? telemetry.context.decision ?? "—"}</dd>
        </dl>
      </div>
      <div className="rounded-lg border border-border bg-card/70 p-2.5">
        <div className="flex items-center gap-1.5 font-medium text-foreground"><Activity className="size-3.5 text-primary" />Model</div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Attempt</dt><dd className="text-right text-foreground">{telemetry.modelAttempt?.status ?? "—"}</dd>
          <dt>Model</dt><dd className="truncate text-right text-foreground">{telemetry.modelAttempt?.model ?? "—"}</dd>
          <dt>Queue</dt><dd className="text-right text-foreground">{displayDuration(telemetry.modelAttempt?.queueMs)}</dd>
          <dt>First token</dt><dd className="text-right text-foreground">{displayDuration(telemetry.modelAttempt?.timeToFirstTokenMs)}</dd>
          <dt>Latency</dt><dd className="text-right text-foreground">{displayDuration(telemetry.modelAttempt?.latencyMs)}</dd>
          <dt>Output</dt><dd className="text-right text-foreground">{displayNumber(telemetry.modelAttempt?.outputTokens)} tokens</dd>
          <dt>Attempts</dt><dd className="text-right text-foreground">{telemetry.attempts.length}</dd>
          <dt>Rolling</dt><dd className="text-right text-foreground">{displayDuration(telemetry.rolling.latencyMs)} · {displayNumber(telemetry.rolling.outputTokensPerSecond)} t/s</dd>
        </dl>
      </div>
      <div className="rounded-lg border border-border bg-card/70 p-2.5 sm:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2 font-medium text-foreground"><span>Evidence</span><span className="font-mono text-[10px] text-muted-foreground">rev {telemetry.revision} · {displayTimestamp(telemetry.observedAt)}</span></div>
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-2">
          <div className="flex justify-between gap-3"><dt>Manifest</dt><dd className="max-w-[14rem] truncate font-mono text-foreground">{telemetry.context.manifestDigest ?? "—"}</dd></div>
          <div className="flex justify-between gap-3"><dt>Components</dt><dd className="text-foreground">{Array.isArray(manifest?.components) ? manifest.components.length : "—"}</dd></div>
          <div className="flex justify-between gap-3"><dt>Compactions</dt><dd className="text-foreground">{telemetry.context.compactionCount}</dd></div>
          <div className="flex justify-between gap-3"><dt>Latest</dt><dd className="max-w-[14rem] truncate text-foreground">{latestCompaction && typeof latestCompaction.type === "string" ? latestCompaction.type : "—"}</dd></div>
        </dl>
      </div>
    </div>
  );
}

export function StudioPage({ initialAgents, initialAgentId, agentsUnavailable = false, surface = "studio" }: StudioPageProps) {
  const router = useRouter();
  const agents = useMemo(() => initialAgents, [initialAgents]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialAgentId ?? null);
  const selectedAgent = useMemo(() => agents.find((agent) => agent.id === selectedAgentId) ?? null, [agents, selectedAgentId]);
  const routeBase = surface;

  const selectAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    router.replace(`/${routeBase}?agent=${encodeURIComponent(agentId)}`);
  };

  const backToList = () => {
    setSelectedAgentId(null);
    router.replace(`/${routeBase}`);
  };

  if (!selectedAgent) {
    return (
      <StudioAgentList
        agents={agents}
        agentsUnavailable={agentsUnavailable}
        surface={surface}
        onCreate={() => router.push("/studio/new")}
        onSelect={selectAgent}
      />
    );
  }

  return <StudioWorkspace key={selectedAgent.id} agent={selectedAgent} onBack={backToList} surface={surface} />;
}

function StudioAgentList({
  agents,
  agentsUnavailable,
  surface,
  onCreate,
  onSelect,
}: {
  agents: AgentDefinition[];
  agentsUnavailable: boolean;
  surface: "studio" | "playground";
  onCreate: () => void;
  onSelect: (agentId: string) => void;
}) {
  return (
    <div className="min-h-[calc(100dvh-4rem)] bg-canvas">
      <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
        <header className="flex flex-col gap-5 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-primary"><FlaskConical className="size-4" /><SectionEyebrow>{surface === "playground" ? "Agent testing" : "Automation"}</SectionEyebrow></div>
            <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">{surface === "playground" ? "Playground" : "Studio"}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{surface === "playground" ? "Run agents against live Playground resources." : "Configure and publish agents."}</p>
          </div>
        <Button type="button" onClick={onCreate}><Plus className="mr-1.5 size-4" />Create agent</Button>
        </header>

        <section className="mt-8" aria-labelledby="studio-agents-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="studio-agents-heading" className="text-sm font-semibold text-foreground">Agents</h2>
            <span className="text-xs text-muted-foreground">{agents.length} {agents.length === 1 ? "agent" : "agents"}</span>
          </div>
          {agentsUnavailable ? <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Workspace agents are unavailable.</p> : null}
          {agents.length ? (
            <div className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
              {agents.map((agent) => (
                <button key={agent.id} type="button" onClick={() => onSelect(agent.id)} className="group flex w-full items-center gap-4 px-4 py-4 text-left transition-colors hover:bg-muted/50 sm:px-5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Bot className="size-5" /></span>
                  <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-semibold text-foreground">{agent.name}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", statusClass(agent.status))}>{statusLabel(agent.status)}</span>{agent.protected ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">Default</span> : null}</span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">{agent.description || "No description"}</span>
                  </span>
                  <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block"><span className="block">{agent.version_number ? `v${agent.version_number}` : "No version"}</span><span className="mt-1 block">{agent.installation_id ? "Installed" : "Not installed"}</span></span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3 rounded-xl border border-dashed border-border bg-card px-6 py-16 text-center">
              <Bot className="mx-auto size-6 text-muted-foreground" />
              <h3 className="mt-3 text-sm font-semibold text-foreground">{surface === "playground" ? "No Playground agents yet" : "No agents yet"}</h3>
              <Button type="button" variant="outline" size="sm" className="mt-5" onClick={onCreate}><Plus className="mr-1.5 size-3.5" />Create agent</Button>
            </div>
          )}
        </section>
      </div>

    </div>
  );
}

function StudioWorkspace({ agent, onBack, surface }: { agent: AgentDefinition; onBack: () => void; surface: "studio" | "playground" }) {
  const router = useRouter();
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(agent.installation_version_id ?? agent.published_version_id ?? null);
  const [instructions, setInstructions] = useState("");
  const [trace, setTrace] = useState<TraceNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(surface === "playground");
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<AgentRuntimeTelemetry | null>(null);
  const [telemetryDetailsOpen, setTelemetryDetailsOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [installingPlayground, setInstallingPlayground] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions[0] ?? null;
  const playgroundReady = agent.installation_settings?.environment === "playground";

  const applyConversation = useCallback((result: Awaited<ReturnType<typeof resolvePlatformConversation>>) => {
    setConversationId(result.conversation.id);
    setMessages(result.messages.map(chatMessageFromAgent));
  }, []);

  const refreshConversation = useCallback(async (id: string) => {
    const result = await getPlatformConversation(id);
    setConversationId(result.conversation.id);
    setMessages(result.messages.map(chatMessageFromAgent));
  }, []);

  useEffect(() => {
    if (surface !== "playground" || !agent.installation_id || !playgroundReady) {
      setConversationLoading(false);
      return;
    }
    let cancelled = false;
    setConversationLoading(true);
    void resolvePlatformConversation(agent.installation_id)
      .then((result) => {
        if (!cancelled) applyConversation(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load Playground conversation");
      })
      .finally(() => {
        if (!cancelled) setConversationLoading(false);
      });
    return () => { cancelled = true; };
  }, [agent.installation_id, applyConversation, playgroundReady, surface]);

  useEffect(() => {
    let cancelled = false;
    setLoadingVersions(true);
    void listAgentVersions(agent.id)
      .then((result) => {
        if (cancelled) return;
        setVersions(result.versions);
        const preferred = result.versions.find((version) => version.id === (agent.installation_version_id ?? agent.published_version_id))
          ?? result.versions.find((version) => version.status === "draft")
          ?? result.versions[0]
          ?? null;
        setSelectedVersionId(preferred?.id ?? null);
        setInstructions(preferred?.instructions ?? "");
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load agent versions");
      })
      .finally(() => {
        if (!cancelled) setLoadingVersions(false);
      });
    return () => { cancelled = true; };
  }, [agent]);

  useEffect(() => {
    if (!activeRunId) return;
    let cancelled = false;
    const refreshRuntimeEvidence = async () => {
      const timeline = await getAgentRunTimeline(activeRunId).catch(() => null);
      if (cancelled || !timeline) return;
      setTelemetry(timeline.telemetry ?? null);
      if (timeline.journal?.length) {
        const journalNodes = nodesFromJournalEvents(timeline.journal, timeline.telemetry?.revision);
        if (journalNodes.length) setTrace(journalNodes);
      }
    };
    void refreshRuntimeEvidence();
    const timer = window.setInterval(() => { void refreshRuntimeEvidence(); }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRunId]);

  const selectVersion = (versionId: string) => {
    setSelectedVersionId(versionId);
    setInstructions(versions.find((version) => version.id === versionId)?.instructions ?? "");
    setTrace([]);
    setSelectedNodeId(null);
    setTelemetry(null);
    setTelemetryDetailsOpen(false);
    setNotice(null);
  };

  const addTraceEvent = useCallback((event: AgentStreamEvent) => {
    const nextNode = nodeFromEvent(event);
    setTrace((current) => {
      const existing = current.find((node) => node.id === nextNode.id);
      const settled = current.map((node) => node.status === "running" ? { ...node, status: "complete" as const } : node);
      if (existing) return settled.map((node) => node.id === nextNode.id ? nextNode : node);
      return [...settled, nextNode].sort((left, right) => left.sequence - right.sequence);
    });
  }, []);

  const runAgent = async () => {
    if (!agent.installation_id) {
      setError("This agent is not installed yet.");
      return;
    }
    if (agent.installation_settings?.environment !== "playground") {
      setError("This agent has no isolated Playground installation.");
      return;
    }
    const message = input.trim();
    if (!message || running || conversationLoading) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    setSelectedNodeId(null);
    setTrace([{ id: "input", event: "run.received", label: "Input", detail: message, status: "running", sequence: 0, data: { message } }]);
    try {
      let targetConversationId = conversationId;
      if (!targetConversationId) {
        const created = await createNewPlatformConversation(agent.installation_id);
        targetConversationId = created.conversation.id;
        applyConversation(created);
      }
      const accepted = await sendPlatformMessage(agent.installation_id, {
        message,
        conversationId: targetConversationId,
        idempotencyKey: crypto.randomUUID(),
        context: { route: window.location.pathname, pageTitle: document.title },
      });
      setMessages((current) => {
        const acceptedMessage = chatMessageFromAgent(accepted.message);
        return current.some((item) => item.id === acceptedMessage.id) ? current : [...current, acceptedMessage];
      });
      setInput("");
      setActiveRunId(accepted.runId);
      addTraceEvent({ event: "run.received", data: { sequence_number: 1, run_id: accepted.runId } });
      const controller = new AbortController();
      await streamAgentRun(accepted.runId, addTraceEvent, controller.signal);
      const result = await getAgentRun(accepted.runId);
      const timeline = await getAgentRunTimeline(accepted.runId).catch(() => null);
      setTelemetry(timeline?.telemetry ?? null);
      const runNodes = timeline?.journal?.length
        ? nodesFromJournalEvents(timeline.journal, timeline.telemetry?.revision)
        : nodesFromRunEvents(result.events);
      if (runNodes.length) setTrace(runNodes);
      await refreshConversation(targetConversationId);
      if (result.run.status === "cancelled") {
        setNotice("Run cancelled");
      } else if (terminalStatuses.has(result.run.status) && result.run.status !== "completed") {
        throw new Error(result.run.error?.userMessage || result.run.error?.message || `Run ${result.run.status}`);
      } else {
        setNotice(`Run ${result.run.status}`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent run failed");
      setTrace((current) => current.map((node) => node.status === "running" ? { ...node, status: "error" } : node));
    } finally {
      setRunning(false);
      setCancelling(false);
      setActiveRunId(null);
    }
  };

  const cancelRun = async () => {
    if (!activeRunId || cancelling) return;
    setCancelling(true);
    setError(null);
    try {
      await cancelAgentRun(activeRunId, "Cancelled from Playground");
      setNotice("Cancellation requested");
    } catch (cause) {
      setCancelling(false);
      setError(cause instanceof Error ? cause.message : "Unable to cancel run");
    }
  };

  const installPlayground = async () => {
    if (!agent.protected || installingPlayground) return;
    setInstallingPlayground(true);
    setError(null);
    setNotice(null);
    try {
      const installation = await ensureKasiAiPlayground();
      if (installation.settings?.environment !== "playground") {
        throw new Error("Playground installation is not available yet. Restart the local Agent Platform and try again.");
      }
      router.push(`/playground?agent=${encodeURIComponent(agent.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to install Playground");
      setInstallingPlayground(false);
    }
  };

  const saveDraft = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const configuredSpec = selectedVersion?.configuration?.agentSpec;
      const next = configuredSpec && typeof configuredSpec === "object" && !Array.isArray(configuredSpec)
        ? await createAgentVersion(agent.id, {
          spec: {
            ...(configuredSpec as AgentSpecInput),
            behavior: {
              ...((configuredSpec as AgentSpecInput).behavior ?? {}),
              instructions,
            },
          },
        })
        : await createAgentVersion(agent.id, { instructions });
      setVersions((current) => [next, ...current]);
      setSelectedVersionId(next.id);
      setNotice("Draft saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save draft");
    } finally {
      setSaving(false);
    }
  };

  const deploy = async () => {
    if (!selectedVersion) return;
    setDeploying(true);
    setError(null);
    setNotice(null);
    try {
      const published = selectedVersion.status === "published" ? selectedVersion : await publishAgentVersion(agent.id, selectedVersion.id);
      if (agent.installation_id) await deployAgentInstallation(agent.installation_id, published.id, agent.installation_version_id ?? undefined);
      setVersions((current) => current.map((version) => version.id === published.id ? published : version));
      setNotice(surface === "playground" ? "Playground updated" : "Installation updated");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to deploy version");
    } finally {
      setDeploying(false);
    }
  };

  const selectedNode = trace.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col bg-canvas">
      <header className="border-b border-border bg-card/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1760px] flex-wrap items-center gap-3">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={onBack}><ArrowLeft className="size-4" />{surface === "playground" ? "Playground" : "Studio"}</Button>
          <span className="hidden h-5 w-px bg-border sm:block" />
          <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><Bot className="size-4 shrink-0 text-primary" /><span className="truncate text-sm font-semibold text-foreground">{agent.name}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", statusClass(agent.status))}>{statusLabel(agent.status)}</span></div><p className="mt-0.5 text-[11px] text-muted-foreground">{selectedVersion ? `v${selectedVersion.version_number}` : "No version"}</p></div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><span className="hidden sm:inline">Version</span><select value={selectedVersionId ?? ""} onChange={(event) => selectVersion(event.target.value)} disabled={loadingVersions || !versions.length} className="h-8 max-w-36 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none focus:border-primary"><option value="">{loadingVersions ? "Loading…" : "No versions"}</option>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {version.status}</option>)}</select></label>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs text-primary"><FlaskConical className="size-3.5" />{surface === "playground" ? "Playground" : "Studio"}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfigurationOpen(true)}><SlidersHorizontal className="mr-1.5 size-3.5" />Configuration</Button>
          {surface === "playground"
            ? activeRunId ? <Button type="button" variant="outline" size="sm" onClick={() => void cancelRun()} disabled={cancelling}><X className="mr-1.5 size-3.5" />{cancelling ? "Cancelling…" : "Cancel"}</Button> : null
            : agent.protected ? <span className="hidden rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs text-primary sm:inline-flex">Protected default</span> : <Button type="button" size="sm" onClick={() => router.push(`/playground?agent=${encodeURIComponent(agent.id)}`)}><FlaskConical className="mr-1.5 size-3.5" />Open Playground</Button>}
          {!agent.protected ? <Button type="button" variant="outline" size="sm" onClick={() => void deploy()} disabled={deploying || !selectedVersion}><Rocket className="mr-1.5 size-3.5" />{deploying ? "Updating…" : surface === "playground" ? "Update Playground" : "Update installation"}</Button> : null}
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[1760px] flex-1 px-3 py-3 sm:px-5 lg:px-6">
        <div className="grid min-h-[calc(100dvh-9rem)] flex-1 overflow-hidden rounded-2xl border border-border bg-card xl:grid-cols-[minmax(330px,0.34fr)_minmax(0,0.66fr)]">
          <section className="flex min-h-[540px] min-w-0 flex-col border-b border-border xl:min-h-0 xl:border-b-0 xl:border-r">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><div><SectionEyebrow>Conversation</SectionEyebrow><h1 className="mt-1 text-sm font-semibold text-foreground">{agent.name}</h1></div><span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><MessageCircle className="size-3.5" />{conversationId ? "Ready" : conversationLoading ? "Loading" : "New"}</span></div>
            <RuntimeStatusRow telemetry={telemetry} detailsOpen={telemetryDetailsOpen} onToggleDetails={() => setTelemetryDetailsOpen((current) => !current)} />
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
              {conversationLoading ? <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />Loading conversation</div> : messages.length ? messages.map((message) => <div key={message.id} className={cn("flex", message.direction === "user" ? "justify-end" : "justify-start")}><div className={cn("max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-5", message.direction === "user" ? "rounded-br-md bg-primary text-primary-foreground" : message.direction === "system" ? "border border-border bg-muted/50 text-muted-foreground" : "rounded-bl-md bg-muted text-foreground")}>{message.text}</div></div>) : <div className="flex h-full min-h-48 flex-col items-center justify-center px-5 text-center"><MessageCircle className="size-5 text-muted-foreground" /><p className="mt-3 text-sm font-medium text-foreground">Start a conversation</p><p className="mt-1 text-xs text-muted-foreground">Send a message to run this agent.</p></div>}
              {running ? <div className="flex justify-start"><div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Agent is running</div></div> : null}
            </div>
            {error ? <div className="mx-4 mb-3 flex items-start justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert"><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError(null)}><X className="size-4 shrink-0" /></button></div> : null}
            {notice ? <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"><Check className="size-3.5" />{notice}</div> : null}
            <form className="border-t border-border p-3" onSubmit={(event) => { event.preventDefault(); void runAgent(); }}>
              <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:border-primary"><Textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void runAgent(); } }} placeholder={surface === "playground" ? "Message this agent…" : "Open Playground to run"} disabled={surface !== "playground" || !playgroundReady || conversationLoading || running} rows={2} className="min-h-12 resize-none border-0 bg-transparent p-1.5 text-sm shadow-none focus-visible:ring-0" aria-label="Message agent" /><Button type="submit" size="icon" className="size-9 shrink-0 rounded-lg" disabled={surface !== "playground" || !playgroundReady || conversationLoading || running || !input.trim()} aria-label="Send message"><Send className="size-4" /></Button></div>
              {!agent.installation_id ? <p className="mt-2 px-1 text-[11px] text-amber-700 dark:text-amber-300">Agent is not installed</p> : !playgroundReady ? <div className="mt-2 flex items-center justify-between gap-2 px-1"><span className="text-[11px] text-amber-700 dark:text-amber-300">Playground installation required</span>{agent.protected && surface === "studio" ? <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => void installPlayground()} disabled={installingPlayground}>{installingPlayground ? <LoaderCircle className="mr-1.5 size-3 animate-spin" /> : <FlaskConical className="mr-1.5 size-3" />}{installingPlayground ? "Installing…" : "Install Playground"}</Button> : null}</div> : <p className="mt-2 px-1 text-[11px] text-muted-foreground">Enter to send · Shift+Enter for a new line</p>}
            </form>
          </section>

          <section className="flex min-h-[620px] min-w-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><div><SectionEyebrow>Execution graph</SectionEyebrow><h1 className="mt-1 text-sm font-semibold text-foreground">{trace.length ? "Latest run" : "No run yet"}</h1></div><span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><CircleDot className={cn("size-3", running ? "animate-pulse text-primary" : "text-muted-foreground")} />{running ? "Running" : trace.length ? "Trace ready" : "Waiting"}</span></div>
            <div className="relative min-h-[560px] flex-1 overflow-auto bg-[radial-gradient(circle_at_50%_45%,color-mix(in_srgb,var(--brand)_6%,transparent),transparent_55%)]">
              {trace.length ? <TraceGraph nodes={trace} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} /> : <div className="flex h-full min-h-[560px] flex-col items-center justify-center px-6 text-center"><div className="flex size-12 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"><Sparkles className="size-5" /></div><p className="mt-4 text-sm font-medium text-foreground">Run the agent to see its execution</p><p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">The graph will be built from the durable run events.</p></div>}
              {selectedNode ? <div className="absolute bottom-4 left-4 right-4 z-10 max-h-72 overflow-auto rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur"><button type="button" aria-label="Close step details" onClick={() => setSelectedNodeId(null)} className="absolute right-3 top-3 z-10 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button><NodeInspector node={selectedNode} /></div> : null}
            </div>
          </section>
        </div>
      </div>
      {configurationOpen ? <div className="fixed inset-0 z-50" role="presentation"><button type="button" aria-label="Close configuration" className="absolute inset-0 bg-black/50" onClick={() => setConfigurationOpen(false)} /><aside role="dialog" aria-modal="true" aria-labelledby="configuration-title" className="absolute inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l border-border bg-card shadow-2xl"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><SectionEyebrow>Agent</SectionEyebrow><h2 id="configuration-title" className="mt-1 text-sm font-semibold text-foreground">Configuration</h2></div><button type="button" aria-label="Close configuration" onClick={() => setConfigurationOpen(false)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button></div><Inspector node={null} agent={agent} version={selectedVersion} instructions={instructions} setInstructions={setInstructions} onSave={saveDraft} saving={saving} /></aside></div> : null}
    </div>
  );
}

function TraceGraph({ nodes, selectedNodeId, onSelect }: { nodes: TraceNode[]; selectedNodeId: string | null; onSelect: (id: string) => void }) {
  return <div className="flex min-w-max items-center justify-center px-8 py-24"><div className="flex items-center">{nodes.map((node, index) => <div key={node.id} className="flex items-center"><button type="button" onClick={() => onSelect(node.id)} className={cn("w-32 rounded-lg border bg-background p-3 text-left transition-colors", selectedNodeId === node.id ? "border-primary ring-2 ring-primary/15" : "border-border hover:border-primary/50")}><span className={cn("flex size-6 items-center justify-center rounded-md", node.status === "error" ? "bg-destructive/10 text-destructive" : node.status === "running" ? "bg-primary/10 text-primary" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300")}><TraceIcon node={node} /></span><span className="mt-3 block truncate text-xs font-semibold text-foreground">{node.label}</span><span className="mt-1 block truncate text-[10px] text-muted-foreground">{node.detail}</span></button>{index < nodes.length - 1 ? <TraceConnector /> : null}</div>)}</div></div>;
}

function TraceConnector() {
  return <svg width="58" height="24" viewBox="0 0 58 24" className="shrink-0 text-border" aria-hidden="true"><path d="M3 12H47" stroke="currentColor" strokeWidth="1.5" /><path d="M42 6L49 12L42 18" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" /></svg>;
}

function TraceIcon({ node }: { node: TraceNode }) {
  if (node.label.startsWith("Tool")) return <Wrench className="size-3.5" />;
  if (node.label === "Context") return <Settings2 className="size-3.5" />;
  if (node.label === "Model") return <Bot className="size-3.5" />;
  if (node.label === "Approval") return <ShieldCheck className="size-3.5" />;
  if (node.label === "Completed") return <Check className="size-3.5" />;
  return <CircleDot className="size-3.5" />;
}

function Inspector({ node, agent, version, instructions, setInstructions, onSave, saving }: { node: TraceNode | null; agent: AgentDefinition; version: AgentVersion | null; instructions: string; setInstructions: (value: string) => void; onSave: () => void; saving: boolean }) {
  if (node) return <NodeInspector node={node} />;
  return <div><div className="border-b border-border px-4 py-3"><SectionEyebrow>Agent</SectionEyebrow><h2 className="mt-1 text-sm font-semibold text-foreground">Configuration</h2></div><div className="space-y-5 p-4">{agent.protected ? <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-5 text-primary">KasiAi is the protected platform default. Its runtime policy is managed by the platform.</p> : <><div><label htmlFor="studio-instructions" className="text-xs font-medium text-foreground">Instructions</label><Textarea id="studio-instructions" value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Define what this agent should do…" className="mt-2 min-h-40 resize-y text-sm" /></div><Button type="button" size="sm" onClick={onSave} disabled={saving}>{saving ? <LoaderCircle className="mr-1.5 size-3.5 animate-spin" /> : <Save className="mr-1.5 size-3.5" />}{saving ? "Saving…" : "Save draft"}</Button></>}<div className="border-t border-border pt-4"><div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">Version</span><span className="font-medium text-foreground">{version ? `v${version.version_number}` : "None"}</span></div><div className="mt-3 flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">Installation</span><span className="font-medium text-foreground">{agent.installation_id ? "Ready" : "Not installed"}</span></div><div className="mt-3 flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">Environment</span><span className="font-medium text-foreground">{agent.protected ? "Platform" : "Playground"}</span></div></div></div></div>;
}

function NodeInspector({ node }: { node: TraceNode }) {
  return <div><div className="border-b border-border px-4 py-3"><SectionEyebrow>Execution step</SectionEyebrow><h2 className="mt-1 text-sm font-semibold text-foreground">{node.label}</h2></div><div className="space-y-4 p-4"><div className="flex items-center justify-between gap-3"><span className="text-xs text-muted-foreground">Status</span><span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", node.status === "error" ? "text-destructive" : node.status === "running" ? "text-primary" : "text-emerald-700 dark:text-emerald-300")}><span className="size-1.5 rounded-full bg-current" />{node.status}</span></div><div className="grid gap-3 text-[11px] sm:grid-cols-3"><div><SectionEyebrow>Event ID</SectionEyebrow><p className="mt-1 break-all font-mono text-foreground">{node.eventId ?? "—"}</p></div><div><SectionEyebrow>Sequence</SectionEyebrow><p className="mt-1 font-mono text-foreground">{node.journalSequence ?? node.sequence}</p></div><div><SectionEyebrow>Snapshot</SectionEyebrow><p className="mt-1 font-mono text-foreground">{node.snapshotRevision ?? "—"}</p></div></div><div><SectionEyebrow>Event</SectionEyebrow><p className="mt-1 break-all font-mono text-[11px] text-foreground">{node.event}</p></div><div><SectionEyebrow>Detail</SectionEyebrow><p className="mt-1 text-xs leading-5 text-muted-foreground">{node.detail}</p></div><div><SectionEyebrow>Payload</SectionEyebrow><pre className="mt-2 max-h-52 overflow-auto rounded-lg bg-muted/60 p-3 font-mono text-[10px] leading-4 text-muted-foreground">{JSON.stringify(node.data, null, 2)}</pre></div></div></div>;
}
