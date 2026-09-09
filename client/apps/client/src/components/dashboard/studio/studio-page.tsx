"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CircleDot,
  FlaskConical,
  MessageCircle,
  Plus,
  Play,
  Rocket,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  createAgentVersion,
  cancelAgentRun,
  createPlatformConversation,
  deployAgentInstallation,
  getAgentDeploymentStatus,
  preflightAgentInstallationDeployment,
  promoteAgentInstallation,
  rollbackAgentInstallation,
  ensureKasiAiPlayground,
  getAudioTranscriptionJob,
  getPlatformConversation,
  getAgentModelCatalog,
  getAgentRun,
  getAgentRunTimeline,
  ensureAgentPlayground,
  listAgentVersions,
  publishAgentVersion,
  resolvePlatformConversation,
  sendPlatformAudio,
  sendPlatformMessage,
  submitAgentUiInteraction,
  streamAgentRun,
  type AgentMessage,
  type AgentDefinition,
  type AgentJournalEvent,
  type AgentModel,
  type AgentModelCatalog,
  type AgentModelProvider,
  type AgentRuntimeTelemetry,
  type AgentDeploymentPreflight,
  type AgentDeploymentStatus,
  type AgentSpecInput,
  type AgentStreamEvent,
  type AgentVersion,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";
import { AgentChatComposer } from "@/components/dashboard/agents/agent-chat-composer";
import { AgentChatMessageList } from "@/components/dashboard/agents/agent-chat-message-list";
import { AgentChatRunStatus } from "@/components/dashboard/agents/agent-chat-run-status";
import { AgentChatSurface } from "@/components/dashboard/agents/agent-chat-surface";
import { StudioSettingsPrototype, type StudioSettingsDraft } from "@/components/dashboard/studio/studio-settings-prototype";
import { StudioSystemCanvas, type StudioGraphNode, type StudioGraphStatus } from "@/components/dashboard/studio/studio-system-canvas";
import type { AgentUiInteraction } from "@/components/dashboard/kasiai/dynamic-ui-renderer";

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

type DemoTraceStep = {
  event: string;
  label?: string;
  detail?: string;
  data?: Record<string, unknown>;
};

const demoTraceSteps: DemoTraceStep[] = [
  { event: "run.received", label: "Input", detail: "Customer asks about Friday availability", data: { channel: "web", message: "Is Friday available?" } },
  { event: "channel.accepted", label: "Channel", detail: "Web channel authenticated", data: { channel: "web", tenant: "demo" } },
  { event: "run.started", label: "Session", detail: "Durable run admitted", data: { session: "conversation-42", retry_policy: "enabled" } },
  { event: "agent.context.prepared", label: "Context", detail: "Working set composed", data: { tokens: 2840, sources: 4 } },
  { event: "memory.retrieval.completed", label: "Memory", detail: "Customer preferences retrieved", data: { facts: 3, scope: "customer" } },
  { event: "context.retrieval.completed", label: "Knowledge", detail: "Availability policy retrieved", data: { evidence: 2, source: "workspace" } },
  { event: "agent.model.completed", label: "Model", detail: "Selected availability lookup", data: { provider: "OpenAI", latency_ms: 820 } },
  { event: "agent.route.selected", label: "Router", detail: "Bookings capability selected", data: { capability: "bookings.check_availability" } },
  { event: "agent.tool.started", label: "Tool: calendar.check_availability", detail: "Checking Google Calendar", data: { name: "calendar.check_availability" } },
  { event: "agent.tool.completed", label: "Tool: calendar.check_availability", detail: "Friday has two open slots", data: { name: "calendar.check_availability", duration_ms: 420 } },
  { event: "agent.mcp.tool.started", label: "MCP: workspace.contacts", detail: "Loading customer record", data: { name: "workspace.contacts" } },
  { event: "agent.mcp.tool.completed", label: "MCP: workspace.contacts", detail: "Customer record loaded", data: { name: "workspace.contacts", duration_ms: 260 } },
  { event: "agent.skill.started", label: "Content skill", detail: "Preparing a follow-up message", data: { name: "content.follow_up" } },
  { event: "agent.skill.completed", label: "Content skill", detail: "Follow-up drafted", data: { name: "content.follow_up", platforms: "web · WhatsApp" } },
  { event: "approval.requested", label: "Approval", detail: "Waiting for send approval", data: { action: "send_follow_up", policy: "human" } },
  { event: "approval.completed", label: "Approval", detail: "Approved by workspace policy", data: { action: "send_follow_up", decision: "approved" } },
  { event: "handoff.requested", label: "Handoff", detail: "Context shared with support team", data: { target: "support", reason: "follow-up requested" } },
  { event: "handoff.completed", label: "Handoff", detail: "Support team accepted context", data: { target: "support" } },
  { event: "run.output.completed", label: "Response", detail: "Answer assembled", data: { format: "channel-aware" } },
  { event: "memory.write.completed", label: "Memory write", detail: "Useful outcome persisted", data: { facts: 1, evidence: "run-42" } },
  { event: "message.delivered", label: "Delivery", detail: "Response delivered to web", data: { channel: "web", receipt: "stored" } },
];

