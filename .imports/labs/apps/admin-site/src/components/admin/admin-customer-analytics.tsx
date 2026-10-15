"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ChartState } from "@/components/admin/chart";
import { AdminLoadingState } from "@/components/admin/page-states";
import { StatusBadge } from "@/components/admin/status-badge";
import {
  AnalyticsChart, AnalyticsMetric, AnalyticsRangeToolbar, BreakdownBars, CoveragePanel, DataStamp,
  displayPoints, formatNumber, formatPercent, RangeDays, TimeBarChart,
} from "@/components/admin/admin-analytics-shared";

type OrganizationRow = { id: string; name: string; plan: string | null; operations: number; activeDays: number };
type CustomerReport = {
  range: { start: string; end: string; days: number; interval: string };
  source: string;
  timezone: string;
  dataAsOf: string;
  coverage: Array<{ key: string; label: string; status: string; detail: string }>;
  kpis: { totalOrganizations: number; newOrganizations: number; activeOrganizations: number; inactiveOrganizations: number; activationRate: number; totalUsers: number; activeUsers: number; payingOrganizations: number; trialOrganizations: number };
  daily: Array<{ date: string; newOrganizations: number; activeOrganizations: number; newUsers: number; activeUsers: number }>;
  funnel: Array<{ key: string; label: string; value: number }>;
  planMix: Array<{ key: string; label: string; value: number }>;
  topOrganizations: OrganizationRow[];
  inactiveOrganizations: OrganizationRow[];
};

export function AdminCustomerAnalytics() {
  const [days, setDays] = useState<RangeDays>(30);
  const [report, setReport] = useState<CustomerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (nextDays: RangeDays) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/analytics/customers?days=${nextDays}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Customer analytics are unavailable");
      setReport(data as CustomerReport);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Customer analytics are unavailable"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(days); }, [days, load]);

  return <>
    <AdminPageHeader eyebrow="Analytics" title="Customers" description="Organization growth, activation, plan distribution, and cohorts." />
    <AnalyticsRangeToolbar days={days} onChange={setDays} onRefresh={() => void load(days)} loading={loading} dataAsOf={report?.dataAsOf} interval={days === 365 ? "month" : "day"} />
    {loading ? <div className="mt-5"><AdminLoadingState rows={7} /></div> : error ? <div className="mt-5"><ChartState kind="error" title="Customer analytics unavailable" description={error} /></div> : report ? <CustomerContent report={report} days={days} /> : <div className="mt-5"><ChartState kind="empty" title="No customer data" /></div>}
  </>;
}

