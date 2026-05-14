import { fetchRustJson } from "@/lib/rust-server-api";
import { getRustSession } from "@/lib/rust-auth";
import type { InvitationPreview } from "@/lib/orgs";
import { AcceptInviteClient } from "./accept-invite-client";

export const metadata = { title: "Accept Invitation | KasiTek" };

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await getRustSession();

  let invitation: InvitationPreview | null = null;
  try {
    const data = await fetchRustJson<{ invitation: InvitationPreview }>(
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
      currentUserEmail={session?.user?.email ?? null}
    />
  );
}
