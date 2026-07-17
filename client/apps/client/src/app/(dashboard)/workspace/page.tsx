import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { Bot, FileText, MessageCircle, PlugZap, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata = { title: "Overview | KasiTek" };

type WorkspaceSummary = {
  botCount: number;
  socialPostCount: number;
  connections: Array<{
    id: string;
    phoneDisplayNumber: string | null;
    phoneNumberId: string;
    currentQualityRating: string;
    stats: { sentLast24h: number; estimatedRemainingToday: number | null };
  }>;
  templateStatusMap: Record<string, number>;
  campaignsAggregate: {
    totalCampaigns: number;
    totalRecipients: number;
    deliveredCount: number;
    readCount: number;
    failedCount: number;
    blockedCount: number;
  };
  activeCampaigns: number;
  recentCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    totalRecipients: number;
    deliveredCount: number;
    readCount: number;
    templateName: string;
    connectionLabel: string | null;
  }>;
  contactsAggregate: { total: number; optedIn: number; excluded: number };
  sendStatusMap: Record<string, number>;
  reviewQueue: Array<{
    id: string;
    templateName: string;
    status: string;
    body: string | null;
    connectionLabel: string | null;
  }>;
};

export default async function WorkspacePage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const response = await fetchRustJson<{ summary: WorkspaceSummary }>("/api/workspace/summary");
  const summary = response.summary;
  const recipients = summary.campaignsAggregate.totalRecipients || 0;
  const delivered = summary.campaignsAggregate.deliveredCount || 0;
  const deliveryRate = recipients ? Math.round((delivered / recipients) * 100) : 0;
  const remainingToday = summary.connections.reduce(
    (total, connection) => total + (connection.stats.estimatedRemainingToday || 0),
    0,
  );

  return (
    <div className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mx-auto max-w-[1280px]">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs text-muted-foreground">Workspace</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
          </div>
          <Link
            href="/campaigns/create"
            className="inline-flex h-9 items-center rounded-md bg-primary px-3.5 text-sm font-semibold text-primary-foreground no-underline transition-opacity hover:opacity-90"
          >
            New campaign
          </Link>
        </header>

        <SectionHeading title="At a glance" actionHref="/billing" actionLabel="View usage" />
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <SummaryCard
            label="Contacts"
            value={summary.contactsAggregate.total.toLocaleString("en-ZA")}
            detail={`${summary.contactsAggregate.optedIn.toLocaleString("en-ZA")} opted in`}
          />
          <SummaryCard label="Campaign delivery" value={`${deliveryRate}%`} detail="This month" />
          <SummaryCard
            label="Templates ready"
            value={(summary.templateStatusMap.APPROVED || 0).toLocaleString("en-ZA")}
            detail={`${summary.templateStatusMap.PENDING || 0} awaiting review`}
            attention={summary.templateStatusMap.PENDING || 0}
          />
          <SummaryCard label="Active agents" value={summary.botCount.toLocaleString("en-ZA")} detail={summary.botCount ? "Automations running" : "No automations running"} />
        </section>

        <SectionHeading title="Work that needs attention" actionHref="/templates" actionLabel="See all activity" />
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.85fr)]">
          <section className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Recent campaigns</h2>
                <p className="mt-1 text-sm text-muted-foreground">Latest activity across your outbound work.</p>
              </div>
              <Link href="/campaigns" className="rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold text-foreground no-underline hover:bg-secondary">Open campaigns</Link>
            </div>
            {summary.recentCampaigns.length ? (
              <div>
                {summary.recentCampaigns.slice(0, 4).map((campaign) => (
                  <Link key={campaign.id} href={`/campaigns/${campaign.id}`} className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-5 py-3.5 no-underline last:border-b-0 hover:bg-secondary/60">
                    <span className="grid size-8 place-items-center rounded-md bg-secondary text-muted-foreground"><MessageCircle className="size-4" /></span>
                    <span className="min-w-0"><span className="block truncate text-sm font-semibold text-foreground">{campaign.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">{campaign.templateName || "No template"} · {campaign.connectionLabel || "No connection"}</span></span>
                    <Status label={campaign.status} />
                  </Link>
                ))}
              </div>
            ) : <EmptyState message="No campaigns yet. Create a campaign when you are ready to send." />}
          </section>

          <section className="rounded-lg border border-border bg-card">
            <div className="px-5 py-4"><h2 className="text-base font-semibold text-foreground">Review queue</h2><p className="mt-1 text-sm text-muted-foreground">Items that need a decision.</p></div>
            <div className="px-5 pb-2">
              {summary.reviewQueue.length ? summary.reviewQueue.slice(0, 4).map((template) => (
                <Link key={template.id} href="/templates" className="flex gap-3 border-t border-border py-3.5 no-underline first:border-t-0">
                  <span className={template.status === "REJECTED" ? "mt-1.5 size-2 shrink-0 rounded-full bg-destructive" : "mt-1.5 size-2 shrink-0 rounded-full bg-status-attention"} />
                  <span><span className="block text-sm font-semibold text-foreground">{template.templateName}</span><span className="mt-0.5 block text-xs text-muted-foreground">{template.status} · {template.connectionLabel || "No connection"}</span></span>
                </Link>
              )) : <EmptyState compact message="Nothing is waiting for review." />}
            </div>
          </section>
        </section>

        <SectionHeading title="Campaign performance" actionHref="/campaigns" actionLabel="View campaigns" />
        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,.85fr)]">
          <section className="overflow-hidden rounded-lg border border-border bg-card">
            {summary.recentCampaigns.length ? (
              <table className="w-full text-left text-sm">
                <thead className="bg-secondary/60 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"><tr><th className="px-5 py-3">Campaign</th><th className="px-3 py-3">Status</th><th className="px-3 py-3">Recipients</th><th className="px-5 py-3 text-right">Delivery</th></tr></thead>
                <tbody>{summary.recentCampaigns.slice(0, 4).map((campaign) => {
                  const campaignRate = campaign.totalRecipients ? Math.round((campaign.deliveredCount / campaign.totalRecipients) * 100) : 0;
                  return <tr key={campaign.id} className="border-t border-border"><td className="px-5 py-3 font-semibold text-foreground">{campaign.name}</td><td className="px-3 py-3"><Status label={campaign.status} /></td><td className="px-3 py-3 text-muted-foreground">{campaign.totalRecipients.toLocaleString("en-ZA")}</td><td className="px-5 py-3 text-right text-muted-foreground">{campaignRate}%</td></tr>;
                })}</tbody>
              </table>
            ) : <EmptyState message="Campaign performance will appear here after your first send." />}
          </section>
          <section className="rounded-lg border border-border bg-card p-5">
            <p className="text-sm font-medium text-muted-foreground">Monthly send capacity</p>
            <p className="mt-3 text-4xl font-semibold tracking-tight text-foreground">{remainingToday.toLocaleString("en-ZA")}<span className="ml-2 text-base font-medium text-muted-foreground">remaining</span></p>
            <p className="mt-2 text-sm text-muted-foreground">Estimated sends across connected numbers</p>
            <div className="mt-5 h-1 rounded-full bg-secondary"><div className="h-full w-[38%] rounded-full bg-muted-foreground" /></div>
            <div className="mt-2 flex justify-between text-xs text-muted-foreground"><span>{summary.campaignsAggregate.totalRecipients.toLocaleString("en-ZA")} sent</span><span>{summary.connections.length.toLocaleString("en-ZA")} connections</span></div>
          </section>
        </section>

        <section className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <OperationalLink href="/inbox" icon={MessageCircle} label="Inbox" detail="Open conversations and customer replies" />
          <OperationalLink href="/templates" icon={FileText} label="Templates" detail={`${summary.templateStatusMap.APPROVED || 0} approved templates`} />
          <OperationalLink href="/agents" icon={Bot} label="Agents" detail={`${summary.botCount} configured automations`} />
          <OperationalLink href="/connections" icon={PlugZap} label="Connections" detail={`${summary.connections.length} connected numbers`} />
        </section>
      </div>
    </div>
  );
}

