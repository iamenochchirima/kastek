import { getRustSession } from "@/lib/rust-auth";
import { fetchOrgs, fetchOrgMembers, fetchOrgInvitations, getActiveOrgId } from "@/lib/orgs";
import { redirect } from "next/navigation";
import { TeamPageClient } from "./team-page-client";
import type { Org, OrgMember, OrgInvitation } from "@/lib/orgs";

export const metadata = { title: "Team | KasiTek" };

export default async function TeamPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const orgs = await fetchOrgs();
  if (orgs.length === 0) redirect("/workspace");

  const activeId = await getActiveOrgId();
  const activeOrg: Org = (activeId ? orgs.find((o) => o.id === activeId) : null) ?? orgs[0]!;

  const [members, invitations] = await Promise.all([
    fetchOrgMembers(activeOrg.id).catch(() => [] as OrgMember[]),
    fetchOrgInvitations(activeOrg.id).catch(() => [] as OrgInvitation[]),
  ]);

  const currentMember = members.find((m) => m.userId === session.user.id);
  const currentRole = currentMember?.role ?? "MEMBER";

  return (
    <TeamPageClient
      org={activeOrg}
      orgs={orgs}
      members={members}
      invitations={invitations}
      currentUserId={session.user.id}
      currentRole={currentRole}
    />
  );
}
