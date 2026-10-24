import { useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { fetchCoreJson } from "@/lib/core-server-api";
import { getCoreSession } from "@/lib/core-auth";
import { EarlyAccessActivation } from "./early-access-activation";

export async function clientLoader(route: ClientLoaderFunctionArgs) {
  const params = (route.params as { token: string });

  const { token } = params;
  const session = await getCoreSession();
  const invitation = await fetchCoreJson<{ invitation: { email: string; status: string; expiresAt: string; businessName: string } }>(`/api/early-access/invitations/${token}`).catch(() => null);
  return { token, session, invitation };
}

export default function EarlyAccessInvitationPage() {
  const { token, session, invitation } = useLoaderData<typeof clientLoader>();
  return <EarlyAccessActivation token={token} invitation={invitation?.invitation ?? null} isLoggedIn={Boolean(session?.user?.id)} />;
}

export function meta() { return [{ name: "robots", content: "noindex, nofollow" }]; }
