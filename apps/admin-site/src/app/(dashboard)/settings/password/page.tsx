import { AdminPageHeader } from "@/components/admin/page-header";
import { LegacyPasswordSettings } from "@/components/admin/legacy-password-settings";
import { requireAdminSession } from "@/lib/admin-auth";

export default async function PasswordSettingsPage() {
  await requireAdminSession();
  if (!process.env.OPS_BACKEND_URL) return <LegacyPasswordSettings />;
  return (
    <div className="admin-page max-w-2xl">
      <AdminPageHeader title="Password" />
      <p className="mt-5 text-sm text-muted-foreground">Password changes are managed by Labs identity.</p>
    </div>
  );
}
