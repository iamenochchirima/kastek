import "./customer-workspace.css";
import {useSearchParams} from "react-router-dom";
import {ConversationEnquiries} from "./enquiry-confirmations";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { InboxPresence } from "./inbox-presence";
import { InboxQueue, InboxNoSelection } from "./inbox-queue";
import { InboxMessages } from "./inbox-messages";
import { InboxHandoff, focusAfterHandoff, inboxAssigneeName } from "./inbox-handoff";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, message, organizationPath, readStored, writeStored } from "./api";
import { InboxBookings } from "./inbox-bookings";
import { ChannelSupport } from "./channel-support";
import { InboxChannelAvailability, InboxCustomerRecord } from "./inbox-availability";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

export type InboxConversation = { channelAvailable?: boolean; customerName?: string | null; customerContactId?: string | null; lastMessage?: { body: string; authorKind: string; createdAt: string } | null; hasBookings?: boolean; id: string; agentId: string; agentName?: string; deploymentId: string | null; channelDeploymentId?: string | null; externalConversationId?: string | null; connectionId?: string | null; connectionName?: string | null; assetId?: string | null; versionId: string;
  channel: "website" | "whatsapp" | "telegram" | "facebook" | "instagram"; state: "automation_active" | "handoff_pending" | "human_owned" | "resolved"; assigneeAccountId: string | null; assigneeDisplayName?: string | null;
  revision: string; ownershipGeneration: string; createdAt: string; updatedAt: string };