function demoTraceNode(step: DemoTraceStep, sequence: number): TraceNode {
  return {
    id: `demo-${sequence}-${step.event}`,
    event: step.event,
    label: step.label ?? eventLabel(step.event, step.data ?? {}),
    detail: step.detail ?? eventDetail(step.event, step.data ?? {}),
    status: eventStatus(step.event),
    sequence,
    data: { ...(step.data ?? {}), demo: true, sequence_number: sequence },
  };
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
  if (event.includes("completed") || event.includes("delivered") || event.includes("cancelled") || event.includes("expired")) return "complete";
  return "running";
}

function studioNodeStatus(node: StudioGraphNode, trace: TraceNode[]): StudioGraphStatus {
  const matching = trace.filter((traceNode) => {
    const event = traceNode.event.toLowerCase();
    const label = traceNode.label.toLowerCase();
    if (node.id === "input") return event.includes("received") || label === "input";
    if (node.id === "channel") return event.includes("channel") || label === "channel";
    if (node.id === "session") return event.includes("run.started") || event.includes("run.queued");
    if (node.id === "context") return event.includes("context");
    if (node.id === "memory-read") return event.includes("memory.retriev") || event.includes("memory.read");
    if (node.id === "memory-write") return event.includes("memory.write") || event.includes("memory.persist");
    if (node.id === "retrieval") return event.includes("retriev") || label.includes("knowledge");
    if (node.id === "model") return event.includes("model") || label === "model";
    if (node.id === "router") return event.includes("route") || event.includes("capabilit");
    if (node.id === "calendar") return label.includes("calendar") || label.includes("booking");
    if (node.id === "mcp") return event.includes("mcp") || label.includes("mcp");
    if (node.id === "content-skill") return label.includes("content") || label.includes("skill");
    if (node.id === "approval") return event.includes("approval");
    if (node.id === "handoff") return event.includes("handoff") || event.includes("human");
    if (node.id === "output") return event.includes("output") || event.includes("run.completed");
    if (node.id === "delivery") return event.includes("deliver");
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
                  <span className="hidden shrink-0 text-right text-xs text-muted-foreground sm:block"><span className="block">{agent.version_number ? `v${agent.version_number}` : "No version"}</span>{agent.installation_id ? <span className="mt-1 block">Ready</span> : null}</span>
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
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(Boolean(agent.installation_id && agent.installation_settings?.environment === "playground"));
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [demoRunning, setDemoRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<AgentRuntimeTelemetry | null>(null);
  const [telemetryDetailsOpen, setTelemetryDetailsOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [deploymentStatus, setDeploymentStatus] = useState<AgentDeploymentStatus | null>(null);
  const [deploymentStatusLoading, setDeploymentStatusLoading] = useState(false);
  const [promotionOpen, setPromotionOpen] = useState(false);
  const [promotionPreflight, setPromotionPreflight] = useState<AgentDeploymentPreflight | null>(null);
  const [promotionCandidateId, setPromotionCandidateId] = useState<string | null>(null);
  const [promotionBusy, setPromotionBusy] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const showError = (message: string, remediation?: string) => {
    toast.error(message, remediation ? { description: remediation } : undefined);
  };
  const clearError = () => undefined;

  const refreshDeploymentStatus = useCallback(async () => {
    setDeploymentStatusLoading(true);
    try {
      setDeploymentStatus(await getAgentDeploymentStatus(agent.id));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to load deployment status");
    } finally {
      setDeploymentStatusLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    void refreshDeploymentStatus();
  }, [refreshDeploymentStatus]);

  const selectedVersion = versions.find((version) => version.id === selectedVersionId) ?? versions[0] ?? null;
  const playgroundReady = agent.installation_settings?.environment === "playground";
  const canRun = Boolean(agent.installation_id && playgroundReady);
  const showPromotion = Boolean(
    deploymentStatus
      && deploymentStatus.live.installationId
      && (deploymentStatus.state === "pending"
        || selectedVersion?.id !== deploymentStatus.live.version?.versionId),
  );
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

  useEffect(() => {
    if (agent.installation_id || !agent.published_version_id) return;
    let cancelled = false;
    const installation = agent.protected
      ? ensureKasiAiPlayground()
      : ensureAgentPlayground(agent.id);
    void installation
      .then(() => {
        if (!cancelled) router.refresh();
      })
      .catch((cause) => {
        if (!cancelled) {
          showError(cause instanceof Error ? cause.message : "Unable to prepare Playground");
        }
      });
    return () => { cancelled = true; };
  }, [agent.id, agent.installation_id, agent.published_version_id, agent.protected, router]);
  const studioGraphNodes = useMemo(
    () => buildStudioGraph(selectedModelEntry?.label ?? selectedModelEntry?.model ?? "Primary model", trace),
    [selectedModelEntry?.label, selectedModelEntry?.model, trace],
  );

  const applyConversation = useCallback((result: Awaited<ReturnType<typeof resolvePlatformConversation>>) => {
    setConversationId(result.conversation.id);
    setMessages(result.messages);
  }, []);

  const refreshConversation = useCallback(async (id: string) => {
    const result = await getPlatformConversation(id);
    setConversationId(result.conversation.id);
    setMessages(result.messages);
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
    setLastRunId(null);
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

  const runDemoExecution = async () => {
    if (running || demoRunning) return;
    setDemoRunning(true);
    clearError();
    setNotice("Demo execution");
    setSelectedNodeId(null);
    setTrace([]);
    try {
      for (const [index, step] of demoTraceSteps.entries()) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, index === 0 ? 250 : 650));
        setTrace((current) => [...current, demoTraceNode(step, index + 1)]);
      }
      setNotice("Demo completed");
    } finally {
      setDemoRunning(false);
    }
  };

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
    if ((!message && !audioFile) || running || demoRunning || conversationLoading) return;
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
        return current.some((item) => item.id === accepted.message.id) ? current : [...current, accepted.message];
      });
      setInput("");
      setActiveRunId(accepted.runId);
      setLastRunId(accepted.runId);
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

  const submitUiInteraction = async (message: AgentMessage, interaction: AgentUiInteraction) => {
    if (!agent.installation_id || !conversationId || running || demoRunning) return;
    setRunning(true);
    clearError();
    setNotice(null);
    const controller = new AbortController();
    try {
      const accepted = await submitAgentUiInteraction(agent.installation_id, {
        conversationId,
        messageId: message.id,
        blockId: interaction.blockId,
        actionId: interaction.actionId,
        idempotencyKey: crypto.randomUUID(),
        ...(interaction.values ? { values: interaction.values } : {}),
        context: { route: window.location.pathname, pageTitle: document.title },
      });
      setMessages((current) => current.some((item) => item.id === accepted.message.id) ? current : [...current, accepted.message]);
      setActiveRunId(accepted.runId);
      setLastRunId(accepted.runId);
      setTrace((current) => [...current, { id: `ui-${accepted.runId}`, event: "run.received", label: "Input", detail: "Interactive result action", status: "running", sequence: current.length, data: { run_id: accepted.runId, action_id: interaction.actionId } }]);
      await streamAgentRun(accepted.runId, addTraceEvent, controller.signal);
      const result = await getAgentRun(accepted.runId);
      const timeline = await getAgentRunTimeline(accepted.runId).catch(() => null);
      setTelemetry(timeline?.telemetry ?? null);
      const runNodes = timeline?.journal?.length
        ? nodesFromJournalEvents(timeline.journal, timeline.telemetry?.revision)
        : nodesFromRunEvents(result.events);
      if (runNodes.length) setTrace(runNodes);
      await refreshConversation(conversationId);
      if (result.run.status !== "completed") {
        const runError = result.run.error;
        throw new Error(runError?.userMessage || runError?.message || `Run ${result.run.status}`);
      }
      setNotice(`Run ${result.run.status}`);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to submit this action");
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

  const saveDraft = async (settingsDraft?: StudioSettingsDraft): Promise<AgentVersion | null> => {
    setSaving(true);
    clearError();
    setNotice(null);
    try {
      const capabilityDraft = settingsDraft?.capabilities;
      const behaviorDraft = settingsDraft?.behavior;
      const memoryDraft = settingsDraft?.memory;
      const behaviorInstructions = behaviorDraft?.advancedInstructions.trim() || instructions.trim() || "Follow the configured behavior settings.";
      const retentionDays = memoryDraft ? Number(memoryDraft.retentionDays) : Number.NaN;
      const memoryPolicy = memoryDraft ? {
        mode: memoryDraft.mode,
        readableNamespaces: memoryDraft.readableNamespaces,
        writableNamespaces: memoryDraft.writableNamespaces,
        writableTypes: memoryDraft.writableTypes,
        maxRetrieved: memoryDraft.maxRetrieved,
        maxRetrievedTokens: memoryDraft.maxRetrievedTokens,
        maxWritesPerRun: memoryDraft.maxWritesPerRun,
        ...(Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 3_650 ? { retentionDays } : {}),
        allowSensitive: memoryDraft.allowSensitive,
      } : undefined;
      const configuredSpec = selectedVersion?.configuration?.agentSpec;
      const next = configuredSpec && typeof configuredSpec === "object" && !Array.isArray(configuredSpec)
        ? await createAgentVersion(agent.id, {
          spec: {
            ...(configuredSpec as AgentSpecInput),
            ...(behaviorDraft ? {
              identity: {
                ...((configuredSpec as AgentSpecInput).identity ?? {}),
                purpose: behaviorDraft.purpose.trim() || undefined,
                audience: behaviorDraft.audience,
              },
              execution: {
                ...((configuredSpec as AgentSpecInput).execution ?? {}),
                role: behaviorDraft.role,
              },
            } : {}),
            behavior: {
              ...((configuredSpec as AgentSpecInput).behavior ?? {}),
              instructions: behaviorInstructions,
              ...(behaviorDraft ? {
                tone: behaviorDraft.tone,
                responseLength: behaviorDraft.responseLength,
                initiative: behaviorDraft.initiative,
                language: behaviorDraft.language.trim() || "en",
                formatting: behaviorDraft.formatting,
                rules: behaviorDraft.rules,
                advancedInstructions: behaviorDraft.advancedInstructions.trim() || undefined,
              } : {}),
            },
            ...(memoryPolicy ? { memory: { ...((configuredSpec as AgentSpecInput).memory ?? {}), ...memoryPolicy } } : {}),
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
          instructions: behaviorInstructions,
          configuration: {
            ...(selectedVersion?.configuration ?? {}),
            ...(modelSelection ? { provider: modelSelection.provider, model: modelSelection.model } : {}),
            ...(behaviorDraft ? { behavior: { ...behaviorDraft, rules: behaviorDraft.rules } } : {}),
            ...(memoryPolicy ? { memory: memoryPolicy } : {}),
          },
          policy: {
            ...(selectedVersion?.policy ?? {}),
            ...(behaviorDraft ? { behavior: behaviorDraft } : {}),
            ...(memoryPolicy ? { memory: memoryPolicy } : {}),
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

  const preparePromotion = async () => {
    if (!selectedVersion || promotionBusy) return;
    setPromotionBusy(true);
    try {
      const candidate = selectedVersion.status === "published" ? selectedVersion : await publishAgentVersion(agent.id, selectedVersion.id);
      let latest = await getAgentDeploymentStatus(agent.id);
      if (!latest) throw new Error("Deployment status is unavailable");
      setDeploymentStatus(latest);
      const sourceInstallationId = latest.playground.installationId ?? agent.installation_id;
      if (!sourceInstallationId) throw new Error("Create a Playground installation before promoting to Live");
      let sourceVersionId = latest.playground.version?.versionId;
      if (sourceVersionId !== candidate.id) {
        await deployAgentInstallation(sourceInstallationId, candidate.id, sourceVersionId);
        latest = await getAgentDeploymentStatus(agent.id);
        if (!latest) throw new Error("Deployment status is unavailable");
        setDeploymentStatus(latest);
        sourceVersionId = latest.playground.version?.versionId;
      }
      const liveInstallationId = latest.live.installationId;
      const expectedVersionId = latest.live.version?.versionId;
      if (!liveInstallationId || !expectedVersionId || sourceVersionId !== candidate.id) throw new Error("Live promotion is not ready");
      const preflight = await preflightAgentInstallationDeployment(liveInstallationId, { versionId: candidate.id, sourceInstallationId, expectedVersionId });
      setPromotionCandidateId(candidate.id);
      setPromotionPreflight(preflight);
      setPromotionOpen(true);
      setVersions((versionsState) => versionsState.map((version) => version.id === candidate.id ? candidate : version));
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to prepare Live promotion");
    } finally {
      setPromotionBusy(false);
    }
  };

  const promoteToLive = async () => {
    if (!promotionPreflight?.ready || !promotionCandidateId || !deploymentStatus?.live.installationId || !promotionPreflight.sourceInstallationId || !promotionPreflight.current?.versionId || promotionBusy) return;
    setPromotionBusy(true);
    try {
      await promoteAgentInstallation(deploymentStatus.live.installationId, {
        versionId: promotionCandidateId,
        sourceInstallationId: promotionPreflight.sourceInstallationId,
        expectedVersionId: promotionPreflight.current.versionId,
        idempotencyKey: crypto.randomUUID(),
      });
      setPromotionOpen(false);
      setNotice("Live updated");
      await refreshDeploymentStatus();
      toast.success("Live updated");
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to promote to Live");
    } finally {
      setPromotionBusy(false);
    }
  };

  const rollbackLive = async () => {
    if (!deploymentStatus?.live.installationId || !deploymentStatus.live.version?.versionId || rollbackBusy) return;
    setRollbackBusy(true);
    try {
      await rollbackAgentInstallation(deploymentStatus.live.installationId, {
        expectedVersionId: deploymentStatus.live.version.versionId,
        targetVersionId: deploymentStatus.rollbackTarget?.versionId ?? undefined,
        idempotencyKey: crypto.randomUUID(),
      });
      setRollbackOpen(false);
      setNotice("Live rolled back");
      await refreshDeploymentStatus();
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to roll back Live");
    } finally {
      setRollbackBusy(false);
    }
  };

  const selectedGraphNode = studioGraphNodes.find((node) => node.id === selectedNodeId) ?? null;

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col overflow-hidden bg-canvas">
      <header className="border-b border-border bg-card/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1760px] flex-wrap items-center gap-3">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={onBack}><ArrowLeft className="size-4" />{surface === "playground" ? "Playground" : "Studio"}</Button>
          <span className="hidden h-5 w-px bg-border sm:block" />
          <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><Bot className="size-4 shrink-0 text-primary" /><span className="truncate text-sm font-semibold text-foreground">{agent.name}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", statusClass(agent.status))}>{statusLabel(agent.status)}</span></div></div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><span className="hidden sm:inline">Version</span><select value={selectedVersionId ?? ""} onChange={(event) => selectVersion(event.target.value)} disabled={loadingVersions || !versions.length} className="h-8 max-w-36 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none focus:border-primary"><option value="">{loadingVersions ? "Loading…" : "No versions"}</option>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {version.status}</option>)}</select></label>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs text-primary"><FlaskConical className="size-3.5" />{surface === "playground" ? "Playground" : "Studio"}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void runDemoExecution()} disabled={running || demoRunning}><Play className="mr-1.5 size-3.5" />{demoRunning ? "Demo running…" : "Demo run"}</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfigurationOpen(true)}><SlidersHorizontal className="mr-1.5 size-3.5" />Settings</Button>
          {activeRunId ? <Button type="button" variant="outline" size="sm" onClick={() => void cancelRun()} disabled={cancelling}><X className="mr-1.5 size-3.5" />{cancelling ? "Cancelling…" : "Cancel"}</Button> : null}
          {!agent.protected ? <Button type="button" variant="outline" size="sm" onClick={() => void deploy()} disabled={deploying || !selectedVersion}><Rocket className="mr-1.5 size-3.5" />{deploying ? "Updating…" : surface === "playground" ? "Update Playground" : "Update installation"}</Button> : null}
          {showPromotion ? <Button type="button" size="sm" onClick={() => void preparePromotion()} disabled={promotionBusy || deploymentStatusLoading || !selectedVersion}><Rocket className="mr-1.5 size-3.5" />{promotionBusy ? "Checking…" : "Promote to Live"}</Button> : null}
          {deploymentStatus?.rollbackTarget && deploymentStatus.live.installationId ? <Button type="button" variant="outline" size="sm" onClick={() => setRollbackOpen(true)} disabled={rollbackBusy}><ArrowLeft className="mr-1.5 size-3.5" />Rollback</Button> : null}
        </div>
      </header>

      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1760px] flex-1 px-3 py-3 sm:px-5 lg:px-6">
        <div className="grid h-full min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-card xl:grid-cols-[minmax(330px,0.34fr)_minmax(0,0.66fr)]">
          <section className="flex min-h-[540px] min-w-0 flex-col border-b border-border xl:min-h-0 xl:border-b-0 xl:border-r">
            <AgentChatSurface
              header={<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3"><div><SectionEyebrow>Conversation</SectionEyebrow><h1 className="mt-1 text-sm font-semibold text-foreground">{agent.name}</h1></div><span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><MessageCircle className="size-3.5" />{conversationId ? "Ready" : conversationLoading ? "Loading" : "New"}</span></div>}
              runtime={{ telemetry, model: selectedModelEntry, detailsOpen: telemetryDetailsOpen, onToggleDetails: () => setTelemetryDetailsOpen((current) => !current) }}
              contentClassName="space-y-3 px-4 py-5"
              statusContent={
                <>
                  <AgentChatRunStatus runId={lastRunId} progress={running ? "Agent is running" : notice ?? "Run completed"} events={trace.slice(-5).map((node) => ({ event: node.event, label: node.label }))} running={running} />
                  {notice ? <div className="mx-4 mb-3 flex shrink-0 items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300"><Check className="size-3.5" />{notice}</div> : null}
                </>
              }
              composer={<AgentChatComposer
                value={input}
                onChange={setInput}
                onSubmit={() => void runAgent()}
                model={selectedModelEntry}
                models={pickerModels}
                onModelChange={(model, provider) => setModelSelection({ model, provider })}
                modelDisabled={modelCatalogLoading || !pickerModels.length}
                disabled={!canRun || demoRunning || conversationLoading}
                sending={running}
                onStop={() => void cancelRun()}
                onAudioReady={(file) => void runAgent(file)}
                onAudioError={showError}
                placeholder="Message this agent…"
                className="border-t border-border bg-card p-3 shadow-none"
                ariaLabel="Message agent"
              />}
            >
              <AgentChatMessageList
                messages={messages}
                loading={conversationLoading}
                onUiInteraction={submitUiInteraction}
                emptyState={<div className="flex min-h-48 flex-col items-center justify-center px-5 text-center"><MessageCircle className="size-5 text-muted-foreground" /><p className="mt-3 text-sm font-medium text-foreground">Start a conversation</p><p className="mt-1 text-xs text-muted-foreground">Send a message to run this agent.</p></div>}
              />
            </AgentChatSurface>
          </section>

          <section className="flex min-h-[620px] min-w-0 flex-col xl:min-h-0">
            <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><div><SectionEyebrow>Execution observatory</SectionEyebrow><h1 className="mt-1 text-sm font-semibold text-foreground">System map</h1></div><span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><CircleDot className={cn("size-3", running || demoRunning ? "animate-pulse text-primary" : "text-muted-foreground")} />{running || demoRunning ? "Run overlay" : trace.length ? "Trace ready" : "Ready"}</span></div>
            <div className="relative min-h-[560px] min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_50%_45%,color-mix(in_srgb,var(--brand)_7%,transparent),transparent_58%)] xl:min-h-0">
              <StudioSystemCanvas nodes={studioGraphNodes} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} running={running || demoRunning} traceCount={trace.length} storageKey={`kasitek:studio-layout:${agent.id}:${selectedVersionId ?? "default"}`} />
              {selectedGraphNode ? <div className="absolute bottom-4 left-4 right-4 z-10 max-h-72 overflow-auto rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur"><button type="button" aria-label="Close node details" onClick={() => setSelectedNodeId(null)} className="absolute right-3 top-3 z-10 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button><StudioGraphInspector node={selectedGraphNode} onConfigure={() => setConfigurationOpen(true)} /></div> : null}
            </div>
          </section>
        </div>
      </div>
      <Dialog open={promotionOpen} onOpenChange={(open) => { if (!promotionBusy) setPromotionOpen(open); }}><DialogContent><DialogHeader><DialogTitle>Promote to Live</DialogTitle></DialogHeader><div className="space-y-3 text-sm"><div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"><span className="text-muted-foreground">Preflight</span><span className={cn("font-medium", promotionPreflight?.ready ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>{promotionPreflight?.status ?? "Checking"}</span></div>{promotionPreflight?.candidate ? <div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">Candidate</span><span className="font-medium text-foreground">v{promotionPreflight.candidate.versionNumber}</span></div> : null}{promotionPreflight?.current ? <div className="flex items-center justify-between gap-3 text-xs"><span className="text-muted-foreground">Current Live</span><span className="font-medium text-foreground">v{promotionPreflight.current.versionNumber}</span></div> : null}{promotionPreflight?.blockers.length ? <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">{promotionPreflight.blockers.map((blocker) => <li key={`${blocker.code}:${blocker.detail}`}>{blocker.detail}</li>)}</ul> : <p className="text-xs text-muted-foreground">The selected immutable Playground candidate will become Live for this agent.</p>}</div><DialogFooter><Button type="button" variant="ghost" onClick={() => setPromotionOpen(false)} disabled={promotionBusy}>Cancel</Button><Button type="button" onClick={() => void promoteToLive()} disabled={promotionBusy || !promotionPreflight?.ready}>{promotionBusy ? "Promoting…" : "Promote to Live"}</Button></DialogFooter></DialogContent></Dialog>
          <Dialog open={rollbackOpen} onOpenChange={(open) => { if (!rollbackBusy) setRollbackOpen(open); }}><DialogContent><DialogHeader><DialogTitle>Roll back Live?</DialogTitle></DialogHeader><p className="text-sm text-muted-foreground">Restore the previous tested Live version. Playground, conversations, memories, and active runs stay unchanged.</p><DialogFooter><Button type="button" variant="ghost" onClick={() => setRollbackOpen(false)} disabled={rollbackBusy}>Cancel</Button><Button type="button" variant="destructive" onClick={() => void rollbackLive()} disabled={rollbackBusy}>{rollbackBusy ? "Rolling back…" : "Roll back"}</Button></DialogFooter></DialogContent></Dialog>
      {configurationOpen ? <div className="fixed inset-0 z-50" role="presentation"><button type="button" aria-label="Close settings" className="absolute inset-0 bg-black/50" onClick={() => setConfigurationOpen(false)} /><aside role="dialog" aria-modal="true" aria-labelledby="configuration-title" className="absolute inset-3 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl sm:inset-6 lg:inset-10"><StudioSettingsPrototype key={selectedVersion?.id ?? "new-version"} agent={agent} version={selectedVersion} installationId={agent.installation_id ?? null} instructions={instructions} setInstructions={setInstructions} onSave={saveDraft} saving={saving} modelCatalog={modelCatalog} modelCatalogLoading={modelCatalogLoading} modelSelection={modelSelection} setModelSelection={setModelSelection} onClose={() => setConfigurationOpen(false)} /></aside></div> : null}
    </div>
  );
}

function StudioGraphInspector({ node, onConfigure }: { node: StudioGraphNode; onConfigure: () => void }) {
  return <div><div className="border-b border-border px-4 py-3"><SectionEyebrow>Selected node</SectionEyebrow><div className="mt-1 flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary"><CircleDot className="size-3.5" /></span><h2 className="text-sm font-semibold text-foreground">{node.label}</h2><span className="ml-auto text-[10px] font-medium text-muted-foreground">{node.status}</span></div></div><div className="grid gap-4 p-4 text-[11px] sm:grid-cols-[1.2fr_1fr_1fr]"><div><SectionEyebrow>Role</SectionEyebrow><p className="mt-1 text-xs leading-5 text-muted-foreground">{node.detail}</p><p className="mt-2 font-mono text-[10px] text-muted-foreground">{node.event}</p></div><div><SectionEyebrow>Scope</SectionEyebrow><p className="mt-1 text-foreground">{node.scope ?? "—"}</p><SectionEyebrow>Provider</SectionEyebrow><p className="mt-1 text-foreground">{node.provider ?? "KasiTek runtime"}</p></div><div><SectionEyebrow>Configuration</SectionEyebrow><dl className="mt-1 space-y-1 text-muted-foreground">{Object.entries(node.data).slice(0, 3).map(([key, value]) => <div key={key} className="flex justify-between gap-3"><dt>{key}</dt><dd className="max-w-[11rem] truncate text-right text-foreground">{value}</dd></div>)}</dl>{node.configurable ? <Button type="button" variant="outline" size="sm" className="mt-3 h-7 px-2.5 text-[11px]" onClick={onConfigure}><SlidersHorizontal className="mr-1.5 size-3" />Configure</Button> : null}</div></div></div>;
}
