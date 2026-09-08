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
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  createAgentVersion,
  cancelAgentRun,
  createPlatformConversation,
  deployAgentInstallation,
  ensureKasiAiPlayground,
  getAudioTranscriptionJob,
  getPlatformConversation,
  getAgentModelCatalog,
  getAgentRun,
  getAgentRunTimeline,
  listAgentVersions,
  publishAgentVersion,
  resolvePlatformConversation,
  sendPlatformAudio,
  sendPlatformMessage,
  streamAgentRun,
  type AgentMessage,
  type AgentDefinition,
  type AgentJournalEvent,
  type AgentModel,
  type AgentModelCatalog,
  type AgentModelProvider,
  type AgentRuntimeTelemetry,
  type AgentSpecInput,
  type AgentStreamEvent,
  type AgentVersion,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";
import { AgentChatComposer } from "@/components/dashboard/agents/agent-chat-composer";
import { StudioSettingsPrototype, type StudioCapabilityDraft } from "@/components/dashboard/studio/studio-settings-prototype";
import { StudioSystemCanvas, type StudioGraphNode, type StudioGraphStatus } from "@/components/dashboard/studio/studio-system-canvas";

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

async function waitForStudioAudioTranscriptionJob(
  jobId: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof getAudioTranscriptionJob>>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const job = await getAudioTranscriptionJob(jobId);
      if (["completed", "failed", "deleted"].includes(job.status)) return job;
    } catch {
      // The job is durable. Keep polling through brief transport failures.
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, 800);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  throw new Error("Audio transcription is taking longer than expected");
}

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

function studioNodeStatus(node: StudioGraphNode, trace: TraceNode[]): StudioGraphStatus {
  const matching = trace.filter((traceNode) => {
    const event = traceNode.event.toLowerCase();
    const label = traceNode.label.toLowerCase();
    if (node.id === "input") return event.includes("received") || label === "input";
    if (node.id === "context") return event.includes("context");
    if (node.id === "memory-read" || node.id === "memory-write") return event.includes("memory");
    if (node.id === "retrieval") return event.includes("retriev") || label.includes("knowledge");
    if (node.id === "model") return event.includes("model") || label === "model";
    if (node.id === "router") return event.includes("route") || event.includes("capabilit");
    if (node.id === "calendar") return label.includes("calendar") || label.includes("booking");
    if (node.id === "mcp") return event.includes("mcp") || label.includes("mcp");
    if (node.id === "content-skill") return label.includes("content") || label.includes("skill");
    if (node.id === "approval") return event.includes("approval");
    if (node.id === "handoff") return event.includes("handoff") || event.includes("human");
    if (node.id === "output" || node.id === "delivery") return event.includes("complete") || event.includes("deliver");
    return false;
  });
  const latest = matching.at(-1);
  if (!latest) return "idle";
  if (latest.status === "error") return "error";
  if (latest.status === "running" && latest.id === trace.at(-1)?.id) return node.id === "approval" ? "waiting" : "running";
  return "complete";
}

