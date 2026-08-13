"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import {
  Archive, ArrowLeft, Bot, ChevronDown, ChevronRight, Copy, LoaderCircle, MessageCircle,
  MoreHorizontal, PanelLeft, Pin, Plus, Search, Send, Settings2, SlidersHorizontal,
  Activity, Sparkles, Square, Trash2, Unlink, X,
} from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelAgentRun, disconnectKasiAiChannel, ensureKasiAi, getKasiAiHome,
  getAgentRun, getPlatformConversation, issueKasiAiWhatsappPairing, listKasiAiChannels,
  listWhatsappConnectionOptions, restoreKasiAiConversation, sendPlatformMessage,
  setKasiAiChannelDefault, setKasiAiConversationStatus, streamAgentRun,
  updateKasiAiConversation, updateKasiAiPreferences, AgentRequestError,
  type AgentChannelBinding, type AgentConversation, type AgentInstallation,
  type AgentMessage, type KasiAiHome, type KasiAiModel, type KasiAiPreferences,
  type WhatsappConnectionOption,
} from "@/lib/agent-platform";
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

const markdownComponents: Components = {
  h1: ({ children }) => <h3 className="mt-3 text-base font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mt-3 text-sm font-semibold first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="mt-2 first:mt-0">{children}</p>,
  ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5 first:mt-0">{children}</ul>,
  ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5 first:mt-0">{children}</ol>,
  code: ({ children, className }) => className
    ? <code className="my-2 block overflow-x-auto rounded-md bg-black/15 p-2 text-xs">{children}</code>
    : <code className="rounded bg-black/15 px-1 py-0.5 text-[0.85em]">{children}</code>,
  a: ({ children, href }) => /^(https?:|mailto:)/i.test(href ?? "")
    ? <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{children}</a>
    : <>{children}</>,
  table: ({ children }) => <div className="my-2 overflow-x-auto"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
  th: ({ children }) => <th className="border border-current/20 px-2 py-1 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-current/20 px-2 py-1 align-top">{children}</td>,
};

const channelLabels: Record<string, string> = { whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord" };

function channelLabel(channel: string) { return channelLabels[channel.toLowerCase()] ?? `${channel.slice(0, 1).toUpperCase()}${channel.slice(1)}`; }
function messageChannel(message: AgentMessage) { return (message.source_channel || message.provider || "platform").toLowerCase(); }
function messageText(message: AgentMessage) { return typeof message.content?.text === "string" ? message.content.text : JSON.stringify(message.content); }
function sorted(messages: AgentMessage[]) { return [...messages].sort((a, b) => Number(a.sequence_number) - Number(b.sequence_number)); }
function mergeMessages(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const durable = new Map(incoming.map((message) => [message.id, message]));
  const retained = current.filter((message) => !message.id.startsWith("optimistic-") || !incoming.some((candidate) => candidate.run_id && candidate.direction === message.direction && messageText(candidate) === messageText(message)));
  return sorted([...retained.map((message) => durable.get(message.id) ?? message), ...incoming.filter((message) => !retained.some((currentMessage) => currentMessage.id === message.id))]);
}
function displayConversationTitle(conversation: AgentConversation | null): string {
  const title = conversation?.title?.trim();
  if (!title || /^(?:hi|hello|hey|yo|new chat)(?:[!,.?\s]+)?$/i.test(title)) return "New chat";
  return title;
}
function dateGroup(iso: string) {
  const date = new Date(iso); const today = new Date(); const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date > new Date(Date.now() - 7 * 86_400_000) ? "Previous 7 days" : "Older";
}
function formatError(cause: unknown, fallback: string) {
  if (!(cause instanceof AgentRequestError)) return cause instanceof Error ? cause.message : fallback;
  if (cause.status === 503) return "KasiAi is temporarily unavailable. Check the Agent Platform and model provider, then retry.";
  if (cause.status === 409) return "KasiAi is still finishing the previous message in this chat.";
  return cause.message || fallback;
}
function panelBounds(leftOffset: number) {
  if (typeof window === "undefined") return { min: MIN_WIDTH, max: MAX_WIDTH };
  return { min: Math.min(MIN_WIDTH, window.innerWidth), max: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - (window.innerWidth >= 1024 ? leftOffset : 0))) };
}

