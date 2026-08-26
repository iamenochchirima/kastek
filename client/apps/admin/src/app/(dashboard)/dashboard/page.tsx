import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import { ArrowRight, Inbox, Plus, Users } from "lucide-react";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Lead { id: string; businessName: string; contactPerson: string; email: string; status: string; source: string; createdAt: string; }
interface Conversation { id: string; channel: string; customerIdentifier: string; customerName: string | null; status: string; lastMessageAt: string; }

export default async function DashboardPage() {
  const [leadsRes, convsRes] = await Promise.all([fetchFromCore("/api/admin/leads"), fetchFromCore("/api/admin/conversations")]);
  const leads: Lead[] = leadsRes.ok ? await leadsRes.json() : [];
  const conversations: Conversation[] = convsRes.ok ? await convsRes.json() : [];
  const statusMap: Record<string, number> = {};
  const sourceMap: Record<string, number> = {};
  for (const lead of leads) { statusMap[lead.status] = (statusMap[lead.status] ?? 0) + 1; sourceMap[lead.source] = (sourceMap[lead.source] ?? 0) + 1; }
  const sourceEntries = Object.entries(sourceMap).sort((a, b) => b[1] - a[1]);
  const maxSourceCount = Math.max(...sourceEntries.map(([, count]) => count), 1);
  const pipelineEntries = ["new", "contacted", "interested", "quoted", "won", "lost"].map((status) => ({ status, count: statusMap[status] ?? 0 }));
  const maxPipelineCount = Math.max(...pipelineEntries.map(({ count }) => count), 1);

  return <div className="admin-page">
    <AdminPageHeader eyebrow="Kasitek Labs" title="Operations overview" description="Lead, conversation, and sales activity." actions={<Link href="/leads/new" className={buttonClassName()}><Plus className="size-4" />Add lead</Link>} />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <AdminMetric label="Total leads" value={leads.length} detail="All recorded sources" />
      <AdminMetric label="New leads" value={statusMap.new ?? 0} detail="Awaiting first action" tone="info" />
      <AdminMetric label="Interested" value={statusMap.interested ?? 0} detail="Active opportunities" tone="attention" />
      <AdminMetric label="Won" value={statusMap.won ?? 0} detail="Converted businesses" tone="success" />
      <AdminMetric label="Conversations" value={conversations.length} detail="Across connected channels" />
    </section>
    <section className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader className="border-b border-border"><div><CardTitle>Lead sources</CardTitle><p className="mt-0.5 text-xs text-muted-foreground">Current opportunity mix.</p></div><span className="text-xs text-muted-foreground">{leads.length} total</span></CardHeader>
        <CardContent className="pt-2">
          {sourceEntries.length === 0 ? <p className="py-8 text-sm text-muted-foreground">No leads yet.</p> : <div className="space-y-4">{sourceEntries.map(([source, count]) => <div key={source}><div className="mb-1.5 flex items-center justify-between gap-3 text-xs"><span className="capitalize text-foreground">{source.replace(/_/g, " ")}</span><span className="font-medium tabular-nums text-muted-foreground">{count}</span></div><div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-primary transition-[width] duration-[var(--v-motion-theme)]" style={{ width: `${(count / maxSourceCount) * 100}%` }} /></div></div>)}</div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="border-b border-border"><div><CardTitle>Lead pipeline</CardTitle><p className="mt-0.5 text-xs text-muted-foreground">Current sales distribution.</p></div><Link href="/leads" className={buttonClassName({ variant: "ghost", size: "sm" })}>View leads<ArrowRight className="size-3.5" /></Link></CardHeader>
        <CardContent className="pt-2"><div className="space-y-3">{pipelineEntries.map(({ status, count }) => <div key={status} className="grid grid-cols-[6.5rem_1fr_2rem] items-center gap-3"><StatusBadge value={status} /><div className="h-2 overflow-hidden rounded-full bg-secondary"><div className="h-full rounded-full bg-brand-2 transition-[width] duration-[var(--v-motion-theme)]" style={{ width: `${count === 0 ? 0 : Math.max((count / maxPipelineCount) * 100, 4)}%` }} /></div><span className="text-right text-xs font-medium tabular-nums text-muted-foreground">{count}</span></div>)}</div></CardContent>
      </Card>
    </section>
    <section className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
      <Card>
        <CardHeader className="border-b border-border"><div><CardTitle>Recent leads</CardTitle><p className="mt-0.5 text-xs text-muted-foreground">Latest businesses added.</p></div><Link href="/leads" className={buttonClassName({ variant: "ghost", size: "sm" })}>View all<ArrowRight className="size-3.5" /></Link></CardHeader>
        {leads.slice(0, 5).length === 0 ? <p className="px-[var(--density-card-padding)] py-10 text-sm text-muted-foreground">No leads yet.</p> : <div className="divide-y divide-border">{leads.slice(0, 5).map((lead) => <Link key={lead.id} href={`/leads/${lead.id}`} className="flex items-center justify-between gap-4 px-[var(--density-card-padding)] py-3.5 hover:bg-secondary"><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{lead.businessName}</p><p className="truncate text-xs text-muted-foreground">{lead.contactPerson} · {lead.email}</p></div><StatusBadge value={lead.status} /></Link>)}</div>}
      </Card>
      <Card>
        <CardHeader className="border-b border-border"><div><CardTitle>Recent conversations</CardTitle><p className="mt-0.5 text-xs text-muted-foreground">Latest customer communication.</p></div><Link href="/conversations" className={buttonClassName({ variant: "ghost", size: "icon" })} aria-label="Open conversations"><Inbox className="size-4" /></Link></CardHeader>
        {conversations.slice(0, 5).length === 0 ? <p className="px-[var(--density-card-padding)] py-10 text-sm text-muted-foreground">No conversations yet.</p> : <div className="divide-y divide-border">{conversations.slice(0, 5).map((conversation) => <Link key={conversation.id} href={`/conversations/${conversation.id}`} className="flex items-center justify-between gap-4 px-[var(--density-card-padding)] py-3.5 hover:bg-secondary"><div className="flex min-w-0 items-center gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-md bg-secondary text-muted-foreground"><Users className="size-4" /></span><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{conversation.customerName ?? conversation.customerIdentifier}</p><p className="text-xs capitalize text-muted-foreground">{conversation.channel}</p></div></div><time className="shrink-0 text-xs text-muted-foreground">{new Date(conversation.lastMessageAt).toLocaleDateString()}</time></Link>)}</div>}
      </Card>
    </section>
  </div>;
}
