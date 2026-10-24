import { useLoaderData } from "react-router";
import { Outlet } from "react-router";
import { LayoutShell } from "@/components/dashboard/layout-shell";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchCoreJson } from "@/lib/core-server-api";
import { fetchBillingSummary } from "@/lib/billing";
import { fetchOnboardingStatus } from "@/lib/onboarding";
import { fetchProductTourStatus } from "@/lib/product-tour";
import { SessionActivity } from "@/components/auth/session-activity";
import ThemeScope from "@/components/theme-scope";
import { redirect } from "react-router";
import { fetchOrgs, getActiveOrgId } from "@/lib/orgs";

export async function clientLoader() {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");

  const orgs = await fetchOrgs();
  if (!orgs.length) throw redirect("/onboarding");

  const [unreadCountResponse, activeOrgId, billingSummary, onboardingStatus, productTourStatus] = await Promise.all([
    fetchCoreJson<{ unreadCount: number }>("/api/whatsapp/inbox/unread-count").catch(
      () => ({ unreadCount: 0 }),
    ),
    getActiveOrgId(),
    fetchBillingSummary().catch(() => null),
    fetchOnboardingStatus(),
    fetchProductTourStatus().catch(() => null),
  ]);

  if (onboardingStatus?.needsOnboarding) throw redirect("/onboarding");

  return { session, orgs, unreadCountResponse, activeOrgId, billingSummary, productTourStatus };
}

export default function AuthenticatedWorkspaceLayout() {
  const { session, orgs, unreadCountResponse, activeOrgId, billingSummary, productTourStatus } = useLoaderData<typeof clientLoader>();
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
        <Outlet />
      </LayoutShell>
    </>
  );
}
