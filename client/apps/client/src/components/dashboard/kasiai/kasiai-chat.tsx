"use client";

import { Button } from "@/components/ui/button";
import {
  Bot,
  Check,
  Copy,
  RotateCcw,
  LoaderCircle,
  MessageCircle,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelAgentRun,
  createPlatformConversation,
  disconnectKasiAiChannel,
  ensureKasiAi,
  getPlatformConversation,
  issueKasiAiWhatsappPairing,
  listAgentConversations,
  listKasiAiChannels,
  listWhatsappConnectionOptions,
  resolvePlatformConversation,
  sendPlatformMessage,
  streamAgentRun,
  AgentRequestError,
  type AgentConversation,
  type AgentChannelBinding,
  type AgentInstallation,
  type AgentMessage,
  type WhatsappConnectionOption,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";

function messageText(message: AgentMessage): string {
  return typeof message.content?.text === "string" ? message.content.text : JSON.stringify(message.content);
}

const markdownComponents: Components = {
  h1: ({ children }) => <h3 className="mt-3 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  h3: ({ children }) => <h5 className="mt-2 text-sm font-semibold first:mt-0">{children}</h5>,
  p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => <blockquote className="mt-2 border-l-2 border-current/30 pl-3 italic">{children}</blockquote>,
  code: ({ children, className }) => className
    ? <code className="my-2 block overflow-x-auto rounded-md bg-black/15 p-2 text-xs leading-5">{children}</code>
    : <code className="rounded bg-black/15 px-1 py-0.5 text-[0.85em]">{children}</code>,
  a: ({ children, href }) => {
    const safeHref = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
    return safeHref
      ? <a href={safeHref} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:opacity-80">{children}</a>
      : <>{children}</>;
  },
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
  th: ({ children }) => <th className="border border-current/20 px-2 py-1 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-current/20 px-2 py-1 align-top">{children}</td>,
};

function SafeMarkdown({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>{children}</ReactMarkdown>;
}

function sortMessages(messages: AgentMessage[]): AgentMessage[] {
  return [...messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number));
}

const channelLabels: Record<string, string> = {
  platform: "Sidebar",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  discord: "Discord",
};

function messageChannel(message: AgentMessage): string {
  return (message.source_channel || message.provider || "platform").toLowerCase();
}

function channelLabel(channel: string): string {
  return channelLabels[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

const KASIAI_PANEL_WIDTH_KEY = "kasitek:kasiai-panel-width";
const KASIAI_DEFAULT_WIDTH = 430;
const KASIAI_MIN_WIDTH = 340;
const KASIAI_MAX_WIDTH = 1600;

function panelWidthBounds(leftOffset = 0) {
  if (typeof window === "undefined") {
    return { min: KASIAI_MIN_WIDTH, max: KASIAI_MAX_WIDTH };
  }
  const desktopLeftOffset = window.innerWidth >= 1024 ? leftOffset : 0;
  return {
    min: Math.min(KASIAI_MIN_WIDTH, window.innerWidth),
    max: Math.min(KASIAI_MAX_WIDTH, Math.max(KASIAI_MIN_WIDTH, window.innerWidth - desktopLeftOffset)),
  };
}

function clampPanelWidth(width: number, leftOffset = 0) {
  const bounds = panelWidthBounds(leftOffset);
  return Math.min(bounds.max, Math.max(bounds.min, width));
}

function formatAgentError(cause: unknown, fallback: string): string {
  if (!(cause instanceof AgentRequestError)) {
    return cause instanceof Error ? cause.message : fallback;
  }
  if (cause.status === 503) return "KasiAi is temporarily unavailable. Check that the Agent Platform and model provider are running, then try again.";
  if (cause.status === 504) return "KasiAi took too long to respond. You can retry this request.";
  if (cause.status === 403 && /installation|disabled|paused/i.test(cause.message)) return "KasiAi is paused for this workspace. Resume the installation from Agents to continue.";
  if (/credential|model provider|api key|authentication/i.test(cause.message)) return "KasiAi's model credentials are not configured. Add the configured provider credentials before sending messages.";
  if (/budget|limit|quota/i.test(cause.message)) return "This run exceeded the current agent budget. Try a shorter request or contact an administrator.";
  if (/approval.*(expired|expire)/i.test(cause.message)) return "The approval window expired. Start the request again if it is still needed.";
  return cause.message || fallback;
}

export function KasiAiChat({ open, onOpenChange, leftOffset = 0 }: { open: boolean; onOpenChange: (open: boolean) => void; leftOffset?: number }) {
  const [installation, setInstallation] = useState<AgentInstallation | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [conversationHistory, setConversationHistory] = useState<AgentConversation[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [channelFilter, setChannelFilter] = useState("all");
  const [channelBindings, setChannelBindings] = useState<AgentChannelBinding[]>([]);
  const [whatsappConnections, setWhatsappConnections] = useState<WhatsappConnectionOption[]>([]);
  const [selectedWhatsappConnection, setSelectedWhatsappConnection] = useState("");
  const [pairing, setPairing] = useState<{ token: string; expiresAt: string } | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingCopied, setPairingCopied] = useState(false);
  const [disconnectingBindingId, setDisconnectingBindingId] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializationKey, setInitializationKey] = useState(0);
  const [panelWidth, setPanelWidth] = useState(KASIAI_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);
  const streamAbort = useRef<AbortController | null>(null);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const messagesViewport = useRef<HTMLDivElement | null>(null);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const resizeStart = useRef<{ pointerX: number; width: number } | null>(null);
  const initializationAttempted = useRef(false);
  const closeButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const storedWidth = window.localStorage.getItem(KASIAI_PANEL_WIDTH_KEY);
    if (!storedWidth) return;
    const parsedWidth = Number(storedWidth);
    if (Number.isFinite(parsedWidth)) setPanelWidth(clampPanelWidth(parsedWidth, leftOffset));
  }, [leftOffset]);

  useEffect(() => {
    const handleWindowResize = () => setPanelWidth((width) => clampPanelWidth(width, leftOffset));
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, [leftOffset]);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 640) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { pointerX: event.clientX, width: panelWidth };
    setResizing(true);
  };

  const updateResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    setPanelWidth(clampPanelWidth(start.width + start.pointerX - event.clientX, leftOffset));
  };

  const finishResize = () => {
    if (!resizeStart.current) return;
    resizeStart.current = null;
    setResizing(false);
    window.localStorage.setItem(KASIAI_PANEL_WIDTH_KEY, String(panelWidth));
  };

  const loadConversation = useCallback(async (conversationId: string) => {
    const response = await getPlatformConversation(conversationId);
    setConversation(response.conversation);
    setMessages(sortMessages(response.messages));
    setHasMoreMessages(Boolean(response.hasMore));
    setNextBefore(response.nextBefore ?? null);
  }, []);

  const refreshConversationHistory = useCallback(async (installationId: string) => {
    const response = await listAgentConversations(installationId);
    setConversationHistory(response.conversations);
  }, []);

  const refreshChannels = useCallback(async (installationId: string) => {
    const [channels, whatsapp] = await Promise.all([
      listKasiAiChannels(installationId),
      listWhatsappConnectionOptions().catch(() => ({ connections: [] })),
    ]);
    setChannelBindings(channels.bindings);
    setWhatsappConnections(whatsapp.connections);
    setSelectedWhatsappConnection((current) => current || whatsapp.connections[0]?.id || "");
  }, []);

  const loadOlder = async () => {
    if (!conversation || !hasMoreMessages || !nextBefore || loadingOlder) return;
    const viewport = messagesViewport.current;
    if (viewport) restoreScroll.current = { height: viewport.scrollHeight, top: viewport.scrollTop };
    setLoadingOlder(true);
    try {
      const response = await getPlatformConversation(conversation.id, { limit: 50, before: nextBefore });
      setMessages((current) => sortMessages([...response.messages, ...current.filter((message) => !response.messages.some((older) => older.id === message.id))]));
      setHasMoreMessages(Boolean(response.hasMore));
      setNextBefore(response.nextBefore ?? null);
    } catch (cause) {
      setError(formatAgentError(cause, "Unable to load earlier messages"));
    } finally {
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    if (!open) {
      initializationAttempted.current = false;
      return;
    }
    if (initializationAttempted.current) return;
    initializationAttempted.current = true;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const installed = installation ?? await ensureKasiAi();
        if (cancelled) return;
        setInstallation(installed);
        const resolved = await resolvePlatformConversation(installed.id);
        if (cancelled) return;
        setConversation(resolved.conversation);
        setMessages(sortMessages(resolved.messages));
        setHasMoreMessages(Boolean(resolved.hasMore));
        setNextBefore(resolved.nextBefore ?? null);
        await Promise.all([refreshConversationHistory(installed.id), refreshChannels(installed.id)]);
      } catch (cause) {
        if (!cancelled) setError(formatAgentError(cause, "KasiAi is unavailable"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initializationKey, open, refreshChannels, refreshConversationHistory]);

  useEffect(() => {
    if (!open || !conversation?.is_primary || document.visibilityState === "hidden") return;
    const interval = window.setInterval(() => {
      void getPlatformConversation(conversation.id, { limit: 100 })
        .then((response) => {
          setConversation(response.conversation);
          setMessages((current) => {
            const incoming = new Map(response.messages.map((message) => [message.id, message]));
            return sortMessages([
              ...current.map((message) => incoming.get(message.id) ?? message),
              ...response.messages.filter((message) => !current.some((existing) => existing.id === message.id)),
            ]);
          });
          setHasMoreMessages((current) => current || Boolean(response.hasMore));
        })
        .catch(() => undefined);
    }, 4_000);
    return () => window.clearInterval(interval);
  }, [conversation?.id, conversation?.is_primary, open]);

  useEffect(() => {
    if (!open || !installation || !pairing) return;
    const interval = window.setInterval(() => {
      void refreshChannels(installation.id).then(() => undefined).catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(interval);
  }, [installation, open, pairing, refreshChannels]);

  useEffect(() => {
    if (pairing && channelBindings.some((binding) => binding.channel_type === "whatsapp" && binding.status === "active")) {
      setPairing(null);
      setPairingCopied(false);
    }
  }, [channelBindings, pairing]);

  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    const previous = restoreScroll.current;
    const viewport = messagesViewport.current;
    if (!previous || !viewport) return;
    viewport.scrollTop = viewport.scrollHeight - previous.height + previous.top;
    restoreScroll.current = null;
  }, [messages]);

  useEffect(() => () => streamAbort.current?.abort(), []);

  const send = async () => {
    const message = draft.trim();
    if (!message || !installation || sending) return;
    setDraft("");
    setError(null);
    setSending(true);
    const optimistic: AgentMessage = {
      id: `optimistic-${crypto.randomUUID()}`,
      conversation_id: conversation?.id ?? "pending",
      direction: "inbound",
      message_type: "text",
      content: { text: message },
      sequence_number: Number.MAX_SAFE_INTEGER,
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    try {
      const accepted = await sendPlatformMessage(installation.id, {
        message,
        idempotencyKey: crypto.randomUUID(),
        context: { route: window.location.pathname, pageTitle: document.title },
      });
      setActiveRunId(accepted.runId);
      if (!conversation || conversation.id !== accepted.conversation.id) {
        setConversation(accepted.conversation);
      }
      const controller = new AbortController();
      streamAbort.current = controller;
      let cursor = 0;
      let completed = false;
      for (let attempt = 0; attempt < 3 && !completed; attempt += 1) {
        try {
          const stream = await streamAgentRun(accepted.runId, (event) => {
            const sequence = Number(event.data.sequence_number);
            if (Number.isSafeInteger(sequence) && sequence > cursor) cursor = sequence;
            if (["run.failed", "run.cancelled", "run.expired"].includes(event.event)) {
              const payload = event.data.payload as { message?: string } | undefined;
              setError(payload?.message ?? "KasiAi could not complete this request");
            }
            if (event.event === "run.failed" || event.event === "agent.stream_error") {
              const payload = event.data.payload as { message?: string } | undefined;
              setError(payload?.message ?? "KasiAi could not complete this request");
            }
          }, controller.signal, cursor);
          cursor = stream.lastSequence;
          completed = stream.terminal;
          if (!completed && attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
        } catch (cause) {
          if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
          if (attempt === 2) throw cause;
          await new Promise((resolve) => window.setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      if (!completed) throw new Error("The run stream ended before KasiAi finished; please try again.");
      await loadConversation(accepted.conversation.id);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(formatAgentError(cause, "KasiAi could not complete this request"));
      }
    } finally {
      streamAbort.current = null;
      setActiveRunId(null);
      setSending(false);
    }
  };

  const stop = async () => {
    if (!activeRunId) return;
    try {
      await cancelAgentRun(activeRunId);
    } catch (cause) {
      setError(formatAgentError(cause, "Unable to stop the run"));
    } finally {
      streamAbort.current?.abort();
      streamAbort.current = null;
      setActiveRunId(null);
      setSending(false);
      if (conversation) void loadConversation(conversation.id);
    }
  };

  const startNewConversation = async () => {
    if (!installation || sending) return;
    if (messages.length && !window.confirm("Reset this KasiAi conversation? The current thread will be archived and remain available in history. Saved preferences and long-term memory will not be erased.")) return;
    setLoading(true);
    setError(null);
    try {
      const response = await createPlatformConversation(installation.id);
      setConversation(response.conversation);
      setMessages(sortMessages(response.messages));
      setHasMoreMessages(Boolean(response.hasMore));
      setNextBefore(response.nextBefore ?? null);
      setChannelFilter("all");
      await refreshConversationHistory(installation.id);
    } catch (cause) {
      setError(formatAgentError(cause, "Unable to start a new conversation"));
    } finally {
      setLoading(false);
    }
  };

  const beginWhatsappPairing = async () => {
    if (!selectedWhatsappConnection || pairingBusy) return;
    setPairingBusy(true);
    setPairingCopied(false);
    setError(null);
    try {
      const response = await issueKasiAiWhatsappPairing(selectedWhatsappConnection);
      setPairing({ token: response.pairing.token, expiresAt: response.pairing.expires_at });
    } catch (cause) {
      setError(formatAgentError(cause, "Unable to create a WhatsApp pairing code"));
    } finally {
      setPairingBusy(false);
    }
  };

  const copyPairingCode = async () => {
    if (!pairing) return;
    await navigator.clipboard.writeText(pairing.token);
    setPairingCopied(true);
  };

  const disconnectChannel = async (binding: AgentChannelBinding) => {
    if (!installation || disconnectingBindingId) return;
    if (!window.confirm(`Disconnect ${channelLabel(binding.channel_type)} from KasiAi? Existing messages will remain in conversation history.`)) return;
    setDisconnectingBindingId(binding.id);
    setError(null);
    try {
      await disconnectKasiAiChannel(binding.id);
      await refreshChannels(installation.id);
    } catch (cause) {
      setError(formatAgentError(cause, `Unable to disconnect ${channelLabel(binding.channel_type)}`));
    } finally {
      setDisconnectingBindingId(null);
    }
  };

  const availableChannels = useMemo(
    () => Array.from(new Set([
      ...messages.map(messageChannel),
      ...channelBindings.filter((binding) => binding.status === "active").map((binding) => binding.channel_type),
    ])).sort(),
    [channelBindings, messages],
  );
  const visibleMessages = useMemo(
    () => channelFilter === "all" ? messages : messages.filter((message) => messageChannel(message) === channelFilter),
    [channelFilter, messages],
  );

  useEffect(() => {
    if (channelFilter !== "all" && !availableChannels.includes(channelFilter)) setChannelFilter("all");
  }, [availableChannels, channelFilter]);

  const retryInitialization = () => {
    initializationAttempted.current = false;
    setConversation(null);
    setInstallation(null);
    setMessages([]);
    setError(null);
    setLoading(false);
    setInitializationKey((key) => key + 1);
  };

  if (!open) return null;

  return (
    <aside
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex max-w-full flex-col border-l border-border bg-background shadow-2xl",
        resizing ? "select-none" : null,
      )}
      style={{ width: `min(${panelWidth}px, 100vw)` }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="kasiai-chat-title"
      aria-describedby="kasiai-chat-description"
      tabIndex={-1}
    >
      <div
        className="group absolute inset-y-0 -left-2 z-10 hidden w-4 cursor-ew-resize touch-none items-center justify-center sm:flex"
        onPointerDown={beginResize}
        onPointerMove={updateResize}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        role="separator"
        aria-label="Resize KasiAi panel"
        aria-orientation="vertical"
        aria-valuemin={panelWidthBounds(leftOffset).min}
        aria-valuemax={panelWidthBounds(leftOffset).max}
        aria-valuenow={Math.round(panelWidth)}
        tabIndex={0}
        title="Drag to resize KasiAi"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const nextWidth = panelWidth + (event.key === "ArrowLeft" ? 24 : -24);
          const clampedWidth = clampPanelWidth(nextWidth, leftOffset);
          setPanelWidth(clampedWidth);
          window.localStorage.setItem(KASIAI_PANEL_WIDTH_KEY, String(clampedWidth));
        }}
      >
        <span className="flex h-16 w-1.5 items-center justify-center rounded-full border border-border/80 bg-card/90 shadow-sm transition-colors group-hover:border-primary/70 group-hover:bg-primary/10 group-focus-visible:border-primary group-focus-visible:ring-2 group-focus-visible:ring-ring">
          <span className="h-8 w-0.5 rounded-full bg-muted-foreground/60 transition-colors group-hover:bg-primary" />
        </span>
      </div>
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id="kasiai-chat-title" className="truncate text-sm font-semibold text-foreground">KasiAi</h2>
            <p id="kasiai-chat-description" className="text-[11px] text-muted-foreground">Your KasiTek platform guide</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" onClick={() => void startNewConversation()} disabled={!installation || sending || loading} aria-label="Start a new KasiAi conversation" title="New conversation">
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button ref={closeButton} type="button" variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close KasiAi">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {installation && conversationHistory.length ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          <label className="sr-only" htmlFor="kasiai-conversation-history">KasiAi conversation</label>
          <select
            id="kasiai-conversation-history"
            value={conversation?.id ?? ""}
            onChange={(event) => void loadConversation(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            {conversationHistory.map((item, index) => (
              <option key={item.id} value={item.id}>
                {item.is_primary ? "Current conversation" : `Previous conversation ${conversationHistory.length - index}`} · {new Date(item.updated_at).toLocaleDateString()}
              </option>
            ))}
          </select>
          <div className="flex max-w-full gap-1 overflow-x-auto" aria-label="Filter messages by channel">
            {["all", ...availableChannels].map((channel) => (
              <Button
                key={channel}
                type="button"
                variant={channelFilter === channel ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setChannelFilter(channel)}
                aria-pressed={channelFilter === channel}
              >
                {channel === "all" ? "All" : channelLabel(channel)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {installation && whatsappConnections.length && !channelBindings.some((binding) => binding.channel_type === "whatsapp" && binding.status === "active") ? (
        <div className="border-b border-border bg-muted/20 px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedWhatsappConnection}
              onChange={(event) => setSelectedWhatsappConnection(event.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-foreground"
              aria-label="WhatsApp number for KasiAi"
            >
              {whatsappConnections.map((connection) => (
                <option key={connection.id} value={connection.id}>{connection.phoneDisplayNumber || connection.phoneNumberId}</option>
              ))}
            </select>
            <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => void beginWhatsappPairing()} disabled={pairingBusy || !selectedWhatsappConnection}>
              {pairingBusy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : null}
              Connect WhatsApp
            </Button>
          </div>
          {pairing ? (
            <div className="mt-2 rounded-md border border-border bg-card p-2">
              <p className="text-muted-foreground">Send this one-time code as a WhatsApp message to the selected KasiTek number:</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap rounded bg-muted px-2 py-1 text-[11px]">{pairing.token}</code>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => void copyPairingCode()} aria-label="Copy WhatsApp pairing code">
                  {pairingCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">Expires {new Date(pairing.expiresAt).toLocaleTimeString()}.</p>
            </div>
          ) : null}
        </div>
      ) : null}

      {channelBindings.some((binding) => binding.status === "active") ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[11px] text-muted-foreground">
          <span>Connected:</span>
          {channelBindings.filter((binding) => binding.status === "active").map((binding) => (
            <span key={binding.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-1">
              {channelLabel(binding.channel_type)}
              <button
                type="button"
                className="rounded-full p-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void disconnectChannel(binding)}
                disabled={disconnectingBindingId === binding.id}
                aria-label={`Disconnect ${channelLabel(binding.channel_type)} from KasiAi`}
              >
                {disconnectingBindingId === binding.id ? <LoaderCircle className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <div ref={messagesViewport} className="flex-1 overflow-y-auto px-4 py-4" aria-busy={loading || sending}>
        {hasMoreMessages ? <div className="mb-3 flex justify-center"><Button type="button" variant="outline" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "Loading earlier…" : "Load earlier messages"}</Button></div> : null}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Preparing KasiAi…
          </div>
        ) : null}
        {!loading && installation && installation.status !== "active" ? (
          <div className="rounded-xl border border-status-attention/30 bg-status-attention-soft px-4 py-4 text-center" role="status">
            <p className="text-sm font-medium text-status-attention">KasiAi is {installation.status} for this workspace.</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Resume the installation from Agents before sending a new message.</p>
          </div>
        ) : null}
        {!loading && !messages.length && !error ? (
          <div className="rounded-xl border border-dashed border-border bg-card px-4 py-8 text-center">
            <Bot className="mx-auto h-7 w-7 text-primary" />
            <p className="mt-3 text-sm font-medium text-foreground">What can I help you find?</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Ask about your KasiTek workspace, settings, or where to complete a task.</p>
          </div>
        ) : null}
        <div className="space-y-3">
          {visibleMessages.map((message) => (
            <div key={message.id} className={cn("flex", message.direction === "outbound" ? "justify-start" : "justify-end")}>
              <div className="max-w-[88%]">
                <div className={cn("mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground", message.direction === "outbound" ? "justify-start" : "justify-end")}>
                  <span>{channelLabel(messageChannel(message))}</span>
                  {message.direction === "outbound" && message.delivery_status && message.delivery_status !== "local" ? <span>· {message.delivery_status}</span> : null}
                </div>
                <div className={cn(
                  "rounded-2xl px-3.5 py-2.5 text-sm leading-6",
                  message.direction === "outbound"
                    ? "rounded-bl-sm border border-border bg-card text-foreground"
                    : "rounded-br-sm bg-primary text-primary-foreground",
                )}>
                  {message.direction === "outbound" ? <SafeMarkdown>{messageText(message)}</SafeMarkdown> : messageText(message)}
                </div>
              </div>
            </div>
          ))}
        </div>
        {sending ? (
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            KasiAi is working…
          </div>
        ) : null}
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {loading ? "Preparing KasiAi." : sending ? "KasiAi is working." : error ?? ""}
        </div>
        <div ref={messagesEnd} />
      </div>

      {error ? (
        <div className="mx-4 mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive" role="alert">
          {error}
          <Button type="button" variant="outline" size="sm" className="mt-2 h-7 border-destructive/30 text-destructive hover:bg-destructive/10" onClick={retryInitialization}>Retry</Button>
        </div>
      ) : null}

      <footer className="border-t border-border p-3">
        <div className="rounded-xl border border-border bg-card p-2 focus-within:border-primary/50">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            placeholder="Ask KasiAi…"
            rows={2}
            disabled={loading || !installation || installation.status !== "active" || conversation?.status !== "active" || !conversation?.is_primary || Boolean(error && !conversation)}
            className="max-h-32 min-h-12 w-full resize-none bg-transparent px-1 py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            aria-label="Message KasiAi"
          />
          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</span>
            {sending ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void stop()}>
                <Square className="h-3.5 w-3.5" />
                Stop
              </Button>
            ) : (
              <Button type="button" size="sm" onClick={() => void send()} disabled={!draft.trim() || loading || !installation || installation.status !== "active" || conversation?.status !== "active" || !conversation?.is_primary}>
                <Send className="h-3.5 w-3.5" />
                Send
              </Button>
            )}
          </div>
        </div>
      </footer>
    </aside>
  );
}

export function KasiAiTrigger({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onClick}
      className={cn(
        "relative flex min-h-9 w-full items-center rounded-md text-[13px] font-medium leading-5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        collapsed ? "justify-center px-2 py-2" : "justify-start gap-2 px-2.5 py-2",
      )}
      title="Open KasiAi"
      aria-label="Open KasiAi"
    >
      <MessageCircle className="h-4 w-4 shrink-0" />
      {!collapsed ? <span>KasiAi</span> : null}
    </Button>
  );
}
