import { useLoaderData } from "react-router";
import CampaignsPageClient from "@/components/dashboard/campaigns/campaigns-page-client";
import { getWorkspaceSession } from "@/lib/core-auth";
import { ApiError, fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";

export function meta() { return [{ title: "Campaigns | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader({ request }: { request: Request }) {
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");

  let loadError: string | null = null;
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
  }>("/api/whatsapp/campaigns").catch((error: unknown) => {
    loadError = error instanceof ApiError && error.status === 403
      ? "You don't have access to campaigns."
      : "Campaigns couldn't be loaded.";
    return { campaigns: [] };
  });

  return { campaignResponse, loadError };
}

export default function ReachCampaignsPage() {
  const { campaignResponse, loadError } = useLoaderData<typeof clientLoader>();
  return <CampaignsPageClient campaigns={campaignResponse.campaigns} loadError={loadError} />;
}
