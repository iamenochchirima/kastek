import { isObservedAnalyticsValue, observedAnalyticsPoints, type AnalyticsMetricResult, type AnalyticsReportPoint } from "@/lib/analytics";
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
  const values = points.map((point) => point.value).filter(isObservedAnalyticsValue);
  if (!values.length) return <AnalyticsEmptyState title="No activity yet" />;

  const width = 360;
  const height = 148;
  const plotLeft = 28;
  const plotRight = width - 4;
  const plotTop = 12;
  const plotBottom = height - 22;
  const min = Math.min(0, ...values);
  const max = Math.max(1, ...values);
  const range = max - min || 1;
  const segments: string[][] = [];
  let segment: string[] = [];
  points.forEach((point, index) => {
    if (!isObservedAnalyticsValue(point.value)) {
      if (segment.length) segments.push(segment);
      segment = [];
      return;
    }
    const x = points.length === 1 ? (plotLeft + plotRight) / 2 : plotLeft + (index / (points.length - 1)) * (plotRight - plotLeft);
    const y = plotBottom - ((point.value - min) / range) * (plotBottom - plotTop);
    segment.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  });
  if (segment.length) segments.push(segment);
  const yFor = (value: number) => plotBottom - ((value - min) / range) * (plotBottom - plotTop);

  return (
    <div className={className}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-36 w-full overflow-visible" role="img" aria-label={label}>
        {[max, max / 2, 0].map((value) => <g key={value}><line x1={plotLeft} y1={yFor(value)} x2={plotRight} y2={yFor(value)} className="stroke-border" strokeWidth="1" strokeDasharray={value === 0 ? undefined : "3 5"} /><text x="0" y={yFor(value) + 3} className="fill-muted-foreground" fontSize="10">{formatValue(value)}</text></g>)}
        {segments.map((coordinates, index) => <polyline key={index} points={coordinates.join(" ")} fill="none" className="stroke-primary" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />)}
      </svg>
      <div className="flex justify-between pl-7 text-[11px] text-muted-foreground">
        <span>30 days ago</span>
        <span>Today</span>
      </div>
    </div>
  );
}

export function AnalyticsMetricSeriesTable({ metric, timezone }: { metric: AnalyticsMetricResult; timezone?: string }) {
  const observedPoints = observedAnalyticsPoints(metric);
  if (!observedPoints.length) return <AnalyticsEmptyState title="No activity yet" />;
  const hasDenominator = observedPoints.some((point) => point.denominator !== null);

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
          {observedPoints.map((point) => (
            <TableRow key={`${point.bucket_start}-${point.bucket_end}`}>
              <TableCell>{formatPointDate(point.bucket_start, timezone)}</TableCell>
              <TableCell className="text-right font-medium">{formatValue(point.value)}{metric.unit ? ` ${metric.unit}` : ""}</TableCell>
              {hasDenominator ? <TableCell className="text-right">{formatValue(point.denominator)}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function formatPointDate(value: string, timezone?: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, timezone ? { timeZone: timezone } : undefined);
}
