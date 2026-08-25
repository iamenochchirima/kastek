"use client";

import Link from "next/link";
import { ArrowUpRight, BarChart3, Bot, MessageCircle, Send, Wifi } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AnalyticsCoverageBadge, AnalyticsEmptyState, AnalyticsErrorState, AnalyticsFreshnessBadge, AnalyticsLoadingState, AnalyticsStatusBadge } from "@/components/analytics/analytics-feedback";
import { AnalyticsTrendChart } from "@/components/analytics/analytics-visualizations";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createAnalyticsDateRange, fetchAnalyticsCatalog, fetchAnalyticsReport, type AnalyticsCatalog, type AnalyticsMetricDefinition, type AnalyticsMetricResult, type AnalyticsReport } from "@/lib/analytics";

const OVERVIEW_METRIC_SET = "overview.summary@1";

const highlightConfig = [
  { key: "conversation.messages.received@1", label: "Messages received", href: "/inbox", icon: MessageCircle },
  { key: "campaign.recipients.delivered@1", label: "Campaign deliveries", href: "/campaigns", icon: Send },
  { key: "agent.runs.completed@1", label: "Completed agent runs", href: "/agents/analytics", icon: Bot },
  { key: "connection.health_checks@1", label: "Connection health checks", href: "/connections", icon: Wifi },
] as const;

const trendConfig = [
  { key: "campaign.delivery_rate@1", label: "Campaign delivery rate", href: "/campaigns" },
  { key: "conversation.response_time_ms@1", label: "Conversation response time", href: "/inbox" },
  { key: "agent.runs.failed@1", label: "Failed agent runs", href: "/agents/analytics" },
] as const;

export function WorkspaceAnalyticsOverview() {
  const [catalog, setCatalog] = useState<AnalyticsCatalog | null>(null);
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
      setCatalog(nextCatalog);
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

  const definitions = useMemo(
    () => new Map((catalog?.metrics ?? []).map((metric) => [`${metric.key}@${metric.version}`, metric])),
    [catalog],
  );
  const results = useMemo(
    () => new Map((report?.metrics ?? []).map((metric) => [`${metric.key}@${metric.version}`, metric])),
    [report],
  );
  const unavailableCount = report?.metrics.filter((metric) => metric.availability.state !== "available").length ?? 0;

  return (
    <section className="mt-8" aria-labelledby="workspace-analytics-title">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="workspace-analytics-title" className="text-base font-semibold text-foreground">Workspace analytics</h2>
          <p className="mt-1 text-xs text-muted-foreground">Feature reporting for the last 30 days.</p>
        </div>
        <Link href="/analytics" className="inline-flex min-h-9 items-center text-xs font-medium text-muted-foreground no-underline transition-colors duration-[150ms] hover:text-foreground">Open analytics <ArrowUpRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" /></Link>
      </div>
      {loading ? <Card><CardContent className="p-5"><AnalyticsLoadingState /></CardContent></Card> : error ? <AnalyticsErrorState description={error.message} onRetry={() => void load()} /> : report ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/20 px-4 py-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />{formatScope(report.scope_kind)}</span>
            <span>Data as of {report.data_as_of ? formatDate(report.data_as_of, report.timezone) : "unavailable"}</span>
            {unavailableCount ? <AnalyticsStatusBadge state="unavailable" label={`${unavailableCount} metric${unavailableCount === 1 ? "" : "s"} unavailable`} /> : <AnalyticsStatusBadge state="available" label="All selected metrics available" />}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {highlightConfig.map((config) => <HighlightCard key={config.key} config={config} metric={results.get(config.key)} definition={definitions.get(config.key)} />)}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {trendConfig.map((config) => <TrendCard key={config.key} config={config} metric={results.get(config.key)} definition={definitions.get(config.key)} />)}
          </div>
        </div>
      ) : <AnalyticsEmptyState title="No overview metrics" />}
    </section>
  );
}

function HighlightCard({ config, metric, definition }: { config: (typeof highlightConfig)[number]; metric?: AnalyticsMetricResult; definition?: AnalyticsMetricDefinition }) {
  const Icon = config.icon;
  const value = metric ? latestValue(metric) : null;
  return (
    <Link href={config.href} className="no-underline">
      <Card className="h-full transition-colors hover:border-primary/40">
        <CardHeader className="gap-3">
          <div className="flex items-start justify-between gap-3"><CardTitle className="text-sm font-medium text-muted-foreground">{config.label}</CardTitle><Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" /></div>
          <div className="text-3xl font-semibold tracking-tight">{metric ? formatMetricValue(value, metric.unit) : "—"}</div>
        </CardHeader>
        <CardContent className="space-y-2"><p className="line-clamp-2 text-xs text-muted-foreground">{definition?.description || "Reporting metric"}</p>{metric ? <div className="flex flex-wrap gap-3"><AnalyticsStatusBadge state={metric.availability.state} /><AnalyticsFreshnessBadge freshness={metric.freshness} /></div> : <Badge variant="outline">Not available</Badge>}</CardContent>
      </Card>
    </Link>
  );
}

function TrendCard({ config, metric, definition }: { config: (typeof trendConfig)[number]; metric?: AnalyticsMetricResult; definition?: AnalyticsMetricDefinition }) {
  return (
    <Card>
      <CardHeader className="gap-2"><div className="flex items-start justify-between gap-3"><CardTitle className="text-sm font-medium">{config.label}</CardTitle><Link href={config.href} aria-label={`Open ${config.label}`} className="text-muted-foreground hover:text-foreground"><ArrowUpRight className="h-4 w-4" aria-hidden="true" /></Link></div><CardDescription className="line-clamp-2">{definition?.description || "Reporting metric"}</CardDescription></CardHeader>
      <CardContent>{metric ? <><AnalyticsTrendChart points={metric.series} label={`${config.label} trend`} /><div className="mt-3 flex flex-wrap gap-3"><AnalyticsFreshnessBadge freshness={metric.freshness} /><AnalyticsCoverageBadge coverage={metric.coverage} /></div></> : <AnalyticsEmptyState title="Metric unavailable" />}</CardContent>
    </Card>
  );
}

function latestValue(metric: AnalyticsMetricResult) {
  return [...metric.series].reverse().find((point) => point.value !== null)?.value ?? null;
}

function formatScope(scope: string) {
  return scope.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string, timezone: string) {
  return new Date(value).toLocaleString(undefined, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
}

function formatMetricValue(value: number | null, unit: string) {
  if (value === null) return "—";
  if (unit === "USD") return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  if (unit === "milliseconds") return `${value.toLocaleString(undefined, { maximumFractionDigits: 0 })} ms`;
  if (unit === "percent") return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString(undefined, { maximumFractionDigits: unit === "count" || unit === "tokens" ? 0 : 2 });
}