function conversationFromUrl(): string | null {
  const value = new URL(window.location.href).searchParams.get(CHAT_URL_KEY);
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function setConversationUrl(conversationId?: string) {
  const url = new URL(window.location.href);
  if (conversationId) url.searchParams.set(CHAT_URL_KEY, conversationId);
  else url.searchParams.delete(CHAT_URL_KEY);
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

const terminalRunStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

function pauseForRunPoll(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const abort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 800);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForRunTerminal(runId: string, signal: AbortSignal): Promise<Awaited<ReturnType<typeof getAgentRun>>["run"] | null> {
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

export function KasiAiChat({ open, onOpenChange, leftOffset = 0 }: { open: boolean; onOpenChange: (open: boolean) => void; leftOffset?: number }) {
  const [installation, setInstallation] = useState<AgentInstallation | null>(null);
  const [home, setHome] = useState<KasiAiHome | null>(null);
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [view, setView] = useState<View>("chat");
  const [navigationExpanded, setNavigationExpanded] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [draft, setDraft] = useState("");
  const [channelFilter, setChannelFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState("Preparing request…");
  const [runEvents, setRunEvents] = useState<Array<{ event: string; label: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [width, setWidth] = useState(470);
  const [resizing, setResizing] = useState(false);
  const [channels, setChannels] = useState<AgentChannelBinding[]>([]);
  const [whatsappConnections, setWhatsappConnections] = useState<WhatsappConnectionOption[]>([]);
  const [selectedWhatsapp, setSelectedWhatsapp] = useState("");
  const [pairing, setPairing] = useState<{ token: string; expiresAt: string } | null>(null);
  const [preferences, setPreferences] = useState<KasiAiPreferences | null>(null);
  const [initialised, setInitialised] = useState(false);
  const streamAbort = useRef<AbortController | null>(null);
  const sendLocked = useRef(false);
  const messagesEnd = useRef<HTMLDivElement | null>(null);
  const viewport = useRef<HTMLDivElement | null>(null);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const conversationSelection = useRef(0);

  const models = home?.models ?? EMPTY_MODELS;
  const activeConversations = home?.conversations ?? [];
  const archivedConversations = home?.archivedConversations ?? [];
  const isArchivedChat = conversation?.status === "archived";
  const effectiveModel = useMemo(() => {
    if (conversation?.model_provider && conversation.model) return { provider: conversation.model_provider, model: conversation.model };
    if (preferences?.default_model_provider && preferences.default_model) return { provider: preferences.default_model_provider, model: preferences.default_model };
    return models[0] ? { provider: models[0].provider, model: models[0].model } : null;
  }, [conversation, models, preferences]);
  const activeModel = models.find((entry) => entry.provider === effectiveModel?.provider && entry.model === effectiveModel?.model) ?? models[0];

  const refreshHome = useCallback(async (installationId: string) => {
    const response = await getKasiAiHome(installationId);
    setHome(response); setPreferences(response.preferences);
    const [channelResponse, whatsapp] = await Promise.all([
      listKasiAiChannels(installationId), listWhatsappConnectionOptions().catch(() => ({ connections: [] })),
    ]);
    setChannels(channelResponse.bindings); setWhatsappConnections(whatsapp.connections);
    setSelectedWhatsapp((current) => current || whatsapp.connections[0]?.id || "");
    return response;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const selection = ++conversationSelection.current;
    streamAbort.current?.abort(); streamAbort.current = null;
    setSending(false); setActiveRunId(null); setError(null);
    const result = await getPlatformConversation(id);
    if (selection !== conversationSelection.current) return;
    setConversation(result.conversation); setMessages(sorted(result.messages)); setHasMore(Boolean(result.hasMore)); setNextBefore(result.nextBefore ?? null);
    setChannelFilter("all"); setView("chat"); window.localStorage.setItem(LAST_CHAT_KEY, id); setConversationUrl(id);
  }, []);

  useEffect(() => {
    if (open || !conversationFromUrl()) return;
    onOpenChange(true);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open || initialised) return;
    let cancelled = false;
    setLoading(true); setError(null);
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
          setConversation(null); setMessages([]); setHasMore(false); setNextBefore(null); setChannelFilter("all");
          window.localStorage.removeItem(LAST_CHAT_KEY);
        }
        setDraft(window.localStorage.getItem(DRAFT_KEY) ?? ""); setInitialised(true);
      } catch (cause) { if (!cancelled) setError(formatError(cause, "Unable to open KasiAi")); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [initialised, loadConversation, open, refreshHome]);

  useEffect(() => {
    if (open) return;
    conversationSelection.current += 1;
    setInitialised(false); streamAbort.current?.abort();
    setConversation(null); setMessages([]); setHasMore(false); setNextBefore(null); setChannelFilter("all");
    setLastRunId(null); setRunProgress("Preparing request…");
  }, [open]);
  useEffect(() => {
    if (!pairing || !installation) return;
    const timer = window.setInterval(() => {
      void refreshHome(installation.id)
        .then(() => listKasiAiChannels(installation.id))
        .then((result) => {
          if (result.bindings.some((binding) => binding.channel_type === "whatsapp" && binding.status === "active")) setPairing(null);
        })
        .catch(() => undefined);
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [installation, pairing, refreshHome]);
  useEffect(() => { window.localStorage.setItem(DRAFT_KEY, draft); }, [draft]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: sending ? "smooth" : "auto", block: "end" }); }, [messages, sending]);
  const polledConversationId = conversation?.id;
  useEffect(() => {
    if (!open || !polledConversationId || document.visibilityState === "hidden") return;
    let cancelled = false;
    const conversationId = polledConversationId;
    const selection = conversationSelection.current;
    const timer = window.setInterval(() => void getPlatformConversation(conversationId, { limit: 100 }).then((result) => {
      if (cancelled || selection !== conversationSelection.current) return;
      setConversation((current) => current?.id === conversationId ? result.conversation : current);
      setMessages((current) => mergeMessages(current, result.messages));
    }).catch(() => undefined), 4_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [open, polledConversationId]);
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(saved)) { const bounds = panelBounds(leftOffset); setWidth(Math.min(bounds.max, Math.max(bounds.min, saved))); }
  }, [leftOffset]);

  const newChat = () => {
    conversationSelection.current += 1; streamAbort.current?.abort(); streamAbort.current = null;
    setConversation(null); setMessages([]); setHasMore(false); setNextBefore(null); setDraft(""); setChannelFilter("all"); setView("chat");
    sendLocked.current = false; setSending(false); setActiveRunId(null); setLastRunId(null); setRunProgress("Preparing request…"); setRunEvents([]); setError(null); window.localStorage.removeItem(LAST_CHAT_KEY); setConversationUrl();
  };
  const close = () => { newChat(); setInitialised(false); onOpenChange(false); };
  const send = async (suggestion?: string) => {
    const text = (suggestion ?? draft).trim();
    if (!text || !installation || sending || sendLocked.current) return;
    sendLocked.current = true;
    const selection = conversationSelection.current;
    const targetConversation = conversation;
    setDraft(""); setError(null); setSending(true);
    const optimistic: AgentMessage = { id: `optimistic-${crypto.randomUUID()}`, conversation_id: targetConversation?.id ?? "new", direction: "inbound", message_type: "text", content: { text }, sequence_number: Number.MAX_SAFE_INTEGER, created_at: new Date().toISOString() };
    setMessages((items) => [...items, optimistic]);
    try {
      const accepted = await sendPlatformMessage(installation.id, {
        message: text, idempotencyKey: crypto.randomUUID(), conversationId: targetConversation?.id,
        createNew: !targetConversation, modelProvider: !targetConversation ? effectiveModel?.provider : undefined, model: !targetConversation ? effectiveModel?.model : undefined,
        context: { route: window.location.pathname, pageTitle: document.title },
      });
      if (selection !== conversationSelection.current) return;
      setMessages((current) => mergeMessages(current.filter((message) => message.id !== optimistic.id), [accepted.message]));
      setConversation(accepted.conversation); window.localStorage.setItem(LAST_CHAT_KEY, accepted.conversation.id); setConversationUrl(accepted.conversation.id);
      setActiveRunId(accepted.runId); setLastRunId(accepted.runId); setRunProgress("Run accepted; building context…"); setRunEvents([{ event: "run.received", label: "Run accepted" }]);
      const controller = new AbortController(); streamAbort.current = controller; let cursor = 0; let terminal = false;
      for (let attempt = 0; attempt < 3 && !terminal; attempt += 1) {
        try {
          const streamed = await streamAgentRun(accepted.runId, (event) => {
            const sequence = Number(event.data.sequence_number); if (Number.isSafeInteger(sequence)) cursor = Math.max(cursor, sequence);
            const name = typeof event.data.name === "string" ? event.data.name : "";
            const label = event.event.includes("tool") ? (name ? `Tool: ${name}` : "Tool activity")
              : event.event.includes("model") ? "Model response"
                : event.event.includes("context") ? "Context prepared"
                  : event.event.includes("approval") ? "Approval required"
                    : event.event.includes("failed") ? "Run failed"
                      : event.event.includes("completed") ? "Run completed" : event.event.replace(/^agent\./, "");
            setRunEvents((current) => [...current.filter((entry) => entry.event !== event.event || entry.label !== label).slice(-4), { event: event.event, label }]);
            if (event.event.includes("tool")) setRunProgress(name ? `Tool activity: ${name}` : "Tool activity in progress…");
            else if (event.event.includes("model")) setRunProgress("Model response in progress…");
            else if (event.event.includes("context")) setRunProgress("Context prepared; starting model…");
            else if (event.event.includes("approval")) setRunProgress("Waiting for approval…");
            else if (event.event.includes("failed")) setRunProgress("Run failed");
            else if (event.event.includes("completed")) setRunProgress("Run completed");
          }, controller.signal, cursor);
          cursor = streamed.lastSequence; terminal = streamed.terminal;
        } catch (streamError) {
          if (streamError instanceof DOMException && streamError.name === "AbortError") throw streamError;
          break;
        }
      }
      let terminalRun: Awaited<ReturnType<typeof getAgentRun>>["run"] | null = null;
      try { terminalRun = terminal ? (await getAgentRun(accepted.runId)).run : await waitForRunTerminal(accepted.runId, controller.signal); }
      catch (cause) { if (cause instanceof DOMException && cause.name === "AbortError") throw cause; }
      if (terminalRun && terminalRun.status !== "completed") {
        setRunProgress(`Run ${terminalRun.status.replaceAll("_", " ")}`);
        throw new Error(terminalRun.error?.message || "KasiAi could not complete this request");
      }
      if (terminalRun?.status === "completed") setRunProgress("Run completed");
      try {
        const [result] = await Promise.all([getPlatformConversation(accepted.conversation.id), refreshHome(installation.id)]);
        if (selection !== conversationSelection.current) return;
        setConversation(result.conversation); setMessages((current) => mergeMessages(current, result.messages)); setHasMore(Boolean(result.hasMore)); setNextBefore(result.nextBefore ?? null);
      } catch {
        // Conversation polling will reconcile a completed response once the connection is available again.
      }
    } catch (cause) {
      if (selection === conversationSelection.current) {
        setMessages((current) => current.filter((message) => message.id !== optimistic.id));
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(formatError(cause, "KasiAi could not complete this request"));
      }
    } finally {
      if (selection === conversationSelection.current) { sendLocked.current = false; streamAbort.current = null; setActiveRunId(null); setSending(false); }
    }
  };
  const stop = async () => { if (!activeRunId) return; setRunProgress("Cancellation requested…"); await cancelAgentRun(activeRunId).catch(() => undefined); streamAbort.current?.abort(); setSending(false); setActiveRunId(null); };
  const changeModel = async (value: string) => {
    if (!conversation) return;
    const [provider, ...parts] = value.split(":"); const model = parts.join(":");
    try { const updated = await updateKasiAiConversation(conversation.id, { modelProvider: provider as KasiAiModel["provider"], model }); setConversation(updated); await refreshHome(installation!.id); }
    catch (cause) { setError(formatError(cause, "Unable to change this chat's model")); }
  };
  const loadOlder = async () => { if (!conversation || !hasMore || !nextBefore) return; const result = await getPlatformConversation(conversation.id, { limit: 50, before: nextBefore }); setMessages((items) => sorted([...result.messages, ...items.filter((item) => !result.messages.some((older) => older.id === item.id))])); setHasMore(Boolean(result.hasMore)); setNextBefore(result.nextBefore ?? null); };
  const updatePreference = async (change: Parameters<typeof updateKasiAiPreferences>[1]) => { if (!installation) return; try { const response = await updateKasiAiPreferences(installation.id, change); setPreferences(response.preferences); await refreshHome(installation.id); } catch (cause) { setError(formatError(cause, "Unable to save KasiAi settings")); } };
  const editTitle = async (item: AgentConversation) => { const title = window.prompt("Rename conversation", item.title ?? ""); if (!title?.trim()) return; const updated = await updateKasiAiConversation(item.id, { title: title.trim() }); if (conversation?.id === item.id) setConversation(updated); await refreshHome(installation!.id); };
  const archiveConversation = async (item: AgentConversation) => { if (!window.confirm(`Archive “${item.title ?? "this conversation"}”?`)) return; await setKasiAiConversationStatus(item.id, "archived"); if (conversation?.id === item.id) newChat(); await refreshHome(installation!.id); };
  const deleteConversation = async (item: AgentConversation) => { if (!window.confirm(`Delete “${item.title ?? "this conversation"}”? This cannot be undone.`)) return; await setKasiAiConversationStatus(item.id, "deleted"); if (conversation?.id === item.id) newChat(); await refreshHome(installation!.id); };
  const connectWhatsapp = async () => { if (!selectedWhatsapp) return; try { const response = await issueKasiAiWhatsappPairing(selectedWhatsapp); setPairing({ token: response.pairing.token, expiresAt: response.pairing.expires_at }); } catch (cause) { setError(formatError(cause, "Unable to create pairing code")); } };
  const disconnect = async (binding: AgentChannelBinding) => { if (!window.confirm(`Disconnect ${channelLabel(binding.channel_type)}? Existing history will remain.`)) return; await disconnectKasiAiChannel(binding.id); await refreshHome(installation!.id); };
  const visibleMessages = channelFilter === "all" ? messages : messages.filter((message) => messageChannel(message) === channelFilter);
  const availableChannels = Array.from(new Set(messages.map(messageChannel).filter((channel) => channel !== "platform"))).sort();
  const suggestions = window.location.pathname.includes("campaign") ? ["Help me create a campaign", "What should I check before sending?", "Explain this page", "Show my recent campaign activity"] : ["What needs my attention?", "Show me around this page", "Check my connected accounts", "Help me get started"];
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => { if (window.innerWidth < 640) return; event.currentTarget.setPointerCapture(event.pointerId); resizeStart.current = { x: event.clientX, width }; setResizing(true); };
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => { if (!resizeStart.current) return; const bounds = panelBounds(leftOffset); setWidth(Math.min(bounds.max, Math.max(bounds.min, resizeStart.current.width + resizeStart.current.x - event.clientX))); };
  const finishResize = () => { resizeStart.current = null; setResizing(false); window.localStorage.setItem(PANEL_WIDTH_KEY, String(width)); };

  if (!open) return null;
  return <aside className={cn("fixed inset-y-0 right-0 z-50 flex max-w-full flex-col border-l border-border bg-background shadow-2xl", resizing && "select-none")} style={{ width: `min(${width}px, 100vw)` }} role="dialog" aria-label="KasiAi">
    <div className="absolute inset-y-0 -left-2 z-10 hidden w-4 cursor-ew-resize sm:block" onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={finishResize} aria-label="Resize KasiAi" role="separator" />
    <header className="flex h-16 items-center justify-between border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary"><Sparkles className="h-4 w-4" /></span><div className="min-w-0"><h2 className="truncate text-sm font-semibold">{displayConversationTitle(conversation)}</h2><p className="truncate text-[11px] text-muted-foreground">{conversation?.is_primary ? "Channel-default chat" : "Your platform agent"}</p></div></div>
      <div className="flex items-center gap-1">{conversation ? <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void navigator.clipboard.writeText(window.location.href)} aria-label="Copy chat link" title="Copy chat link"><Copy className="h-4 w-4" /></Button> : null}<Button variant="ghost" size="icon" className="h-8 w-8" onClick={close} aria-label="Close KasiAi"><X className="h-4 w-4" /></Button></div>
    </header>
    <div className="flex min-h-0 flex-1">
    <KasiAiNavigation expanded={navigationExpanded} view={view} conversations={activeConversations} selectedId={conversation?.id} onToggle={() => setNavigationExpanded((current) => !current)} onNew={newChat} onChats={() => setView("library")} onSettings={() => setView("settings")} onOpen={(item) => void loadConversation(item.id)} />
    <div className="flex min-w-0 flex-1 flex-col">
    {view === "library" ? <ConversationLibrary conversations={activeConversations} archived={archivedConversations} selectedId={conversation?.id} search={search} onSearch={setSearch} onBack={() => setView("chat")} onNew={newChat} onOpen={(item) => void loadConversation(item.id)} onRename={(item) => void editTitle(item)} onPin={(item) => void updateKasiAiConversation(item.id, { pinned: !item.pinned }).then(() => refreshHome(installation!.id))} onArchive={(item) => void archiveConversation(item)} onDelete={(item) => void deleteConversation(item)} onRestore={(item) => void restoreKasiAiConversation(item.id).then(() => refreshHome(installation!.id))} /> : null}
    {view === "settings" ? <KasiAiSettings section={settingsSection} onSection={setSettingsSection} onBack={() => setView("chat")} preferences={preferences} models={models} modelCatalog={home?.modelCatalog} selectedModel={preferences?.default_model_provider && preferences.default_model ? { provider: preferences.default_model_provider, model: preferences.default_model } : (models[0] ? { provider: models[0].provider, model: models[0].model } : null)} channels={channels} whatsappConnections={whatsappConnections} selectedWhatsapp={selectedWhatsapp} onWhatsapp={setSelectedWhatsapp} pairing={pairing} onPair={() => void connectWhatsapp()} onCopy={() => pairing && navigator.clipboard.writeText(pairing.token)} onDisconnect={(binding) => void disconnect(binding)} onPreference={(input) => void updatePreference(input)} /> : null}
    {view === "chat" ? <>
      {loading ? <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />Preparing KasiAi…</div> : <>
        {conversation ? <div ref={viewport} className="flex-1 overflow-y-auto px-4 py-5">{hasMore ? <div className="mb-3 text-center"><Button variant="outline" size="sm" onClick={() => void loadOlder()}>Load earlier messages</Button></div> : null}{availableChannels.length ? <div className="mb-4 flex gap-1 overflow-x-auto">{["all", ...availableChannels].map((channel) => <Button key={channel} variant={channelFilter === channel ? "secondary" : "ghost"} size="sm" className="h-7 px-2 text-[11px]" onClick={() => setChannelFilter(channel)}>{channel === "all" ? "All messages" : channelLabel(channel)}</Button>)}</div> : null}<div className="mx-auto max-w-3xl space-y-4">{visibleMessages.map((message) => { const source = messageChannel(message); const delivery = message.direction === "outbound" && message.delivery_status && message.delivery_status !== "local" ? ` · ${message.delivery_status}` : ""; return <div key={message.id} className={cn("flex", message.direction === "outbound" ? "justify-start" : "justify-end")}><div className="max-w-[88%]">{source !== "platform" ? <div className={cn("mb-1 text-[10px] text-muted-foreground", message.direction === "outbound" ? "text-left" : "text-right")}>{channelLabel(source)}{delivery}</div> : null}<div className={cn("rounded-2xl px-3.5 py-2.5 text-sm leading-6", message.direction === "outbound" ? "rounded-bl-sm border border-border bg-card" : "rounded-br-sm bg-primary text-primary-foreground")}>{message.direction === "outbound" ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents} skipHtml>{messageText(message)}</ReactMarkdown> : messageText(message)}</div></div></div>; })}</div>{lastRunId ? <div className="mx-auto mt-5 max-w-3xl rounded-lg border border-border bg-card px-3 py-2 text-xs"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2 text-muted-foreground"><Activity className="h-3.5 w-3.5 shrink-0 text-primary" /><span className="truncate">{runProgress}</span></div><Link href={`/agents/activity/${encodeURIComponent(lastRunId)}`} className="shrink-0 font-medium text-primary hover:underline">View activity</Link></div>{runEvents.length ? <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Run activity">{runEvents.map((entry, index) => <span key={`${entry.event}-${index}`} className={cn("rounded-full px-2 py-0.5 text-[10px]", entry.event.includes("failed") ? "bg-destructive/10 text-destructive" : entry.event.includes("approval") ? "bg-status-attention-soft text-status-attention" : "bg-secondary text-muted-foreground")}>{entry.label}</span>)}</div> : null}</div> : null}{sending ? <div className="mx-auto mt-3 flex max-w-3xl items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />KasiAi is working…</div> : null}<div ref={messagesEnd} /></div> : <NewChatHome suggestions={suggestions} onSuggestion={(suggestion) => void send(suggestion)} />}
        {error ? <div className="mx-4 mb-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{error}</div> : null}
        <footer className="border-t border-border p-3">{isArchivedChat ? <div className="rounded-xl border border-border bg-muted/40 px-3 py-3 text-xs text-muted-foreground">This chat is archived. Restore it from the conversation library to continue it.</div> : <div className="rounded-xl border border-border bg-card p-2 focus-within:border-primary/50"><div className="mb-1 flex items-center justify-between gap-2"><ComposerModelPicker model={activeModel} models={models} disabled={!conversation || sending} onSelect={(value) => void changeModel(value)} />{conversation && !conversation.is_primary ? <Button variant="ghost" size="sm" className="h-6 text-[10px]" onClick={() => void setKasiAiChannelDefault(conversation.id).then(async (updated) => { setConversation(updated); await refreshHome(installation!.id); })}>Use for channels</Button> : null}</div><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={conversation ? "Ask KasiAi…" : "Start a new chat…"} rows={2} disabled={sending || !installation} className="min-h-12 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none" aria-label="Message KasiAi" /><div className="flex items-center justify-between pt-1"><span className="text-[10px] text-muted-foreground">Enter to send · Shift+Enter for a new line</span>{sending ? <Button variant="outline" size="sm" onClick={() => void stop()}><Square className="h-3.5 w-3.5" />Stop</Button> : <Button size="sm" disabled={!draft.trim() || !installation} onClick={() => void send()}><Send className="h-3.5 w-3.5" />Send</Button>}</div></div>}</footer>
      </>}
    </> : null}
    </div>
    </div>
  </aside>;
}

function NewChatHome({ suggestions, onSuggestion }: { suggestions: string[]; onSuggestion: (suggestion: string) => void }) {
  return <div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="h-6 w-6" /></span><h3 className="mt-4 text-lg font-semibold">How can I help?</h3><div className="mt-6 grid w-full max-w-md gap-2 sm:grid-cols-2">{suggestions.map((suggestion) => <button key={suggestion} type="button" onClick={() => onSuggestion(suggestion)} className="rounded-xl border border-border bg-card p-3 text-left text-xs transition-colors hover:border-primary/50 hover:bg-muted">{suggestion}<ChevronRight className="mt-2 h-3.5 w-3.5 text-muted-foreground" /></button>)}</div></div>;
}

function KasiAiNavigation({ expanded, view, conversations, selectedId, onToggle, onNew, onChats, onSettings, onOpen }: { expanded: boolean; view: View; conversations: AgentConversation[]; selectedId?: string; onToggle: () => void; onNew: () => void; onChats: () => void; onSettings: () => void; onOpen: (conversation: AgentConversation) => void }) {
  const actionClass = (active = false) => cn("flex h-9 items-center rounded-md text-sm transition-colors hover:bg-muted", expanded ? "w-full gap-2 px-2.5" : "w-9 justify-center", active && "bg-muted text-foreground");
  return <nav className={cn("flex shrink-0 flex-col border-r border-border bg-card/30 p-2 transition-[width] duration-200", expanded ? "w-56" : "w-14")} aria-label="KasiAi navigation"><div className={cn("mb-2 flex items-center", expanded ? "justify-between px-1" : "justify-center")}><span className={cn("text-sm font-semibold", !expanded && "sr-only")}>KasiAi</span><Button variant="ghost" size="icon" className="h-8 w-8" onClick={onToggle} aria-label={expanded ? "Collapse KasiAi navigation" : "Expand KasiAi navigation"}><PanelLeft className={cn("h-4 w-4 transition-transform", expanded && "rotate-180")} /></Button></div><button type="button" onClick={onNew} className={actionClass(view === "chat" && !selectedId)} title="New chat"><Plus className="h-4 w-4 shrink-0" />{expanded ? <span>New chat</span> : null}</button><button type="button" onClick={onChats} className={actionClass(view === "library")} title="Chats"><MessageCircle className="h-4 w-4 shrink-0" />{expanded ? <span>Chats</span> : null}</button><button type="button" onClick={onSettings} className={actionClass(view === "settings")} title="Settings"><Settings2 className="h-4 w-4 shrink-0" />{expanded ? <span>Settings</span> : null}</button>{expanded ? <div className="mt-5 min-h-0 flex-1 overflow-y-auto"><p className="px-2 pb-2 text-[11px] font-medium text-muted-foreground">Recents</p><div className="space-y-0.5">{conversations.map((conversation) => <button type="button" key={conversation.id} onClick={() => onOpen(conversation)} className={cn("w-full truncate rounded-md px-2 py-2 text-left text-xs hover:bg-muted", conversation.id === selectedId && "bg-muted font-medium")} title={displayConversationTitle(conversation)}>{conversation.pinned ? "• " : ""}{displayConversationTitle(conversation)}</button>)}{!conversations.length ? <p className="px-2 py-2 text-xs text-muted-foreground">No chats yet.</p> : null}</div></div> : null}</nav>;
}

function ComposerModelPicker({ model, models, disabled, onSelect }: { model?: KasiAiModel; models: KasiAiModel[]; disabled: boolean; onSelect: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = model ? `${model.provider}:${model.model}` : "";
  const visible = open && !disabled;
  return <div className="relative min-w-0"><button type="button" disabled={disabled} onClick={() => setOpen((value) => !value)} className="flex max-w-[14rem] items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60" aria-haspopup="listbox" aria-expanded={visible}><span className="truncate">{model?.label ?? "Workspace default"}</span><ChevronDown className="h-3.5 w-3.5 shrink-0" /></button>{visible ? <><button type="button" className="fixed inset-0 z-10 cursor-default" onClick={() => setOpen(false)} aria-label="Close model picker" /><div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-xl" role="listbox" aria-label="Choose this chat's model"><div className="border-b border-border px-3 py-2 text-[10px] text-muted-foreground">Choose a model for this chat</div><div className="max-h-64 overflow-y-auto p-1">{models.map((item) => { const value = `${item.provider}:${item.model}`; const active = value === selected; return <button type="button" key={value} role="option" aria-selected={active} onClick={() => { onSelect(value); setOpen(false); }} className={cn("w-full rounded-md px-2.5 py-2 text-left transition-colors", active ? "bg-primary/10 text-primary" : "hover:bg-muted")}><div className="flex items-center justify-between gap-2"><span className="truncate text-xs font-medium">{item.label}</span><span className="shrink-0 text-[10px] text-muted-foreground">{item.isFree ? "free" : item.tier}</span></div><p className="mt-0.5 truncate text-[10px] text-muted-foreground">{item.provider} · {item.model}</p></button>; })}</div></div></> : null}</div>;
}

function ConversationLibrary({ conversations, archived, selectedId, search, onSearch, onBack, onNew, onOpen, onRename, onPin, onArchive, onDelete, onRestore }: { conversations: AgentConversation[]; archived: AgentConversation[]; selectedId?: string; search: string; onSearch: (value: string) => void; onBack: () => void; onNew: () => void; onOpen: (item: AgentConversation) => void; onRename: (item: AgentConversation) => void; onPin: (item: AgentConversation) => void; onArchive: (item: AgentConversation) => void; onDelete: (item: AgentConversation) => void; onRestore: (item: AgentConversation) => void }) {
  const filtered = conversations.filter((item) => displayConversationTitle(item).toLowerCase().includes(search.toLowerCase()));
  const groups = ["Today", "Yesterday", "Previous 7 days", "Older"].map((label) => [label, filtered.filter((item) => dateGroup(item.updated_at) === label)] as const).filter(([, items]) => items.length);
  return <div className="flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-2 border-b border-border p-4"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button><h3 className="flex-1 text-sm font-semibold">Conversations</h3><Button size="sm" onClick={onNew}><Plus className="h-3.5 w-3.5" />New chat</Button></div><div className="border-b border-border p-3"><label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search chats" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label></div><div className="flex-1 overflow-y-auto p-3">{groups.map(([label, items]) => <section key={label} className="mb-5"><h4 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{label}</h4>{items.map((item) => <ConversationRow key={item.id} item={item} selected={item.id === selectedId} onOpen={onOpen} onRename={onRename} onPin={onPin} onArchive={onArchive} onDelete={onDelete} />)}</section>)}{!filtered.length ? <p className="px-2 py-8 text-center text-sm text-muted-foreground">No conversations found.</p> : null}{archived.length ? <section className="border-t border-border pt-4"><h4 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">Archived</h4>{archived.map((item) => <div key={item.id} className="flex items-center gap-1 rounded-lg px-2 py-2 text-sm text-muted-foreground"><button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => onOpen(item)}>{displayConversationTitle(item)}</button><Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={() => onRestore(item)}>Restore</Button><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onDelete(item)}><Trash2 className="h-3.5 w-3.5" /></Button></div>)}</section> : null}</div></div>;
}

function ConversationRow({ item, selected, onOpen, onRename, onPin, onArchive, onDelete }: { item: AgentConversation; selected: boolean; onOpen: (item: AgentConversation) => void; onRename: (item: AgentConversation) => void; onPin: (item: AgentConversation) => void; onArchive: (item: AgentConversation) => void; onDelete: (item: AgentConversation) => void }) {
  return <div className={cn("group flex items-center gap-1 rounded-lg px-2 py-2", selected && "bg-muted")}><button type="button" onClick={() => onOpen(item)} className="min-w-0 flex-1 text-left"><span className="flex items-center gap-1 truncate text-sm">{item.pinned ? <Pin className="h-3 w-3 shrink-0 text-primary" /> : null}{displayConversationTitle(item)}</span><span className="mt-0.5 block text-[10px] text-muted-foreground">{item.is_primary ? "Connected channels" : new Date(item.updated_at).toLocaleDateString()}</span></button><div className="hidden gap-0.5 group-hover:flex group-focus-within:flex"><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onRename(item)} aria-label="Rename"><MoreHorizontal className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onPin(item)} aria-label="Pin"><Pin className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onArchive(item)} aria-label="Archive"><Archive className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => onDelete(item)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></Button></div></div>;
}

