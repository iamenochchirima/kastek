"use client";

import { useEffect, useState } from "react";
import type { AdminCrossProductReport, AdminReportProduct } from "@kasitek-labs/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { reportingParams, type ReportScope } from "@/lib/admin-report-format";

const labels = { growth: "Growth", agents: "Agents", agency: "Agency" };
export function ReportCustomerSelector({ scope, onSelect }: { scope: ReportScope; onSelect: (product: ReportScope["product"], organizationId?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [report, setReport] = useState<AdminCrossProductReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<{ product: string; id: string; label: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(null); setReport(null);
    const timer = setTimeout(async () => {
      try {
        const params = reportingParams({ ...scope, organizationId: undefined, detail: undefined, page, pageSize: 25 }, "customers");
        params.set("search", search.trim());
        const response = await fetch(`/api/analytics/cross-product?${params}`, { cache: "no-store", signal: controller.signal });
        const body = await response.json();
        if (!response.ok || body.contractVersion !== "1" || !Array.isArray(body.products)) throw Error(body.error || "Customers unavailable");
        if (!controller.signal.aborted) setReport(body);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Customers unavailable"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, search, page, retry, scope]);
  function select(product: ReportScope["product"], id?: string, label?: string) {
    setSelected(id ? { product, id, label: label || id } : null); onSelect(product, id); setOpen(false);
  }
  const rows = report?.products.flatMap(product => product.records.filter(row => row.kind === "organization" || row.kind === "workspace").map(row => ({ ...row, product: product.product }))) ?? [];
  const unavailable = report?.products.filter(product => product.availability === "unavailable") ?? [];
  const current = selected?.product === scope.product && selected.id === scope.organizationId ? selected.label : scope.organizationId;
  return <>
    <Button type="button" variant="outline" className="w-full justify-start overflow-hidden" aria-label="Choose customer" onClick={() => { setSearch(""); setPage(1); setOpen(true); }}><span className="truncate">{current || "All customers"}</span></Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg"><DialogHeader><DialogTitle>Choose customer</DialogTitle></DialogHeader>
      <Input autoFocus aria-label="Search customers" placeholder="Name or exact ID" maxLength={100} value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} />
      <Button variant="ghost" className="justify-start" onClick={() => select(scope.product)}>All customers</Button>
      <div aria-live="polite" aria-busy={loading} className="min-h-24 space-y-1">
        {loading ? <p className="py-4 text-sm text-muted-foreground">Searching...</p> : error ? <div role="alert"><p className="text-sm">{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>Retry</Button></div> : <>
          {unavailable.map(product => <p key={product.product} className="text-sm text-status-danger">{labels[product.product]} unavailable</p>)}
          {!rows.length ? <p className="py-4 text-sm text-muted-foreground">No customers found</p> : rows.map(row => <button key={`${row.product}-${row.id}`} type="button" className="w-full rounded-md px-3 py-2 text-left hover:bg-muted focus-visible:outline focus-visible:outline-ring" onClick={() => select(row.product as AdminReportProduct, row.organizationId, row.label)}><span className="block break-words text-sm font-medium">{row.label || row.id}</span><span className="block break-all text-xs text-muted-foreground">{labels[row.product]} · {row.id}</span></button>)}
        </>}
      </div>
      <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">Page {page}</span><div className="flex gap-2"><Button variant="outline" disabled={loading || page === 1} onClick={() => setPage(value => value - 1)}>Previous</Button><Button variant="outline" disabled={loading || !report?.products.some(product => product.hasMore)} onClick={() => setPage(value => value + 1)}>Next</Button></div></div>
    </DialogContent></Dialog>
  </>;
}
