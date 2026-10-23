"use client";

import Link from "next/link";
import { reportingParams, type ReportScope } from "@/lib/admin-report-format";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ChartState } from "@/components/admin/chart";
import { AdminLoadingState } from "@/components/admin/page-states";
import ConfirmModal from "@/components/admin/confirm-modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ReportDefinition = { key: string; name: string; description: string; source: string };
type SavedReport = { id: string; name: string; reportKey: string; config: { days?: number; definitionVersion?: string; product?: ReportScope["product"]; domain?: string; start?: string; end?: string; timezone?: string; organizationId?: string; pageSize?: number }; createdByName: string; updatedAt: string };
type ReportsResponse = { reports: ReportDefinition[]; saved: SavedReport[] };

function savedScope(report: SavedReport): ReportScope {
  return { product: report.config.product ?? "all", start: report.config.start ?? "", end: report.config.end ?? "", timezone: report.config.timezone ?? "UTC", organizationId: report.config.organizationId, page: 1, pageSize: report.config.pageSize ?? 50 };
}
function savedHref(report: SavedReport) {
  const domain = ["overview", "usage", "revenue", "customers", "adoption", "reliability"].includes(report.config.domain ?? "") ? report.config.domain! : "overview";
  return `/analytics${domain === "overview" ? "" : `/${domain}`}?${reportingParams(savedScope(report), domain)}`;
}