function CustomerContent({ report, days }: { report: CustomerReport; days: RangeDays }) {
  const { kpis } = report;
  const lifecyclePoints = useMemo(() => displayPoints(report.daily, days, ["newOrganizations", "activeOrganizations", "newUsers", "activeUsers"]), [days, report.daily]);
  return <div className="mt-5 space-y-5">
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6" aria-label="Customer metrics">
      <AnalyticsMetric label="Organizations" value={formatNumber(kpis.totalOrganizations)} detail={`${formatNumber(kpis.newOrganizations)} new in period`} />
      <AnalyticsMetric label="Active" value={formatNumber(kpis.activeOrganizations)} detail={`${formatNumber(kpis.inactiveOrganizations)} inactive`} tone="info" />
      <AnalyticsMetric label="Activation rate" value={formatPercent(kpis.activationRate)} detail="Meaningful event in period" tone={kpis.activationRate >= 50 ? "success" : "attention"} />
      <AnalyticsMetric label="Paying" value={formatNumber(kpis.payingOrganizations)} detail={`${formatNumber(kpis.trialOrganizations)} trials`} tone="success" />
      <AnalyticsMetric label="Users" value={formatNumber(kpis.totalUsers)} detail={`${formatNumber(kpis.activeUsers)} active owners`} />
      <AnalyticsMetric label="New organizations" value={formatNumber(kpis.newOrganizations)} detail="Created in period" tone="info" />
    </section>

    <AnalyticsChart title="Customer lifecycle" description="Organization and user creation alongside active organizations by period." action={<span className="text-xs text-muted-foreground">{days === 365 ? "Monthly view" : "Daily view"}</span>}>
      <TimeBarChart points={lifecyclePoints} series={[{ key: "newOrganizations", label: "New organizations", color: 1 }, { key: "activeOrganizations", label: "Active organizations", color: 2 }, { key: "newUsers", label: "New users", color: 3 }, { key: "activeUsers", label: "Active users", color: 4 }]} valueFormatter={formatNumber} ariaLabel="Customer lifecycle by day" emptyTitle="No customer movement" />
    </AnalyticsChart>

    <section className="grid gap-5 xl:grid-cols-[1fr_1.25fr]">
      <AnalyticsChart title="Activation funnel" description="All organizations, recorded activity, and paying organizations."><BreakdownBars items={report.funnel} emptyTitle="No activation data" /></AnalyticsChart>
      <AnalyticsChart title="Current plan distribution" description="Organizations grouped by their current trial or paid plan."><BreakdownBars items={report.planMix} emptyTitle="No active plans" /></AnalyticsChart>
    </section>

    <section className="grid gap-5 xl:grid-cols-2">
      <OrganizationTable title="Most active organizations" description="Ranked by recorded operations in the selected period." rows={report.topOrganizations} emptyTitle="No active organizations" />
      <OrganizationTable title="Inactive organizations" description="No recorded usage events in the selected period." rows={report.inactiveOrganizations} emptyTitle="No inactive organizations" />
    </section>
    <CoveragePanel items={report.coverage} />
    <DataStamp source={report.source} start={report.range.start} end={report.range.end} timezone={report.timezone} />
  </div>;
}

function OrganizationTable({ title, description, rows, emptyTitle }: { title: string; description: string; rows: OrganizationRow[]; emptyTitle: string }) {
  return <section className="v-card overflow-hidden"><div className="border-b border-line px-[var(--density-card-padding)] py-4"><h2 className="text-base font-semibold text-foreground">{title}</h2><p className="mt-1 text-xs text-muted-foreground">{description}</p></div>{rows.length === 0 ? <ChartState kind="empty" title={emptyTitle} /> : <><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[510px] text-left text-sm"><thead className="border-b border-line text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Organization</th><th className="px-5 py-3 font-medium">Plan</th><th className="px-5 py-3 text-right font-medium">Operations</th><th className="px-5 py-3 text-right font-medium">Days</th></tr></thead><tbody className="divide-y divide-line">{rows.map((row) => <tr key={row.id} className="hover:bg-secondary"><td className="px-5 py-3"><Link href={`/agencies/${row.id}`} className="font-medium text-foreground hover:text-primary">{row.name}</Link><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{row.id}</p></td><td className="px-5 py-3 text-xs text-muted-foreground">{row.plan ?? "No active plan"}</td><td className="px-5 py-3 text-right font-medium tabular-nums text-foreground">{formatNumber(row.operations)}</td><td className="px-5 py-3 text-right tabular-nums text-muted-foreground">{formatNumber(row.activeDays)}</td></tr>)}</tbody></table></div><div className="divide-y divide-line md:hidden">{rows.map((row) => <Link key={row.id} href={`/agencies/${row.id}`} className="block p-4 hover:bg-secondary"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{row.name}</p><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{row.id}</p></div><StatusBadge value={row.plan ? "active" : "unknown"} /></div><div className="mt-3 grid grid-cols-2 gap-3 text-xs"><div><p className="text-muted-foreground">Operations</p><p className="mt-1 font-medium tabular-nums text-foreground">{formatNumber(row.operations)}</p></div><div><p className="text-muted-foreground">Active days</p><p className="mt-1 font-medium tabular-nums text-foreground">{formatNumber(row.activeDays)}</p></div></div></Link>)}</div></>}</section>;
}
