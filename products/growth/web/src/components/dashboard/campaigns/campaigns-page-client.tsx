import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Search, MessageCircle, ArrowRight, RotateCcw } from "@/components/ui/interface-icons";
import { Link, useRevalidator } from "react-router";
import { useMemo, useState } from "react";
import { CAMPAIGN_ANALYTICS_METRICS, FeatureAnalyticsPanel } from "@/components/analytics/feature-analytics-panel";
import "./campaigns-workspace.css";

type Campaign = {
  id: string;
  name: string;
  description: string | null;
  templateName: string;
  templateLanguage: string;
  status: string;
  scheduledAt: string | null;
  launchedAt: string | null;
  completedAt: string | null;
  totalRecipients: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  blockedCount: number;
  unsubscribedCount: number;
  createdAt: string;
  connectionLabel: string | null;
  templateStatus: string | null;
  listLabel: string | null;
  defaultBatchSize: number | null;
};

const tabs = [
  { label: "All campaigns", value: "ALL" }, { label: "Drafts", value: "DRAFT" },
  { label: "Scheduled", value: "SCHEDULED" }, { label: "Sending", value: "SENDING" },
  { label: "Completed", value: "COMPLETED" },
];
const statusOptions = ["DRAFT", "SCHEDULED", "SENDING", "PAUSED", "COMPLETED", "FAILED"];
const label = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");
function formatDate(value: string | null) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return new Date(value).toLocaleString("en-ZA", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}
function processed(c: Campaign) { return c.sentCount + c.failedCount + c.blockedCount + c.unsubscribedCount; }
const count = (n: number) => n.toLocaleString("en-ZA");

export default function CampaignsPageClient({ campaigns, loadError }: { campaigns: Campaign[]; loadError?: string | null }) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState("ALL");
  const [status, setStatus] = useState("ALL");
  const [reportOpen, setReportOpen] = useState(false);
  const revalidator = useRevalidator();
  const filtered = useMemo(() => campaigns.filter(c => {
    const needle = query.trim().toLowerCase();
    return (view === "ALL" || c.status === view) && (status === "ALL" || c.status === status) && (!needle || [c.name, c.templateName, c.status, c.connectionLabel || "", c.description || "", c.listLabel || ""].join(" ").toLowerCase().includes(needle));
  }), [campaigns, query, view, status]);
  return <section className="campaigns-workspace" aria-label="Campaigns workspace">
    <header className="campaigns-header"><h1>Campaigns</h1><Button asChild><Link to="/campaigns/create"><Plus size={16} />New campaign</Link></Button></header>
    <nav className="campaigns-tabs" aria-label="Campaign views">{tabs.map(tab => <button key={tab.value} type="button" aria-current={view === tab.value ? "page" : undefined} onClick={() => { setView(tab.value); setStatus("ALL"); }}>
      {tab.label}<span>{count(tab.value === "ALL" ? campaigns.length : campaigns.filter(c => c.status === tab.value).length)}</span>
    </button>)}</nav>
    <div className="campaigns-toolbar"><div className="campaigns-search"><Search size={17} /><Input aria-label="Search campaigns" placeholder="Search campaigns…" value={query} onChange={e => setQuery(e.target.value)} /></div>
      <Select value={status} onValueChange={value => { setStatus(value); setView("ALL"); }}><SelectTrigger aria-label="Campaign status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">All statuses</SelectItem>{[...new Set([...statusOptions, ...campaigns.map(c => c.status)])].map(s => <SelectItem value={s} key={s}>{label(s)}</SelectItem>)}</SelectContent></Select>
      <Button variant="ghost" className="campaigns-report-link" aria-expanded={reportOpen} onClick={() => setReportOpen(v => !v)}>View reporting<ArrowRight size={16} /></Button>
    </div>
    {loadError ? <div className="campaigns-empty" role="alert"><h2>{loadError}</h2><Button variant="outline" disabled={revalidator.state !== "idle"} onClick={() => revalidator.revalidate()}><RotateCcw size={16} />{revalidator.state !== "idle" ? "Retrying…" : "Try again"}</Button></div> : filtered.length === 0 ? <div className="campaigns-empty"><MessageCircle size={24} /><h2>{campaigns.length ? "No matching campaigns" : "No campaigns yet"}</h2>{campaigns.length ? <Button variant="outline" onClick={() => { setQuery(""); setStatus("ALL"); setView("ALL"); }}>Clear filters</Button> : <Button asChild><Link to="/campaigns/create">New campaign</Link></Button>}</div> : <>
      <div className="campaigns-table-scroll" role="region" aria-label="Campaign list" tabIndex={0}><table className="campaigns-table"><thead><tr><th scope="col">Campaign</th><th scope="col">Connection</th><th scope="col">Audience</th><th scope="col">Status</th><th scope="col">Recipients</th><th scope="col">Delivered</th><th scope="col">Scheduled</th></tr></thead><tbody>{filtered.map(c => <tr key={c.id}>
        <td><Link className="campaigns-name" to={`/campaigns/${c.id}`}>{c.name}</Link><div className="campaigns-secondary">{c.templateName}</div></td>
        <td><span>{c.connectionLabel || "—"}</span><div className="campaigns-secondary">WhatsApp</div></td><td>{c.listLabel || "—"}</td>
        <td><Badge className="campaign-status" data-status={c.status}>{label(c.status)}</Badge></td><td className="campaigns-number">{count(c.totalRecipients)}</td>
        <td className="campaigns-number">{count(c.deliveredCount)}<div className="campaigns-secondary">{count(c.sentCount)} sent</div></td><td className="campaigns-date">{formatDate(c.scheduledAt)}</td>
      </tr>)}</tbody></table></div>
      <div className="campaigns-mobile-list">{filtered.map(c => <Link key={c.id} to={`/campaigns/${c.id}`} className="campaigns-mobile-row"><div className="campaigns-mobile-heading"><span>{c.name}</span><Badge className="campaign-status" data-status={c.status}>{label(c.status)}</Badge></div><p className="campaigns-secondary">{c.connectionLabel || "WhatsApp"} · {c.listLabel || c.templateName}</p><dl><div><dt>Recipients</dt><dd>{count(c.totalRecipients)}</dd></div><div><dt>Delivered</dt><dd>{count(c.deliveredCount)}</dd></div><div><dt>Remaining</dt><dd>{count(Math.max(c.totalRecipients - processed(c), 0))}</dd></div></dl>{c.scheduledAt && <p className="campaigns-date">{formatDate(c.scheduledAt)}</p>}</Link>)}</div>
      <footer className="campaigns-footer">{count(filtered.length)} {filtered.length === 1 ? "campaign" : "campaigns"}</footer>
    </>}
    {reportOpen && <div className="campaigns-report"><FeatureAnalyticsPanel title="Campaign" description="" metricKeys={CAMPAIGN_ANALYTICS_METRICS} /></div>}
  </section>;
}
