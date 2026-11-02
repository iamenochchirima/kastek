import { InviteLookupClient } from "../../invite/invite-lookup-client";

export function meta() { return [{ title: "Redeem Invitation | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }

export default function InviteLookupPage() {
  return <InviteLookupClient />;
}
