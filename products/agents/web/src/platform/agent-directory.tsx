import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { PiRobot as Bot, PiCaretLeft as ChevronLeft, PiPlus as Plus, PiMagnifyingGlass as Search, PiChatCircle, PiSquaresFour, PiLightning, PiBookOpen, PiSlidersHorizontal, PiChatTeardrop, PiRocketLaunch, PiGear } from "react-icons/pi";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, hasPermission, message, organizationPath, type AgentSummary, type Page } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { GuidedAgentCreation } from "./guided-agent-creation";
import { CreateAgentDialog } from "./create-agent-dialog";
import { AgentLanding } from "./agent-landing";
import { AgentAvatar } from "./agent-avatar";
import { AgentSetupProgress } from "./agent-setup-progress";

type Directory = { refresh: () => void; newChat: () => void; chatGeneration: number };
const DirectoryContext = createContext<Directory>({ refresh: () => {}, newChat: () => {}, chatGeneration: 0 });
export const useAgentDirectory = () => useContext(DirectoryContext);

export const agentSections = [
  ["overview", "Overview", PiSquaresFour],
  ["conversations", "Conversations", PiChatCircle],
  ["capabilities", "Capabilities", PiLightning],
  ["knowledge", "Training data", PiBookOpen],
  ["behaviour", "Behaviour", PiSlidersHorizontal],
  ["widget", "Chat widget", PiChatTeardrop],
  ["deploy", "Deploy", PiRocketLaunch],
  ["settings", "Settings", PiGear],
] as const;
const legacySections: Record<string, string> = { configuration: "behaviour", tools: "behaviour", skills: "behaviour", channels: "deploy", publish: "widget", activity: "conversations", chat: "conversations" };
export const normalizeAgentSection = (value: string | null) => {
  const section = value ?? "overview";
  return legacySections[section] ?? section;
};

