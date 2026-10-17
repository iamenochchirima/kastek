import { createContext, useContext, useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, message, type Session } from "./api";

type Workspace = { organizationId: string; session: Session };
const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() { const value = useContext(WorkspaceContext); if (!value) throw new Error("Workspace unavailable"); return value; }
export function Loading() { return <div aria-label="Loading" className="space-y-4 py-8"><Skeleton className="h-7 w-48" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>; }
export function ErrorMessage({ value }: { value: string }) { return value ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{value}</p> : null; }
export function Login() { return <main className="dashboard-theme flex min-h-dvh items-center justify-center bg-background p-6 text-foreground"><section className="w-full max-w-sm space-y-6"><h1 className="text-3xl font-semibold tracking-tight">Agents</h1><p className="text-sm text-muted-foreground">Your support assistants.</p><Button asChild className="w-full"><a href="/api/auth/login">Sign in</a></Button></section></main>; }
export function WorkspaceShell() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setError("");
    try { const result = await api<Session>("/api/session"); setSession(result); const saved = sessionStorage.getItem("agents.organization"); setOrganizationId(result.organizations.find(org => org.id === saved)?.id ?? result.organizations[0]?.id ?? ""); }
    catch (e) { if (e instanceof ApiError && e.status === 401) setSignedOut(true); else setError(message(e)); }
  };
  useEffect(() => { void load(); }, []);
  async function createWorkspace(event: FormEvent) {
    event.preventDefault(); setBusy(true);
    try { const result = await api<{ organization: { id: string } }>("/api/organizations", { name }); await load(); setOrganizationId(result.organization.id); sessionStorage.setItem("agents.organization", result.organization.id); setWorkspaceOpen(false); setName(""); toast.success("Workspace created"); }
    catch (e) { toast.error(message(e)); } finally { setBusy(false); }
  }
  async function logout() { setBusy(true); try { const result = await api<{ redirectTo: string }>("/api/auth/logout", {}); sessionStorage.clear(); window.location.assign(result.redirectTo || "/login"); } catch (e) { toast.error(message(e)); setBusy(false); } }
  if (signedOut) return <Navigate to="/login" replace />;
  return <div className="dashboard-theme min-h-dvh bg-background text-foreground">
    <header className="border-b border-border bg-card"><div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
      <Link to="/app/agents" className="mr-1 text-xl font-semibold tracking-tight">Agents</Link>
      {session?.organizations.length ? <select aria-label="Workspace" className="min-w-0 max-w-48 rounded-md border border-border bg-background px-3 py-2 text-sm" value={organizationId} onChange={event => { if (event.target.value === "new") setWorkspaceOpen(true); else { setOrganizationId(event.target.value); sessionStorage.setItem("agents.organization", event.target.value); navigate("/app/agents"); } }}>
        {session.organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}<option value="new">Create workspace</option>
      </select> : null}
      <div className="ml-auto flex min-w-0 items-center gap-2"><span className="hidden max-w-56 truncate text-sm text-muted-foreground sm:block" title={session?.account.email}>{session?.account.displayName || session?.account.email}</span><Button size="sm" variant="ghost" onClick={() => void logout()} disabled={!session || busy}>Sign out</Button></div>
    </div></header>
    <main className="mx-auto max-w-5xl px-4 pb-12 sm:px-6">
      {error ? <div className="space-y-3 py-8"><ErrorMessage value={error} /><Button variant="outline" onClick={() => void load()}>Try again</Button></div> : !session ? <Loading /> : !organizationId ? <section className="space-y-4 py-12"><h1 className="text-2xl font-semibold">Create a workspace</h1><Button onClick={() => setWorkspaceOpen(true)}>Create workspace</Button></section> : <WorkspaceContext.Provider value={{ organizationId, session }}><nav className="mb-8 flex gap-5 overflow-x-auto border-b border-border" aria-label="Main navigation">{[["/app/agents", "Agents"], ["/app/knowledge", "Knowledge"], ["/app/connections", "Connections"], ["/app/automations", "Automations"]].map(([path, label]) => <NavLink key={path} to={path} className={({ isActive }) => `border-b-2 py-4 text-sm ${isActive ? "border-primary font-medium" : "border-transparent text-muted-foreground"}`}>{label}</NavLink>)}</nav><div key={organizationId}><Outlet /></div></WorkspaceContext.Provider>}
    </main>
    <Dialog open={workspaceOpen} onOpenChange={setWorkspaceOpen}><DialogContent><DialogHeader><DialogTitle>Create workspace</DialogTitle><DialogDescription>Name your workspace.</DialogDescription></DialogHeader><form onSubmit={event => void createWorkspace(event)} className="space-y-4"><label className="block space-y-2 text-sm">Workspace name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create workspace"}</Button></form></DialogContent></Dialog>
  </div>;
}