function KasiAiSettings({ section, onSection, onBack, preferences, models, modelCatalog, selectedModel, channels, whatsappConnections, selectedWhatsapp, onWhatsapp, pairing, onPair, onCopy, onDisconnect, onPreference }: { section: SettingsSection; onSection: (value: SettingsSection) => void; onBack: () => void; preferences: KasiAiPreferences | null; models: KasiAiModel[]; modelCatalog?: KasiAiHome["modelCatalog"]; selectedModel: { provider: string; model: string } | null; channels: AgentChannelBinding[]; whatsappConnections: WhatsappConnectionOption[]; selectedWhatsapp: string; onWhatsapp: (value: string) => void; pairing: { token: string; expiresAt: string } | null; onPair: () => void; onCopy: () => void; onDisconnect: (binding: AgentChannelBinding) => void; onPreference: (input: Parameters<typeof updateKasiAiPreferences>[1]) => void }) {
  const [modelSearch, setModelSearch] = useState("");
  const normalizedSearch = modelSearch.trim().toLowerCase();
  const matchingModels = models.filter((model) => !normalizedSearch || `${model.label} ${model.model} ${model.provider}`.toLowerCase().includes(normalizedSearch));
  const displayedModels = matchingModels.slice(0, normalizedSearch ? 100 : 30);
  const nav: Array<[SettingsSection, string, typeof SlidersHorizontal]> = [["general", "General", SlidersHorizontal], ["model", "Model", Sparkles], ["connections", "Connections", MessageCircle], ["memory", "Memory & privacy", Bot]];
  if (shouldShowModelSettings(section)) return <KasiAiModelSettings onBack={onBack} onSection={onSection} models={models} modelCatalog={modelCatalog} selectedModel={selectedModel} onPreference={onPreference} />;
  return <div className="flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-2 border-b border-border p-4"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button><h3 className="text-sm font-semibold">KasiAi settings</h3></div><div className="flex min-h-0 flex-1"><nav className="w-36 shrink-0 border-r border-border p-2">{nav.map(([key, label, Icon]) => <button key={key} type="button" onClick={() => onSection(key)} className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs", section === key ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60")}><Icon className="h-3.5 w-3.5" />{label}</button>)}</nav><div className="min-w-0 flex-1 overflow-y-auto p-4">{section === "general" ? <div className="space-y-5"><SettingTitle title="General" description="These preferences apply to your new KasiAi responses." /><SelectSetting label="Response style" value={preferences?.tone ?? "balanced"} options={[["concise", "Concise"], ["balanced", "Balanced"], ["detailed", "Detailed"]]} onChange={(tone) => onPreference({ tone: tone as "concise" | "balanced" | "detailed" })} /><SelectSetting label="Response detail" value={preferences?.response_detail ?? "standard"} options={[["concise", "Concise"], ["standard", "Standard"], ["detailed", "Detailed"]]} onChange={(responseDetail) => onPreference({ responseDetail: responseDetail as "concise" | "standard" | "detailed" })} /><Toggle label="Notifications" description="Show updates when KasiAi completes a task." checked={preferences?.notifications_enabled ?? true} onChange={(notificationsEnabled) => onPreference({ notificationsEnabled })} /></div> : null}{section === "model" ? <div className="space-y-4"><SettingTitle title="Default model" description="Used for new chats. OpenRouter's full live text-model catalog is available through your configured OpenRouter account." /><label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="Search models, labs, or IDs…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label><div className="flex flex-wrap gap-1 text-[10px] text-muted-foreground"><span>{matchingModels.length} model{matchingModels.length === 1 ? "" : "s"}</span><span>·</span><span>{modelCatalog?.source === "live" ? "Live OpenRouter catalog" : "Cached fallback catalog"}</span></div>{modelCatalog?.error ? <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">The live catalog is unavailable right now; showing safe fallback models.</p> : null}<div className="space-y-2">{displayedModels.map((item) => <button type="button" key={`${item.provider}:${item.model}`} onClick={() => onPreference({ defaultModelProvider: item.provider, defaultModel: item.model })} className={cn("w-full rounded-lg border p-3 text-left", selectedModel?.provider === item.provider && selectedModel.model === item.model ? "border-primary bg-primary/5" : "border-border hover:bg-muted/60")}><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{item.label}</span><span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px]">{item.isFree ? "free" : item.tier}</span></div><p className="mt-1 truncate text-[11px] text-muted-foreground">{item.provider} · {item.model}</p><div className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted-foreground">{item.isWorkspaceDefault ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">workspace default</span> : null}{item.supportsTools ? <span className="rounded bg-muted px-1.5 py-0.5">tools</span> : <span className="rounded bg-muted px-1.5 py-0.5">chat only</span>}{item.contextWindow ? <span className="rounded bg-muted px-1.5 py-0.5">{Math.round(item.contextWindow / 1000)}k context</span> : null}{item.inputUsdPerMillion !== undefined ? <span className="rounded bg-muted px-1.5 py-0.5">${item.inputUsdPerMillion}/M in</span> : null}</div></button>)}</div>{matchingModels.length > displayedModels.length ? <p className="text-center text-xs text-muted-foreground">Showing {displayedModels.length} of {matchingModels.length}. Refine your search to find any model.</p> : null}</div> : null}{section === "connections" ? <div className="space-y-5"><SettingTitle title="Connections" description="Connect personal channels to the designated channel-default conversation." />{channels.filter((binding) => binding.status === "active").map((binding) => <div key={binding.id} className="flex items-center justify-between rounded-lg border border-border p-3"><div><p className="text-sm font-medium">{channelLabel(binding.channel_type)}</p><p className="text-xs text-muted-foreground">Connected</p></div><Button variant="outline" size="sm" onClick={() => onDisconnect(binding)}><Unlink className="h-3.5 w-3.5" />Disconnect</Button></div>)}{whatsappConnections.length && !channels.some((binding) => binding.channel_type === "whatsapp" && binding.status === "active") ? <div className="rounded-lg border border-border p-3"><p className="text-sm font-medium">Connect WhatsApp</p><p className="mt-1 text-xs text-muted-foreground">Send a one-time code to your selected KasiTek WhatsApp number.</p><div className="mt-3 flex gap-2"><select value={selectedWhatsapp} onChange={(event) => onWhatsapp(event.target.value)} className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 text-xs">{whatsappConnections.map((connection) => <option key={connection.id} value={connection.id}>{connection.phoneDisplayNumber || connection.phoneNumberId}</option>)}</select><Button size="sm" onClick={onPair}>Connect</Button></div>{pairing ? <div className="mt-3 rounded-md bg-muted p-2"><code className="break-all text-[11px]">{pairing.token}</code><Button variant="ghost" size="sm" className="mt-1 h-7" onClick={onCopy}><Copy className="h-3 w-3" />Copy</Button><p className="mt-1 text-[10px] text-muted-foreground">Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</p></div> : null}</div> : null}{!channels.length && !whatsappConnections.length ? <p className="text-sm text-muted-foreground">No supported personal channel is available in this workspace yet.</p> : null}</div> : null}{section === "memory" ? <div className="space-y-5"><SettingTitle title="Memory & privacy" description="Control how KasiAi uses saved preferences across chats." /><Toggle label="Use saved preferences" description="Use your saved language, style, and preference settings." checked={preferences?.use_saved_preferences ?? true} onChange={(useSavedPreferences) => onPreference({ useSavedPreferences })} /><Toggle label="Reference previous chats" description="Allow future KasiAi improvements to use relevant prior chat context. Current conversation context is always isolated." checked={preferences?.reference_previous_chats ?? false} onChange={(referencePreviousChats) => onPreference({ referencePreviousChats })} /><p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">Deleting a chat removes its conversation-specific summary and memory. Saved user preferences are kept until you change them.</p></div> : null}</div></div></div>;
}

