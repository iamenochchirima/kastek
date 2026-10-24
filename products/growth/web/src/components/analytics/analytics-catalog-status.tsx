"use client";

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AnalyticsErrorState, AnalyticsLoadingState, AnalyticsStatusBadge } from "@/components/analytics/analytics-feedback";
import { analyticsGatewayPaths, fetchAnalyticsCatalog, type AnalyticsCatalog, type AnalyticsSurface } from "@/lib/analytics";

export function AnalyticsCatalogStatus({ surface = "core" }: { surface?: AnalyticsSurface }) {
  const [catalog, setCatalog] = useState<AnalyticsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCatalog(await fetchAnalyticsCatalog({ path: analyticsGatewayPaths(surface).catalog }));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError(cause instanceof Error ? cause : new Error("Analytics request failed"));
    } finally {
      setLoading(false);
    }
  }, [surface]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="px-4 pt-4 sm:px-6" aria-label="Reporting data status">
      <div className="mx-auto max-w-[1440px]">
        {loading ? (
          <Card><CardContent className="p-5"><AnalyticsLoadingState /></CardContent></Card>
        ) : error ? (
          <AnalyticsErrorState
            description={error.message}
            onRetry={() => void load()}
          />
        ) : catalog ? (
          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <CardTitle>Reporting data</CardTitle>
                <CardDescription>Canonical metrics catalog.</CardDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2"><AnalyticsStatusBadge state="available" label="Available" />{import.meta.env.DEV ? <Link to="/analytics/playground" className="text-xs font-medium text-primary hover:underline">Open playground</Link> : null}</div>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
              <span><strong className="font-medium text-foreground">{catalog.metrics.length}</strong> metrics</span>
              <span><strong className="font-medium text-foreground">{catalog.dimensions.length}</strong> dimensions</span>
              <span><strong className="font-medium text-foreground">{catalog.metric_sets.length}</strong> metric sets</span>
              <Badge variant="outline">Registry {catalog.registry_version}</Badge>
              <span>Timezone: {catalog.timezone}</span>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </section>
  );
}
