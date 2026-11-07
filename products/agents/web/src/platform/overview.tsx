import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Alert02Icon, ArrowRight01Icon, Calendar01Icon, Chatting01Icon, Facebook01Icon, Globe02Icon, InstagramIcon, Robot01Icon, TelegramIcon, UserGroupIcon, UserIcon, WhatsappIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import { api, message, organizationPath } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";
import { GuidedAgentCreation } from "./guided-agent-creation";
import "./overview.css";

type Conversation = { id: string; agentName: string; channel: string; state: string; updatedAt: string };
type OverviewData = {
  counts: { conversations: number; needsAttention: number; enquiries: number; activeAgents: number };
  conversationActivity: { date: string; count: number }[];
  needsAttention: Conversation[];
  recentActivity: Conversation[];
  channels: { channel: string; count: number }[];
};
const channelNames: Record<string, string> = { website: "Website", whatsapp: "WhatsApp", telegram: "Telegram", facebook: "Messenger", instagram: "Instagram" };
const stateNames: Record<string, string> = { automation_active: "Automated", handoff_pending: "Needs a person", human_owned: "With support", resolved: "Resolved" };
const channelIcons = { website: Globe02Icon, whatsapp: WhatsappIcon, telegram: TelegramIcon, facebook: Facebook01Icon, instagram: InstagramIcon };
export const channelIcon = (channel: string) => channelIcons[channel as keyof typeof channelIcons] ?? Chatting01Icon;
export const channelName = (channel: string) => channelNames[channel] ?? channel;
export const stateName = (state: string) => stateNames[state] ?? state;
const dateLabel = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
export const timeLabel = (date: string) => new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const inboxLink = (id: string) => `/app/inbox?conversation=${encodeURIComponent(id)}`;

export function ConversationChart({ points }: { points: { date: string; count: number }[] }) {
  if (!points.length) return <p className="overview-empty">No conversations in this period</p>;
  const max = Math.max(1, ...points.map(point => point.count));
  const chartTop = 10, chartBottom = 155, chartLeft = 40, chartRight = 720;
  const coordinates = points.map((point, index) => ({ ...point, x: points.length === 1 ? (chartLeft + chartRight) / 2 : chartLeft + index * (chartRight - chartLeft) / (points.length - 1), y: chartBottom - point.count / max * (chartBottom - chartTop) }));
  const line = coordinates.map((point, index) => {
    if (!index) return `M${point.x} ${point.y}`;
    const previous = coordinates[index - 1];
    const middle = (previous.x + point.x) / 2;
    return `C${middle} ${previous.y} ${middle} ${point.y} ${point.x} ${point.y}`;
  }).join(" ");
  const labels = points.length > 10 ? new Set([0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1]) : new Set(points.map((_, index) => index));
  return <svg className="overview-chart" viewBox="0 0 760 195" preserveAspectRatio="none" role="img" aria-label={`Conversations by day: ${points.map(point => `${dateLabel(point.date)} ${point.count}`).join(", ")}`}>
    {[0, 0.5, 1].map(ratio => <g key={ratio}><line x1={chartLeft} x2={chartRight} y1={chartBottom - ratio * (chartBottom - chartTop)} y2={chartBottom - ratio * (chartBottom - chartTop)} /><text x="30" y={chartBottom - ratio * (chartBottom - chartTop) + 4} textAnchor="end">{Math.round(max * ratio)}</text></g>)}
    {coordinates.filter((_, index) => labels.has(index)).map(point => <line key={point.date} className="overview-chart-vertical" x1={point.x} x2={point.x} y1={chartTop} y2={chartBottom} />)}
    <path className="overview-chart-fill" d={`${line} L${coordinates[coordinates.length - 1].x} ${chartBottom} L${coordinates[0].x} ${chartBottom} Z`} /><path className="overview-chart-path" d={line} />
    {coordinates.map((point, index) => <g key={point.date}><circle className="overview-chart-point" cx={point.x} cy={point.y} r={points.length > 10 ? 2.5 : 4} />{labels.has(index) && <text x={point.x} y="182" textAnchor="middle">{dateLabel(point.date)}</text>}</g>)}
  </svg>;
}