function shouldShowModelSettings(section: SettingsSection): boolean { return section === "model"; }

function KasiAiModelSettings({ onBack, onSection, models, modelCatalog, selectedModel, onPreference }: { onBack: () => void; onSection: (value: SettingsSection) => void; models: KasiAiModel[]; modelCatalog?: KasiAiHome["modelCatalog"]; selectedModel: { provider: string; model: string } | null; onPreference: (input: Parameters<typeof updateKasiAiPreferences>[1]) => void }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const current = models.find((model) => model.provider === selectedModel?.provider && model.model === selectedModel.model) ?? models[0];
  const matching = models.filter((model) => !search.trim() || `${model.label} ${model.model} ${model.provider}`.toLowerCase().includes(search.trim().toLowerCase()));
  const displayed = matching.slice(0, search.trim() ? 100 : 30);
  const nav: Array<[SettingsSection, string, typeof SlidersHorizontal]> = [["general", "General", SlidersHorizontal], ["model", "Model", Sparkles], ["connections", "Connections", MessageCircle], ["memory", "Memory & privacy", Bot]];
  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPickerOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [pickerOpen]);
  const select = (model: KasiAiModel) => { onPreference({ defaultModelProvider: model.provider, defaultModel: model.model }); setPickerOpen(false); setSearch(""); };
  return <div className="flex min-h-0 flex-1 flex-col"><div className="flex items-center gap-2 border-b border-border p-4"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}><ArrowLeft className="h-4 w-4" /></Button><h3 className="text-sm font-semibold">KasiAi settings</h3></div><div className="flex min-h-0 flex-1"><nav className="w-36 shrink-0 border-r border-border p-2">{nav.map(([key, label, Icon]) => <button key={key} type="button" onClick={() => onSection(key)} className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs", key === "model" ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/60")}><Icon className="h-3.5 w-3.5" />{label}</button>)}</nav><div className="min-w-0 flex-1 overflow-y-auto p-4"><div className="space-y-4"><SettingTitle title="Default model" description="Used for new chats. Change it whenever you need another model." />{current ? <ModelCard model={current} selected /> : <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">No model is currently available.</p>}<Button onClick={() => setPickerOpen(true)} disabled={!models.length}><Search className="h-4 w-4" />Change model</Button><p className="text-xs text-muted-foreground">{models.length} available models · {modelCatalog?.source === "live" ? "Live OpenRouter catalog" : "Cached fallback catalog"}</p>{modelCatalog?.error ? <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">The live catalog is unavailable right now; showing safe fallback models.</p> : null}</div></div></div>{pickerOpen ? <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4"><div className="flex max-h-[calc(100vh-4rem)] w-full max-w-2xl flex-col rounded-xl border border-border bg-background shadow-2xl" role="dialog" aria-modal="true" aria-label="Choose a model"><div className="flex items-center justify-between border-b border-border p-4"><div><h4 className="text-sm font-semibold">Choose a model</h4><p className="mt-1 text-xs text-muted-foreground">Search the live OpenRouter catalog.</p></div><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setPickerOpen(false)} aria-label="Close model picker"><X className="h-4 w-4" /></Button></div><div className="border-b border-border p-3"><label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models, labs, or IDs…" className="min-w-0 flex-1 bg-transparent text-sm outline-none" /></label><p className="mt-2 text-[11px] text-muted-foreground">{matching.length} matches{matching.length > displayed.length ? ` · showing first ${displayed.length}` : ""}</p></div><div className="min-h-0 flex-1 overflow-y-auto p-3"><div className="space-y-2">{displayed.map((model) => <button key={`${model.provider}:${model.model}`} type="button" onClick={() => select(model)} className="w-full text-left"><ModelCard model={model} selected={model.provider === selectedModel?.provider && model.model === selectedModel.model} /></button>)}</div>{!matching.length ? <p className="py-10 text-center text-sm text-muted-foreground">No models match that search.</p> : null}</div></div></div> : null}</div>;
}

