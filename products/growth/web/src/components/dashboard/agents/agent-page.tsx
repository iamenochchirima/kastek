import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  ArrowLeft, ArrowUpRight, FileText, Grid2x2, MessageCircle as MessageSquare, Search,
} from "@/components/ui/interface-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { AgentAvatar, agentAvatars } from "./agent-avatar";
import { AgentCapabilityUpgrade } from "./agent-capability-upgrade";
import { AgentResources } from "./agent-resources";
import { GrowthAgentModelPicker } from "./agent-model-picker";
import { TaskStatus } from "./agent-workspace";
import { useGrowthAgents } from "./agent-provider";
import { growthAgents, isActiveTask, type GrowthAgentConversation, type GrowthAgentFeature, type GrowthAgentTask } from "@/lib/growth-agents";
import { AgentMemoryPanel } from "@kasitek-labs/ui/agent-memory";
import AssistantChannelsCard from "@/components/dashboard/settings/assistant-channels-card";
import { cn } from "@/lib/utils";
import "./agents-workspace.css";

const featureIcons = { assistant: MessageSquare, research: Search, content: FileText, campaigns: Grid2x2 } as const;
const tabIds = ["overview", "conversations", "activity", "settings"] as const;
type TabId = typeof tabIds[number];

function featureIcon(id: string) {
  return featureIcons[id as keyof typeof featureIcons] ?? MessageSquare;
}
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function statusLabel(feature: GrowthAgentFeature) {
  if (feature.ready) return "Ready";
  return feature.reasons[0]?.message || "Unavailable";
}

function ConversationRows({ conversations }: { conversations: GrowthAgentConversation[] }) {
  if (!conversations.length) return <p className="px-1 py-8 text-sm text-muted-foreground">No conversations yet</p>;
  return <div className="growth-agents-table-wrap"><table className="growth-agents-table"><thead><tr><th>Conversation</th><th>Updated</th><th /></tr></thead><tbody>
    {conversations.map(conversation => <tr key={conversation.id}>
      <td><Link to={`/agents/conversations/${encodeURIComponent(conversation.id)}`} className="growth-agents-record-link">{conversation.title || "New conversation"}</Link><span className="growth-agents-mobile-meta">{dateLabel(conversation.updatedAt)}</span></td>
      <td><time dateTime={conversation.updatedAt}>{dateLabel(conversation.updatedAt)}</time></td>
      <td className="text-right"><Button asChild variant="ghost" size="sm"><Link to={`/agents/conversations/${encodeURIComponent(conversation.id)}`} aria-label="Open conversation">Open<ArrowUpRight className="ml-1.5 size-3.5" /></Link></Button></td>
    </tr>)}
  </tbody></table></div>;
}
function TaskRows({ tasks }: { tasks: GrowthAgentTask[] }) {
  if (!tasks.length) return <p className="px-1 py-8 text-sm text-muted-foreground">No activity yet</p>;
  return <div className="growth-agents-table-wrap"><table className="growth-agents-table growth-agents-task-table"><thead><tr><th>Work</th><th>Status</th><th>Updated</th><th /></tr></thead><tbody>
    {tasks.map(task => <tr key={task.id}>
      <td><span className="growth-agents-task-title">{task.input || "Agent task"}</span><span className="growth-agents-mobile-meta">{taskStateLabel(task.state)}</span></td>
      <td><TaskStatus task={task} /></td>
      <td><time dateTime={task.updatedAt}>{dateLabel(task.updatedAt)}</time></td>
      <td className="text-right"><Button asChild variant="outline" size="sm"><Link to={`/agents/conversations/${encodeURIComponent(task.conversationId)}?task=${encodeURIComponent(task.id)}`} aria-label="Open task">Open</Link></Button></td>
    </tr>)}
  </tbody></table></div>;
}
function taskStateLabel(state: GrowthAgentTask["state"]) {
  return state === "waiting_review" ? "Needs review" : state === "waiting_authority" ? "Access required" : state.charAt(0).toUpperCase() + state.slice(1).replaceAll("_", " ");
}
function FeatureIcon({ id, className }: { id: string; className?: string }) {
  const Icon = featureIcon(id);
  return <Icon className={className} />;
}

function SettingsSection({ id, title, description, children, action }: {
  id: string; title: string; description: string; children: ReactNode; action?: ReactNode;
}) {
  return <section id={id} className="scroll-mt-24 rounded-xl border border-border bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="text-sm font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>
      {action}
    </div>
    <div className="mt-4">{children}</div>
  </section>;
}

