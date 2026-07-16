import { LayoutShell } from "@/components/dashboard/layout-shell";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { fetchBillingSummary } from "@/lib/billing";
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

  const [unreadCountResponse, orgs, activeOrgId, billingSummary] = await Promise.all([
    fetchRustJson<{ unreadCount: number }>("/api/whatsapp/inbox/unread-count").catch(
      () => ({ unreadCount: 0 }),
    ),
    fetchOrgs(),
    getActiveOrgId(),
    fetchBillingSummary().catch(() => null),
  ]);

  return (
    <>
      <ThemeScope mode="stored" />
      <LayoutShell
        user={session.user}
        inboxUnreadCount={unreadCountResponse.unreadCount}
        orgs={orgs}
        activeOrgId={activeOrgId}
        billingSummary={billingSummary}
      >
        {children}
      </LayoutShell>
    </>
  );
}