function buildStudioGraph(modelLabel: string, trace: TraceNode[]): StudioGraphNode[] {
  const nodes: StudioGraphNode[] = [
    { id: "input", label: "Message input", detail: "Web, WhatsApp, Telegram, Discord", kind: "input", status: "idle", configured: true, scope: "channel", event: "run.received", data: { source: "webhook or conversation", mode: "inbound" } },
    { id: "channel", label: "Channel gateway", detail: "Normalize and authenticate", kind: "channel", status: "idle", configured: true, configurable: true, scope: "workspace", event: "channel.accepted", data: { channels: "Web · WhatsApp · Telegram · Discord", auth: "workspace connection" } },
    { id: "session", label: "Session", detail: "Durable run and conversation", kind: "session", status: "idle", configured: true, scope: "tenant / conversation", event: "run.started", data: { state: "durable", retries: "enabled" } },
    { id: "context", label: "Context engine", detail: "Compose the model's working set", kind: "context", status: "idle", configured: true, configurable: true, scope: "agent / run", event: "agent.context.prepared", data: { policy: "bounded context", sources: "messages · workspace · memory" } },
    { id: "memory-read", label: "Memory read", detail: "Facts, preferences, prior work", kind: "memory", status: "idle", configured: true, configurable: true, scope: "tenant / user / agent", event: "memory.retrieval.completed", data: { namespaces: "customer · business · agent", ranking: "hybrid + temporal" } },
    { id: "retrieval", label: "Knowledge retrieval", detail: "Connected sources and evidence", kind: "retrieval", status: "idle", configured: true, configurable: true, scope: "workspace", event: "context.retrieval.completed", data: { sources: "workspace knowledge · connected apps", evidence: "source IDs retained" } },
    { id: "model", label: modelLabel || "Primary model", detail: "Reason, plan, and choose next step", kind: "model", status: "idle", configured: true, configurable: true, provider: "Model provider", scope: "agent version", event: "agent.model.completed", data: { provider: "configured model provider", turn: "bounded by run policy" } },
    { id: "router", label: "Capability router", detail: "Select the next operation", kind: "router", status: "idle", configured: true, scope: "agent version", event: "agent.route.selected", data: { policy: "typed capabilities", selection: "model decision" } },
    { id: "calendar", label: "Bookings tool", detail: "Check and update availability", kind: "tool", status: "idle", configured: true, configurable: true, provider: "Google Calendar", scope: "workspace connection", event: "agent.tool.completed", data: { tool: "check_availability", connection: "Google Calendar", risk: "write requires approval" } },
    { id: "mcp", label: "MCP server", detail: "Connected workspace tools", kind: "mcp", status: "idle", configured: true, configurable: true, provider: "KasiTek MCP", scope: "workspace", event: "agent.mcp.tool.completed", data: { server: "KasiTek workspace", tools: "content · campaigns · contacts" } },
    { id: "content-skill", label: "Content skill", detail: "Draft and publish across platforms", kind: "skill", status: "idle", configured: true, configurable: true, provider: "multi-platform content", scope: "agent version", event: "agent.skill.completed", data: { skill: "content-management", platforms: "LinkedIn · Instagram · Facebook" } },
    { id: "approval", label: "Approval gate", detail: "Pause before sensitive actions", kind: "approval", status: "idle", configured: true, configurable: true, scope: "workspace policy", event: "approval.requested", data: { policy: "human approval", actions: "publish · send · modify" } },
    { id: "handoff", label: "Human handoff", detail: "Escalate with full context", kind: "handoff", status: "idle", configured: true, configurable: true, scope: "workspace / team", event: "handoff.requested", data: { target: "support team", context: "conversation + evidence" } },
    { id: "memory-write", label: "Memory write", detail: "Persist useful outcomes", kind: "memory", status: "idle", configured: true, configurable: true, scope: "tenant / user / agent", event: "memory.write.completed", data: { lifecycle: "capture · review · project", evidence: "run event digest" } },
    { id: "output", label: "Response", detail: "Assemble the final answer", kind: "output", status: "idle", configured: true, scope: "run", event: "run.completed", data: { format: "channel-aware response", trace: "journal-backed" } },
    { id: "delivery", label: "Delivery", detail: "Send and record the result", kind: "delivery", status: "idle", configured: true, configurable: true, scope: "channel", event: "message.delivered", data: { retries: "idempotent", receipts: "stored" } },
  ];
  return nodes.map((node) => ({ ...node, status: studioNodeStatus(node, trace) }));
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

type ModelSelection = Pick<AgentModel, "provider" | "model">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAgentModelProvider(value: unknown): value is AgentModelProvider {
  return typeof value === "string" && [
    "openrouter",
    "openai",
    "anthropic",
    "gemini",
    "deepseek",
    "glm",
    "kimi",
    "minimax",
    "xai",
    "opencode_go",
    "opencode_zen",
  ].includes(value);
}

function modelSelectionFromVersion(version: AgentVersion | null | undefined): ModelSelection | null {
  const configuration = version?.configuration;
  const spec = isRecord(configuration?.agentSpec) ? configuration.agentSpec : undefined;
  const specModel = isRecord(spec?.model) ? spec.model : undefined;
  const specPrimary = isRecord(specModel?.primary) ? specModel.primary : undefined;
  const policy = version?.policy;
  const modelPolicy = isRecord(policy?.modelPolicy)
    ? policy.modelPolicy
    : isRecord(version?.model_policy)
      ? version.model_policy
      : undefined;
  const policyPrimary = isRecord(modelPolicy?.primary) ? modelPolicy.primary : undefined;
  const provider = specPrimary?.provider ?? policyPrimary?.provider ?? configuration?.provider;
  const model = specPrimary?.model ?? policyPrimary?.model ?? configuration?.model;
  if (!isAgentModelProvider(provider) || typeof model !== "string" || !model.trim()) return null;
  return { provider, model: model.trim() };
}

function RuntimeStatusRow({ telemetry, model, detailsOpen, onToggleDetails }: { telemetry: AgentRuntimeTelemetry | null; model?: AgentModel; detailsOpen: boolean; onToggleDetails: () => void }) {
  const contextTokens = telemetry?.context.tokens ?? 0;
  const contextWindowTokens = telemetry?.context.contextWindowTokens ?? model?.contextWindow ?? 0;
  const contextValue = `${contextTokens.toLocaleString()} / ${contextWindowTokens.toLocaleString()}`;
  const utilization = telemetry?.context.utilizationPercent ?? 0;
  const latency = telemetry?.modelAttempt?.latencyMs ?? telemetry?.rolling.latencyMs ?? 0;
  const turnElapsed = telemetry?.turn.elapsedMs ?? 0;
  return (
    <div className="border-b border-border bg-background/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground"><Activity className="size-3.5 text-primary" />Runtime</span>
        <span className="text-muted-foreground">Context <strong className="font-medium text-foreground">{contextValue}</strong></span>
        <span className="text-muted-foreground">Use <strong className="font-medium text-foreground">{displayNumber(utilization, "%")}</strong></span>
        <span className="text-muted-foreground">Latency <strong className="font-medium text-foreground">{displayDuration(latency)}</strong></span>
        <span className="text-muted-foreground">Turn <strong className="font-medium text-foreground">{displayDuration(turnElapsed)}</strong></span>
        <button type="button" className="ml-auto inline-flex items-center gap-1 text-primary hover:text-primary/80" aria-expanded={detailsOpen} onClick={onToggleDetails}>{detailsOpen ? "Hide" : "Details"}<span aria-hidden="true">{detailsOpen ? "−" : "+"}</span></button>
      </div>
      {detailsOpen ? telemetry ? <RuntimeTelemetryDetail telemetry={telemetry} /> : <div className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">No run data yet.</div> : null}
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
      <div className="rounded-lg border border-border bg-card/70 p-2.5">
        <div className="flex items-center gap-1.5 font-medium text-foreground"><Gauge className="size-3.5 text-primary" />Run usage</div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Total</dt><dd className="text-right text-foreground">{displayNumber(telemetry.usage.totalTokens)} tokens</dd>
          <dt>Input / output</dt><dd className="text-right text-foreground">{displayNumber(telemetry.usage.inputTokens)} / {displayNumber(telemetry.usage.outputTokens)}</dd>
          <dt>Budget</dt><dd className="text-right text-foreground">{displayNumber(telemetry.runBudget.maxTotalTokens)} tokens</dd>
          <dt>Remaining</dt><dd className="text-right text-foreground">{displayNumber(telemetry.runBudget.remainingTokens)} tokens</dd>
          <dt>Basis</dt><dd className="text-right text-foreground">{telemetry.usage.basis}</dd>
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
            <p className="mt-2 text-sm text-muted-foreground">{surface === "playground" ? "Run agents against live Playground resources." : "Configure and run agents."}</p>
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
  const [modelCatalog, setModelCatalog] = useState<AgentModelCatalog | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(true);
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [trace, setTrace] = useState<TraceNode[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(Boolean(agent.installation_id && agent.installation_settings?.environment === "playground"));
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
  const [errorRemediation, setErrorRemediation] = useState<string | null>(null);

  const clearError = () => {
    setError(null);
    setErrorRemediation(null);
  };
  const showError = (message: string, remediation?: string) => {
    setError(message);
    setErrorRemediation(remediation ?? null);
  };

  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions[0] ?? null;
  const playgroundReady = agent.installation_settings?.environment === "playground";
  const canRun = Boolean(agent.installation_id && playgroundReady);
  const pickerModels = useMemo<AgentModel[]>(() => {
    const available = modelCatalog?.models ?? [];
    if (!modelSelection || available.some((model) => model.provider === modelSelection.provider && model.model === modelSelection.model)) return available;
    return [{ provider: modelSelection.provider, model: modelSelection.model, label: modelSelection.model, description: "Saved model is not in the current catalog.", tier: "balanced" }, ...available];
  }, [modelCatalog, modelSelection]);
  const selectedModelEntry = pickerModels.find((model) => model.provider === modelSelection?.provider && model.model === modelSelection.model)
    ?? pickerModels.find((model) => model.isWorkspaceDefault)
    ?? pickerModels[0];
  const effectiveModelSelection = selectedModelEntry
    ? { provider: selectedModelEntry.provider, model: selectedModelEntry.model }
    : modelSelection;
  const studioGraphNodes = useMemo(
    () => buildStudioGraph(selectedModelEntry?.label ?? selectedModelEntry?.model ?? "Primary model", trace),
    [selectedModelEntry?.label, selectedModelEntry?.model, trace],
  );

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
    const installationId = agent.installation_id;
    if (!canRun || !installationId) {
      setConversationLoading(false);
      return;
    }
    let cancelled = false;
    setConversationLoading(true);
    void resolvePlatformConversation(installationId)
      .then((result) => {
        if (!cancelled) applyConversation(result);
      })
      .catch((cause) => {
        if (!cancelled) showError(cause instanceof Error ? cause.message : "Unable to load Playground conversation");
      })
      .finally(() => {
        if (!cancelled) setConversationLoading(false);
      });
    return () => { cancelled = true; };
  }, [agent.installation_id, applyConversation, canRun]);

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
        setModelSelection(modelSelectionFromVersion(preferred));
      })
      .catch((cause) => {
        if (!cancelled) showError(cause instanceof Error ? cause.message : "Unable to load agent versions");
      })
      .finally(() => {
        if (!cancelled) setLoadingVersions(false);
      });
    return () => { cancelled = true; };
  }, [agent]);

  useEffect(() => {
    let cancelled = false;
    setModelCatalogLoading(true);
    void getAgentModelCatalog()
      .then((result) => {
        if (!cancelled) setModelCatalog(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setModelCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

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
    const nextVersion = versions.find((version) => version.id === versionId) ?? null;
    setSelectedVersionId(versionId);
    setInstructions(nextVersion?.instructions ?? "");
    setModelSelection(modelSelectionFromVersion(nextVersion));
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

  const runAgent = async (audioFile?: File) => {
    if (!agent.installation_id) {
      showError("This agent is not installed yet.");
      return;
    }
    if (!playgroundReady) {
      showError("This agent has no Playground installation.");
      return;
    }
    const message = input.trim();
    if ((!message && !audioFile) || running || conversationLoading) return;
    const displayInput = message || "Audio message";
    setRunning(true);
    clearError();
    setNotice(null);
    setSelectedNodeId(null);
    setTrace([{ id: "input", event: "run.received", label: "Input", detail: displayInput, status: "running", sequence: 0, data: { message: displayInput } }]);
    try {
      let targetConversationId = conversationId;
      if (!targetConversationId) {
        const created = await createPlatformConversation(agent.installation_id, {
          modelProvider: effectiveModelSelection?.provider,
          model: effectiveModelSelection?.model,
        });
        targetConversationId = created.conversation.id;
        applyConversation(created);
      }
      const controller = new AbortController();
      const accepted = audioFile
        ? await (async () => {
            const queued = await sendPlatformAudio(agent.installation_id!, {
              file: audioFile,
              conversationId: targetConversationId!,
              idempotencyKey: crypto.randomUUID(),
              context: { route: window.location.pathname, pageTitle: document.title },
            });
            const job = await waitForStudioAudioTranscriptionJob(queued.jobId, controller.signal);
            if (job.status !== "completed") throw new Error(job.errorMessage || "Audio transcription failed");
            if (!job.runId) throw new Error("Audio run was not created");
            const conversationResult = await getPlatformConversation(targetConversationId!);
            const audioMessage = [...conversationResult.messages].reverse().find(
              (item) => item.direction === "inbound" && item.content.assetId === queued.assetId && item.run_id === job.runId,
            );
            if (!audioMessage) throw new Error("Transcribed audio message was not available");
            return { conversation: conversationResult.conversation, message: audioMessage, runId: job.runId, status: "received" };
          })()
        : await sendPlatformMessage(agent.installation_id, {
            message,
            conversationId: targetConversationId,
            idempotencyKey: crypto.randomUUID(),
            ...(effectiveModelSelection ? { modelProvider: effectiveModelSelection.provider, model: effectiveModelSelection.model } : {}),
            context: { route: window.location.pathname, pageTitle: document.title },
          });
      setMessages((current) => {
        const acceptedMessage = chatMessageFromAgent(accepted.message);
        return current.some((item) => item.id === acceptedMessage.id) ? current : [...current, acceptedMessage];
      });
      setInput("");
      setActiveRunId(accepted.runId);
      addTraceEvent({ event: "run.received", data: { sequence_number: 1, run_id: accepted.runId } });
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
        const runError = result.run.error;
        throw Object.assign(new Error(runError?.userMessage || runError?.message || `Run ${result.run.status}`), {
          remediation: typeof runError?.remediation === "string" ? runError.remediation : undefined,
        });
      } else {
        setNotice(`Run ${result.run.status}`);
      }
    } catch (cause) {
      const remediation = cause instanceof Error && "remediation" in cause && typeof cause.remediation === "string" ? cause.remediation : undefined;
      showError(cause instanceof Error ? cause.message : "Agent run failed", remediation);
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
    clearError();
    try {
      await cancelAgentRun(activeRunId, "Cancelled from Playground");
      setNotice("Cancellation requested");
    } catch (cause) {
      setCancelling(false);
      showError(cause instanceof Error ? cause.message : "Unable to cancel run");
    }
  };

  const installPlayground = async () => {
    if (!agent.protected || installingPlayground) return;
    setInstallingPlayground(true);
    clearError();
    setNotice(null);
    try {
      const installation = await ensureKasiAiPlayground();
      if (installation.settings?.environment !== "playground") {
        throw new Error("Playground installation is not available yet. Restart the local Agent Platform and try again.");
      }
      router.refresh();
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to install Playground");
      setInstallingPlayground(false);
    }
  };

  const saveDraft = async (capabilityDraft?: StudioCapabilityDraft): Promise<AgentVersion | null> => {
    setSaving(true);
    clearError();
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
            ...(modelSelection ? { model: { ...(configuredSpec as AgentSpecInput).model, primary: modelSelection } } : {}),
            ...(capabilityDraft ? {
              capabilities: {
                ...((configuredSpec as AgentSpecInput).capabilities ?? {}),
                allowedTools: capabilityDraft.allowedTools,
                requiredCapabilities: capabilityDraft.requiredCapabilities,
              },
              skills: {
                ...((configuredSpec as AgentSpecInput).skills ?? {}),
                allowedSkillIds: capabilityDraft.allowedSkillIds,
              },
              extensions: {
                ...((configuredSpec as AgentSpecInput).extensions ?? {}),
                packages: capabilityDraft.extensionPackages,
                grants: capabilityDraft.extensionGrants,
              },
            } : {}),
          },
        })
        : await createAgentVersion(agent.id, {
          instructions,
          configuration: {
            ...(selectedVersion?.configuration ?? {}),
            ...(modelSelection ? { provider: modelSelection.provider, model: modelSelection.model } : {}),
          },
          policy: {
            ...(selectedVersion?.policy ?? {}),
            ...(capabilityDraft ? {
              allowedTools: capabilityDraft.allowedTools,
              requiredCapabilities: capabilityDraft.requiredCapabilities,
              extensions: {
                ...(isRecord(selectedVersion?.policy?.extensions) ? selectedVersion.policy.extensions : {}),
                packages: capabilityDraft.extensionPackages,
                grants: capabilityDraft.extensionGrants,
              },
            } : {}),
            ...(modelSelection ? {
              modelPolicy: {
                ...(isRecord(selectedVersion?.policy?.modelPolicy) ? selectedVersion.policy.modelPolicy : {}),
                version: isRecord(selectedVersion?.policy?.modelPolicy) && typeof selectedVersion.policy.modelPolicy.version === "string"
                  ? selectedVersion.policy.modelPolicy.version
                  : "hosted-agent-v1",
                primary: modelSelection,
              },
            } : {}),
          },
        });
      setVersions((current) => [next, ...current]);
      setSelectedVersionId(next.id);
      setNotice("Draft saved");
      return next;
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to save draft");
      return null;
    } finally {
      setSaving(false);
    }
  };

  const deploy = async () => {
    if (!selectedVersion) return;
    setDeploying(true);
    clearError();
    setNotice(null);
    try {
      const published = selectedVersion.status === "published" ? selectedVersion : await publishAgentVersion(agent.id, selectedVersion.id);
      if (agent.installation_id) await deployAgentInstallation(agent.installation_id, published.id, agent.installation_version_id ?? undefined);
      setVersions((current) => current.map((version) => version.id === published.id ? published : version));
      setNotice(surface === "playground" ? "Playground updated" : "Installation updated");
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to deploy version");
    } finally {
      setDeploying(false);
    }
  };

  const selectedGraphNode = studioGraphNodes.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <div className="flex min-h-[calc(100dvh-4rem)] flex-col bg-canvas">
      <header className="border-b border-border bg-card/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1760px] flex-wrap items-center gap-3">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={onBack}><ArrowLeft className="size-4" />{surface === "playground" ? "Playground" : "Studio"}</Button>
          <span className="hidden h-5 w-px bg-border sm:block" />
          <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><Bot className="size-4 shrink-0 text-primary" /><span className="truncate text-sm font-semibold text-foreground">{agent.name}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", statusClass(agent.status))}>{statusLabel(agent.status)}</span></div></div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><span className="hidden sm:inline">Version</span><select value={selectedVersionId ?? ""} onChange={(event) => selectVersion(event.target.value)} disabled={loadingVersions || !versions.length} className="h-8 max-w-36 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none focus:border-primary"><option value="">{loadingVersions ? "Loading…" : "No versions"}</option>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {version.status}</option>)}</select></label>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs text-primary"><FlaskConical className="size-3.5" />{surface === "playground" ? "Playground" : "Studio"}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfigurationOpen(true)}><SlidersHorizontal className="mr-1.5 size-3.5" />Settings</Button>
          {activeRunId ? <Button type="button" variant="outline" size="sm" onClick={() => void cancelRun()} disabled={cancelling}><X className="mr-1.5 size-3.5" />{cancelling ? "Cancelling…" : "Cancel"}</Button> : null}
          {!agent.protected ? <Button type="button" variant="outline" size="sm" onClick={() => void deploy()} disabled={deploying || !selectedVersion}><Rocket className="mr-1.5 size-3.5" />{deploying ? "Updating…" : surface === "playground" ? "Update Playground" : "Update installation"}</Button> : null}
        </div>
      </header>

      <div className="mx-auto flex min-h-0 w-full max-w-[1760px] flex-1 px-3 py-3 sm:px-5 lg:px-6">
        <div className="grid min-h-[calc(100dvh-9rem)] flex-1 overflow-hidden rounded-2xl border border-border bg-card xl:grid-cols-[minmax(330px,0.34fr)_minmax(0,0.66fr)]">
          <section className="flex min-h-[540px] min-w-0 flex-col border-b border-border xl:min-h-0 xl:border-b-0 xl:border-r">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><div><SectionEyebrow>Conversation</SectionEyebrow><h1 className="mt-1 text-sm font-semibold text-foreground">{agent.name}</h1></div><span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><MessageCircle className="size-3.5" />{conversationId ? "Ready" : conversationLoading ? "Loading" : "New"}</span></div>
            <RuntimeStatusRow telemetry={telemetry} model={selectedModelEntry} detailsOpen={telemetryDetailsOpen} onToggleDetails={() => setTelemetryDetailsOpen((current) => !current)} />
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-5">
              {conversationLoading ? <div className="flex h-full min-h-48 items-center justify-center text-xs text-muted-foreground"><LoaderCircle className="mr-2 size-4 animate-spin" />Loading conversation</div> : messages.length ? messages.map((message) => <div key={message.id} className={cn("flex", message.direction === "user" ? "justify-end" : "justify-start")}><div className={cn("max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-5", message.direction === "user" ? "rounded-br-md bg-primary text-primary-foreground" : message.direction === "system" ? "border border-border bg-muted/50 text-muted-foreground" : "rounded-bl-md bg-muted text-foreground")}>{message.text}</div></div>) : <div className="flex h-full min-h-48 flex-col items-center justify-center px-5 text-center"><MessageCircle className="size-5 text-muted-foreground" /><p className="mt-3 text-sm font-medium text-foreground">Start a conversation</p><p className="mt-1 text-xs text-muted-foreground">Send a message to run this agent.</p></div>}
              {running ? <div className="flex justify-start"><div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-3.5 py-2.5 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />Agent is running</div></div> : null}
            </div>
            {error ? <div className="mx-4 mb-3 flex items-start justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert"><div><p>{error}</p>{errorRemediation ? <p className="mt-1 text-destructive/80">{errorRemediation}</p> : null}</div><button type="button" aria-label="Dismiss error" onClick={clearError}><X className="size-4 shrink-0" /></button></div> : null}
            {notice ? <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"><Check className="size-3.5" />{notice}</div> : null}
            <AgentChatComposer
              value={input}
              onChange={setInput}
              onSubmit={() => void runAgent()}
              model={selectedModelEntry}
              models={pickerModels}
              onModelChange={(model, provider) => setModelSelection({ model, provider })}
              modelDisabled={modelCatalogLoading || !pickerModels.length}
              disabled={!canRun || conversationLoading}
              sending={running}
              onStop={() => void cancelRun()}
              onAudioReady={(file) => void runAgent(file)}
              onAudioError={showError}
              placeholder="Message this agent…"
              className="border-t border-border bg-card p-3 shadow-none"
              ariaLabel="Message agent"
            />
            {!agent.installation_id ? <p className="px-4 pb-3 text-[11px] text-amber-700 dark:text-amber-300">Agent is not installed</p> : !playgroundReady ? <div className="flex items-center justify-between gap-2 px-4 pb-3"><span className="text-[11px] text-amber-700 dark:text-amber-300">Playground installation required</span>{agent.protected && surface === "studio" ? <Button type="button" variant="outline" size="sm" className="h-7 px-2.5 text-[11px]" onClick={() => void installPlayground()} disabled={installingPlayground}>{installingPlayground ? <LoaderCircle className="mr-1.5 size-3 animate-spin" /> : <FlaskConical className="mr-1.5 size-3" />}{installingPlayground ? "Installing…" : "Install Playground"}</Button> : null}</div> : null}
          </section>

          <section className="flex min-h-[620px] min-w-0 flex-col">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><div><SectionEyebrow>Execution observatory</SectionEyebrow><h1 className="mt-1 text-sm font-semibold text-foreground">System map</h1></div><span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><CircleDot className={cn("size-3", running ? "animate-pulse text-primary" : "text-muted-foreground")} />{running ? "Run overlay" : trace.length ? "Trace ready" : "Ready"}</span></div>
            <div className="relative min-h-[560px] flex-1 overflow-auto bg-[radial-gradient(circle_at_50%_45%,color-mix(in_srgb,var(--brand)_7%,transparent),transparent_58%)]">
              <StudioSystemCanvas nodes={studioGraphNodes} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} running={running} traceCount={trace.length} />
              {selectedGraphNode ? <div className="absolute bottom-4 left-4 right-4 z-10 max-h-72 overflow-auto rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur"><button type="button" aria-label="Close node details" onClick={() => setSelectedNodeId(null)} className="absolute right-3 top-3 z-10 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button><StudioGraphInspector node={selectedGraphNode} onConfigure={() => setConfigurationOpen(true)} /></div> : null}
            </div>
          </section>
        </div>
      </div>
      {configurationOpen ? <div className="fixed inset-0 z-50" role="presentation"><button type="button" aria-label="Close settings" className="absolute inset-0 bg-black/50" onClick={() => setConfigurationOpen(false)} /><aside role="dialog" aria-modal="true" aria-labelledby="configuration-title" className="absolute inset-3 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl sm:inset-6 lg:inset-10"><StudioSettingsPrototype key={selectedVersion?.id ?? "new-version"} agent={agent} version={selectedVersion} installationId={agent.installation_id ?? null} instructions={instructions} setInstructions={setInstructions} onSave={saveDraft} saving={saving} modelCatalog={modelCatalog} modelCatalogLoading={modelCatalogLoading} modelSelection={modelSelection} setModelSelection={setModelSelection} onClose={() => setConfigurationOpen(false)} /></aside></div> : null}
    </div>
  );
}

