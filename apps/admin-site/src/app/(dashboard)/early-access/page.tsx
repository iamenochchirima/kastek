import { AdminPageHeader } from "@/components/admin/page-header";
import { EarlyAccessManager, type EarlyAccessApplication } from "@/components/admin/early-access-manager";
import { fetchFromCore } from "@/lib/admin-auth";

export default async function EarlyAccessPage() {
  const response = await fetchFromCore("/api/admin/early-access");
  const payload = response.ok ? await response.json() : { applications: [] };
  return (
    <div className="admin-page">
      <AdminPageHeader title="Early access" description="Grant beta access." />
      <EarlyAccessManager initialApplications={(payload.applications ?? []) as EarlyAccessApplication[]} />
    </div>
  );
}
