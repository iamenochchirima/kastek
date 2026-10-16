"use client";

import Link from "next/link";
import { BarChart3, Building2, CreditCard, RefreshCw, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ChartCard, ChartLegend, ChartState } from "@/components/admin/chart";
import { AdminPageHeader, AdminSectionHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type RangeDays = 7 | 30 | 90 | 365;

type DailyPoint = {
  date: string;
  newOrganizations: number;
  newUsers: number;
  activeOrganizations: number;
  operations: number;
  failedOperations: number;
  revenueMinor: number;
  creditsConsumed: number;
};

type AnalyticsResponse = {
  range: { start: string; end: string; days: number; interval: string };
  timezone: string;
  source: string;
  dataAsOf: string;
  kpis: {
    totalOrganizations: number;
    newOrganizations: number;
    activeOrganizations: number;
    totalUsers: number;
    newUsers: number;
    activeUsers: number;
    activeSubscriptions: number;
    trials: number;
    pastDueSubscriptions: number;
    collectedRevenueMinor: number;
    monthlyRecurringRevenueMinor: number;
    failedPayments: number;
    operations: number;
    failedOperations: number;
    creditsConsumed: number;
  };
  daily: DailyPoint[];
  productMix: Array<{ key: string; label: string; value: number }>;
  planMix: Array<{ product: string; plan: string; subscriptions: number }>;
  topOrganizations: Array<{ id: string; name: string; plan: string | null; operations: number; activeDays: number }>;
};

const ranges: Array<{ days: RangeDays; label: string }> = [
  { days: 7, label: "7D" },
  { days: 30, label: "30D" },
  { days: 90, label: "90D" },
  { days: 365, label: "12M" },
];

export function AdminAnalyticsOverview() {
  const [rangeDays, setRangeDays] = useState<RangeDays>(30);
  const [report, setReport] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (days: RangeDays) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/analytics/overview?days=${days}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Analytics are unavailable");
      setReport(data as AnalyticsResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Analytics are unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(rangeDays); }, [load, rangeDays]);

  return (
    <>
      <AdminPageHeader
        eyebrow="Platform"
        title="Analytics"
        description="Growth, product usage, customers, and revenue across KasiTek."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load(rangeDays)} disabled={loading}>
            <RefreshCw className={loading ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
            Refresh
          </Button>
        }
      />

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 rounded-md border border-line bg-card p-1" aria-label="Analytics range">
          {ranges.map((range) => (
            <button
              key={range.days}
              type="button"
              onClick={() => setRangeDays(range.days)}
              aria-pressed={rangeDays === range.days}
              className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${rangeDays === range.days ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}
            >
              {range.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {report ? <><span>UTC</span><span aria-hidden="true">·</span><span>Data as of {formatDateTime(report.dataAsOf)}</span></> : <span>Loading reporting data</span>}
        </div>
      </div>

      {loading ? <AnalyticsSkeleton /> : error ? <ChartState kind="error" title="Analytics unavailable" description={error} action={<Button variant="outline" size="sm" onClick={() => void load(rangeDays)}>Try again</Button>} /> : report ? <AnalyticsContent report={report} /> : <ChartState kind="empty" title="No analytics data" />}
    </>
  );
}

function AnalyticsContent({ report }: { report: AnalyticsResponse }) {
  const { kpis } = report;
  const hasGrowth = report.daily.some((point) => point.newOrganizations > 0 || point.newUsers > 0);
  const hasUsage = report.daily.some((point) => point.operations > 0 || point.failedOperations > 0);

  return (
    <div className="mt-5 space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Platform metrics">
        <MetricCard icon={Building2} label="Organizations" value={formatNumber(kpis.totalOrganizations)} detail={`${formatNumber(kpis.newOrganizations)} new in period`} />
        <MetricCard icon={Users} label="Active organizations" value={formatNumber(kpis.activeOrganizations)} detail={`${formatNumber(kpis.activeUsers)} active owners`} tone="info" />
        <MetricCard icon={CreditCard} label="Collected revenue" value={formatCurrency(kpis.collectedRevenueMinor)} detail={`${formatCurrency(kpis.monthlyRecurringRevenueMinor)} MRR`} tone="success" />
        <MetricCard icon={BarChart3} label="Operations" value={formatNumber(kpis.operations)} detail={`${formatNumber(kpis.failedOperations)} failed`} tone={kpis.failedOperations > 0 ? "attention" : "default"} />
        <MetricCard icon={CreditCard} label="Subscriptions" value={formatNumber(kpis.activeSubscriptions)} detail={`${formatNumber(kpis.trials)} trials · ${formatNumber(kpis.pastDueSubscriptions)} past due`} />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <ChartCard title="Platform growth" description="New organizations and users by day." actions={<Badge variant="outline">{report.range.days === 365 ? "12 months" : `${report.range.days} days`}</Badge>}>
          {hasGrowth ? <GroupedBarChart points={report.daily} series={[{ key: "newOrganizations", label: "Organizations", color: 1 }, { key: "newUsers", label: "Users", color: 2 }]} valueLabel="new" /> : <ChartState kind="empty" title="No growth recorded" description="There are no new organizations or users in this period." />}
        </ChartCard>
        <ChartCard title="Daily activity" description="Recorded product operations by day." actions={<Link className="text-xs font-medium text-primary hover:underline" href="/operations">Operations</Link>}>
          {hasUsage ? <GroupedBarChart points={report.daily} series={[{ key: "operations", label: "Operations", color: 3 }, { key: "failedOperations", label: "Failures", color: 6 }]} valueLabel="operations" /> : <ChartState kind="empty" title="No operations recorded" description="No product usage events were recorded in this period." />}
        </ChartCard>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <BreakdownCard title="Activity by product" description="Usage events attributed to each product." items={report.productMix.map((item) => ({ label: item.label, value: item.value }))} emptyTitle="No product activity" />
        <PlanMixCard report={report} />
      </section>

      <section className="v-card overflow-hidden">
        <div className="border-b border-line px-[var(--density-card-padding)] py-4">
          <AdminSectionHeader title="Most active organizations" description="Ranked by recorded operations in the selected period." actions={<Link href="/agencies" className="text-xs font-medium text-primary hover:underline">View organizations</Link>} />
        </div>
        {report.topOrganizations.length === 0 ? <ChartState kind="empty" title="No organization activity" description="No organizations have recorded product operations in this period." /> : <div className="overflow-x-auto"><table className="w-full min-w-[600px] text-left text-sm"><thead className="border-b border-line text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Organization</th><th className="px-5 py-3 font-medium">Plan</th><th className="px-5 py-3 text-right font-medium">Operations</th><th className="px-5 py-3 text-right font-medium">Active days</th></tr></thead><tbody className="divide-y divide-line">{report.topOrganizations.map((organization, index) => <tr key={organization.id} className="transition-colors hover:bg-secondary"><td className="px-5 py-3"><Link href={`/agencies/${organization.id}`} className="flex items-center gap-3 font-medium text-foreground hover:text-primary"><span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-xs text-primary">{index + 1}</span>{organization.name}</Link></td><td className="px-5 py-3 text-xs text-muted-foreground">{organization.plan ?? "No active plan"}</td><td className="px-5 py-3 text-right font-medium tabular-nums text-foreground">{formatNumber(organization.operations)}</td><td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{formatNumber(organization.activeDays)}</td></tr>)}</tbody></table></div>}
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-xs text-muted-foreground">
        <span>Source: Core authoritative records</span>
        <span>Daily buckets · {report.timezone} · {formatDate(report.range.start)} – {formatDate(report.range.end)}</span>
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, detail, tone = "default" }: { icon: typeof Building2; label: string; value: string; detail: string; tone?: "default" | "info" | "success" | "attention" }) {
  const styles = { default: "v-card", info: "border-status-info/25 bg-status-info-soft", success: "border-status-success/25 bg-status-success-soft", attention: "border-status-attention/25 bg-status-attention-soft" };
  return <article className={`rounded-[calc(var(--radius)-1px)] border p-[var(--density-card-padding)] shadow-card ${styles[tone]}`}><div className="flex items-start justify-between gap-3"><p className="v-label">{label}</p><Icon className="size-4 text-muted-foreground" aria-hidden="true" /></div><p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-foreground">{value}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></article>;
}

type Series = { key: keyof DailyPoint; label: string; color: 1 | 2 | 3 | 4 | 5 | 6 };

function GroupedBarChart({ points, series, valueLabel }: { points: DailyPoint[]; series: Series[]; valueLabel: string }) {
  const width = 960;
  const height = 300;
  const left = 54;
  const right = 16;
  const top = 22;
  const bottom = 48;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(...points.flatMap((point) => series.map((item) => numberValue(point[item.key]))), 0);
  const scaleMax = niceMax(maxValue);
  const groupWidth = plotWidth / Math.max(points.length, 1);
  const barWidth = Math.max(3, Math.min(24, (groupWidth * 0.72) / series.length));
  const tickValues = [scaleMax, scaleMax / 2, 0];
  const labelIndices = useMemo(() => tickIndices(points.length), [points.length]);
  const y = (value: number) => top + plotHeight - (value / scaleMax) * plotHeight;

  return <div className="space-y-3"><ChartLegend series={series.map((item) => ({ id: String(item.key), label: item.label, color: item.color }))} /><div className="overflow-hidden rounded-md border border-line bg-background/50"><svg viewBox={`0 0 ${width} ${height}`} className="h-[260px] w-full min-w-[620px]" role="img" aria-label={`${valueLabel} by day`} preserveAspectRatio="none">
    {tickValues.map((value) => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="var(--line)" strokeDasharray={value === 0 ? undefined : "3 5"} /><text x={left - 10} y={y(value) + 4} textAnchor="end" className="fill-muted-foreground" fontSize="11">{formatNumber(value)}</text></g>)}
    {points.map((point, pointIndex) => series.map((item, seriesIndex) => { const value = numberValue(point[item.key]); const barHeight = value === 0 ? 0 : Math.max(2, (value / scaleMax) * plotHeight); const x = left + pointIndex * groupWidth + (groupWidth - series.length * barWidth) / 2 + seriesIndex * barWidth; return <rect key={`${point.date}-${String(item.key)}`} x={x} y={y(value)} width={Math.max(1, barWidth - 2)} height={barHeight} rx="2" fill={`var(--chart-${item.color})`} opacity={seriesIndex === 1 ? 0.7 : 0.95}><title>{`${formatLongDate(point.date)} · ${item.label}: ${formatNumber(value)}`}</title></rect>; }))}
    {labelIndices.map((index) => <text key={index} x={left + index * groupWidth + groupWidth / 2} y={height - 16} textAnchor="middle" className="fill-muted-foreground" fontSize="11">{formatShortDate(points[index]?.date ?? "")}</text>)}
  </svg></div><p className="sr-only">{series.map((item) => `${item.label}: ${formatNumber(points.reduce((sum, point) => sum + numberValue(point[item.key]), 0))}`).join(". ")}</p></div>;
}

function BreakdownCard({ title, description, items, emptyTitle }: { title: string; description: string; items: Array<{ label: string; value: number }>; emptyTitle: string }) {
  const max = Math.max(...items.map((item) => item.value), 1);
  return <Card><CardHeader className="border-b border-line"><div><CardTitle>{title}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{description}</p></div></CardHeader><CardContent>{items.length === 0 ? <ChartState kind="empty" title={emptyTitle} /> : <div className="space-y-4">{items.map((item, index) => <div key={item.label}><div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="text-foreground">{item.label}</span><span className="font-medium tabular-nums text-muted-foreground">{formatNumber(item.value)}</span></div><div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full" style={{ width: `${Math.max((item.value / max) * 100, item.value > 0 ? 3 : 0)}%`, backgroundColor: `var(--chart-${(index % 5) + 1})` }} /></div></div>)}</div>}</CardContent></Card>;
}

function PlanMixCard({ report }: { report: AnalyticsResponse }) {
  return <Card><CardHeader className="border-b border-line"><div><CardTitle>Plan mix</CardTitle><p className="mt-1 text-xs text-muted-foreground">Current trial and paid subscription distribution.</p></div><Link href="/billing" className="text-xs font-medium text-primary hover:underline">Billing</Link></CardHeader><CardContent>{report.planMix.length === 0 ? <ChartState kind="empty" title="No subscriptions" /> : <div className="divide-y divide-line">{report.planMix.map((item) => <div key={`${item.product}-${item.plan}`} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{item.plan}</p><p className="truncate text-xs text-muted-foreground">{item.product}</p></div><span className="text-sm font-semibold tabular-nums text-foreground">{formatNumber(item.subscriptions)}</span></div>)}</div>}</CardContent></Card>;
}

function AnalyticsSkeleton() {
  return <div className="mt-5 space-y-5" role="status" aria-label="Loading analytics"><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{Array.from({ length: 5 }, (_, index) => <div key={index} className="h-32 animate-pulse rounded-[calc(var(--radius)-1px)] bg-secondary" />)}</div><div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]"><div className="h-[390px] animate-pulse rounded-[calc(var(--radius)-1px)] bg-secondary" /><div className="h-[390px] animate-pulse rounded-[calc(var(--radius)-1px)] bg-secondary" /></div></div>;
}

function numberValue(value: DailyPoint[keyof DailyPoint]) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function niceMax(value: number) { if (value <= 0) return 1; const magnitude = 10 ** Math.floor(Math.log10(value)); const normalized = value / magnitude; const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10; return step * magnitude; }
function tickIndices(length: number) { return Array.from(new Set([0, Math.floor((length - 1) / 4), Math.floor((length - 1) / 2), Math.floor(((length - 1) * 3) / 4), length - 1])).filter((index) => index >= 0 && index < length); }
function formatNumber(value: number) { return new Intl.NumberFormat("en-ZA", { notation: value >= 1000 ? "compact" : "standard", maximumFractionDigits: value >= 1000 ? 1 : 0 }).format(value); }
function formatCurrency(minor: number) { return new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 0 }).format(minor / 100); }
function formatDate(value: string) { return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(value)); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(value)); }
function formatShortDate(value: string) { return value ? new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)) : ""; }
function formatLongDate(value: string) { return value ? new Intl.DateTimeFormat("en-ZA", { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)) : ""; }
