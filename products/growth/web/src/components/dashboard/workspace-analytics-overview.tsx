"use client";

import Link from "next/link";
import { ArrowUpRight, Bot, MessageCircle, Send, Wifi } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AnalyticsEmptyState, AnalyticsErrorState, AnalyticsLoadingState } from "@/components/analytics/analytics-feedback";
import { AnalyticsTrendChart } from "@/components/analytics/analytics-visualizations";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createAnalyticsDateRange, fetchAnalyticsCatalog, fetchAnalyticsReport, hasObservedAnalyticsData, latestObservedAnalyticsValue, type AnalyticsMetricResult, type AnalyticsReport } from "@/lib/analytics";

const OVERVIEW_METRIC_SET = "overview.summary@1";

const highlightConfig = [
  { key: "conversation.messages.received@1", label: "Messages received", href: "/inbox", icon: MessageCircle },
  { key: "campaign.recipients.delivered@1", label: "Campaign deliveries", href: "/campaigns", icon: Send },
  { key: "agent.runs.completed@1", label: "Completed agent runs", href: "/analytics", icon: Bot },
  { key: "connection.health_checks@1", label: "Connection health checks", href: "/connections", icon: Wifi },
] as const;

const trendConfig = [
  { key: "campaign.delivery_rate@1", label: "Campaign delivery rate", href: "/campaigns" },
  { key: "conversation.response_time_ms@1", label: "Conversation response time", href: "/inbox" },
  { key: "agent.runs.failed@1", label: "Failed agent runs", href: "/analytics" },
] as const;

export function WorkspaceAnalyticsOverview() {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextCatalog = await fetchAnalyticsCatalog();
      const nextReport = await fetchAnalyticsReport({
        ...createAnalyticsDateRange({ days: 30, timezone: nextCatalog.timezone }),
        interval: "day",
        metric_set: OVERVIEW_METRIC_SET,
        include_descendants: false,
      });
      setReport(nextReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Unable to load overview analytics"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const results = new Map((report?.metrics ?? []).map((metric) => [`${metric.key}@${metric.version}`, metric]));
  const populatedMetrics = (report?.metrics ?? []).filter(hasObservedAnalyticsData);

  return (
    <section className="mt-10" aria-labelledby="workspace-analytics-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="workspace-analytics-title" className="text-lg font-semibold tracking-tight text-foreground">Analytics</h2>
          <p className="mt-1 text-xs text-muted-foreground">Last 30 days</p>
        </div>
        <Link href="/analytics" className="inline-flex min-h-9 items-center text-xs font-medium text-muted-foreground no-underline transition-colors duration-[150ms] hover:text-foreground">View report <ArrowUpRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" /></Link>
      </div>
      {loading ? <Card><CardContent className="p-5"><AnalyticsLoadingState /></CardContent></Card> : error ? <AnalyticsErrorState description={error.message} onRetry={() => void load()} /> : report ? (
        populatedMetrics.length ? <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {highlightConfig.filter((config) => hasObservedAnalyticsData(results.get(config.key) ?? { series: [] })).map((config) => <HighlightCard key={config.key} config={config} metric={results.get(config.key)!} />)}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {trendConfig.filter((config) => hasObservedAnalyticsData(results.get(config.key) ?? { series: [] })).map((config) => <TrendCard key={config.key} config={config} metric={results.get(config.key)!} />)}
          </div>
        </div> : <AnalyticsEmptyState title="No activity yet" />
      ) : <AnalyticsEmptyState title="No overview metrics" />}
    </section>
  );
}

function HighlightCard({ config, metric }: { config: (typeof highlightConfig)[number]; metric: AnalyticsMetricResult }) {
  const Icon = config.icon;
  const value = latestObservedAnalyticsValue(metric);
  const unit = metric.unit;
  return (
    <Link href={config.href} className="no-underline">
      <Card className="h-full transition-colors hover:border-primary/40">
        <CardHeader className="gap-2 pb-3">
          <div className="flex items-start justify-between gap-3"><CardTitle className="text-xs font-medium text-muted-foreground">{config.label}</CardTitle><Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" /></div>
          <div className="text-3xl font-semibold tracking-tight">{formatMetricValue(value ?? 0, unit)}</div>
        </CardHeader>
        <CardContent className="pt-0"><span className="text-[11px] text-muted-foreground">Last 30 days</span></CardContent>
      </Card>
    </Link>
  );
}

function TrendCard({ config, metric }: { config: (typeof trendConfig)[number]; metric: AnalyticsMetricResult }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between gap-3 border-b border-border pb-3"><div><CardTitle className="text-sm font-medium">{config.label}</CardTitle><CardDescription className="mt-1 text-xs">Last 30 days</CardDescription></div><Link href={config.href} aria-label={`Open ${config.label}`} className="text-muted-foreground hover:text-foreground"><ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link></CardHeader>
      <CardContent className="p-4"><AnalyticsTrendChart points={metric.series} label={`${config.label} trend`} /></CardContent>
    </Card>
  );
}

function formatMetricValue(value: number, unit: string) {
  if (unit === "USD") return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (unit === "milliseconds") return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`;
  if (unit === "percent") return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString(undefined, { maximumFractionDigits: unit === "count" || unit === "tokens" ? 0 : 2 });
}