function ModelCard({ model, selected = false }: { model: KasiAiModel; selected?: boolean }) {
  return <div className={cn("w-full rounded-lg border p-3 text-left transition-colors", selected ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-muted/60")}><div className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium">{model.label}</span><span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px]">{model.isFree ? "free" : model.tier}</span></div><p className="mt-1 truncate text-[11px] text-muted-foreground">{model.provider} · {model.model}</p><div className="mt-2 flex flex-wrap gap-1 text-[10px] text-muted-foreground">{model.isWorkspaceDefault ? <span className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">workspace default</span> : null}{model.supportsTools ? <span className="rounded bg-muted px-1.5 py-0.5">tools</span> : <span className="rounded bg-muted px-1.5 py-0.5">chat only</span>}{model.contextWindow ? <span className="rounded bg-muted px-1.5 py-0.5">{Math.round(model.contextWindow / 1_000)}k context</span> : null}{model.inputUsdPerMillion !== undefined ? <span className="rounded bg-muted px-1.5 py-0.5">${model.inputUsdPerMillion}/M in</span> : null}</div></div>;
}

function SettingTitle({ title, description }: { title: string; description: string }) { return <div><h4 className="text-base font-semibold">{title}</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p></div>; }
function SelectSetting({ label, value, options, onChange }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void }) { return <label className="block text-sm font-medium">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 w-full rounded-md border border-border bg-card px-3 py-2 text-sm font-normal">{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>; }
function Toggle({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) { return <label className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-border p-3"><span><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 h-4 w-4 accent-primary" /></label>; }

export function KasiAiTrigger({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return <Button type="button" variant="ghost" onClick={onClick} className={cn("relative flex min-h-9 w-full items-center rounded-md text-[13px] font-medium leading-5 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground", collapsed ? "justify-center px-2 py-2" : "justify-start gap-2 px-2.5 py-2")} title="Open KasiAi" aria-label="Open KasiAi"><MessageCircle className="h-4 w-4 shrink-0" />{!collapsed ? <span>KasiAi</span> : null}</Button>;
}
