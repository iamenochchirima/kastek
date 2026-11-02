import { adminCapabilities } from "@kasitek-labs/server-support/admin-authority";
import { requireAdminSession } from "@/lib/admin-auth";
import { AdminReportsPage } from "@/components/admin/admin-reports-page";

export const metadata = { title: "Reports | KasiTek Labs" };

export default async function ReportsPage() {
  const admin = await requireAdminSession();
  const capabilities = adminCapabilities(admin.role);
  return <div className="admin-page"><AdminReportsPage canExport={capabilities.has("admin:export")} canSave={capabilities.has("admin:write")} /></div>;
}
