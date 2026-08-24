import type { AnalyticsMetricResult, AnalyticsReportPoint } from "@/lib/analytics";
import { AnalyticsCoverageBadge, AnalyticsEmptyState, AnalyticsFreshnessBadge } from "@/components/analytics/analytics-feedback";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

function formatValue(value: number | null) {
  return value === null ? "—" : value.toLocaleString();
}

export function AnalyticsTrendChart({
  points,
  label,
  className = "",
}: {
  points: AnalyticsReportPoint[];
  label: string;
  className?: string;
}) {
  const values = points.map((point) => point.value).filter((value): value is number => value !== null && Number.isFinite(value));
  if (!values.length) return <AnalyticsEmptyState title="No points" />;

  const width = 360;
  const height = 120;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const coordinates = points
    .map((point, index) => {
      if (point.value === null || !Number.isFinite(point.value)) return null;
      const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
      const y = height - ((point.value - min) / range) * (height - 12) - 6;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter((coordinate): coordinate is string => coordinate !== null)
    .join(" ");

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-32 w-full overflow-visible" role="img" aria-label={label}>
        <line x1="0" y1={height - 6} x2={width} y2={height - 6} className="stroke-border" strokeWidth="1" />
        <polyline points={coordinates} fill="none" className="stroke-primary" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatValue(min)}</span>
        <span>{formatValue(max)}</span>
      </div>
    </div>
  );
}

export function AnalyticsMetricSeriesTable({ metric }: { metric: AnalyticsMetricResult }) {
  if (!metric.series.length) return <AnalyticsEmptyState title="No points" />;
  const hasDenominator = metric.series.some((point) => point.denominator !== null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <AnalyticsFreshnessBadge freshness={metric.freshness} />
        <AnalyticsCoverageBadge coverage={metric.coverage} />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Period</TableHead>
            <TableHead className="text-right">Value</TableHead>
            {hasDenominator ? <TableHead className="text-right">Denominator</TableHead> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {metric.series.map((point) => (
            <TableRow key={`${point.bucket_start}-${point.bucket_end}`}>
              <TableCell>{new Date(point.bucket_start).toLocaleDateString()}</TableCell>
              <TableCell className="text-right font-medium">{formatValue(point.value)}{metric.unit ? ` ${metric.unit}` : ""}</TableCell>
              {hasDenominator ? <TableCell className="text-right">{formatValue(point.denominator)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
