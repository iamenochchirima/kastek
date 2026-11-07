import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { AiChat02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { Link } from "react-router-dom";
import { PiArchive, PiArrowCounterClockwise, PiChatCircle, PiGear, PiLinkSimple, PiMagnifyingGlass, PiPlus, PiPushPin, PiPushPinFill } from "react-icons/pi";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, message, organizationPath, type Agent, type Configuration, type ConversationSummary } from "./api";
import { ChatModelPicker } from "./agent-model";
import { AgentMemory } from "./agent-memory";
import { MemberChannelsPanel, type Assistant } from "./assistant";
import { Chat } from "./chat";

type Tab = "chat" | "history" | "settings" | "channels";

const MIN_PANEL_WIDTH = 340;
const MAX_PANEL_WIDTH = 680;
const DEFAULT_PANEL_WIDTH = 420;

function readWidth(storageKey: string): number {
  try {
    const value = Number(window.localStorage.getItem(storageKey));
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

/**
 * Workspace assistant surface: chat, conversation history and settings.
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
  const [tab, setTab] = useState<Tab>("chat");
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const widthKey = `agents.assistant.panelWidth.${accountId}.${organizationId}`;
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const widthRef = useRef(panelWidth);
  widthRef.current = panelWidth;
  const resizing = useRef(false);

  const onResizeMove = useCallback((event: MouseEvent) => {
    if (!resizing.current) return;
    setPanelWidth(Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, window.innerWidth - event.clientX - 24)));
  }, []);
  const stopResize = useCallback(() => {
    if (!resizing.current) return;
    resizing.current = false;
    document.removeEventListener("mousemove", onResizeMove);
    document.removeEventListener("mouseup", stopResize);
    try { window.localStorage.setItem(widthKey, String(widthRef.current)); } catch { /* The panel remains usable when storage is unavailable. */ }
  }, [onResizeMove, widthKey]);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    api<Assistant>(`${organizationPath(organizationId)}/assistant`)
      .then(result => { if (live) { setAssistant(result); setLoaded(true); } })
      .catch(() => { if (live) { setAssistant(null); setLoaded(true); } });
    return () => { live = false; };
  }, [organizationId]);

  useEffect(() => { setPanelWidth(readWidth(widthKey)); }, [widthKey]);

  const close = useCallback(() => {
    onOpenChange(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[data-slot="dialog-content"]')) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const agentId = assistant?.agent?.id ?? null;
  const ready = assistant?.state === "configured" && Boolean(agentId);
  const agentPath = agentId ? `/app/agents/${encodeURIComponent(agentId)}` : null;

  // Another shell dialog takes over the viewport; close instead of leaving an orphaned panel.
  useEffect(() => {
    if (hidden && open) onOpenChange(false);
  }, [hidden, open, onOpenChange]);

  const openChat = useCallback((conversationId: string | null) => {
    setActiveConversationId(conversationId);
    if (conversationId === null) setNonce(value => value + 1);
    setTab("chat");
  }, []);

  if (hidden) return null;

  const chatKey = `agents.assistant.${accountId}.${organizationId}.${activeConversationId ?? `new-${nonce}`}`;

  return <>
    {!open ? <button
      ref={trigger}
      type="button"
      aria-label="Open assistant"
      title="Open assistant"
      onClick={() => onOpenChange(true)}
      className="fixed bottom-5 right-5 z-30 grid size-14 place-items-center rounded-full border border-border bg-primary text-primary-foreground shadow-sm transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:bottom-6 sm:right-6"
    >
      <HugeiconsIcon icon={AiChat02Icon} size={24} aria-hidden="true" />
    </button> : null}
    {open ? createPortal(
      <div className="fixed inset-0 z-40" role="presentation">
        <div className="absolute inset-0 bg-black/40" onClick={close} aria-hidden="true" />
        <div
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-label="Assistant"
          style={{ width: panelWidth }}
          className="absolute inset-x-0 bottom-0 top-0 flex max-w-full flex-col overflow-hidden border border-border bg-background shadow-lg sm:inset-auto sm:bottom-6 sm:right-6 sm:top-auto sm:h-[min(720px,calc(100dvh-48px))] sm:max-w-[calc(100vw-48px)] sm:rounded-lg"
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize assistant panel"
            className="absolute inset-y-0 left-0 hidden w-2 cursor-ew-resize touch-none sm:block"
            onMouseDown={event => {
              event.preventDefault();
              resizing.current = true;
              document.addEventListener("mousemove", onResizeMove);
              document.addEventListener("mouseup", stopResize);
            }}
          />
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><HugeiconsIcon icon={AiChat02Icon} size={16} aria-hidden="true" /></span>
            <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{assistant?.agent?.name ?? "Assistant"}</h2>
            <Button type="button" size="icon" variant="ghost" onClick={close} aria-label="Close assistant">
              <HugeiconsIcon icon={Cancel01Icon} size={18} aria-hidden="true" />
            </Button>
          </header>
          <div role="tablist" aria-label="Assistant views" className="flex shrink-0 gap-1 border-b border-border px-3 py-2">
            {([["chat", "Chat", PiChatCircle], ["history", "History", PiMagnifyingGlass], ["settings", "Settings", PiGear], ["channels", "Channels", PiLinkSimple]] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                className={`flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md px-3 text-sm ${tab === id ? "bg-secondary font-medium" : "text-muted-foreground hover:bg-secondary/60"}`}>
                <Icon size={16} aria-hidden="true" />{label}
              </button>
            ))}
          </div>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === "chat" ? (
              ready ? <Chat
                key={chatKey}
                endpoint={`${organizationPath(organizationId)}/tasks`}
                storageKey={chatKey}
                agentId={agentId!}
                expectedAgentId={agentId!}
                initialConversationId={activeConversationId ?? undefined}
                onConversationReady={id => setActiveConversationId(id)}
                cancellable
              /> : loaded ? <AssistantSetupSection organizationId={organizationId} assistant={assistant} isOwner={isOwner} onUpdate={setAssistant} onNavigate={close} /> : <p className="p-6 text-sm text-muted-foreground" role="status">Loading assistant…</p>
            ) : null}
            {tab === "history" ? (
              ready ? <AssistantHistory organizationId={organizationId} accountId={accountId} activeConversationId={activeConversationId} onOpen={openChat} /> : loaded ? <AssistantSetupSection organizationId={organizationId} assistant={assistant} isOwner={isOwner} onUpdate={setAssistant} onNavigate={close} /> : <p className="p-6 text-sm text-muted-foreground" role="status">Loading assistant…</p>
            ) : null}
            {tab === "settings" ? (
              <AssistantSettings organizationId={organizationId} assistant={assistant} loaded={loaded} isOwner={isOwner} onUpdate={setAssistant} onNavigate={close} />
            ) : null}
            {tab === "channels" ? (
              loaded ? <div className="min-h-0 flex-1 overflow-y-auto p-4"><MemberChannelsPanel agentPath={agentPath} ready={ready} /></div> : <p className="p-6 text-sm text-muted-foreground" role="status">Loading assistant…</p>
            ) : null}
          </div>
        </div>
      </div>,
      document.body,
    ) : null}
  </>;
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
      toast.success("Assistant ready to configure");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  const agentPath = assistant?.agent ? `/app/agents/${encodeURIComponent(assistant.agent.id)}` : null;
  if (!assistant) return <p className="p-6 text-sm text-muted-foreground" role="status">Loading assistant…</p>;
  return <div className="space-y-3 p-6 text-sm">
    <p className="font-medium">{assistant.state === "deleted" ? "Assistant removed" : assistant.state === "draft" ? "Configuration required" : "Assistant needs setup"}</p>
    {assistant.state === "draft" ? <p className="text-muted-foreground">Configure the assistant before chatting.</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    <div className="flex flex-wrap gap-2">
      {agentPath ? <>
        {assistant.state === "configured" ? null : isOwner ? <Button asChild size="sm"><Link to={`${agentPath}?section=configuration`} onClick={onNavigate}>Configure</Link></Button> : <p className="text-muted-foreground">Ask an owner to configure the assistant.</p>}
      </> : isOwner ? <Button size="sm" disabled={busy} onClick={() => void repair()}>{busy ? "Preparing…" : assistant.state === "deleted" ? "Restore assistant" : "Set up assistant"}</Button> : <p className="text-muted-foreground">Ask an owner to set up the assistant.</p>}
    </div>
  </div>;
}

function AssistantHistory({ organizationId, accountId, activeConversationId, onOpen }: {
  organizationId: string;
  accountId: string;
  activeConversationId: string | null;
  onOpen: (conversationId: string | null) => void;
}) {
  const agentPath = `${organizationPath(organizationId)}`;
  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [archived, setArchived] = useState<ConversationSummary[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const pinsKey = `agents.assistant.pins.${accountId}.${organizationId}`;
  const [pins, setPins] = useState<string[]>(() => readPins(pinsKey));

  useEffect(() => {
    let live = true;
    setConversations(null); setArchived(null); setError("");
    api<Assistant>(`${agentPath}/assistant`)
      .then(result => { if (!live) return; setAssistant(result); })
      .catch(cause => { if (live) setError(message(cause)); });
    return () => { live = false; };
  }, [agentPath]);

  const agentId = assistant?.agent?.id ?? null;
  useEffect(() => {
    if (!agentId) return;
    let live = true;
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
        if (activeConversationId === id) onOpen(null);
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

  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center gap-2 p-3">
      <label className="relative min-w-0 flex-1">
        <PiMagnifyingGlass size={15} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={event => setSearch(event.target.value)} className="pl-8" />
      </label>
      <Button type="button" size="sm" variant="outline" onClick={() => onOpen(null)}><PiPlus size={15} aria-hidden="true" />New</Button>
    </div>
    <div className="flex shrink-0 items-center gap-2 px-3 pb-2">
      <Button type="button" size="sm" variant={showArchived ? "secondary" : "ghost"} onClick={() => setShowArchived(value => !value)}>
        <PiArchive size={15} aria-hidden="true" />{showArchived ? "Hide archived" : "Archived"}
      </Button>
    </div>
    {error ? <p role="alert" className="shrink-0 px-4 pb-2 text-sm text-destructive">{error}</p> : null}
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      {!conversations && !error ? <p role="status" className="p-2 text-sm text-muted-foreground">Loading conversations…</p> :
        !list.length ? <p className="p-2 text-sm text-muted-foreground">{search.trim() ? "No matching conversations" : showArchived ? "No archived conversations" : "No conversations yet"}</p> :
        <ul className="space-y-1">
          {list.map(item => <li key={item.id} className={`flex items-center gap-1 rounded-md px-2 py-1.5 ${activeConversationId === item.id && !showArchived ? "bg-secondary" : "hover:bg-secondary/60"}`}>
            <button type="button" onClick={() => togglePin(item.id)} aria-label={pins.includes(item.id) ? `Unpin ${item.title}` : `Pin ${item.title}`} title={pins.includes(item.id) ? "Unpin" : "Pin"}
              className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground">
              {pins.includes(item.id) ? <PiPushPinFill size={15} aria-hidden="true" /> : <PiPushPin size={15} aria-hidden="true" />}
            </button>
            <button type="button" onClick={() => { if (!showArchived) onOpen(item.id); }} disabled={showArchived} className="min-w-0 flex-1 text-left disabled:cursor-default">
              <span className="block truncate text-sm font-medium">{item.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</span>
            </button>
            <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0" disabled={busyId === item.id}
              onClick={() => void archive(item.id, showArchived)}
              aria-label={showArchived ? `Restore ${item.title}` : `Archive ${item.title}`} title={showArchived ? "Restore" : "Archive"}>
              {showArchived ? <PiArrowCounterClockwise size={15} aria-hidden="true" /> : <PiArchive size={15} aria-hidden="true" />}
            </Button>
          </li>)}
        </ul>}
    </div>
  </div>;
}

function AssistantSettings({ organizationId, assistant, loaded, isOwner, onUpdate, onNavigate }: {
  organizationId: string;
  assistant: Assistant | null;
  loaded: boolean;
  isOwner: boolean;
  onUpdate: (assistant: Assistant) => void;
  onNavigate: () => void;
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
    return <AssistantSetupSection organizationId={organizationId} assistant={assistant} isOwner={isOwner} onUpdate={onUpdate} onNavigate={onNavigate} />;
  }
  const settingsAgent = agent?.id === assistant.agent.id ? agent : null;
  if (!settingsAgent) {
    return <p className="p-6 text-sm text-muted-foreground" role="status">Loading settings…</p>;
  }
  return <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
    <section aria-label="Assistant profile" className="flex items-center gap-3">
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-foreground">
        {assistant.agent.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{assistant.agent.name}</p>
        <p className="text-xs text-muted-foreground">Workspace system assistant · {assistant.state === "configured" ? "Ready" : "Needs setup"}</p>
      </div>
    </section>
    <section aria-label="Model" className="space-y-2">
      <h3 className="text-sm font-medium">Model</h3>
      {!settingsLoaded ? <p role="status" className="text-sm text-muted-foreground">Loading model…</p> :
        <ChatModelPicker organizationId={organizationId} agentId={settingsAgent.id} configuration={settingsAgent.draft} dirty={false} saving={saving} onSelect={saveModel} />}
      {modelError ? <p role="alert" className="text-sm text-destructive">{modelError}</p> : null}
    </section>
    <section aria-label="Memory" className="space-y-2">
      <h3 className="text-sm font-medium">Memory</h3>
      <div className="flex items-center gap-2">
        <AgentMemory agentId={settingsAgent.id} enabled={settingsAgent.draft.memory?.enabled ?? false} />
        <span className="text-xs text-muted-foreground">{settingsAgent.draft.memory?.enabled ? "Memory enabled" : "Memory disabled"}</span>
      </div>
    </section>
    <section aria-label="More setup" className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-medium">More setup</h3>
      <p className="text-xs text-muted-foreground">Instructions, knowledge, tools and channels live in the agent editor.</p>
      {isOwner ? <Button asChild type="button" size="sm" variant="outline"><Link to={`/app/agents/${encodeURIComponent(settingsAgent.id)}?section=configuration`} onClick={onNavigate}>Configure in editor</Link></Button> : null}
    </section>
  </div>;
}
