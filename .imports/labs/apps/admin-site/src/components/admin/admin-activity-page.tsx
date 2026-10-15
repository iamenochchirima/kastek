"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { ChartState } from "@/components/admin/chart";
import { AdminLoadingState } from "@/components/admin/page-states";
import { StatusBadge } from "@/components/admin/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AnalyticsRangeToolbar, RangeDays, formatDateTime } from "@/components/admin/admin-analytics-shared";

type ActivityItem = {
  id: string;
  occurredAt: string;
  source: string;
  domain: string;
  action: string;
  status: string;
  severity: string;
  actorType: string | null;
  actorId: string | null;
  organizationId: string | null;
  resourceType: string;
  resourceId: string;
  correlationId: string | null;
  metadata: Record<string, unknown>;
};
type ActivityResponse = { items: ActivityItem[]; nextCursor: string | null; hasMore: boolean; dataAsOf: string; source: string; coverage: string };

const domains = ["", "usage", "conversations", "messaging", "campaigns", "content", "billing", "credits", "notifications", "security", "data_quality"];
const severities = ["", "info", "warning", "error", "critical"];
const statuses = ["", "RECORDED", "SENT", "DELIVERED", "FAILED", "PAID", "OPEN"];

export function AdminActivityPage() {
  const [days, setDays] = useState<RangeDays>(7);
  const [domain, setDomain] = useState("");
  const [severity, setSeverity] = useState("");
  const [status, setStatus] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [report, setReport] = useState<ActivityResponse | null>(null);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [newEvents, setNewEvents] = useState(0);

  const query = useMemo(() => {
    const params = new URLSearchParams({ days: String(days), limit: "50" });
    if (domain) params.set("domain", domain);
    if (severity) params.set("severity", severity);
    if (status) params.set("status", status);
    if (organizationId.trim()) params.set("organizationId", organizationId.trim());
    return params.toString();
  }, [days, domain, severity, status, organizationId]);

  const load = useCallback(async (nextCursor: string | null) => {
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/activity?${query}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Activity is unavailable");
      setReport(data as ActivityResponse); setItems((data as ActivityResponse).items); setNewEvents(0);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Activity is unavailable"); }
    finally { setLoading(false); }
  }, [query]);

  useEffect(() => { setCursor(null); void load(null); }, [load]);
  useEffect(() => { if (cursor) void load(cursor); }, [cursor, load]);

  useEffect(() => {
    if (!live) return;
    const stream = new EventSource(`/api/activity/stream?${query}&limit=30`);
    setLiveError(null);
    const onActivity = (event: MessageEvent<string>) => {
      try {
        const item = JSON.parse(event.data) as ActivityItem;
        setItems((current) => [item, ...current.filter((existing) => existing.id !== item.id)].slice(0, 100));
        setNewEvents((count) => count + 1);
      } catch { setLiveError("A live event could not be read"); }
    };
    const onError = () => setLiveError("Reconnecting to live activity");
    stream.addEventListener("activity", onActivity as EventListener);
    stream.addEventListener("error", onError);
    return () => { stream.removeEventListener("activity", onActivity as EventListener); stream.removeEventListener("error", onError); stream.close(); };
  }, [live, query]);

  function clearFilters() {
    setDomain(""); setSeverity(""); setStatus(""); setOrganizationId(""); setCursor(null);
  }

  const filteredCount = [domain, severity, status, organizationId].filter(Boolean).length;
  return <>
    <AdminPageHeader eyebrow="Platform" title="Activity" description="Committed platform events across workspaces and billing." actions={<Button variant={live ? "primary" : "outline"} size="sm" onClick={() => setLive((value) => !value)}><span className={`size-2 rounded-full ${live ? "bg-status-success" : "bg-muted-foreground"}`} />{live ? "Live" : "Go live"}</Button>} />
    <AnalyticsRangeToolbar days={days} onChange={(value) => { setDays(value); setCursor(null); }} onRefresh={() => void load(cursor)} loading={loading} dataAsOf={report?.dataAsOf} interval="event time" />
    <section className="mt-5 rounded-md border border-line bg-card p-3 shadow-card"><div className="flex flex-wrap items-end gap-3"><label className="grid gap-1.5 text-xs text-muted-foreground">Domain<select value={domain} onChange={(event) => { setDomain(event.target.value); setCursor(null); }} className="h-9 min-w-36 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring">{domains.map((value) => <option key={value} value={value}>{value || "All domains"}</option>)}</select></label><label className="grid gap-1.5 text-xs text-muted-foreground">Severity<select value={severity} onChange={(event) => { setSeverity(event.target.value); setCursor(null); }} className="h-9 min-w-32 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring">{severities.map((value) => <option key={value} value={value}>{value || "All severities"}</option>)}</select></label><label className="grid gap-1.5 text-xs text-muted-foreground">Status<select value={status} onChange={(event) => { setStatus(event.target.value); setCursor(null); }} className="h-9 min-w-36 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring">{statuses.map((value) => <option key={value} value={value}>{value || "All statuses"}</option>)}</select></label><label className="grid min-w-52 flex-1 gap-1.5 text-xs text-muted-foreground">Organization ID<Input value={organizationId} onChange={(event) => { setOrganizationId(event.target.value); setCursor(null); }} placeholder="Filter by ID" /></label>{filteredCount ? <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters ({filteredCount})</Button> : null}</div></section>
    {liveError ? <div className="mt-3 rounded-md border border-status-attention/30 bg-status-attention-soft px-3 py-2 text-xs text-status-attention" role="status">{liveError}</div> : null}
    {newEvents > 0 ? <button type="button" onClick={() => setNewEvents(0)} className="mt-3 text-xs font-medium text-primary hover:underline">{newEvents} new event{newEvents === 1 ? "" : "s"}</button> : null}
    <section className="mt-5 v-card overflow-hidden">{loading && !items.length ? <div className="p-5"><AdminLoadingState rows={6} /></div> : error ? <div className="p-5"><ChartState kind="error" title="Activity unavailable" description={error} action={<Button variant="outline" size="sm" onClick={() => void load(cursor)}>Retry</Button>} /></div> : items.length === 0 ? <div className="p-5"><ChartState kind="empty" title="No activity" description="No committed events match these filters." /></div> : <><div className="hidden overflow-x-auto lg:block"><table className="w-full min-w-[920px] text-left text-sm"><thead className="border-b border-line text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Time</th><th className="px-5 py-3 font-medium">Event</th><th className="px-5 py-3 font-medium">Organization</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3 font-medium">Resource</th><th className="px-5 py-3 font-medium">Metadata</th></tr></thead><tbody className="divide-y divide-line">{items.map((item) => <ActivityRow key={item.id} item={item} />)}</tbody></table></div><div className="divide-y divide-line lg:hidden">{items.map((item) => <ActivityCard key={item.id} item={item} />)}</div><div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-3 text-xs text-muted-foreground"><span>{items.length} events · {report?.coverage ?? "Core records"}</span><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={!cursor} onClick={() => { setCursor(null); }}>First page</Button><Button variant="outline" size="sm" disabled={!report?.hasMore} onClick={() => { if (report?.nextCursor) setCursor(report.nextCursor); }}>Next page</Button></div></div></>}</section>
  </>;
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return <tr className="hover:bg-secondary"><td className="whitespace-nowrap px-5 py-3 text-xs text-muted-foreground">{formatDateTime(item.occurredAt)}</td><td className="px-5 py-3"><div className="flex items-center gap-2"><span className="text-sm font-medium text-foreground">{item.action}</span><StatusBadge value={item.domain} /></div><p className="mt-1 font-mono text-[10px] text-muted-foreground">{item.id}</p></td><td className="px-5 py-3 text-xs text-muted-foreground">{item.organizationId ? <Link href={`/agencies/${item.organizationId}`} className="font-mono hover:text-primary">{item.organizationId}</Link> : "Platform"}</td><td className="px-5 py-3"><StatusBadge value={item.status} /><p className="mt-1 text-[10px] capitalize text-muted-foreground">{item.severity}</p></td><td className="px-5 py-3 text-xs text-muted-foreground">{item.resourceType}<p className="mt-1 font-mono text-[10px]">{item.resourceId}</p></td><td className="max-w-64 px-5 py-3 text-xs text-muted-foreground">{metadataText(item.metadata)}</td></tr>;
}

function ActivityCard({ item }: { item: ActivityItem }) {
  return <article className="p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{item.action}</p><p className="mt-1 text-xs text-muted-foreground">{item.domain} · {formatDateTime(item.occurredAt)}</p></div><StatusBadge value={item.status} /></div><div className="mt-3 grid gap-2 text-xs"><div className="flex justify-between gap-3"><span className="text-muted-foreground">Organization</span><span className="truncate font-mono text-foreground">{item.organizationId ?? "Platform"}</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Resource</span><span className="truncate font-mono text-foreground">{item.resourceType}:{item.resourceId}</span></div><div className="flex justify-between gap-3"><span className="text-muted-foreground">Metadata</span><span className="max-w-[65%] truncate text-right text-foreground">{metadataText(item.metadata)}</span></div></div></article>;
}

function metadataText(metadata: Record<string, unknown>) {
  return Object.entries(metadata).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ") || "—";
}
