import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, Navigate, Outlet, useNavigate, useLocation } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Robot01Icon, DashboardSquare01Icon, Task01Icon, BookOpen01Icon, Plug01Icon, CalendarClockIcon, Settings01Icon, Menu01Icon, Logout01Icon, SidebarLeft01Icon, InboxIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError, message, type Session } from "./api";
import { InboxAlertsButton, InboxAlertsDialog, useInboxAlerts } from "./inbox-alerts";

type Workspace = { organizationId: string; session: Session; createWorkspace: () => void; selectWorkspace: (id: string) => void; logout: () => Promise<void> };
const WorkspaceContext = createContext<Workspace | null>(null);
export function useWorkspace() { const value = useContext(WorkspaceContext); if (!value) throw new Error("Workspace unavailable"); return value; }
export function Loading() { return <div aria-label="Loading" className="space-y-4 py-8"><Skeleton className="h-7 w-48" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>; }
export function ErrorMessage({ value }: { value: string }) { return value ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{value}</p> : null; }
export function WorkspaceShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const resize = () => document.documentElement.style.setProperty("--workspace-height", `${viewport.height}px`);
    resize(); viewport.addEventListener("resize", resize);
    return () => { viewport.removeEventListener("resize", resize); document.documentElement.style.removeProperty("--workspace-height"); };
  }, []);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => { try { return localStorage.getItem("agents.sidebar.collapsed") === "true"; } catch { return false; } });
  const [session, setSession] = useState<Session | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const alerts = useInboxAlerts(organizationId, session?.account.id ?? "");
  const [alertsOpen, setAlertsOpen] = useState(false);
  const alertsTrigger = useRef<HTMLElement | null>(null);
  function openAlerts() { alertsTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setNavigationOpen(false); setAlertsOpen(true); }
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
  function toggleSidebar() { setSidebarCollapsed(current => { const next = !current; try { localStorage.setItem("agents.sidebar.collapsed", String(next)); } catch { /* The sidebar still works when storage is unavailable. */ } return next; }); }
  function selectWorkspace(id: string) { if (!session?.organizations.some(org => org.id === id)) return; setOrganizationId(id); sessionStorage.setItem("agents.organization", id); navigate("/app/agents"); }
  if (signedOut) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  const navigation = <>
    <Link to="/app/overview" className="workspace-brand" aria-label="Agents overview"><span className="brand-symbol"><HugeiconsIcon icon={Robot01Icon} size={19} /></span><span className="workspace-brand-label">Agents</span></Link>
    {session?.organizations.length ? <select aria-label="Workspace" className="workspace-select" value={organizationId} onChange={event => event.target.value === "new" ? setWorkspaceOpen(true) : selectWorkspace(event.target.value)}>{session.organizations.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}<option value="new">Create workspace</option></select> : null}
    <nav aria-label="Main navigation" className="workspace-navigation">{([
      ["/app/overview", "Overview", DashboardSquare01Icon], ["/app/assistant", "Assistant", Robot01Icon], ["/app/agents", "Agents", Robot01Icon], ["/app/inbox", "Inbox", InboxIcon], ["/app/customers", "Customers", UserGroupIcon], ["/app/tasks", "Tasks", Task01Icon], ["/app/knowledge", "Knowledge", BookOpen01Icon], ["/app/connections", "Connections", Plug01Icon], ["/app/automations", "Automations", CalendarClockIcon], ["/app/settings", "Settings", Settings01Icon],
    ] as const).map(([path, label, icon]) => <NavLink key={String(path)} to={String(path)} aria-label={label} title={label} onClick={() => setNavigationOpen(false)} className={({ isActive }) => `workspace-nav-link ${isActive ? "is-active" : ""}`}><HugeiconsIcon icon={icon} size={18} strokeWidth={1.6} aria-hidden="true" /><span>{String(label)}</span></NavLink>)}</nav>
    {organizationId ? <InboxAlertsButton unread={alerts.data?.unread ?? 0} onClick={openAlerts} /> : null}
    <div className="workspace-account"><span className="account-avatar">{(session?.account.displayName || session?.account.email || "A").slice(0, 1).toUpperCase()}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{session?.account.displayName || "Account"}</p><p className="truncate text-xs text-muted-foreground">{session?.account.email}</p></div><Button aria-label="Sign out" title="Sign out" size="icon" variant="ghost" onClick={() => void logout()} disabled={!session || busy}><HugeiconsIcon icon={Logout01Icon} size={16} /></Button></div>
  </>;
  return <div className={`dashboard-theme workspace-shell bg-background text-foreground ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
    <a href="#workspace-content" className="skip-link">Skip to content</a>
    <aside className="workspace-sidebar"><Button className="workspace-sidebar-toggle" variant="ghost" size="icon" aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleSidebar}><HugeiconsIcon icon={SidebarLeft01Icon} size={18} /></Button>{navigation}</aside>
    <header className="workspace-mobile-header"><Button ref={navigationTrigger} aria-label="Open navigation" size="icon" variant="ghost" onClick={() => setNavigationOpen(true)}><HugeiconsIcon icon={Menu01Icon} size={20} /></Button><Link to="/app/overview" className="font-semibold">Agents</Link><span className="ml-auto truncate text-xs text-muted-foreground">{session?.organizations.find(org => org.id === organizationId)?.name}</span>{organizationId ? <InboxAlertsButton unread={alerts.data?.unread ?? 0} onClick={openAlerts} mobile /> : null}</header>
    <Dialog open={navigationOpen} onOpenChange={setNavigationOpen}><DialogContent className="workspace-navigation-drawer" onCloseAutoFocus={event => { event.preventDefault(); navigationTrigger.current?.focus(); }}><DialogHeader><DialogTitle>Workspace navigation</DialogTitle><DialogDescription className="sr-only">Select a workspace page.</DialogDescription></DialogHeader>{navigation}<Button variant="ghost" onClick={() => setNavigationOpen(false)}><HugeiconsIcon icon={SidebarLeft01Icon} size={16} />Close navigation</Button></DialogContent></Dialog>
    <main id="workspace-content" tabIndex={-1} className={`workspace-main ${location.pathname.startsWith("/app/agents") ? "workspace-main-agents" : ""}`}>
      {error ? <div className="workspace-page space-y-3"><ErrorMessage value={error} /><Button variant="outline" onClick={() => void load()}>Try again</Button></div> : !session ? <div className="workspace-page"><Loading /></div> : !organizationId ? <section className="workspace-page space-y-4"><h1 className="text-2xl font-semibold">No workspace access</h1><Button variant="outline" onClick={() => void load()}>Try again</Button></section> : <WorkspaceContext.Provider value={{ organizationId, session, createWorkspace: () => setWorkspaceOpen(true), selectWorkspace, logout }}><div className="workspace-outlet" key={`${session.account.id}.${organizationId}`}><Outlet /></div></WorkspaceContext.Provider>}
    </main>
    <InboxAlertsDialog key={`${organizationId}.${session?.account.id}`} open={alertsOpen} onOpenChange={setAlertsOpen} controller={alerts} restoreFocus={() => { if (alertsTrigger.current?.isConnected) alertsTrigger.current.focus(); else navigationTrigger.current?.focus(); }} />
    <Dialog open={workspaceOpen} onOpenChange={setWorkspaceOpen}><DialogContent><DialogHeader><DialogTitle>Create workspace</DialogTitle><DialogDescription>Name your workspace.</DialogDescription></DialogHeader><form onSubmit={event => void createWorkspace(event)} className="space-y-4"><label className="block space-y-2 text-sm">Workspace name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label><Button type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create workspace"}</Button></form></DialogContent></Dialog>
  </div>;
}
