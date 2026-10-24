import { AnalyticsCatalogStatus } from "@/components/analytics/analytics-catalog-status";
import { WorkspaceAnalyticsOverview } from "@/components/dashboard/workspace-analytics-overview";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";

export function meta() { return [{ title: "Analytics | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

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
