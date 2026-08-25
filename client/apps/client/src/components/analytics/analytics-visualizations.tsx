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
  const width = 360;
  const height = 148;
  const plotLeft = 28;
  const plotRight = width - 4;
  const plotTop = 12;
  const plotBottom = height - 22;
  const hasData = values.length > 0;
  const min = hasData ? Math.min(0, ...values) : 0;
  const max = hasData ? Math.max(1, ...values) : 1;
  const range = max - min || 1;
  const coordinates = points
    .map((point, index) => {
      if (point.value === null || !Number.isFinite(point.value)) return null;
      const x = points.length === 1 ? (plotLeft + plotRight) / 2 : plotLeft + (index / (points.length - 1)) * (plotRight - plotLeft);
      const y = plotBottom - ((point.value - min) / range) * (plotBottom - plotTop);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .filter((coordinate): coordinate is string => coordinate !== null)
    .join(" ");
  const yFor = (value: number) => plotBottom - ((value - min) / range) * (plotBottom - plotTop);

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full overflow-visible" role="img" aria-label={label}>
        {[max, max / 2, 0].map((value) => <g key={value}><line x1={plotLeft} y1={yFor(value)} x2={plotRight} y2={yFor(value)} className="stroke-border" strokeWidth="1" strokeDasharray={value === 0 ? undefined : "3 5"} /><text x="0" y={yFor(value) + 3} className="fill-muted-foreground" fontSize="10">{formatValue(value)}</text></g>)}
        {hasData ? <polyline points={coordinates} fill="none" className="stroke-primary" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /> : <line x1={plotLeft} y1={yFor(0)} x2={plotRight} y2={yFor(0)} className="stroke-muted-foreground" strokeWidth="2" strokeDasharray="4 6" />}
      </svg>
      <div className="flex justify-between pl-7 text-[11px] text-muted-foreground">
        <span>30 days ago</span>
        <span>{hasData ? "Today" : "No activity yet"}</span>
      </div>
    </div>
  );
}

export function AnalyticsMetricSeriesTable({ metric, timezone }: { metric: AnalyticsMetricResult; timezone?: string }) {
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
              <TableCell>{new Date(point.bucket_start).toLocaleDateString(undefined, timezone ? { timeZone: timezone } : undefined)}</TableCell>
              <TableCell className="text-right font-medium">{formatValue(point.value)}{metric.unit ? ` ${metric.unit}` : ""}</TableCell>
              {hasDenominator ? <TableCell className="text-right">{formatValue(point.denominator)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
