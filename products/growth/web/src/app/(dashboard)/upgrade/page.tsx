import { useLoaderData } from "react-router";
import { UpgradePage } from "@/components/dashboard/billing/upgrade-page";
import { fetchBillingPlans, fetchBillingSummary } from "@/lib/billing";
import { getWorkspaceSession } from "@/lib/core-auth";
import { redirect } from "react-router";

export function meta() { return [{ title: "Choose a Plan | KasiTek" }]; }

export async function clientLoader() {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");

  const [planResponse, summary] = await Promise.all([
    fetchBillingPlans().catch(() => ({ plans: [] })),
    fetchBillingSummary().catch(() => null),
  ]);

  return { planResponse, summary };
}

export default function UpgradeRoute() {
  const { planResponse, summary } = useLoaderData<typeof clientLoader>();
  return <UpgradePage plans={planResponse.plans} summary={summary} />;
}
