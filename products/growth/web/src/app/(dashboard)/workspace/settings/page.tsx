import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchOrgs, fetchOrgMembers, getActiveOrgId, type Org } from "@/lib/orgs";
import { fetchBillingCredits, fetchBillingPlans, fetchBillingSummary, fetchBillingUsage } from "@/lib/billing";
import { fetchCoreJson } from "@/lib/core-server-api";
import { redirect } from "react-router";
import { WorkspaceSettingsClient, type WorkspaceProfile } from "./workspace-settings-client";

export function meta() { return [{ title: "Settings | KasiTek" }]; }

type SettingsSearchParams = {
  section?: string | string[];
  payment?: string | string[];
  reference?: string | string[];
  trxref?: string | string[];
};

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const search = new URL(route.request.url).searchParams;
  const searchParams = (Object.fromEntries([...search.keys()].map(key => [key, search.getAll(key).length > 1 ? search.getAll(key) : search.get(key)!])) as SettingsSearchParams);

  const { section, payment, reference, trxref } = searchParams;
  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");
  const sectionValue = Array.isArray(section) ? section[0] : section;
  if (sectionValue === "api-keys") throw redirect("/developers/api-keys");
  const orgs = await fetchOrgs();
  const activeId = await getActiveOrgId();
  const org: Org | undefined = (activeId ? orgs.find((item) => item.id === activeId) : undefined) ?? orgs[0];
  if (!org) throw redirect("/workspace");
  const [members, billingSummary, billingPlans, billingCredits, billingUsage, profile] = await Promise.all([
    fetchOrgMembers(org.id).catch(() => []),
    fetchBillingSummary().catch(() => null),
    fetchBillingPlans().catch(() => ({ plans: [] })),
    fetchBillingCredits().catch(() => null),
    fetchBillingUsage().catch(() => null),
    fetchCoreJson<WorkspaceProfile>("/api/profile").catch(() => null),
  ]);
  if (!profile?.user) throw redirect("/login");
  const role = members.find((member) => member.userId === session.user.id)?.role ?? "MEMBER";
  const initialTab = ["profile", "organization", "appearance", "notifications", "billing", "usage"].includes(sectionValue ?? "")
    ? sectionValue as "profile" | "organization" | "appearance" | "notifications" | "billing" | "usage"
    : "profile";
  const query = {
    payment: Array.isArray(payment) ? payment[0] : payment,
    reference: Array.isArray(reference) ? reference[0] : reference,
    trxref: Array.isArray(trxref) ? trxref[0] : trxref,
  };

  return { org, billingSummary, billingPlans, billingCredits, billingUsage, profile, role, initialTab, query };
}

export default function WorkspaceSettingsPage() {
  const { org, billingSummary, billingPlans, billingCredits, billingUsage, profile, role, initialTab, query } = useLoaderData<typeof clientLoader>();
  return (
    <WorkspaceSettingsClient
      org={org}
      canManage={role === "OWNER" || role === "ADMIN"}
      profile={profile}
      initialTab={initialTab}
      billingSummary={billingSummary}
      billingPlans={billingPlans}
      billingCredits={billingCredits}
      billingUsage={billingUsage}
      billingQuery={query}
    />
  );
}
