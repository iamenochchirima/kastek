"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ChartState } from "@/components/admin/chart";
import { AdminLoadingState } from "@/components/admin/page-states";
import {
  AnalyticsChart, AnalyticsMetric, AnalyticsRangeToolbar, BreakdownBars, CoveragePanel, DataStamp,
  displayPoints, formatCurrency, formatNumber, RangeDays, TimeBarChart,
} from "@/components/admin/admin-analytics-shared";

type RevenueReport = {
  range: { start: string; end: string; days: number; interval: string };
  source: string;
  timezone: string;
  dataAsOf: string;
  coverage: Array<{ key: string; label: string; status: string; detail: string }>;
  kpis: { collectedRevenueMinor: number; refundsMinor: number; monthlyRecurringRevenueMinor: number; paidInvoices: number; failedPayments: number; activeSubscriptions: number; trials: number; pastDueSubscriptions: number; newSubscriptions: number; cancellations: number };
  daily: Array<{ date: string; collectedRevenueMinor: number; refundsMinor: number; paidInvoices: number; failedPayments: number; newSubscriptions: number; cancellations: number }>;
  planMix: Array<{ product: string; plan: string; subscriptions: number }>;
  paymentOutcomes: Array<{ key: string; label: string; value: number }>;
  invoiceStatus: Array<{ key: string; label: string; value: number }>;
  subscriptionStatus: Array<{ key: string; label: string; value: number }>;
  creditLifecycle: Array<{ kind: string; amount: number }>;
};

export function AdminRevenueAnalytics() {
  const [days, setDays] = useState<RangeDays>(30);
  const [report, setReport] = useState<RevenueReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (nextDays: RangeDays) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/analytics/revenue?days=${nextDays}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Revenue analytics are unavailable");
      setReport(data as RevenueReport);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Revenue analytics are unavailable"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(days); }, [days, load]);

  return <>
    <AdminPageHeader eyebrow="Analytics" title="Revenue" description="Collections, subscriptions, payment outcomes, and billing health." />
    <AnalyticsRangeToolbar days={days} onChange={setDays} onRefresh={() => void load(days)} loading={loading} dataAsOf={report?.dataAsOf} interval={days === 365 ? "month" : "day"} />
    {loading ? <div className="mt-5"><AdminLoadingState rows={7} /></div> : error ? <div className="mt-5"><ChartState kind="error" title="Revenue analytics unavailable" description={error} /></div> : report ? <RevenueContent report={report} days={days} /> : <div className="mt-5"><ChartState kind="empty" title="No revenue data" /></div>}
  </>;
}

function RevenueContent({ report, days }: { report: RevenueReport; days: RangeDays }) {
  const { kpis } = report;
  const moneyPoints = useMemo(() => displayPoints(report.daily, days, ["collectedRevenueMinor", "refundsMinor"]), [days, report.daily]);
  const movementPoints = useMemo(() => displayPoints(report.daily, days, ["newSubscriptions", "cancellations"]), [days, report.daily]);
  const planItems = report.planMix.map((item) => ({ key: `${item.product}-${item.plan}`, label: `${item.product} · ${item.plan}`, value: item.subscriptions }));
  return <div className="mt-5 space-y-5">
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Revenue metrics">
      <AnalyticsMetric label="Collected" value={formatCurrency(kpis.collectedRevenueMinor)} detail="Paid invoices in period" tone="success" />
      <AnalyticsMetric label="MRR" value={formatCurrency(kpis.monthlyRecurringRevenueMinor)} detail="Active recurring plans" tone="info" />
      <AnalyticsMetric label="Refunds" value={formatCurrency(kpis.refundsMinor)} detail="Refunded invoice states" tone={kpis.refundsMinor ? "attention" : "default"} />
      <AnalyticsMetric label="Paid invoices" value={formatNumber(kpis.paidInvoices)} detail={`${formatNumber(kpis.failedPayments)} failed payments`} />
      <AnalyticsMetric label="Subscriptions" value={formatNumber(kpis.activeSubscriptions)} detail={`${formatNumber(kpis.trials)} trials`} tone="info" />
      <AnalyticsMetric label="Net movement" value={formatNumber(kpis.newSubscriptions - kpis.cancellations)} detail={`${formatNumber(kpis.newSubscriptions)} new · ${formatNumber(kpis.cancellations)} cancelled`} tone={kpis.newSubscriptions >= kpis.cancellations ? "success" : "attention"} />
    </section>

    <AnalyticsChart title="Cash collections" description="Collected revenue and refunded invoice amounts by period." action={<span className="text-xs text-muted-foreground">{days === 365 ? "Monthly view" : "Daily view"}</span>}>
      <TimeBarChart points={moneyPoints} series={[{ key: "collectedRevenueMinor", label: "Collected", color: 3 }, { key: "refundsMinor", label: "Refunds", color: 6 }]} valueFormatter={formatCurrency} ariaLabel="Collected revenue and refunds by day" emptyTitle="No billing movement" />
    </AnalyticsChart>

    <section className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
      <AnalyticsChart title="Subscription movement" description="New subscriptions and recorded cancellations by period."><TimeBarChart points={movementPoints} series={[{ key: "newSubscriptions", label: "New", color: 2 }, { key: "cancellations", label: "Cancelled", color: 6 }]} valueFormatter={formatNumber} ariaLabel="Subscription movement by day" emptyTitle="No subscription movement" /></AnalyticsChart>
      <AnalyticsChart title="Current plan mix" description="Active, grace, past-due, and trial organizations by plan."><BreakdownBars items={planItems} emptyTitle="No active plans" /></AnalyticsChart>
    </section>

    <section className="grid gap-5 lg:grid-cols-3">
      <AnalyticsChart title="Payment outcomes" description="Checkout status across the selected period."><BreakdownBars items={report.paymentOutcomes} emptyTitle="No payment outcomes" /></AnalyticsChart>
      <AnalyticsChart title="Invoice status" description="Invoice status by issue date."><BreakdownBars items={report.invoiceStatus} emptyTitle="No invoices" /></AnalyticsChart>
      <AnalyticsChart title="Subscription status" description="Current subscription state distribution."><BreakdownBars items={report.subscriptionStatus} emptyTitle="No subscriptions" /></AnalyticsChart>
    </section>

    <AnalyticsChart title="Credit ledger movement" description="Credit grants, reservations, usage, and reversals recorded in Core."><BreakdownBars items={report.creditLifecycle.map((item) => ({ key: item.kind, label: item.kind.replaceAll("_", " "), value: Math.abs(item.amount) }))} emptyTitle="No credit movements" /></AnalyticsChart>
    <CoveragePanel items={report.coverage} />
    <DataStamp source={report.source} start={report.range.start} end={report.range.end} timezone={report.timezone} />
  </div>;
}
