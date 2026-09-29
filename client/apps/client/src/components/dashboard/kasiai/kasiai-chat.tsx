"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Archive,
  ArrowLeft,
  Bot,
  ChevronRight,
  Copy,
  LoaderCircle,
  MessageCircle,
  MoreHorizontal,
  PanelLeft,
  Pin,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Unlink,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelAgentRun,
  activeConversationRun,
  isActiveAgentRunStatus,
  createPlatformConversation,
  disconnectKasiAiChannel,
  ensureKasiAi,
  getKasiAiHome,
  getAgentRunTimeline,
  getAudioTranscriptionJob,
  getAgentRun,
  getPlatformConversation,
  issueKasiAiWhatsappPairing,
  listKasiAiChannels,
  listWhatsappConnectionOptions,
  restoreKasiAiConversation,
  retryAgentRun,
  retryAudioTranscription,
  sendPlatformAudio,
  sendPlatformMessage,
  submitAgentUiInteraction,
  setKasiAiChannelDefault,
  setKasiAiConversationStatus,
  streamAgentRun,
  updateKasiAiConversation,
  updateKasiAiPreferences,
  AgentRequestError,
  type AgentApprovalGroup,
  type AgentChannelBinding,
  type AgentConversation,
  type AgentInstallation,
  type AgentMessage,
  type AgentRuntimeTelemetry,
  type KasiAiHome,
  type KasiAiModel,
  type KasiAiPreferences,
  type WhatsappConnectionOption,
} from "@/lib/agent-platform";
import { AgentApprovalGroupActions } from "@/components/dashboard/kasiai/agent-approval-group-actions";
import { AgentChatComposer } from "@/components/dashboard/kasiai/agent-chat-composer";
import { AgentChatMessageList, channelLabel, messageChannel, messageText } from "@/components/dashboard/kasiai/agent-chat-message-list";
import { AgentChatRunStatus } from "@/components/dashboard/kasiai/agent-chat-run-status";
import { AgentChatSurface } from "@/components/dashboard/kasiai/agent-chat-surface";
import type { AgentUiInteraction } from "@/components/dashboard/kasiai/dynamic-ui-renderer";
import { cn } from "@/lib/utils";

type View = "chat" | "library" | "settings";
type SettingsSection = "general" | "model" | "connections" | "memory";

const PANEL_WIDTH_KEY = "kasitek:kasiai-panel-width";
const LAST_CHAT_KEY = "kasitek:kasiai:last-conversation";
const DRAFT_KEY = "kasitek:kasiai:draft";
const CHAT_URL_KEY = "kasiai-chat";
const MIN_WIDTH = 360;
const MAX_WIDTH = 1500;
const EMPTY_MODELS: KasiAiModel[] = [];

type UiInteractionRequest = AgentUiInteraction & { messageId: string };
function sorted(messages: AgentMessage[]) {
  return [...messages].sort(
    (a, b) => Number(a.sequence_number) - Number(b.sequence_number),
  );
}
function mergeMessages(
  current: AgentMessage[],
  incoming: AgentMessage[],
): AgentMessage[] {
  const durable = new Map(incoming.map((message) => [message.id, message]));
  const retained = current.filter(
    (message) =>
      !message.id.startsWith("optimistic-") ||
      !incoming.some(
        (candidate) =>
          candidate.run_id &&
          candidate.direction === message.direction &&
          (messageText(candidate) === messageText(message) ||
            (typeof candidate.content.assetId === "string" &&
              candidate.content.assetId === message.content.assetId)),
      ),
  );
  return sorted([
    ...retained.map((message) => durable.get(message.id) ?? message),
    ...incoming.filter(
      (message) =>
        !retained.some((currentMessage) => currentMessage.id === message.id),
    ),
  ]);
}
function displayConversationTitle(
  conversation: AgentConversation | null,
): string {
  const title = conversation?.title?.trim();
  if (!title || /^(?:hi|hello|hey|yo|new chat)(?:[!,.?\s]+)?$/i.test(title))
    return "New chat";
  return title;
}
function dateGroup(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date > new Date(Date.now() - 7 * 86_400_000)
    ? "Previous 7 days"
    : "Older";
}
function formatError(cause: unknown, fallback: string) {
  if (!(cause instanceof AgentRequestError))
    return cause instanceof Error ? cause.message : fallback;
  if (cause.status === 503)
    return "KasiAi is temporarily unavailable. Check the Agent Platform and model provider, then retry.";
  if (cause.status === 409)
    return "KasiAi is still finishing the previous message in this chat.";
  return cause.message || fallback;
}
function panelBounds(leftOffset: number) {
  if (typeof window === "undefined") return { min: MIN_WIDTH, max: MAX_WIDTH };
  return {
    min: Math.min(MIN_WIDTH, window.innerWidth),
    max: Math.min(
      MAX_WIDTH,
      Math.max(
        MIN_WIDTH,
        window.innerWidth - (window.innerWidth >= 1024 ? leftOffset : 0),
      ),
    ),
  };
}

type GroundingSummary = {
  reviewedKnowledge?: { requested?: boolean; matchedChunks?: number };
  toolEvidence?: { authorized?: string[]; used?: string[] };
  unavailableActions?: string[];
  uncertainty?: string;
  organizationScoped?: boolean;
};

function groundingSummaryFromRun(value: unknown): GroundingSummary | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const knowledge = candidate.reviewedKnowledge;
  const tools = candidate.toolEvidence;
  return {
    organizationScoped: candidate.organizationScoped === true,
    reviewedKnowledge:
      knowledge && typeof knowledge === "object"
        ? (knowledge as GroundingSummary["reviewedKnowledge"])
        : undefined,
    toolEvidence:
      tools && typeof tools === "object"
        ? (tools as GroundingSummary["toolEvidence"])
        : undefined,
    unavailableActions: Array.isArray(candidate.unavailableActions)
      ? candidate.unavailableActions.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    uncertainty:
      typeof candidate.uncertainty === "string"
        ? candidate.uncertainty
        : undefined,
  };
}

function conversationFromUrl(): string | null {
  const value = new URL(window.location.href).searchParams.get(CHAT_URL_KEY);
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
    ? value
    : null;
}

function setConversationUrl(conversationId?: string) {
  const url = new URL(window.location.href);
  if (conversationId) url.searchParams.set(CHAT_URL_KEY, conversationId);
  else url.searchParams.delete(CHAT_URL_KEY);
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
}

const terminalRunStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
function runProgressLabel(status: string) {
  if (status === "awaiting_approval") return "Waiting for approval…";
  if (status === "awaiting_human") return "Waiting for a workspace member…";
  if (status === "awaiting_external_event")
    return "Waiting for an external event…";
  if (status === "queued" || status === "received")
    return "Run accepted; waiting to start…";
  if (status === "completed") return "Run completed";
  if (status === "failed") return "Run failed";
  if (status === "cancelled") return "Run cancelled";
  if (status === "expired") return "Run expired";
  return "KasiAi is working…";
}

function runEventLabel(event: {
  event_type?: string;
  payload?: Record<string, unknown>;
}) {
  const eventType = event.event_type ?? "";
  const name =
    typeof event.payload?.name === "string" ? event.payload.name : "";
  return eventType.includes("tool")
    ? name
      ? `Tool: ${name}`
      : "Tool activity"
    : eventType.includes("model")
      ? "Model response"
      : eventType.includes("context")
        ? "Context prepared"
        : eventType.includes("approval")
          ? "Approval required"
          : eventType.includes("failed")
            ? "Run failed"
            : eventType.includes("completed")
              ? "Run completed"
              : eventType.replace(/^agent\./, "");
}

function pauseForRunPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
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

async function waitForAudioTranscriptionJob(
  jobId: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof getAudioTranscriptionJob>>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const job = await getAudioTranscriptionJob(jobId);
      if (["completed", "failed", "deleted"].includes(job.status)) return job;
    } catch {
      // Keep polling; the job remains durable server-side.
    }
    await pauseForRunPoll(signal);
  }
  throw new Error("Audio transcription is taking longer than expected");
}

async function waitForRunTerminal(
  runId: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof getAgentRun>>["run"] | null> {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const { run } = await getAgentRun(runId);
      if (terminalRunStatuses.has(run.status)) return run;
    } catch {
      // The run remains durable server-side; keep polling instead of treating a transport blip as a failed chat.
    }
    await pauseForRunPoll(signal);
  }
  return null;
}