export function AgentDirectory() {
  const { organizationId, session, plan } = useWorkspace();
  const { agentId, conversationId } = useParams();
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const location = useLocation(), navigate = useNavigate();
  const path = organizationPath(organizationId);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null), [agentCursor, setAgentCursor] = useState<string | null>(null);
  const [assistantAgentId, setAssistantAgentId] = useState<string | null>(null);
  const [assistantReady, setAssistantReady] = useState(false);
  const [error, setError] = useState(""), [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const [generation, setGeneration] = useState(0), [chatGeneration, setChatGeneration] = useState(0);
  const resumeSetup = new URLSearchParams(location.search).get("setup") === "guided";
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [directoryOpen, setDirectoryOpen] = useState(false);
  const scope = useRef({ path, generation, query, filter });
  scope.current = { path, generation, query, filter };
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  const newChat = useCallback(() => {
    if (!agentId) return;
    const prefix = `agents.chat.${session.account.id}.${organizationId}.${agentId}.`;
    try {
      const keys = Object.keys(sessionStorage).filter(key => key.startsWith(prefix) && !key.endsWith(".draft"));
      if (keys.some(key => { try { const entries = JSON.parse(sessionStorage.getItem(key) ?? "null"); return Array.isArray(entries) && entries.some(entry => entry.requestKey && !entry.task); } catch { return false; } })) { toast.error("Resolve the pending request before starting a new chat."); return; }
      keys.filter(key => key.endsWith(".new")).forEach(key => { sessionStorage.removeItem(key); sessionStorage.removeItem(`${key}.draft`); });
    } catch { /* Server history remains authoritative if browser storage is unavailable. */ }
    setChatGeneration(value => value + 1); navigate(`/app/agents/${agentId}?section=chat`); setDirectoryOpen(false);
  }, [agentId, navigate, organizationId, session.account.id]);
  useEffect(() => { let live = true; setAgents(null); setAgentCursor(null); setError(""); api<Page<"agents", AgentSummary>>(`${path}/agents/summaries?q=${encodeURIComponent(query)}&status=${encodeURIComponent(filter)}`).then(result => { if (live) { setAgents(result.agents); setAgentCursor(result.nextCursor); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path, generation, query, filter]);
  useEffect(() => {
    let live = true;
    setAssistantReady(false);
    // The workspace assistant is a system helper, not a customer agent. Keep it out of the agent catalogue.
    api<{ agent: { id: string } | null }>(`${path}/assistant`)
      .then(result => { if (live) { setAssistantAgentId(result.agent?.id ?? null); setAssistantReady(true); } })
      .catch(() => { if (live) setAssistantReady(true); });
    return () => { live = false; };
  }, [path, generation]);
  async function moreAgents() { if (!agentCursor || busy) return; setBusy(true); const captured = scope.current; try { const result = await api<Page<"agents", AgentSummary>>(`${path}/agents/summaries?q=${encodeURIComponent(query)}&status=${encodeURIComponent(filter)}&cursor=${encodeURIComponent(agentCursor)}`); if (scope.current.path !== captured.path || scope.current.generation !== captured.generation || scope.current.query !== captured.query || scope.current.filter !== captured.filter) return; setAgents(current => [...(current ?? []), ...result.agents]); setAgentCursor(result.nextCursor); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  const visibleAgents = useMemo(
    () => (assistantReady ? agents?.filter(item => item.id !== assistantAgentId) ?? null : null),
    [agents, assistantReady, assistantAgentId],
  );
  const agent = agents?.find(item => item.id === agentId);
  const section = conversationId ? "conversations" : normalizeAgentSection(new URLSearchParams(location.search).get("section"));
  const workspace = session.organizations.find(item => item.id === organizationId);
  const canConfigure = hasPermission(workspace, "agents.manage");
  const canDelete = hasPermission(workspace, "agents.delete");
  const canDeployWidget = hasPermission(workspace, "deploy.manage");
  const canDeployChannels = hasPermission(workspace, "channels.manage");
  const visibleSections = agentSections.filter(([id]) => {
    if (id === "capabilities" || id === "knowledge" || id === "behaviour") return canConfigure;
    if (id === "widget") return canDeployWidget;
    if (id === "deploy") return canDeployChannels;
    if (id === "settings") return canConfigure || canDelete;
    return true;
  });
  useEffect(() => {
    if (!agentId) return;
    if (visibleSections.some(([id]) => id === section)) return;
    navigate(`/app/agents/${agentId}?section=overview`, { replace: true });
  }, [agentId, navigate, section, canConfigure, canDelete, canDeployWidget, canDeployChannels]);
  const agentMenu = <>
    <Link className="agent-scope-back" to="/app/agents" onClick={() => setDirectoryOpen(false)}><ChevronLeft size={15} />All agents</Link>
    <div className="agent-scope-head"><AgentAvatar id={agent?.avatar} size={38} /><div className="agent-scope-identity"><strong>{agent?.name ?? "Agent"}</strong><button type="button" className="agent-scope-new" onClick={newChat}><Plus size={13} />Start chat</button></div></div>
    <nav className="agent-scope-nav" aria-label="Agent sections">{visibleSections.map(([id, label, Icon]) => <Link key={id} to={`/app/agents/${agentId}?section=${id}`} onClick={() => setDirectoryOpen(false)} aria-current={section === id ? "page" : undefined} className={section === id ? "is-active" : ""}><Icon size={17} />{label}</Link>)}</nav>
    {!canConfigure ? <p className="agent-scope-readonly">Read-only access</p> : <AgentSetupProgress organizationId={organizationId} agentId={agentId ?? ""} draftRevision={agent?.draftRevision ?? 0} />}
  </>;
  const directory = <>
    <div className="agent-directory-heading"><h2>Agents</h2>{canConfigure ? <Button aria-label="Create agent" title="Create agent" variant="ghost" size="icon" onClick={() => setOpen(true)}><Plus size={17} /></Button> : null}</div>
    <label className="agent-search"><Search size={15} /><Input aria-label="Search agents" placeholder="Search agents" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <ErrorMessage value={error} />
    {!visibleAgents && !error ? <Loading /> : <nav aria-label="Agent directory" className="agent-roster">{visibleAgents?.map(agent => <Link key={agent.id} to={`/app/agents/${agent.id}`} onClick={() => setDirectoryOpen(false)} aria-current={agentId === agent.id ? "page" : undefined} className={`agent-roster-item ${agentId === agent.id ? "is-active" : ""}`}><AgentAvatar id={agent.avatar} size={30} /><span className="min-w-0"><span className="block truncate font-medium">{agent.name}</span></span></Link>)}{visibleAgents?.length === 0 && !query ? <div className="px-3 py-6 text-sm text-muted-foreground">No agents yet</div> : visibleAgents?.length === 0 && query ? <p className="px-3 py-4 text-sm text-muted-foreground">No matching agents</p> : null}</nav>}
    {agentCursor ? <Button variant="ghost" size="sm" onClick={() => void moreAgents()} disabled={busy}>Load more agents</Button> : null}
  </>;
  return <DirectoryContext.Provider value={{ refresh, newChat, chatGeneration }}>{agentId ? <div className="agent-workspace"><aside className="agent-directory">{agentMenu}</aside><div className="agent-content"><div className="agent-mobile-toolbar"><Button ref={directoryTrigger} variant="ghost" size="sm" onClick={() => setDirectoryOpen(true)}><ChevronLeft size={16} />Agent menu</Button></div><div className="agent-route" key={agentId}><Outlet key={agentId} /></div></div></div> : <AgentLanding agents={visibleAgents} plan={plan} search={search} onSearch={setSearch} filter={filter} onFilter={setFilter} error={error} onRetry={refresh} hasMore={Boolean(agentCursor)} onMore={() => void moreAgents()} busy={busy} canCreate={canConfigure} onCreate={() => setOpen(true)} />}
    <Dialog open={directoryOpen} onOpenChange={setDirectoryOpen}><DialogContent className="agent-directory-drawer" onCloseAutoFocus={event => { event.preventDefault(); directoryTrigger.current?.focus(); }}><DialogHeader><DialogTitle>{agentId ? "Agent menu" : "Agents"}</DialogTitle><DialogDescription className="sr-only">Choose an agent or a section.</DialogDescription></DialogHeader>{agentId ? agentMenu : directory}</DialogContent></Dialog>
    <CreateAgentDialog key={`${session.account.id}.${organizationId}`} open={canConfigure && open && !resumeSetup} onOpenChange={setOpen} organizationId={organizationId} onCreated={id => { refresh(); setOpen(false); setDirectoryOpen(false); navigate(`/app/agents/${id}?section=behaviour`); }} />
    {resumeSetup ? <GuidedAgentCreation key={`${session.account.id}.${organizationId}`} open={canConfigure} onOpenChange={value => { if (!value) navigate(`/app/agents/${agentId}`,{replace:true}); }} organizationId={organizationId} resumeAgentId={agentId} onCreated={id => { refresh(); setDirectoryOpen(false); navigate(`/app/agents/${id}`); }} onDraftCreated={refresh} /> : null}
  </DirectoryContext.Provider>;
}
export function AgentWelcome() { return <section className="agent-welcome"><span className="agent-welcome-icon"><Bot size={30} /></span><h1>What shall we work on?</h1><p>Select an agent to start a chat.</p></section>; }
