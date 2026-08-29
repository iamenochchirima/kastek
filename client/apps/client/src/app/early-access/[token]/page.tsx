import { fetchRustJson } from "@/lib/rust-server-api";
import { getRustSession } from "@/lib/rust-auth";
import { EarlyAccessActivation } from "./early-access-activation";

export default async function EarlyAccessInvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getRustSession();
  const invitation = await fetchRustJson<{ invitation: { email: string; status: string; expiresAt: string; businessName: string } }>(`/api/early-access/invitations/${token}`).catch(() => null);
  return <EarlyAccessActivation token={token} invitation={invitation?.invitation ?? null} isLoggedIn={Boolean(session?.user?.id)} />;
}
