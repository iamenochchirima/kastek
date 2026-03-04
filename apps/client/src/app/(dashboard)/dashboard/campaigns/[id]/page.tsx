import { redirect } from "next/navigation";

export default async function LegacyCampaignDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/dashboard/campaigns/whatsapp/${id}`);
}