function StudioGraphInspector({ node, onConfigure }: { node: StudioGraphNode; onConfigure: () => void }) {
  return <div><div className="border-b border-border px-4 py-3"><SectionEyebrow>Selected node</SectionEyebrow><div className="mt-1 flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary"><CircleDot className="size-3.5" /></span><h2 className="text-sm font-semibold text-foreground">{node.label}</h2><span className="ml-auto text-[10px] font-medium text-muted-foreground">{node.status}</span></div></div><div className="grid gap-4 p-4 text-[11px] sm:grid-cols-[1.2fr_1fr_1fr]"><div><SectionEyebrow>Role</SectionEyebrow><p className="mt-1 text-xs leading-5 text-muted-foreground">{node.detail}</p><p className="mt-2 font-mono text-[10px] text-muted-foreground">{node.event}</p></div><div><SectionEyebrow>Scope</SectionEyebrow><p className="mt-1 text-foreground">{node.scope ?? "—"}</p><SectionEyebrow>Provider</SectionEyebrow><p className="mt-1 text-foreground">{node.provider ?? "KasiTek runtime"}</p></div><div><SectionEyebrow>Configuration</SectionEyebrow><dl className="mt-1 space-y-1 text-muted-foreground">{Object.entries(node.data).slice(0, 3).map(([key, value]) => <div key={key} className="flex justify-between gap-3"><dt>{key}</dt><dd className="max-w-[11rem] truncate text-right text-foreground">{value}</dd></div>)}</dl>{node.configurable ? <Button type="button" variant="outline" size="sm" className="mt-3 h-7 px-2.5 text-[11px]" onClick={onConfigure}><SlidersHorizontal className="mr-1.5 size-3" />Configure</Button> : null}</div></div></div>;
}
