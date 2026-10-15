import { PlanDetailsPage } from "@/components/dashboard/billing/plan-details-page";
import { fetchBillingPlanDetails } from "@/lib/billing";
import { getWorkspaceSession } from "@/lib/core-auth";
import { redirect } from "next/navigation";

export const metadata = { title: "Plan details | KasiTek" };

export default async function PlanDetailsRoute({ params }: { params: Promise<{ planKey: string }> }) {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) redirect("/login");
  const { planKey } = await params;
  const details = await fetchBillingPlanDetails(planKey).catch(() => null);
  if (!details) redirect("/upgrade");
  return <PlanDetailsPage details={details} />;
}
