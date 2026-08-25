import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { Bot, FileText, MessageCircle, PlugZap, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import Link from "next/link";
import { redirect } from "next/navigation";
import { WorkspaceAnalyticsOverview } from "@/components/dashboard/workspace-analytics-overview";

export const metadata = { title: "Overview | KasiTek" };

type WorkspaceSummary = {
  agentCount: number;
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

  return (
    <div className="px-4 py-6 lg:px-6">
      <div className="mx-auto max-w-[1440px]">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderDescription>Workspace</PageHeaderDescription>
            <PageHeaderTitle>Overview</PageHeaderTitle>
          </PageHeaderContent>
          <PageHeaderActions>
            <Button asChild><Link href="/campaigns/create">New campaign</Link></Button>
          </PageHeaderActions>
        </PageHeader>

        <WorkspaceAnalyticsOverview />

        <section className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <OperationalLink href="/inbox" icon={MessageCircle} label="Inbox" detail="Open conversations and customer replies" delay={0.16} />
          <OperationalLink href="/templates" icon={FileText} label="Templates" detail={`${summary.templateStatusMap.APPROVED || 0} approved templates`} delay={0.2} />
          <OperationalLink href="/agents" icon={Bot} label="Agents" detail={`${summary.agentCount} installed agents`} delay={0.24} />
          <OperationalLink href="/connections" icon={PlugZap} label="Connections" detail={`${summary.connections.length} connected numbers`} delay={0.28} />
        </section>
      </div>
    </div>
  );
}

function OperationalLink({ href, icon: Icon, label, detail, delay }: { href: string; icon: LucideIcon; label: string; detail: string; delay: number }) {
  return <MotionReveal delay={delay} hoverLift className="h-full"><Link href={href} className="v-card group flex h-full min-h-32 flex-col p-4 no-underline transition-[border-color,background-color] duration-[150ms] hover:border-line-strong hover:bg-secondary"><Icon className="size-4 text-muted-foreground transition-colors duration-[150ms] group-hover:text-primary" /><p className="mt-4 text-sm font-semibold text-foreground">{label}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></Link></MotionReveal>;
}
