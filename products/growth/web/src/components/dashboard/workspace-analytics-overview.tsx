import { AskGrowthAgent } from "@/components/dashboard/agents/agent-context";
import { Link } from "react-router";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Bot, CalendarDays, FileText, MessageCircle, Send, Cable, Users } from "@/components/ui/interface-icons";
import { AnalyticsCoverageBadge, AnalyticsEmptyState, AnalyticsErrorState, AnalyticsFreshnessBadge, AnalyticsLoadingState } from "@/components/analytics/analytics-feedback";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createAnalyticsDateRange, fetchAnalyticsCatalog, fetchAnalyticsReport, hasObservedAnalyticsData, latestObservedAnalyticsValue, type AnalyticsMetricResult, type AnalyticsReport } from "@/lib/analytics";
import "./workspace-overview.css";

const OVERVIEW_METRIC_SET = "overview.summary@1";
const highlightConfig = [
  { key: "conversation.messages.received@1", label: "Messages received", href: "/inbox", icon: MessageCircle },
  { key: "campaign.recipients.delivered@1", label: "Campaign deliveries", href: "/campaigns", icon: Send },
  { key: "agent.runs.completed@1", label: "Completed agent runs", href: "/analytics", icon: Bot },
  { key: "connection.health_checks@1", label: "Connection health checks", href: "/connections", icon: Cable },
] as const;
const chartConfig = [
  ...highlightConfig,
  { key: "campaign.delivery_rate@1", label: "Campaign delivery rate" },
  { key: "conversation.response_time_ms@1", label: "Conversation response time" },
  { key: "agent.runs.failed@1", label: "Failed agent runs" },
] as const;
export type OverviewSummary = {
  recentCampaigns: { id: string; name: string; status: string; deliveredCount: number; totalRecipients: number; templateName: string; connectionLabel: string | null }[];
  activeCampaigns: number;
  templateStatusMap: Record<string, number>;
  connections: { id: string; phoneDisplayNumber: string | null; phoneNumberId: string; currentQualityRating: string }[];
  attention?: { unreadConversations: number; socialAttention: number; connectionAttention: number; campaignFailures: number };
};

