import { getRustSession } from "@/lib/rust-auth";
import { fetchOrgs, fetchOrgMembers, getActiveOrgId, type Org } from "@/lib/orgs";
import { fetchBillingPlans, fetchBillingSummary } from "@/lib/billing";
import { redirect } from "next/navigation";
import { WorkspaceSettingsClient } from "./workspace-settings-client";

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
  const [members, billingSummary, billingPlans] = await Promise.all([
    fetchOrgMembers(org.id).catch(() => []),
    fetchBillingSummary().catch(() => null),
    fetchBillingPlans().catch(() => ({ plans: [] })),
  ]);
  const role = members.find((member) => member.userId === session.user.id)?.role ?? "MEMBER";
  const initialTab = ["appearance", "notifications", "billing"].includes(sectionValue ?? "")
    ? sectionValue as "appearance" | "notifications" | "billing"
    : "general";
  const query = {
    payment: Array.isArray(payment) ? payment[0] : payment,
    reference: Array.isArray(reference) ? reference[0] : reference,
    trxref: Array.isArray(trxref) ? trxref[0] : trxref,
  };

  return (
    <WorkspaceSettingsClient
      org={org}
      canManage={role === "OWNER" || role === "ADMIN"}
      initialTab={initialTab}
      billingSummary={billingSummary}
      billingPlans={billingPlans}
      billingQuery={query}
    />
  );
}
