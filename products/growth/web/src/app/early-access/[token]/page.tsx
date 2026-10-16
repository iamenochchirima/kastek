import { fetchCoreJson } from "@/lib/core-server-api";
import { getCoreSession } from "@/lib/core-auth";
import { EarlyAccessActivation } from "./early-access-activation";

export default async function EarlyAccessInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getCoreSession();
  const invitation = await fetchCoreJson<{ invitation: { email: string; status: string; expiresAt: string; businessName: string } }>(`/api/early-access/invitations/${token}`).catch(() => null);
  return <EarlyAccessActivation token={token} invitation={invitation?.invitation ?? null} isLoggedIn={Boolean(session?.user?.id)} />;
}
