import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLoaderData, useLocation, useNavigation } from "react-router-dom";
import { Bot, Cable, ChevronLeft, ChevronRight, Home, Inbox, Library, Menu, Moon, Settings, Sparkles, Sun, ChartNoAxesCombined } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { setTheme, useAppearance, resolveTheme } from "@/lib/appearance";
import { selectWorkspace, type Session } from "@/lib/session";
import { fetchApiJson } from "@/lib/api-client";

const groups = [
  { label: "Workspace", items: [{ name: "Overview", path: "/app", icon: Home, end: true }, { name: "Agents", path: "/app/agents", icon: Bot }, { name: "Inbox", path: "/app/inbox", icon: Inbox }] },
  { label: "Resources", items: [{ name: "Knowledge", path: "/app/knowledge", icon: Library }, { name: "Connections", path: "/app/connections", icon: Cable }] },
  { label: "Manage", items: [{ name: "Usage", path: "/app/usage", icon: ChartNoAxesCombined }, { name: "Settings", path: "/app/settings", icon: Settings }] },
];

export function AppShell() {
  const session = useLoaderData() as Session;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("kasitek-agents-sidebar-collapsed") === "1");
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileNavigationTrigger = useRef<HTMLButtonElement>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const appearance = useAppearance();
  const location = useLocation(); const navigation = useNavigation();
  const title = groups.flatMap(group => group.items).find(item => item.end ? location.pathname === item.path : location.pathname.startsWith(item.path))?.name ?? "Agent workspace";
  useEffect(() => {
    let lastActivity = 0;
    function recordActivity() {
      if (document.visibilityState !== "visible" || Date.now() - lastActivity < 60_000) return;
      lastActivity = Date.now();
      void fetchApiJson("/api/auth/activity", { method: "POST" }).catch(() => {});
    }
    document.addEventListener("pointerdown", recordActivity);
    document.addEventListener("keydown", recordActivity);
    return () => { document.removeEventListener("pointerdown", recordActivity); document.removeEventListener("keydown", recordActivity); };
  }, []);
  async function switchWorkspace(id: string) {
    setSwitching(true); setSwitchError("");
    try { await selectWorkspace(id); window.location.assign("/app"); }
    catch { setSwitchError("Couldn't switch workspace. Please try again."); setSwitching(false); }
  }
  function toggleCollapsed() { const value = !collapsed; setCollapsed(value); localStorage.setItem("kasitek-agents-sidebar-collapsed", value ? "1" : "0"); }
  const sidebar = (compact: boolean) => <>
    <a href="/" className={cn("flex h-16 items-center gap-3 border-b border-border px-5 font-semibold tracking-tight", compact && "justify-center px-2")} aria-label="KasiTek Agents home"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-4" /></span>{!compact && <span>KasiTek <span className="font-normal text-muted-foreground">Agents</span></span>}</a>
    <nav aria-label="Workspace navigation" className="flex-1 space-y-5 overflow-y-auto px-3 py-5">{groups.map(group => <section key={group.label}>
      {!compact && <h2 className="px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-[.16em] text-muted-foreground">{group.label}</h2>}
      <div className="space-y-1">{group.items.map(item => <NavLink key={item.path} to={item.path} end={item.end} onClick={() => setMobileOpen(false)} title={compact ? item.name : undefined} className={({ isActive }) => cn("relative flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors", compact && "justify-center px-0", isActive ? "bg-sidebar-accent font-medium text-primary before:absolute before:left-0 before:h-5 before:w-[3px] before:rounded-r-full before:bg-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}><item.icon className="size-[18px] shrink-0" />{!compact && item.name}</NavLink>)}</div>
    </section>)}</nav>
    <div className="border-t border-border p-3">{!compact && <div className="mb-3 truncate px-2 text-xs text-muted-foreground">{session.user.name || session.user.email}</div>}<Button variant="ghost" className="w-full text-muted-foreground" size="sm" onClick={toggleCollapsed} aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}>{compact ? <ChevronRight /> : <><ChevronLeft />Collapse sidebar</>}</Button></div>
  </>;
  return <div className="dashboard-theme min-h-dvh bg-background">
    <aside className={cn("fixed inset-y-0 left-0 z-20 hidden flex-col border-r border-border bg-sidebar transition-[width] md:flex", collapsed ? "w-[68px]" : "w-[264px]")}>{sidebar(collapsed)}</aside>
    <Dialog open={mobileOpen} onOpenChange={setMobileOpen}><DialogContent onCloseAutoFocus={event => { event.preventDefault(); mobileNavigationTrigger.current?.focus(); }} className="inset-y-0 left-0 flex h-dvh max-h-dvh w-[264px] max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-sidebar p-0 sm:max-w-[264px]"><DialogTitle className="sr-only">Workspace navigation</DialogTitle><DialogDescription className="sr-only">Navigate your Agents workspace.</DialogDescription>{sidebar(false)}</DialogContent></Dialog>

    <div className={cn("min-w-0 transition-[padding]", collapsed ? "md:pl-[68px]" : "md:pl-[264px]")}>
      <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 backdrop-blur-sm sm:px-7"><div className="flex min-w-0 items-center gap-3"><Button ref={mobileNavigationTrigger} variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu /></Button><label htmlFor="active-workspace" className="sr-only">Workspace</label><select id="active-workspace" aria-label="Workspace" value={session.activeOrganizationId ?? ""} disabled={switching} onChange={event => void switchWorkspace(event.target.value)} className="min-w-0 max-w-40 rounded-md border border-border bg-background px-2 py-1 text-sm sm:max-w-56">{session.organizations?.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select><span className="hidden text-border sm:block">/</span><span className="text-sm font-medium">{title}</span></div><div className="flex items-center gap-2"><Button variant="ghost" size="icon" aria-label="Toggle theme" onClick={() => setTheme(resolveTheme(appearance.theme) === "dark" ? "light" : "dark")}>{resolveTheme(appearance.theme) === "dark" ? <Sun /> : <Moon />}</Button><Button asChild variant="ghost" size="sm"><NavLink to="/app/settings" aria-label="Account"><Settings /><span className="hidden sm:inline">Account</span></NavLink></Button></div></header>
      {switchError && <p role="alert" className="border-b border-border px-7 py-2 text-xs text-destructive">{switchError}</p>}
      {navigation.state !== "idle" && <div role="status" className="border-b border-border px-7 py-2 text-xs text-muted-foreground">Loading…</div>}
      <main id="main-content" className="min-w-0"><Outlet /></main>
    </div>
  </div>;
}
