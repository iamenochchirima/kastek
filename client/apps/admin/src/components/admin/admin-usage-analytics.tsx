"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ChartState } from "@/components/admin/chart";
import { AdminLoadingState } from "@/components/admin/page-states";
import {
  AnalyticsChart, AnalyticsMetric, AnalyticsRangeToolbar, BreakdownBars, CoveragePanel, DataStamp,
  displayPoints, formatNumber, formatPercent, RangeDays, TimeBarChart,
} from "@/components/admin/admin-analytics-shared";

type UsageReport = {
  range: { start: string; end: string; days: number; interval: string };
  source: string;
  timezone: string;
  dataAsOf: string;
  coverage: Array<{ key: string; label: string; status: string; detail: string }>;
  kpis: { operations: number; conversations: number; messages: number; calls: number; campaignSends: number; deliveredMessages: number; failedMessages: number; deliveryRate: number; connections: number; connectionIssues: number; creditsConsumed: number };
  daily: Array<{ date: string; operations: number; conversations: number; messages: number; calls: number; campaignSends: number; creditsConsumed: number }>;
  productMix: Array<{ key: string; label: string; value: number }>;
  metricMix: Array<{ key: string; label: string; value: number }>;
  channelMix: Array<{ key: string; label: string; value: number }>;
  campaignFunnel: Array<{ key: string; label: string; value: number }>;
  connectionMix: Array<{ key: string; label: string; value: number }>;
  creditLifecycle: Array<{ kind: string; amount: number }>;
};

export function AdminUsageAnalytics() {
  const [days, setDays] = useState<RangeDays>(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (nextDays: RangeDays) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/analytics/usage?days=${nextDays}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Usage analytics are unavailable");
      setReport(data as UsageReport);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Usage analytics are unavailable"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(days); }, [days, load]);

  return <>
    <AdminPageHeader eyebrow="Analytics" title="Usage" description="Product activity, messaging, delivery, and credit consumption." />
    <AnalyticsRangeToolbar days={days} onChange={setDays} onRefresh={() => void load(days)} loading={loading} dataAsOf={report?.dataAsOf} interval={days === 365 ? "month" : "day"} />
    {loading ? <div className="mt-5"><AdminLoadingState rows={7} /></div> : error ? <div className="mt-5"><ChartState kind="error" title="Usage analytics unavailable" description={error} /></div> : report ? <UsageContent report={report} days={days} /> : <div className="mt-5"><ChartState kind="empty" title="No usage data" /></div>}
  </>;
}

function UsageContent({ report, days }: { report: UsageReport; days: RangeDays }) {
  const { kpis } = report;
  const activityPoints = useMemo(() => displayPoints(report.daily, days, ["operations", "conversations", "messages"]), [days, report.daily]);
  const deliveryPoints = useMemo(() => displayPoints(report.daily, days, ["campaignSends"]), [days, report.daily]);
  return <div className="mt-5 space-y-5">
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Usage metrics">
      <AnalyticsMetric label="Operations" value={formatNumber(kpis.operations)} detail="Recorded events" />
      <AnalyticsMetric label="Conversations" value={formatNumber(kpis.conversations)} detail="Workspace conversations" tone="info" />
      <AnalyticsMetric label="Messages" value={formatNumber(kpis.messages)} detail={`${formatNumber(kpis.calls)} calls`} />
      <AnalyticsMetric label="Campaign sends" value={formatNumber(kpis.campaignSends)} detail={`${formatPercent(kpis.deliveryRate)} delivered`} tone={kpis.deliveryRate < 90 && kpis.campaignSends > 0 ? "attention" : "success"} />
      <AnalyticsMetric label="Credits consumed" value={formatNumber(kpis.creditsConsumed)} detail="Metered activity" tone="info" />
      <AnalyticsMetric label="Connection issues" value={formatNumber(kpis.connectionIssues)} detail={`${formatNumber(kpis.connections)} total connections`} tone={kpis.connectionIssues ? "attention" : "success"} />
    </section>

    <AnalyticsChart title="Activity volume" description="Daily workspace activity. Each bar is a recorded event count." action={<span className="text-xs text-muted-foreground">{days === 365 ? "Monthly view" : "Daily view"}</span>}>
      <TimeBarChart points={activityPoints} series={[{ key: "operations", label: "Operations", color: 1 }, { key: "conversations", label: "Conversations", color: 2 }, { key: "messages", label: "Messages", color: 3 }]} ariaLabel="Workspace activity by day" valueFormatter={formatNumber} />
    </AnalyticsChart>

    <section className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
      <AnalyticsChart title="Campaign delivery" description="Send volume and delivery outcomes for the selected period.">
        <div className="space-y-5"><TimeBarChart points={deliveryPoints} series={[{ key: "campaignSends", label: "Campaign sends", color: 4 }]} ariaLabel="Campaign sends by day" /><BreakdownBars items={report.campaignFunnel} valueFormatter={formatNumber} emptyTitle="No campaign delivery data" maxItems={8} /></div>
      </AnalyticsChart>
      <AnalyticsChart title="Credits by lifecycle" description="Ledger movements and metered consumption.">
        <BreakdownBars items={report.creditLifecycle.map((item) => ({ key: item.kind, label: item.kind.replaceAll("_", " "), value: Math.abs(item.amount) }))} valueFormatter={formatNumber} emptyTitle="No credit movements" />
      </AnalyticsChart>
    </section>

    <section className="grid gap-5 lg:grid-cols-3">
      <AnalyticsChart title="Activity by product" description="Usage events attributed to each product."><BreakdownBars items={report.productMix} emptyTitle="No product activity" /></AnalyticsChart>
      <AnalyticsChart title="Activity by metric" description="Recorded operation metric distribution."><BreakdownBars items={report.metricMix} emptyTitle="No metric activity" /></AnalyticsChart>
      <AnalyticsChart title="Activity by channel" description="Conversation and delivery channel distribution."><BreakdownBars items={report.channelMix} emptyTitle="No channel activity" /></AnalyticsChart>
    </section>

    <section className="grid gap-5 lg:grid-cols-2">
      <AnalyticsChart title="Connection health" description="Current connection states across workspaces."><BreakdownBars items={report.connectionMix} emptyTitle="No connections" /></AnalyticsChart>
      <AnalyticsChart title="Delivery totals" description="Successful and unsuccessful campaign outcomes."><div className="grid gap-3 sm:grid-cols-2"><AnalyticsMetric label="Delivered" value={formatNumber(kpis.deliveredMessages)} tone="success" /><AnalyticsMetric label="Failed" value={formatNumber(kpis.failedMessages)} tone={kpis.failedMessages ? "danger" : "default"} /></div></AnalyticsChart>
    </section>
    <CoveragePanel items={report.coverage} />
    <DataStamp source={report.source} start={report.range.start} end={report.range.end} timezone={report.timezone} />
  </div>;
}