export function AdminReportsPage({ canExport, canSave }: { canExport: boolean; canSave: boolean }) {
  const [data, setData] = useState<ReportsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedReport, setSelectedReport] = useState("usage-daily");
  const [days, setDays] = useState("30");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SavedReport | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/reports", { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Reports are unavailable");
      setData(body as ReportsResponse);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Reports are unavailable"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true); setStatus(null);
    try {
      const response = await fetch("/api/reports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, reportKey: selectedReport, days: Number(days) }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Report could not be saved");
      setName(""); setStatus("Report saved"); await load();
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Report could not be saved"); }
    finally { setSaving(false); }
  }

  async function exportSaved(report: SavedReport) {
    setStatus(null);
    try {
      const response = await fetch(`/api/analytics/cross-product/export?${reportingParams(savedScope(report), report.config.domain)}`, { method: "POST" });
      if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error || "Export unavailable"); }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = "kasitek-report.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Export downloaded");
    } catch (failure) { setStatus(failure instanceof Error ? failure.message : "Export unavailable"); }
  }

  async function remove() {
    if (!deleting) return;
    setDeleteBusy(true); setStatus(null);
    try {
      const response = await fetch(`/api/reports/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "Report could not be deleted");
      setDeleting(null); setStatus("Report deleted"); await load();
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Report could not be deleted"); }
    finally { setDeleteBusy(false); }
  }

  if (loading) return <><AdminPageHeader eyebrow="Platform" title="Reports" description="Saved definitions and aggregate CSV exports." /><div className="mt-5"><AdminLoadingState rows={5} /></div></>;
  if (error) return <><AdminPageHeader eyebrow="Platform" title="Reports" description="Saved definitions and aggregate CSV exports." /><div className="mt-5"><ChartState kind="error" title="Reports unavailable" description={error} action={<Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button>} /></div></>;
  if (!data) return <ChartState kind="empty" title="No reports" />;
  const exportUrl = `/api/reports/export?report=${encodeURIComponent(selectedReport)}&days=${encodeURIComponent(days)}`;
  return <>
    <AdminPageHeader eyebrow="Platform" title="Reports" description="Saved definitions and aggregate CSV exports." />
    <div className="mt-5 space-y-5">
      <section className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="v-card overflow-hidden"><div className="border-b border-line px-[var(--density-card-padding)] py-4"><div className="flex items-center justify-between gap-3"><div><h2 className="text-base font-semibold text-foreground">Report catalog</h2><p className="mt-1 text-xs text-muted-foreground">Choose a bounded aggregate report to export or save.</p></div><Badge variant="outline">CSV</Badge></div></div><div className="grid gap-3 p-[var(--density-card-padding)] sm:grid-cols-2">{data.reports.map((report) => <button key={report.key} type="button" onClick={() => setSelectedReport(report.key)} className={`rounded-md border p-4 text-left transition-colors ${selectedReport === report.key ? "border-primary bg-primary/5" : "border-line bg-background/35 hover:bg-secondary"}`}><div className="flex items-start justify-between gap-3"><p className="text-sm font-medium text-foreground">{report.name}</p>{selectedReport === report.key ? <Badge>Selected</Badge> : null}</div><p className="mt-2 text-xs leading-5 text-muted-foreground">{report.description}</p><p className="mt-3 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">{report.source}</p></button>)}</div></div>
        <div className="v-card h-fit overflow-hidden"><div className="border-b border-line px-[var(--density-card-padding)] py-4"><h2 className="text-base font-semibold text-foreground">Export report</h2><p className="mt-1 text-xs text-muted-foreground">The selected period is applied at export time.</p></div><div className="space-y-4 p-[var(--density-card-padding)]"><label className="grid gap-1.5 text-xs text-muted-foreground">Range<select value={days} onChange={(event) => setDays(event.target.value)} className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring"><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">12 months</option></select></label>{selectedReport === "cross-product" ? <Link href="/analytics" className="text-sm text-primary hover:underline">Open product reporting</Link> : canExport ? <a href={exportUrl} download className="inline-flex h-9 w-full items-center justify-center rounded-md border border-transparent bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-brand-strong">Download CSV</a> : <p className="text-xs text-muted-foreground">Export access required</p>}</div></div>
      </section>

      {canSave && selectedReport !== "cross-product" ? <section className="v-card overflow-hidden"><div className="border-b border-line px-[var(--density-card-padding)] py-4"><h2 className="text-base font-semibold text-foreground">Save definition</h2><p className="mt-1 text-xs text-muted-foreground">Save a private report definition.</p></div><form onSubmit={save} className="flex flex-col gap-3 p-[var(--density-card-padding)] sm:flex-row sm:items-end"><label className="grid flex-1 gap-1.5 text-xs text-muted-foreground">Report name<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Weekly usage" maxLength={80} /></label><Button type="submit" disabled={saving || !name.trim()}>{saving ? "Saving..." : "Save report"}</Button></form>{status ? <p className="border-t border-line px-[var(--density-card-padding)] py-3 text-xs text-muted-foreground" role="status">{status}</p> : null}</section> : status ? <p role="status" className="text-sm text-muted-foreground">{status}</p> : null}

      <section className="v-card overflow-hidden"><div className="border-b border-line px-[var(--density-card-padding)] py-4"><h2 className="text-base font-semibold text-foreground">Saved reports</h2><p className="mt-1 text-xs text-muted-foreground">Definitions are private to the admin who created them.</p></div>{data.saved.length === 0 ? <div className="p-[var(--density-card-padding)]"><ChartState kind="empty" title="No saved reports" /></div> : <div className="divide-y divide-line">{data.saved.map((report) => <div key={report.id} className="flex flex-col gap-3 p-[var(--density-card-padding)] sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{report.name}</p><p className="mt-1 text-xs text-muted-foreground">{report.reportKey} · {report.reportKey === "cross-product" ? `${report.config.product ?? "all"} · definition ${report.config.definitionVersion ?? "1"}` : `${report.config.days ?? 30} days`} · updated {new Date(report.updatedAt).toLocaleDateString("en-ZA")}</p></div><div className="flex flex-wrap items-center gap-2">{report.reportKey === "cross-product" ? <><Link href={savedHref(report)} className="text-xs text-primary hover:underline">Open report</Link>{canExport ? <Button variant="outline" size="sm" onClick={() => void exportSaved(report)}>Export CSV</Button> : null}</> : canExport ? <a href={`/api/reports/export?report=${encodeURIComponent(report.reportKey)}&days=${report.config.days ?? 30}`} download className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-secondary">Download</a> : null}{canSave ? <Button variant="ghost" size="sm" onClick={() => setDeleting(report)}>Delete</Button> : null}</div></div>)}</div>}</section>
    </div>
    <ConfirmModal open={Boolean(deleting)} title="Delete saved report?" message="This report definition will be removed. Exported files are not affected." confirmLabel="Delete" loading={deleteBusy} onConfirm={() => void remove()} onCancel={() => { if (!deleteBusy) setDeleting(null); }} />
  </>;
}
