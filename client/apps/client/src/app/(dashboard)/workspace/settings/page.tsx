import { getRustSession } from "@/lib/rust-auth";
import { fetchOrgs, fetchOrgMembers, getActiveOrgId, type Org } from "@/lib/orgs";
import { redirect } from "next/navigation";
import { WorkspaceSettingsClient } from "./workspace-settings-client";

export const metadata = { title: "Workspace settings | KasiTek" };

export default async function WorkspaceSettingsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const orgs = await fetchOrgs();
  const activeId = await getActiveOrgId();
  const org: Org | undefined = (activeId ? orgs.find((item) => item.id === activeId) : undefined) ?? orgs[0];
  if (!org) redirect("/workspace");
  const members = await fetchOrgMembers(org.id).catch(() => []);
  const role = members.find((member) => member.userId === session.user.id)?.role ?? "MEMBER";
  return <WorkspaceSettingsClient org={org} canManage={role === "OWNER" || role === "ADMIN"} />;
}
