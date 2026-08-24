import { AnalyticsDashboard } from "@/components/social/analytics-dashboard";
import { AnalyticsCatalogStatus } from "@/components/analytics/analytics-catalog-status";

export const metadata = { title: "Analytics | KasiTek" };

export default function AnalyticsPage() {
  return (
    <>
      <AnalyticsCatalogStatus />
      <AnalyticsDashboard />
    </>
  );
}