type ChannelDelivery = { id:string;segment:number;state:"pending"|"sending"|"accepted"|"sent"|"delivered"|"read"|"failed"|"unknown"|"suppressed";reason:string|null };
export type CustomerMessage = { displayKind?: "system"; channelFacts?:{occurredAt:string|null;replyToProviderMessageId:string|null;attachments:{kind:string;fileName?:string;index:number}[]};deliveries?:ChannelDelivery[]; id: string; sequence: string; authorKind: "visitor" | "human" | "assistant"; body: string; createdAt: string; authorAccountId?: string; taskId?: string };
export type CustomerTimeline = { conversation: InboxConversation; handoff?: { requestedAt: string; firstHumanReplyAt: string | null } | null; handoffBrief?: { reason: string; brief: string } | null; followupFailures?: Array<{ id: string; state: "rejected" | "unknown"; createdAt: string }>; messages: CustomerMessage[]; nextSequence: string; latestSequence?: string; earlierBefore?: string | null };
type Command = { commandId: string; expectedRevision: string; action: string; body?: string; assigneeAccountId?: string };
const deliveryLabels = {pending:"Pending",sending:"Sending",accepted:"Provider accepted",sent:"Sent",delivered:"Delivered",read:"Read",failed:"Failed",unknown:"Outcome unknown",suppressed:"Suppressed"};
const channelLabels = { website: "Website", whatsapp: "WhatsApp", telegram: "Telegram", facebook: "Messenger", instagram: "Instagram" };
const labels = { automation_active: "Automated", handoff_pending: "Needs a person", human_owned: "With support", resolved: "Resolved" };
export function CustomerMessages({ messages }: { messages: CustomerMessage[] }) {
  return <div className="customer-messages space-y-5" role="log" aria-label="Conversation messages" aria-live="polite">{messages.map(item => <article key={item.id} className={`rounded-lg border p-3 ${item.authorKind === "visitor" ? "bg-muted/40" : "bg-background"}`}><p className="mb-2 text-xs font-medium text-muted-foreground">{item.displayKind === "system" ? "System" : item.authorKind === "visitor" ? "Customer" : item.authorKind === "human" ? "Support" : "Assistant"}<time dateTime={item.createdAt} className="ml-3 font-normal">{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></p><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{item.body}</p>{item.channelFacts?.attachments.length?<ul className="mt-2 space-y-1 text-xs text-muted-foreground" aria-label="Message attachments">{item.channelFacts.attachments.map(attachment=><li key={attachment.index} className="break-words">{attachment.fileName??`${attachment.kind} attachment`}</li>)}</ul>:null}{item.deliveries?.length?<div aria-label="Delivery status" className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">{item.deliveries.map(delivery=><span key={delivery.id}>{item.deliveries!.length>1?`Part ${delivery.segment+1}: `:""}{deliveryLabels[delivery.state]}{delivery.state==="unknown"?" · Check provider before retrying":""}</span>)}</div>:null}</article>)}</div>;
}
export function HistoryNavigation({ timeline, earlier, latest, onEarlier, onLatest }: { timeline: CustomerTimeline | null; earlier: boolean; latest: boolean; onEarlier(): void; onLatest(): void }) {
  if (latest && !earlier) return null;
  return <nav aria-label="Message history" className="mb-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!timeline || !earlier} onClick={onEarlier}>Earlier messages</Button>{!latest ? <Button size="sm" variant="outline" onClick={onLatest}>Latest messages</Button> : null}</nav>;
}
export function InboxPage() {
  const { organizationId, session } = useWorkspace(), base = `${organizationPath(organizationId)}/inbox`;
  const [items, setItems] = useState<InboxConversation[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedConversation = searchParams.get("conversation");
  const [selected, setSelected] = useState(searchParams.get("conversation") ?? ""), [timeline, setTimeline] = useState<CustomerTimeline | null>(null), [members, setMembers] = useState<{ id: string; displayName: string }[]>([]);
  const [connectionId,setConnectionId]=useState(""),[connections,setConnections]=useState<{id:string;name:string;kind:string}[]>([]);
  const [channel, setChannel] = useState(""), [state, setState] = useState(""), [agentId, setAgentId] = useState(""), [assigned, setAssigned] = useState("");
  const [searchInput, setSearchInput] = useState(""), [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  useEffect(() => { const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250); return () => window.clearTimeout(timer); }, [searchInput]);
  const [error, setError] = useState(""), [listError, setListError] = useState(""), [timelineError, setTimelineError] = useState(""), [busy, setBusy] = useState(false), [body, setBody] = useState("");
  const [pending, setPending] = useState<Command | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [agentOptions, setAgentOptions] = useState<{ id: string; name: string }[]>([]), [agentCursor, setAgentCursor] = useState<string | null>(null);
  useEffect(() => { setSelected(requestedConversation ?? ""); setBefore(null); pageRef.current = null; historyRequest.current++; }, [requestedConversation]);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [before, setBefore] = useState<string | null>(null), pageRef = useRef(before), historyRequest = useRef(0);
  pageRef.current = before;
  function historyPage(value: string | null) { pageRef.current = value; historyRequest.current++; setTimeline(null); setBefore(value); }
  function selectConversation(id: string) {
    selectedRef.current = id; setSelected(id); historyPage(null); setError("");
    setSearchParams(previous => { const next = new URLSearchParams(previous); if (id) next.set("conversation", id); else next.delete("conversation"); return next; });
  }
  const path = `${base}?${new URLSearchParams({ ...(connectionId ? { connectionId } : {}), ...(channel ? { channel } : {}), ...(state ? { state } : {}), ...(agentId ? { agentId } : {}), ...(assigned ? { assigned } : {}), ...(search ? { search } : {}), ...(sort === "oldest" ? { sort } : {}) })}`;
  const pathRef = useRef(path); pathRef.current = path;
  const itemsRef = useRef(items); itemsRef.current = items;
  const cursorRef = useRef(cursor); cursorRef.current = cursor;
  const listRequest = useRef(0);
  const loadingMore = useRef(false);
  const pollingList = useRef(false);
  const pendingKey = `agents.inbox.pending.${session.account.id}.${organizationId}.${selected}`;
  const draftKey = `agents.inbox.draft.${session.account.id}.${organizationId}.${selected}`;
  const owner = session.organizations.find(org => org.id === organizationId)?.role === "owner";
  const mine = timeline?.conversation.assigneeAccountId === session.account.id;
  const messageAuthors = members.some(member => member.id === session.account.id) ? members : [...members, { id: session.account.id, displayName: session.account.displayName || "You" }];
  async function loadList(more = false) {
    if (more && loadingMore.current) return;
    const expected = path, request = ++listRequest.current;
    const current = () => pathRef.current === expected && listRequest.current === request;
    if (more) {
      const next = cursorRef.current;
      if (!next) return;
      loadingMore.current = true;
      try {
        const result = await api<{ conversations: InboxConversation[]; nextCursor: string | null }>(`${expected}&cursor=${encodeURIComponent(next)}`);
        if (!current()) return;
        const merged = [...new Map([...(itemsRef.current ?? []), ...result.conversations].map(item => [item.id, item])).values()];
        itemsRef.current = merged; cursorRef.current = result.nextCursor; setItems(merged); setCursor(result.nextCursor); setListError("");
      } finally { loadingMore.current = false; }
      return;
    }
    // Rebuild the loaded window with one fresh cursor chain, so refresh never
    // combines pages from different snapshots or drops pages already opened.
    const target = Math.max(1, itemsRef.current?.length ?? 0);
    const collected: InboxConversation[] = []; let next: string | null = null;
    do {
      const result: { conversations: InboxConversation[]; nextCursor: string | null } = await api(expected + (next ? `&cursor=${encodeURIComponent(next)}` : ""));
      if (!current()) return;
      collected.push(...result.conversations); next = result.nextCursor;
    } while (next && collected.length < target);
    itemsRef.current = collected; cursorRef.current = next; setItems(collected); setCursor(next); setListError("");
  }
  async function loadConversation(id: string) {
    const expectedPage = pageRef.current, request = ++historyRequest.current;
    const current = () => selectedRef.current === id && pageRef.current === expectedPage && historyRequest.current === request;
    try {
      const result = await api<CustomerTimeline>(`${base}/${encodeURIComponent(id)}?limit=100${expectedPage ? `&before=${expectedPage}` : ""}`);
      if (current()) { setTimeline(result); setTimelineError(""); }
    } catch (error) { if (current()) { setTimeline(null); throw error; } }
  }
  useEffect(() => {
    let live = true; itemsRef.current = null; cursorRef.current = null; setItems(null); setCursor(null); setListError("");
    void loadList().catch(e => { if (live) setListError(message(e)); });
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && !loadingMore.current && !pollingList.current) {
        pollingList.current = true;
        void loadList().catch(e => { if (live) setListError(message(e)); }).finally(() => { pollingList.current = false; });
      }
    }, 10000);
    return () => {
      live = false;
      // Invalidate every outstanding request for this filter, including later refreshes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      listRequest.current++;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(()=>{let live=true;void api<{connections:{id:string;name:string;kind:string}[]}>(`${organizationPath(organizationId)}/channels`).then(result=>{if(live)setConnections(result.connections);}).catch(()=>{if(live)setConnections([]);});return()=>{live=false;};},[organizationId]);
  useEffect(() => { let live = true; api<{ members: { id: string; displayName: string }[] }>(`${base}/members`).then(result => { if (live) setMembers(result.members); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [base]);
  useEffect(() => { let live = true; api<{ agents: { id: string; name: string }[]; nextCursor: string | null }>(`${organizationPath(organizationId)}/agents/summaries?limit=100`).then(result => { if (live) { setAgentOptions(result.agents); setAgentCursor(result.nextCursor); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [organizationId]);
  useEffect(() => {
    setTimeline(null); setTimelineError(""); if (!selected) return;
    let stopped = false, running = false;
    const refresh = async () => { if (running || stopped) return; running = true; try { await loadConversation(selected); } catch (e) { if (!stopped) setTimelineError(message(e)); } finally { running = false; } };
    void refresh(); const timer = window.setInterval(() => { void refresh(); }, 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate requests across the polling lifetime, rather than capture a DOM ref.
    return () => { stopped = true; historyRequest.current++; window.clearInterval(timer); };
    // Workspace remounts the page; selection owns the polling lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, base, before]);
  useEffect(() => { setBody(readStored<string>(draftKey) ?? ""); setPending(readStored<Command>(pendingKey)); }, [pendingKey, draftKey]);
  async function runCommand(action: string, extra: Partial<Command> = {}) {
    if (!timeline || busy) return false; const id = selected, key = pendingKey;
    const command = pending ?? { commandId: crypto.randomUUID(), expectedRevision: timeline.conversation.revision, action, ...extra };
    setPending(command); writeStored(key, command); setBusy(true); setError("");
    try { await api(`${base}/${id}/commands`, command); writeStored(key, null); if (selectedRef.current === id) { setPending(null); if (command.action === "reply") { setBody(""); writeStored(draftKey, null); } await loadConversation(id); } const queuePath = path; await loadList().catch(e => { if (pathRef.current === queuePath) setListError(message(e)); }); return true; }
    catch (e) { if (e instanceof ApiError && e.status < 500) { writeStored(key, null); if (selectedRef.current === id) setPending(null); await loadConversation(id).catch(() => {}); } if (selectedRef.current === id) setError(message(e)); return false; }
    finally { setBusy(false); }
  }
  function reply(event: FormEvent) { event.preventDefault(); if (timeline?.conversation.channelAvailable !== false) void runCommand("reply", { body: body.trim() }); }
  async function moreAgents() { if (!agentCursor) return; try { const result = await api<{ agents: { id: string; name: string }[]; nextCursor: string | null }>(`${organizationPath(organizationId)}/agents/summaries?limit=100&cursor=${encodeURIComponent(agentCursor)}`); setAgentOptions(old => [...new Map([...old, ...result.agents].map(agent => [agent.id, agent])).values()]); setAgentCursor(result.nextCursor); } catch (e) { setError(message(e)); } }
  const agents = agentOptions.map(agent => [agent.id, agent.name]);
  return <section className="workspace-page inbox-page min-w-0"><ErrorMessage value={error} /><div className="inbox-layout grid min-w-0"><div className={`inbox-queue-column ${selected ? "has-selection" : ""}`}><header className="flex items-center justify-between gap-4"><div><h1 className="text-2xl font-semibold">Inbox</h1><p className="inbox-heading-subtitle">Customer conversations</p></div><Button variant="outline" size="sm" onClick={() => void loadList().catch(e => setListError(message(e)))}><HugeiconsIcon icon={RefreshIcon} size={16} />Refresh</Button></header>
    <InboxPresence organizationId={organizationId} /><div className="inbox-filters my-5 flex flex-wrap gap-2"><select aria-label="Sort conversations" className="task-filter" value={sort} onChange={event => setSort(event.target.value as "newest" | "oldest")}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select><select aria-label="Filter Inbox status" className="task-filter" value={state} onChange={event => setState(event.target.value)}><option value="">All statuses</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select aria-label="Filter Inbox agent" className="task-filter" value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">All agents</option>{agents.map(([id, name]) => <option value={id} key={id}>{name}</option>)}</select><select aria-label="Filter Inbox assignment" className="task-filter" value={assigned} onChange={event => setAssigned(event.target.value)}><option value="">Everyone</option><option value="mine">Assigned to me</option><option value="unassigned">Unassigned</option></select><select aria-label="Filter Inbox channel" className="task-filter" value={channel} onChange={event => setChannel(event.target.value)}><option value="">All channels</option>{Object.entries(channelLabels).map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>{connections.length?<select aria-label="Filter Inbox connection" className="task-filter max-w-full" value={connectionId} onChange={event=>setConnectionId(event.target.value)}><option value="">All connections</option>{connections.map(connection=><option key={connection.id} value={connection.id}>{connection.name}</option>)}</select>:null}{agentCursor ? <Button size="sm" variant="ghost" onClick={() => void moreAgents()}>Load more agents</Button> : null}</div>
    <InboxQueue items={items} selected={selected} search={searchInput} filtered={Boolean(state || agentId || assigned || channel || connectionId)} error={listError} hasMore={Boolean(cursor)} onSearch={setSearchInput} onSelect={selectConversation} onRetry={() => void loadList().catch(e => setListError(message(e)))} onMore={() => void loadList(true).catch(e => setError(message(e)))} /></div>
      <div className="inbox-conversation-detail min-w-0">{selected ? <><Button variant="ghost" size="sm" className="inbox-back mb-3" onClick={() => selectConversation("")}><HugeiconsIcon icon={ArrowLeft01Icon} size={16} />Conversations</Button>{timeline ? <><header className="inbox-detail-header mb-4 flex flex-wrap items-center justify-between gap-3 border-b pb-4"><div><h2 className="font-medium">{timeline.conversation.customerName || "Customer"}</h2><p className="mt-1 text-xs text-muted-foreground">{channelLabels[timeline.conversation.channel]} · {labels[timeline.conversation.state]}</p></div><Button ref={detailsButton} variant="outline" size="sm" aria-expanded={detailsOpen} aria-controls="inbox-conversation-details" onClick={() => setDetailsOpen(open => !open)} onKeyDown={event => { if (event.key === "Escape" && detailsOpen) { event.stopPropagation(); setDetailsOpen(false); } }}>Details</Button></header>
      <InboxHandoff key={timeline.conversation.id} conversation={timeline.conversation} handoff={timeline.handoff} accountId={session.account.id} owner={owner} members={members} busy={busy} pending={!!pending} onCommand={(action, extra) => runCommand(action, extra)} />
      {timeline.handoffBrief ? <details className="my-3 rounded-lg border border-border px-4 py-3 text-sm"><summary className="cursor-pointer font-medium">Agent handoff note</summary><dl className="mt-3 space-y-2"><div><dt className="text-xs text-muted-foreground">Reason</dt><dd className="break-words">{timeline.handoffBrief.reason}</dd></div><div><dt className="text-xs text-muted-foreground">Context</dt><dd className="whitespace-pre-wrap break-words">{timeline.handoffBrief.brief}</dd></div></dl></details> : null}
      <div className="inbox-detail-columns"><aside id="inbox-conversation-details" className="inbox-context" aria-label="Conversation details" hidden={!detailsOpen} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setDetailsOpen(false); detailsButton.current?.focus(); } }}><h3>Details</h3><dl><div><dt>Agent</dt><dd>{timeline.conversation.agentName ?? items?.find(item => item.id === timeline.conversation.id)?.agentName ?? agentOptions.find(agent => agent.id === timeline.conversation.agentId)?.name ?? "Agent"}</dd></div><div><dt>Channel</dt><dd>{channelLabels[timeline.conversation.channel]}</dd></div><div><dt>Status</dt><dd>{labels[timeline.conversation.state]}</dd></div><div><dt>Assignee</dt><dd>{mine ? session.account.displayName || "You" : inboxAssigneeName(timeline.conversation.assigneeAccountId, members, timeline.conversation.assigneeDisplayName)}</dd></div></dl><InboxCustomerRecord contactId={timeline.conversation.customerContactId} /><ConversationEnquiries key={`enquiries:${timeline.conversation.id}:${timeline.conversation.revision}:${timeline.latestSequence ?? timeline.nextSequence}`} path={`${base}/${encodeURIComponent(timeline.conversation.id)}/enquiries`}/>
      {timeline.conversation.hasBookings ? <InboxBookings key={`${organizationId}.${timeline.conversation.id}`} path={`${base}/${encodeURIComponent(timeline.conversation.id)}/bookings`} refreshKey={`${timeline.conversation.revision}:${timeline.latestSequence ?? timeline.nextSequence}:${timeline.conversation.state}`} /> : null}</aside><div className="inbox-thread">
      <InboxChannelAvailability available={timeline.conversation.channelAvailable} />{timeline.followupFailures?.length ? <p role="status" className="mb-3 text-sm text-destructive">Email notification {timeline.followupFailures.some(item => item.state === "unknown") ? "outcome unknown" : "failed"}.</p> : null}<HistoryNavigation timeline={timeline} earlier={!!timeline.earlierBefore} latest={before === null} onEarlier={() => historyPage(timeline.earlierBefore ?? null)} onLatest={() => historyPage(null)} /><div className="inbox-message-scroll max-h-[60vh] overflow-y-auto py-2"><InboxMessages messages={timeline.messages} customerName={timeline.conversation.customerName} agentName={timeline.conversation.agentName ?? items?.find(item => item.id === timeline.conversation.id)?.agentName ?? agentOptions.find(agent => agent.id === timeline.conversation.agentId)?.name} members={messageAuthors} /></div><div className="inbox-channel-controls"><ChannelSupport key={`${organizationId}:${timeline.conversation.id}`} orgId={organizationId} conversation={timeline.conversation} accountId={session.account.id} messages={timeline.messages} onChanged={async()=>{await Promise.all([loadList(),loadConversation(timeline.conversation.id)]);}} /></div>{mine && timeline.conversation.state === "human_owned" ? <form onSubmit={reply} className="inbox-composer"><label className="sr-only" htmlFor="inbox-reply">Reply to customer</label><Textarea id="inbox-reply" placeholder="Reply to customer…" value={pending?.body ?? body} disabled={busy || !!pending} maxLength={8000} onChange={event => { setBody(event.target.value); writeStored(draftKey, event.target.value); }} rows={2} /><div className="inbox-composer-actions"><Button type="submit" disabled={busy || !!pending || !body.trim() || timeline.conversation.channelAvailable === false}>{busy ? "Sending…" : "Send reply"}</Button></div></form> : null}{pending && !busy ? <Button className="mt-3" variant="outline" onClick={event => { const id = selected; void focusAfterHandoff(pending.action, event.currentTarget, () => runCommand(pending.action), () => selectedRef.current === id ? document.querySelector<HTMLElement>(".inbox-handoff") : null); }}>Retry pending action</Button> : null}</div></div></> : timelineError ? <div className="space-y-3"><ErrorMessage value={timelineError} /><Button size="sm" variant="outline" onClick={() => void loadConversation(selected).catch(e => setTimelineError(message(e)))}>Retry</Button></div> : <Loading />}</> : <InboxNoSelection />}</div></div></section>;
}
