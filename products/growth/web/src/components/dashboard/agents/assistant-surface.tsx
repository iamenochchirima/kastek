import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import AssistantChannelsCard from "@/components/dashboard/settings/assistant-channels-card";
import { AssistantChannelsView, AssistantLauncher, AssistantLibrary, AssistantPanel, AssistantSettingsView, defaultAssistantNavigationIcons, type AssistantNavigationItem, type AssistantRecentConversation } from "@kasitek-labs/ui/assistant";
import { growthAgents, type GrowthAgentConversation, type GrowthAgentFeature, type GrowthAgentFeatureId } from "@/lib/growth-agents";
import { AgentConversation } from "./agent-conversation";
import { GrowthAgentModelPicker } from "./agent-model-picker";
import { useGrowthAgents } from "./agent-provider";
import { Sparkles } from "@/components/ui/interface-icons";

type View = "chat" | "library" | "settings" | "channels";

const WIDTH_KEY_PREFIX = "kasitek:growth-assistant-width";
const LAUNCHER_KEY = "kasitek:growth-assistant-launcher-position";

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

  return <AssistantLibrary
    title="Conversations"
    onBack={onBack}
    search={search}
    onSearch={setSearch}
    searchPlaceholder="Search conversations"
    loading={loading}
    error={error || undefined}
    onRetry={() => setGeneration(value => value + 1)}
    items={conversations}
    onOpen={onOpen}
    emptyLabel="No conversations yet"
    noResultsLabel="No conversations found."
    loadMore={cursor ? <Button type="button" variant="ghost" size="sm" className="mt-2 w-full" disabled={loading} onClick={() => void more()}>{loading ? "Loading…" : "Load more"}</Button> : null}
  />;
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
  return <AssistantSettingsView
    title="Assistant settings"
    onBack={onBack}
    identity={{ name: "Growth assistant", subtitle: `Growth AI · ${ready ? "Ready" : feature?.reasons[0]?.message || "Needs setup"}`, icon: <Sparkles className="size-4" /> }}
    sections={[
      { id: "model", title: "Model", content: <GrowthAgentModelPicker key={`${scopeKey}:${featureId}`} featureId={featureId} label={feature?.model?.label || "Default"} scopeKey={scopeKey} canConfigure={canConfigure} onSaved={() => onSaved()} /> },
      { id: "memory", title: "Memory", content: <><p className="text-sm text-muted-foreground">{feature?.memory?.enabled ? "Memory is on. Saved memories are reviewed before use." : "Memory is off. The agent does not retain memories."}</p><Link className="text-sm underline underline-offset-4" to={`/agents/${encodeURIComponent(featureId)}?tab=settings#memory`} onClick={onClose}>Manage memory</Link></> },
      { id: "channels", title: "Channels", description: "Connect messaging accounts to the Growth assistant.", content: <Button type="button" variant="outline" size="sm" onClick={onOpenChannels}>Manage channels</Button> },
      { id: "more", title: "More setup", description: "Profile, knowledge, skills and capabilities live in the agent editor.", content: <Button asChild type="button" size="sm" variant="outline"><Link to={`/agents/${encodeURIComponent(featureId)}?tab=settings`} onClick={onClose}>Configure in editor</Link></Button> },
    ]}
  />;
}

function ChannelsView({ onBack }: { onBack: () => void }) {
  return <AssistantChannelsView title="Channels" onBack={onBack}><AssistantChannelsCard /></AssistantChannelsView>;
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
