import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { PiRobot as Bot, PiCaretLeft as ChevronLeft, PiClockCounterClockwise as History, PiPlus as Plus, PiMagnifyingGlass as Search, PiChatCircle, PiPulse, PiSlidersHorizontal } from "react-icons/pi";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, message, organizationPath, type AgentSummary, type ConversationSummary, type Page } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { GuidedAgentCreation } from "./guided-agent-creation";
import { AgentLanding } from "./agent-landing";
import { AgentAvatar } from "./agent-avatar";

type Directory = { refresh: () => void; newChat: () => void; chatGeneration: number };
const DirectoryContext = createContext<Directory>({ refresh: () => {}, newChat: () => {}, chatGeneration: 0 });
export const useAgentDirectory = () => useContext(DirectoryContext);

export function AgentDirectory() {
  const { organizationId, session } = useWorkspace();
  const { agentId, conversationId } = useParams();
  const directoryTrigger = useRef<HTMLButtonElement>(null);
  const location = useLocation(), navigate = useNavigate();
  const path = organizationPath(organizationId);
  const [agents, setAgents] = useState<AgentSummary[] | null>(null), [agentCursor, setAgentCursor] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]), [conversationCursor, setConversationCursor] = useState<string | null>(null);
  const [error, setError] = useState(""), [historyError, setHistoryError] = useState(""), [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const [generation, setGeneration] = useState(0), [chatGeneration, setChatGeneration] = useState(0), [historyLoading, setHistoryLoading] = useState(false);
  const resumeSetup = new URLSearchParams(location.search).get("setup") === "guided";
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [directoryOpen, setDirectoryOpen] = useState(false);
  const scope = useRef({ path, agentId, generation, query, filter });
  scope.current = { path, agentId, generation, query, filter };
  const refresh = useCallback(() => setGeneration(value => value + 1), []);
  const newChat = useCallback(() => {
    if (!agentId) return;
    const prefix = `agents.chat.${session.account.id}.${organizationId}.${agentId}.`;
    try {
      const keys = Object.keys(sessionStorage).filter(key => key.startsWith(prefix) && !key.endsWith(".draft"));
      if (keys.some(key => { try { const entries = JSON.parse(sessionStorage.getItem(key) ?? "null"); return Array.isArray(entries) && entries.some(entry => entry.requestKey && !entry.task); } catch { return false; } })) { toast.error("Resolve the pending request before starting a new chat."); return; }
      keys.filter(key => key.endsWith(".new")).forEach(key => { sessionStorage.removeItem(key); sessionStorage.removeItem(`${key}.draft`); });
    } catch { /* Server history remains authoritative if browser storage is unavailable. */ }
    setChatGeneration(value => value + 1); navigate(`/app/agents/${agentId}`); setDirectoryOpen(false);
  }, [agentId, navigate, organizationId, session.account.id]);
  useEffect(() => { let live = true; setAgents(null); setAgentCursor(null); setError(""); api<Page<"agents", AgentSummary>>(`${path}/agents/summaries?q=${encodeURIComponent(query)}&status=${encodeURIComponent(filter)}`).then(result => { if (live) { setAgents(result.agents); setAgentCursor(result.nextCursor); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path, generation, query, filter]);
  useEffect(() => {
    setConversations([]); setConversationCursor(null); setHistoryError("");
    if (!agentId) return;
    let live = true; setHistoryLoading(true);
    api<Page<"conversations", ConversationSummary>>(`${path}/conversations?agentId=${encodeURIComponent(agentId)}`).then(result => { if (live) { setConversations(result.conversations); setConversationCursor(result.nextCursor); } }).catch(e => { if (live) setHistoryError(message(e)); }).finally(() => { if (live) setHistoryLoading(false); });
    return () => { live = false; };
  }, [path, agentId, generation]);
  async function moreAgents() { if (!agentCursor || busy) return; setBusy(true); const captured = scope.current; try { const result = await api<Page<"agents", AgentSummary>>(`${path}/agents/summaries?q=${encodeURIComponent(query)}&status=${encodeURIComponent(filter)}&cursor=${encodeURIComponent(agentCursor)}`); if (scope.current.path !== captured.path || scope.current.generation !== captured.generation || scope.current.query !== captured.query || scope.current.filter !== captured.filter) return; setAgents(current => [...(current ?? []), ...result.agents]); setAgentCursor(result.nextCursor); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function moreConversations() { if (!conversationCursor || !agentId || busy) return; setBusy(true); const captured = scope.current; try { const result = await api<Page<"conversations", ConversationSummary>>(`${path}/conversations?agentId=${encodeURIComponent(agentId)}&cursor=${encodeURIComponent(conversationCursor)}`); if (scope.current.path !== captured.path || scope.current.agentId !== captured.agentId || scope.current.generation !== captured.generation) return; setConversations(current => [...current, ...result.conversations]); setConversationCursor(result.nextCursor); } catch (e) { setHistoryError(message(e)); } finally { setBusy(false); } }
  const activeSection = new URLSearchParams(location.search).get("section") ?? "chat";
  const configMode = Boolean(agentId && ["configuration", "tools", "skills", "publish"].includes(activeSection));
  const navigateSection = (value: string) => navigate({ pathname: location.pathname, search: value === "chat" ? "" : `?section=${value}` }, { replace: true });
  const configurationDirectory = <div className="agent-configuration-navigation">
    <button type="button" className="agent-configuration-back" onClick={() => navigate(`/app/agents/${agentId}`)} aria-label="Back to agent chat"><span className="agent-avatar"><Bot size={19} /></span></button>
    <nav aria-label="Agent sections">{([["chat", "Chat", PiChatCircle], ["activity", "Activity", PiPulse], ["configuration", "Configure", PiSlidersHorizontal]] as const).map(([id, label, Icon]) => <button key={id} type="button" className={id === "configuration" ? "is-active" : ""} onClick={() => navigateSection(id)}><Icon size={17} />{label}</button>)}</nav>
    <nav aria-label="Configuration sections" className="agent-configuration-subnav">{([["configuration", "General"], ["tools", "Tools"], ["skills", "Skills"], ["publish", "Website"]] as const).map(([id, label]) => <button key={id} type="button" aria-current={activeSection === id ? "page" : undefined} onClick={() => navigateSection(id)}>{label}</button>)}</nav>
  </div>;
  const directory = <>
    <div className="agent-directory-heading"><h2>Agents</h2><Button aria-label="Create agent" title="Create agent" variant="ghost" size="icon" onClick={() => setOpen(true)}><Plus size={17} /></Button></div>
    <label className="agent-search"><Search size={15} /><Input aria-label="Search agents" placeholder="Search agents" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <ErrorMessage value={error} />
    {!agents && !error ? <Loading /> : <nav aria-label="Agent directory" className="agent-roster">{agents?.map(agent => <Link key={agent.id} to={`/app/agents/${agent.id}`} onClick={() => setDirectoryOpen(false)} aria-current={agentId === agent.id ? "page" : undefined} className={`agent-roster-item ${agentId === agent.id ? "is-active" : ""}`}><AgentAvatar id={agent.avatar} size={30} /><span className="min-w-0"><span className="block truncate font-medium">{agent.name}</span></span></Link>)}{agents?.length === 0 && !query ? <div className="px-3 py-6 text-sm text-muted-foreground">No agents yet</div> : agents?.length === 0 && query ? <p className="px-3 py-4 text-sm text-muted-foreground">No matching agents</p> : null}</nav>}
    {agentCursor ? <Button variant="ghost" size="sm" onClick={() => void moreAgents()} disabled={busy}>Load more agents</Button> : null}
    {agentId ? <section className="conversation-directory"><div className="agent-directory-heading"><h2><History size={14} />Conversations</h2><Button aria-label="Start new conversation" title="New chat" size="icon" variant="ghost" onClick={newChat}><Plus size={16} /></Button></div><ErrorMessage value={historyError} />{historyLoading ? <div role="status" className="p-3 text-xs text-muted-foreground">Loading conversations…</div> : conversations.length ? <nav aria-label="Conversation history">{conversations.map(conversation => <Link key={conversation.id} to={`/app/agents/${agentId}/conversations/${conversation.id}`} onClick={() => setDirectoryOpen(false)} aria-current={conversationId === conversation.id ? "page" : undefined} className={`conversation-link ${conversationId === conversation.id ? "is-active" : ""}`}><span className="truncate">{conversation.title}</span></Link>)}</nav> : !historyError ? <p className="px-3 py-4 text-xs text-muted-foreground">No conversations yet</p> : null}{conversationCursor ? <Button size="sm" variant="ghost" onClick={() => void moreConversations()} disabled={busy}>Older conversations</Button> : null}</section> : null}
  </>;
  return <DirectoryContext.Provider value={{ refresh, newChat, chatGeneration }}>{agentId ? <div className={`agent-workspace ${configMode ? "is-configuring" : ""}`}><aside className="agent-directory">{configMode ? configurationDirectory : directory}</aside><div className="agent-content"><div className="agent-mobile-toolbar"><Button ref={directoryTrigger} variant="ghost" size="sm" onClick={() => setDirectoryOpen(true)}><ChevronLeft size={16} />Agents & history</Button></div><div className="agent-route" key={agentId}><Outlet key={agentId} /></div></div></div> : <AgentLanding agents={agents} search={search} onSearch={setSearch} filter={filter} onFilter={setFilter} error={error} onRetry={refresh} hasMore={Boolean(agentCursor)} onMore={() => void moreAgents()} busy={busy} onCreate={() => setOpen(true)} />}
    <Dialog open={directoryOpen} onOpenChange={setDirectoryOpen}><DialogContent className="agent-directory-drawer" onCloseAutoFocus={event => { event.preventDefault(); directoryTrigger.current?.focus(); }}><DialogHeader><DialogTitle>Agents & history</DialogTitle><DialogDescription className="sr-only">Choose an agent or conversation.</DialogDescription></DialogHeader>{directory}</DialogContent></Dialog>
    <GuidedAgentCreation key={`${session.account.id}.${organizationId}`} open={open || resumeSetup} onOpenChange={value => { setOpen(value); if (!value && resumeSetup) navigate(`/app/agents/${agentId}`,{replace:true}); }} organizationId={organizationId} resumeAgentId={resumeSetup ? agentId : undefined} onCreated={id => { refresh(); setOpen(false); setDirectoryOpen(false); navigate(`/app/agents/${id}`); }} onDraftCreated={refresh} />
  </DirectoryContext.Provider>;
}
export function AgentWelcome() { return <section className="agent-welcome"><span className="agent-welcome-icon"><Bot size={30} /></span><h1>What shall we work on?</h1><p>Select an agent to start a chat.</p></section>; }
