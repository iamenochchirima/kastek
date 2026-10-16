"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnalyticsCoverageBadge, AnalyticsEmptyState, AnalyticsErrorState, AnalyticsFreshnessBadge, AnalyticsLoadingState } from "@/components/analytics/analytics-feedback";
import { AnalyticsMetricSeriesTable, AnalyticsTrendChart } from "@/components/analytics/analytics-visualizations";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  analyticsGatewayPaths,
  createAnalyticsDateRange,
  fetchAnalyticsCatalog,
  fetchAnalyticsReport,
  type AnalyticsCatalog,
  type AnalyticsMetricDefinition,
  type AnalyticsMetricResult,
  type AnalyticsReport,
  type AnalyticsSurface,
  hasObservedAnalyticsData,
  latestObservedAnalyticsValue,
} from "@/lib/analytics";

export const CAMPAIGN_ANALYTICS_METRICS = [
  "campaign.recipients.sent@1",
  "campaign.recipients.delivered@1",
  "campaign.recipients.read@1",
  "campaign.recipients.failed@1",
  "campaign.recipients.blocked@1",
  "campaign.recipients.suppressed@1",
  "campaign.recipients.unsubscribed@1",
  "campaign.delivery_delay_ms@1",
  "campaign.recipients.retried@1",
  "campaign.recipients.pricing_recorded@1",
  "campaign.delivery_rate@1",
] as const;

export const CONNECTION_ANALYTICS_METRICS = [
  "connection.lifecycle_events@1",
  "connection.health_checks@1",
  "connection.capability_events@1",
  "connection.sync_attempts@1",
  "connection.rate_limit_encounters@1",
  "connection.incidents@1",
] as const;

export const INBOX_ANALYTICS_METRICS = [
  "conversation.lifecycle_events@1",
  "conversation.message.lifecycle_events@1",
  "conversation.response_time_ms@1",
  "conversation.messages.received@1",
  "conversation.responses.recorded@1",
] as const;

type FeatureAnalyticsPanelProps = {
  title: string;
  description: string;
  metricKeys: readonly string[];
  surface?: AnalyticsSurface;
};

export function FeatureAnalyticsPanel({ title, description, metricKeys, surface = "core" }: FeatureAnalyticsPanelProps) {
  const [catalog, setCatalog] = useState<AnalyticsCatalog | null>(null);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const paths = analyticsGatewayPaths(surface);
      const nextCatalog = await fetchAnalyticsCatalog({ path: paths.catalog });
      const nextReport = await fetchAnalyticsReport(
        {
          ...createAnalyticsDateRange({ days: 30, timezone: nextCatalog.timezone }),
          interval: "day",
          metrics: [...metricKeys],
          include_descendants: false,
        },
        { path: paths.query },
      );
      setCatalog(nextCatalog);
      setReport(nextReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Unable to load feature analytics"));
    } finally {
      setLoading(false);
    }
  }, [metricKeys, surface]);

  useEffect(() => {
    void load();
  }, [load]);

  const definitions = useMemo(() => new Map((catalog?.metrics ?? []).map((metric) => [`${metric.key}@${metric.version}`, metric])), [catalog]);
  const results = report?.metrics ?? [];
  const populatedMetrics = results.filter(hasObservedAnalyticsData);
  const summaryMetrics = populatedMetrics.slice(0, 4);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title} analytics</CardTitle>
        <CardDescription>{description} · {report ? `${report.timezone} · last 30 days` : ""}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <AnalyticsLoadingState /> : error ? <AnalyticsErrorState description={error.message} onRetry={() => void load()} /> : report ? populatedMetrics.length ? <div className="space-y-5">
          {summaryMetrics.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{summaryMetrics.map((metric) => <FeatureMetricCard key={`${metric.key}-${metric.version}`} metric={metric} definition={definitions.get(`${metric.key}@${metric.version}`)} />)}</div> : null}
          <div className="space-y-3">{populatedMetrics.map((metric) => <FeatureMetricDetail key={`${metric.key}-${metric.version}`} metric={metric} definition={definitions.get(`${metric.key}@${metric.version}`)} timezone={report.timezone} />)}</div>
        </div> : <AnalyticsEmptyState title="No activity yet" /> : null}
      </CardContent>
    </Card>
  );
}

function FeatureMetricCard({ metric, definition }: { metric: AnalyticsMetricResult; definition?: AnalyticsMetricDefinition }) {
  const value = latestObservedAnalyticsValue(metric);
  return <div className="rounded-lg border border-border p-4"><div className="text-xs text-muted-foreground">{definition?.description || metric.key}</div><div className="mt-2 text-2xl font-semibold">{formatMetricValue(value, metric.unit)}</div><div className="mt-3 flex flex-wrap gap-3"><AnalyticsFreshnessBadge freshness={metric.freshness} /><AnalyticsCoverageBadge coverage={metric.coverage} /></div></div>;
}

function FeatureMetricDetail({ metric, definition, timezone }: { metric: AnalyticsMetricResult; definition?: AnalyticsMetricDefinition; timezone: string }) {
  return <details className="rounded-lg border border-border"><summary className="flex cursor-pointer list-none flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden"><div><div className="text-sm font-medium">{definition?.description || metric.key}</div><div className="mt-1 text-xs text-muted-foreground">{metric.key} · {metric.exactness}</div></div><div className="flex flex-wrap gap-3"><AnalyticsFreshnessBadge freshness={metric.freshness} /><AnalyticsCoverageBadge coverage={metric.coverage} /></div></summary><div className="grid gap-5 border-t border-border p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><AnalyticsTrendChart points={metric.series} label={`${metric.key} trend`} /><AnalyticsMetricSeriesTable metric={metric} timezone={timezone} /></div>{metric.warnings.length ? <div className="border-t border-status-attention/20 bg-status-attention-soft px-4 py-3 text-xs text-status-attention">{metric.warnings.join(" · ")}</div> : null}</details>;
}

function formatMetricValue(value: number | null, unit: string) {
  if (value === null) return "—";
  const formatted = value.toLocaleString(undefined, { maximumFractionDigits: unit === "count" ? 0 : 2 });
  return unit && unit !== "count" ? `${formatted} ${unit}` : formatted;
}
