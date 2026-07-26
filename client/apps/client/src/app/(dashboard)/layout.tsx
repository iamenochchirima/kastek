import { LayoutShell } from "@/components/dashboard/layout-shell";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { fetchBillingSummary } from "@/lib/billing";
import { fetchOnboardingStatus } from "@/lib/onboarding";
import { fetchProductTourStatus } from "@/lib/product-tour";
import ThemeScope from "@/components/theme-scope";
import { redirect } from "next/navigation";
import { fetchOrgs, getActiveOrgId } from "@/lib/orgs";

export default async function AuthenticatedWorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  if (!session.user.emailVerified) {
    redirect(`/verify-request?email=${encodeURIComponent(session.user.email)}`);
  }

  const [unreadCountResponse, orgs, activeOrgId, billingSummary, onboardingStatus, productTourStatus] = await Promise.all([
    fetchRustJson<{ unreadCount: number }>("/api/whatsapp/inbox/unread-count").catch(
      () => ({ unreadCount: 0 }),
    ),
    fetchOrgs(),
    getActiveOrgId(),
    fetchBillingSummary().catch(() => null),
    fetchOnboardingStatus(),
    fetchProductTourStatus().catch(() => null),
  ]);

  if (onboardingStatus?.needsOnboarding) redirect("/onboarding");

  return (
    <>
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
