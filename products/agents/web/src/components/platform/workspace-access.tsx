import { useState, type FormEvent } from "react";
import { useLoaderData } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createWorkspace, selectWorkspace, logout, type Session } from "@/lib/session";
import { ApiError } from "@/lib/api-client";

function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) return "Your session expired. Please sign in again.";
  if (error instanceof ApiError && error.status === 403) return "You don't have access to this workspace.";
  return "We couldn't complete that request. Please try again.";
}

export function WorkspaceAccess() {
  const session = useLoaderData() as Session;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function enter(operation: () => Promise<void>) {
    setBusy(true); setError("");
    try { await operation(); window.location.assign("/app"); }
    catch (failure) { setError(messageFor(failure)); setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim()) void enter(() => createWorkspace(name.trim()));
  }
  return <main className="dashboard-theme min-h-dvh bg-background px-5 py-16">
    <section className="mx-auto max-w-md rounded-xl border border-border bg-card p-7">
      <p className="text-xs font-medium text-muted-foreground">KasiTek Agents</p>
      <h1 className="mt-3 text-2xl font-semibold">Open your workspace</h1>
      <p className="mt-3 text-sm text-muted-foreground">Signed in as {session.user.email}. Your agents and conversations belong to a workspace.</p>
      {!!session.organizations?.length && <div className="mt-6 space-y-2" aria-label="Your workspaces">
        {session.organizations.map(org => <Button key={org.id} variant="outline" className="w-full justify-start" disabled={busy} onClick={() => void enter(() => selectWorkspace(org.id))}>{org.name}</Button>)}
      </div>}
      <form onSubmit={submit} className="mt-7 space-y-3">
        <label htmlFor="workspace-name" className="text-sm font-medium">Create a workspace</label>
        <Input id="workspace-name" placeholder="Workspace name" value={name} onChange={event => setName(event.target.value)} minLength={1} maxLength={120} required disabled={busy} autoComplete="organization" />
        <Button type="submit" className="w-full" disabled={busy || !name.trim()}>{busy ? "Opening…" : "Create workspace"}</Button>
      </form>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
      <Button variant="ghost" className="mt-5 w-full" disabled={busy} onClick={() => { setBusy(true); void logout().catch(failure => { setError(messageFor(failure)); setBusy(false); }); }}>Sign out</Button>
    </section>
  </main>;
}

export function AccountSettings({ session }: { session: Session }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function signOut(everywhere: boolean) {
    setBusy(true); setError("");
    try { await logout(everywhere); }
    catch (failure) { setError(messageFor(failure)); setBusy(false); }
  }
  const workspace = session.organizations?.find(org => org.id === session.activeOrganizationId);
  return <section className="mx-auto max-w-3xl px-5 py-8 sm:px-7">
    <h1 className="text-2xl font-semibold">Account and workspace</h1>
    <div className="mt-6 rounded-lg border border-border bg-card p-5">
      <h2 className="font-medium">{session.user.name}</h2><p className="mt-1 text-sm text-muted-foreground">{session.user.email}</p>
      <div className="mt-5 flex flex-wrap gap-3"><Button variant="outline" disabled={busy} onClick={() => void signOut(false)}>Sign out</Button><Button variant="outline" disabled={busy} onClick={() => void signOut(true)}>Sign out on all devices</Button></div>
      {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    </div>
    <div className="mt-5 rounded-lg border border-border bg-card p-5"><h2 className="font-medium">{workspace?.name}</h2><p className="mt-2 text-sm text-muted-foreground">Your role: {workspace?.role ?? "Member"}</p><a href="/onboarding" className="mt-4 inline-block text-sm text-primary underline underline-offset-4">Choose or create a workspace</a><p className="mt-4 text-sm text-muted-foreground">Team invitations and role management are planned.</p></div>
  </section>;
}
