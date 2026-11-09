import { redirect } from "react-router";

import { AnalyticsDashboard } from "@/components/social/analytics-dashboard";
import { fetchBillingSummary, planAllowsAnalytics } from "@/lib/billing";
import { getWorkspaceSession } from "@/lib/core-auth";

export function meta() { return [{ title: "Content analytics | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader({ request }: { request: Request }) {
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");
  const summary = await fetchBillingSummary().catch(() => null);
  if (!planAllowsAnalytics(summary)) throw redirect("/upgrade");
  return null;
}

export default function ContentAnalyticsPage() {
  return <AnalyticsDashboard />;
}