export function WorkspaceAnalyticsOverview({ summary }: { summary?: OverviewSummary }) {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [days, setDays] = useState("30");
  const [chart, setChart] = useState<string>(highlightConfig[0].key);
  const [retry, setRetry] = useState(0);
  const load = useCallback(async (cancelled: () => boolean) => {
    setLoading(true); setError(null);
    try {
      const catalog = await fetchAnalyticsCatalog();
      const next = await fetchAnalyticsReport({ ...createAnalyticsDateRange({ days: Number(days), timezone: catalog.timezone }), interval: "day", metric_set: OVERVIEW_METRIC_SET, include_descendants: false });
      if (!cancelled()) setReport(next);
    } catch (cause) { if (!cancelled()) setError(cause instanceof Error ? cause : new Error("Unable to load overview analytics")); }
    finally { if (!cancelled()) setLoading(false); }
  }, [days]);
  useEffect(() => { let cancelled = false; void load(() => cancelled); return () => { cancelled = true; }; }, [load, retry]);
  const results = new Map((report?.metrics ?? []).map((metric) => [`${metric.key}@${metric.version}`, metric]));
  const selectedMetric = results.get(chart);
  const selectedConfig = chartConfig.find((config) => config.key === chart)!;
  const populated = report?.metrics.some(hasObservedAnalyticsData);
  return <section className="growth-overview" aria-labelledby="workspace-analytics-title">
    <header className="mb-6 flex flex-wrap items-center justify-between gap-3">{summary ? <h1 id="workspace-analytics-title" className="text-[28px] font-semibold tracking-tight">Overview</h1> : <h2 id="workspace-analytics-title" className="text-lg font-semibold tracking-tight">Analytics</h2>}<Select value={days} onValueChange={setDays}><SelectTrigger aria-label="Overview date range" className="h-9 w-40"><CalendarDays className="mr-2 size-4" /><SelectValue /></SelectTrigger><SelectContent>{[7, 30, 90].map((value) => <SelectItem key={value} value={String(value)}>Last {value} days</SelectItem>)}</SelectContent></Select></header>
    {loading ? <div className="growth-overview-loading"><AnalyticsLoadingState /></div> : error ? <AnalyticsErrorState description={error.message} onRetry={() => setRetry((value) => value + 1)} /> : <>
      <div className="growth-overview-metrics">{highlightConfig.filter((config) => summary || hasObservedAnalyticsData(results.get(config.key) ?? { series: [] })).map((config) => { const Icon = config.icon; const metric = results.get(config.key); const value = metric ? latestObservedAnalyticsValue(metric) : null; return <Link key={config.key} to={config.href} className="growth-overview-metric"><Icon className="mt-1 size-6 shrink-0" /><div className="min-w-0"><p className="text-xs text-muted-foreground">{config.label}</p><p className="mt-1 text-[28px] font-semibold leading-tight">{value === null ? "—" : formatMetricValue(value, metric!.unit)}</p><p className="mt-2 text-[11px] text-muted-foreground">{value === null ? "No reported data" : "Latest reported period"}</p></div></Link>; })}</div>
      <div className="growth-overview-grid" data-workspace={Boolean(summary)}>
        <section className="growth-overview-panel"><header className="growth-overview-panel-header"><h2>Activity</h2><Select value={chart} onValueChange={setChart}><SelectTrigger aria-label="Overview activity metric" className="h-8 w-48 text-xs"><SelectValue /></SelectTrigger><SelectContent>{chartConfig.map((config) => <SelectItem key={config.key} value={config.key}>{config.label}</SelectItem>)}</SelectContent></Select></header><div className="p-4">{selectedMetric && hasObservedAnalyticsData(selectedMetric) ? <OverviewChart metric={selectedMetric} label={selectedConfig.label} timezone={report?.timezone} /> : <div className="flex min-h-52 items-center justify-center"><AnalyticsEmptyState title="No activity yet" /></div>}{selectedMetric ? <div className="mt-3 flex flex-wrap gap-2"><AnalyticsCoverageBadge coverage={selectedMetric.coverage} /><AnalyticsFreshnessBadge freshness={selectedMetric.freshness} /></div> : null}</div></section>
        {summary ? <section className="growth-overview-panel"><header className="growth-overview-panel-header"><h2>Needs attention</h2></header>{summary?.attention ? <div className="px-4"><AttentionRow icon={MessageCircle} title="Unread conversations" count={summary.attention.unreadConversations} href="/inbox" action="Open inbox" /><AttentionRow icon={FileText} title="Posts needing attention" count={summary.attention.socialAttention} href="/content/posts" action="Review" /><AttentionRow icon={Cable} title="Connection issues" count={summary.attention.connectionAttention} href="/connections" action="Review" /></div> : <p className="p-4 text-sm text-muted-foreground">No attention data available</p>}</section> : null}
        {summary ? <><section className="growth-overview-panel"><header className="growth-overview-panel-header"><h2>Recent campaigns</h2><Link to="/campaigns" className="text-xs text-muted-foreground">View all</Link></header><div className="overflow-x-auto"><table className="growth-overview-table"><thead><tr><th>Campaign</th><th>Template</th><th>Delivered</th><th>Status</th></tr></thead><tbody>{summary.recentCampaigns.map((campaign) => <tr key={campaign.id}><td><Link to={`/campaigns/${encodeURIComponent(campaign.id)}`}>{campaign.name}</Link></td><td>{campaign.templateName}</td><td>{campaign.deliveredCount.toLocaleString()} / {campaign.totalRecipients.toLocaleString()}</td><td><span className="growth-overview-status">{campaign.status.replaceAll("_", " ").toLowerCase()}</span></td></tr>)}</tbody></table>{!summary.recentCampaigns.length ? <p className="p-5 text-sm text-muted-foreground">No campaigns yet</p> : null}</div></section>
        <section className="growth-overview-panel"><header className="growth-overview-panel-header"><h2>Workspace</h2></header><div className="px-4"><SummaryRow label="Active campaigns" value={summary.activeCampaigns} href="/campaigns" /><SummaryRow label="Approved templates" value={summary.templateStatusMap.APPROVED || 0} href="/templates" /><SummaryRow label="Connected WhatsApp numbers" value={summary.connections.length} href="/connections" /></div></section></> : null}
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">{report && populated ? <AskGrowthAgent featureId="research" context={{ kind: "analytics_report", resourceId: OVERVIEW_METRIC_SET, range: { from: report.range_start, to: report.range_end, timezone: report.timezone } }}>Analyse results</AskGrowthAgent> : <span />}<Link to="/analytics" className="inline-flex min-h-9 items-center gap-1 text-xs text-muted-foreground">View report<ArrowUpRight className="size-3.5" /></Link></div>
    </>}
    {summary ? <section className="growth-overview-panel mt-4"><h2 className="px-4 pt-3 text-sm font-semibold">Quick access</h2><div className="growth-overview-quick">{[{ href: "/inbox", label: "Inbox", icon: MessageCircle }, { href: "/content", label: "Create post", icon: FileText }, { href: "/contacts", label: "Contacts", icon: Users }, { href: "/campaigns/create", label: "New campaign", icon: Send }].map(({ href, label, icon: Icon }) => <Link key={href} to={href}><Icon className="size-5" /><span>{label}</span><ArrowUpRight className="ml-auto size-3.5 text-muted-foreground" /></Link>)}</div></section> : null}
  </section>;
}
function AttentionRow({ icon: Icon, title, count, href, action }: { icon: typeof MessageCircle; title: string; count: number; href: string; action: string }) { return <div className="growth-overview-attention"><span className="growth-overview-attention-icon"><Icon className="size-5" /></span><span className="min-w-0 flex-1 text-sm font-medium">{title}</span><span className="text-lg font-semibold">{count.toLocaleString()}</span><Link to={href} className="growth-overview-action">{action}</Link></div>; }
function SummaryRow({ label, value, href }: { label: string; value: number; href: string }) { return <Link to={href} className="growth-overview-summary"><span>{label}</span><strong>{value.toLocaleString()}</strong></Link>; }
function OverviewChart({ metric, label, timezone }: { metric: AnalyticsMetricResult; label: string; timezone?: string }) {
  const points = metric.series;
  const observed = points.filter((point) => typeof point.value === "number" && Number.isFinite(point.value));
  const max = Math.max(1, ...observed.map((point) => point.value!));
  const x = (index: number) => points.length === 1 ? 320 : 38 + index / (points.length - 1) * 586;
  const y = (value: number) => 204 - value / max * 184;
  const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: timezone });
  const segments: string[][] = []; let segment: string[] = [];
  points.forEach((point, index) => { if (point.value === null || !Number.isFinite(point.value)) { if (segment.length) segments.push(segment); segment = []; } else segment.push(`${x(index)},${y(point.value)}`); });
  if (segment.length) segments.push(segment);
  return <><svg viewBox="0 0 640 224" className="growth-overview-chart" role="img" aria-label={`${label} trend`}>{[0, 0.25, 0.5, 0.75, 1].map((step) => <g key={step}><line x1="38" x2="624" y1={y(step * max)} y2={y(step * max)} stroke="var(--border)" strokeDasharray="3 4" /><text x="0" y={y(step * max) + 4} fontSize="10" fill="var(--muted-foreground)">{Math.round(step * max).toLocaleString()}</text></g>)}{segments.map((coordinates, index) => <polyline key={index} points={coordinates.join(" ")} fill="none" stroke="var(--primary)" strokeWidth="2" strokeLinejoin="round" />)}{points.map((point, index) => typeof point.value === "number" && Number.isFinite(point.value) ? <circle key={index} cx={x(index)} cy={y(point.value)} r="2.5" fill="var(--card)" stroke="var(--primary)" strokeWidth="1.5"><title>{date(point.bucket_start)}: {formatMetricValue(point.value, metric.unit)}</title></circle> : null)}</svg><div className="flex justify-between pl-9 text-[11px] text-muted-foreground"><span>{points[0] ? date(points[0].bucket_start) : ""}</span><span>{points.at(-1) ? date(points.at(-1)!.bucket_start) : ""}</span></div><details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">View data</summary><table className="mt-2 w-full text-left"><thead><tr><th>Date</th><th>Value</th></tr></thead><tbody>{points.map((point, index) => <tr key={index}><td className="py-1">{date(point.bucket_start)}</td><td>{point.value === null ? "—" : formatMetricValue(point.value, metric.unit)}</td></tr>)}</tbody></table></details></>;
}
function formatMetricValue(value: number, unit: string) { if (unit === "USD") return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`; if (unit === "milliseconds") return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`; if (unit === "percent") return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`; return value.toLocaleString(undefined, { maximumFractionDigits: unit === "count" || unit === "tokens" ? 0 : 2 }); }
