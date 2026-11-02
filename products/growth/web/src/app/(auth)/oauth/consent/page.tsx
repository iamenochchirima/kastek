import { redirect, useLoaderData, type ClientLoaderFunctionArgs } from "react-router";
import { getCoreSession } from "@/lib/core-auth";
import { OAuthConsent, type OAuthConsentData } from "@/components/dashboard/developers/oauth-consent";

export function meta() { return [{title:"Connect agent | KasiTek"},{name:"robots",content:"noindex, nofollow"}]; }
export async function clientLoader({request}: ClientLoaderFunctionArgs) {
  const url = new URL(request.url);
  const session = await getCoreSession(request);
  if (!session?.user?.id) throw redirect(`/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
  const requestId = url.searchParams.get("request") ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(requestId)) return {requestId, data:null, error:"Start a new connection from your agent."};
  const response = await fetch(`/api/oauth/requests/${encodeURIComponent(requestId)}`, {credentials:"include",cache:"no-store",signal:request.signal});
  if (!response.ok) return {requestId,data:null,error:response.status === 404 ? "This connection request expired or is unavailable." : "Could not load this connection. Try again."};
  return {requestId,data:await response.json() as OAuthConsentData,error:""};
}
export default function OAuthConsentPage() { const data=useLoaderData<typeof clientLoader>(); return <OAuthConsent key={data.requestId} {...data} />; }