export function Overview({ onCreateAgent }: { onCreateAgent: () => void }) {
  const { organizationId } = useWorkspace();
  const [days, setDays] = useState(7), [revision, setRevision] = useState(0);
  const [data, setData] = useState<OverviewData | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true; setData(null); setError("");
    api<OverviewData>(`${organizationPath(organizationId)}/overview?days=${days}`).then(result => { if (live) setData(result); }).catch(reason => { if (live) setError(message(reason)); });
    return () => { live = false; };
  }, [organizationId, days, revision]);
  const metrics = data && [
    { label: "Conversations", value: data.counts.conversations, icon: Chatting01Icon },
    { label: "Needs attention", value: data.counts.needsAttention, icon: Alert02Icon, tone: "warning" },
    { label: "New enquiries", value: data.counts.enquiries, icon: UserGroupIcon },
    { label: "Agents with conversations", value: data.counts.activeAgents, icon: Robot01Icon, tone: "success" },
  ];
  return <section className="workspace-page overview-page">
    <header className="overview-top"><div><h1>Overview</h1><p>Customer conversations · UTC dates</p></div><div className="overview-actions"><span className="overview-period-wrap"><HugeiconsIcon icon={Calendar01Icon} size={16} aria-hidden="true" /><select className="overview-period" aria-label="Time period" value={days} onChange={event => setDays(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option></select></span><Button onClick={onCreateAgent}><HugeiconsIcon icon={Add01Icon} size={16} aria-hidden="true" /> Create agent</Button></div></header>
    {error ? <div className="space-y-3"><ErrorMessage value={error} /><Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>Retry</Button></div> : !data || !metrics ? <Loading /> : <>
      <div className="overview-metrics">{metrics.map(({ label, value, icon, tone }) => <div className="overview-metric" data-tone={tone} key={label}><span className="overview-metric-icon"><HugeiconsIcon icon={icon} size={24} aria-hidden="true" /></span><div><p className="overview-metric-label">{label}</p><p className="overview-metric-value">{value.toLocaleString()}</p></div></div>)}</div>
      <div className="overview-layout"><div className="overview-column">
        <section className="overview-panel"><div className="overview-panel-header"><div><h2>Conversation activity</h2><p className="overview-panel-subtitle">New customer conversations · UTC</p></div></div><ConversationChart points={data.conversationActivity} /></section>
        <section className="overview-panel"><div className="overview-panel-header"><div><h2>Recent activity</h2><p className="overview-panel-subtitle">Recently updated conversations</p></div><Link className="overview-link" to="/app/inbox">View inbox <HugeiconsIcon icon={ArrowRight01Icon} size={14} aria-hidden="true" /></Link></div>{data.recentActivity.length ? <div className="overview-table-wrap"><table className="overview-table"><thead><tr><th>Updated</th><th>Agent</th><th>Status</th><th>Channel</th></tr></thead><tbody>{data.recentActivity.map(item => <tr key={item.id}><td><time dateTime={item.updatedAt}>{timeLabel(item.updatedAt)}</time></td><td><Link className="overview-agent" to={inboxLink(item.id)}><span className="overview-agent-icon"><HugeiconsIcon icon={Robot01Icon} size={17} aria-hidden="true" /></span>{item.agentName}</Link></td><td>{stateNames[item.state] ?? item.state}</td><td><span className="overview-table-channel"><HugeiconsIcon icon={channelIcon(item.channel)} size={17} aria-hidden="true" />{channelName(item.channel)}</span></td></tr>)}</tbody></table></div> : <p className="overview-empty">No recent activity</p>}</section>
      </div><div className="overview-column">
        <section className="overview-panel"><div className="overview-panel-header"><div><h2>Needs attention</h2><p className="overview-panel-subtitle">Currently waiting for a person</p></div><Link className="overview-link" to="/app/inbox">View inbox <HugeiconsIcon icon={ArrowRight01Icon} size={14} aria-hidden="true" /></Link></div>{data.needsAttention.length ? <div className="overview-list">{data.needsAttention.map(item => <Link className="overview-person" key={item.id} to={inboxLink(item.id)}><span className="overview-person-avatar"><HugeiconsIcon icon={Chatting01Icon} size={18} aria-hidden="true" /></span><span className="overview-person-main"><span className="overview-person-name"><span>{item.agentName}</span><time className="overview-person-time" dateTime={item.updatedAt}>{timeLabel(item.updatedAt)}</time></span><span className="overview-person-preview">{channelName(item.channel)}</span></span><span className="overview-handoff"><HugeiconsIcon icon={UserIcon} size={14} aria-hidden="true" /> Handoff</span></Link>)}</div> : <p className="overview-empty">No conversations need attention</p>}</section>
        <section className="overview-panel"><div className="overview-panel-header"><div><h2>Conversations by channel</h2><p className="overview-panel-subtitle">New conversations in this period</p></div></div>{data.channels.length ? data.channels.map(item => <div className="overview-channel" key={item.channel}><span className="overview-channel-icon" data-channel={item.channel}><HugeiconsIcon icon={channelIcon(item.channel)} size={21} aria-hidden="true" /></span><div className="overview-channel-main"><div className="overview-channel-label"><span>{channelName(item.channel)}</span><span>{item.count.toLocaleString()}</span></div><div className="overview-channel-track"><span style={{ width: `${data.counts.conversations ? item.count / data.counts.conversations * 100 : 0}%` }} /></div></div></div>) : <p className="overview-empty">No conversations in this period</p>}</section>
      </div></div>
    </>}
  </section>;
}

export function OverviewPage() {
  const { organizationId, session } = useWorkspace();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  return <>
    <Overview onCreateAgent={() => setOpen(true)} />
    <GuidedAgentCreation key={`${session.account.id}.${organizationId}`} open={open} onOpenChange={setOpen} organizationId={organizationId} onDraftCreated={() => {}} onCreated={id => { setOpen(false); navigate(`/app/agents/${id}`); }} />
  </>;
}
