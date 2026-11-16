import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { SparklesIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Link } from "react-router-dom";
import { PiArchive, PiArrowLeft, PiChatCircle, PiGear, PiLinkSimple, PiMagnifyingGlass, PiPlus, PiPushPin, PiPushPinFill, PiSidebarSimple } from "react-icons/pi";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, message, organizationPath, type Agent, type Configuration, type ConversationSummary } from "./api";
import { ChatModelPicker } from "./agent-model";
import { AgentMemory } from "./agent-memory";
import { MemberChannelsPanel, type Assistant } from "./assistant";
import { Chat } from "./chat";
import { cn } from "@/lib/utils";
import "./assistant-launcher.css";

type View = "chat" | "library" | "settings" | "channels";

const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 900;
const DEFAULT_PANEL_WIDTH = 480;
const WIDTH_KEY_PREFIX = "agents.assistant.panelWidth";
const PINS_KEY_PREFIX = "agents.assistant.pins";
const LAUNCHER_SIZE = 56;
const DRAG_THRESHOLD = 4;

function AskMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  const fontSize = Math.max(6.5, size * 0.36);
  return <span aria-hidden="true" className={cn("relative grid place-items-center", className)} style={{ width: size, height: size }}>
    <svg viewBox="0 0 32 32" className="absolute inset-0 h-full w-full" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M5 5h22a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3H14l-5 4v-4H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z" />
    </svg>
    <span style={{ fontSize, fontWeight: 700, lineHeight: 1, marginTop: -size * 0.06, letterSpacing: "-.02em" }}>ask</span>
  </span>;
}

function readWidth(storageKey: string): number {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return DEFAULT_PANEL_WIDTH;
    const value = Number(stored);
    if (Number.isFinite(value)) return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, value));
  } catch { /* The panel remains usable when storage is unavailable. */ }
  return DEFAULT_PANEL_WIDTH;
}

function readPins(storageKey: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]") as unknown;
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  } catch { /* Pins are an enhancement; ignore invalid stored values. */ }
  return [];
}

