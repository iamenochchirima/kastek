"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiUrl } from "@/lib/server-api";

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

function googleErrorMessage(code: string | null) {
  switch (code) {
    case "google_email_mismatch":
      return "Use the Google account for this invitation.";
    case "google_cancelled":
      return "Google sign-in was cancelled.";
    case "invitation_unavailable":
      return "This early-access invitation is no longer available. Ask for a new link.";
    default:
      return "";
  }
}

export function EarlyAccessActivation({ token, invitation, isLoggedIn }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const oauthError = searchParams.get("error");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState(invitation?.businessName ?? "");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [authenticated, setAuthenticated] = useState(isLoggedIn);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(isLoggedIn);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const message = googleErrorMessage(oauthError);
    if (message) setError(message);
  }, [oauthError]);

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

      router.replace("/workspace");
      router.refresh();
    } catch {
      setError("We could not reach KasiTek. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function signup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/auth/signup"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: invitation!.email,
          name,
          password,
          earlyAccessToken: token,
        }),
      });
      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        setError(body.error ?? "Unable to create account.");
        return;
      }

      setLoadingWorkspaces(true);
      setAuthenticated(true);
      await activate();
    } catch {
      setError("We could not reach KasiTek. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function signUpWithGoogle() {
    setBusy(true);
    setError("");
    window.location.assign(
      apiUrl(`/api/auth/google/start?earlyAccessToken=${encodeURIComponent(token)}`),
    );
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
          <div className="space-y-4">
            <Button className="w-full" disabled={busy} type="button" variant="outline" onClick={signUpWithGoogle}>
              <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              Continue with Google
            </Button>
            <div className="flex items-center gap-3" aria-hidden="true">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            <form className="space-y-3" onSubmit={signup}>
            <label className="block text-sm font-medium">
              Name
              <Input className="mt-1" value={name} onChange={(event) => setName(event.target.value)} required />
            </label>
            <label className="block text-sm font-medium">
              Password
              <Input className="mt-1" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} />
            </label>
            <label className="block text-sm font-medium">
              Workspace name
              <Input className="mt-1" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} required />
            </label>
            <Button className="w-full" disabled={busy} type="submit">{busy ? "Creating…" : "Create account"}</Button>
            <button className="w-full text-sm text-primary" type="button" onClick={() => router.push(`/login?callbackUrl=${encodeURIComponent(`/early-access/${token}`)}`)}>
              Already have an account? Sign in
            </button>
            </form>
          </div>
        )}
      </div>
    </main>
  );
}
