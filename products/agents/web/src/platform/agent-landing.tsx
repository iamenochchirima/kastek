import { useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Chatting01Icon, Facebook01Icon, Globe02Icon, InstagramIcon, Robot01Icon, Search01Icon, Settings01Icon, TelegramIcon, WhatsappIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AgentSummary } from "./api";
import "./agent-landing.css";

type LandingAgent = AgentSummary & { offering?: string | null; responsibilities?: string[] | null; activeChannels?: string[] | null; lastCustomerConversationAt?: string | null };
type Props = { agents: LandingAgent[] | null; search: string; onSearch: (value: string) => void; filter: string; onFilter: (value: string) => void; error: string; onRetry: () => void; hasMore: boolean; onMore: () => void; busy: boolean; onCreate: () => void };
const responsibilityLabels: Record<string, string> = { "answer-questions": "Answer questions", "customer-support": "Handle support", bookings: "Book appointments", enquiries: "Collect enquiries" };
const channelNames: Record<string, string> = { website: "Website", whatsapp: "WhatsApp", facebook: "Messenger", instagram: "Instagram", telegram: "Telegram" };
const channelIcons = { website: Globe02Icon, whatsapp: WhatsappIcon, facebook: Facebook01Icon, instagram: InstagramIcon, telegram: TelegramIcon };
const labelOffering = (offering?: string | null) => offering === "customer-service" ? "Customer service" : offering === "faq" ? "FAQ" : offering ? offering.replace(/[-_]/g, " ") : "Agent";
const purpose = (agent: LandingAgent) => agent.responsibilities?.map(item => responsibilityLabels[item] ?? item.replace(/[-_]/g, " ")).join(", ") || "—";
const status = (agent: LandingAgent) => !agent.latestVersion ? "Setup" : agent.hasUnpublishedChanges ? "Changes pending" : "Configured";
const when = (value?: string | null) => value ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "No activity yet";

export function AgentLanding({ agents, search, onSearch, filter, onFilter, error, onRetry, hasMore, onMore, busy, onCreate }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const selected = !closed ? agents?.find(agent => agent.id === selectedId) ?? agents?.[0] : undefined;
  return <div className="agent-landing">
    <section className="agent-landing-main">
      <header className="agent-landing-header"><div><h1>Agents</h1><p>Manage your agents.</p></div><Button onClick={onCreate}><HugeiconsIcon icon={Add01Icon} size={18} aria-hidden="true" />Create agent</Button></header>
      <div className="agent-landing-filters"><label className="agent-landing-search"><HugeiconsIcon icon={Search01Icon} size={18} aria-hidden="true" /><Input aria-label="Search agents" placeholder="Search agents..." value={search} onChange={event => onSearch(event.target.value)} /></label><select aria-label="Filter agents" className="agent-landing-filter" value={filter} onChange={event => onFilter(event.target.value)}><option value="all">All agents</option><option value="configured">Configured</option><option value="changes-pending">Changes pending</option><option value="setup">Setup</option></select></div>
      {error ? <div role="alert" className="agent-landing-error"><span>{error}</span><Button size="sm" variant="outline" onClick={onRetry}>Retry</Button></div> : null}
      {!agents && !error ? <div className="agent-landing-loading" role="status">Loading agents…</div> : agents?.length ? <div className="agent-landing-list" aria-label="Agents">
        <div className="agent-landing-columns" aria-hidden="true"><span>Name</span><span>Purpose</span><span>Status</span><span>Customer activity</span><span /></div>
        {agents.map(agent => <div className={`agent-landing-row ${selected?.id === agent.id ? "is-selected" : ""}`} key={agent.id}>
          <button type="button" className="agent-landing-row-main" aria-label={`Show ${agent.name} details`} aria-pressed={selected?.id === agent.id} onClick={() => { setSelectedId(agent.id); setClosed(false); }}><span className="agent-landing-name"><span className="agent-landing-avatar"><HugeiconsIcon icon={Robot01Icon} size={23} aria-hidden="true" /></span><span><strong>{agent.name}</strong><small>{labelOffering(agent.offering)}</small></span></span><span className="agent-landing-purpose">{purpose(agent)}</span><span><span className="agent-landing-status" data-status={status(agent)}>{status(agent)}</span></span><span className="agent-landing-date">{when(agent.lastCustomerConversationAt)}</span></button>
          <Link className="agent-landing-quick-chat" aria-label={`Open chat with ${agent.name}`} title="Open chat" to={`/app/agents/${agent.id}`}><HugeiconsIcon icon={Chatting01Icon} size={19} aria-hidden="true" /></Link>
        </div>)}
        {hasMore ? <Button variant="outline" size="sm" onClick={onMore} disabled={busy}>{busy ? "Loading…" : "Load more"}</Button> : null}
      </div> : agents && !error ? <div className="agent-landing-empty"><p>{search.trim() || filter !== "all" ? "No matching agents" : "No agents yet"}</p>{!search.trim() && filter === "all" ? <Button variant="outline" onClick={onCreate}>Create agent</Button> : null}</div> : null}
    </section>
    {selected ? <aside className="agent-landing-detail" aria-label={`${selected.name} details`}><button className="agent-landing-close" aria-label="Close agent details" onClick={() => setClosed(true)} type="button">×</button><span className="agent-landing-detail-avatar"><HugeiconsIcon icon={Robot01Icon} size={32} aria-hidden="true" /></span><div className="agent-landing-detail-title"><h2>{selected.name}</h2><span className="agent-landing-status" data-status={status(selected)}>{status(selected)}</span></div><p className="agent-landing-description">{purpose(selected) === "—" ? labelOffering(selected.offering) : purpose(selected)}</p><div className="agent-landing-detail-actions"><Button asChild><Link to={`/app/agents/${selected.id}`}><HugeiconsIcon icon={Chatting01Icon} size={18} aria-hidden="true" />Open chat</Link></Button><Button asChild variant="outline"><Link to={`/app/agents/${selected.id}?section=configuration`}><HugeiconsIcon icon={Settings01Icon} size={18} aria-hidden="true" />Configure</Link></Button></div>
      <section className="agent-landing-detail-section"><h3>Channels</h3>{selected.activeChannels?.length ? <div className="agent-landing-channels">{selected.activeChannels.map(channel => <span key={channel} title={channelNames[channel] ?? channel}><HugeiconsIcon icon={channelIcons[channel as keyof typeof channelIcons] ?? Chatting01Icon} size={19} aria-hidden="true" />{channelNames[channel] ?? channel}</span>)}</div> : <p>No connected channels</p>}</section>
      <section className="agent-landing-detail-section"><h3>Details</h3><dl><div><dt>Agent type</dt><dd>{labelOffering(selected.offering)}</dd></div><div><dt>Customer activity</dt><dd>{when(selected.lastCustomerConversationAt)}</dd></div></dl></section>
    </aside> : null}
  </div>;
}
