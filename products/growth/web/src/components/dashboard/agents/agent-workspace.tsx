import { Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Bot, CheckCircle2, ChevronRight, Clock3, MessageSquare, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderTitle } from "@/components/ui/page-header";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { growthAgents, isActiveTask, safeGrowthRoute, taskStateLabel, type GrowthAgentConversation, type GrowthAgentFeature, type GrowthAgentTask } from "@/lib/growth-agents";
import { cn } from "@/lib/utils";
import { useGrowthAgents } from "./agent-provider";

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
export function TaskStatus({ task }: { task: GrowthAgentTask }) {
  return <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs", task.state === "waiting_review" ? "text-status-attention" : ["failed", "uncertain", "refused"].includes(task.state) ? "text-destructive" : "text-muted-foreground")}>{task.state === "completed" ? <CheckCircle2 className="size-3.5" /> : isActiveTask(task) ? <Clock3 className="size-3.5" /> : null}{taskStateLabel[task.state]}</span>;
}
function ConversationRows({ conversations }: { conversations: GrowthAgentConversation[] }) {
  return <ul className="divide-y divide-border">{conversations.map((conversation) => <li key={conversation.id}><Link to={`/agents/conversations/${encodeURIComponent(conversation.id)}`} className="group flex min-h-16 items-center gap-3 py-3 no-underline"><MessageSquare className="size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-foreground group-hover:text-primary">{conversation.title || "New conversation"}</p><p className="mt-1 text-xs text-muted-foreground">{conversation.featureId === "assistant" ? "Growth assistant" : conversation.featureId.charAt(0).toUpperCase() + conversation.featureId.slice(1)}</p></div><time className="hidden text-xs text-muted-foreground sm:block" dateTime={conversation.updatedAt}>{dateLabel(conversation.updatedAt)}</time><ChevronRight className="size-4 shrink-0 text-muted-foreground" /></Link></li>)}</ul>;
}
function TaskRows({ tasks }: { tasks: GrowthAgentTask[] }) {
  return <ul className="divide-y divide-border">{tasks.map((task) => <li key={task.id}><Link to={`/agents/conversations/${encodeURIComponent(task.conversationId)}?task=${encodeURIComponent(task.id)}`} className="group flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 py-3 no-underline"><div className="min-w-0 flex-1 basis-1/2"><p className="truncate text-sm font-medium text-foreground group-hover:text-primary">{task.input || "Agent task"}</p><p className="mt-1 text-xs text-muted-foreground">{dateLabel(task.updatedAt)}</p></div><TaskStatus task={task} /><ChevronRight className="size-4 shrink-0 text-muted-foreground" /></Link></li>)}</ul>;
}
function FeatureCard({ feature, onStart }: { feature: GrowthAgentFeature; onStart: () => void }) {
  const reason = feature.reasons[0];
  const route = safeGrowthRoute(reason?.route);
  return <article className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-4"><div className="mb-4 grid size-9 place-items-center rounded-lg bg-secondary"><Bot className="size-4 text-foreground" /></div><h3 className="text-sm font-semibold">{feature.name}</h3><p className="mt-1 min-h-10 text-xs leading-5 text-muted-foreground">{feature.description}</p><div className="mt-4 flex flex-wrap items-center gap-2">{feature.ready ? <Button type="button" variant="outline" size="sm" onClick={onStart}><MessageSquare className="mr-1.5 size-3.5" />Chat</Button> : <><span className="text-xs text-muted-foreground">{reason?.message || "Unavailable"}</span>{route ? <Link to={route} className="inline-flex min-h-8 items-center gap-1 text-xs text-primary underline underline-offset-2">Set up<ArrowUpRight className="size-3" /></Link> : null}</>}</div></article>;
}

