import { LayoutShell } from "@/components/dashboard/layout-shell";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { fetchBillingSummary } from "@/lib/billing";
import { fetchOnboardingStatus } from "@/lib/onboarding";
import { fetchProductTourStatus } from "@/lib/product-tour";
import { SessionActivity } from "@/components/auth/session-activity";
import ThemeScope from "@/components/theme-scope";
import { redirect } from "next/navigation";
import { fetchOrgs, getActiveOrgId } from "@/lib/orgs";

export default async function AuthenticatedWorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) redirect("/login");

  const orgs = await fetchOrgs();
  if (!orgs.length) redirect("/onboarding");

  const [unreadCountResponse, activeOrgId, billingSummary, onboardingStatus, productTourStatus] = await Promise.all([
    fetchCoreJson<{ unreadCount: number }>("/api/whatsapp/inbox/unread-count").catch(
      () => ({ unreadCount: 0 }),
    ),
    getActiveOrgId(),
    fetchBillingSummary().catch(() => null),
    fetchOnboardingStatus(),
    fetchProductTourStatus().catch(() => null),
  ]);

  if (onboardingStatus?.needsOnboarding) redirect("/onboarding");

  return (
    <>
      <SessionActivity />
      <ThemeScope mode="stored" />
      <LayoutShell
        user={session.user}
        inboxUnreadCount={unreadCountResponse.unreadCount}
        orgs={orgs}
        activeOrgId={activeOrgId}
        billingSummary={billingSummary}
        productTourStatus={productTourStatus}
      >
        {children}
      </LayoutShell>
    </>
  );
}
