import { getRustSession } from "@/lib/rust-auth";
import { fetchOrgs, fetchOrgMembers, getActiveOrgId, type Org } from "@/lib/orgs";
import { fetchBillingPlans, fetchBillingSummary } from "@/lib/billing";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import { WorkspaceSettingsClient, type WorkspaceProfile } from "./workspace-settings-client";

export const metadata = { title: "Settings | KasiTek" };

type SettingsSearchParams = {
  section?: string | string[];
  payment?: string | string[];
  reference?: string | string[];
  trxref?: string | string[];
};

export default async function WorkspaceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<SettingsSearchParams>;
}) {
  const { section, payment, reference, trxref } = await searchParams;
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const sectionValue = Array.isArray(section) ? section[0] : section;
  if (sectionValue === "api-keys") redirect("/developers/api-keys");
  const orgs = await fetchOrgs();
  const activeId = await getActiveOrgId();
  const org: Org | undefined = (activeId ? orgs.find((item) => item.id === activeId) : undefined) ?? orgs[0];
  if (!org) redirect("/workspace");
  const [members, billingSummary, billingPlans, profile] = await Promise.all([
    fetchOrgMembers(org.id).catch(() => []),
    fetchBillingSummary().catch(() => null),
    fetchBillingPlans().catch(() => ({ plans: [] })),
    fetchRustJson<WorkspaceProfile>("/api/profile").catch(() => null),
  ]);
  if (!profile?.user) redirect("/login");
  const role = members.find((member) => member.userId === session.user.id)?.role ?? "MEMBER";
  const initialTab = ["profile", "organization", "appearance", "notifications", "billing"].includes(sectionValue ?? "")
    ? sectionValue as "profile" | "organization" | "appearance" | "notifications" | "billing"
    : "profile";
  const query = {
    payment: Array.isArray(payment) ? payment[0] : payment,
    reference: Array.isArray(reference) ? reference[0] : reference,
    trxref: Array.isArray(trxref) ? trxref[0] : trxref,
  };

  return (
    <WorkspaceSettingsClient
      org={org}
      canManage={role === "OWNER" || role === "ADMIN"}
      profile={profile}
      initialTab={initialTab}
      billingSummary={billingSummary}
      billingPlans={billingPlans}
      billingQuery={query}
    />
  );
}
