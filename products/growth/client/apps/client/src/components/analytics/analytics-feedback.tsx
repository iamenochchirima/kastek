import { AlertCircle, CheckCircle2, Clock3, Database, Info, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { AnalyticsCoverage, AnalyticsFreshness } from "@/lib/analytics";

type AnalyticsState = "available" | "complete" | "partial" | "fresh" | "stale" | "unavailable" | "unknown" | string;

function stateLabel(state: string) {
  return state.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stateClass(state: string) {
  if (["available", "complete", "fresh"].includes(state)) return "border-status-success/30 bg-status-success-soft text-status-success";
  if (["partial", "stale"].includes(state)) return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  if (["unavailable", "failed", "missing"].includes(state)) return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-secondary text-muted-foreground";
}

export function AnalyticsStatusBadge({ state, label }: { state: AnalyticsState; label?: string }) {
  const normalized = state || "unknown";
  return <Badge variant="outline" className={stateClass(normalized)}>{label ?? stateLabel(normalized)}</Badge>;
}

export function AnalyticsFreshnessBadge({ freshness }: { freshness: AnalyticsFreshness }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
      <AnalyticsStatusBadge state={freshness.state} />
    </span>
  );
}

export function AnalyticsCoverageBadge({ coverage }: { coverage: AnalyticsCoverage }) {
  const points = coverage.expected_points === null
    ? `${coverage.included_points} points`
    : `${coverage.included_points}/${coverage.expected_points} points`;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Database className="h-3.5 w-3.5" aria-hidden="true" />
      <AnalyticsStatusBadge state={coverage.state} label={`${stateLabel(coverage.state)} · ${points}`} />
    </span>
  );
}

export function AnalyticsLoadingState({ label = "Loading analytics" }: { label?: string }) {
  return (
    <div role="status" className="space-y-3" aria-label={label}>
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-3 w-full max-w-md" />
    </div>
  );
}

export function AnalyticsEmptyState({ title = "No data", description }: { title?: string; description?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center">
      <Info className="mx-auto h-5 w-5 text-muted-foreground" aria-hidden="true" />
      <p className="mt-2 text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

export function AnalyticsErrorState({
  title = "Analytics unavailable",
  description = "The reporting request could not be completed.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-5 py-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-destructive">{title}</p>
          <p className="mt-1 text-sm text-destructive/80">{description}</p>
          {onRetry ? (
            <Button type="button" variant="outline" size="sm" className="mt-3 gap-1.5" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AnalyticsMetricCard({
  label,
  value,
  unit,
  state,
  description,
  footer,
}: {
  label: string;
  value: string;
  unit?: string;
  state?: AnalyticsState;
  description?: string;
  footer?: ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
          {state ? <AnalyticsStatusBadge state={state} /> : <CheckCircle2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
        </div>
        <div className="text-3xl font-semibold tracking-tight">{value}{unit ? <span className="ml-1 text-base font-normal text-muted-foreground">{unit}</span> : null}</div>
      </CardHeader>
      {description || footer ? <CardContent className="space-y-3 text-sm text-muted-foreground">{description ? <CardDescription>{description}</CardDescription> : null}{footer}</CardContent> : null}
    </Card>
  );
}
