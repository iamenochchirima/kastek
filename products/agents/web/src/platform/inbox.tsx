import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, message, organizationPath, readStored, writeStored } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

export type InboxConversation = { id: string; agentId: string; agentName?: string; deploymentId: string; versionId: string;
  channel: "website"; state: "automation_active" | "handoff_pending" | "human_owned" | "resolved"; assigneeAccountId: string | null;
  revision: string; ownershipGeneration: string; createdAt: string; updatedAt: string };
export type CustomerMessage = { id: string; sequence: string; authorKind: "visitor" | "human" | "assistant"; body: string; createdAt: string; authorAccountId?: string; taskId?: string };
export type CustomerTimeline = { conversation: InboxConversation; messages: CustomerMessage[]; nextSequence: string; latestSequence?: string; earlierBefore?: string | null };
type Command = { commandId: string; expectedRevision: string; action: string; body?: string; assigneeAccountId?: string };
const labels = { automation_active: "Automated", handoff_pending: "Needs a person", human_owned: "With support", resolved: "Resolved" };
export function CustomerMessages({ messages }: { messages: CustomerMessage[] }) {
  return <div className="space-y-5" role="log" aria-label="Conversation messages" aria-live="polite">{messages.map(item => <article key={item.id} className={`rounded-lg border p-3 ${item.authorKind === "visitor" ? "bg-muted/40" : "bg-background"}`}><p className="mb-2 text-xs font-medium text-muted-foreground">{item.authorKind === "visitor" ? "Customer" : item.authorKind === "human" ? "Support" : "Assistant"}<time dateTime={item.createdAt} className="ml-3 font-normal">{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{item.body}</p></article>)}</div>;
}
export function HistoryNavigation({ timeline, earlier, latest, onEarlier, onLatest }: { timeline: CustomerTimeline | null; earlier: boolean; latest: boolean; onEarlier(): void; onLatest(): void }) {
  if (latest && !earlier) return null;
  return <nav aria-label="Message history" className="mb-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!timeline || !earlier} onClick={onEarlier}>Earlier messages</Button>{!latest ? <Button size="sm" variant="outline" onClick={onLatest}>Latest messages</Button> : null}</nav>;
}
export function InboxPage() {
  const { organizationId, session } = useWorkspace(), base = `${organizationPath(organizationId)}/inbox`;
  const [items, setItems] = useState<InboxConversation[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState(""), [timeline, setTimeline] = useState<CustomerTimeline | null>(null), [members, setMembers] = useState<{ id: string; displayName: string }[]>([]);
  const [state, setState] = useState(""), [agentId, setAgentId] = useState(""), [assigned, setAssigned] = useState(""), [assignee, setAssignee] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [body, setBody] = useState("");
  const [pending, setPending] = useState<Command | null>(null);
  const [agentOptions, setAgentOptions] = useState<{ id: string; name: string }[]>([]), [agentCursor, setAgentCursor] = useState<string | null>(null);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [before, setBefore] = useState<string | null>(null), pageRef = useRef(before), historyRequest = useRef(0);
  pageRef.current = before;
  function historyPage(value: string | null) { pageRef.current = value; historyRequest.current++; setTimeline(null); setBefore(value); }
  const path = `${base}?${new URLSearchParams({ ...(state ? { state } : {}), ...(agentId ? { agentId } : {}), ...(assigned ? { assigned } : {}) })}`;
  const pathRef = useRef(path); pathRef.current = path;
  const pendingKey = `agents.inbox.pending.${session.account.id}.${organizationId}.${selected}`;
  const owner = session.organizations.find(org => org.id === organizationId)?.role === "owner";
  const mine = timeline?.conversation.assigneeAccountId === session.account.id;
  async function loadList(more = false) {
    const expected = path; const result = await api<{ conversations: InboxConversation[]; nextCursor: string | null }>(path + (more && cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    if (pathRef.current !== expected) return; setItems(old => more ? [...new Map([...old ?? [], ...result.conversations].map(item => [item.id, item])).values()] : result.conversations); setCursor(result.nextCursor);
  }
  async function loadConversation(id: string) {
    const expectedPage = pageRef.current, request = ++historyRequest.current;
    const current = () => selectedRef.current === id && pageRef.current === expectedPage && historyRequest.current === request;
    try {
      const result = await api<CustomerTimeline>(`${base}/${encodeURIComponent(id)}?limit=100${expectedPage ? `&before=${expectedPage}` : ""}`);
      if (current()) setTimeline(result);
    } catch (error) { if (current()) { setTimeline(null); throw error; } }
  }
  useEffect(() => { let live = true; setItems(null); setError(""); api<{ conversations: InboxConversation[]; nextCursor: string | null }>(path).then(result => { if (live) { setItems(result.conversations); setCursor(result.nextCursor); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path]);
  useEffect(() => { let live = true; api<{ members: { id: string; displayName: string }[] }>(`${base}/members`).then(result => { if (live) setMembers(result.members); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [base]);
  useEffect(() => { let live = true; api<{ agents: { id: string; name: string }[]; nextCursor: string | null }>(`${organizationPath(organizationId)}/agents/summaries?limit=100`).then(result => { if (live) { setAgentOptions(result.agents); setAgentCursor(result.nextCursor); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [organizationId]);
  useEffect(() => {
    setTimeline(null); if (!selected) return;
    let stopped = false, running = false;
    const refresh = async () => { if (running || stopped) return; running = true; try { await loadConversation(selected); } catch (e) { if (!stopped) setError(message(e)); } finally { running = false; } };
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate requests across the polling lifetime, rather than capture a DOM ref.
    return () => { stopped = true; historyRequest.current++; window.clearInterval(timer); };
    // Workspace remounts the page; selection owns the polling lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, base, before]);
  useEffect(() => { setBody(""); setPending(readStored<Command>(pendingKey)); }, [pendingKey]);
  async function runCommand(action: string, extra: Partial<Command> = {}) {
    if (!timeline || busy) return; const id = selected, key = pendingKey;
    const command = pending ?? { commandId: crypto.randomUUID(), expectedRevision: timeline.conversation.revision, action, ...extra };
    setPending(command); writeStored(key, command); setBusy(true); setError("");
    try { await api(`${base}/${id}/commands`, command); writeStored(key, null); if (selectedRef.current === id) { setPending(null); setBody(""); await loadConversation(id); } await loadList(); }
    catch (e) { if (e instanceof ApiError && e.status < 500) { writeStored(key, null); if (selectedRef.current === id) setPending(null); await loadConversation(id).catch(() => {}); } if (selectedRef.current === id) setError(message(e)); }
    finally { setBusy(false); }
  }
  function reply(event: FormEvent) { event.preventDefault(); void runCommand("reply", { body: body.trim() }); }
  async function moreAgents() { if (!agentCursor) return; try { const result = await api<{ agents: { id: string; name: string }[]; nextCursor: string | null }>(`${organizationPath(organizationId)}/agents/summaries?limit=100&cursor=${encodeURIComponent(agentCursor)}`); setAgentOptions(old => [...new Map([...old, ...result.agents].map(agent => [agent.id, agent])).values()]); setAgentCursor(result.nextCursor); } catch (e) { setError(message(e)); } }
  const agents = agentOptions.map(agent => [agent.id, agent.name]);
  return <section className="workspace-page min-w-0"><header className="flex items-center justify-between gap-4"><h1 className="text-2xl font-semibold">Inbox</h1><Button variant="outline" size="sm" onClick={() => void loadList().catch(e => setError(message(e)))}><RefreshCw size={15} />Refresh</Button></header>
    <div className="my-5 flex flex-wrap gap-2"><select aria-label="Filter Inbox status" className="task-filter" value={state} onChange={event => setState(event.target.value)}><option value="">All statuses</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Filter Inbox agent" className="task-filter" value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">All agents</option>{agents.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select><select aria-label="Filter Inbox assignment" className="task-filter" value={assigned} onChange={event => setAssigned(event.target.value)}><option value="">Everyone</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option></select><span className="self-center text-xs text-muted-foreground">Website</span>{agentCursor ? <Button size="sm" variant="ghost" onClick={() => void moreAgents()}>Load more agents</Button> : null}</div>
    <ErrorMessage value={error} /><div className="mt-4 grid min-w-0 gap-5 md:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]"><aside aria-label="Customer conversations" className={`${selected ? "hidden md:block" : ""} min-w-0`}>{!items ? <Loading /> : items.length ? <div className="space-y-2">{items.map(item => <button type="button" key={item.id} onClick={() => { selectedRef.current = item.id; setSelected(item.id); historyPage(null); setError(""); }} aria-pressed={selected === item.id} className={`block w-full rounded-lg border p-3 text-left ${selected === item.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}><span className="block truncate text-sm font-medium">{item.agentName ?? "Customer conversation"}</span><span className="mt-1 block text-xs text-muted-foreground">{labels[item.state]}</span><time dateTime={item.updatedAt} className="mt-2 block text-xs text-muted-foreground">{new Date(item.updatedAt).toLocaleString()}</time></button>)}</div> : <p className="py-12 text-sm text-muted-foreground">No customer conversations</p>}{cursor ? <Button variant="ghost" className="mt-3" onClick={() => void loadList(true).catch(e => setError(message(e)))}>Load more conversations</Button> : null}</aside>
      <div className="min-w-0">{selected ? <><Button variant="ghost" size="sm" className="mb-3 md:hidden" onClick={() => setSelected("")}><ArrowLeft size={15} />Conversations</Button>{timeline ? <><header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b pb-4"><div><h2 className="font-medium">Customer conversation</h2><p className="mt-1 text-xs text-muted-foreground">{labels[timeline.conversation.state]}</p><p className="mt-1 text-xs text-muted-foreground">{members.find(member => member.id === timeline.conversation.assigneeAccountId)?.displayName ?? "Unassigned"}</p></div><div className="flex flex-wrap gap-2">{!timeline.conversation.assigneeAccountId ? <Button size="sm" variant="outline" disabled={busy || !!pending} onClick={() => void runCommand("claim")}>Assign to me</Button> : null}{mine && timeline.conversation.state !== "human_owned" && timeline.conversation.state !== "resolved" ? <Button size="sm" disabled={busy || !!pending} onClick={() => void runCommand("takeover")}>Take over</Button> : null}{mine && ["human_owned", "handoff_pending"].includes(timeline.conversation.state) ? <Button size="sm" variant="outline" disabled={busy || !!pending} onClick={() => void runCommand("return")}>Return to automation</Button> : null}{mine && timeline.conversation.state !== "resolved" ? <Button size="sm" variant="outline" disabled={busy || !!pending} onClick={() => void runCommand("resolve")}>Resolve</Button> : null}{mine && timeline.conversation.state === "resolved" ? <Button size="sm" variant="outline" disabled={busy || !!pending} onClick={() => void runCommand("reopen")}>Reopen</Button> : null}</div></header>
      {owner || mine ? <div className="mb-4 flex flex-wrap gap-2">{owner ? <><select aria-label="Assign conversation" className="task-filter max-w-full" value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">Select teammate</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select><Button size="sm" variant="outline" disabled={!assignee || busy || !!pending} onClick={() => void runCommand("assign", { assigneeAccountId: assignee })}>Assign</Button></> : null}{timeline.conversation.assigneeAccountId ? <Button size="sm" variant="ghost" disabled={busy || !!pending} onClick={() => void runCommand("unassign")}>Unassign</Button> : null}</div> : null}
      <HistoryNavigation timeline={timeline} earlier={!!timeline.earlierBefore} latest={before === null} onEarlier={() => historyPage(timeline.earlierBefore ?? null)} onLatest={() => historyPage(null)} /><div className="max-h-[60vh] overflow-y-auto py-2"><CustomerMessages messages={timeline.messages} /></div>{mine && timeline.conversation.state === "human_owned" ? <form onSubmit={reply} className="mt-4 space-y-3 border-t pt-4"><label className="block space-y-2 text-sm"><span>Reply to customer</span><Textarea value={pending?.body ?? body} disabled={busy || !!pending} maxLength={8000} onChange={event => setBody(event.target.value)} rows={3} /></label><Button type="submit" disabled={busy || !!pending || !body.trim()}>{busy ? "Sending…" : "Send reply"}</Button></form> : null}{pending && !busy ? <Button className="mt-3" variant="outline" onClick={() => void runCommand(pending.action)}>Retry pending action</Button> : null}</> : <Loading />}</> : <p className="hidden py-16 text-center text-sm text-muted-foreground md:block">Select a conversation</p>}</div></div></section>;
}
