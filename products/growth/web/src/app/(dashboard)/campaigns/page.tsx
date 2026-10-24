import { useLoaderData } from "react-router";
import CampaignsPageClient from "@/components/dashboard/campaigns/campaigns-page-client";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";

export function meta() { return [{ title: "Campaigns | KasiTek" }]; }

export async function clientLoader() {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");

  const campaignResponse = await fetchCoreJson<{
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

  return { campaignResponse };
}

export default function ReachCampaignsPage() {
  const { campaignResponse } = useLoaderData<typeof clientLoader>();
  return <CampaignsPageClient campaigns={campaignResponse.campaigns} />;
}
