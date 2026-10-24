import { fetchCoreJson } from "@/lib/core-server-api";

export type OrgRole = "OWNER" | "ADMIN" | "MEMBER";

export type Org = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
};

export type OrgMember = {
  id: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  joinedAt: string;
  name: string | null;
  email: string | null;
  image: string | null;
};

export type OrgInvitation = {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  token: string;
  invitedById: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
  invitedByName: string | null;
};

export type InvitationPreview = {
  id: string;
  orgId: string;
  orgName: string;
  orgLogo: string | null;
  email: string;
  role: OrgRole;
  expiresAt: string;
  acceptedAt: string | null;
  invitedByName: string | null;
};

export const ACTIVE_ORG_COOKIE = "kasitek_active_org";

export async function getActiveOrgId(): Promise<string | null> {
  const data = await fetchCoreJson<{ activeOrgId: string | null }>("/api/orgs");
  return data.activeOrgId;
}

export async function fetchOrgs(): Promise<Org[]> {
  const data = await fetchCoreJson<{ orgs: Org[] }>("/api/orgs");
  return data.orgs;
}


export async function fetchOrgMembers(orgId: string): Promise<OrgMember[]> {
  const data = await fetchCoreJson<{ members: OrgMember[] }>(`/api/orgs/${orgId}/members`);
  return data.members;
}

export async function fetchOrgInvitations(orgId: string): Promise<OrgInvitation[]> {
  const data = await fetchCoreJson<{ invitations: OrgInvitation[] }>(
    `/api/orgs/${orgId}/invitations`,
  );
  return data.invitations;
}
