"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ADMIN_REPORT_METRICS, type AdminCrossProductReport, type AdminProductReport, type AdminReportDomain, type AdminReportAvailability, type AdminReportTrend } from "@kasitek-labs/contracts";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminLoadingState } from "@/components/admin/page-states";
import { ChartA11ySummary } from "@/components/admin/chart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { exactMetricValue, reportingParams, reportTimestamp, trendChartValues, type ReportScope } from "@/lib/admin-report-format";

export type ReportDomain = AdminReportDomain | "overview";
const titles: Record<ReportDomain, string> = { overview: "Product overview", customers: "Customers and access", adoption: "Adoption", usage: "Usage and cost", revenue: "Revenue", reliability: "Reliability" };
const products = { growth: "Growth", agents: "Agents", agency: "Agency" };
const metricDefinitions = new Map(ADMIN_REPORT_METRICS.map((definition) => [definition.key, definition]));
const control = "h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground";
function initialScope(): ReportScope {
  const now = new Date(Math.floor(Date.now() / 60000) * 60000);
  const scope: ReportScope = { product: "all", start: new Date(now.getTime() - 30 * 86400000).toISOString(), end: now.toISOString(), timezone: "UTC", page: 1, pageSize: 50 };
  return scope;
}
function fromSearch(defaultScope: ReportScope) {
  const params = new URLSearchParams(window.location.search);
  const product = params.get("product");
  return { ...defaultScope, ...(product && ["all", "growth", "agents", "agency"].includes(product) ? { product: product as ReportScope["product"] } : {}), start: params.get("start") || defaultScope.start, end: params.get("end") || defaultScope.end, timezone: params.get("timezone") || "UTC", ...(params.get("organizationId") ? { organizationId: params.get("organizationId")! } : {}), page: Math.max(1, Number(params.get("page")) || 1), pageSize: Math.max(1, Math.min(100, Number(params.get("pageSize")) || defaultScope.pageSize)) };
}
function coverageVariant(value: AdminReportAvailability) {
  return value === "available" ? "success" : value === "partial" || value === "stale" ? "attention" : "outline";
}

