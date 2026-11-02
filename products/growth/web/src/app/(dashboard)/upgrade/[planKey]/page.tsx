import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { PlanDetailsPage } from "@/components/dashboard/billing/plan-details-page";
import { fetchBillingPlanDetails } from "@/lib/billing";
import { getWorkspaceSession } from "@/lib/core-auth";
import { redirect } from "react-router";

export function meta() { return [{ title: "Plan details | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const params = (route.params as { planKey: string });

  const session = await getWorkspaceSession(route.request);
  if (!session?.user?.id) throw redirect("/login");
  const { planKey } = params;
  const details = await fetchBillingPlanDetails(planKey).catch(() => null);
  if (!details) throw redirect("/upgrade");
  return { details };
}

export default function PlanDetailsRoute() {
  const { details } = useLoaderData<typeof clientLoader>();
  return <PlanDetailsPage details={details} />;
}