export function AgentsWorkspace() {
  const agents = useGrowthAgents();
  const { ensureBootstrap, conversation } = agents;
  const [tab, setTab] = useState("overview");
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [conversations, setConversations] = useState<GrowthAgentConversation[]>([]);
  const [tasks, setTasks] = useState<GrowthAgentTask[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const [newContext, setNewContext] = useState("none");
  const queryVersion = useRef(0);
  const observedWork = agents.tasks.map((task) => `${task.id}:${task.state}:${task.updatedAt}`).join("|");
  useEffect(() => {
    const abort = new AbortController();
    queryVersion.current += 1;
    const timer = setTimeout(() => {
      setLoading(true); setLoadingMore(false); setError(null);
      void ensureBootstrap().then(async (home) => {
        if (home.setup && home.setup.state !== "ready") { setConversations([]); setTasks([]); setCursor(null); return; }
        if (tab === "activity") { const page = await growthAgents.tasks({ search, state: stateFilter, limit: 30 }, abort.signal); if (!abort.signal.aborted) { setTasks(page.tasks); setCursor(page.nextCursor); } }
        else if (tab === "conversations") { const page = await growthAgents.conversations({ search, limit: 30 }, abort.signal); if (!abort.signal.aborted) { setConversations(page.conversations); setCursor(page.nextCursor); } }
        else { const [recent, work] = await Promise.all([growthAgents.conversations({ limit: 6 }, abort.signal), growthAgents.tasks({ state: "active", limit: 20 }, abort.signal)]); if (!abort.signal.aborted) { setConversations(recent.conversations); setTasks(work.tasks); setCursor(null); } }
      }).catch((cause: unknown) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load agents."); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, search ? 250 : 0);
    return () => { queryVersion.current += 1; abort.abort(); clearTimeout(timer); };
  }, [ensureBootstrap, conversation?.id, tab, search, stateFilter, retry, observedWork]);
  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const version = queryVersion.current;
    try {
      if (tab === "activity") { const page = await growthAgents.tasks({ search, state: stateFilter, cursor, limit: 30 }); if (version !== queryVersion.current) return; setTasks((previous) => [...previous, ...page.tasks.filter((item) => !previous.some((old) => old.id === item.id))]); setCursor(page.nextCursor); }
      else { const page = await growthAgents.conversations({ search, cursor, limit: 30 }); if (version !== queryVersion.current) return; setConversations((previous) => [...previous, ...page.conversations.filter((item) => !previous.some((old) => old.id === item.id))]); setCursor(page.nextCursor); }
    } catch (cause) { if (version === queryVersion.current) setError(cause instanceof Error ? cause.message : "Unable to load more work."); }
    finally { if (version === queryVersion.current) setLoadingMore(false); }
  };
  const ongoing = tasks.filter(isActiveTask);
  return <div className="px-4 py-6 lg:px-6"><div className="mx-auto max-w-[1200px] space-y-7">
    <PageHeader><PageHeaderContent><PageHeaderTitle>Agents</PageHeaderTitle></PageHeaderContent><PageHeaderActions><Button type="button" onClick={() => setNewOpen(true)} disabled={!agents.bootstrap?.features.some((feature) => feature.ready)}><Plus className="mr-2 size-4" />New conversation</Button></PageHeaderActions></PageHeader>
    <Tabs value={tab} onValueChange={(value) => { setTab(value); setSearch(""); setStateFilter(""); setCursor(null); }}><TabsList className="h-auto gap-5 rounded-none border-b border-border bg-transparent p-0"><TabsTrigger value="overview" className="rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 py-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Overview</TabsTrigger><TabsTrigger value="conversations" className="rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 py-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Conversations</TabsTrigger><TabsTrigger value="activity" className="rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-0 py-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Activity</TabsTrigger></TabsList>
      {error ? <div role="alert" className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-border p-4"><p className="min-w-0 flex-1 text-sm text-muted-foreground">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry</Button></div> : null}
      <TabsContent value="overview" className="mt-7 space-y-9">{loading ? <WorkspaceSkeleton /> : !error ? <>
        <section aria-labelledby="your-agents"><h2 id="your-agents" className="mb-4 text-sm font-semibold">Your agents</h2><div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>{agents.bootstrap?.features.map((feature) => <FeatureCard key={feature.id} feature={feature} onStart={() => void agents.start(feature.id)} />)}</div>{!agents.bootstrap?.features.length ? <p className="py-5 text-sm text-muted-foreground">No agents available</p> : null}</section>
        <section aria-labelledby="ongoing-work"><div className="mb-2 flex items-center justify-between gap-3"><h2 id="ongoing-work" className="text-sm font-semibold">Ongoing work</h2><Button type="button" variant="ghost" size="sm" onClick={() => setTab("activity")}>View activity<ArrowUpRight className="ml-1.5 size-3.5" /></Button></div>{ongoing.length ? <TaskRows tasks={[...ongoing.filter((item) => item.state === "waiting_review"), ...ongoing.filter((item) => item.state !== "waiting_review")]} /> : <p className="border-b border-border py-5 text-sm text-muted-foreground">No ongoing work</p>}</section>
        <section aria-labelledby="recent-conversations"><div className="mb-2 flex items-center justify-between gap-3"><h2 id="recent-conversations" className="text-sm font-semibold">Recent conversations</h2><Button type="button" variant="ghost" size="sm" onClick={() => setTab("conversations")}>View all<ArrowUpRight className="ml-1.5 size-3.5" /></Button></div>{conversations.length ? <ConversationRows conversations={conversations} /> : <p className="py-5 text-sm text-muted-foreground">No conversations yet</p>}</section>
      </> : null}</TabsContent>
      <TabsContent value="conversations" className="mt-6"><SearchBar value={search} onChange={setSearch} placeholder="Search conversations" />{loading ? <ListSkeleton /> : !error ? conversations.length ? <ConversationRows conversations={conversations} /> : <p className="py-10 text-center text-sm text-muted-foreground">{search ? "No matching conversations" : "No conversations yet"}</p> : null}</TabsContent>
      <TabsContent value="activity" className="mt-6"><div className="mb-3 flex flex-wrap gap-3"><SearchBar value={search} onChange={setSearch} placeholder="Search work" /><label className="sr-only" htmlFor="task-state">Task state</label><select id="task-state" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={stateFilter} onChange={(event) => setStateFilter(event.target.value)}><option value="">All activity</option><option value="waiting_review">Needs review</option><option value="working">Working</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="uncertain">Outcome unknown</option></select></div>{loading ? <ListSkeleton /> : !error ? tasks.length ? <TaskRows tasks={tasks} /> : <p className="py-10 text-center text-sm text-muted-foreground">No matching activity</p> : null}</TabsContent>
      {cursor && !loading ? <div className="mt-4 text-center"><Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Load more"}</Button></div> : null}
    </Tabs>
    <Dialog open={newOpen} onOpenChange={setNewOpen}><DialogContent><DialogHeader><DialogTitle>New conversation</DialogTitle><DialogDescription className="sr-only">Choose an agent and optional business context</DialogDescription></DialogHeader><div className="space-y-2"><label htmlFor="new-conversation-context" className="text-xs font-medium">Context</label><Select value={newContext} onValueChange={setNewContext}><SelectTrigger id="new-conversation-context"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No attached context</SelectItem><SelectItem value="workspace">{agents.businessName}</SelectItem></SelectContent></Select></div><div className="space-y-2">{agents.bootstrap?.features.filter((feature) => feature.ready).map((feature) => <button key={feature.id} type="button" className="flex w-full items-center gap-3 rounded-lg border border-border px-3 py-3 text-left hover:bg-secondary" onClick={() => { setNewOpen(false); void agents.start(feature.id, newContext === "workspace" ? { kind: "workspace" } : null); }}><Bot className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{feature.name}</span><span className="mt-1 block text-xs text-muted-foreground">{feature.description}</span></span><ChevronRight className="size-4" /></button>)}</div></DialogContent></Dialog>
  </div></div>;
}
function SearchBar({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) { return <label className="relative mb-3 block w-full max-w-sm"><Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label={placeholder} placeholder={placeholder} value={value} onChange={(event) => onChange(event.target.value)} className="pl-9" /></label>; }
function ListSkeleton() { return <div role="status" aria-label="Loading work" className="space-y-5 py-5">{[1, 2, 3].map((value) => <Skeleton key={value} className="h-12 w-full" />)}</div>; }
function WorkspaceSkeleton() { return <div role="status" aria-label="Loading agents" className="space-y-8"><div className="grid gap-3 sm:grid-cols-2">{[1, 2, 3, 4].map((value) => <Skeleton key={value} className="h-40" />)}</div><ListSkeleton /></div>; }
