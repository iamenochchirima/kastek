"use client";

import { Badge } from "@/components/ui/badge";
import type { BillingCredits, BillingUsage, BillingUsageDay, MeterUsage } from "@/lib/billing";
import { fetchBillingUsage } from "@/lib/billing-client";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { Activity, BarChart3, Coins, RefreshCw, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

type UsageRange = "7d" | "30d" | "90d";

const RANGE_OPTIONS: Array<{ value: UsageRange; label: string }> = [
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "90d", label: "90D" },
];

function rangeLabel(range: UsageRange) {
  return range === "7d" ? "Last 7 days" : range === "90d" ? "Last 90 days" : "Last 30 days";
}

function formatDate(value: string | null, dateStyle: "short" | "medium" = "medium") {
  if (!value) return "—";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString("en-ZA", { dateStyle });
}

function formatChartDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T12:00:00`) : new Date(value);
  return date.toLocaleDateString("en-ZA", { day: "numeric", month: "short" });
}

function formatAction(key: string) {
  return key
    .replace(/^ai\./, "")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function progressValue(meter: MeterUsage) {
  if (meter.limit === null || meter.limit <= 0) return 0;
  return Math.min(100, Math.round((meter.used / meter.limit) * 100));
}

function UsageChart({ data }: { data: BillingUsage }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const width = 760;
  const height = 260;
  const left = 48;
  const right = 12;
  const top = 18;
  const bottom = 38;
  const chartHeight = height - top - bottom;
  const metric = data.operations > 0 ? "operations" : data.credits.used > 0 ? "credits" : null;
  const valueForMetric = (day: BillingUsageDay) => metric === "credits" ? day.creditsUsed : day.operations;
  const values = data.daily.map(valueForMetric);
  const max = Math.max(...values, 0);
  const plotWidth = width - left - right;
  const slotWidth = plotWidth / Math.max(data.daily.length, 1);
  const barWidth = Math.min(24, slotWidth * 0.62);
  const points = data.daily.map((day, index) => ({
    day,
    value: valueForMetric(day),
    x: left + (index * slotWidth) + (slotWidth / 2),
    barX: left + (index * slotWidth) + ((slotWidth - barWidth) / 2),
    barY: top + chartHeight - (valueForMetric(day) / Math.max(max, 1)) * chartHeight,
    barHeight: (valueForMetric(day) / Math.max(max, 1)) * chartHeight,
  }));
  const labelCount = Math.min(data.daily.length, data.daily.length >= 30 ? 8 : 7);
  const labelIndexes = labelCount <= 1
    ? [0]
    : Array.from({ length: labelCount }, (_, index) => Math.round((index * (data.daily.length - 1)) / (labelCount - 1)));

  if (!metric || max === 0) {
    return (
      <div className="mt-5 flex min-h-[260px] items-center justify-center rounded-xl border border-dashed border-border bg-background/40 px-6 text-center">
        <div>
          <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-secondary text-muted-foreground"><Activity className="size-4" /></div>
          <p className="mt-3 text-sm font-medium text-foreground">No activity in this period</p>
          <p className="mt-1 text-xs text-muted-foreground">Usage will appear after workspace actions are recorded.</p>
        </div>
      </div>
    );
  }

  const tickValues = max <= 1 ? [1, 0] : [max, Math.ceil(max / 2), 0];
  const activePoint = activeIndex === null ? null : points[activeIndex];

  return (
    <div className="relative mt-5 overflow-hidden rounded-xl border border-border bg-background/40 p-3 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2"><span className="size-2 rounded-full bg-[var(--chart-1)]" />{metric === "operations" ? "Workspace operations" : "AI credits"}</span>
        <span className="ml-auto font-medium text-foreground">{max.toLocaleString()} peak</span>
      </div>
      <svg className="h-auto w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${data.granularity === "day" ? "Daily" : "Weekly"} ${metric === "operations" ? "workspace operations" : "AI credits"}`}>
        {tickValues.map((value, index) => {
          const y = top + (index / Math.max(tickValues.length - 1, 1)) * chartHeight;
          return <g key={`${value}-${index}`}><line x1={left} x2={width - right} y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 5" /><text x={left - 10} y={y + 4} fill="var(--muted-foreground)" fontSize="11" textAnchor="end">{value.toLocaleString()}</text></g>;
        })}
        {activePoint ? <line x1={activePoint.x} x2={activePoint.x} y1={top} y2={top + chartHeight} stroke="var(--chart-1)" strokeDasharray="3 4" strokeOpacity="0.6" /> : null}
        {points.map((point, index) => point.value > 0 ? <rect key={point.day.date} x={point.barX} y={point.barY} width={barWidth} height={point.barHeight} rx="4" fill="var(--chart-1)" fillOpacity={activeIndex === index ? "1" : "0.9"} /> : null)}
        {points.map((point, index) => <rect key={`hit-${point.day.date}`} x={left + (index * slotWidth)} y={top} width={slotWidth} height={chartHeight} fill="transparent" onMouseEnter={() => setActiveIndex(index)} onMouseLeave={() => setActiveIndex(null)} />)}
        {labelIndexes.map((index) => {
          const point = points[index];
          return point ? <text key={point.day.date} x={point.x} y={height - 8} fill="var(--muted-foreground)" fontSize="11" textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"}>{formatChartDate(point.day.date)}</text> : null;
        })}
      </svg>
      {activePoint ? <div className="pointer-events-none absolute top-14 z-10 min-w-[150px] -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg" style={{ left: `${(activePoint.x / width) * 100}%` }}><p className="font-medium text-foreground">{formatDate(activePoint.day.date)}</p><p className="mt-1 text-muted-foreground">{activePoint.day.operations.toLocaleString()} operations</p><p className="text-muted-foreground">{activePoint.day.creditsUsed.toLocaleString()} credits</p></div> : null}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, detail }: { icon: LucideIcon; label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-panel)]">
      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Icon className="size-3.5 text-primary" />{label}</div>
      <p className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function UsageMeter({ meter }: { meter: MeterUsage }) {
  const percent = progressValue(meter);
  const approachingLimit = meter.limit !== null && percent >= 80;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{meter.name}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{meter.description}</p>
        </div>
        {approachingLimit ? <Badge variant="outline" className="shrink-0 border-status-attention/40 text-status-attention">Near limit</Badge> : null}
      </div>
      <div className="mt-4 flex items-baseline justify-between gap-3">
        <p className="text-lg font-semibold text-foreground">{meter.used.toLocaleString()}</p>
        <p className="text-xs text-muted-foreground">{meter.limit === null ? "Tracked" : `${meter.limit.toLocaleString()} limit`}</p>
      </div>
      {meter.limit !== null ? <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary"><div className={approachingLimit ? "h-full rounded-full bg-status-attention" : "h-full rounded-full bg-primary"} style={{ width: `${percent}%` }} /></div> : null}
    </div>
  );
}

