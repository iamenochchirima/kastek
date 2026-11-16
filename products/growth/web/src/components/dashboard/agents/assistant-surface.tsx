import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "@/components/ui/interface-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import AssistantChannelsCard from "@/components/dashboard/settings/assistant-channels-card";
import { AssistantLauncher, AssistantPanel, defaultAssistantNavigationIcons, type AssistantNavigationItem, type AssistantRecentConversation } from "@kasitek-labs/ui/assistant";
import { growthAgents, type GrowthAgentConversation, type GrowthAgentFeature, type GrowthAgentFeatureId } from "@/lib/growth-agents";
import { AgentConversation } from "./agent-conversation";
import { GrowthAgentModelPicker } from "./agent-model-picker";
import { useGrowthAgents } from "./agent-provider";
import { Sparkles } from "@/components/ui/interface-icons";

type View = "chat" | "library" | "settings" | "channels";

const WIDTH_KEY_PREFIX = "kasitek:growth-assistant-width";
const LAUNCHER_KEY = "kasitek:growth-assistant-launcher-position";

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function ViewHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return <div className="flex shrink-0 items-center gap-2 border-b border-border p-4">
    <Button type="button" variant="ghost" size="icon" className="size-8" onClick={onBack} aria-label="Back to chat"><ArrowLeft className="size-4" /></Button>
    <h3 className="flex-1 text-sm font-semibold">{title}</h3>
  </div>;
}

function ConversationLibrary({ featureId, onBack, onOpen }: { featureId: GrowthAgentFeatureId; onBack: () => void; onOpen: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [conversations, setConversations] = useState<GrowthAgentConversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void growthAgents.conversations({ featureId, search: search.trim() || undefined, limit: 20 })
        .then(page => { if (live) { setConversations(page.conversations); setCursor(page.nextCursor); } })
        .catch(cause => { if (live) setError(cause instanceof Error ? cause.message : "Unable to load conversations."); })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [featureId, search, generation]);

  async function more() {
    if (!cursor || loading) return;
    setLoading(true); setError("");
    try {
      const page = await growthAgents.conversations({ featureId, search: search.trim() || undefined, cursor, limit: 20 });
      setConversations(current => [...current, ...page.conversations]);
      setCursor(page.nextCursor);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load conversations."); }
    finally { setLoading(false); }
  }

  return <div className="flex min-h-0 flex-1 flex-col">
    <ViewHeader title="Conversations" onBack={onBack} />
    <div className="p-4 pb-2"><Input aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={event => setSearch(event.target.value)} /></div>
    {error ? <div className="px-4 py-2" role="alert"><p className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => setGeneration(value => value + 1)}>Retry conversations</Button></div> : null}
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {loading && !conversations.length ? <p className="px-2 py-6 text-sm text-muted-foreground" role="status">Loading conversations…</p> : null}
      {!loading && !conversations.length && !error ? <p className="px-2 py-6 text-sm text-muted-foreground">No conversations yet</p> : null}
      {conversations.map(conversation => <button key={conversation.id} type="button" onClick={() => onOpen(conversation.id)} className="flex w-full items-start gap-3 rounded-md px-2 py-3 text-left transition-colors hover:bg-muted">
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{conversation.title || "New conversation"}</span><span className="mt-0.5 block text-xs text-muted-foreground">{dateLabel(conversation.updatedAt)}</span></span>
      </button>)}
      {cursor ? <Button type="button" variant="ghost" size="sm" className="mt-2 w-full" disabled={loading} onClick={() => void more()}>{loading ? "Loading…" : "Load more"}</Button> : null}
    </div>
  </div>;
}

