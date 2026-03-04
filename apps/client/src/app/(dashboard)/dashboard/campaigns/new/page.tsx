import { redirect } from "next/navigation";

export default function LegacyCampaignNewRedirect() {
  redirect("/dashboard/campaigns/whatsapp/new");
}
