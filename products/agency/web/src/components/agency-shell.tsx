import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Menu,
  Moon,
  Sun,
  Settings,
  LogOut,
  Plus,
  LayoutDashboard,
  Users,
  PenTool,
  BarChart3,
  Mail,
  SearchCheck,
  Mic,
  Star,
  Megaphone,
  MessageSquare,
  CreditCard,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AppSwitcher, buildKasitekAppLinks } from "@kasitek-labs/ui/app-switcher";
import { cn } from "@/lib/utils";
import { setTheme, useAppearance, resolveTheme } from "@/lib/appearance";
import { useAuth } from "@/lib/auth";
import { useTenantContext } from "@/lib/tenant-context-provider";
import {
  AGENCY_BUSINESSES_CHANGED,
  getAgencyWorkspaceSlug,
  openAgencyWorkspace,
  tenantFetch,
} from "@/lib/api";
import { TENANT_ROUTE_ACCESS, hasAnyTenantRole } from "@/lib/tenant-access";

type Business = { id: string; slug: string; displayName: string };
const workspaceItems = [
  ["/", "Overview", LayoutDashboard, "dashboard"],
  ["/clients", "Clients", Building2, "clients"],
  ["/leads", "Leads", Users, "leads"],
  ["/content", "Content", PenTool, "content"],
  ["/reporting", "Reporting", BarChart3, "reporting"],
  ["/nurturing", "Nurturing", Mail, "nurturing"],
  ["/aeo", "AEO", SearchCheck, "aeo"],
  ["/voice", "Voice", Mic, "voice"],
  ["/reviews", "Reputation", Star, "reviews"],
  ["/adcreative", "Ad creatives", Megaphone, "adcreative"],
  ["/billing", "Billing", CreditCard, "billing"],
  ["/settings", "Settings", Settings, "settings"],
] as const;
export function AgencyShell({
  children,
  mode = "workspace",
}: {
  children: ReactNode;
  mode?: "partner" | "workspace" | "client";
}) {
  const { user, clientUser, logout } = useAuth();
  const { brandName, logoUrl, features, context } = useTenantContext();
  const location = useLocation();
  const appearance = useAppearance();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("kasitek-agency-sidebar-collapsed") === "1";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (mode === "partner" || user?.agencyPartner) {
      let active = true;
      let request = 0;
      const refresh = () => {
        const currentRequest = ++request;
        void Promise.all([
          tenantFetch<{ businesses: Business[] }>("/api/partner/businesses"),
          tenantFetch<{ partner: { email: string } }>("/api/partner/auth/me"),
        ])
          .then(([list, account]) => {
            if (active && currentRequest === request) {
              setBusinesses(list.businesses);
              setEmail(account.partner.email);
            }
          })
          .catch(() => {});
      };
      refresh();
      window.addEventListener(AGENCY_BUSINESSES_CHANGED, refresh);
      return () => {
        active = false;
        window.removeEventListener(AGENCY_BUSINESSES_CHANGED, refresh);
      };
    }
  }, [mode, user?.agencyPartner, location.pathname]);
  const partner = mode === "partner";
  const client = mode === "client";
  const items = partner
    ? [
        { path: "/app/businesses", name: "Businesses", icon: Building2 },
        { path: "/onboarding", name: "Create business", icon: Plus },
        { path: "/app/appearance", name: "Appearance", icon: Settings },
      ]
    : client
      ? [
          { path: "/client", name: "Overview", icon: LayoutDashboard },
          { path: "/client/leads", name: "Leads", icon: Users },
          {
            path: "/client/conversations",
            name: "Conversations",
            icon: MessageSquare,
          },
        ]
      : workspaceItems
          .filter(
            ([, , , key]) =>
              (key === "billing" || features[key]) &&
              hasAnyTenantRole(user?.roles, [...TENANT_ROUTE_ACCESS[key]]),
          )
          .map(([path, name, icon]) => ({ path, name, icon }));
  if (!partner && !client && user?.agencyPartner)
    items.unshift({
      path: "/app/businesses",
      name: "My businesses",
      icon: Building2,
    });
  const title =
    partner && location.pathname.startsWith("/app/businesses/")
      ? "Business settings"
      : [...items]
          .reverse()
          .find((item) =>
            item.path === "/" || item.path === "/client"
              ? location.pathname === item.path
              : location.pathname.startsWith(item.path),
          )?.name || (partner ? "Business settings" : "Workspace");
  const appLinks = buildKasitekAppLinks({
    current: "agency",
    growthUrl:
      import.meta.env.VITE_GROWTH_APP_URL ??
      (import.meta.env.DEV ? "http://localhost:3000/workspace" : undefined),
    agentsUrl:
      import.meta.env.VITE_AGENTS_APP_URL ??
      (import.meta.env.DEV ? "http://localhost:3100/app/overview" : undefined),
  });
  const brand = partner ? "KasiTek Agency" : brandName;
  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(
        "kasitek-agency-sidebar-collapsed",
        next ? "1" : "0",
      );
    } catch {}
  }
  async function signOut() {
    try {
      if (partner) {
        const result = await tenantFetch<{ logoutUrl: string }>(
          "/api/partner/auth/logout",
          { method: "POST" },
        );
        window.location.assign(result.logoutUrl);
      } else await logout();
    } catch {
      setError("Could not sign out. Please try again.");
    }
  }
  const sidebar = (compact: boolean) => (
    <>
      <NavLink
        to="/"
        className={cn(
          "flex h-16 items-center gap-3 border-b border-border px-5 font-semibold tracking-tight",
          compact && "justify-center px-2",
        )}
        aria-label={`${brand} home`}
      >
        <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-primary text-primary-foreground">
          {!partner && logoUrl ? (
            <img src={logoUrl} alt="" className="size-full object-contain" />
          ) : (
            <Building2 className="size-4" />
          )}
        </span>
        {!compact && <span className="truncate">{brand}</span>}
      </NavLink>
      <nav
        aria-label="Workspace navigation"
        className="flex-1 space-y-5 overflow-y-auto px-3 py-5"
      >
        <section>
          {!compact && (
            <h2 className="px-2.5 pb-2 text-[10px] font-semibold uppercase tracking-[.16em] text-muted-foreground">
              {partner
                ? "Your businesses"
                : client
                  ? "Client workspace"
                  : "Workspace"}
            </h2>
          )}
          <div className="space-y-1">
            {items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === "/" || item.path === "/client"}
                onClick={() => setMobileOpen(false)}
                title={compact ? item.name : undefined}
                className={({ isActive }) =>
                  cn(
                    "relative flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors",
                    compact && "justify-center px-0",
                    isActive
                      ? "bg-sidebar-accent font-medium text-primary before:absolute before:left-0 before:h-5 before:w-[3px] before:rounded-r-full before:bg-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )
                }
              >
                <item.icon className="size-[18px] shrink-0" />
                {!compact && item.name}
              </NavLink>
            ))}
          </div>
        </section>
      </nav>
      <div className="border-t border-border p-3">
        {!compact && (
          <div className="mb-3 truncate px-2 text-xs text-muted-foreground">
            {email || user?.email || clientUser?.email}
          </div>
        )}
        <Button
          variant="ghost"
          className="w-full text-muted-foreground"
          size="sm"
          onClick={toggleCollapsed}
          aria-label={compact ? "Expand sidebar" : "Collapse sidebar"}
        >
          {compact ? (
            <ChevronRight />
          ) : (
            <>
              <ChevronLeft />
              Collapse sidebar
            </>
          )}
        </Button>
      </div>
    </>
  );
  return (
    <div className="dashboard-theme min-h-dvh bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:z-50 focus:bg-card focus:p-3"
      >
        Skip to content
      </a>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-20 hidden flex-col border-r border-border bg-sidebar transition-[width] md:flex",
          collapsed ? "w-[68px]" : "w-[264px]",
        )}
      >
        {sidebar(collapsed)}
      </aside>
      <Dialog open={mobileOpen} onOpenChange={setMobileOpen}>
        <DialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          className="inset-y-0 left-0 flex h-dvh max-h-dvh w-[264px] max-w-[85vw] translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-sidebar p-0 sm:max-w-[264px]"
        >
          <DialogTitle className="sr-only">Workspace navigation</DialogTitle>
          <DialogDescription className="sr-only">
            Navigate your Agency workspace.
          </DialogDescription>
          {sidebar(false)}
        </DialogContent>
      </Dialog>
      <div
        className={cn(
          "min-w-0 transition-[padding]",
          collapsed ? "md:pl-[68px]" : "md:pl-[264px]",
        )}
      >
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 backdrop-blur-sm sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              ref={trigger}
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu />
            </Button>
            {businesses.length > 0 ? (
              <>
                <label htmlFor="active-business" className="sr-only">
                  Business
                </label>
                <select
                  id="active-business"
                  value={
                    partner
                      ? businesses.find((b) => location.pathname.includes(b.id))
                          ?.slug || ""
                      : context.workspace?.slug ||
                        getAgencyWorkspaceSlug() ||
                        ""
                  }
                  disabled={switching}
                  onChange={(event) => {
                    setSwitching(true);
                    openAgencyWorkspace(event.target.value);
                  }}
                  className="min-w-0 max-w-40 rounded-md border border-border bg-background px-2 py-1 text-sm sm:max-w-56"
                >
                  {partner && <option value="">All businesses</option>}
                  {businesses.map((b) => (
                    <option key={b.id} value={b.slug}>
                      {b.displayName}
                    </option>
                  ))}
                </select>
                <span className="hidden text-border sm:block">/</span>
              </>
            ) : null}
            <span className="truncate text-sm font-medium">{title}</span>
          </div>
          <div className="flex items-center gap-2">
            <AppSwitcher current="agency" apps={appLinks} />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() =>
                setTheme(
                  resolveTheme(appearance.theme) === "dark" ? "light" : "dark",
                )
              }
            >
              {resolveTheme(appearance.theme) === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Sign out"
              onClick={() => void signOut()}
            >
              <LogOut />
            </Button>
          </div>
        </header>
        {error && (
          <p role="alert" className="px-7 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <main id="main-content" className="min-w-0">
          {children}
        </main>
      </div>
    </div>
  );
}
