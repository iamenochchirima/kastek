import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import { ArrowRight, Inbox, Plus, Users } from "lucide-react";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";

interface Lead { id: string; businessName: string; contactPerson: string; email: string; status: string; source: string; createdAt: string; }
interface Conversation { id: string; channel: string; customerIdentifier: string; customerName: string | null; status: string; lastMessageAt: string; }

export default async function DashboardPage() {
  const [leadsRes, convsRes] = await Promise.all([fetchFromCore("/api/admin/leads"), fetchFromCore("/api/admin/conversations")]);
  const leads: Lead[] = leadsRes.ok ? await leadsRes.json() : [];
  const conversations: Conversation[] = convsRes.ok ? await convsRes.json() : [];
  const statusMap: Record<string, number> = {};
  const sourceMap: Record<string, number> = {};
  for (const lead of leads) { statusMap[lead.status] = (statusMap[lead.status] ?? 0) + 1; sourceMap[lead.source] = (sourceMap[lead.source] ?? 0) + 1; }

  return <div className="admin-page">
    <AdminPageHeader eyebrow="KasiTek platform" title="Operations overview" description="Current lead, conversation, and sales activity across the internal workspace." actions={<Link href="/leads/new" className={buttonClassName()}><Plus className="size-4" />Add lead</Link>} />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <AdminMetric label="Total leads" value={leads.length} detail="All recorded sources" />
      <AdminMetric label="New leads" value={statusMap.new ?? 0} detail="Awaiting first action" tone="info" />
      <AdminMetric label="Interested" value={statusMap.interested ?? 0} detail="Active opportunities" tone="attention" />
      <AdminMetric label="Won" value={statusMap.won ?? 0} detail="Converted businesses" tone="success" />
      <AdminMetric label="Conversations" value={conversations.length} detail="Across connected channels" />
    </section>
    <section className="grid gap-5 lg:grid-cols-2">
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Lead sources</h2><p className="mt-1 text-xs text-muted-foreground">Where current opportunities originate.</p></div><div className="divide-y divide-border">{Object.entries(sourceMap).length === 0 ? <p className="px-5 py-10 text-sm text-muted-foreground">No leads yet.</p> : Object.entries(sourceMap).sort((a, b) => b[1] - a[1]).map(([source, count]) => <div key={source} className="flex items-center justify-between px-5 py-3"><span className="text-sm capitalize text-foreground">{source.replace(/_/g, " ")}</span><span className="text-sm font-semibold text-foreground">{count}</span></div>)}</div></article>
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Lead pipeline</h2><p className="mt-1 text-xs text-muted-foreground">Distribution by current sales status.</p></div><div className="divide-y divide-border">{["new", "contacted", "interested", "quoted", "won", "lost"].map((status) => <div key={status} className="flex items-center justify-between px-5 py-3"><StatusBadge value={status} /><span className="text-sm font-semibold text-foreground">{statusMap[status] ?? 0}</span></div>)}</div></article>
    </section>
    <section className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
      <article className="rounded-lg border border-border bg-card"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="text-sm font-semibold text-foreground">Recent leads</h2><p className="mt-1 text-xs text-muted-foreground">Latest businesses added to the pipeline.</p></div><Link href="/leads" className={buttonClassName({ variant: "ghost", size: "sm" })}>View all<ArrowRight className="size-3.5" /></Link></div>{leads.slice(0, 5).length === 0 ? <p className="px-5 py-10 text-sm text-muted-foreground">No leads yet. Add your first lead to get started.</p> : <div className="divide-y divide-border">{leads.slice(0, 5).map((lead) => <Link key={lead.id} href={`/leads/${lead.id}`} className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-secondary"><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{lead.businessName}</p><p className="truncate text-xs text-muted-foreground">{lead.contactPerson} · {lead.email}</p></div><StatusBadge value={lead.status} /></Link>)}</div>}</article>
      <article className="rounded-lg border border-border bg-card"><div className="flex items-center justify-between border-b border-border px-5 py-4"><div><h2 className="text-sm font-semibold text-foreground">Recent conversations</h2><p className="mt-1 text-xs text-muted-foreground">Latest customer communication.</p></div><Link href="/conversations" className={buttonClassName({ variant: "ghost", size: "icon" })} aria-label="Open conversations"><Inbox className="size-4" /></Link></div>{conversations.slice(0, 5).length === 0 ? <p className="px-5 py-10 text-sm text-muted-foreground">No conversations yet.</p> : <div className="divide-y divide-border">{conversations.slice(0, 5).map((conversation) => <Link key={conversation.id} href={`/conversations/${conversation.id}`} className="flex items-center justify-between gap-4 px-5 py-3.5 hover:bg-secondary"><div className="flex min-w-0 items-center gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground"><Users className="size-4" /></span><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{conversation.customerName ?? conversation.customerIdentifier}</p><p className="text-xs capitalize text-muted-foreground">{conversation.channel}</p></div></div><time className="shrink-0 text-xs text-muted-foreground">{new Date(conversation.lastMessageAt).toLocaleDateString()}</time></Link>)}</div>}</article>
    </section>
  </div>;
}