export function AdminCrossProductReporting({ domain = "overview", canExport, canSave }: { domain?: ReportDomain; canExport: boolean; canSave: boolean }) {
  const [scope, setScope] = useState<ReportScope>(initialScope);
  const [draft, setDraft] = useState<ReportScope>(initialScope);
  const [report, setReport] = useState<AdminCrossProductReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const value = fromSearch(initialScope());
    setScope(value); setDraft(value); setReady(true);
    function restore() { const next = fromSearch(initialScope()); setScope(next); setDraft(next); }
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  const load = useCallback(async (query: ReportScope) => {
    activeRequest.current?.abort();
    const request = new AbortController(); activeRequest.current = request;
    setLoading(true); setError(null); setReport(null);
    try {
      const response = await fetch(`/api/analytics/cross-product?${reportingParams(query, domain)}`, { cache: "no-store", signal: request.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Reporting unavailable");
      if (body.contractVersion !== "1" || !Array.isArray(body.products)) throw new Error("Invalid reporting response");
      if (!request.signal.aborted) setReport(body as AdminCrossProductReport);
    } catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Reporting unavailable"); }
    finally { if (!request.signal.aborted) setLoading(false); }
  }, [domain]);
  useEffect(() => { if (ready) void load(scope); return () => activeRequest.current?.abort(); }, [ready, load, scope]);

  function changeScope(next: ReportScope) {
    setReport(null); setLoading(true); setScope(next); setDraft(next); setStatus(null);
    window.history.pushState(null, "", `${window.location.pathname}?${reportingParams(next, domain)}`);
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    if (!Number.isFinite(Date.parse(draft.start)) || !Number.isFinite(Date.parse(draft.end)) || Date.parse(draft.start) >= Date.parse(draft.end)) { setError("Choose a valid start and end time"); return; }
    try { new Intl.DateTimeFormat("en", { timeZone: draft.timezone }); } catch { setError("Enter a valid timezone"); return; }
    changeScope({ ...draft, start: new Date(draft.start).toISOString(), end: new Date(draft.end).toISOString(), organizationId: draft.organizationId?.trim() || undefined, page: 1 });
  }
  async function exportReport() {
    setExporting(true); setStatus(null);
    try {
      const response = await fetch(`/api/analytics/cross-product/export?${reportingParams(scope, domain)}`, { method: "POST" });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.error || "Export unavailable"); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = `kasitek-${scope.product}-${domain}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Export downloaded");
    } catch (failure) { setStatus(failure instanceof Error ? failure.message : "Export unavailable"); }
    finally { setExporting(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setStatus(null);
    try {
      const response = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim(), reportKey: "cross-product", config: { definitionVersion: "1", domain, product: scope.product, start: scope.start, end: scope.end, timezone: scope.timezone, organizationId: scope.organizationId, pageSize: scope.pageSize } }) });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "Report could not be saved");
      setSaveOpen(false); setName(""); setStatus("Report saved");
    } catch (failure) { setStatus(failure instanceof Error ? failure.message : "Report could not be saved"); }
    finally { setSaving(false); }
  }
  const hasMore = report?.products.some((product) => product.hasMore) ?? false;
  return <>
    <AdminPageHeader title={titles[domain]} actions={<>{canSave ? <Button variant="outline" disabled={loading || !report} onClick={() => { setStatus(null); setSaveOpen(true); }}>Save report</Button> : null}{canExport ? <Button disabled={loading || !report || exporting} onClick={() => void exportReport()}>{exporting ? "Exporting..." : "Export CSV"}</Button> : null}</>} />
    <form onSubmit={apply} className="v-card grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-6" aria-label="Report filters">
      <label className="grid gap-1 text-xs text-muted-foreground">Product<select aria-label="Product" value={draft.product} onChange={(event) => setDraft({ ...draft, product: event.target.value as ReportScope["product"], organizationId: undefined })} className={control}><option value="all">All products</option>{Object.entries(products).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="grid gap-1 text-xs text-muted-foreground">Organization / workspace<Input aria-label="Organization / workspace" disabled={draft.product === "all"} value={draft.organizationId ?? ""} onChange={(event) => setDraft({ ...draft, organizationId: event.target.value })} placeholder="Product-owned ID" /></label>
      <label className="grid gap-1 text-xs text-muted-foreground">Start (UTC)<input aria-label="Start (UTC)" type="datetime-local" value={draft.start.slice(0, 16)} onChange={(event) => setDraft({ ...draft, start: event.target.value ? `${event.target.value}:00.000Z` : "" })} className={control} required /></label>
      <label className="grid gap-1 text-xs text-muted-foreground">End (UTC, exclusive)<input aria-label="End (UTC, exclusive)" type="datetime-local" value={draft.end.slice(0, 16)} onChange={(event) => setDraft({ ...draft, end: event.target.value ? `${event.target.value}:00.000Z` : "" })} className={control} required /></label>
      <label className="grid gap-1 text-xs text-muted-foreground">Timezone<Input aria-label="Timezone" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} list="report-timezones" required /><datalist id="report-timezones"><option>UTC</option><option>Africa/Johannesburg</option><option>Europe/London</option><option>America/New_York</option></datalist></label>
      <div className="flex items-end gap-2"><Button type="submit" disabled={loading}>Apply</Button><Button variant="ghost" disabled={loading} onClick={() => void load(scope)}>Refresh</Button></div>
    </form>
    {status && !saveOpen ? <p role="status" className="text-sm text-muted-foreground">{status}</p> : null}
    {loading ? <AdminLoadingState rows={6} /> : error ? <section className="v-card space-y-3 p-5" role="alert"><h2 className="font-semibold">Reporting unavailable</h2><p className="text-sm text-muted-foreground">{error}</p><Button variant="outline" onClick={() => void load(scope)}>Retry</Button></section> : report ? <>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{reportTimestamp(report.query.start, report.query.timezone)} to {reportTimestamp(report.query.end, report.query.timezone)} · {report.query.timezone}</span><span>Definition {report.contractVersion}</span></div>
      {report.products.length ? report.products.map((product, index) => <ProductSection key={`${product.product}-${product.query.consumer ?? "owner"}-${index}`} report={product} domain={domain} />) : <p className="v-card p-5 text-sm text-muted-foreground">No product sources in this scope</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"><span className="text-xs text-muted-foreground">Records page {scope.page} · up to {scope.pageSize} per source</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={scope.page <= 1} onClick={() => changeScope({ ...scope, page: scope.page - 1 })}>Previous</Button><Button variant="outline" size="sm" disabled={!hasMore} onClick={() => changeScope({ ...scope, page: scope.page + 1 })}>Next</Button></div></div>
    </> : null}
    <Dialog open={saveOpen} onOpenChange={(next) => { if (!saving) setSaveOpen(next); }}><DialogContent className="max-w-md"><DialogHeader><DialogTitle>Save report</DialogTitle><DialogDescription>Private report definition</DialogDescription></DialogHeader><form onSubmit={save} className="space-y-4"><label className="grid gap-1 text-sm">Name<Input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required autoFocus /></label>{status ? <p role="alert" className="text-sm text-status-danger">{status}</p> : null}<div className="flex justify-end gap-2"><Button variant="ghost" disabled={saving} onClick={() => setSaveOpen(false)}>Cancel</Button><Button type="submit" disabled={saving || !name.trim()}>{saving ? "Saving..." : "Save"}</Button></div></form></DialogContent></Dialog>
  </>;
}

function ProductSection({ report, domain }: { report: AdminProductReport; domain: ReportDomain }) {
  const rows = report.metrics.filter((metric) => domain === "overview" || metricDefinitions.get(metric.key)?.domain === domain);
  const id = `${report.product}-${report.query.consumer ?? "owner"}-records`;
  const label = `${products[report.product]}${report.query.consumer ? ` · ${products[report.query.consumer]} execution` : ""}`;
  return <section className="v-card min-w-0 overflow-hidden" aria-label={`${label} reporting`}>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border p-4"><h2 className="text-base font-semibold">{label}</h2><Badge variant={coverageVariant(report.availability)}>{report.availability}</Badge></header>
    <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border px-4 py-3 text-xs text-muted-foreground"><span>Latest source record: {reportTimestamp(report.sourceObservedAt, report.query.timezone)}</span><span>Complete through: {reportTimestamp(report.completeThrough, report.query.timezone)}</span></div>
    {rows.length ? <div className="overflow-x-auto focus-visible:outline focus-visible:outline-ring" tabIndex={0} role="region" aria-label={`${label} metrics`}><table className="w-full min-w-[660px] text-left text-sm"><thead className="border-b border-border text-xs text-muted-foreground"><tr><th className="px-4 py-3 font-medium">Metric</th><th className="px-4 py-3 text-right font-medium">Value</th><th className="px-4 py-3 font-medium">Coverage</th><th className="px-4 py-3 font-medium">Source</th></tr></thead><tbody className="divide-y divide-border">{rows.map((metric, index) => {
      const definition = metricDefinitions.get(metric.key);
      return <tr key={`${metric.key}-${metric.currency ?? ""}-${index}`}><td className="px-4 py-3"><span className="font-medium">{definition?.label ?? metric.key.replaceAll("_", " ")}</span>{definition?.semantics === "current" ? <span className="ml-2 text-xs text-muted-foreground">Current</span> : null}{metric.dimensions && Object.keys(metric.dimensions).length ? <p className="mt-1 max-w-sm break-words text-xs text-muted-foreground">{Object.entries(metric.dimensions).map(([key, value]) => `${key}: ${value}`).join(" · ")}</p> : null}<details className="mt-1 text-xs text-muted-foreground"><summary className="cursor-pointer">Definition</summary><p className="mt-1 max-w-md">{definition?.definition ?? "Product-owned metric"}</p></details></td><td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums">{metric.value === null || metric.availability === "unavailable" || metric.availability === "unsupported" ? "Unavailable" : <button type="button" onClick={() => { const detail = document.getElementById(id); if (detail instanceof HTMLDetailsElement) { detail.open = true; detail.scrollIntoView({ block: "nearest" }); } }} className="underline decoration-border underline-offset-4 hover:text-primary">{exactMetricValue(metric, definition)}</button>}</td><td className="px-4 py-3"><Badge variant={coverageVariant(metric.availability)}>{metric.availability}</Badge>{metric.reason ? <p className="mt-1 max-w-xs text-xs text-muted-foreground">{metric.reason}</p> : null}</td><td className="px-4 py-3 text-xs text-muted-foreground"><p className="break-all">{metric.source}</p><p className="mt-1">{reportTimestamp(metric.observedAt, report.query.timezone)}</p></td></tr>;
    })}</tbody></table></div> : <p className="p-4 text-sm text-muted-foreground">{report.availability === "unavailable" ? report.metrics.find((metric) => metric.reason)?.reason ?? "Source unavailable" : "No metrics for this scope"}</p>}
    <ProductTrends report={report} domain={domain} label={label} />
    <details id={id} className="border-t border-border p-4"><summary className="cursor-pointer text-sm font-medium">Source records · {report.records.length}{report.hasMore ? "+" : ""}</summary>{report.records.length ? <div className="mt-3 overflow-x-auto focus-visible:outline focus-visible:outline-ring" tabIndex={0} role="region" aria-label={`${label} source records`}><table className="w-full min-w-[700px] text-left text-xs"><thead className="border-b border-border text-muted-foreground"><tr><th className="py-2 pr-4 font-medium">Record</th><th className="py-2 pr-4 font-medium">Kind</th><th className="py-2 pr-4 font-medium">Organization / workspace</th><th className="py-2 pr-4 font-medium">State</th><th className="py-2 font-medium">Time</th></tr></thead><tbody className="divide-y divide-border">{report.records.map((record) => <tr key={`${record.kind}-${record.id}`}><td className="max-w-64 break-all py-3 pr-4">{record.id}{record.rootId ? <p className="mt-1 text-muted-foreground">Root: {record.rootId}</p> : null}</td><td className="py-3 pr-4">{record.kind}</td><td className="max-w-64 break-all py-3 pr-4">{record.organizationId}</td><td className="py-3 pr-4">{record.state}</td><td className="whitespace-nowrap py-3">{reportTimestamp(record.occurredAt, report.query.timezone)}</td></tr>)}</tbody></table></div> : <p className="mt-3 text-sm text-muted-foreground">No source records in this page and scope</p>}</details>
  </section>;
}

function ProductTrends({ report, domain, label }: { report: AdminProductReport; domain: ReportDomain; label: string }) {
  const trends = (report.trends ?? []).filter((trend) => domain === "overview" || trend.domain === domain);
  if (!trends.length) return null;
  return <section className="space-y-4 border-t border-border p-4" aria-label={`${label} event projections`}>
    <h3 className="text-sm font-semibold">Event projections</h3>
    {trends.map((trend, index) => <Trend key={`${trend.key}-${index}`} trend={trend} timezone={report.query.timezone} />)}
  </section>;
}

function Trend({ trend, timezone }: { trend: AdminReportTrend; timezone: string }) {
  const values = trendChartValues(trend);
  const known = values?.filter((value): value is number => value !== null) ?? [];
  const low = Math.min(0, ...known);
  const high = Math.max(1, ...known);
  const range = high - low;
  const points = values?.map((value, index) => value === null ? null : { x: 20 + index * 600 / Math.max(1, values.length - 1), y: 130 - (value - low) / range * 110 });
  const path = points?.map((point, index) => point ? `${index && points[index - 1] ? "L" : "M"}${point.x},${point.y}` : "").join(" ");
  return <div className="min-w-0 space-y-2 rounded-md border border-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="break-all text-sm font-medium">{trend.key}</h4><Badge variant={coverageVariant(trend.availability)}>{trend.availability}</Badge></div>
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span>{trend.unit}</span><span className="break-all">{trend.source}</span><span>Latest event: {reportTimestamp(trend.observedAt, timezone)}</span><span>Complete through: {reportTimestamp(trend.completeThrough, timezone)}</span></div>
    {trend.scopeCoverage ? <p className="text-xs text-muted-foreground">Organization / workspace coverage: {trend.scopeCoverage.includedScopeCount} of {trend.scopeCoverage.totalScopeCount}{trend.scopeCoverage.hasMore ? " · partial" : ""}</p> : null}
    {trend.reason ? <p className="text-xs text-muted-foreground">{trend.reason}</p> : null}
    {points && path ? <><ChartA11ySummary>{trend.key}, {trend.availability}, {trend.series.length} buckets. Exact values follow.</ChartA11ySummary><svg viewBox="0 0 640 150" role="img" aria-label={`${trend.key} trend`} className="h-40 w-full text-primary" preserveAspectRatio="none"><path d="M20 130 H620" stroke="var(--border)" fill="none" /><path d={path} stroke="currentColor" strokeWidth="2" fill="none" vectorEffect="non-scaling-stroke" />{points.map((point, index) => point ? <circle key={index} cx={point.x} cy={point.y} r="3" fill="currentColor"><title>{reportTimestamp(trend.series[index].start, timezone)}: {trend.series[index].value} {trend.unit}</title></circle> : null)}</svg></> : null}
    <details><summary className="cursor-pointer text-xs font-medium">Bucket values · {trend.series.length}</summary><div className="mt-2 overflow-x-auto" role="region" aria-label={`${trend.key} bucket values`} tabIndex={0}><table className="w-full min-w-[500px] text-left text-xs"><thead className="border-b border-border text-muted-foreground"><tr><th className="py-2 pr-3 font-medium">Start</th><th className="py-2 pr-3 font-medium">End (exclusive)</th><th className="py-2 text-right font-medium">Value ({trend.unit})</th></tr></thead><tbody className="divide-y divide-border">{trend.series.map((bucket, index) => <tr key={`${bucket.start}-${index}`}><td className="whitespace-nowrap py-2 pr-3">{reportTimestamp(bucket.start, timezone)}</td><td className="whitespace-nowrap py-2 pr-3">{reportTimestamp(bucket.end, timezone)}</td><td className="py-2 text-right tabular-nums">{exactMetricValue({key:trend.key,value:bucket.value,availability:trend.availability,source:trend.source,observedAt:trend.observedAt})}</td></tr>)}</tbody></table></div></details>
  </div>;
}
