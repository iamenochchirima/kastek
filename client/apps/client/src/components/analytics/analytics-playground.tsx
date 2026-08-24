"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Database, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { AnalyticsCoverageBadge, AnalyticsEmptyState, AnalyticsErrorState, AnalyticsFreshnessBadge, AnalyticsLoadingState, AnalyticsStatusBadge } from "@/components/analytics/analytics-feedback";
import { AnalyticsMetricSeriesTable, AnalyticsTrendChart } from "@/components/analytics/analytics-visualizations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { apiUrl } from "@/lib/server-api";
import {
  analyticsGatewayPaths,
  createAnalyticsDateRange,
  fetchAnalyticsCatalog,
  fetchAnalyticsReport,
  formatAnalyticsTimestamp,
  type AnalyticsCatalog,
  type AnalyticsMetricResult,
  type AnalyticsReport,
} from "@/lib/analytics";

type PlaygroundConnection = {
  id: string;
  phoneDisplayNumber: string | null;
  currentQualityRating: string;
  verified: boolean;
};

type HealthResult = {
  ok: boolean;
  detail: string;
};

async function listPlaygroundConnections(): Promise<PlaygroundConnection[]> {
  const response = await fetch(apiUrl("/api/whatsapp/connections"), {
    credentials: "include",
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Unable to load connections");
  return Array.isArray(body?.connections) ? body.connections as PlaygroundConnection[] : [];
}

async function runConnectionHealthCheck(connectionId: string) {
  const response = await fetch(apiUrl(`/api/whatsapp/connections/${encodeURIComponent(connectionId)}/health`), {
    credentials: "include",
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Connection health check failed");
  return body as { healthy?: boolean; steps?: Array<{ ok?: boolean; detail?: string }> };
}

export function AnalyticsPlayground() {
  const [catalog, setCatalog] = useState<AnalyticsCatalog | null>(null);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [connections, setConnections] = useState<PlaygroundConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [healthChecks, setHealthChecks] = useState<Record<string, HealthResult>>({});
  const [checkingConnection, setCheckingConnection] = useState<string | null>(null);

  const load = useCallback(async (background = false) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const nextCatalog = await fetchAnalyticsCatalog({ path: analyticsGatewayPaths().catalog });
      const nextReport = await fetchAnalyticsReport(
        {
          ...createAnalyticsDateRange({ days: 7, timezone: nextCatalog.timezone }),
          interval: "day",
          metric_set: "overview.summary@1",
          include_descendants: false,
        },
        { path: analyticsGatewayPaths().query },
      );
      const nextConnections = await listPlaygroundConnections();
      setCatalog(nextCatalog);
      setReport(nextReport);
      setConnections(nextConnections);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "Unable to load the Analytics playground");
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const checkHealth = async (connection: PlaygroundConnection) => {
    setCheckingConnection(connection.id);
    setError(null);
    try {
      const result = await runConnectionHealthCheck(connection.id);
      const failedStep = result.steps?.find((step) => step.ok === false);
      setHealthChecks((current) => ({
        ...current,
        [connection.id]: {
          ok: result.healthy === true,
          detail: failedStep?.detail || (result.healthy ? "Health check completed" : "Health check reported an issue"),
        },
      }));
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Connection health check failed");
    } finally {
      setCheckingConnection(null);
    }
  };

  const metrics = report?.metrics ?? [];
  const availableMetrics = metrics.filter((metric) => metric.availability.state === "available").length;

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Analytics playground</PageHeaderTitle>
            <PageHeaderDescription>Local pipeline checks.</PageHeaderDescription>
          </PageHeaderContent>
          <div className="flex flex-wrap gap-2">
            <Button asChild type="button" variant="outline" size="sm"><Link href="/analytics"><ArrowLeft className="mr-1.5 h-3.5 w-3.5" />Analytics</Link></Button>
            <Button type="button" variant="outline" size="sm" className="gap-1.5" disabled={loading || refreshing} onClick={() => void load(true)}><RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />Refresh</Button>
          </div>
        </PageHeader>

        {error ? <AnalyticsErrorState description={error} onRetry={() => void load(true)} /> : null}

        {loading ? <Card><CardContent className="p-5"><AnalyticsLoadingState /></CardContent></Card> : null}

        {!loading && report && catalog ? <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <PipelineCard icon={<ShieldCheck className="h-4 w-4" />} label="Reporting gateway" value="Available" detail={`${catalog.metrics.length} registered metrics`} state="available" />
            <PipelineCard icon={<Database className="h-4 w-4" />} label="Projection generation" value={report.generation_id ? `#${report.generation_id}` : "Not generated"} detail={report.projection_version} state={report.generation_id ? "complete" : "unavailable"} />
            <PipelineCard icon={<Zap className="h-4 w-4" />} label="Report metrics" value={`${availableMetrics}/${metrics.length}`} detail="Available in this scope" state={availableMetrics === metrics.length ? "complete" : "partial"} />
            <PipelineCard icon={<RefreshCw className="h-4 w-4" />} label="Data as of" value={formatAnalyticsTimestamp(report.data_as_of)} detail={`Generated ${formatAnalyticsTimestamp(report.generated_at)}`} state="available" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Pipeline report</CardTitle>
              <CardDescription>{report.range_start} to {report.range_end} · {report.timezone}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {metrics.length ? metrics.map((metric) => <MetricCheck key={`${metric.key}-${metric.version}`} metric={metric} timezone={report.timezone} />) : <AnalyticsEmptyState />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Source activity</CardTitle>
              <CardDescription>Run an existing Core health operation and inspect its reported result.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {connections.length ? connections.map((connection) => {
                const result = healthChecks[connection.id];
                return (
                  <div key={connection.id} className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm font-medium"><span>{connection.phoneDisplayNumber || "WhatsApp connection"}</span><Badge variant="outline">{connection.currentQualityRating}</Badge>{connection.verified ? <AnalyticsStatusBadge state="available" label="Verified" /> : null}</div>
                      {result ? <p className={`mt-1 text-xs ${result.ok ? "text-status-success" : "text-destructive"}`}>{result.detail}</p> : <p className="mt-1 text-xs text-muted-foreground">No local check recorded.</p>}
                    </div>
                    <Button type="button" variant="outline" size="sm" disabled={checkingConnection !== null} onClick={() => void checkHealth(connection)}>{checkingConnection === connection.id ? "Checking…" : "Check health"}</Button>
                  </div>
                );
              }) : <AnalyticsEmptyState title="No WhatsApp connections" description="Connect a source before running a health check." />}
            </CardContent>
          </Card>
        </> : null}
      </div>
    </div>
  );
}

function PipelineCard({ icon, label, value, detail, state }: { icon: React.ReactNode; label: string; value: string; detail: string; state: string }) {
  return <Card><CardContent className="p-5"><div className="flex items-center justify-between gap-3 text-xs text-muted-foreground"><span className="flex items-center gap-1.5">{icon}{label}</span><AnalyticsStatusBadge state={state} /></div><div className="mt-3 text-2xl font-semibold tracking-tight">{value}</div><div className="mt-1 truncate text-xs text-muted-foreground">{detail}</div></CardContent></Card>;
}

function MetricCheck({ metric, timezone }: { metric: AnalyticsMetricResult; timezone: string }) {
  return (
    <details className="group rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between [&::-webkit-details-marker]:hidden">
        <div className="min-w-0"><div className="truncate text-sm font-medium">{metric.key}</div><div className="mt-1 text-xs text-muted-foreground">v{metric.version} · {metric.exactness} · {metric.unit || "unitless"}</div></div>
        <div className="flex flex-wrap items-center gap-3"><AnalyticsStatusBadge state={metric.availability.state} /><AnalyticsFreshnessBadge freshness={metric.freshness} /><AnalyticsCoverageBadge coverage={metric.coverage} /></div>
      </summary>
      <div className="grid gap-6 border-t border-border p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <AnalyticsTrendChart points={metric.series} label={`${metric.key} trend`} />
        <AnalyticsMetricSeriesTable metric={metric} timezone={timezone} />
      </div>
      {metric.warnings.length ? <div className="border-t border-status-attention/20 bg-status-attention-soft px-4 py-3 text-xs text-status-attention">{metric.warnings.join(" · ")}</div> : null}
    </details>
  );
}
