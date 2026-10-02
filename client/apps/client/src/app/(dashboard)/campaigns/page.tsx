import CampaignsPageClient from "@/components/dashboard/campaigns/campaigns-page-client";
import { getWorkspaceSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Campaigns | KasiTek",
};

export default async function ReachCampaignsPage() {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) redirect("/login");

  const campaignResponse = await fetchRustJson<{
    campaigns: Array<{
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
    }>;
  }>("/api/whatsapp/campaigns").catch(() => ({ campaigns: [] }));

  return <CampaignsPageClient campaigns={campaignResponse.campaigns} />;
}