export function UsagePanel({
  usage,
  credits,
  embedded = false,
}: {
  usage: BillingUsage | null;
  credits: BillingCredits | null;
  embedded?: boolean;
}) {
  const [range, setRange] = useState<UsageRange>("30d");
  const [fetchedData, setFetchedData] = useState<BillingUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(usage ? null : "Usage information is unavailable right now.");
  const data = range === "30d" ? usage ?? fetchedData : fetchedData;

  useEffect(() => {
    if (range === "30d" && usage) return;
    let active = true;
    void fetchBillingUsage(range)
      .then((nextData) => {
        if (active) {
          setFetchedData(nextData);
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError("Usage information is unavailable right now.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [range, usage]);

  function selectRange(nextRange: UsageRange) {
    setRange(nextRange);
    if (nextRange !== "30d" || !usage) {
      setLoading(true);
      setError(null);
    }
  }

  const averageDaily = useMemo(() => {
    if (!data?.daily.length) return 0;
    const total = data.operations > 0 ? data.operations : data.credits.used;
    return Math.round(total / data.daily.length);
  }, [data]);
  const breakdownMax = Math.max(...(data?.breakdown.map((item) => item.creditsUsed) ?? []), 1);
  const chartUsesOperations = Boolean(data && (data.operations > 0 || data.previousDaily.some((day) => day.operations > 0)));
  const peakDay = useMemo(() => {
    if (!data?.daily.length) return null;
    return data.daily.reduce((peak, day) => {
      const peakValue = chartUsesOperations ? peak.operations : peak.creditsUsed;
      const dayValue = chartUsesOperations ? day.operations : day.creditsUsed;
      return dayValue > peakValue ? day : peak;
    }, data.daily[0]);
  }, [chartUsesOperations, data]);
  const peakValue = peakDay ? chartUsesOperations ? peakDay.operations : peakDay.creditsUsed : 0;

  return (
    <div className={embedded ? "space-y-5" : "min-h-[100dvh] p-4 sm:p-6"}>
      <div className={embedded ? "space-y-5" : "mx-auto max-w-[1080px] space-y-6"}>
        {!embedded ? (
          <PageHeader>
            <PageHeaderContent>
              <PageHeaderTitle>Usage</PageHeaderTitle>
              <PageHeaderDescription>Credits and workspace activity.</PageHeaderDescription>
            </PageHeaderContent>
          </PageHeader>
        ) : null}

        <div>
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">Activity</p>
            <h2 className="mt-1 text-xl font-semibold tracking-[-0.03em] text-foreground">Usage overview</h2>
            <p className="mt-1 text-sm text-muted-foreground">Workspace activity, credits, and limits.</p>
          </div>
        </div>

        {error ? <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{error}</div> : null}
        {data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard icon={Coins} label="Credits used" value={data.credits.used.toLocaleString()} detail={`in the last ${range.replace("d", " days")}`} />
              <MetricCard icon={BarChart3} label="Available credits" value={data.credits.available.toLocaleString()} detail={`${data.credits.reserved.toLocaleString()} reserved`} />
              <MetricCard icon={Activity} label="Operations" value={data.operations.toLocaleString()} detail="Recorded workspace activity" />
              <MetricCard icon={RefreshCw} label="Daily average" value={averageDaily.toLocaleString()} detail={data.operations > 0 ? "Operations per period day" : "Credits per period day"} />
            </div>

            <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
              <div className="flex flex-col gap-4 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div><h2 className="text-base font-semibold text-foreground">Daily activity</h2><p className="mt-1 text-sm text-muted-foreground">{data.granularity === "day" ? "Daily" : "Weekly"} · {rangeLabel(range)} · {formatDate(data.rangeStart, "short")} – {formatDate(data.rangeEnd, "short")}</p></div>
                <div className="flex items-center gap-3 self-start sm:self-auto"><span className="hidden text-xs text-muted-foreground sm:inline">{data.timezone}</span><div className="flex rounded-lg border border-border bg-background/60 p-1" role="group" aria-label="Usage period">{RANGE_OPTIONS.map((option) => <button key={option.value} type="button" onClick={() => selectRange(option.value)} className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${range === option.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`} aria-pressed={range === option.value}>{option.label}</button>)}</div></div>
              </div>
              {loading ? <p className="mt-3 text-xs text-muted-foreground">Updating…</p> : null}
              <UsageChart data={data} />
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
                <span>Operations <strong className="ml-1 font-semibold text-foreground">{data.operations.toLocaleString()}</strong></span>
                <span>Credits used <strong className="ml-1 font-semibold text-foreground">{data.credits.used.toLocaleString()}</strong></span>
                <span>Peak day <strong className="ml-1 font-semibold text-foreground">{peakDay ? `${formatDate(peakDay.date, "short")} · ${peakValue.toLocaleString()} ${chartUsesOperations ? "operations" : "credits"}` : "—"}</strong></span>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
              <div><h2 className="text-base font-semibold text-foreground">Usage limits</h2><p className="mt-1 text-sm text-muted-foreground">Tracked workspace activity for the current cycle.</p></div>
              <div className="mt-5 grid gap-3 md:grid-cols-2">{data.meters.map((meter) => <UsageMeter key={meter.key} meter={meter} />)}</div>
            </section>

            <div className="grid gap-5 lg:grid-cols-[1.05fr_0.95fr]">
              <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
                <h2 className="text-base font-semibold text-foreground">Credit usage</h2>
                <div className="mt-5 space-y-4">
                  {data.breakdown.length ? data.breakdown.map((item) => (
                    <div key={item.key}>
                      <div className="flex items-center justify-between gap-4 text-sm"><span className="font-medium text-foreground">{formatAction(item.key)}</span><span className="text-muted-foreground">{item.creditsUsed.toLocaleString()}</span></div>
                      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary/80" style={{ width: `${Math.max(3, (item.creditsUsed / breakdownMax) * 100)}%` }} /></div>
                      <p className="mt-1 text-xs text-muted-foreground">{item.operations.toLocaleString()} operations</p>
                    </div>
                  )) : <p className="text-sm text-muted-foreground">No credit usage in this period</p>}
                </div>
              </section>

              <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
                <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold text-foreground">Credit grants</h2><span className="text-xs text-muted-foreground">{credits?.account.availableBalance.toLocaleString() ?? data.credits.available.toLocaleString()} available</span></div>
                <div className="mt-4 divide-y divide-border">
                  {credits?.account.grants.length ? credits.account.grants.slice(0, 5).map((grant) => (
                    <div key={grant.id} className="flex items-center justify-between gap-3 py-3 text-sm"><div><p className="font-medium text-foreground">{formatAction(grant.source)}</p><p className="mt-1 text-xs text-muted-foreground">{grant.remainingAmount.toLocaleString()} remaining</p></div><span className="text-right text-xs text-muted-foreground">{grant.endsAt ? `Expires ${formatDate(grant.endsAt, "short")}` : "No expiry"}</span></div>
                  )) : <p className="py-3 text-sm text-muted-foreground">No active grants</p>}
                </div>
              </section>
            </div>

            <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
              <h2 className="text-base font-semibold text-foreground">Recent activity</h2>
              {data.recent.length ? (
                <div className="mt-4 divide-y divide-border">
                  {data.recent.slice(0, 10).map((event) => <div key={event.id} className="flex flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-foreground">{formatAction(event.actionKey)}</p><p className="mt-1 text-xs text-muted-foreground">{event.model ?? event.provider ?? "Workspace action"} · {formatDate(event.createdAt, "short")}</p></div><span className="font-medium text-foreground">−{event.creditsCharged.toLocaleString()}</span></div>)}
                </div>
              ) : <p className="mt-4 text-sm text-muted-foreground">No usage recorded</p>}
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
