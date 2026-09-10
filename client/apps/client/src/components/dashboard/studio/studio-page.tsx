"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  SlidersHorizontal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { toast } from "sonner";
import {
  createAgentVersion,
  cancelAgentRun,
  createPlatformConversation,
  ensureKasiAiPlayground,
  getAudioTranscriptionJob,
  getPlatformConversation,
  getAgentModelCatalog,
  getAgentRun,
  getAgentMemoryLineage,
  getAgentRunMemoryObservatory,
  getAgentRunTimeline,
  getAgentVersionEffectiveConfig,
  type AgentDeploymentStatus,
  getAgentInstallationReadiness,
  AgentRequestError,
  activeConversationRun,
  listAgentInstallationCapabilities,
  listAgentConnectionDirectory,
  listAgentInstallationRuns,
  retryAgentRun,
  ensureAgentPlayground,
  listAgentVersions,
  resolvePlatformConversation,
  sendPlatformAudio,
  sendPlatformMessage,
  submitAgentUiInteraction,
  streamAgentRun,
  type AgentMessage,
  type AgentDefinition,
  type AgentModel,
  type AgentModelCatalog,
  type AgentModelProvider,
  type AgentRuntimeTelemetry,
  type AgentRunTimeline,
  type AgentInstallationRun,
  type AgentMemoryObservatoryGraph,
  type AgentApproval,
  type AgentEffectReceipt,
  type AgentEffectiveConfigProjection,
  type AgentCapability,
  type AgentConnectionDirectoryEntry,
  type AgentReadiness,
  type AgentSpecInput,
  type AgentStreamEvent,
  type AgentVersion,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";
import { AgentChatComposer } from "@/components/dashboard/agents/agent-chat-composer";
import { AgentApprovalActions } from "@/components/dashboard/agents/agent-approval-actions";
import { AgentReconciliationActions } from "@/components/dashboard/agents/agent-reconciliation-actions";
import { AgentRunActions } from "@/components/dashboard/agents/agent-run-actions";
import { AgentChatMessageList } from "@/components/dashboard/agents/agent-chat-message-list";
import { AgentChatRunStatus } from "@/components/dashboard/agents/agent-chat-run-status";
import { AgentChatSurface } from "@/components/dashboard/agents/agent-chat-surface";
import { AgentDeploymentLifecycle } from "@/components/dashboard/agents/agent-deployment-lifecycle";
import { StudioSettingsPrototype, type StudioSettingsDraft } from "@/components/dashboard/studio/studio-settings-prototype";
import { StudioSystemCanvas, type StudioGraphNode } from "@/components/dashboard/studio/studio-system-canvas";
import { projectStudioObservatory } from "@/components/dashboard/studio/studio-observatory-projection";
import { executionEventFromStream } from "@/components/dashboard/studio/studio-execution-events";
import { applyExecutionStageEvent, createExecutionObservatoryState, type ExecutionObservatoryState, type ExecutionStageEvent } from "@/components/dashboard/studio/studio-execution-reducer";
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
  stageId?: string;
  event: string;
  label: string;
  detail: string;
  status: TraceStatus;
  sequence: number;
  data: Record<string, unknown>;
};

type StudioStreamState = "idle" | "connected" | "replaying" | "delayed" | "disconnected" | "unavailable";

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

function stageLabel(stageId?: string) {
  if (stageId === "input") return "Input";
  if (stageId === "context") return "Context";
  if (stageId === "memory-read") return "Memory";
  if (stageId === "model") return "Model";
  if (stageId === "response") return "Response";
  if (stageId === "approval") return "Approval";
  if (stageId === "handoff") return "Handoff";
  if (stageId === "session") return "Session";
  if (stageId?.startsWith("capability:")) return stageId.slice("capability:".length);
  return stageId ?? "Execution";
}

function traceNodeFromExecution(event: ExecutionStageEvent): TraceNode {
  const status: TraceStatus = event.type === "stage.failed" || event.type === "run.failed" ? "error" : event.type === "stage.waiting" ? "running" : event.type === "stage.started" || event.type === "stage.queued" || event.type === "run.admitted" ? "running" : "complete";
  const detail = event.error?.message ?? event.type;
  return {
    id: event.eventId,
    ...(event.stageId ? { stageId: event.stageId } : {}),
    event: event.type,
    label: stageLabel(event.stageId),
    detail,
    status,
    sequence: event.cursor,
    data: event.data ?? {},
  };
}

function executionEventFromRecord(
  runId: string,
  event: { id?: string; event_type?: string; payload?: Record<string, unknown>; sequence_number?: number | string },
) {
  return executionEventFromStream({
    event: event.event_type ?? "agent.event",
    data: {
      event_id: event.id,
      run_id: runId,
      sequence_number: event.sequence_number,
      payload: event.payload ?? {},
    },
  });
}

