import { adminCapabilities } from "@kasitek-labs/server-support/admin-authority";
import { requireAdminSession } from "@/lib/admin-auth";
import { AdminCrossProductReporting, type ReportDomain } from "./admin-cross-product-report";

export async function ProductReportingPage({ domain = "overview" }: { domain?: ReportDomain }) {
  const admin = await requireAdminSession();
  const capabilities = adminCapabilities(admin.role);
  return <div className="admin-page"><AdminCrossProductReporting domain={domain} canExport={capabilities.has("admin:export")} canSave={capabilities.has("admin:write")} /></div>;
}