export function KasiAiChat({
  open,
  onOpenChange,
  leftOffset = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leftOffset?: number;
}) {
  const pathname = usePathname() ?? "";
  const { confirm, prompt } = useConfirmationDialog();
  const [installation, setInstallation] = useState<AgentInstallation | null>(
    null,
  );
  const [home, setHome] = useState<KasiAiHome | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(
    null,
  );
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [view, setView] = useState<View>("chat");
  const [navigationExpanded, setNavigationExpanded] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [draft, setDraft] = useState("");
  const [channelFilter, setChannelFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [runtimeTelemetry, setRuntimeTelemetry] = useState<AgentRuntimeTelemetry | null>(null);
  const [runtimeDetailsOpen, setRuntimeDetailsOpen] = useState(false);
  const [runProgress, setRunProgress] = useState("Preparing request…");
  const [runEvents, setRunEvents] = useState<
    Array<{ event: string; label: string }>
  >([]);
  const [runStatuses, setRunStatuses] = useState<Record<string, string>>({});
  const [pendingApproval, setPendingApproval] = useState<{
    runId: string;
    approvalGroup: AgentApprovalGroup;
    canApprove: boolean;
  } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [groundingSummary, setGroundingSummary] =
    useState<GroundingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audioRetryJobId, setAudioRetryJobId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [width, setWidth] = useState(470);
  const [resizing, setResizing] = useState(false);
  const [channels, setChannels] = useState<AgentChannelBinding[]>([]);
  const [whatsappConnections, setWhatsappConnections] = useState<
    WhatsappConnectionOption[]
  >([]);
  const [selectedWhatsapp, setSelectedWhatsapp] = useState("");
  const [pairing, setPairing] = useState<{
    token: string;
    expiresAt: string;
  } | null>(null);
  const [preferences, setPreferences] = useState<KasiAiPreferences | null>(
    null,
  );
  const [initialised, setInitialised] = useState(false);
  const streamAbort = useRef<AbortController | null>(null);
  const sendLocked = useRef(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const mobileNavigationPanelRef = useRef<HTMLDivElement | null>(null);
  const mobileNavigationTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavigationWasOpenRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const conversationSelection = useRef(0);
  const runStatusesRef = useRef<Record<string, string>>({});
  const activeRunIdRef = useRef<string | null>(null);
  const cancellationRequestedRun = useRef<string | null>(null);

  const models = home?.models ?? EMPTY_MODELS;
  const activeConversations = home?.conversations ?? [];
  const archivedConversations = home?.archivedConversations ?? [];
  const isArchivedChat = conversation?.status === "archived";
  const effectiveModel = useMemo(() => {
    if (conversation?.model_provider && conversation.model)
      return {
        provider: conversation.model_provider,
        model: conversation.model,
      };
    if (preferences?.default_model_provider && preferences.default_model)
      return {
        provider: preferences.default_model_provider,
        model: preferences.default_model,
      };
    return models[0]
      ? { provider: models[0].provider, model: models[0].model }
      : null;
  }, [conversation, models, preferences]);
  const activeModel =
    models.find(
      (entry) =>
        entry.provider === effectiveModel?.provider &&
        entry.model === effectiveModel?.model,
    ) ?? models[0];

  useEffect(() => {
    activeRunIdRef.current = activeRunId;
  }, [activeRunId]);

  useEffect(() => {
    const runId = activeRunId ?? lastRunId;
    if (!runId) {
      setRuntimeTelemetry(null);
      return;
    }
    let cancelled = false;
    const refreshRuntimeTelemetry = async () => {
      const timeline = await getAgentRunTimeline(runId).catch(() => null);
      if (!cancelled) setRuntimeTelemetry(timeline?.telemetry ?? null);
    };
    void refreshRuntimeTelemetry();
    if (!activeRunId) return () => { cancelled = true; };
    const timer = window.setInterval(() => { void refreshRuntimeTelemetry(); }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRunId, lastRunId]);

  const recordRunStatus = useCallback((runId: string, status: string) => {
    runStatusesRef.current = { ...runStatusesRef.current, [runId]: status };
    setRunStatuses((current) =>
      current[runId] === status ? current : { ...current, [runId]: status },
    );
  }, []);

  const refreshRunStatuses = useCallback(
    async (items: AgentMessage[], additionalRunIds: string[] = []) => {
      const runIds = Array.from(
        new Set([
          ...items
            .map((message) => message.run_id)
            .filter((runId): runId is string => Boolean(runId)),
          ...additionalRunIds.filter((runId): runId is string =>
            Boolean(runId),
          ),
        ]),
      );
      const pending = runIds.filter(
        (runId) =>
          !["completed", "failed", "cancelled", "expired"].includes(
            runStatusesRef.current[runId] ?? "",
          ),
      );
      if (!pending.length) return [];
      const results = await Promise.all(
        pending.map(async (runId) => {
          try {
            const result = await getAgentRun(runId);
            return {
              runId,
              status: result.run.status,
              approvalGroup: result.approvalGroup,
              canApprove: result.canApprove !== false,
              events: result.events,
            };
          } catch {
            return null;
          }
        }),
      );
      results.forEach((result) => {
        if (!result) return;
        recordRunStatus(result.runId, result.status);
        const active = isActiveAgentRunStatus(result.status);
        const cancellationRequested = cancellationRequestedRun.current === result.runId;
        if (cancellationRequested && active) {
          activeRunIdRef.current = result.runId;
          setActiveRunId(result.runId);
          setLastRunId(result.runId);
          setRunProgress("Cancellation requested…");
          setSending(true);
        } else if (
          activeRunIdRef.current === result.runId ||
          (active && activeRunIdRef.current === null)
        ) {
          if (activeRunIdRef.current === null) {
            activeRunIdRef.current = result.runId;
            setActiveRunId(result.runId);
          }
          setLastRunId(result.runId);
          setRunProgress(runProgressLabel(result.status));
          if (active) {
            setSending(true);
          } else {
            setSending(false);
            setActiveRunId(null);
            activeRunIdRef.current = null;
          }
          if (result.events.length) {
            setRunEvents(
              result.events
                .slice(-5)
                .map((event) => ({
                  event: event.event_type ?? "",
                  label: runEventLabel(event),
                })),
            );
          }
        }
        if (cancellationRequested && !active) {
          cancellationRequestedRun.current = null;
        }
        if (
          result.status === "awaiting_approval" &&
          result.approvalGroup?.status === "pending"
        ) {
          setPendingApproval({
            runId: result.runId,
            approvalGroup: result.approvalGroup,
            canApprove: result.canApprove,
          });
        } else if (result.status !== "awaiting_approval") {
          setPendingApproval((current) =>
            current?.runId === result.runId ? null : current,
          );
        }
      });
      return results.filter(
        (result): result is NonNullable<typeof result> => result !== null,
      );
    },
    [recordRunStatus],
  );

  const refreshHome = useCallback(async (installationId: string) => {
    const response = await getKasiAiHome(installationId);
    setHome(response);
    setPreferences(response.preferences);
    const [channelResponse, whatsapp] = await Promise.all([
      listKasiAiChannels(installationId),
      listWhatsappConnectionOptions().catch(() => ({ connections: [] })),
    ]);
    setChannels(channelResponse.bindings);
    setWhatsappConnections(whatsapp.connections);
    setSelectedWhatsapp(
      (current) => current || whatsapp.connections[0]?.id || "",
    );
    return response;
  }, []);

  const loadConversation = useCallback(
    async (id: string) => {
      const selection = ++conversationSelection.current;
      streamAbort.current?.abort();
      streamAbort.current = null;
      activeRunIdRef.current = null;
      cancellationRequestedRun.current = null;
      setSending(false);
      setActiveRunId(null);
      setPendingApproval(null);
      setError(null);
      setAudioRetryJobId(null);
      const result = await getPlatformConversation(id);
      if (selection !== conversationSelection.current) return;
      setConversation(result.conversation);
      setMessages(sorted(result.messages));
      setHasMore(Boolean(result.hasMore));
      setNextBefore(result.nextBefore ?? null);
      runStatusesRef.current = {};
      setRunStatuses({});
      const refreshedRuns = await refreshRunStatuses(
        result.messages,
        result.activeRuns?.map((run) => run.id) ?? [],
      );
      if (selection !== conversationSelection.current) return;
      const active = refreshedRuns.find((run) => isActiveAgentRunStatus(run.status));
      if (active) {
        activeRunIdRef.current = active.runId;
        setActiveRunId(active.runId);
        setLastRunId(active.runId);
        setSending(true);
        setRunProgress(runProgressLabel(active.status));
        setRunEvents(
          active.events
            .slice(-5)
            .map((event) => ({
              event: event.event_type ?? "",
              label: runEventLabel(event),
            })),
        );
      } else {
        setActiveRunId(null);
        setLastRunId(null);
        setSending(false);
        setRunEvents([]);
        setRunProgress("Preparing request…");
      }
      setChannelFilter("all");
      setView("chat");
      window.localStorage.setItem(LAST_CHAT_KEY, id);
      setConversationUrl(id);
    },
    [refreshRunStatuses],
  );

  useEffect(() => {
    if (open || !conversationFromUrl()) return;
    onOpenChange(true);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open || initialised) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const installed = await ensureKasiAi();
        if (cancelled) return;
        setInstallation(installed);
        await refreshHome(installed.id);
        if (cancelled) return;
        const linkedConversation = conversationFromUrl();
        if (linkedConversation) await loadConversation(linkedConversation);
        else {
          conversationSelection.current += 1;
          activeRunIdRef.current = null;
          setConversation(null);
          setMessages([]);
          setHasMore(false);
          setNextBefore(null);
          setPendingApproval(null);
          setAudioRetryJobId(null);
          runStatusesRef.current = {};
          setRunStatuses({});
          setChannelFilter("all");
          window.localStorage.removeItem(LAST_CHAT_KEY);
        }
        setDraft(window.localStorage.getItem(DRAFT_KEY) ?? "");
        setInitialised(true);
      } catch (cause) {
        if (!cancelled) setError(formatError(cause, "Unable to open KasiAi"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialised, loadConversation, open, refreshHome]);

  useEffect(() => {
    if (open) return;
    conversationSelection.current += 1;
    activeRunIdRef.current = null;
    cancellationRequestedRun.current = null;
    setInitialised(false);
    streamAbort.current?.abort();
    setConversation(null);
    setMessages([]);
    setHasMore(false);
    setNextBefore(null);
    setPendingApproval(null);
    setAudioRetryJobId(null);
    setChannelFilter("all");
    setLastRunId(null);
    setGroundingSummary(null);
    setRunProgress("Preparing request…");
  }, [open]);
  useEffect(() => {
    if (!open) {
      setMobileNavigationOpen(false);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous && document.contains(previous)) previous.focus();
      return;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    if (!mobileNavigationOpen) {
      if (mobileNavigationWasOpenRef.current) {
        mobileNavigationWasOpenRef.current = false;
        mobileNavigationTriggerRef.current?.focus();
      }
      return;
    }
    mobileNavigationWasOpenRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      mobileNavigationPanelRef.current
        ?.querySelector<HTMLButtonElement>("button")
        ?.focus();
    });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavigationOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [mobileNavigationOpen]);
  useEffect(() => {
    if (!pairing || !installation) return;
    const timer = window.setInterval(() => {
      void refreshHome(installation.id)
        .then(() => listKasiAiChannels(installation.id))
        .then((result) => {
          if (
            result.bindings.some(
              (binding) =>
                binding.channel_type === "whatsapp" &&
                binding.status === "active",
            )
          )
            setPairing(null);
        })
        .catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [installation, pairing, refreshHome]);
  useEffect(() => {
    window.localStorage.setItem(DRAFT_KEY, draft);
  }, [draft]);
  const polledConversationId = conversation?.id;
  useEffect(() => {
    if (!open || !polledConversationId || document.visibilityState === "hidden")
      return;
    let cancelled = false;
    const conversationId = polledConversationId;
    const selection = conversationSelection.current;
    const timer = window.setInterval(
      () =>
        void getPlatformConversation(conversationId, { limit: 100 })
          .then((result) => {
            if (cancelled || selection !== conversationSelection.current)
              return;
            setConversation((current) =>
              current?.id === conversationId ? result.conversation : current,
            );
            setMessages((current) => mergeMessages(current, result.messages));
            void refreshRunStatuses(
              result.messages,
              result.activeRuns?.map((run) => run.id) ?? [],
            );
          })
          .catch(() => undefined),
      4_000,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, polledConversationId, refreshRunStatuses]);
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved)) {
      const bounds = panelBounds(leftOffset);
      setWidth(Math.min(bounds.max, Math.max(bounds.min, saved)));
    }
  }, [leftOffset]);

  const newChat = () => {
    conversationSelection.current += 1;
    streamAbort.current?.abort();
    streamAbort.current = null;
    activeRunIdRef.current = null;
    setConversation(null);
    setMessages([]);
    setHasMore(false);
    setNextBefore(null);
    setDraft("");
    setEditingMessageId(null);
    setPendingApproval(null);
    setChannelFilter("all");
    setView("chat");
    sendLocked.current = false;
    setSending(false);
    setActiveRunId(null);
    setLastRunId(null);
    setGroundingSummary(null);
    setAudioRetryJobId(null);
    setRunProgress("Preparing request…");
    setRunEvents([]);
    runStatusesRef.current = {};
    setRunStatuses({});
    setError(null);
    window.localStorage.removeItem(LAST_CHAT_KEY);
    setConversationUrl();
  };
  const close = () => {
    newChat();
    setInitialised(false);
    onOpenChange(false);
  };
  const send = async (
    suggestion?: string,
    retryRunId?: string,
    audioFile?: File,
    uiInteraction?: UiInteractionRequest,
  ) => {
    const text = audioFile ? "" : (suggestion ?? draft).trim();
    if ((!text && !audioFile && !uiInteraction) || !installation || sending || sendLocked.current || cancellationRequestedRun.current)
      return;
    sendLocked.current = true;
    const selection = conversationSelection.current;
    const targetConversation = conversation;
    setDraft("");
    setEditingMessageId(null);
    setPendingApproval(null);
    setError(null);
    setAudioRetryJobId(null);
    setSending(true);
    let audioJobId: string | null = null;
    let adoptedActiveRun = false;
    const optimistic: AgentMessage | null = retryRunId || uiInteraction
      ? null
      : {
          id: `optimistic-${crypto.randomUUID()}`,
          conversation_id: targetConversation?.id ?? "new",
          direction: "inbound",
          message_type: audioFile ? "attachment" : "text",
          content: audioFile
            ? { text: "Audio message", mediaKind: "audio" }
            : { text },
          sequence_number: Number.MAX_SAFE_INTEGER,
          created_at: new Date().toISOString(),
        };
    if (optimistic) setMessages((items) => [...items, optimistic]);
    let acceptedRunId: string | null = null;
    const recordDisplayedRunStatus = (runId: string, status: string) => {
      recordRunStatus(runId, status);
      if (retryRunId && retryRunId !== runId) {
        recordRunStatus(retryRunId, status);
      }
    };
    const controller = new AbortController();
    streamAbort.current = controller;
    try {
      const accepted = retryRunId
        ? await retryAgentRun(retryRunId)
        : uiInteraction
          ? await submitAgentUiInteraction(installation.id, {
              conversationId: targetConversation?.id ?? "",
              messageId: uiInteraction.messageId,
              blockId: uiInteraction.blockId,
              actionId: uiInteraction.actionId,
              idempotencyKey: crypto.randomUUID(),
              ...(uiInteraction.values ? { values: uiInteraction.values } : {}),
              context: {
                route: window.location.pathname,
                pageTitle: document.title,
              },
            })
        : audioFile
          ? await (async () => {
              const audioConversation = targetConversation
                ? { conversation: targetConversation }
                : await createPlatformConversation(installation.id, {
                    modelProvider: effectiveModel?.provider,
                    model: effectiveModel?.model,
                  });
              setRunProgress("Uploading audio…");
              const queued = await sendPlatformAudio(installation.id, {
                file: audioFile,
                idempotencyKey: crypto.randomUUID(),
                conversationId: audioConversation.conversation.id,
                context: {
                  route: window.location.pathname,
                  pageTitle: document.title,
                },
              });
              audioJobId = queued.jobId;
              setConversation(audioConversation.conversation);
              window.localStorage.setItem(LAST_CHAT_KEY, audioConversation.conversation.id);
              setConversationUrl(audioConversation.conversation.id);
              if (optimistic) {
                setMessages((current) =>
                  current.map((message) =>
                    message.id === optimistic.id
                      ? { ...message, conversation_id: audioConversation.conversation.id, content: { ...message.content, assetId: queued.assetId, transcription: { status: "queued", provider: "elevenlabs" } } }
                      : message,
                  ),
                );
              }
              setRunProgress("Transcribing audio…");
              setRunEvents([{ event: "audio.transcription", label: "Transcribing audio" }]);
              const job = await waitForAudioTranscriptionJob(queued.jobId, controller.signal);
              if (job.status !== "completed") {
                setAudioRetryJobId(job.jobId);
                throw new Error(job.errorMessage || "Audio transcription failed");
              }
              if (!job.runId) throw new Error("Audio run was not created");
              const conversationResult = await getPlatformConversation(audioConversation.conversation.id);
              const audioMessage = [...conversationResult.messages].reverse().find(
                (message) => message.direction === "inbound" && message.content.assetId === queued.assetId && message.run_id === job.runId,
              );
              if (!audioMessage) throw new Error("Transcribed audio message was not available");
              return {
                conversation: conversationResult.conversation,
                message: audioMessage,
                runId: job.runId,
                status: "received",
              };
            })()
          : await sendPlatformMessage(installation.id, {
              message: text,
              idempotencyKey: crypto.randomUUID(),
              conversationId: targetConversation?.id,
              createNew: !targetConversation,
              modelProvider: !targetConversation
                ? effectiveModel?.provider
                : undefined,
              model: !targetConversation ? effectiveModel?.model : undefined,
              context: {
                route: window.location.pathname,
                pageTitle: document.title,
              },
            });
      if (selection !== conversationSelection.current) return;
      setMessages((current) =>
        mergeMessages(
          optimistic
            ? current.filter((message) => message.id !== optimistic.id)
            : current,
          [accepted.message],
        ),
      );
      setConversation(accepted.conversation);
      window.localStorage.setItem(LAST_CHAT_KEY, accepted.conversation.id);
      setConversationUrl(accepted.conversation.id);
      acceptedRunId = accepted.runId;
      recordDisplayedRunStatus(accepted.runId, accepted.status || "received");
      activeRunIdRef.current = accepted.runId;
      setActiveRunId(accepted.runId);
      setLastRunId(accepted.runId);
      setRunProgress("Run accepted; building context…");
      setRunEvents([{ event: "run.received", label: "Run accepted" }]);
      let cursor = 0;
      let terminal = false;
      for (let attempt = 0; attempt < 3 && !terminal; attempt += 1) {
        try {
          const streamed = await streamAgentRun(
            accepted.runId,
            (event) => {
              const sequence = Number(event.data.sequence_number);
              if (Number.isSafeInteger(sequence))
                cursor = Math.max(cursor, sequence);
              const name =
                typeof event.data.name === "string" ? event.data.name : "";
              const label = event.event.includes("tool")
                ? name
                  ? `Tool: ${name}`
                  : "Tool activity"
                : event.event.includes("model")
                  ? "Model response"
                  : event.event.includes("context")
                    ? "Context prepared"
                    : event.event.includes("approval")
                      ? "Approval required"
                      : event.event.includes("failed")
                        ? "Run failed"
                        : event.event.includes("completed")
                          ? "Run completed"
                          : event.event.replace(/^agent\./, "");
              setRunEvents((current) => [
                ...current
                  .filter(
                    (entry) =>
                      entry.event !== event.event || entry.label !== label,
                  )
                  .slice(-4),
                { event: event.event, label },
              ]);
              if (event.event.includes("tool"))
                setRunProgress(
                  name
                    ? `Tool activity: ${name}`
                    : "Tool activity in progress…",
                );
              else if (event.event.includes("model"))
                setRunProgress("Model response in progress…");
              else if (event.event.includes("context"))
                setRunProgress("Context prepared; starting model…");
              else if (event.event.includes("approval"))
                setRunProgress("Waiting for approval…");
              else if (event.event.includes("failed"))
                setRunProgress("Run failed");
              else if (event.event.includes("completed"))
                setRunProgress("Run completed");
              if (event.event.includes("approval")) {
                void getAgentRun(accepted.runId)
                  .then((result) => {
                    if (selection !== conversationSelection.current) return;
                    recordDisplayedRunStatus(accepted.runId, result.run.status);
                    if (
                      result.run.status === "awaiting_approval" &&
                      result.approvalGroup?.status === "pending"
                    ) {
                      setPendingApproval({
                        runId: accepted.runId,
                        approvalGroup: result.approvalGroup,
                        canApprove: result.canApprove !== false,
                      });
                    }
                  })
                  .catch(() => undefined);
              }
            },
            controller.signal,
            cursor,
          );
          cursor = streamed.lastSequence;
          terminal = streamed.terminal;
        } catch (streamError) {
          if (
            streamError instanceof DOMException &&
            streamError.name === "AbortError"
          )
            throw streamError;
          break;
        }
      }
      let terminalRun: Awaited<ReturnType<typeof getAgentRun>>["run"] | null =
        null;
      try {
        terminalRun = terminal
          ? (await getAgentRun(accepted.runId)).run
          : await waitForRunTerminal(accepted.runId, controller.signal);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError")
          throw cause;
      }
      if (terminalRun && terminalRun.status !== "completed") {
        activeRunIdRef.current = null;
        setPendingApproval(null);
        recordDisplayedRunStatus(accepted.runId, terminalRun.status);
        setRunProgress(`Run ${terminalRun.status.replaceAll("_", " ")}`);
        throw new Error(
          terminalRun.error?.message ||
            "KasiAi could not complete this request",
        );
      }
      if (terminalRun?.status === "completed") {
        activeRunIdRef.current = null;
        setPendingApproval(null);
        recordDisplayedRunStatus(accepted.runId, terminalRun.status);
        setRunProgress("Run completed");
        setGroundingSummary(
          groundingSummaryFromRun(terminalRun.output?.provenance),
        );
      }
      try {
        const [result] = await Promise.all([
          getPlatformConversation(accepted.conversation.id),
          refreshHome(installation.id),
        ]);
        if (selection !== conversationSelection.current) return;
        setConversation(result.conversation);
        setMessages((current) => mergeMessages(current, result.messages));
        setHasMore(Boolean(result.hasMore));
        setNextBefore(result.nextBefore ?? null);
      } catch {
        // Conversation polling will reconcile a completed response once the connection is available again.
      }
    } catch (cause) {
      if (selection === conversationSelection.current) {
        if (cause instanceof AgentRequestError && cause.status === 409 && targetConversation?.id) {
          try {
            const current = await getPlatformConversation(targetConversation.id);
            const activeRun = activeConversationRun(current.activeRuns);
            if (activeRun) {
              setConversation(current.conversation);
              setMessages((items) => mergeMessages(items.filter((item) => item.id !== optimistic?.id), current.messages));
              await refreshRunStatuses(current.messages, [activeRun.id]);
              activeRunIdRef.current = activeRun.id;
              setActiveRunId(activeRun.id);
              setLastRunId(activeRun.id);
              setSending(true);
              setRunProgress(runProgressLabel(activeRun.status));
              adoptedActiveRun = true;
              setError(null);
            }
          } catch {
            // Preserve the original conflict when the reconciliation read also fails.
          }
        }
        setMessages((current) =>
          optimistic
            ? current.filter((message) => message.id !== optimistic.id)
            : current,
        );
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          if (acceptedRunId) {
            recordDisplayedRunStatus(acceptedRunId, "failed");
            setPendingApproval(null);
          }
          if (!retryRunId) setDraft(text);
          if (!audioJobId) setAudioRetryJobId(null);
          if (!adoptedActiveRun) setError(formatError(cause, "KasiAi could not complete this request"));
        }
      }
    } finally {
      if (selection === conversationSelection.current) {
        sendLocked.current = false;
        if (!adoptedActiveRun) {
          streamAbort.current = null;
          if (cancellationRequestedRun.current !== acceptedRunId) {
            activeRunIdRef.current = null;
            setActiveRunId(null);
            setSending(false);
          }
        }
      }
    }
  };
  const sendAudio = (file: File) => {
    void send(undefined, undefined, file);
  };
  const retryAudio = async () => {
    const jobId = audioRetryJobId;
    if (!jobId || sending) return;
    const selection = conversationSelection.current;
    const controller = new AbortController();
    sendLocked.current = true;
    streamAbort.current = controller;
    setError(null);
    setSending(true);
    setRunProgress("Retrying audio transcription…");
    setRunEvents([
      { event: "audio.transcription.retry", label: "Retrying audio transcription" },
    ]);
    try {
      await retryAudioTranscription(jobId);
      const job = await waitForAudioTranscriptionJob(jobId, controller.signal);
      if (job.status !== "completed") {
        throw new Error(job.errorMessage || "Audio transcription failed");
      }
      if (selection !== conversationSelection.current) return;
      setAudioRetryJobId(null);
      if (job.conversationId) {
        await loadConversation(job.conversationId);
      } else if (conversation) {
        const result = await getPlatformConversation(conversation.id);
        setConversation(result.conversation);
        setMessages((current) => mergeMessages(current, result.messages));
      }
      setRunProgress("Audio transcription completed");
    } catch (cause) {
      if (
        selection === conversationSelection.current &&
        !(cause instanceof DOMException && cause.name === "AbortError")
      ) {
        setError(formatError(cause, "Audio transcription failed"));
      }
    } finally {
      if (selection === conversationSelection.current) {
        sendLocked.current = false;
        streamAbort.current = null;
        setSending(false);
      }
    }
  };
  const editMessage = (message: AgentMessage) => {
    setEditingMessageId(message.id);
    setDraft(messageText(message));
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.select();
    });
  };
  const copyMessage = async (message: AgentMessage) => {
    await navigator.clipboard
      .writeText(messageText(message))
      .catch(() => undefined);
  };
  const retryMessage = (message: AgentMessage) => {
    if (!sending && message.run_id)
      void send(messageText(message), message.run_id);
  };
  const cancelEdit = () => {
    setEditingMessageId(null);
    setDraft("");
    composerRef.current?.focus();
  };
  const stop = async () => {
    const runId = activeRunId;
    if (!runId || cancellationRequestedRun.current === runId) return;
    cancellationRequestedRun.current = runId;
    setRunProgress("Cancellation requested…");
    streamAbort.current?.abort();
    await cancelAgentRun(runId).catch(() => undefined);
  };
  const changeModel = async (value: string) => {
    if (!conversation) return;
    const [provider, ...parts] = value.split(":");
    const model = parts.join(":");
    try {
      const updated = await updateKasiAiConversation(conversation.id, {
        modelProvider: provider as KasiAiModel["provider"],
        model,
      });
      setConversation(updated);
      await refreshHome(installation!.id);
    } catch (cause) {
      setError(formatError(cause, "Unable to change this chat's model"));
    }
  };
  const loadOlder = async () => {
    if (!conversation || !hasMore || !nextBefore) return;
    const result = await getPlatformConversation(conversation.id, {
      limit: 50,
      before: nextBefore,
    });
    setMessages((items) =>
      sorted([
        ...result.messages,
        ...items.filter(
          (item) => !result.messages.some((older) => older.id === item.id),
        ),
      ]),
    );
    setHasMore(Boolean(result.hasMore));
    setNextBefore(result.nextBefore ?? null);
  };
  const updatePreference = async (
    change: Parameters<typeof updateKasiAiPreferences>[1],
  ) => {
    if (!installation) return;
    try {
      const response = await updateKasiAiPreferences(installation.id, change);
      setPreferences(response.preferences);
      await refreshHome(installation.id);
    } catch (cause) {
      setError(formatError(cause, "Unable to save KasiAi settings"));
    }
  };
  const editTitle = async (item: AgentConversation) => {
    const title = await prompt({
      title: "Rename conversation",
      label: "Title",
      defaultValue: item.title ?? "",
      confirmLabel: "Save",
    });
    if (!title?.trim()) return;
    const updated = await updateKasiAiConversation(item.id, {
      title: title.trim(),
    });
    if (conversation?.id === item.id) setConversation(updated);
    await refreshHome(installation!.id);
  };
  const archiveConversation = async (item: AgentConversation) => {
    if (
      !(await confirm({
        title: `Archive “${item.title ?? "this conversation"}”?`,
        confirmLabel: "Archive",
      }))
    )
      return;
    await setKasiAiConversationStatus(item.id, "archived");
    if (conversation?.id === item.id) newChat();
    await refreshHome(installation!.id);
  };
  const deleteConversation = async (item: AgentConversation) => {
    if (
      !(await confirm({
        title: `Delete “${item.title ?? "this conversation"}”?`,
        description: "This cannot be undone.",
        confirmLabel: "Delete",
        variant: "destructive",
      }))
    )
      return;
    await setKasiAiConversationStatus(item.id, "deleted");
    if (conversation?.id === item.id) newChat();
    await refreshHome(installation!.id);
  };
  const connectWhatsapp = async () => {
    if (!selectedWhatsapp) return;
    try {
      const response = await issueKasiAiWhatsappPairing(selectedWhatsapp);
      setPairing({
        token: response.pairing.token,
        expiresAt: response.pairing.expires_at,
      });
    } catch (cause) {
      setError(formatError(cause, "Unable to create pairing code"));
    }
  };
  const disconnect = async (binding: AgentChannelBinding) => {
    if (
      !(await confirm({
        title: `Disconnect ${channelLabel(binding.channel_type)}?`,
        description: "Existing history will remain.",
        confirmLabel: "Disconnect",
        variant: "destructive",
      }))
    )
      return;
    await disconnectKasiAiChannel(binding.id);
    await refreshHome(installation!.id);
  };
  const availableChannels = Array.from(
    new Set(
      messages.map(messageChannel).filter((channel) => channel !== "platform"),
    ),
  ).sort();
  const suggestions = pathname.includes("campaign")
    ? [
        "Help me create a campaign",
        "What should I check before sending?",
        "Explain this page",
        "Show my recent campaign activity",
      ]
    : [
        "What needs my attention?",
        "Show me around this page",
        "Check my connected accounts",
        "Create an AI agent",
      ];
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 640) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { x: event.clientX, width };
    setResizing(true);
  };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return;
    const bounds = panelBounds(leftOffset);
    setWidth(
      Math.min(
        bounds.max,
        Math.max(
          bounds.min,
          resizeStart.current.width + resizeStart.current.x - event.clientX,
        ),
      ),
    );
  };
  const finishResize = () => {
    resizeStart.current = null;
    setResizing(false);
    window.localStorage.setItem(PANEL_WIDTH_KEY, String(width));
  };

  if (!open) return null;
  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      className={cn(
        "fixed inset-y-0 right-0 z-[var(--z-floating)] flex max-w-full flex-col border-l border-border bg-background shadow-2xl",
        resizing && "select-none",
      )}
      style={{ width: `min(${width}px, 100vw)` }}
      role="dialog"
      aria-modal="true"
      aria-label="KasiAi"
    >
      <div
        className="absolute inset-y-0 -left-2 z-10 hidden w-4 cursor-ew-resize sm:block"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        aria-label="Resize KasiAi"
        role="separator"
      />
      <header className="flex h-16 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            ref={mobileNavigationTriggerRef}
            variant="ghost"
            size="icon"
            className="h-8 w-8 sm:hidden"
            onClick={() => setMobileNavigationOpen(true)}
            aria-label="Open KasiAi navigation"
            aria-expanded={mobileNavigationOpen}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {displayConversationTitle(conversation)}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {conversation?.is_primary
                ? "Channel-default chat"
                : "Your platform agent"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {conversation ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() =>
                void navigator.clipboard.writeText(window.location.href)
              }
              aria-label="Copy chat link"
              title="Copy chat link"
            >
              <Copy className="h-4 w-4" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={close}
            aria-label="Close KasiAi"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div className="hidden min-h-0 shrink-0 sm:flex">
          <KasiAiNavigation
            expanded={navigationExpanded}
            view={view}
            conversations={activeConversations}
            selectedId={conversation?.id}
            onToggle={() => setNavigationExpanded((current) => !current)}
            onNew={newChat}
            onChats={() => setView("library")}
            onSettings={() => setView("settings")}
            onOpen={(item) => void loadConversation(item.id)}
          />
        </div>
        {mobileNavigationOpen ? (
          <>
            <button
              type="button"
              className="absolute inset-0 z-[var(--z-overlay)] bg-black/40 sm:hidden"
              onClick={() => setMobileNavigationOpen(false)}
              aria-label="Close KasiAi navigation"
            />
            <div
              ref={mobileNavigationPanelRef}
              className="absolute inset-y-0 left-0 z-[var(--z-popover)] flex w-56 max-w-[calc(100%-3rem)] sm:hidden"
            >
              <KasiAiNavigation
                expanded
                view={view}
                conversations={activeConversations}
                selectedId={conversation?.id}
                onToggle={() => setMobileNavigationOpen(false)}
                onNew={() => {
                  setMobileNavigationOpen(false);
                  newChat();
                }}
                onChats={() => {
                  setMobileNavigationOpen(false);
                  setView("library");
                }}
                onSettings={() => {
                  setMobileNavigationOpen(false);
                  setView("settings");
                }}
                onOpen={(item) => {
                  setMobileNavigationOpen(false);
                  void loadConversation(item.id);
                }}
              />
            </div>
          </>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          {view === "library" ? (
            <ConversationLibrary
              conversations={activeConversations}
              archived={archivedConversations}
              selectedId={conversation?.id}
              search={search}
              onSearch={setSearch}
              onBack={() => setView("chat")}
              onNew={newChat}
              onOpen={(item) => void loadConversation(item.id)}
              onRename={(item) => void editTitle(item)}
              onPin={(item) =>
                void updateKasiAiConversation(item.id, {
                  pinned: !item.pinned,
                }).then(() => refreshHome(installation!.id))
              }
              onArchive={(item) => void archiveConversation(item)}
              onDelete={(item) => void deleteConversation(item)}
              onRestore={(item) =>
                void restoreKasiAiConversation(item.id).then(() =>
                  refreshHome(installation!.id),
                )
              }
            />
          ) : null}
          {view === "settings" ? (
            <KasiAiSettings
              section={settingsSection}
              onSection={setSettingsSection}
              onBack={() => setView("chat")}
              preferences={preferences}
              models={models}
              modelCatalog={home?.modelCatalog}
              selectedModel={
                preferences?.default_model_provider && preferences.default_model
                  ? {
                      provider: preferences.default_model_provider,
                      model: preferences.default_model,
                    }
                  : models[0]
                    ? { provider: models[0].provider, model: models[0].model }
                    : null
              }
              channels={channels}
              whatsappConnections={whatsappConnections}
              selectedWhatsapp={selectedWhatsapp}
              onWhatsapp={setSelectedWhatsapp}
              pairing={pairing}
              onPair={() => void connectWhatsapp()}
              onCopy={() =>
                pairing && navigator.clipboard.writeText(pairing.token)
              }
              onDisconnect={(binding) => void disconnect(binding)}
              onPreference={(input) => void updatePreference(input)}
            />
          ) : null}
          {view === "chat" ? (
            loading ? (
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Preparing KasiAi…
              </div>
            ) : (
              <AgentChatSurface
                runtime={{ telemetry: runtimeTelemetry, detailsOpen: runtimeDetailsOpen, onToggleDetails: () => setRuntimeDetailsOpen((current) => !current) }}
                contentClassName="px-4 py-5"
                autoScrollKey={`${conversation?.id ?? "new"}:${messages.length}:${messages[messages.length - 1]?.id ?? ""}:${sending ? "running" : "idle"}`}
                statusContent={
                  <>
                    {pendingApproval && pendingApproval.runId === lastRunId ? (
                      <KasiAiApprovalPrompt
                        runId={pendingApproval.runId}
                        approvalGroup={pendingApproval.approvalGroup}
                        canApprove={pendingApproval.canApprove}
                        onDecision={(decision) => {
                          setPendingApproval(null);
                          setRunProgress(decision === "approved" ? "Approval accepted; resuming…" : "Approval denied");
                        }}
                      />
                    ) : null}
                    <AgentChatRunStatus runId={lastRunId} progress={runProgress} events={runEvents} running={sending} />
                    {groundingSummary ? <div className="mx-4 mb-2 shrink-0 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[10px] text-muted-foreground" aria-label="Grounding summary"><span className="font-medium text-foreground">Grounded response</span>{groundingSummary.organizationScoped ? " · workspace scoped" : " · scope unavailable"}{groundingSummary.toolEvidence ? ` · ${groundingSummary.toolEvidence.used?.length ?? 0} tools used` : ""}{groundingSummary.reviewedKnowledge?.requested ? ` · ${groundingSummary.reviewedKnowledge.matchedChunks ?? 0} reviewed sources` : " · no reviewed sources requested"}{groundingSummary.unavailableActions?.length ? ` · ${groundingSummary.unavailableActions.length} unavailable action${groundingSummary.unavailableActions.length === 1 ? "" : "s"}` : ""}{groundingSummary.uncertainty === "not_asserted" ? " · no unsupported certainty" : ""}</div> : null}
                  </>
                }
                error={error ? <div className="flex items-center justify-between gap-3"><span>{error}</span>{audioRetryJobId ? <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 gap-1 px-2 text-[11px]" onClick={() => void retryAudio()} disabled={sending}><RotateCcw className="h-3.5 w-3.5" />Retry</Button> : null}</div> : null}
                composer={isArchivedChat ? <footer className="shrink-0 border-t border-border p-3"><div className="rounded-xl border border-border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">This chat is archived. Restore it from the conversation library to continue it.</div></footer> : <AgentChatComposer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={() => void send()}
                  model={activeModel}
                  models={models}
                  modelDisabled={!conversation || sending}
                  onModelChange={(value, provider) => void changeModel(`${provider}:${value}`)}
                  disabled={!installation}
                  sending={sending}
                  onStop={() => void stop()}
                  onAudioReady={sendAudio}
                  onAudioError={setError}
                  placeholder={conversation ? "Ask KasiAi…" : "Start a new chat…"}
                  inputRef={composerRef}
                  leadingContent={editingMessageId ? <div className="mb-2 flex items-center justify-between gap-2 rounded-md bg-primary/5 px-2 py-1.5 text-[11px] text-muted-foreground"><span className="font-medium text-foreground">Editing message</span><Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={cancelEdit}>Cancel</Button></div> : null}
                  modelAccessory={conversation && !conversation.is_primary ? <Button type="button" variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => void setKasiAiChannelDefault(conversation.id).then(async (updated) => { setConversation(updated); await refreshHome(installation!.id); })}>Use for channels</Button> : null}
                  className="border-t border-border bg-card p-3 shadow-none"
                  ariaLabel="Message KasiAi"
                />}
              >
                {conversation ? <div className="space-y-3">
                  {hasMore ? <div className="text-center"><Button variant="outline" size="sm" onClick={() => void loadOlder()}>Load earlier messages</Button></div> : null}
                  <AgentChatMessageList
                    messages={messages}
                    availableChannels={availableChannels}
                    channelFilter={channelFilter}
                    onChannelFilterChange={setChannelFilter}
                    runStatuses={runStatuses}
                    archived={isArchivedChat}
                    onUiInteraction={(_message, interaction) => void send(undefined, undefined, undefined, { ...interaction, messageId: _message.id })}
                    onCopy={copyMessage}
                    onEdit={editMessage}
                    onRetry={retryMessage}
                    retryable={(message, status) => messageChannel(message) === "platform" && message.direction === "inbound" && ["failed", "cancelled", "expired"].includes(status ?? "")}
                    actionDisabled={sending}
                  />
                </div> : <NewChatHome suggestions={suggestions} onSuggestion={(suggestion) => void send(suggestion)} />}
              </AgentChatSurface>
            )
          ) : null}
        </div>
      </div>
    </aside>
  );
}

function KasiAiApprovalPrompt({
  runId,
  approvalGroup,
  canApprove,
  onDecision,
}: {
  runId: string;
  approvalGroup: AgentApprovalGroup;
  canApprove: boolean;
  onDecision: (decision: "approved" | "rejected") => void;
}) {
  return <div className="mx-auto mt-4 max-w-3xl rounded-lg border border-status-attention/40 bg-status-attention-soft/40 px-3 py-3 text-xs" role="status" aria-live="polite"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-foreground">Approval required</p><p className="mt-1 text-muted-foreground">Review {approvalGroup.operations.length} proposed actions as one group.</p></div><span className="shrink-0 rounded-full border border-status-attention/40 px-2 py-0.5 text-[10px] font-medium text-status-attention">Pending</span></div><div className="mt-3 space-y-1.5">{approvalGroup.operations.map((operation) => <div key={operation.runtimeOperationId ?? operation.providerToolCallId} className="rounded-md border border-border/70 bg-background/30 px-3 py-2"><p className="font-medium text-foreground">{operation.capability}</p><p className="mt-1 text-[10px] text-muted-foreground">{operation.status}</p></div>)}</div><div className="mt-3 flex flex-wrap items-center gap-2">{canApprove ? <AgentApprovalGroupActions runId={runId} group={approvalGroup} onDecided={onDecision} /> : <p className="text-muted-foreground">Approval is required from an authorized operator.</p>}</div></div>;
}

function NewChatHome({
  suggestions,
  onSuggestion,
}: {
  suggestions: string[];
  onSuggestion: (suggestion: string) => void;
}) {
  const workspaces = [
    { label: "Connect account", href: "/connections" },
    { label: "Open content", href: "/content" },
    { label: "View report", href: "/workspace" },
  ];
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="h-6 w-6" />
      </span>
      <h3 className="mt-4 text-lg font-semibold">How can I help?</h3>
      <div className="mt-6 grid w-full max-w-md gap-2 sm:grid-cols-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSuggestion(suggestion)}
            className="rounded-xl border border-border bg-card p-3 text-left text-xs transition-colors hover:border-primary/50 hover:bg-muted"
          >
            {suggestion}
            <ChevronRight className="mt-2 h-3.5 w-3.5 text-muted-foreground" />
          </button>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Workspaces">
        {workspaces.map((workspace) => (
          <Link key={workspace.href} href={workspace.href} className="rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground">
            {workspace.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

function KasiAiNavigation({
  expanded,
  view,
  conversations,
  selectedId,
  onToggle,
  onNew,
  onChats,
  onSettings,
  onOpen,
}: {
  expanded: boolean;
  view: View;
  conversations: AgentConversation[];
  selectedId?: string;
  onToggle: () => void;
  onNew: () => void;
  onChats: () => void;
  onSettings: () => void;
  onOpen: (conversation: AgentConversation) => void;
}) {
  const actionClass = (active = false) =>
    cn(
      "flex h-9 items-center rounded-md text-sm transition-colors hover:bg-muted",
      expanded ? "w-full gap-2 px-2.5" : "w-9 justify-center",
      active && "bg-muted text-foreground",
    );
  return (
    <nav
      className={cn(
        "flex shrink-0 flex-col border-r border-border bg-card/30 p-2 transition-[width] duration-[var(--v-motion-shell)]",
        expanded ? "w-56" : "w-14",
      )}
      aria-label="KasiAi navigation"
    >
      <div
        className={cn(
          "mb-2 flex items-center",
          expanded ? "justify-between px-1" : "justify-center",
        )}
      >
        <span className={cn("text-sm font-semibold", !expanded && "sr-only")}>
          KasiAi
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onToggle}
          aria-label={
            expanded ? "Collapse KasiAi navigation" : "Expand KasiAi navigation"
          }
        >
          <PanelLeft
            className={cn(
              "h-4 w-4 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </Button>
      </div>
      <button
        type="button"
        onClick={onNew}
        className={actionClass(view === "chat" && !selectedId)}
        title="New chat"
      >
        <Plus className="h-4 w-4 shrink-0" />
        {expanded ? <span>New chat</span> : null}
      </button>
      <button
        type="button"
        onClick={onChats}
        className={actionClass(view === "library")}
        title="Chats"
      >
        <MessageCircle className="h-4 w-4 shrink-0" />
        {expanded ? <span>Chats</span> : null}
      </button>
      <button
        type="button"
        onClick={onSettings}
        className={actionClass(view === "settings")}
        title="Settings"
      >
        <Settings2 className="h-4 w-4 shrink-0" />
        {expanded ? <span>Settings</span> : null}
      </button>
      {expanded ? (
        <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
          <p className="px-2 pb-2 text-[11px] font-medium text-muted-foreground">
            Recents
          </p>
          <div className="space-y-0.5">
            {conversations.map((conversation) => (
              <button
                type="button"
                key={conversation.id}
                onClick={() => onOpen(conversation)}
                className={cn(
                  "w-full truncate rounded-md px-2 py-2 text-left text-xs hover:bg-muted",
                  conversation.id === selectedId && "bg-muted font-medium",
                )}
                title={displayConversationTitle(conversation)}
              >
                {conversation.pinned ? "• " : ""}
                {displayConversationTitle(conversation)}
              </button>
            ))}
            {!conversations.length ? (
              <p className="px-2 py-2 text-xs text-muted-foreground">
                No chats yet.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </nav>
  );
}

function ConversationLibrary({
  conversations,
  archived,
  selectedId,
  search,
  onSearch,
  onBack,
  onNew,
  onOpen,
  onRename,
  onPin,
  onArchive,
  onDelete,
  onRestore,
}: {
  conversations: AgentConversation[];
  archived: AgentConversation[];
  selectedId?: string;
  search: string;
  onSearch: (value: string) => void;
  onBack: () => void;
  onNew: () => void;
  onOpen: (item: AgentConversation) => void;
  onRename: (item: AgentConversation) => void;
  onPin: (item: AgentConversation) => void;
  onArchive: (item: AgentConversation) => void;
  onDelete: (item: AgentConversation) => void;
  onRestore: (item: AgentConversation) => void;
}) {
  const filtered = conversations.filter((item) =>
    displayConversationTitle(item).toLowerCase().includes(search.toLowerCase()),
  );
  const groups = ["Today", "Yesterday", "Previous 7 days", "Older"]
    .map(
      (label) =>
        [
          label,
          filtered.filter((item) => dateGroup(item.updated_at) === label),
        ] as const,
    )
    .filter(([, items]) => items.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h3 className="flex-1 text-sm font-semibold">Conversations</h3>
        <Button size="sm" onClick={onNew}>
          <Plus className="h-3.5 w-3.5" />
          New chat
        </Button>
      </div>
      <div className="border-b border-border p-3">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </label>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {groups.map(([label, items]) => (
          <section key={label} className="mb-5">
            <h4 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
              {label}
            </h4>
            {items.map((item) => (
              <ConversationRow
                key={item.id}
                item={item}
                selected={item.id === selectedId}
                onOpen={onOpen}
                onRename={onRename}
                onPin={onPin}
                onArchive={onArchive}
                onDelete={onDelete}
              />
            ))}
          </section>
        ))}
        {!filtered.length ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            No conversations found.
          </p>
        ) : null}
        {archived.length ? (
          <section className="border-t border-border pt-4">
            <h4 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">
              Archived
            </h4>
            {archived.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-1 rounded-lg px-2 py-2 text-sm text-muted-foreground"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => onOpen(item)}
                >
                  {displayConversationTitle(item)}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[10px]"
                  onClick={() => onRestore(item)}
                >
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => onDelete(item)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ConversationRow({
  item,
  selected,
  onOpen,
  onRename,
  onPin,
  onArchive,
  onDelete,
}: {
  item: AgentConversation;
  selected: boolean;
  onOpen: (item: AgentConversation) => void;
  onRename: (item: AgentConversation) => void;
  onPin: (item: AgentConversation) => void;
  onArchive: (item: AgentConversation) => void;
  onDelete: (item: AgentConversation) => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg px-2 py-2",
        selected && "bg-muted",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex items-center gap-1 truncate text-sm">
          {item.pinned ? (
            <Pin className="h-3 w-3 shrink-0 text-primary" />
          ) : null}
          {displayConversationTitle(item)}
        </span>
        <span className="mt-0.5 block text-[10px] text-muted-foreground">
          {item.is_primary
            ? "Connected channels"
            : new Date(item.updated_at).toLocaleDateString()}
        </span>
      </button>
      <div className="hidden gap-0.5 group-hover:flex group-focus-within:flex">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onRename(item)}
          aria-label="Rename"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onPin(item)}
          aria-label="Pin"
        >
          <Pin className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => onArchive(item)}
          aria-label="Archive"
        >
          <Archive className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive"
          onClick={() => onDelete(item)}
          aria-label="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function KasiAiSettings({
  section,
  onSection,
  onBack,
  preferences,
  models,
  modelCatalog,
  selectedModel,
  channels,
  whatsappConnections,
  selectedWhatsapp,
  onWhatsapp,
  pairing,
  onPair,
  onCopy,
  onDisconnect,
  onPreference,
}: {
  section: SettingsSection;
  onSection: (value: SettingsSection) => void;
  onBack: () => void;
  preferences: KasiAiPreferences | null;
  models: KasiAiModel[];
  modelCatalog?: KasiAiHome["modelCatalog"];
  selectedModel: { provider: string; model: string } | null;
  channels: AgentChannelBinding[];
  whatsappConnections: WhatsappConnectionOption[];
  selectedWhatsapp: string;
  onWhatsapp: (value: string) => void;
  pairing: { token: string; expiresAt: string } | null;
  onPair: () => void;
  onCopy: () => void;
  onDisconnect: (binding: AgentChannelBinding) => void;
  onPreference: (input: Parameters<typeof updateKasiAiPreferences>[1]) => void;
}) {
  const [modelSearch, setModelSearch] = useState("");
  const normalizedSearch = modelSearch.trim().toLowerCase();
  const matchingModels = models.filter(
    (model) =>
      !normalizedSearch ||
      `${model.label} ${model.model} ${model.provider}`
        .toLowerCase()
        .includes(normalizedSearch),
  );
  const displayedModels = matchingModels.slice(0, normalizedSearch ? 100 : 30);
  const nav: Array<[SettingsSection, string, typeof SlidersHorizontal]> = [
    ["general", "General", SlidersHorizontal],
    ["model", "Model", Sparkles],
    ["connections", "Connections", MessageCircle],
    ["memory", "Memory & privacy", Bot],
  ];
  if (shouldShowModelSettings(section))
    return (
      <KasiAiModelSettings
        onBack={onBack}
        onSection={onSection}
        models={models}
        modelCatalog={modelCatalog}
        selectedModel={selectedModel}
        onPreference={onPreference}
      />
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h3 className="text-sm font-semibold">KasiAi settings</h3>
      </div>
      <div className="flex min-h-0 flex-1 flex-col min-[480px]:flex-row">
        <nav className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-border p-2 min-[480px]:block min-[480px]:w-36 min-[480px]:overflow-visible min-[480px]:border-b-0 min-[480px]:border-r">
          {nav.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => onSection(key)}
              aria-current={section === key ? "page" : undefined}
              className={cn(
                "flex min-h-9 shrink-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs min-[480px]:mb-1 min-[480px]:w-full",
                section === key
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          {section === "general" ? (
            <div className="space-y-5">
              <SettingTitle
                title="General"
                description="These preferences apply to your new KasiAi responses."
              />
              <SelectSetting
                label="Response style"
                value={preferences?.tone ?? "balanced"}
                options={[
                  ["concise", "Concise"],
                  ["balanced", "Balanced"],
                  ["detailed", "Detailed"],
                ]}
                onChange={(tone) =>
                  onPreference({
                    tone: tone as "concise" | "balanced" | "detailed",
                  })
                }
              />
              <SelectSetting
                label="Response detail"
                value={preferences?.response_detail ?? "standard"}
                options={[
                  ["concise", "Concise"],
                  ["standard", "Standard"],
                  ["detailed", "Detailed"],
                ]}
                onChange={(responseDetail) =>
                  onPreference({
                    responseDetail: responseDetail as
                      | "concise"
                      | "standard"
                      | "detailed",
                  })
                }
              />
              <Toggle
                label="Notifications"
                description="Show updates when KasiAi completes a task."
                checked={preferences?.notifications_enabled ?? true}
                onChange={(notificationsEnabled) =>
                  onPreference({ notificationsEnabled })
                }
              />
            </div>
          ) : null}
          {section === "model" ? (
            <div className="space-y-4">
              <SettingTitle
                title="Default model"
                description="Used for new chats. OpenRouter's full live text-model catalog is available through your configured OpenRouter account."
              />
              <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder="Search models, labs, or IDs…"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </label>
              <div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                <span>
                  {matchingModels.length} model
                  {matchingModels.length === 1 ? "" : "s"}
                </span>
                <span>·</span>
                <span>
                  {modelCatalog?.source === "live"
                    ? "Live OpenRouter catalog"
                    : "Cached fallback catalog"}
                </span>
              </div>
              {modelCatalog?.error ? (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                  The live catalog is unavailable right now; showing safe
                  fallback models.
                </p>
              ) : null}
              <div className="space-y-2">
                {displayedModels.map((item) => (
                  <button
                    type="button"
                    key={`${item.provider}:${item.model}`}
                    onClick={() =>
                      onPreference({
                        defaultModelProvider: item.provider,
                        defaultModel: item.model,
                      })
                    }
                    className={cn(
                      "w-full rounded-lg border p-3 text-left",
                      selectedModel?.provider === item.provider &&
                        selectedModel.model === item.model
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">
                        {item.label}
                      </span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px]">
                        {item.isFree ? "free" : item.tier}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-muted-foreground">
                      {item.provider} · {item.model}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                      {item.isWorkspaceDefault ? (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                          workspace default
                        </span>
                      ) : null}
                      {item.supportsTools ? (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          tools
                        </span>
                      ) : (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          chat only
                        </span>
                      )}
                      {item.contextWindow ? (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          {Math.round(item.contextWindow / 1000)}k context
                        </span>
                      ) : null}
                      {item.inputUsdPerMillion !== undefined ? (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          ${item.inputUsdPerMillion}/M in
                        </span>
                      ) : null}
                    </div>
                  </button>
                ))}
              </div>
              {matchingModels.length > displayedModels.length ? (
                <p className="text-center text-xs text-muted-foreground">
                  Showing {displayedModels.length} of {matchingModels.length}.
                  Refine your search to find any model.
                </p>
              ) : null}
            </div>
          ) : null}
          {section === "connections" ? (
            <div className="space-y-5">
              <SettingTitle
                title="Connections"
                description="Connect personal channels to the designated channel-default conversation."
              />
              {channels
                .filter((binding) => binding.status === "active")
                .map((binding) => (
                  <div
                    key={binding.id}
                    className="flex items-center justify-between rounded-lg border border-border p-3"
                  >
                    <div>
                      <p className="text-sm font-medium">
                        {channelLabel(binding.channel_type)}
                      </p>
                      <p className="text-xs text-muted-foreground">Connected</p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onDisconnect(binding)}
                    >
                      <Unlink className="h-3.5 w-3.5" />
                      Disconnect
                    </Button>
                  </div>
                ))}
              {whatsappConnections.length &&
              !channels.some(
                (binding) =>
                  binding.channel_type === "whatsapp" &&
                  binding.status === "active",
              ) ? (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-sm font-medium">Connect WhatsApp</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Send a one-time code to your selected KasiTek WhatsApp
                    number.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 min-[480px]:flex-row">
                    <Select value={selectedWhatsapp} onValueChange={onWhatsapp}>
                      <SelectTrigger className="min-w-0 flex-1 text-xs">
                        <SelectValue placeholder="Select a number" />
                      </SelectTrigger>
                      <SelectContent>
                      {whatsappConnections.map((connection) => (
                        <SelectItem key={connection.id} value={connection.id}>
                          {connection.phoneDisplayNumber ||
                            connection.phoneNumberId}
                        </SelectItem>
                      ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" className="w-full min-[480px]:w-auto" onClick={onPair}>
                      Connect
                    </Button>
                  </div>
                  {pairing ? (
                    <div className="mt-3 rounded-md bg-muted p-2">
                      <code className="break-all text-[11px]">
                        {pairing.token}
                      </code>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-7"
                        onClick={onCopy}
                      >
                        <Copy className="h-3 w-3" />
                        Copy
                      </Button>
                      <p className="mt-1 text-[10px] text-muted-foreground">
                        Expires{" "}
                        {new Date(pairing.expiresAt).toLocaleTimeString()}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {!channels.length && !whatsappConnections.length ? (
                <p className="text-sm text-muted-foreground">
                  No supported personal channel is available in this workspace
                  yet.
                </p>
              ) : null}
            </div>
          ) : null}
          {section === "memory" ? (
            <div className="space-y-5">
              <SettingTitle
                title="Memory & privacy"
                description="Control how KasiAi uses saved preferences across chats."
              />
              <Toggle
                label="Use saved preferences"
                description="Use your saved language, style, and preference settings."
                checked={preferences?.use_saved_preferences ?? true}
                onChange={(useSavedPreferences) =>
                  onPreference({ useSavedPreferences })
                }
              />
              <Toggle
                label="Reference previous chats"
                description="Allow future KasiAi improvements to use relevant prior chat context. Current conversation context is always isolated."
                checked={preferences?.reference_previous_chats ?? false}
                onChange={(referencePreviousChats) =>
                  onPreference({ referencePreviousChats })
                }
              />
              <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
                Deleting a chat removes its conversation-specific summary and
                memory. Saved user preferences are kept until you change them.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function shouldShowModelSettings(section: SettingsSection): boolean {
  return section === "model";
}

function KasiAiModelSettings({
  onBack,
  onSection,
  models,
  modelCatalog,
  selectedModel,
  onPreference,
}: {
  onBack: () => void;
  onSection: (value: SettingsSection) => void;
  models: KasiAiModel[];
  modelCatalog?: KasiAiHome["modelCatalog"];
  selectedModel: { provider: string; model: string } | null;
  onPreference: (input: Parameters<typeof updateKasiAiPreferences>[1]) => void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current =
    models.find(
      (model) =>
        model.provider === selectedModel?.provider &&
        model.model === selectedModel.model,
    ) ?? models[0];
  const matching = models.filter(
    (model) =>
      !search.trim() ||
      `${model.label} ${model.model} ${model.provider}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const displayed = matching.slice(0, search.trim() ? 100 : 30);
  const nav: Array<[SettingsSection, string, typeof SlidersHorizontal]> = [
    ["general", "General", SlidersHorizontal],
    ["model", "Model", Sparkles],
    ["connections", "Connections", MessageCircle],
    ["memory", "Memory & privacy", Bot],
  ];
  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [pickerOpen]);
  const select = (model: KasiAiModel) => {
    onPreference({
      defaultModelProvider: model.provider,
      defaultModel: model.model,
    });
    setPickerOpen(false);
    setSearch("");
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h3 className="text-sm font-semibold">KasiAi settings</h3>
      </div>
      <div className="flex min-h-0 flex-1 flex-col min-[480px]:flex-row">
        <nav className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-border p-2 min-[480px]:block min-[480px]:w-36 min-[480px]:overflow-visible min-[480px]:border-b-0 min-[480px]:border-r">
          {nav.map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => onSection(key)}
              aria-current={key === "model" ? "page" : undefined}
              className={cn(
                "flex min-h-9 shrink-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs min-[480px]:mb-1 min-[480px]:w-full",
                key === "model"
                  ? "bg-muted font-medium"
                  : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-4">
            <SettingTitle
              title="Default model"
              description="Used for new chats. Change it whenever you need another model."
            />
            {current ? (
              <ModelCard model={current} selected />
            ) : (
              <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                No model is currently available.
              </p>
            )}
            <Button
              onClick={() => setPickerOpen(true)}
              disabled={!models.length}
            >
              <Search className="h-4 w-4" />
              Change model
            </Button>
            <p className="text-xs text-muted-foreground">
              {models.length} available models ·{" "}
              {modelCatalog?.source === "live"
                ? "Live OpenRouter catalog"
                : "Cached fallback catalog"}
            </p>
            {modelCatalog?.error ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                The live catalog is unavailable right now; showing safe fallback
                models.
              </p>
            ) : null}
          </div>
        </div>
      </div>
      {pickerOpen ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
          <div
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Choose a model"
          >
            <div className="flex items-center justify-between border-b border-border p-4">
              <div>
                <h4 className="text-sm font-semibold">Choose a model</h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  Search the live OpenRouter catalog.
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => setPickerOpen(false)}
                aria-label="Close model picker"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="border-b border-border p-3">
              <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input
                  autoFocus
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search models, labs, or IDs…"
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                />
              </label>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {matching.length} matches
                {matching.length > displayed.length
                  ? ` · showing first ${displayed.length}`
                  : ""}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <div className="space-y-2">
                {displayed.map((model) => (
                  <button
                    key={`${model.provider}:${model.model}`}
                    type="button"
                    onClick={() => select(model)}
                    className="w-full text-left"
                  >
                    <ModelCard
                      model={model}
                      selected={
                        model.provider === selectedModel?.provider &&
                        model.model === selectedModel.model
                      }
                    />
                  </button>
                ))}
              </div>
              {!matching.length ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No models match that search.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ModelCard({
  model,
  selected = false,
}: {
  model: KasiAiModel;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "w-full rounded-lg border p-3 text-left transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:bg-muted/60",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{model.label}</span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px]">
          {model.isFree ? "free" : model.tier}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
        {model.isWorkspaceDefault ? (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
            workspace default
          </span>
        ) : null}
        {model.supportsTools ? (
          <span className="rounded bg-muted px-1.5 py-0.5">tools</span>
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5">chat only</span>
        )}
        {model.contextWindow ? (
          <span className="rounded bg-muted px-1.5 py-0.5">
            {Math.round(model.contextWindow / 1_000)}k context
          </span>
        ) : null}
        {model.inputUsdPerMillion !== undefined ? (
          <span className="rounded bg-muted px-1.5 py-0.5">
            ${model.inputUsdPerMillion}/M in
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SettingTitle({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h4 className="text-base font-semibold">{title}</h4>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
function SelectSetting({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<[string, string]>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block text-sm font-medium">
      {label}
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="mt-2 w-full bg-card font-normal">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([id, name]) => (
            <SelectItem key={id} value={id}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border p-3">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        className="mt-1"
      />
    </label>
  );
}