function ProfileForm({ feature, canConfigure, onSaved }: { feature: GrowthAgentFeature; canConfigure: boolean; onSaved: () => Promise<unknown> }) {
  const [name, setName] = useState(feature.name);
  const [avatar, setAvatar] = useState(feature.avatar || agentAvatars[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setName(feature.name); setAvatar(feature.avatar || agentAvatars[0].id); }, [feature.id, feature.name, feature.avatar]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canConfigure || busy || !name.trim()) return;
    setBusy(true); setError("");
    try { await growthAgents.updateProfile(feature.id, { name: name.trim(), avatar }); await onSaved(); toast.success("Agent updated"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update agent."); }
    finally { setBusy(false); }
  }
  return <form onSubmit={save} className="space-y-4">
    <div className="flex flex-wrap items-center gap-4"><AgentAvatar avatar={avatar} className="size-14" /><Button type="button" variant="outline" size="sm" disabled={!canConfigure || busy} onClick={() => { const options = agentAvatars.filter(item => item.id !== avatar); setAvatar(options[Math.floor(Math.random() * options.length)]!.id); }}>Shuffle avatar</Button></div>
    <label className="block max-w-md space-y-2 text-sm font-medium">Name<Input value={name} maxLength={120} disabled={!canConfigure || busy} onChange={event => setName(event.target.value)} required /></label>
    <div className="space-y-2"><span className="text-sm font-medium">Role</span><p className="text-sm text-muted-foreground">{feature.id === "assistant" ? "Growth assistant" : feature.id.charAt(0).toUpperCase() + feature.id.slice(1)}</p></div>
    <div className="space-y-2"><span className="text-sm font-medium">Avatar</span><div className="grid max-w-md grid-cols-5 gap-2" role="group" aria-label="Avatar">{agentAvatars.map(item => <button type="button" key={item.id} aria-label={item.id} aria-pressed={avatar === item.id} disabled={!canConfigure || busy} onClick={() => setAvatar(item.id)} className={cn("rounded-xl p-1 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary", avatar === item.id && "ring-2 ring-primary")}><AgentAvatar avatar={item.id} className="aspect-square w-full" /></button>)}</div></div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex justify-end"><Button type="submit" disabled={!canConfigure || busy || !name.trim()}>{busy ? "Saving…" : "Save changes"}</Button></div>
  </form>;
}

export function GrowthAgentPage() {
  const { featureId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const agents = useGrowthAgents();
  const { ensureBootstrap } = agents;
  const [feature, setFeature] = useState<GrowthAgentFeature | null>(null);
  const [conversations, setConversations] = useState<GrowthAgentConversation[]>([]);
  const [tasks, setTasks] = useState<GrowthAgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const tabParam = params.get("tab") as TabId | null;
  const tab: TabId = tabParam && tabIds.includes(tabParam) ? tabParam : "overview";
  const setTab = (value: string) => {
    const next = new URLSearchParams(params);
    next.set("tab", value);
    setParams(next, { replace: true });
  };
  const canConfigure = agents.bootstrap?.scope.canConfigureAgents === true;
  const featureTasks = useMemo(() => tasks.filter(task => task.featureId === feature?.id), [tasks, feature?.id]);
  const activeTasks = featureTasks.filter(isActiveTask);

  useEffect(() => {
    if (tab !== "settings" || !feature || !hash) return;
    const frame = requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [tab, feature, hash]);

  useEffect(() => {
    if (!featureId) return;
    let live = true;
    setLoading(true); setError("");
    void ensureBootstrap().then(async home => {
      if (!live) return;
      const selected = home.features.find(item => item.id === featureId) ?? null;
      setFeature(selected);
      if (!selected) return;
      const [conversationPage, taskPage] = await Promise.all([
        growthAgents.conversations({ featureId: selected.id, limit: 6 }),
        growthAgents.tasks({ limit: 30 }),
      ]);
      if (!live) return;
      setConversations(conversationPage.conversations);
      setTasks(taskPage.tasks);
    }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : "Unable to load agent."); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [featureId, ensureBootstrap]);

  async function refresh() {
    const home = await ensureBootstrap(true);
    const selected = home.features.find(item => item.id === featureId) ?? null;
    setFeature(selected);
    if (selected) {
      const [conversationPage, taskPage] = await Promise.all([growthAgents.conversations({ featureId: selected.id, limit: 6 }), growthAgents.tasks({ limit: 30 })]);
      setConversations(conversationPage.conversations);
      setTasks(taskPage.tasks);
    }
  }
  async function chat() {
    if (!feature || chatBusy) return;
    setChatBusy(true);
    try { const id = await agents.start(feature.id); if (id) navigate(`/agents/conversations/${encodeURIComponent(id)}`); }
    catch (cause) { toast.error(cause instanceof Error ? cause.message : "Unable to start chat."); }
    finally { setChatBusy(false); }
  }

  if (loading && !feature) return <div className="min-h-[60dvh] p-6"><div className="mx-auto max-w-[1440px] space-y-5"><Skeleton className="h-20 w-full" /><Skeleton className="h-64 w-full" /></div></div>;
  if (!feature) return <div className="min-h-[60dvh] p-6"><div className="mx-auto max-w-[1440px]"><Link to="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft className="size-4" />Agents</Link><div className="mt-8 rounded-xl border border-border p-8 text-center"><h1 className="text-lg font-semibold">Agent not found</h1><p className="mt-2 text-sm text-muted-foreground">This agent is not available in this workspace.</p><Button asChild className="mt-4" variant="outline"><Link to="/agents">Back to agents</Link></Button></div></div></div>;

  return <div className="growth-agents-workspace px-4 py-6 lg:px-6"><div className="mx-auto max-w-[1440px] space-y-5">
    <Link to="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />Agents</Link>
    <PageHeader>
      <PageHeaderContent>
        <div className="flex min-w-0 items-center gap-3">
          <AgentAvatar avatar={feature.avatar} className="size-12 shrink-0" />
          <div className="min-w-0">
            <PageHeaderTitle className="break-words">{feature.name}</PageHeaderTitle>
            <PageHeaderDescription>{feature.description || statusLabel(feature)}</PageHeaderDescription>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span className={cn("inline-block size-1.5 rounded-full", feature.ready ? "bg-emerald-500" : "bg-amber-500")} />{statusLabel(feature)}<span>·</span><FeatureIcon id={feature.id} className="size-3.5" />{feature.id === "assistant" ? "Growth assistant" : feature.id.charAt(0).toUpperCase() + feature.id.slice(1)}</div>
          </div>
        </div>
      </PageHeaderContent>
      <PageHeaderActions>
        <Button type="button" onClick={() => void chat()} disabled={!feature.ready || chatBusy}>{chatBusy ? "Opening…" : "Chat"}</Button>
        <Button type="button" variant="outline" onClick={() => setTab("settings")}>Settings</Button>
      </PageHeaderActions>
    </PageHeader>
    {error ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-4"><p className="min-w-0 flex-1 text-sm text-muted-foreground">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>Retry</Button></div> : null}
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList className="growth-agents-tabs flex h-auto w-full flex-wrap justify-start gap-x-5 rounded-none border-b border-border bg-transparent p-0">
        {([["overview", "Overview"], ["conversations", "Conversations"], ["activity", "Activity"], ["settings", "Settings"]] as const).map(([id, label]) => <TabsTrigger key={id} value={id} className="rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 py-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">{label}</TabsTrigger>)}
      </TabsList>
      <TabsContent value="overview" className="mt-6 space-y-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <section className="rounded-xl border border-border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Agent</h2><p className="mt-1 text-sm text-muted-foreground">Model and readiness</p></div><Button type="button" variant="outline" size="sm" onClick={() => setTab("settings")}>Manage</Button></div><dl className="mt-4 grid gap-4 sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">Model</dt><dd className="mt-1 text-sm font-medium">{feature.model?.label || agents.bootstrap?.model?.label || "Default"}</dd></div><div><dt className="text-xs text-muted-foreground">Status</dt><dd className="mt-1 flex items-center gap-2 text-sm"><span className={cn("inline-block size-1.5 rounded-full", feature.ready ? "bg-emerald-500" : "bg-amber-500")} />{statusLabel(feature)}</dd></div><div><dt className="text-xs text-muted-foreground">Memory</dt><dd className="mt-1 text-sm">{feature.memory?.enabled ? "On" : "Off"}</dd></div><div><dt className="text-xs text-muted-foreground">Active work</dt><dd className="mt-1 text-sm">{activeTasks.length}</dd></div></dl></section>
          <section className="rounded-xl border border-border bg-card p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold">Specialists</h2><p className="mt-1 text-sm text-muted-foreground">Agents this agent can delegate to</p></div></div>{feature.specialists?.length ? <ul className="mt-4 divide-y divide-border">{feature.specialists.map(specialist => <li key={specialist.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><span className="min-w-0 break-words font-medium">{specialist.name}</span><span className="text-xs text-muted-foreground">{specialist.state === "configured" ? "Configured" : specialist.state === "disabled" ? "Disabled" : "Unavailable"}</span></li>)}</ul> : <p className="mt-4 text-sm text-muted-foreground">No specialists</p>}</section>
        </div>
        <section><div className="mb-2 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">Recent conversations</h2><Button type="button" variant="ghost" size="sm" onClick={() => setTab("conversations")}>View all<ArrowUpRight className="ml-1.5 size-3.5" /></Button></div><ConversationRows conversations={conversations} /></section>
        <section><div className="mb-2 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">Ongoing work</h2><Button type="button" variant="ghost" size="sm" onClick={() => setTab("activity")}>View activity<ArrowUpRight className="ml-1.5 size-3.5" /></Button></div><TaskRows tasks={activeTasks} /></section>
      </TabsContent>
      <TabsContent value="conversations" className="mt-6"><ConversationRows conversations={conversations} /></TabsContent>
      <TabsContent value="activity" className="mt-6"><TaskRows tasks={featureTasks} /></TabsContent>
      <TabsContent value="settings" className="mt-6">
        <div className="grid gap-4 xl:grid-cols-2">
          <SettingsSection id="general" title="General" description="Name and avatar for this agent."><ProfileForm feature={feature} canConfigure={canConfigure} onSaved={refresh} /></SettingsSection>
          <SettingsSection id="model" title="Model" description="Choose the model this agent uses." action={<GrowthAgentModelPicker key={`${agents.scopeKey}:${feature.id}`} featureId={feature.id} label={feature.model?.label || agents.bootstrap?.model?.label || "Default"} scopeKey={agents.scopeKey} canConfigure={canConfigure} onSaved={() => ensureBootstrap(true)} />}><p className="text-sm text-muted-foreground">{feature.model?.label || agents.bootstrap?.model?.label || "Default"} · {feature.model?.provider || "Workspace default"}</p></SettingsSection>
          <SettingsSection id="memory" title="Memory" description="What this agent remembers about your work." action={<Button type="button" variant="outline" size="sm" onClick={() => setMemoryOpen(true)}>Manage memory</Button>}><p className="text-sm text-muted-foreground">{feature.memory?.enabled ? "Memory is on. Saved memories are reviewed before use." : "Memory is off. The agent does not retain memories."}</p></SettingsSection>
          <SettingsSection id="knowledge" title="Knowledge & skills" description="Sources and reviewed skills this agent can use." action={<Button type="button" variant="outline" size="sm" onClick={() => setResourcesOpen(true)}>Manage</Button>}><p className="text-sm text-muted-foreground">Add text sources, review them, and select skills for this agent.</p></SettingsSection>
          <SettingsSection id="channels" title="Channels" description="Connect messaging accounts to this agent.">{feature.id === "assistant" ? <AssistantChannelsCard /> : <p className="text-sm text-muted-foreground">Channels are available for the Growth assistant.</p>}</SettingsSection>
          <SettingsSection id="capabilities" title="Capabilities" description="Review changes to this agent's tools and permissions." action={<Button type="button" variant="outline" size="sm" disabled={!canConfigure} onClick={() => setUpgradeOpen(true)}>Review update</Button>}><p className="text-sm text-muted-foreground">Updates are reviewed before they are applied. Existing settings are preserved unless you choose otherwise.</p></SettingsSection>
        </div>
      </TabsContent>
    </Tabs>
    {memoryOpen ? <AgentMemoryPanel open={memoryOpen} onOpenChange={setMemoryOpen} scopeKey={`${agents.scopeKey}:${feature.id}`}
      load={page => growthAgents.memories(feature.id, page)} mutate={(memoryId, input) => growthAgents.mutateMemory(feature.id, memoryId, input)}
      enabled={feature.memory?.enabled ?? false} onEnabledChange={canConfigure && feature.revision !== undefined ? async (enabled, requestId) => { await growthAgents.configureMemory(feature.id, enabled, feature.revision!, requestId); await refresh(); } : undefined} /> : null}
    {resourcesOpen ? <AgentResources key={`${agents.scopeKey}:${feature.id}:resources`} featureId={feature.id} name={feature.name} open={resourcesOpen} onOpenChange={setResourcesOpen} onSaved={refresh} /> : null}
    {upgradeOpen ? <AgentCapabilityUpgrade key={`${agents.scopeKey}:${feature.id}:upgrade`} featureId={feature.id} name={feature.name} open={upgradeOpen} onOpenChange={setUpgradeOpen} onSaved={refresh} /> : null}
  </div></div>;
}
