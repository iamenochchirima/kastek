import { UpgradePage } from "@/components/dashboard/billing/upgrade-page";
import { fetchBillingPlans, fetchBillingSummary } from "@/lib/billing";
import { getWorkspaceSession } from "@/lib/core-auth";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Choose a Plan | KasiTek",
};

export default async function UpgradeRoute() {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) redirect("/login");

  const [planResponse, summary] = await Promise.all([
    fetchBillingPlans().catch(() => ({ plans: [] })),
    fetchBillingSummary().catch(() => null),
  ]);

  return <UpgradePage plans={planResponse.plans} summary={summary} />;
}
