import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { fetchCoreJson } from "@/lib/core-server-api";
import { getCoreSession } from "@/lib/core-auth";
import type { InvitationPreview } from "@/lib/orgs";
import { AcceptInviteClient } from "./accept-invite-client";

export function meta() { return [{ title: "Accept Invitation | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const params = (route.params as { token: string });

  const { token } = params;
  const session = await getCoreSession(route.request);

  let invitation: InvitationPreview | null = null;
  try {
    const data = await fetchCoreJson<{ invitation: InvitationPreview }>(
      `/api/invitations/${token}`,
    );
    invitation = data.invitation;
  } catch {
    invitation = null;
  }

  return { token, session, invitation };
}

export default function InvitePage() {
  const { token, session, invitation } = useLoaderData<typeof clientLoader>();
  return (
    <AcceptInviteClient
      token={token}
      invitation={invitation}
      isLoggedIn={!!session?.user?.id}
    />
  );
}
