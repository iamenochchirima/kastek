"use client";

import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import { ChartCard, ChartLegend, ChartState } from "@/components/admin/chart";
import { AdminMetric } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type RangeDays = 7 | 30 | 90 | 365;
export const ANALYTICS_RANGES: Array<{ days: RangeDays; label: string }> = [
  { days: 7, label: "7D" },
  { days: 30, label: "30D" },
  { days: 90, label: "90D" },
  { days: 365, label: "12M" },
];

export type TimePoint = { date: string; values: Record<string, number> };
export type ChartSeries = { key: string; label: string; color: 1 | 2 | 3 | 4 | 5 | 6 };

export function AnalyticsRangeToolbar({
  days,
  onChange,
  onRefresh,
  loading,
  dataAsOf,
  interval = "day",
}: {
  days: RangeDays;
  onChange: (days: RangeDays) => void;
  onRefresh: () => void;
  loading: boolean;
  dataAsOf?: string;
  interval?: string;
}) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-line bg-card p-1" aria-label="Analytics range">
        {ANALYTICS_RANGES.map((range) => (
          <button key={range.days} type="button" onClick={() => onChange(range.days)} aria-pressed={days === range.days} className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${days === range.days ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>
            {range.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span className="rounded-full border border-line px-2 py-1 uppercase tracking-[0.08em]">{interval}</span>
        {dataAsOf ? <span>Updated {formatDateTime(dataAsOf)} UTC</span> : null}
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
          Refresh
        </Button>
      </div>
    </div>
  );
}

export function AnalyticsMetric({ label, value, detail, tone = "default" }: { label: string; value: ReactNode; detail?: ReactNode; tone?: "default" | "attention" | "danger" | "success" | "info" }) {
  return <AdminMetric label={label} value={value} detail={detail} tone={tone} />;
}

export function AnalyticsChart({ title, description, children, action, className }: { title: string; description?: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return <ChartCard title={title} description={description} actions={action} className={className}>{children}</ChartCard>;
}

export function TimeBarChart({ points, series, valueFormatter = formatNumber, ariaLabel = "Activity by period", emptyTitle = "No activity recorded" }: { points: TimePoint[]; series: ChartSeries[]; valueFormatter?: (value: number) => string; ariaLabel?: string; emptyTitle?: string }) {
  if (!points.length || !points.some((point) => series.some((item) => (point.values[item.key] ?? 0) > 0))) return <ChartState kind="empty" title={emptyTitle} />;

  const width = 980;
  const height = 310;
  const left = 60;
  const right = 18;
  const top = 24;
  const bottom = 52;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(...points.flatMap((point) => series.map((item) => point.values[item.key] ?? 0)), 0);
  const scaleMax = niceMax(maxValue);
  const groupWidth = plotWidth / Math.max(points.length, 1);
  const barWidth = Math.max(3, Math.min(28, (groupWidth * 0.76) / series.length));
  const ticks = [scaleMax, scaleMax * 0.75, scaleMax * 0.5, scaleMax * 0.25, 0];
  const labelIndices = tickIndices(points.length);
  const y = (value: number) => top + plotHeight - (Math.max(0, value) / scaleMax) * plotHeight;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3"><ChartLegend series={series.map((item) => ({ id: item.key, label: item.label, color: item.color }))} /><span className="text-xs tabular-nums text-muted-foreground">Peak {valueFormatter(maxValue)}</span></div>
      <div className="overflow-x-auto rounded-md border border-line bg-background/50">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[286px] min-w-[680px] w-full" role="img" aria-label={ariaLabel}>
          {ticks.map((value, index) => <g key={`${value}-${index}`}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="var(--line)" strokeDasharray={value === 0 ? undefined : "3 5"} /><text x={left - 12} y={y(value) + 4} textAnchor="end" className="fill-muted-foreground" fontSize="11">{valueFormatter(value)}</text></g>)}
          {points.map((point, pointIndex) => series.map((item, seriesIndex) => {
            const value = Math.max(0, point.values[item.key] ?? 0);
            const barHeight = value > 0 ? Math.max(2, (value / scaleMax) * plotHeight) : 0;
            const x = left + pointIndex * groupWidth + (groupWidth - series.length * barWidth) / 2 + seriesIndex * barWidth;
            return <rect key={`${point.date}-${item.key}`} x={x} y={y(value)} width={Math.max(1, barWidth - 2)} height={barHeight} rx="3" fill={`var(--chart-${item.color})`} opacity={seriesIndex === 0 ? 0.96 : 0.72}><title>{`${formatPeriodLong(point.date)} · ${item.label}: ${valueFormatter(value)}`}</title></rect>;
          }))}
          {labelIndices.map((index) => <text key={index} x={left + index * groupWidth + groupWidth / 2} y={height - 17} textAnchor="middle" className="fill-muted-foreground" fontSize="11">{formatPeriod(points[index]?.date ?? "")}</text>)}
        </svg>
      </div>
      <p className="sr-only">{series.map((item) => `${item.label}: ${valueFormatter(points.reduce((sum, point) => sum + (point.values[item.key] ?? 0), 0))}`).join(". ")}</p>
    </div>
  );
}

export function BreakdownBars({ items, emptyTitle = "No records", valueFormatter = formatNumber, maxItems = 10 }: { items: Array<{ key?: string; label: string; value: number }>; emptyTitle?: string; valueFormatter?: (value: number) => string; maxItems?: number }) {
  const visible = items.slice(0, maxItems);
  if (!visible.length || !visible.some((item) => item.value > 0)) return <ChartState kind="empty" title={emptyTitle} />;
  const max = Math.max(...visible.map((item) => item.value), 1);
  return <div className="space-y-4">{visible.map((item, index) => <div key={item.key ?? item.label}><div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="min-w-0 truncate text-foreground">{item.label}</span><span className="shrink-0 font-medium tabular-nums text-muted-foreground">{valueFormatter(item.value)}</span></div><div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full transition-[width]" style={{ width: `${Math.max((item.value / max) * 100, item.value > 0 ? 3 : 0)}%`, backgroundColor: `var(--chart-${(index % 6) + 1})` }} /></div></div>)}</div>;
}

export function FunnelBars({ items, valueFormatter = formatNumber }: { items: Array<{ key?: string; label: string; value: number }>; valueFormatter?: (value: number) => string }) {
  return <BreakdownBars items={items} valueFormatter={valueFormatter} emptyTitle="No funnel data" maxItems={12} />;
}

export function CoveragePanel({ items }: { items: Array<{ key: string; label: string; status: string; detail: string }> }) {
  return <section className="v-card overflow-hidden"><div className="border-b border-line px-[var(--density-card-padding)] py-4"><div className="flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-foreground">Data coverage</h2><p className="mt-1 text-xs text-muted-foreground">Scope and freshness are shown with every reporting surface.</p></div><Badge variant="outline">Core</Badge></div></div><div className="grid gap-3 p-[var(--density-card-padding)] sm:grid-cols-2">{items.map((item) => <div key={item.key} className="rounded-md border border-line bg-background/45 p-3"><div className="flex items-start justify-between gap-3"><p className="text-sm font-medium text-foreground">{item.label}</p><StatusBadge value={item.status} /></div><p className="mt-2 text-xs leading-5 text-muted-foreground">{item.detail}</p></div>)}</div></section>;
}

export function DataStamp({ source, start, end, timezone = "UTC" }: { source: string; start?: string; end?: string; timezone?: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-xs text-muted-foreground"><span>Source: {source}</span>{start && end ? <span>{formatPeriodLong(start)} – {formatPeriodLong(end)} · {timezone}</span> : null}</div>;
}

export function monthlyPoints<T extends { date: string }>(points: T[], keys: string[]): TimePoint[] {
  const buckets = new Map<string, Record<string, number>>();
  for (const point of points) {
    const month = point.date.slice(0, 7);
    const current = buckets.get(month) ?? Object.fromEntries(keys.map((key) => [key, 0]));
    for (const key of keys) current[key] += numberValue((point as unknown as Record<string, unknown>)[key]);
    buckets.set(month, current);
  }
  return Array.from(buckets, ([date, values]) => ({ date, values }));
}

export function dailyPoints<T extends { date: string }>(points: T[], keys: string[]): TimePoint[] {
  return points.map((point) => ({ date: point.date, values: Object.fromEntries(keys.map((key) => [key, numberValue((point as unknown as Record<string, unknown>)[key])])) }));
}

export function displayPoints<T extends { date: string }>(points: T[], days: RangeDays, keys: string[]) {
  return days === 365 ? monthlyPoints(points, keys) : dailyPoints(points, keys);
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-ZA", { notation: Math.abs(value) >= 1000 ? "compact" : "standard", maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : 0 }).format(value);
}

export function formatCurrency(minor: number) {
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(minor / 100);
}

export function formatPercent(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(value % 1 === 0 ? 0 : 1) : "0"}%`;
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(value));
}

export function formatPeriod(value: string) {
  if (!value) return "";
  const date = new Date(`${value.length === 7 ? `${value}-01` : value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-ZA", { day: value.length === 7 ? undefined : "numeric", month: "short", timeZone: "UTC" }).format(date);
}

export function formatPeriodLong(value: string) {
  if (!value) return "";
  const date = new Date(`${value.length === 7 ? `${value}-01` : value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function niceMax(value: number) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

function tickIndices(length: number) {
  return Array.from(new Set([0, Math.floor((length - 1) / 4), Math.floor((length - 1) / 2), Math.floor(((length - 1) * 3) / 4), length - 1])).filter((index) => index >= 0 && index < length);
}
