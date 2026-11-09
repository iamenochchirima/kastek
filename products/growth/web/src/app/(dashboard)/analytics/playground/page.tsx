import { redirect } from "react-router";
import { AnalyticsPlayground } from "@/components/analytics/analytics-playground";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchBillingSummary, planAllowsAnalytics } from "@/lib/billing";

export function meta() { return [{ title: "Analytics Playground | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader({ request }: { request: Request }) {
  if (!import.meta.env.DEV) throw new Response("Not found", { status: 404 });
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");
  const summary = await fetchBillingSummary().catch(() => null);
  if (!planAllowsAnalytics(summary)) throw redirect("/upgrade");
  return {  };
}

export default function AnalyticsPlaygroundPage() {
  return <AnalyticsPlayground />;
}