function SectionHeading({ title, actionHref, actionLabel }: { title: string; actionHref: string; actionLabel: string }) {
  return <div className="mb-3 mt-8 flex items-baseline justify-between gap-4"><h2 className="text-base font-semibold text-foreground">{title}</h2><Link href={actionHref} className="text-xs font-medium text-muted-foreground no-underline hover:text-foreground">{actionLabel} →</Link></div>;
}

function SummaryCard({ label, value, detail, attention }: { label: string; value: string; detail: string; attention?: number }) {
  return <section className="min-h-28 rounded-lg border border-border bg-card p-4"><div className="flex items-start justify-between gap-2"><p className="text-sm font-medium text-muted-foreground">{label}</p>{attention ? <span className="text-xs font-medium text-status-attention">{attention} review</span> : null}</div><p className="mt-4 text-3xl font-semibold tracking-tight text-foreground">{value}</p><p className="mt-1 text-sm text-muted-foreground">{detail}</p></section>;
}

function Status({ label }: { label: string }) {
  const normalized = label.toLowerCase();
  const tone = normalized.includes("reject") || normalized.includes("fail") ? "bg-destructive" : normalized.includes("pending") || normalized.includes("draft") ? "bg-status-attention" : "bg-muted-foreground";
  return <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"><i className={`size-1.5 rounded-full ${tone}`} />{label}</span>;
}

function EmptyState({ message, compact = false }: { message: string; compact?: boolean }) {
  return <div className={compact ? "border-t border-border py-5 text-sm text-muted-foreground" : "p-8 text-center text-sm text-muted-foreground"}>{message}</div>;
}

function OperationalLink({ href, icon: Icon, label, detail }: { href: string; icon: LucideIcon; label: string; detail: string }) {
  return <Link href={href} className="rounded-lg border border-border bg-card p-4 no-underline transition-colors hover:bg-secondary"><Icon className="size-4 text-muted-foreground" /><p className="mt-4 text-sm font-semibold text-foreground">{label}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></Link>;
}
