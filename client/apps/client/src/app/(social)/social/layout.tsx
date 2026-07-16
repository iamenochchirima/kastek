import { LayoutShell } from "@/components/dashboard/layout-shell";
import ThemeScope from "@/components/theme-scope";
import { fetchBillingSummary } from "@/lib/billing";
import { fetchOrgs, getActiveOrgId } from "@/lib/orgs";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";

export default async function SocialLayout({ children }: { children: React.ReactNode }) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const [orgs, activeOrgId, billingSummary] = await Promise.all([
    fetchOrgs(),
    getActiveOrgId(),
    fetchBillingSummary().catch(() => null),
  ]);

  return (
    <>
      <ThemeScope mode="stored" />
      <LayoutShell
        user={session.user}
        orgs={orgs}
        activeOrgId={activeOrgId}
        billingSummary={billingSummary}
      >
        {children}
      </LayoutShell>
    </>
  );
}