async function streamStudioRun(
  runId: string,
  onEvent: (event: AgentStreamEvent) => void,
  signal: AbortSignal,
  onState: (state: Exclude<StudioStreamState, "idle">) => void,
): Promise<void> {
  let cursor = 0;
  let retryCount = 0;
  while (!signal.aborted) {
    try {
      onState(cursor > 0 ? "replaying" : "connected");
      const result = await streamAgentRun(runId, (event) => {
        const sequence = Number(event.data.sequence_number);
        if (Number.isSafeInteger(sequence) && sequence > cursor) cursor = sequence;
        onEvent(event);
      }, signal, cursor);
      cursor = Math.max(cursor, result.lastSequence);
      if (result.terminal || signal.aborted) return;
      retryCount += 1;
      onState("delayed");
    } catch (cause) {
      if (signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) return;
      if (cause instanceof AgentRequestError && cause.status >= 400 && cause.status < 500) {
        onState("unavailable");
        throw cause;
      }
      retryCount += 1;
      onState(retryCount >= 3 ? "disconnected" : "delayed");
    }
    const delayMs = Math.min(5_000, 250 * 2 ** Math.min(retryCount, 5));
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = window.setTimeout(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      }, delayMs);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
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

function formatRunTime(value?: string) {
  if (!value) return "unknown";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(5, 16).replace("T", " ") : "unknown";
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
  const [execution, setExecution] = useState<ExecutionObservatoryState>(() => createExecutionObservatoryState());
  const [runHistory, setRunHistory] = useState<AgentInstallationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [timelineProjection, setTimelineProjection] = useState<AgentRunTimeline["projection"] | null>(null);
  const [memoryObservatory, setMemoryObservatory] = useState<AgentMemoryObservatoryGraph | null>(null);
  const [memoryLineage, setMemoryLineage] = useState<AgentMemoryObservatoryGraph | null>(null);
  const [approval, setApproval] = useState<AgentApproval | null>(null);
  const [canApprove, setCanApprove] = useState(false);
  const [deploymentStatus, setDeploymentStatus] = useState<AgentDeploymentStatus | null>(null);
  const [effectiveConfig, setEffectiveConfig] = useState<AgentEffectiveConfigProjection | null>(null);
  const [effectiveCapabilities, setEffectiveCapabilities] = useState<AgentCapability[]>([]);
  const [effectiveConnections, setEffectiveConnections] = useState<AgentConnectionDirectoryEntry[]>([]);
  const [installationReadiness, setInstallationReadiness] = useState<AgentReadiness | null>(null);
  const [effectiveConfigLoading, setEffectiveConfigLoading] = useState(false);
  const [effectiveConfigError, setEffectiveConfigError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(Boolean(agent.installation_id && agent.installation_settings?.environment === "playground"));
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [loadingVersions, setLoadingVersions] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<AgentRuntimeTelemetry | null>(null);
  const [telemetryDetailsOpen, setTelemetryDetailsOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [runStreamState, setRunStreamState] = useState<StudioStreamState>("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();
  const activeRunRef = useRef<string | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamOwnerRef = useRef<string | null>(null);
  const showError = (message: string, remediation?: string) => {
    toast.error(message, remediation ? { description: remediation } : undefined);
  };

  const upsertConversationRun = useCallback((run: NonNullable<ReturnType<typeof activeConversationRun>>) => {
    setRunHistory((current) => {
      const existing = current.find((item) => item.id === run.id);
      const next: AgentInstallationRun = {
        ...(existing ?? {}),
        id: run.id,
        status: run.status,
        organization_id: existing?.organization_id ?? "",
        installation_id: existing?.installation_id ?? agent.installation_id ?? "",
        conversation_id: run.conversation_id ?? existing?.conversation_id ?? null,
        created_at: run.created_at ?? existing?.created_at,
        updated_at: run.updated_at ?? existing?.updated_at,
      };
      return existing
        ? current.map((item) => item.id === run.id ? next : item)
        : [next, ...current].slice(0, 50);
    });
  }, [agent.installation_id]);

  const syncConversationRun = useCallback((response: Awaited<ReturnType<typeof resolvePlatformConversation>>) => {
    const activeRun = activeConversationRun(response.activeRuns);
    if (activeRun) {
      upsertConversationRun(activeRun);
      activeRunRef.current = activeRun.id;
      setActiveRunId(activeRun.id);
      setSelectedRunId(activeRun.id);
      setLastRunId(activeRun.id);
      setRunning(true);
      return activeRun;
    }
    if (activeRunRef.current) {
      activeRunRef.current = null;
      setActiveRunId(null);
      setRunning(false);
      setRunStreamState("idle");
    }
    return null;
  }, [upsertConversationRun]);

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
  const runProgress = useMemo(() => {
    if (execution.runStatus === "failed") return "Run failed";
    if (execution.runStatus === "cancelled") return "Run cancelled";
    if (execution.runStatus === "expired") return "Run expired";
    if (execution.runStatus === "completed") return "Run completed";
    const activeStage = Object.values(execution.topology).find((stage) => stage.status === "running" || stage.status === "waiting");
    if (activeStage) return `${activeStage.status === "waiting" ? "Waiting" : "Running"}: ${activeStage.label}`;
    return running ? "Agent is running" : "Ready";
  }, [execution, running]);

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
  const studioProjection = useMemo(
    () => projectStudioObservatory({
      effectiveConfig,
      capabilities: effectiveCapabilities,
      connections: effectiveConnections,
      modelLabel: selectedModelEntry?.label ?? selectedModelEntry?.model ?? "Primary model",
      execution,
      memory: memoryObservatory,
      configurationState: effectiveConfigLoading ? "loading" : effectiveConfigError ? "unavailable" : "ready",
      handoffEnabled: agent.agent_audience === "customer_service",
    }),
    [agent.agent_audience, effectiveCapabilities, effectiveConfig, effectiveConfigError, effectiveConfigLoading, effectiveConnections, execution, memoryObservatory, selectedModelEntry?.label, selectedModelEntry?.model],
  );
  const studioGraphNodes = studioProjection.nodes;
  const studioGraphEdges = studioProjection.edges;
  const visibleGraphNodes = studioGraphNodes;
  const visibleGraphEdges = studioGraphEdges;

  const applyConversation = useCallback((result: Awaited<ReturnType<typeof resolvePlatformConversation>>) => {
    setConversationId(result.conversation.id);
    setMessages(result.messages);
    syncConversationRun(result);
  }, [syncConversationRun]);

  const refreshConversation = useCallback(async (id: string) => {
    const result = await getPlatformConversation(id);
    setConversationId(result.conversation.id);
    setMessages(result.messages);
    syncConversationRun(result);
    return result;
  }, [syncConversationRun]);

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
    if (!canRun || !conversationId || !activeRunId) return;
    let cancelled = false;
    const refreshActiveRun = async () => {
      try {
        const result = await getPlatformConversation(conversationId);
        if (cancelled) return;
        setMessages(result.messages);
        syncConversationRun(result);
      } catch {
        // A transient conversation read failure should not hide an already visible run.
      }
    };
    void refreshActiveRun();
    const timer = window.setInterval(() => void refreshActiveRun(), 1_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRunId, canRun, conversationId, syncConversationRun]);

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
    if (!selectedVersionId) {
      setEffectiveConfig(null);
      setEffectiveCapabilities([]);
      setEffectiveConnections([]);
      setInstallationReadiness(null);
      setEffectiveConfigError(null);
      return;
    }
    let cancelled = false;
    setEffectiveConfigLoading(true);
    setEffectiveConfigError(null);
    setEffectiveConfig(null);
    setEffectiveCapabilities([]);
    setEffectiveConnections([]);
    setInstallationReadiness(null);
    const installationId = agent.installation_id ?? undefined;
    void Promise.allSettled([
      getAgentVersionEffectiveConfig(selectedVersionId, installationId),
      installationId ? listAgentInstallationCapabilities(installationId) : Promise.resolve({ capabilities: [] as AgentCapability[] }),
      installationId ? listAgentConnectionDirectory(installationId) : Promise.resolve({ connections: [] as AgentConnectionDirectoryEntry[] }),
      installationId ? getAgentInstallationReadiness(installationId) : Promise.resolve(null),
    ]).then(([configResult, capabilitiesResult, connectionsResult, readinessResult]) => {
      if (cancelled) return;
      if (configResult.status === "fulfilled") {
        setEffectiveConfig(configResult.value.effective);
      } else {
        setEffectiveConfig(null);
        setEffectiveConfigError(configResult.reason instanceof Error ? configResult.reason.message : "Effective configuration unavailable");
      }
      setEffectiveCapabilities(capabilitiesResult.status === "fulfilled" ? capabilitiesResult.value.capabilities : []);
      setEffectiveConnections(connectionsResult.status === "fulfilled" ? connectionsResult.value.connections : []);
      setInstallationReadiness(readinessResult.status === "fulfilled" ? readinessResult.value : null);
    }).finally(() => {
      if (!cancelled) setEffectiveConfigLoading(false);
    });
    return () => { cancelled = true; };
  }, [agent.installation_id, selectedVersionId]);

  useEffect(() => {
    const installationId = agent.installation_id;
    if (!installationId) {
      setRunHistory([]);
      setSelectedRunId(null);
      return;
    }
    let cancelled = false;
    void listAgentInstallationRuns(installationId, 50)
      .then((result) => {
        if (cancelled) return;
        setRunHistory(result.runs);
        setSelectedRunId((current) => current && result.runs.some((run) => run.id === current) ? current : result.runs[0]?.id ?? null);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [agent.installation_id]);

  useEffect(() => {
    const observedRunId = activeRunId ?? selectedRunId;
    if (!observedRunId) return;
    let cancelled = false;
    const refreshRuntimeEvidence = async () => {
      const [timelineResult, detailResult] = await Promise.allSettled([
        getAgentRunTimeline(observedRunId),
        getAgentRun(observedRunId),
      ]);
      if (cancelled) return;
      if (timelineResult.status !== "fulfilled") {
        showError("Execution timeline unavailable", "The durable run record could not be loaded.");
        return;
      }
      const timeline = timelineResult.value;
      const detail = detailResult.status === "fulfilled" ? detailResult.value : null;
      const memoryResult = await getAgentRunMemoryObservatory(observedRunId, { afterSequence: 0, limit: 200 }).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      );
      if (memoryResult.status === "rejected") {
        showError("Memory observatory unavailable", "Run timeline evidence is still available.");
      }
      const memory = memoryResult.status === "fulfilled" ? memoryResult.value : null;
      setTelemetry(timeline.telemetry ?? null);
      setTimelineProjection(timeline.projection ?? null);
      setMemoryObservatory(memory);
      setApproval(detail?.approval ?? null);
      // The standard run detail route returns the approval record but does not
      // advertise a separate capability flag. Let the durable command enforce
      // authorization and only hide the control when a route explicitly says
      // this actor cannot approve.
      setCanApprove(detail ? detail.canApprove !== false : false);
      setRunHistory((current) => {
        const existing = current.find((run) => run.id === observedRunId);
        const nextRun: AgentInstallationRun = {
          ...existing,
          ...timeline.run,
          organization_id: timeline.run.organization_id ?? existing?.organization_id ?? "",
          installation_id: timeline.run.installation_id ?? existing?.installation_id ?? agent.installation_id ?? "",
        };
        return existing
          ? current.map((run) => run.id === observedRunId ? nextRun : run)
          : [nextRun, ...current].slice(0, 50);
      });
      if (timeline.events.length && activeRunId !== observedRunId) {
        const historicalEvents = timeline.events
          .map((event) => executionEventFromRecord(observedRunId, event))
          .filter((event): event is ExecutionStageEvent => Boolean(event))
          .sort((left, right) => left.cursor - right.cursor);
        const historicalState = historicalEvents.reduce(
          (current, event) => applyExecutionStageEvent(current, event),
          createExecutionObservatoryState(),
        );
        setExecution(historicalState);
        setTrace(historicalEvents.map(traceNodeFromExecution));
      }
    };
    void refreshRuntimeEvidence();
    const timer = activeRunId
      ? window.setInterval(() => void refreshRuntimeEvidence(), 1_200)
      : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [activeRunId, agent.installation_id, selectedRunId]);

  const selectVersion = (versionId: string) => {
    const nextVersion = versions.find((version) => version.id === versionId) ?? null;
    setSelectedVersionId(versionId);
    setInstructions(nextVersion?.instructions ?? "");
    setModelSelection(modelSelectionFromVersion(nextVersion));
    setTrace([]);
    setExecution(createExecutionObservatoryState());
    setSelectedNodeId(null);
    setTelemetry(null);
    setRunStreamState("idle");
    setMemoryObservatory(null);
    setMemoryLineage(null);
    setApproval(null);
    setCanApprove(false);
    setTimelineProjection(null);
    setTelemetryDetailsOpen(false);
    setLastRunId(null);
    setSelectedRunId(null);
    setNotice(null);
  };

  const selectRun = (runId: string) => {
    if (running) return;
    setSelectedRunId(runId || null);
    setLastRunId(runId || null);
    setTrace([]);
    setExecution(createExecutionObservatoryState());
    setTelemetry(null);
    setRunStreamState("idle");
    setMemoryObservatory(null);
    setMemoryLineage(null);
    setApproval(null);
    setCanApprove(false);
    setTimelineProjection(null);
    setSelectedNodeId(null);
    setNotice(null);
  };

  const addTraceEvent = useCallback((event: AgentStreamEvent) => {
    const executionEvent = executionEventFromStream(event);
    if (!executionEvent) return;
    setExecution((current) => applyExecutionStageEvent(current, executionEvent));
    const nextNode = traceNodeFromExecution(executionEvent);
    setTrace((current) => {
      const existing = current.find((node) => node.id === nextNode.id);
      if (existing) return current.map((node) => node.id === nextNode.id ? nextNode : node);
      return [...current, nextNode].sort((left, right) => left.sequence - right.sequence);
    });
  }, []);

  useEffect(() => {
    const runId = activeRunId;
    if (!runId || streamOwnerRef.current === runId) return;
    const controller = new AbortController();
    streamAbortRef.current = controller;
    streamOwnerRef.current = runId;
    setRunStreamState("connected");
    void streamStudioRun(runId, addTraceEvent, controller.signal, setRunStreamState)
      .catch((cause) => {
        if (controller.signal.aborted) return;
        showError(cause instanceof Error ? cause.message : "Live run activity unavailable");
      })
      .finally(() => {
        if (streamOwnerRef.current !== runId) return;
        streamOwnerRef.current = null;
        streamAbortRef.current = null;
        setRunStreamState("idle");
      });
    return () => {
      controller.abort();
      if (streamOwnerRef.current === runId) {
        streamOwnerRef.current = null;
        streamAbortRef.current = null;
      }
    };
  }, [activeRunId, addTraceEvent]);

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
    setRunning(true);
    setNotice(null);
    setSelectedNodeId(null);
    setTrace([]);
    setExecution(createExecutionObservatoryState());
    let adoptedActiveRun = false;
    let acceptedRunId: string | null = null;
    let targetConversationId = conversationId;
    try {
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
      acceptedRunId = accepted.runId;
      setMessages((current) => {
        return current.some((item) => item.id === accepted.message.id) ? current : [...current, accepted.message];
      });
      setInput("");
      streamAbortRef.current = controller;
      streamOwnerRef.current = accepted.runId;
      activeRunRef.current = accepted.runId;
      setActiveRunId(accepted.runId);
      setSelectedRunId(accepted.runId);
      setLastRunId(accepted.runId);
      await streamStudioRun(accepted.runId, addTraceEvent, controller.signal, setRunStreamState);
      const result = await getAgentRun(accepted.runId);
      const timeline = await getAgentRunTimeline(accepted.runId).catch(() => null);
      setTelemetry(timeline?.telemetry ?? null);
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
      if (cause instanceof AgentRequestError && cause.status === 409 && targetConversationId) {
        try {
          const current = await getPlatformConversation(targetConversationId);
          const active = syncConversationRun(current);
          if (active) {
            adoptedActiveRun = true;
            setInput(message);
            setNotice("An agent run is already in progress.");
            return;
          }
        } catch {
          // Preserve the original conflict when the reconciliation read also fails.
        }
      }
      const remediation = cause instanceof Error && "remediation" in cause && typeof cause.remediation === "string" ? cause.remediation : undefined;
      showError(cause instanceof Error ? cause.message : "Agent run failed", remediation);
    } finally {
      if (!adoptedActiveRun) {
        setRunning(false);
        setCancelling(false);
        setRunStreamState("idle");
        if (streamOwnerRef.current === acceptedRunId) streamOwnerRef.current = null;
        streamAbortRef.current = null;
        activeRunRef.current = null;
        setActiveRunId(null);
      }
    }
  };

  const submitUiInteraction = async (message: AgentMessage, interaction: AgentUiInteraction) => {
    if (!agent.installation_id || !conversationId || running) return;
    setRunning(true);
    setNotice(null);
    setTrace([]);
    setExecution(createExecutionObservatoryState());
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
      setSelectedRunId(accepted.runId);
      setLastRunId(accepted.runId);
      await streamStudioRun(accepted.runId, addTraceEvent, controller.signal, setRunStreamState);
      const result = await getAgentRun(accepted.runId);
      const timeline = await getAgentRunTimeline(accepted.runId).catch(() => null);
      setTelemetry(timeline?.telemetry ?? null);
      await refreshConversation(conversationId);
      if (result.run.status !== "completed") {
        const runError = result.run.error;
        throw new Error(runError?.userMessage || runError?.message || `Run ${result.run.status}`);
      }
      setNotice(`Run ${result.run.status}`);
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to submit this action");
    } finally {
      setRunning(false);
      setCancelling(false);
      setRunStreamState("idle");
      setActiveRunId(null);
    }
  };

  const cancelRun = async () => {
    if (!activeRunId || cancelling) return;
    if (!await confirm({ title: "Cancel run?", description: "The durable run will be marked cancelled.", confirmLabel: "Cancel run", variant: "destructive" })) return;
    setCancelling(true);
    try {
      await cancelAgentRun(activeRunId, "Cancelled from Playground");
      setNotice("Cancellation requested");
      streamAbortRef.current?.abort();
    } catch (cause) {
      setCancelling(false);
      showError(cause instanceof Error ? cause.message : "Unable to cancel run");
    }
  };

  const retryRun = async () => {
    if (!selectedRunId || running || retrying) return;
    setRetrying(true);
    setNotice(null);
    setSelectedNodeId(null);
    setTrace([]);
    setExecution(createExecutionObservatoryState());
    try {
      const accepted = await retryAgentRun(selectedRunId);
      setConversationId(accepted.conversation.id);
      setMessages((current) => current.some((item) => item.id === accepted.message.id) ? current : [...current, accepted.message]);
      setActiveRunId(accepted.runId);
      setSelectedRunId(accepted.runId);
      setLastRunId(accepted.runId);
      const controller = new AbortController();
      await streamStudioRun(accepted.runId, addTraceEvent, controller.signal, setRunStreamState);
      const result = await getAgentRun(accepted.runId);
      await refreshConversation(accepted.conversation.id);
      if (result.run.status !== "completed") {
        const runError = result.run.error;
        throw new Error(runError?.userMessage || runError?.message || `Run ${result.run.status}`);
      }
      setNotice("Run completed");
    } catch (cause) {
      showError(cause instanceof Error ? cause.message : "Unable to retry run");
    } finally {
      setRetrying(false);
      setRunStreamState("idle");
      setActiveRunId(null);
    }
  };

  const saveDraft = async (settingsDraft?: StudioSettingsDraft): Promise<AgentVersion | null> => {
    setSaving(true);
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

  const selectedGraphNode = visibleGraphNodes.find((node) => node.id === selectedNodeId) ?? null;
  const observedRunId = activeRunId ?? selectedRunId;
  const selectedRun = runHistory.find((run) => run.id === (activeRunId ?? selectedRunId)) ?? null;
  const selectedMemoryRevisionId = selectedGraphNode?.evidence?.memory?.revisionIds[0] ?? null;

  useEffect(() => {
    if (!selectedMemoryRevisionId) {
      setMemoryLineage(null);
      return;
    }
    let cancelled = false;
    void getAgentMemoryLineage(selectedMemoryRevisionId)
      .then((lineage) => {
        if (!cancelled) setMemoryLineage(lineage);
      })
      .catch(() => {
        if (!cancelled) setMemoryLineage(null);
      });
    return () => { cancelled = true; };
  }, [selectedMemoryRevisionId]);

  return (
    <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col overflow-hidden bg-canvas">
      <header className="border-b border-border bg-card/80 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1760px] flex-wrap items-center gap-3">
          <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1.5 text-muted-foreground" onClick={onBack}><ArrowLeft className="size-4" />{surface === "playground" ? "Playground" : "Studio"}</Button>
          <span className="hidden h-5 w-px bg-border sm:block" />
          <div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><Bot className="size-4 shrink-0 text-primary" /><span className="truncate text-sm font-semibold text-foreground">{agent.name}</span><span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", statusClass(agent.status))}>{statusLabel(agent.status)}</span></div></div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground"><span className="hidden sm:inline">Version</span><select value={selectedVersionId ?? ""} onChange={(event) => selectVersion(event.target.value)} disabled={loadingVersions || !versions.length} className="h-8 max-w-36 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none focus:border-primary"><option value="">{loadingVersions ? "Loading…" : "No versions"}</option>{versions.map((version) => <option key={version.id} value={version.id}>v{version.version_number} · {version.status}</option>)}</select></label>
          {agent.installation_id ? <label className="flex items-center gap-2 text-xs text-muted-foreground"><span className="hidden sm:inline">Run</span><select value={selectedRunId ?? ""} onChange={(event) => selectRun(event.target.value)} disabled={running || !runHistory.length} className="h-8 max-w-44 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground outline-none focus:border-primary"><option value="">{runHistory.length ? "Select run" : "No runs"}</option>{runHistory.map((run) => <option key={run.id} value={run.id}>{run.status} · {formatRunTime(run.created_at)}</option>)}</select></label> : null}
          <span className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs text-primary"><FlaskConical className="size-3.5" />{surface === "playground" ? "Playground" : "Studio"}</span>
          <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px]", installationReadiness?.ready ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300" : installationReadiness ? "border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground")} title={effectiveConfig?.version.checksum ? `Candidate ${effectiveConfig.version.checksum}` : undefined}><CircleDot className="size-3" />{installationReadiness ? (installationReadiness.ready ? "Ready" : "Blocked") : effectiveConfigLoading ? "Checking" : "Unknown"}{effectiveConfig?.version ? ` · v${effectiveConfig.version.versionNumber}` : ""}</span>
          {deploymentStatus?.live.version ? <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[11px] text-muted-foreground" title={`Live candidate ${deploymentStatus.live.version.digest}`}><CircleDot className="size-3 text-status-success" />Live · v{deploymentStatus.live.version.versionNumber}</span> : null}
          <Button type="button" variant="outline" size="sm" onClick={() => setConfigurationOpen(true)}><SlidersHorizontal className="mr-1.5 size-3.5" />Settings</Button>
          {activeRunId ? <Button type="button" variant="outline" size="sm" onClick={() => void cancelRun()} disabled={cancelling}><X className="mr-1.5 size-3.5" />{cancelling ? "Cancelling…" : "Cancel"}</Button> : null}
          {!activeRunId && selectedRun && ["failed", "expired"].includes(selectedRun.status) ? <Button type="button" variant="outline" size="sm" onClick={() => void retryRun()} disabled={retrying}><ArrowRight className="mr-1.5 size-3.5" />{retrying ? "Retrying…" : "Retry"}</Button> : null}
          {selectedRun && ["awaiting_external_event", "awaiting_human"].includes(selectedRun.status) ? <AgentRunActions runId={selectedRun.id} status={selectedRun.status} waitingFor={typeof selectedRun.output?.waitingFor === "string" ? selectedRun.output.waitingFor : undefined} showCancel={!activeRunId} /> : null}
          <AgentDeploymentLifecycle agent={agent} versions={versions} selectedVersionId={selectedVersionId} onVersionsChange={setVersions} onStatusChange={setDeploymentStatus} compact />
        </div>
      </header>

      <div className="mx-auto flex h-full min-h-0 w-full max-w-[1760px] flex-1 px-3 py-3 sm:px-5 lg:px-6">
        <div className="grid h-full min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-card xl:grid-cols-[minmax(330px,0.34fr)_minmax(0,0.66fr)]">
          <section className="flex min-h-[540px] min-w-0 flex-col border-b border-border xl:min-h-0 xl:border-b-0 xl:border-r">
            <AgentChatSurface
              header={<div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3"><div><SectionEyebrow>Conversation</SectionEyebrow><h1 className="mt-1 text-sm font-semibold text-foreground">{agent.name}</h1></div><span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><MessageCircle className="size-3.5" />{conversationId ? "Ready" : conversationLoading ? "Loading" : "New"}</span></div>}
              runtime={{ telemetry, model: selectedModelEntry, detailsOpen: telemetryDetailsOpen, onToggleDetails: () => setTelemetryDetailsOpen((current) => !current) }}
              contentClassName="space-y-3 px-4 py-5"
              autoScrollKey={`${messages.length}:${running ? "running" : "idle"}`}
              statusContent={
                <>
                  <AgentChatRunStatus runId={lastRunId} progress={runProgress} events={trace.slice(-5).map((node) => ({ event: node.event, label: node.label }))} running={running} />
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
                disabled={!canRun || conversationLoading}
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
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3"><div><SectionEyebrow>Execution observatory</SectionEyebrow><h1 className="mt-1 text-sm font-semibold text-foreground">System map</h1></div><div className="flex flex-wrap items-center justify-end gap-2"><span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><CircleDot className={cn("size-3", running ? "animate-pulse text-primary" : "text-muted-foreground")} />{running ? "Live execution" : trace.length ? "Execution observed" : effectiveConfigLoading ? "Loading config" : effectiveConfigError ? "Config unavailable" : "Ready"}</span></div></div>
            <div className="relative min-h-[560px] min-w-0 flex-1 overflow-auto bg-[radial-gradient(circle_at_50%_45%,color-mix(in_srgb,var(--brand)_7%,transparent),transparent_58%)] xl:min-h-0">
              <StudioSystemCanvas nodes={visibleGraphNodes} edges={visibleGraphEdges} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} running={running} traceCount={trace.length} storageKey={`kasitek:studio-layout:${agent.id}:${selectedVersionId ?? "default"}`} />
              {selectedGraphNode ? <div className="absolute bottom-4 left-4 right-4 z-10 max-h-72 overflow-auto rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur"><button type="button" aria-label="Close node details" onClick={() => setSelectedNodeId(null)} className="absolute right-3 top-3 z-10 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button><StudioGraphInspector node={selectedGraphNode} telemetry={telemetry} memory={memoryObservatory} lineage={memoryLineage} approval={approval} canApprove={canApprove} runId={observedRunId} onApprovalDecided={(decision) => { setApproval((current) => current ? { ...current, status: decision } : current); setNotice(`Approval ${decision}`); }} onConfigure={() => setConfigurationOpen(true)} /></div> : null}
            </div>
            <StudioExecutionActivity trace={trace} nodes={visibleGraphNodes} projection={timelineProjection} run={runHistory.find((run) => run.id === (activeRunId ?? selectedRunId)) ?? null} streamState={runStreamState} onSelectNode={setSelectedNodeId} />
          </section>
        </div>
      </div>
      {configurationOpen ? <div className="fixed inset-0 z-50" role="presentation"><button type="button" aria-label="Close settings" className="absolute inset-0 bg-black/50" onClick={() => setConfigurationOpen(false)} /><aside role="dialog" aria-modal="true" aria-labelledby="configuration-title" className="absolute inset-3 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl sm:inset-6 lg:inset-10"><StudioSettingsPrototype key={selectedVersion?.id ?? "new-version"} agent={agent} version={selectedVersion} installationId={agent.installation_id ?? null} instructions={instructions} setInstructions={setInstructions} onSave={saveDraft} saving={saving} modelCatalog={modelCatalog} modelCatalogLoading={modelCatalogLoading} modelSelection={modelSelection} setModelSelection={setModelSelection} onClose={() => setConfigurationOpen(false)} /></aside></div> : null}
    </div>
  );
}

function streamStateLabel(state: StudioStreamState) {
  if (state === "connected") return "Live";
  if (state === "replaying") return "Replaying";
  if (state === "delayed") return "Delayed";
  if (state === "disconnected") return "Disconnected";
  if (state === "unavailable") return "Unavailable";
  return "Idle";
}

function StudioExecutionActivity({ trace, nodes, projection, run, streamState, onSelectNode }: { trace: TraceNode[]; nodes: StudioGraphNode[]; projection: AgentRunTimeline["projection"] | null; run: AgentInstallationRun | null; streamState: StudioStreamState; onSelectNode: (id: string) => void }) {
  const hasSequenceGap = trace.some((item, index) => index > 0 && item.sequence > trace[index - 1]!.sequence + 1);
  const failure = run?.error?.userMessage ?? run?.error?.message;
  return <div className="max-h-44 shrink-0 border-t border-border bg-card/90 px-4 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><SectionEyebrow>Live activity</SectionEyebrow><div className="flex flex-wrap items-center justify-end gap-2 text-[10px] text-muted-foreground">{run ? <span className="rounded-md border border-border/70 px-2 py-1">{run.status} · {run.trigger_type ?? "manual"}</span> : null}{streamState !== "idle" ? <span className={cn("rounded-md border px-2 py-1", streamState === "connected" ? "border-primary/30 text-primary" : streamState === "delayed" || streamState === "disconnected" ? "border-amber-500/30 text-amber-700 dark:text-amber-300" : streamState === "unavailable" ? "border-destructive/30 text-destructive" : "border-border/70")}>{streamStateLabel(streamState)}</span> : null}{projection ? <span className={cn("rounded-md border px-2 py-1", projection.freshness === "live" ? "border-primary/30 text-primary" : "border-border/70")}>{projection.freshness} · cursor {projection.cursor}</span> : null}{hasSequenceGap ? <span className="rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-amber-700 dark:text-amber-300">sequence gap</span> : null}</div></div>
    {failure ? <p className="mt-2 truncate text-[10px] text-destructive">{failure}</p> : null}
    {trace.length ? <div className="mt-2 flex max-h-24 gap-2 overflow-x-auto pb-1">
      {trace.map((item) => {
        const target = item.stageId ? nodes.find((node) => node.id === item.stageId) : undefined;
        return <button key={item.id} type="button" onClick={() => { if (target) onSelectNode(target.id); }} disabled={!target} className="group min-w-40 max-w-56 shrink-0 rounded-lg border border-border/80 bg-background/60 px-2.5 py-2 text-left transition-colors hover:border-primary/50 disabled:cursor-default disabled:opacity-70">
          <span className="flex items-center gap-2"><span className={cn("size-1.5 shrink-0 rounded-full", item.status === "error" ? "bg-destructive" : item.status === "running" ? "animate-pulse bg-primary" : "bg-emerald-500")} /><span className="truncate text-[10px] font-medium text-foreground">{item.label}</span><span className="ml-auto text-[9px] text-muted-foreground">#{item.sequence}</span></span>
          <span className="mt-1 block truncate text-[10px] text-muted-foreground">{item.detail}</span>
        </button>;
      })}
    </div> : <p className="mt-2 text-[11px] text-muted-foreground">Execution activity appears here while the agent runs.</p>}
  </div>;
}

function StudioGraphInspector({ node, telemetry, memory, lineage, approval, canApprove, runId, onApprovalDecided, onConfigure }: { node: StudioGraphNode; telemetry: AgentRuntimeTelemetry | null; memory: AgentMemoryObservatoryGraph | null; lineage: AgentMemoryObservatoryGraph | null; approval: AgentApproval | null; canApprove: boolean; runId: string | null; onApprovalDecided?: (decision: "approved" | "rejected") => void; onConfigure: () => void }) {
  const context = telemetry?.context;
  const modelAttempt = telemetry?.modelAttempt;
  const sourceEventId = node.data.event_id ?? node.evidence?.id;
  const occurredAt = node.data.occurred_at;
  const memoryEvidence = node.evidence?.memory;
  const operation = node.evidence?.operation;
  return <div>
    <StudioGraphInspectorBase node={node} telemetry={telemetry} onConfigure={onConfigure} />
    {approval && runId ? <section className="border-t border-border px-4 py-3"><SectionEyebrow>Approval</SectionEyebrow><div className="mt-2 flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium text-foreground">{approval.capability}</p><p className="mt-1 text-[10px] text-muted-foreground">{approval.status === "pending" ? `Expires ${approval.expiresAt}` : `Decision: ${approval.status}`}</p></div>{approval.status === "pending" && canApprove ? <AgentApprovalActions runId={runId} approval={approval} onDecided={(decision) => { onApprovalDecided?.(decision); }} /> : null}</div>{approval.status === "pending" && !canApprove ? <p className="mt-2 text-[10px] text-muted-foreground">Approval is required from an authorized operator.</p> : null}</section> : null}
    <section className="border-t border-border px-4 py-3">
      <SectionEyebrow>Durable evidence</SectionEyebrow>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-[10px] text-muted-foreground sm:grid-cols-2">
        <div className="flex min-w-0 justify-between gap-3"><dt>Event ID</dt><dd className="truncate font-mono text-foreground" title={sourceEventId}>{sourceEventId ?? "—"}</dd></div>
        <div className="flex justify-between gap-3"><dt>Sequence</dt><dd className="tabular-nums text-foreground">{node.evidence?.sequence ?? node.data.journal_sequence ?? "—"}</dd></div>
        <div className="flex min-w-0 justify-between gap-3"><dt>Occurred</dt><dd className="truncate font-mono text-foreground" title={occurredAt}>{occurredAt ?? "—"}</dd></div>
        {operation ? <div className="flex min-w-0 justify-between gap-3"><dt>Operation</dt><dd className="truncate font-mono text-foreground" title={operation.id}>{operation.kind} · {operation.status}</dd></div> : null}
        {operation?.attemptId ? <div className="flex min-w-0 justify-between gap-3"><dt>Attempt</dt><dd className="truncate font-mono text-foreground" title={operation.attemptId}>{operation.attemptId}</dd></div> : null}
        {operation?.receipt ? <div className="flex min-w-0 justify-between gap-3"><dt>Receipt</dt><dd className="text-foreground">{operation.receipt}</dd></div> : null}
      </dl>
      {operation?.reconciliationRequired ? <div className="mt-3 rounded-lg border border-status-attention/30 bg-status-attention-soft p-2"><p className="text-[10px] font-medium text-status-attention">Provider effect unknown</p><p className="mt-1 text-[10px] text-muted-foreground">Resolve the durable effect before retrying this operation.</p><AgentReconciliationActions effect={{ id: operation.id, status: operation.status, capability: node.label, reconciliation_required: true } satisfies AgentEffectReceipt} /></div> : null}
      {context && ["context", "memory-read", "retrieval"].includes(node.id) ? <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-muted-foreground sm:grid-cols-4"><span>Capacity <b className="ml-1 text-foreground">{context.contextWindowTokens ?? "unknown"}</b></span><span>Reserved <b className="ml-1 text-foreground">{context.reservedOutputTokens ?? "unknown"}</b></span><span>Safety <b className="ml-1 text-foreground">{context.safetyMarginTokens ?? "unknown"}</b></span><span>Budget left <b className="ml-1 text-foreground">{telemetry.runBudget.remainingTokens ?? "unknown"}</b></span><span>Input <b className="ml-1 text-foreground">{telemetry.usage.inputTokens ?? "unknown"}</b></span><span>Output <b className="ml-1 text-foreground">{telemetry.usage.outputTokens ?? "unknown"}</b></span><span>Usage basis <b className="ml-1 text-foreground">{telemetry.usage.basis}</b></span><span>Manifest <b className="ml-1 max-w-24 truncate text-foreground" title={context.manifestDigest}>{context.manifestDigest ?? "unknown"}</b></span></div> : null}
      {modelAttempt && node.id === "model" ? <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-muted-foreground sm:grid-cols-4"><span>Queue <b className="ml-1 text-foreground">{modelAttempt.queueMs !== undefined ? `${modelAttempt.queueMs} ms` : "unknown"}</b></span><span>First token <b className="ml-1 text-foreground">{modelAttempt.timeToFirstTokenMs !== undefined ? `${modelAttempt.timeToFirstTokenMs} ms` : "unknown"}</b></span><span>Turn <b className="ml-1 text-foreground">{telemetry.turn.elapsedMs !== undefined ? `${telemetry.turn.elapsedMs} ms` : "unknown"}</b></span><span>Attempts <b className="ml-1 text-foreground">{telemetry.attempts.length}</b></span></div> : null}
      {memoryEvidence ? <div className="mt-3 rounded-lg border border-border/80 bg-background/50 p-2"><SectionEyebrow>Memory observatory</SectionEyebrow><div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-muted-foreground sm:grid-cols-4"><span>Stage <b className="ml-1 text-foreground">{memoryEvidence.kind}</b></span><span>Status <b className="ml-1 text-foreground">{memoryEvidence.status}</b></span><span>Evidence <b className="ml-1 text-foreground">{memoryEvidence.evidenceCount}</b></span><span>Revisions <b className="ml-1 text-foreground">{memoryEvidence.revisionCount}</b></span><span>Sources <b className="ml-1 text-foreground">{memoryEvidence.sourceEventCount}</b></span><span>Cursor <b className="ml-1 text-foreground">{memory?.projection?.cursor ?? memory?.cursor ?? "unknown"}</b></span><span>Redaction <b className="ml-1 text-foreground">{memory?.projection?.redaction ?? "unknown"}</b></span>{memoryEvidence.errorCode ? <span>Error <b className="ml-1 text-destructive">{memoryEvidence.errorCode}</b></span> : null}</div>{lineage ? <div className="mt-2 border-t border-border/70 pt-2 text-[10px] text-muted-foreground"><span>Lineage <b className="ml-1 text-foreground">{lineage.nodes.length} nodes · {lineage.edges.length} links</b></span><span className="ml-3">{lineage.projection?.freshness ?? "unknown"} · {lineage.projection?.redaction ?? "unknown"}</span></div> : null}</div> : null}
    </section>
  </div>;
}

function StudioGraphInspectorBase({ node, telemetry, onConfigure }: { node: StudioGraphNode; telemetry: AgentRuntimeTelemetry | null; onConfigure: () => void }) {
  const context = telemetry?.context;
  const modelAttempt = telemetry?.modelAttempt;
  const showContextTelemetry = node.id === "context" || node.id === "memory-read" || node.id === "retrieval";
  const showModelTelemetry = node.id === "model";
  return <div><div className="border-b border-border px-4 py-3"><SectionEyebrow>Selected node</SectionEyebrow><div className="mt-1 flex items-center gap-2"><span className="flex size-6 items-center justify-center rounded-md bg-primary/10 text-primary"><CircleDot className="size-3.5" /></span><h2 className="text-sm font-semibold text-foreground">{node.label}</h2><span className="ml-auto text-[10px] font-medium text-muted-foreground">{node.status}</span></div></div><div className="grid gap-4 p-4 text-[11px] sm:grid-cols-[1.2fr_1fr_1fr]"><div><SectionEyebrow>Role</SectionEyebrow><p className="mt-1 text-xs leading-5 text-muted-foreground">{node.detail}</p><p className="mt-2 font-mono text-[10px] text-muted-foreground">{node.event}</p>{node.configuredNodeId ? <p className="mt-2 text-[10px] text-primary">Configured stage · {node.configuredNodeId}</p> : null}{node.activity ? <div className="mt-3 rounded-lg border border-border/80 bg-background/50 p-2"><SectionEyebrow>Observed activity</SectionEyebrow><p className="mt-1 text-[10px] text-foreground">{node.activity.count} execution {node.activity.count === 1 ? "item" : "items"} · latest #{node.activity.latest.sequence}</p><p className="mt-1 font-mono text-[9px] text-muted-foreground">{node.activity.latest.event}</p></div> : null}{node.evidence ? <div className="mt-3 rounded-lg border border-border/80 bg-background/50 p-2"><SectionEyebrow>Latest evidence</SectionEyebrow><p className="mt-1 text-[10px] text-foreground">{node.evidence.detail}</p><p className="mt-1 font-mono text-[9px] text-muted-foreground">{node.evidence.event} · #{node.evidence.sequence}</p></div> : null}</div><div><SectionEyebrow>Scope</SectionEyebrow><p className="mt-1 text-foreground">{node.scope ?? "—"}</p><SectionEyebrow>Provider</SectionEyebrow><p className="mt-1 text-foreground">{node.provider ?? "KasiTek runtime"}</p></div><div><SectionEyebrow>Configuration</SectionEyebrow><dl className="mt-1 space-y-1 text-muted-foreground">{Object.entries(node.data).slice(0, 3).map(([key, value]) => <div key={key} className="flex justify-between gap-3"><dt>{key}</dt><dd className="max-w-[11rem] truncate text-right text-foreground">{value}</dd></div>)}</dl>{node.configurable ? <Button type="button" variant="outline" size="sm" className="mt-3 h-7 px-2.5 text-[11px]" onClick={onConfigure}><SlidersHorizontal className="mr-1.5 size-3" />Configure</Button> : null}</div>{showContextTelemetry && context ? <div className="rounded-lg border border-border/80 bg-background/50 p-2 sm:col-span-3"><SectionEyebrow>Runtime context</SectionEyebrow><div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-muted-foreground sm:grid-cols-4"><span>Tokens <b className="ml-1 text-foreground">{context.tokens ?? "—"}</b></span><span>Basis <b className="ml-1 text-foreground">{context.basis}</b></span><span>Utilization <b className="ml-1 text-foreground">{context.utilizationPercent !== undefined ? `${context.utilizationPercent}%` : "—"}</b></span><span>Pressure <b className="ml-1 text-foreground">{context.pressure ?? "—"}</b></span><span>Decision <b className="ml-1 text-foreground">{context.decision ?? "—"}</b></span><span>Compactions <b className="ml-1 text-foreground">{context.compactionCount}</b></span><span>Turn <b className="ml-1 text-foreground">{telemetry.turn.status}</b></span><span>Revision <b className="ml-1 text-foreground">{telemetry.revision}</b></span></div></div> : null}{showModelTelemetry && modelAttempt ? <div className="rounded-lg border border-border/80 bg-background/50 p-2 sm:col-span-3"><SectionEyebrow>Runtime model attempt</SectionEyebrow><div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-muted-foreground sm:grid-cols-4"><span>Provider <b className="ml-1 text-foreground">{modelAttempt.provider ?? "—"}</b></span><span>Model <b className="ml-1 text-foreground">{modelAttempt.model ?? "—"}</b></span><span>Status <b className="ml-1 text-foreground">{modelAttempt.status}</b></span><span>Latency <b className="ml-1 text-foreground">{modelAttempt.latencyMs !== undefined ? `${modelAttempt.latencyMs} ms` : "—"}</b></span></div></div> : null}</div></div>;
}
