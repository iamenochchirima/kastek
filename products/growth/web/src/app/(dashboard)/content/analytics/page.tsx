import { AnalyticsDashboard } from "@/components/social/analytics-dashboard";

export function meta() { return [{ title: "Content analytics | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function ContentAnalyticsPage() {
  return <AnalyticsDashboard />;
}
