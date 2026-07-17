import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { fetchBillingSummary } from "@/lib/billing";
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
  attention: { unreadConversations: number; agentAttention: number; campaignFailures: number; socialAttention: number; connectionAttention: number };
};

export default async function WorkspacePage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const [response, billing] = await Promise.all([
    fetchRustJson<{ summary: WorkspaceSummary }>("/api/workspace/summary"),
    fetchBillingSummary().catch(() => null),
  ]);
  const summary = response.summary;
  const usageAttention = billing?.products.filter((product) => Object.entries(product.limits).some(([key, limit]) => limit > 0 && (product.usage[key] || 0) / limit >= 0.8)).length || 0;
  const billingAttention = billing?.products.filter((product) => !product.hasAccess || product.subscriptionStatus === "PAST_DUE").length || 0;
  const actions = [
    [summary.attention.unreadConversations, "/inbox", "Unread conversations", "Customer replies need a response"],
    [summary.attention.agentAttention, "/agents", "Agents need attention", "Paused or failed deployments need review"],
    [summary.attention.campaignFailures, "/campaigns", "Campaign delivery issues", "Failed or blocked campaign recipients"],
    [summary.attention.socialAttention, "/content", "Content needs attention", "Posts failed or await approval"],
    [summary.attention.connectionAttention, "/connections", "Connections need reconnection", "Provider health or credentials need review"],
    [usageAttention, "/billing", "Usage approaching a limit", "Review included usage before work is interrupted"],
    [billingAttention, "/billing", "Billing action required", "A product needs access or payment attention"],
  ].filter(([count]) => Number(count) > 0) as Array<[number, string, string, string]>;

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

        <SectionHeading title="Work that needs attention" actionHref="/inbox" actionLabel="Open Inbox" />
        <section className="overflow-hidden rounded-lg border border-border bg-card">
          {actions.length ? actions.map(([count, href, title, detail]) => <Link key={title} href={href} className="flex items-center justify-between gap-4 border-b border-border px-5 py-4 no-underline last:border-b-0 hover:bg-secondary/60"><span><span className="block text-sm font-semibold text-foreground">{title}</span><span className="mt-1 block text-xs text-muted-foreground">{detail}</span></span><span className="rounded-full bg-status-attention-soft px-2.5 py-1 text-sm font-semibold text-status-attention">{count}</span></Link>) : <EmptyState message="Nothing needs attention right now." />}
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

function EmptyState({ message, compact = false }: { message: string; compact?: boolean }) {
  return <div className={compact ? "border-t border-border py-5 text-sm text-muted-foreground" : "p-8 text-center text-sm text-muted-foreground"}>{message}</div>;
}

function OperationalLink({ href, icon: Icon, label, detail }: { href: string; icon: LucideIcon; label: string; detail: string }) {
  return <Link href={href} className="rounded-lg border border-border bg-card p-4 no-underline transition-colors hover:bg-secondary"><Icon className="size-4 text-muted-foreground" /><p className="mt-4 text-sm font-semibold text-foreground">{label}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></Link>;
}
