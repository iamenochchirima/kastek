import { useLoaderData } from "react-router";
import { UpgradePage } from "@/components/dashboard/billing/upgrade-page";
import { fetchBillingPlans, fetchBillingSummary, fetchBillingTrial } from "@/lib/billing";
import { getWorkspaceSession } from "@/lib/core-auth";
import { redirect } from "react-router";

export function meta() { return [{ title: "Choose a Plan | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader({ request }: { request: Request }) {
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");

  const [planResponse, summary, trial] = await Promise.all([
    fetchBillingPlans().catch(() => ({ plans: [] })),
    fetchBillingSummary().catch(() => null),
    fetchBillingTrial().catch(() => null),
  ]);

  return { planResponse, summary, trial };
}

export default function UpgradeRoute() {
  const { planResponse, summary, trial } = useLoaderData<typeof clientLoader>();
  return <UpgradePage plans={planResponse.plans} summary={summary} trial={trial} />;
}
