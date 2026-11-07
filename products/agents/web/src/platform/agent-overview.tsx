import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon, Calendar01Icon, Chatting01Icon, MessageMultiple01Icon, Book02Icon, Layers01Icon, Robot01Icon, UserIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { api, message, organizationPath, type Agent } from "./api";
import { ErrorMessage, Loading } from "./shell";
import { channelIcon, channelName, ConversationChart, stateName, timeLabel } from "./overview";
import "./overview.css";

type Conversation = { id: string; agentName: string; channel: string; state: string; updatedAt: string };
export type AgentOverviewData = {
  period: { days: number };
  counts: { conversations: number; messages: number; needsAttention: number; activeChannels: number; knowledgeSources: number; knowledgeChunks: number };
  conversationActivity: { date: string; count: number }[];
  needsAttention: Conversation[];
  recentActivity: Conversation[];
  channels: { channel: string; count: number }[];
};
const inboxLink = (id: string) => `/app/inbox?conversation=${encodeURIComponent(id)}`;

export function AgentOverview({ organizationId, agent }: { organizationId: string; agent: Agent }) {
  const [days, setDays] = useState(7), [revision, setRevision] = useState(0);
  const [data, setData] = useState<AgentOverviewData | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true; setData(null); setError("");
    api<AgentOverviewData>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(agent.id)}/overview?days=${days}`)
      .then(result => { if (live) setData(result); })
      .catch(reason => { if (live) setError(message(reason)); });
    return () => { live = false; };
  }, [organizationId, agent.id, days, revision]);
  const metrics = data && [
    { label: "Conversations", value: data.counts.conversations, icon: Chatting01Icon },
    { label: "Messages", value: data.counts.messages, icon: MessageMultiple01Icon },
    { label: "Needs attention", value: data.counts.needsAttention, icon: Alert02Icon, tone: "warning" },
    { label: "Channels used", value: data.counts.activeChannels, icon: Robot01Icon, tone: "success" },
    { label: "Knowledge sources", value: data.counts.knowledgeSources, icon: Book02Icon },
    { label: "Indexed chunks", value: data.counts.knowledgeChunks, icon: Layers01Icon },
  ];
  return <section className="agent-overview">
    <header className="overview-top"><div><h1>Overview</h1><p>{agent.name} · UTC dates</p></div><div className="overview-actions"><span className="overview-period-wrap"><HugeiconsIcon icon={Calendar01Icon} size={16} aria-hidden="true" /><select className="overview-period" aria-label="Time period" value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></span></div></header>
    {error ? <div className="space-y-3"><ErrorMessage value={error} /><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Retry</Button></div> : !data || !metrics ? <Loading /> : <>
      <div className="overview-metrics">{metrics.map(({ label, value, icon, tone }) => <div className="overview-metric" data-tone={tone} key={label}><span className="overview-metric-icon"><HugeiconsIcon icon={icon} size={24} aria-hidden="true" /></span><div><p className="overview-metric-label">{label}</p><p className="overview-metric-value">{value.toLocaleString()}</p></div></div>)}</div>
      <div className="overview-layout"><div className="overview-column">
        <section className="overview-panel"><div className="overview-panel-header"><div><h2>Conversation activity</h2><p className="overview-panel-subtitle">New customer conversations · UTC</p></div></div><ConversationChart points={data.conversationActivity} /></section>
        <section className="overview-panel"><div className="overview-panel-header"><div><h2>Recent conversations</h2><p className="overview-panel-subtitle">Recently updated conversations</p></div><Link className="overview-link" to={`/app/agents/${agent.id}?section=conversations`}>View all</Link></div>{data.recentActivity.length ? <div className="overview-table-wrap"><table className="overview-table"><thead><tr><th>Updated</th><th>Conversation</th><th>Status</th><th>Channel</th></tr></thead><tbody>{data.recentActivity.map(item => <tr key={item.id}><td><time dateTime={item.updatedAt}>{timeLabel(item.updatedAt)}</time></td><td><Link className="overview-agent" to={`/app/agents/${agent.id}/conversations/${item.id}`}><span className="overview-agent-icon"><HugeiconsIcon icon={Chatting01Icon} size={17} aria-hidden="true" /></span>Open conversation</Link></td><td>{stateName(item.state)}</td><td><span className="overview-table-channel"><HugeiconsIcon icon={channelIcon(item.channel)} size={17} aria-hidden="true" />{channelName(item.channel)}</span></td></tr>)}</tbody></table></div> : <p className="overview-empty">No conversations yet</p>}</section>
      </div><div className="overview-column">
        <section className="overview-panel"><div className="overview-panel-header"><div><h2>Needs attention</h2><p className="overview-panel-subtitle">Currently waiting for a person</p></div><Link className="overview-link" to="/app/inbox">View inbox</Link></div>{data.needsAttention.length ? <div className="overview-list">{data.needsAttention.map(item => <Link className="overview-person" key={item.id} to={inboxLink(item.id)}><span className="overview-person-avatar"><HugeiconsIcon icon={Chatting01Icon} size={18} aria-hidden="true" /></span><span className="overview-person-main"><span className="overview-person-name"><span>Conversation</span><time className="overview-person-time" dateTime={item.updatedAt}>{timeLabel(item.updatedAt)}</time></span><span className="overview-person-preview">{channelName(item.channel)}</span></span><span className="overview-handoff"><HugeiconsIcon icon={UserIcon} size={14} aria-hidden="true" /> Handoff</span></Link>)}</div> : <p className="overview-empty">No conversations need attention</p>}</section>
        <section className="overview-panel"><div className="overview-panel-header"><div><h2>Conversations by channel</h2><p className="overview-panel-subtitle">New conversations in this period</p></div></div>{data.channels.length ? data.channels.map(item => <div className="overview-channel" key={item.channel}><span className="overview-channel-icon" data-channel={item.channel}><HugeiconsIcon icon={channelIcon(item.channel)} size={21} aria-hidden="true" /></span><div className="overview-channel-main"><div className="overview-channel-label"><span>{channelName(item.channel)}</span><span>{item.count.toLocaleString()}</span></div><div className="overview-channel-track"><span style={{ width: `${data.counts.conversations ? item.count / data.counts.conversations * 100 : 0}%` }} /></div></div></div>) : <p className="overview-empty">No conversations in this period</p>}</section>
      </div></div>
    </>}
  </section>;
}