function useAssistantAgent(organizationId: string, agentId: string | null) {
  const [agent, setAgent] = useState<Agent | null>(null);
  useEffect(() => {
    if (!agentId) { setAgent(null); return; }
    let live = true;
    api<{ agent: Agent }>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}`)
      .then(result => { if (live) setAgent(result.agent); })
      .catch(() => { if (live) setAgent(null); });
    return () => { live = false; };
  }, [organizationId, agentId]);
  return { agent, setAgent };
}

function dateGroup(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date > new Date(Date.now() - 7 * 86_400_000) ? "Previous 7 days" : "Older";
}

type LauncherPosition = { left: number; top: number };
function clampLauncher(position: LauncherPosition): LauncherPosition {
  const gutter = window.innerWidth < 640 ? 16 : 24;
  const maxLeft = Math.max(gutter, window.innerWidth - LAUNCHER_SIZE - gutter);
  const maxTop = Math.max(gutter, window.innerHeight - LAUNCHER_SIZE - gutter);
  return { left: Math.min(Math.max(gutter, position.left), maxLeft), top: Math.min(Math.max(gutter, position.top), maxTop) };
}

/**
 * Workspace assistant panel: chat, conversation library, settings and channels.
 * The assistant is a system helper, so it lives outside the agent catalogue and gets its own surface.
 */
export function AssistantLauncher({ organizationId, accountId, isOwner, open, onOpenChange, hidden = false }: {
  organizationId: string;
  accountId: string;
  isOwner: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hidden?: boolean;
}) {
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<View>("chat");
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [navigationExpanded, setNavigationExpanded] = useState(true);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [modelSaving, setModelSaving] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const widthKey = `${WIDTH_KEY_PREFIX}.${accountId}.${organizationId}`;
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const widthRef = useRef(width);
  widthRef.current = width;
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [launcherPosition, setLauncherPosition] = useState<LauncherPosition | null>(null);
  const launcherPositionRef = useRef<LauncherPosition | null>(null);
  const dragRef = useRef<{ pointerId: number; startLeft: number; startTop: number; offsetX: number; offsetY: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    api<Assistant>(`${organizationPath(organizationId)}/assistant`)
      .then(result => { if (live) { setAssistant(result); setLoaded(true); } })
      .catch(() => { if (live) { setAssistant(null); setLoaded(true); } });
    return () => { live = false; };
  }, [organizationId]);

  useEffect(() => { setWidth(readWidth(widthKey)); }, [widthKey]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      try {
        const value = JSON.parse(window.localStorage.getItem(`${widthKey}.launcher`) ?? "null") as Partial<LauncherPosition> | null;
        if (typeof value?.left === "number" && typeof value.top === "number") {
          const next = clampLauncher({ left: value.left, top: value.top });
          launcherPositionRef.current = next;
          setLauncherPosition(next);
        }
      } catch { /* The launcher remains usable when storage is unavailable. */ }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [widthKey]);

  const close = useCallback(() => {
    onOpenChange(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[data-slot="dialog-content"]')) return;
      if (mobileNavigationOpen) { setMobileNavigationOpen(false); return; }
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close, mobileNavigationOpen]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || panel.current?.contains(target)) return;
      // Portaled selects, menus and application dialogs belong to the open panel flow.
      if (target.closest('[data-slot="dialog-content"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]')) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  const agentId = assistant?.agent?.id ?? null;
  const ready = assistant?.state === "configured" && Boolean(agentId) && assistant.modelReady;
  const agentPath = agentId ? `/app/agents/${encodeURIComponent(agentId)}` : null;
  const { agent: chatAgent, setAgent: setChatAgent } = useAssistantAgent(organizationId, agentId);

  async function saveChatModel(selection: NonNullable<Configuration["model"]["selection"]>): Promise<boolean> {
    if (!agentId || modelSaving) return false;
    setModelSaving(true);
    try {
      const path = `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}`;
      const current = await api<{ agent: Agent }>(path);
      const configuration = { ...current.agent.draft, model: { ...current.agent.draft.model, selection } };
      const saved = await api<{ agent: Agent }>(`${path}/configuration`, { name: current.agent.name, configuration, expectedRevision: current.agent.draftRevision });
      setChatAgent(saved.agent);
      toast.success("Model updated");
      return true;
    } catch (cause) {
      toast.error(message(cause));
      return false;
    } finally { setModelSaving(false); }
  }

  // Another shell dialog takes over the viewport; close instead of leaving an orphaned panel.
  useEffect(() => {
    if (hidden && open) onOpenChange(false);
  }, [hidden, open, onOpenChange]);

  const openChat = useCallback((conversationId: string | null) => {
    setActiveConversationId(conversationId);
    if (conversationId === null) setNonce(value => value + 1);
    setView("chat");
  }, []);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 640) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { x: event.clientX, width: widthRef.current };
    setResizing(true);
  }, []);
  const moveResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return;
    const max = Math.min(MAX_PANEL_WIDTH, window.innerWidth);
    setWidth(Math.min(max, Math.max(Math.min(MIN_PANEL_WIDTH, window.innerWidth), resizeStart.current.width + resizeStart.current.x - event.clientX)));
  }, []);
  const finishResize = useCallback(() => {
    resizeStart.current = null;
    setResizing(false);
    try { window.localStorage.setItem(widthKey, String(widthRef.current)); } catch { /* The panel remains usable when storage is unavailable. */ }
  }, [widthKey]);

  const finishLauncherDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
    if (drag.moved) {
      suppressClickRef.current = true;
      if (launcherPositionRef.current) {
        try { window.localStorage.setItem(`${widthKey}.launcher`, JSON.stringify(launcherPositionRef.current)); } catch { /* The launcher remains usable when storage is unavailable. */ }
      }
    }
  }, [widthKey]);

  if (hidden) return null;

  const chatKey = `agents.assistant.${accountId}.${organizationId}.${activeConversationId ?? `new-${nonce}`}`;

  return <>
    {!open ? <div
      className={cn("fixed z-30 h-14 w-14", !launcherPosition && "bottom-5 right-5 sm:bottom-6 sm:right-6")}
      style={launcherPosition ? { left: launcherPosition.left, top: launcherPosition.top } : undefined}
    >
      <span aria-hidden="true" className="pointer-events-none absolute -inset-2 rounded-full bg-primary/25 blur-md" />
      <button
        ref={trigger}
        type="button"
        aria-label="Open Ask AI"
        title="Open Ask AI"
        onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } onOpenChange(true); }}
        onPointerDown={event => {
          if (event.button !== 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          dragRef.current = { pointerId: event.pointerId, startLeft: rect.left, startTop: rect.top, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, moved: false };
          setDragging(true);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          const left = event.clientX - drag.offsetX, top = event.clientY - drag.offsetY;
          if (!drag.moved && Math.hypot(left - drag.startLeft, top - drag.startTop) >= DRAG_THRESHOLD) drag.moved = true;
          const next = clampLauncher({ left, top });
          launcherPositionRef.current = next;
          setLauncherPosition(next);
        }}
        onPointerUp={finishLauncherDrag}
        onPointerCancel={finishLauncherDrag}
        className={cn("relative grid size-14 place-items-center overflow-hidden rounded-full border border-white/30 bg-[#161b62] p-0 text-white shadow-[0_12px_30px_-8px_color-mix(in_srgb,var(--brand)_70%,transparent)] transition-transform hover:scale-105 hover:brightness-110 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", dragging ? "cursor-grabbing scale-105" : "cursor-grab")}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-5 rounded-[45%] blur-[5px] motion-safe:animate-[assistant-wave_5s_ease-in-out_infinite]"
          style={{ background: "radial-gradient(ellipse at 24% 28%, rgba(196,181,253,.98), transparent 48%), radial-gradient(ellipse at 78% 78%, rgba(37,99,235,.98), transparent 54%), linear-gradient(135deg, #312e81, #11154e 58%, #050817)" }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-6 rounded-[48%] opacity-75 blur-[4px] motion-safe:animate-[assistant-wave-secondary_7s_ease-in-out_infinite]"
          style={{ background: "radial-gradient(ellipse at 72% 22%, rgba(129,140,248,.88), transparent 42%), radial-gradient(ellipse at 28% 78%, rgba(14,165,233,.78), transparent 48%)" }}
        />
        <AskMark size={24} className="relative z-10 drop-shadow-[0_1px_3px_rgba(0,0,0,.4)]" />
      </button>
    </div> : null}
    {open ? createPortal(
      <div className="fixed inset-0 z-40" role="presentation">
        <div className="absolute inset-0 bg-black/40 sm:hidden" onClick={close} aria-hidden="true" />
        <aside
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Ask AI"
          style={{ width: `min(${width}px, 100vw)` }}
          className={cn("fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-border bg-background shadow-2xl", resizing && "select-none")}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize Ask AI panel"
            className="absolute inset-y-0 -left-2 z-10 hidden w-4 cursor-ew-resize touch-none sm:block"
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
          />
          <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8 sm:hidden" onClick={() => setMobileNavigationOpen(true)} aria-label="Open Ask AI navigation" aria-expanded={mobileNavigationOpen}>
                <PiSidebarSimple size={16} aria-hidden="true" />
              </Button>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <HugeiconsIcon icon={SparklesIcon} size={16} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">Ask AI</h2>
                <p className="truncate text-[11px] text-muted-foreground">{ready ? "Your workspace AI" : "Setup required"}</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button type="button" size="icon" variant="ghost" className="h-8 w-8" onClick={close} aria-label="Close Ask AI">
                <HugeiconsIcon icon={Cancel01Icon} size={18} aria-hidden="true" />
              </Button>
            </div>
          </header>
          <div className="relative flex min-h-0 flex-1">
            <div className="hidden min-h-0 shrink-0 sm:flex">
              <AssistantNavigation
                expanded={navigationExpanded}
                view={view}
                organizationId={organizationId}
                agentId={agentId}
                selectedId={activeConversationId}
                onToggle={() => setNavigationExpanded(current => !current)}
                onNew={() => openChat(null)}
                onChats={() => setView("library")}
                onSettings={() => setView("settings")}
                onChannels={() => setView("channels")}
                onOpen={id => openChat(id)}
              />
            </div>
            {mobileNavigationOpen ? <>
              <div className="absolute inset-0 z-10 bg-black/40 sm:hidden" onClick={() => setMobileNavigationOpen(false)} aria-hidden="true" />
              <div className="absolute inset-y-0 left-0 z-20 flex w-64 max-w-[calc(100%-3rem)] sm:hidden">
                <AssistantNavigation
                  expanded
                  view={view}
                  organizationId={organizationId}
                  agentId={agentId}
                  selectedId={activeConversationId}
                  onToggle={() => setMobileNavigationOpen(false)}
                  onNew={() => { setMobileNavigationOpen(false); openChat(null); }}
                  onChats={() => { setMobileNavigationOpen(false); setView("library"); }}
                  onSettings={() => { setMobileNavigationOpen(false); setView("settings"); }}
                  onChannels={() => { setMobileNavigationOpen(false); setView("channels"); }}
                  onOpen={id => { setMobileNavigationOpen(false); openChat(id); }}
                />
              </div>
            </> : null}
            <div className="flex min-w-0 flex-1 flex-col">
              {view === "library" ? (
                ready ? <ConversationLibrary
                  organizationId={organizationId}
                  accountId={accountId}
                  agentId={agentId}
                  selectedId={activeConversationId}
                  onBack={() => setView("chat")}
                  onNew={() => openChat(null)}
                  onOpen={id => openChat(id)}
                /> : loaded ? <AssistantSetupSection organizationId={organizationId} assistant={assistant} isOwner={isOwner} onUpdate={setAssistant} onNavigate={close} /> : <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground" role="status">Loading Ask AI…</div>
              ) : null}
              {view === "settings" ? (
                <AssistantSettings organizationId={organizationId} assistant={assistant} loaded={loaded} isOwner={isOwner} onUpdate={setAssistant} onNavigate={close} onBack={() => setView("chat")} />
              ) : null}
              {view === "channels" ? (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex items-center gap-2 border-b border-border p-4">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setView("chat")} aria-label="Back to chat">
                      <PiArrowLeft size={16} aria-hidden="true" />
                    </Button>
                    <h3 className="flex-1 text-sm font-semibold">Channels</h3>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <MemberChannelsPanel agentPath={agentPath} ready={ready} />
                  </div>
                </div>
              ) : null}
              {view === "chat" ? (
                ready ? <Chat
                  key={chatKey}
                  endpoint={`${organizationPath(organizationId)}/tasks`}
                  storageKey={chatKey}
                  agentId={agentId!}
                  expectedAgentId={agentId!}
                  initialConversationId={activeConversationId ?? undefined}
                  onConversationReady={id => setActiveConversationId(id)}
                  composerAccessory={chatAgent ? <ChatModelPicker organizationId={organizationId} agentId={chatAgent.id} configuration={chatAgent.draft} dirty={false} saving={modelSaving} onSelect={saveChatModel} /> : null}
                  cancellable
                /> : loaded ? <AssistantSetupSection organizationId={organizationId} assistant={assistant} isOwner={isOwner} onUpdate={setAssistant} onNavigate={close} /> : <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground" role="status">Loading Ask AI…</div>
              ) : null}
            </div>
          </div>
        </aside>
      </div>,
      document.body,
    ) : null}
  </>;
}

function AssistantNavigation({ expanded, view, organizationId, agentId, selectedId, onToggle, onNew, onChats, onSettings, onChannels, onOpen }: {
  expanded: boolean;
  view: View;
  organizationId: string;
  agentId: string | null;
  selectedId: string | null;
  onToggle: () => void;
  onNew: () => void;
  onChats: () => void;
  onSettings: () => void;
  onChannels: () => void;
  onOpen: (conversationId: string) => void;
}) {
  const [recents, setRecents] = useState<ConversationSummary[] | null>(null);
  useEffect(() => {
    if (!expanded || !agentId) { setRecents(null); return; }
    let live = true;
    api<{ conversations: ConversationSummary[] }>(`${organizationPath(organizationId)}/conversations?agentId=${encodeURIComponent(agentId)}&limit=20`)
      .then(result => { if (live) setRecents(result.conversations); })
      .catch(() => { if (live) setRecents([]); });
    return () => { live = false; };
  }, [expanded, organizationId, agentId]);
  const actionClass = (active = false) =>
    cn("flex h-9 items-center rounded-md text-sm transition-colors hover:bg-muted", expanded ? "w-full gap-2 px-2.5" : "w-9 justify-center", active && "bg-muted text-foreground");
  return <nav aria-label="Ask AI navigation" className={cn("flex shrink-0 flex-col border-r border-border bg-card/30 p-2 transition-[width]", expanded ? "w-56" : "w-14")}>
    <div className={cn("mb-2 flex items-center", expanded ? "justify-between px-1" : "justify-center")}>
      <span className={cn("text-sm font-semibold", !expanded && "sr-only")}>Ask AI</span>
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onToggle} aria-label={expanded ? "Collapse Ask AI navigation" : "Expand Ask AI navigation"}>
        <PiSidebarSimple size={16} aria-hidden="true" className={cn("transition-transform", expanded && "rotate-180")} />
      </Button>
    </div>
    <button type="button" onClick={onNew} className={actionClass(view === "chat" && !selectedId)} title="New chat">
      <PiPlus size={16} aria-hidden="true" className="shrink-0" />{expanded ? <span>New chat</span> : null}
    </button>
    <button type="button" onClick={onChats} className={actionClass(view === "library")} title="Chats">
      <PiChatCircle size={16} aria-hidden="true" className="shrink-0" />{expanded ? <span>Chats</span> : null}
    </button>
    <button type="button" onClick={onSettings} className={actionClass(view === "settings")} title="Settings">
      <PiGear size={16} aria-hidden="true" className="shrink-0" />{expanded ? <span>Settings</span> : null}
    </button>
    <button type="button" onClick={onChannels} className={actionClass(view === "channels")} title="Channels">
      <PiLinkSimple size={16} aria-hidden="true" className="shrink-0" />{expanded ? <span>Channels</span> : null}
    </button>
    {expanded ? <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
      <p className="px-2 pb-2 text-[11px] font-medium text-muted-foreground">Recents</p>
      <div className="space-y-0.5">
        {recents?.map(item => <button type="button" key={item.id} onClick={() => onOpen(item.id)} title={item.title}
          className={cn("w-full truncate rounded-md px-2 py-2 text-left text-xs hover:bg-muted", item.id === selectedId && "bg-muted font-medium")}>
          {item.title}
        </button>)}
        {recents && !recents.length ? <p className="px-2 py-2 text-xs text-muted-foreground">No chats yet.</p> : null}
      </div>
    </div> : null}
  </nav>;
}

function AssistantSetupSection({ organizationId, assistant, isOwner, onUpdate, onNavigate }: {
  organizationId: string;
  assistant: Assistant | null;
  isOwner: boolean;
  onUpdate: (assistant: Assistant) => void;
  onNavigate: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function repair() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await api<Assistant>(`${organizationPath(organizationId)}/assistant/repair`, {});
      onUpdate(result);
      toast.success(assistant?.state === "deleted" ? "Ask AI restored" : result.modelReady ? "Ask AI ready" : "Ask AI added");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  const agentPath = assistant?.agent ? `/app/agents/${encodeURIComponent(assistant.agent.id)}` : null;
  if (!assistant) return <p className="p-6 text-sm text-muted-foreground" role="status">Loading Ask AI…</p>;
  const configured = assistant.state === "configured";
  const needsModel = configured && !assistant.modelReady;
  return <div className="space-y-3 p-6 text-sm">
    <p className="font-medium">{assistant.state === "deleted" ? "Ask AI removed" : needsModel ? "Choose a model" : assistant.state === "draft" ? "Configuration required" : "Ask AI needs setup"}</p>
    {needsModel ? <p className="text-muted-foreground">Add a model before chatting.</p> : assistant.state === "draft" ? <p className="text-muted-foreground">Finish setting up Ask AI before chatting.</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    <div className="flex flex-wrap gap-2">
      {agentPath ? <>
        {configured && assistant.modelReady ? null : isOwner ? <Button asChild size="sm"><Link to={`${agentPath}?section=configuration`} onClick={onNavigate}>{needsModel ? "Choose model" : "Configure"}</Link></Button> : <p className="text-muted-foreground">{needsModel ? "Ask an owner to choose a model." : "Ask an owner to configure Ask AI."}</p>}
      </> : isOwner ? <Button size="sm" disabled={busy} onClick={() => void repair()}>{busy ? "Preparing…" : assistant.state === "deleted" ? "Restore Ask AI" : "Set up Ask AI"}</Button> : <p className="text-muted-foreground">Ask an owner to set up Ask AI.</p>}
    </div>
  </div>;
}

function ConversationLibrary({ organizationId, accountId, agentId, selectedId, onBack, onNew, onOpen }: {
  organizationId: string;
  accountId: string;
  agentId: string | null;
  selectedId: string | null;
  onBack: () => void;
  onNew: () => void;
  onOpen: (conversationId: string) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [archived, setArchived] = useState<ConversationSummary[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const pinsKey = `${PINS_KEY_PREFIX}.${accountId}.${organizationId}`;
  const [pins, setPins] = useState<string[]>(() => readPins(pinsKey));
  const agentPath = `${organizationPath(organizationId)}`;

  useEffect(() => {
    if (!agentId) { setConversations([]); return; }
    let live = true;
    setConversations(null); setArchived(null); setError("");
    api<{ conversations: ConversationSummary[]; nextCursor: string | null }>(`${agentPath}/conversations?agentId=${encodeURIComponent(agentId)}&limit=100`)
      .then(result => { if (live) setConversations(result.conversations); })
      .catch(cause => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [agentPath, agentId]);

  useEffect(() => {
    if (!agentId || !showArchived || archived) return;
    let live = true;
    api<{ conversations: ConversationSummary[] }>(`${agentPath}/conversations?agentId=${encodeURIComponent(agentId)}&limit=100&state=archived`)
      .then(result => { if (live) setArchived(result.conversations); })
      .catch(cause => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [agentPath, agentId, showArchived, archived]);

  async function archive(id: string, restore: boolean) {
    if (busyId) return;
    setBusyId(id); setError("");
    try {
      await api(`${agentPath}/conversations/${encodeURIComponent(id)}/${restore ? "restore" : "archive"}`, {});
      if (restore) {
        const moved = archived?.find(item => item.id === id) ?? null;
        setArchived(current => current?.filter(item => item.id !== id) ?? null);
        if (moved) setConversations(current => [...(current ?? []), moved].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
      } else {
        setConversations(current => current?.filter(item => item.id !== id) ?? null);
        setArchived(null);
        if (selectedId === id) onOpen(id);
      }
    } catch (cause) { setError(message(cause)); }
    finally { setBusyId(null); }
  }

  function togglePin(id: string) {
    setPins(current => {
      const next = current.includes(id) ? current.filter(item => item !== id) : [...current, id];
      try { window.localStorage.setItem(pinsKey, JSON.stringify(next)); } catch { /* Pins are an enhancement. */ }
      return next;
    });
  }

  const list = useMemo(() => {
    const items = (showArchived ? archived : conversations) ?? [];
    const query = search.trim().toLowerCase();
    const filtered = query ? items.filter(item => item.title.toLowerCase().includes(query)) : items;
    const pinned = new Set(pins);
    return [...filtered].sort((left, right) => Number(pinned.has(right.id)) - Number(pinned.has(left.id)));
  }, [archived, conversations, pins, search, showArchived]);

  if (!agentId) return <p className="p-6 text-sm text-muted-foreground" role="status">Loading chats…</p>;
  return <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label="Conversation library">
    <div className="flex items-center gap-2 border-b border-border p-4">
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} aria-label="Back to chat">
        <PiArrowLeft size={16} aria-hidden="true" />
      </Button>
      <h3 className="flex-1 text-sm font-semibold">Conversations</h3>
      <Button size="sm" onClick={onNew}><PiPlus size={14} aria-hidden="true" />New chat</Button>
    </div>
    <div className="flex shrink-0 items-center gap-2 border-b border-border p-3">
      <label className="relative min-w-0 flex-1">
        <PiMagnifyingGlass size={15} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search conversations" placeholder="Search chats" value={search} onChange={event => setSearch(event.target.value)} className="pl-8" />
      </label>
      <Button type="button" size="sm" variant={showArchived ? "secondary" : "ghost"} onClick={() => setShowArchived(value => !value)} aria-pressed={showArchived}>
        <PiArchive size={15} aria-hidden="true" />{showArchived ? "Hide archived" : "Archived"}
      </Button>
    </div>
    {error ? <p role="alert" className="shrink-0 px-4 pt-2 text-sm text-destructive">{error}</p> : null}
    <div className="min-h-0 flex-1 overflow-y-auto p-3">
      {!showArchived ? (["Today", "Yesterday", "Previous 7 days", "Older"] as const).map(label => {
        const items = list.filter(item => dateGroup(item.updatedAt) === label);
        if (!items.length) return null;
        return <section key={label} className="mb-5">
          <h4 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">{label}</h4>
          {items.map(item => <ConversationRow key={item.id} item={item} selected={item.id === selectedId} pinned={pins.includes(item.id)} busy={busyId === item.id}
            onOpen={() => onOpen(item.id)} onPin={() => togglePin(item.id)} onArchive={() => void archive(item.id, false)} />)}
        </section>;
      }) : null}
      {!showArchived && !list.length && conversations ? <p className="px-2 py-8 text-center text-sm text-muted-foreground">{search.trim() ? "No conversations found." : "No chats yet."}</p> : null}
      {showArchived ? <section>
        <h4 className="px-2 pb-1 text-[11px] font-medium text-muted-foreground">Archived</h4>
        {!archived ? <p role="status" className="px-2 py-2 text-sm text-muted-foreground">Loading archived chats…</p> :
          !list.length ? <p className="px-2 py-8 text-center text-sm text-muted-foreground">No archived chats.</p> :
          list.map(item => <div key={item.id} className="flex items-center gap-1 rounded-lg px-2 py-2 text-sm text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{item.title}</span>
            <Button variant="ghost" size="sm" className="h-7 shrink-0 text-[11px]" disabled={busyId === item.id} onClick={() => void archive(item.id, true)}>Restore</Button>
          </div>)}
      </section> : null}
      {!conversations && !error ? <p role="status" className="px-2 py-8 text-center text-sm text-muted-foreground">Loading chats…</p> : null}
    </div>
  </div>;
}

function ConversationRow({ item, selected, pinned, busy, onOpen, onPin, onArchive }: {
  item: ConversationSummary;
  selected: boolean;
  pinned: boolean;
  busy: boolean;
  onOpen: () => void;
  onPin: () => void;
  onArchive: () => void;
}) {
  return <div className={cn("group flex items-center gap-1 rounded-lg px-2 py-1.5", selected ? "bg-muted" : "hover:bg-muted/60")}>
    <button type="button" onClick={onPin} aria-label={pinned ? `Unpin ${item.title}` : `Pin ${item.title}`} title={pinned ? "Unpin" : "Pin"}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
      {pinned ? <PiPushPinFill size={14} aria-hidden="true" /> : <PiPushPin size={14} aria-hidden="true" />}
    </button>
    <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left" title={item.title}>
      <span className="block truncate text-sm font-medium">{pinned ? "• " : ""}{item.title}</span>
      <span className="block truncate text-[11px] text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</span>
    </button>
    <Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100" disabled={busy}
      onClick={onArchive} aria-label={`Archive ${item.title}`} title="Archive">
      <PiArchive size={14} aria-hidden="true" />
    </Button>
  </div>;
}

function AssistantSettings({ organizationId, assistant, loaded, isOwner, onUpdate, onNavigate, onBack }: {
  organizationId: string;
  assistant: Assistant | null;
  loaded: boolean;
  isOwner: boolean;
  onUpdate: (assistant: Assistant) => void;
  onNavigate: () => void;
  onBack: () => void;
}) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelError, setModelError] = useState("");
  const agentId = assistant?.agent?.id ?? null;
  const agentPath = agentId ? `${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}` : null;

  useEffect(() => {
    if (!agentPath) return;
    let live = true;
    setSettingsLoaded(false);
    api<{ agent: Agent }>(agentPath)
      .then(result => { if (live) { setAgent(result.agent); setSettingsLoaded(true); } })
      .catch(() => { if (live) setSettingsLoaded(true); });
    return () => { live = false; };
  }, [agentPath]);

  async function saveModel(selection: NonNullable<Configuration["model"]["selection"]>): Promise<boolean> {
    if (!agentPath || saving) return false;
    setSaving(true); setModelError("");
    try {
      const current = await api<{ agent: Agent }>(agentPath);
      const configuration = { ...current.agent.draft, model: { ...current.agent.draft.model, selection } };
      const saved = await api<{ agent: Agent }>(`${agentPath}/configuration`, { name: current.agent.name, configuration, expectedRevision: current.agent.draftRevision });
      setAgent(saved.agent);
      return true;
    } catch (cause) {
      setModelError(message(cause));
      return false;
    } finally { setSaving(false); }
  }

  if (!loaded || !assistant?.agent) {
    return <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-4">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} aria-label="Back to chat">
          <PiArrowLeft size={16} aria-hidden="true" />
        </Button>
        <h3 className="flex-1 text-sm font-semibold">Ask AI settings</h3>
      </div>
      <AssistantSetupSection organizationId={organizationId} assistant={assistant} isOwner={isOwner} onUpdate={onUpdate} onNavigate={onNavigate} />
    </div>;
  }
  const settingsAgent = agent?.id === assistant.agent.id ? agent : null;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center gap-2 border-b border-border p-4">
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} aria-label="Back to chat">
        <PiArrowLeft size={16} aria-hidden="true" />
      </Button>
      <h3 className="flex-1 text-sm font-semibold">Ask AI settings</h3>
    </div>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      <section aria-label="Ask AI profile" className="flex items-center gap-3">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">A</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">Ask AI</p>
          <p className="text-xs text-muted-foreground">Workspace AI · {assistant.state === "configured" && assistant.modelReady ? "Ready" : "Needs setup"}</p>
        </div>
      </section>
      <section aria-label="Model" className="space-y-2">
        <h4 className="text-sm font-medium">Model</h4>
        {!settingsLoaded ? <p role="status" className="text-sm text-muted-foreground">Loading model…</p> :
          settingsAgent ? <ChatModelPicker organizationId={organizationId} agentId={settingsAgent.id} configuration={settingsAgent.draft} dirty={false} saving={saving} onSelect={saveModel} /> :
          <p className="text-sm text-muted-foreground">Model settings are unavailable.</p>}
        {modelError ? <p role="alert" className="text-sm text-destructive">{modelError}</p> : null}
      </section>
      <section aria-label="Memory" className="space-y-2">
        <h4 className="text-sm font-medium">Memory</h4>
        {settingsAgent ? <div className="flex items-center gap-2">
          <AgentMemory agentId={settingsAgent.id} enabled={settingsAgent.draft.memory?.enabled ?? false} />
          <span className="text-xs text-muted-foreground">{settingsAgent.draft.memory?.enabled ? "Memory enabled" : "Memory disabled"}</span>
        </div> : <p className="text-sm text-muted-foreground">Memory settings are unavailable.</p>}
      </section>
      <section aria-label="More setup" className="space-y-2 border-t border-border pt-4">
        <h4 className="text-sm font-medium">More setup</h4>
        <p className="text-xs text-muted-foreground">Instructions, knowledge, tools and channels live in the agent editor.</p>
        {isOwner && settingsAgent ? <Button asChild type="button" size="sm" variant="outline"><Link to={`/app/agents/${encodeURIComponent(settingsAgent.id)}?section=configuration`} onClick={onNavigate}>Configure in editor</Link></Button> : null}
      </section>
    </div>
  </div>;
}
