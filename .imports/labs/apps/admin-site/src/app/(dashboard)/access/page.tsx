import { AdminPageHeader } from "@/components/admin/page-header";
import { UserAccessManager, type LaunchAccess } from "@/components/admin/user-access-manager";
import { fetchFromCore } from "@/lib/admin-auth";

export default async function UserAccessPage() {
  const response = await fetchFromCore("/api/admin/access");
  const payload = response.ok ? await response.json() : { access: [] };
  return <div className="admin-page"><AdminPageHeader title="User access" description="Provision launch users, create their first workspace, and manage invitation-only access." /><UserAccessManager initialAccess={(payload.access ?? []) as LaunchAccess[]} /></div>;
}
