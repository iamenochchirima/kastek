"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, BarChart3, Clock3, Coins, MessageSquare, Wrench } from "lucide-react";
import { AnalyticsCoverageBadge, AnalyticsEmptyState, AnalyticsErrorState, AnalyticsFreshnessBadge, AnalyticsLoadingState, AnalyticsStatusBadge } from "@/components/analytics/analytics-feedback";
import { AnalyticsMetricSeriesTable, AnalyticsTrendChart } from "@/components/analytics/analytics-visualizations";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  createAnalyticsDateRange,
  fetchAnalyticsCatalog,
  fetchAnalyticsReport,
  type AnalyticsCatalog,
  type AnalyticsMetricDefinition,
  type AnalyticsMetricResult,
  type AnalyticsReport,
  hasObservedAnalyticsData,
  latestObservedAnalyticsValue,
} from "@/lib/analytics";

export const AGENT_ANALYTICS_METRICS = [
  "agent.runs.completed@1",
  "agent.runs.failed@1",
  "agent.model_calls.completed@1",
  "agent.model_calls.failed@1",
  "agent.tokens.input@1",
  "agent.tokens.output@1",
  "agent.cost.usd@1",
  "agent.tools.lifecycle_events@1",
  "agent.approvals.lifecycle_events@1",
  "agent.effects.lifecycle_events@1",
  "agent.schedules.lifecycle_events@1",
  "agent.installations.lifecycle_events@1",
  "agent.versions.lifecycle_events@1",
  "agent.definitions.lifecycle_events@1",
  "agent.readiness.evaluations@1",
  "agent.conversations.lifecycle_events@1",
  "agent.conversation_messages.lifecycle_events@1",
  "agent.conversation.response_time_ms@1",
] as const;

export const AGENT_HANDOFF_ANALYTICS_METRIC = "agent.handoffs.lifecycle_events@1";

type AgentAnalyticsPanelProps = {
  agentName: string;
  installationId: string;
  handoffEnabled: boolean;
};

export function AgentAnalyticsPanel({ agentName, installationId, handoffEnabled }: AgentAnalyticsPanelProps) {
  const [catalog, setCatalog] = useState<AnalyticsCatalog | null>(null);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const metricKeys = useMemo(
    () => [...AGENT_ANALYTICS_METRICS, ...(handoffEnabled ? [AGENT_HANDOFF_ANALYTICS_METRIC] : [])],
    [handoffEnabled],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextCatalog = await fetchAnalyticsCatalog();
      const nextReport = await fetchAnalyticsReport({
        ...createAnalyticsDateRange({ days: 30, timezone: nextCatalog.timezone }),
        interval: "day",
        metrics: metricKeys,
        breakdowns: ["agent_installation"],
        filters: { agent_installation: [installationId] },
        include_descendants: false,
      });
      setCatalog(nextCatalog);
      setReport(nextReport);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error("Unable to load agent analytics"));
    } finally {
      setLoading(false);
    }
  }, [installationId, metricKeys]);

  useEffect(() => {
    void load();
  }, [load]);

  const definitions = useMemo(
    () => new Map((catalog?.metrics ?? []).map((metric) => [`${metric.key}@${metric.version}`, metric])),
    [catalog],
  );
  const results = report?.metrics ?? [];
  const populatedMetrics = results.filter(hasObservedAnalyticsData);
  const summaryMetrics = populatedMetrics.slice(0, 4);
  const unavailableCount = populatedMetrics.filter((metric) => metric.availability.state !== "available").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{agentName} analytics</CardTitle>
        <CardDescription>
          Last 30 days{report ? ` · ${report.timezone}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? <AnalyticsLoadingState /> : error ? <AnalyticsErrorState description={error.message} onRetry={() => void load()} /> : report ? (
          <div className="space-y-5">
            {populatedMetrics.length ? <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-secondary/20 px-4 py-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />Scope: {formatScope(report.scope_kind)}</span>
              <span>Filtered to this installation</span>
              <span>{report.data_as_of ? `Data as of ${formatDate(report.data_as_of, report.timezone)}` : "Data as of unavailable"}</span>
              {unavailableCount ? <AnalyticsStatusBadge state="unavailable" label={`${unavailableCount} source${unavailableCount === 1 ? "" : "s"} unavailable`} /> : <AnalyticsStatusBadge state="available" label="Sources available" />}
            </div> : null}
            {summaryMetrics.length ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{summaryMetrics.map((metric) => <AgentMetricCard key={`${metric.key}-${metric.version}`} metric={metric} definition={definitions.get(`${metric.key}@${metric.version}`)} />)}</div> : null}
            {populatedMetrics.length ? <div className="space-y-3">{populatedMetrics.map((metric) => <AgentMetricDetail key={`${metric.key}-${metric.version}`} metric={metric} definition={definitions.get(`${metric.key}@${metric.version}`)} timezone={report.timezone} />)}</div> : <AnalyticsEmptyState title="No activity yet" />}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AgentMetricCard({ metric, definition }: { metric: AnalyticsMetricResult; definition?: AnalyticsMetricDefinition }) {
  const value = latestObservedAnalyticsValue(metric);
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="text-xs text-muted-foreground">{definition?.description || metric.key}</div>
        <MetricIcon metricKey={metric.key} />
      </div>
      <div className="mt-2 text-2xl font-semibold">{formatMetricValue(value, metric.unit)}</div>
      <div className="mt-3 flex flex-wrap gap-3"><AnalyticsStatusBadge state={metric.availability.state} /><AnalyticsFreshnessBadge freshness={metric.freshness} /></div>
    </div>
  );
}

function AgentMetricDetail({ metric, definition, timezone }: { metric: AnalyticsMetricResult; definition?: AnalyticsMetricDefinition; timezone: string }) {
  return (
    <details className="rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden">
        <div><div className="text-sm font-medium">{definition?.description || metric.key}</div><div className="mt-1 text-xs text-muted-foreground">{metric.key} · {metric.exactness}</div></div>
        <div className="flex flex-wrap gap-3"><AnalyticsStatusBadge state={metric.availability.state} /><AnalyticsCoverageBadge coverage={metric.coverage} /></div>
      </summary>
      <div className="grid gap-5 border-t border-border p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"><AnalyticsTrendChart points={metric.series} label={`${metric.key} trend`} /><AnalyticsMetricSeriesTable metric={metric} timezone={timezone} /></div>
      {metric.availability.reason ? <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{metric.availability.reason}</div> : null}
      {metric.warnings.length ? <div className="border-t border-status-attention/20 bg-status-attention-soft px-4 py-3 text-xs text-status-attention">{metric.warnings.join(" · ")}</div> : null}
    </details>
  );
}

function MetricIcon({ metricKey }: { metricKey: string }) {
  if (metricKey.includes("model") || metricKey.includes("tokens") || metricKey.includes("cost")) return <Coins className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  if (metricKey.includes("tool") || metricKey.includes("effect")) return <Wrench className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  if (metricKey.includes("response_time")) return <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  if (metricKey.includes("conversation") || metricKey.includes("handoff")) return <MessageSquare className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
  return <Activity className="h-4 w-4 text-muted-foreground" aria-hidden="true" />;
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
  return value.toLocaleString(undefined, { maximumFractionDigits: unit === "count" || unit === "tokens" ? 0 : 2 });
}
