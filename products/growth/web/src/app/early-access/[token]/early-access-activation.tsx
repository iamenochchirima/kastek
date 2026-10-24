"use client";

import { useEffect, useState } from "react";
import { useNavigate, useRevalidator } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/server-api";
import { loginUrl } from "@/lib/shared-login";

type Workspace = { id: string; name: string };

type Invitation = {
  email: string;
  status: string;
  expiresAt: string;
  businessName: string;
};

type Props = {
  token: string;
  invitation: Invitation | null;
  isLoggedIn: boolean;
};

export function EarlyAccessActivation({ token, invitation, isLoggedIn }: Props) {
  const navigateTo = useNavigate();
  const revalidator = useRevalidator();
  const [workspaceName, setWorkspaceName] = useState(invitation?.businessName ?? "");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const authenticated = isLoggedIn;
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(isLoggedIn);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authenticated) return;

    let cancelled = false;
    void fetch(apiUrl("/api/orgs"), { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { orgs?: Workspace[] } | null) => {
        if (!cancelled) setWorkspaces(body?.orgs ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadingWorkspaces(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  if (!invitation || invitation.status !== "pending" || new Date(invitation.expiresAt) < new Date()) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center p-6">
        <div>
          <h1 className="text-xl font-semibold">Invitation unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">This early-access invitation is invalid or has expired.</p>
        </div>
      </main>
    );
  }

  async function activate() {
    if (!workspaceId && !workspaceName.trim()) {
      setError("Choose a workspace or enter a workspace name.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetch(apiUrl(`/api/early-access/invitations/${token}/activate`), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          organizationId: workspaceId || undefined,
          workspaceName: workspaceId ? undefined : workspaceName.trim(),
        }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.error ?? "Unable to activate early access.");
        return;
      }

      navigateTo("/workspace");
      revalidator.revalidate();
    } catch {
      setError("We could not reach KasiTek. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center p-6">
      <div className="w-full space-y-5 rounded-xl border border-border bg-card p-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-primary">Early access</p>
          <h1 className="mt-1 text-2xl font-semibold">You’re approved</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {authenticated ? "Choose a workspace to activate beta access." : "Create your account, then choose a workspace."}
          </p>
        </div>

        <p className="text-sm text-muted-foreground">{invitation.email}</p>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

        {authenticated ? (
          <div className="space-y-3">
            {loadingWorkspaces ? <p className="text-sm text-muted-foreground">Loading workspaces…</p> : null}
            {!loadingWorkspaces && workspaces.length ? (
              <label className="block text-sm font-medium">
                Workspace
                <select
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={workspaceId || "new"}
                  onChange={(event) => setWorkspaceId(event.target.value === "new" ? "" : event.target.value)}
                >
                  <option value="new">Create a new workspace</option>
                  {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
              </label>
            ) : null}
            {!loadingWorkspaces && !workspaceId ? (
              <label className="block text-sm font-medium">
                Workspace name
                <Input className="mt-1" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} />
              </label>
            ) : null}
            <Button className="w-full" disabled={busy || loadingWorkspaces} onClick={() => void activate()}>
              {busy ? "Activating…" : "Activate early access"}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Button asChild className="w-full"><a href={loginUrl(`/early-access/${encodeURIComponent(token)}`, true)}>Create account</a></Button>
            <Button asChild className="w-full" variant="outline"><a href={loginUrl(`/early-access/${encodeURIComponent(token)}`)}>Sign in</a></Button>
          </div>
        )}
      </div>
    </main>
  );
}
