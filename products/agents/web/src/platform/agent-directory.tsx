import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import { Bot, ChevronLeft, History, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, message, organizationPath, type Agent, type CustomerOffering, type AgentSummary, type ConversationSummary, type Page } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

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
  const [query, setQuery] = useState("");
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  const [generation, setGeneration] = useState(0), [chatGeneration, setChatGeneration] = useState(0), [historyLoading, setHistoryLoading] = useState(false);
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [busy, setBusy] = useState(false), [directoryOpen, setDirectoryOpen] = useState(false);
  const [offerings, setOfferings] = useState<CustomerOffering[] | null>(null), [offering, setOffering] = useState<"faq" | "customer-service">("faq");
  const [creationError, setCreationError] = useState(""), [catalogueAttempt, setCatalogueAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true; setOfferings(null); setCreationError("");
    api<{ offerings: CustomerOffering[] }>(`${path}/offerings`).then(result => { if (live) setOfferings(result.offerings); }).catch(error => { if (live) setCreationError(message(error)); });
    return () => { live = false; };
  }, [open, path, catalogueAttempt]);
  const scope = useRef({ path, agentId, generation, query });
  scope.current = { path, agentId, generation, query };
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
  useEffect(() => { let live = true; api<Page<"agents", AgentSummary>>(`${path}/agents/summaries?q=${encodeURIComponent(query)}`).then(result => { if (live) { setAgents(result.agents); setAgentCursor(result.nextCursor); setError(""); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path, generation, query]);
  useEffect(() => {
    setConversations([]); setConversationCursor(null); setHistoryError("");
    if (!agentId) return;
    let live = true; setHistoryLoading(true);
    api<Page<"conversations", ConversationSummary>>(`${path}/conversations?agentId=${encodeURIComponent(agentId)}`).then(result => { if (live) { setConversations(result.conversations); setConversationCursor(result.nextCursor); } }).catch(e => { if (live) setHistoryError(message(e)); }).finally(() => { if (live) setHistoryLoading(false); });
    return () => { live = false; };
  }, [path, agentId, generation]);
  async function moreAgents() { if (!agentCursor || busy) return; setBusy(true); const captured = scope.current; try { const result = await api<Page<"agents", AgentSummary>>(`${path}/agents/summaries?q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(agentCursor)}`); if (scope.current.path !== captured.path || scope.current.generation !== captured.generation || scope.current.query !== captured.query) return; setAgents(current => [...(current ?? []), ...result.agents]); setAgentCursor(result.nextCursor); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function moreConversations() { if (!conversationCursor || !agentId || busy) return; setBusy(true); const captured = scope.current; try { const result = await api<Page<"conversations", ConversationSummary>>(`${path}/conversations?agentId=${encodeURIComponent(agentId)}&cursor=${encodeURIComponent(conversationCursor)}`); if (scope.current.path !== captured.path || scope.current.agentId !== captured.agentId || scope.current.generation !== captured.generation) return; setConversations(current => [...current, ...result.conversations]); setConversationCursor(result.nextCursor); } catch (e) { setHistoryError(message(e)); } finally { setBusy(false); } }
  async function create(event: FormEvent) { event.preventDefault(); if (busy || !offerings?.some(item => item.id === offering && item.available)) return; setBusy(true); try { const result = await api<{ agent: Agent }>(`${path}/agents`, { name, offering }); setOpen(false); setName(""); setOffering("faq"); refresh(); setDirectoryOpen(false); navigate(`/app/agents/${result.agent.id}?section=configuration`); toast.success("Agent created"); } catch (e) { toast.error(message(e)); } finally { setBusy(false); } }
  const directory = <>
    <div className="agent-directory-heading"><h2>Agents</h2><Button aria-label="Create agent" title="Create agent" variant="ghost" size="icon" onClick={() => setOpen(true)}><Plus size={17} /></Button></div>
    <label className="agent-search"><Search size={15} /><Input aria-label="Search agents" placeholder="Search agents" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <ErrorMessage value={error} />
    {!agents && !error ? <Loading /> : <nav aria-label="Agent directory" className="agent-roster">{agents?.map(agent => <Link key={agent.id} to={`/app/agents/${agent.id}`} onClick={() => setDirectoryOpen(false)} aria-current={agentId === agent.id ? "page" : undefined} className={`agent-roster-item ${agentId === agent.id ? "is-active" : ""}`}><span className="agent-avatar"><Bot size={17} /></span><span className="min-w-0"><span className="block truncate font-medium">{agent.name}</span></span></Link>)}{agents?.length === 0 && !query ? <div className="px-3 py-6 text-sm text-muted-foreground">No agents yet</div> : agents?.length === 0 && query ? <p className="px-3 py-4 text-sm text-muted-foreground">No matching agents</p> : null}</nav>}
    {agentCursor ? <Button variant="ghost" size="sm" onClick={() => void moreAgents()} disabled={busy}>Load more agents</Button> : null}
    {agentId ? <section className="conversation-directory"><div className="agent-directory-heading"><h2><History size={14} />Conversations</h2><Button aria-label="Start new conversation" title="New chat" size="icon" variant="ghost" onClick={newChat}><Plus size={16} /></Button></div><ErrorMessage value={historyError} />{historyLoading ? <div role="status" className="p-3 text-xs text-muted-foreground">Loading conversations…</div> : conversations.length ? <nav aria-label="Conversation history">{conversations.map(conversation => <Link key={conversation.id} to={`/app/agents/${agentId}/conversations/${conversation.id}`} onClick={() => setDirectoryOpen(false)} aria-current={conversationId === conversation.id ? "page" : undefined} className={`conversation-link ${conversationId === conversation.id ? "is-active" : ""}`}><span className="truncate">{conversation.title}</span></Link>)}</nav> : !historyError ? <p className="px-3 py-4 text-xs text-muted-foreground">No conversations yet</p> : null}{conversationCursor ? <Button size="sm" variant="ghost" onClick={() => void moreConversations()} disabled={busy}>Older conversations</Button> : null}</section> : null}
  </>;
  return <DirectoryContext.Provider value={{ refresh, newChat, chatGeneration }}><div className="agent-workspace"><aside className="agent-directory">{directory}</aside><div className="agent-content"><div className="agent-mobile-toolbar"><Button ref={directoryTrigger} variant="ghost" size="sm" onClick={() => setDirectoryOpen(true)}><ChevronLeft size={16} />Agents & history</Button></div><div className="agent-route" key={agentId ?? "overview"}><Outlet key={location.pathname.startsWith("/app/agents/") ? agentId : "overview"} /></div></div></div>
    <Dialog open={directoryOpen} onOpenChange={setDirectoryOpen}><DialogContent className="agent-directory-drawer" onCloseAutoFocus={event => { event.preventDefault(); directoryTrigger.current?.focus(); }}><DialogHeader><DialogTitle>Agents & history</DialogTitle><DialogDescription className="sr-only">Choose an agent or conversation.</DialogDescription></DialogHeader>{directory}</DialogContent></Dialog>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent><DialogHeader><DialogTitle>Create agent</DialogTitle><DialogDescription className="sr-only">Create a customer agent.</DialogDescription></DialogHeader><form onSubmit={event => void create(event)} className="space-y-4"><label className="block space-y-2 text-sm">Name<Input required maxLength={120} autoFocus value={name} onChange={event => setName(event.target.value)} /></label><ErrorMessage value={creationError} />{creationError ? <Button type="button" variant="outline" onClick={() => setCatalogueAttempt(value => value + 1)}>Try again</Button> : offerings ? <label className="block space-y-2 text-sm">Agent type<select className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={offering} onChange={event => { if (event.target.value === "faq" || event.target.value === "customer-service") setOffering(event.target.value); }}>{offerings.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.name}{!item.available ? " · Unavailable" : ""}</option>)}</select></label> : <p role="status" className="text-sm text-muted-foreground">Loading types…</p>}<Button type="submit" disabled={busy || !name.trim() || !offerings?.some(item => item.id === offering && item.available)}>{busy ? "Creating…" : "Create agent"}</Button></form></DialogContent></Dialog>
  </DirectoryContext.Provider>;
}
export function AgentWelcome() { return <section className="agent-welcome"><span className="agent-welcome-icon"><Bot size={30} /></span><h1>What shall we work on?</h1><p>Select an agent to start a chat.</p></section>; }
