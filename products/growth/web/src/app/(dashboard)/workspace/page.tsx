import { useLoaderData } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";
import { WorkspaceAnalyticsOverview } from "@/components/dashboard/workspace-analytics-overview";

export function meta() { return [{ title: "Overview | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

type WorkspaceSummary = {
  socialPostCount: number;
  attention?: { unreadConversations: number; socialAttention: number; connectionAttention: number; campaignFailures: number };
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

export async function clientLoader({ request }: { request: Request }) {
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");

  const response = await fetchCoreJson<{ summary: WorkspaceSummary }>("/api/workspace/summary");
  const summary = response.summary;
  const earlyAccessResponse = await fetchCoreJson<{
    earlyAccess: { status: string; endsAt: string | null } | null;
  }>("/api/early-access/status").catch(() => null);

  return { summary, earlyAccessResponse };
}

export default function WorkspacePage() {
  const { summary, earlyAccessResponse } = useLoaderData<typeof clientLoader>();
  return (
    <div className="px-4 py-6 lg:px-6">
      <div className="mx-auto max-w-[1440px]">

        {earlyAccessResponse?.earlyAccess ? (
          <section className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary/5 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-foreground">Beta access</p>
              <p className="mt-0.5 text-xs capitalize text-muted-foreground">{earlyAccessResponse.earlyAccess.status}{earlyAccessResponse.earlyAccess.endsAt ? ` · ends ${new Date(earlyAccessResponse.earlyAccess.endsAt).toLocaleDateString()}` : ""}</p>
            </div>
            <span className="rounded-full border border-primary/25 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-primary">Beta</span>
          </section>
        ) : null}

        <WorkspaceAnalyticsOverview summary={summary} />
      </div>
    </div>
  );
}