function SettingsView({ feature, scopeKey, canConfigure, onBack, onOpenChannels, onClose, onSaved }: {
  feature: GrowthAgentFeature | null;
  scopeKey: string;
  canConfigure: boolean;
  onBack: () => void;
  onOpenChannels: () => void;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const featureId = (feature?.id ?? "assistant") as GrowthAgentFeatureId;
  const ready = feature?.ready === true;
  return <div className="flex min-h-0 flex-1 flex-col">
    <ViewHeader title="Assistant settings" onBack={onBack} />
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
      <section aria-label="Growth assistant profile" className="flex items-center gap-3">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"><Sparkles className="size-4" /></span>
        <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">Growth assistant</p><p className="text-xs text-muted-foreground">Growth AI · {ready ? "Ready" : feature?.reasons[0]?.message || "Needs setup"}</p></div>
      </section>
      <section aria-label="Model" className="space-y-2">
        <h4 className="text-sm font-medium">Model</h4>
        <GrowthAgentModelPicker key={`${scopeKey}:${featureId}`} featureId={featureId} label={feature?.model?.label || "Default"} scopeKey={scopeKey} canConfigure={canConfigure} onSaved={() => onSaved()} />
      </section>
      <section aria-label="Memory" className="space-y-2">
        <h4 className="text-sm font-medium">Memory</h4>
        <p className="text-sm text-muted-foreground">{feature?.memory?.enabled ? "Memory is on. Saved memories are reviewed before use." : "Memory is off. The agent does not retain memories."}</p>
        <Link className="text-sm underline underline-offset-4" to={`/agents/${encodeURIComponent(featureId)}?tab=settings#memory`} onClick={onClose}>Manage memory</Link>
      </section>
      <section aria-label="Channels" className="space-y-2">
        <h4 className="text-sm font-medium">Channels</h4>
        <p className="text-sm text-muted-foreground">Connect messaging accounts to the Growth assistant.</p>
        <Button type="button" variant="outline" size="sm" onClick={onOpenChannels}>Manage channels</Button>
      </section>
      <section aria-label="More setup" className="space-y-2 border-t border-border pt-4">
        <h4 className="text-sm font-medium">More setup</h4>
        <p className="text-xs text-muted-foreground">Profile, knowledge, skills and capabilities live in the agent editor.</p>
        <Button asChild type="button" size="sm" variant="outline"><Link to={`/agents/${encodeURIComponent(featureId)}?tab=settings`} onClick={onClose}>Configure in editor</Link></Button>
      </section>
    </div>
  </div>;
}

function ChannelsView({ onBack }: { onBack: () => void }) {
  return <div className="flex min-h-0 flex-1 flex-col">
    <ViewHeader title="Channels" onBack={onBack} />
    <div className="min-h-0 flex-1 overflow-y-auto p-4"><AssistantChannelsCard /></div>
  </div>;
}

export function GrowthAssistantSurface({ launcherHidden = false, panelHidden = false, bottomInset = 0 }: { launcherHidden?: boolean; panelHidden?: boolean; bottomInset?: number }) {
  const agents = useGrowthAgents();
  const [view, setView] = useState<View>("chat");
  const [recents, setRecents] = useState<AssistantRecentConversation[] | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const featureId = (agents.conversation?.featureId ?? "assistant") as GrowthAgentFeatureId;
  const feature = agents.bootstrap?.features.find(item => item.id === featureId) ?? null;
  const canConfigure = agents.bootstrap?.scope.canConfigureAgents === true;

  useEffect(() => { if (!agents.panelOpen) setView("chat"); }, [agents.panelOpen]);
  useEffect(() => {
    if (!agents.panelOpen) { setRecents(null); return; }
    let live = true;
    void growthAgents.conversations({ featureId, limit: 20 })
      .then(page => { if (live) setRecents(page.conversations.map(item => ({ id: item.id, title: item.title || "New conversation", updatedAt: item.updatedAt }))); })
      .catch(() => { if (live) setRecents([]); });
    return () => { live = false; };
  }, [agents.panelOpen, featureId, agents.conversation?.id]);

  const navigationItems: AssistantNavigationItem[] = [
    { id: "library", label: "Chats", icon: defaultAssistantNavigationIcons.chats },
    { id: "settings", label: "Settings", icon: defaultAssistantNavigationIcons.settings },
    { id: "channels", label: "Channels", icon: defaultAssistantNavigationIcons.channels },
  ];

  return <>
    <AssistantLauncher open={agents.panelOpen} onOpenChange={open => { if (open) void agents.openGeneral(); }} label="Open Growth assistant" storageKey={LAUNCHER_KEY} hidden={launcherHidden} bottomInset={bottomInset} triggerRef={launcherRef}
      dataAttributes={{ "data-growth-assistant-launcher": "" }} icon={<Sparkles className="size-6" />} />
    <AssistantPanel
      open={agents.panelOpen}
      onClose={agents.closePanel}
      hidden={panelHidden}
      ariaLabel="Growth assistant"
      closeLabel="Close assistant"
      widthKey={`${WIDTH_KEY_PREFIX}.${agents.scopeKey}`}
      defaultWidth={720}
      returnFocusRef={launcherRef}
      className="dashboard-theme"
      view={view}
      identity={{ name: "Growth assistant", subtitle: feature?.name || agents.businessName, icon: <Sparkles className="size-4" /> }}
      navigation={{
        title: "Growth assistant",
        items: navigationItems,
        recents,
        selectedConversationId: agents.conversation?.id ?? null,
        onSelect: id => setView(id as View),
        onNewChat: () => { setView("chat"); void agents.start(featureId); },
        onOpenConversation: id => { setView("chat"); void agents.openConversation(id, true); },
      }}
    >
      {view === "chat" ? <AgentConversation /> : null}
      {view === "library" ? <ConversationLibrary featureId={featureId} onBack={() => setView("chat")} onOpen={id => { setView("chat"); void agents.openConversation(id, true); }} /> : null}
      {view === "settings" ? <SettingsView feature={feature} scopeKey={agents.scopeKey} canConfigure={canConfigure} onBack={() => setView("chat")} onOpenChannels={() => setView("channels")} onClose={agents.closePanel} onSaved={() => agents.ensureBootstrap(true)} /> : null}
      {view === "channels" ? <ChannelsView onBack={() => setView("chat")} /> : null}
    </AssistantPanel>
  </>;
}
