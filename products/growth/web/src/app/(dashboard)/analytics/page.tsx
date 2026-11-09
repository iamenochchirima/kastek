import { redirect } from "react-router";

import { AnalyticsCatalogStatus } from "@/components/analytics/analytics-catalog-status";
import { WorkspaceAnalyticsOverview } from "@/components/dashboard/workspace-analytics-overview";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { fetchBillingSummary, planAllowsAnalytics } from "@/lib/billing";
import { getWorkspaceSession } from "@/lib/core-auth";

export function meta() { return [{ title: "Analytics | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader({ request }: { request: Request }) {
  const session = await getWorkspaceSession(request);
  if (!session?.user?.id) throw redirect("/login");
  const summary = await fetchBillingSummary().catch(() => null);
  if (!planAllowsAnalytics(summary)) throw redirect("/upgrade");
  return null;
}

export default function AnalyticsPage() {
  return (
    <>
      <AnalyticsCatalogStatus />
      <div className="px-4 py-6 lg:px-6">
        <div className="mx-auto max-w-[1440px]">
          <PageHeader>
            <PageHeaderContent>
              <PageHeaderDescription>Reporting</PageHeaderDescription>
              <PageHeaderTitle>Analytics</PageHeaderTitle>
            </PageHeaderContent>
          </PageHeader>
          <WorkspaceAnalyticsOverview />
        </div>
      </div>
    </>
  );
}
