import { fetchCoreJson } from "@/lib/core-server-api";
import { getCoreSession } from "@/lib/core-auth";
import type { InvitationPreview } from "@/lib/orgs";
import { AcceptInviteClient } from "./accept-invite-client";

export const metadata = { title: "Accept Invitation | KasiTek" };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getCoreSession();

  let invitation: InvitationPreview | null = null;
  try {
    const data = await fetchCoreJson<{ invitation: InvitationPreview }>(
      `/api/invitations/${token}`,
    );
    invitation = data.invitation;
  } catch {
    invitation = null;
  }

  return (
    <AcceptInviteClient
      token={token}
      invitation={invitation}
      isLoggedIn={!!session?.user?.id}
    />
  );
}
