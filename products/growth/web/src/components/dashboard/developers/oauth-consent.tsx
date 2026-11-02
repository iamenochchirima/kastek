import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const oauthPermissionLabels: Record<string, string> = {
  "growth:read": "Read business records",
  "growth:draft": "Create and edit records",
  "growth:publish": "Publish, schedule and send",
  "growth:manage": "Delete and manage records",
};
export type OAuthConsentData = {
  request: { clientId: string; clientName: string; scopes: string[]; resource: string };
  organizations: Array<{id: string; name: string}>;
};

export function OAuthConsent({ requestId, data, error: initialError }: {requestId: string; data: OAuthConsentData | null; error?: string}) {
  const [organizationId, setOrganizationId] = useState(data?.organizations.length === 1 ? data.organizations[0]!.id : "");
  const [scopes, setScopes] = useState(data?.request.scopes ?? []);
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState(initialError ?? "");
  async function decide(approved: boolean) {
    if (pending) return;
    setPending(approved ? "approve" : "deny"); setError("");
    try {
      const response = await fetch(`/api/oauth/requests/${encodeURIComponent(requestId)}/decision`, {
        method: "POST", credentials: "include", headers: {"Content-Type":"application/json"},
        body: JSON.stringify({approved, ...(approved ? {organizationId, scope:scopes.join(" ")} : {})}),
      });
      const result = await response.json() as {redirectUrl?: string; error?: string};
      if (!response.ok || !result.redirectUrl) throw new Error(result.error || "Could not complete this connection");
      const destination = new URL(result.redirectUrl);
      if (!["https:", "http:"].includes(destination.protocol)) throw new Error("Invalid callback address");
      window.location.assign(destination.toString());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not complete this connection"); setPending(null);
    }
  }
  if (!data) return <div className="space-y-4"><h1 className="text-xl font-semibold">Connection unavailable</h1><p role="alert" className="text-sm text-destructive">{error || "Start a new connection from your agent."}</p><Button asChild variant="outline"><Link to="/developers/mcp">Back to connections</Link></Button></div>;
  return (
    <div className="space-y-6">
      <div><h1 className="text-xl font-semibold">Connect {data.request.clientName}</h1><p className="mt-2 text-sm text-muted-foreground">Choose a workspace and permissions.</p></div>
      <div className="space-y-2"><label htmlFor="oauth-workspace" className="text-sm font-medium">Workspace</label><Select value={organizationId} onValueChange={setOrganizationId} disabled={Boolean(pending)}><SelectTrigger id="oauth-workspace" className="w-full"><SelectValue placeholder="Choose workspace" /></SelectTrigger><SelectContent>{data.organizations.map(organization => <SelectItem key={organization.id} value={organization.id}>{organization.name}</SelectItem>)}</SelectContent></Select></div>
      {data.organizations.length === 0 ? <p className="text-sm text-muted-foreground">No workspaces available. <Link to="/onboarding" className="text-primary underline">Create workspace</Link></p> : null}
      <fieldset className="space-y-3" disabled={Boolean(pending)}><legend className="mb-3 text-sm font-medium">Permissions</legend>{data.request.scopes.map(scope => <label key={scope} className="flex cursor-pointer items-start gap-3 text-sm"><Checkbox className="mt-0.5" checked={scopes.includes(scope)} onCheckedChange={checked => setScopes(current => checked === true ? [...current,scope] : current.filter(value => value !== scope))} disabled={Boolean(pending)} /><span>{oauthPermissionLabels[scope] ?? scope}</span></label>)}</fieldset>
      <p className="text-xs leading-5 text-muted-foreground">You can revoke access in Developers. Publishing still follows your approval rules.</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="outline" disabled={Boolean(pending)} onClick={() => void decide(false)}>{pending === "deny" ? "Cancelling…" : "Cancel"}</Button><Button type="button" disabled={Boolean(pending) || !organizationId || !scopes.length} onClick={() => void decide(true)}>{pending === "approve" ? "Connecting…" : "Connect"}</Button></div>
    </div>
  );
}
