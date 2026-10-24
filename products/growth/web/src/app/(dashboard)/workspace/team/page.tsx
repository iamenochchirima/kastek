import { useLoaderData } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { fetchOrgs, fetchOrgMembers, fetchOrgInvitations, getActiveOrgId } from "@/lib/orgs";
import { redirect } from "react-router";
import { TeamPageClient } from "./team-page-client";
import type { Org, OrgMember, OrgInvitation } from "@/lib/orgs";

export function meta() { return [{ title: "Team | KasiTek" }]; }

export async function clientLoader() {
  const session = await getWorkspaceSession();
  if (!session?.user?.id) throw redirect("/login");

  const orgs = await fetchOrgs();
  if (orgs.length === 0) throw redirect("/workspace");

  const activeId = await getActiveOrgId();
  const activeOrg: Org = (activeId ? orgs.find((o) => o.id === activeId) : null) ?? orgs[0]!;

  const [members, invitations] = await Promise.all([
    fetchOrgMembers(activeOrg.id).catch(() => [] as OrgMember[]),
    fetchOrgInvitations(activeOrg.id).catch(() => [] as OrgInvitation[]),
  ]);

  const currentMember = members.find((m) => m.userId === session.user.id);
  const currentRole = currentMember?.role ?? "MEMBER";

  return { session, orgs, activeOrg, members, invitations, currentRole };
}

export default function TeamPage() {
  const { session, orgs, activeOrg, members, invitations, currentRole } = useLoaderData<typeof clientLoader>();
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
