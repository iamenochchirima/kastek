"use client";

import { Button } from "@/components/ui/button";
import {
  Bot,
  RotateCcw,
  LoaderCircle,
  MessageCircle,
  Send,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelAgentRun,
  createPlatformConversation,
  ensureKasiAi,
  getPlatformConversation,
  resolvePlatformConversation,
  sendPlatformMessage,
  streamAgentRun,
  type AgentConversation,
  type AgentInstallation,
  type AgentMessage,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";

function messageText(message: AgentMessage): string {
  return typeof message.content?.text === "string" ? message.content.text : JSON.stringify(message.content);
}

function sortMessages(messages: AgentMessage[]): AgentMessage[] {
  return [...messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number));
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

export function KasiAiChat({ open, onOpenChange, leftOffset = 0 }: { open: boolean; onOpenChange: (open: boolean) => void; leftOffset?: number }) {
  const [installation, setInstallation] = useState<AgentInstallation | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
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
      setError(cause instanceof Error ? cause.message : "Unable to load earlier messages");
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
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "KasiAi is unavailable");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initializationKey, open]);

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
        setError(cause instanceof Error ? cause.message : "KasiAi could not complete this request");
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
      setError(cause instanceof Error ? cause.message : "Unable to stop the run");
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
    setLoading(true);
    setError(null);
    try {
      const response = await createPlatformConversation(installation.id);
      setConversation(response.conversation);
      setMessages(sortMessages(response.messages));
      setHasMoreMessages(Boolean(response.hasMore));
      setNextBefore(response.nextBefore ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start a new conversation");
    } finally {
      setLoading(false);
    }
  };

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
            <p className="text-[11px] text-muted-foreground">Your KasiTek platform guide</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="icon" onClick={() => void startNewConversation()} disabled={!installation || sending || loading} aria-label="Start a new KasiAi conversation" title="New conversation">
            <RotateCcw className="h-4 w-4" />
          </Button>
          <Button type="button" variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close KasiAi">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <div ref={messagesViewport} className="flex-1 overflow-y-auto px-4 py-4" aria-live="polite" aria-busy={loading || sending}>
        {hasMoreMessages ? <div className="mb-3 flex justify-center"><Button type="button" variant="outline" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>{loadingOlder ? "Loading earlier…" : "Load earlier messages"}</Button></div> : null}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Preparing KasiAi…
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
          {messages.map((message) => (
            <div key={message.id} className={cn("flex", message.direction === "outbound" ? "justify-start" : "justify-end")}>
              <div className={cn(
                "max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm leading-6",
                message.direction === "outbound"
                  ? "rounded-bl-sm border border-border bg-card text-foreground"
                  : "rounded-br-sm bg-primary text-primary-foreground",
              )}>
                {messageText(message)}
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
            disabled={loading || !installation || Boolean(error && !conversation)}
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
              <Button type="button" size="sm" onClick={() => void send()} disabled={!draft.trim() || loading || !installation}>
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
