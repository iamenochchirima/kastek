"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  Bell,
  Download,
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Grid2x2,
  LayoutGrid,
  LogOut,
  Menu,
  Moon,
  PanelLeftOpen,
  Send,
  Settings,
  Sparkles,
  Sun,
  UserRound,
  Users,
} from "lucide-react";
import Image from "next/image";
import { apiUrl } from "@/lib/server-api";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  useWhatsappInboxUnreadCount,
  WhatsappRealtimeProvider,
} from "@/components/dashboard/whatsapp-realtime-provider";
import PushNotificationReminder from "@/components/dashboard/notifications/push-notification-reminder";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import type { Org } from "@/lib/orgs";

type NavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

type ProductKey = "agents" | "reach" | "inbox" | "social";

type ProductDefinition = {
  key: ProductKey;
  name: string;
  shortName: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  nav: NavItem[];
  settingsHref?: string;
};

const products: ProductDefinition[] = [
  {
    key: "agents",
    name: "KasiAgents",
    shortName: "Agents",
    description: "AI agents, workflows, and automation logic.",
    href: "/agents",
    icon: Bot,
    nav: [{ name: "Overview", href: "/agents", icon: Bot }],
  },
  {
    key: "reach",
    name: "KasiReach",
    shortName: "Reach",
    description: "Contacts, templates, campaigns, and outbound growth.",
    href: "/reach",
    icon: Send,
    settingsHref: "/reach/settings",
    nav: [
      { name: "Overview", href: "/reach", icon: LayoutGrid },
      { name: "Contacts", href: "/reach/contacts", icon: Users },
      { name: "Templates", href: "/reach/templates", icon: FileText },
      { name: "Campaigns", href: "/reach/campaigns", icon: Send },
      { name: "Settings", href: "/reach/settings", icon: Settings },
    ],
  },
  {
    key: "inbox",
    name: "KasiInbox",
    shortName: "Inbox",
    description: "Live conversations, human replies, and team response workflows.",
    href: "/inbox",
    icon: Bell,
    nav: [{ name: "Overview", href: "/inbox", icon: Bell }],
  },
  {
    key: "social",
    name: "KasiSocial",
    shortName: "Social",
    description: "Social planning, publishing, channels, and analytics.",
    href: "/social",
    icon: Sparkles,
    nav: [
      { name: "Overview", href: "/social", icon: LayoutGrid },
      { name: "Planner", href: "/social/planner", icon: Sparkles },
      { name: "Calendar", href: "/social/calendar", icon: Bell },
      { name: "Posts", href: "/social/posts", icon: FileText },
      { name: "Channels", href: "/social/channels", icon: Users },
      { name: "Analytics", href: "/social/analytics", icon: Grid2x2 },
    ],
  },
];

type Theme = "light" | "dark";
const storageKey = "kasiai-theme";

function getTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const stored = window.localStorage.getItem(storageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeToggleSimple({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(getTheme);

  return (
    <button
      type="button"
      onClick={() => {
        const nextTheme = theme === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = nextTheme;
        document.documentElement.classList.toggle("dark", nextTheme === "dark");
        window.localStorage.setItem(storageKey, nextTheme);
        setTheme(nextTheme);
      }}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
        className,
      )}
      aria-label="Toggle theme"
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function isItemActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function getActiveProduct(pathname: string): ProductDefinition | null {
  return products.find((product) => isItemActive(pathname, product.href)) ?? null;
}

function getSectionLabel(pathname: string, activeProduct: ProductDefinition | null) {
  if (activeProduct) return activeProduct.shortName;
  if (pathname.startsWith("/workspace/team")) return "Team";
  if (pathname.startsWith("/workspace/notifications")) return "Notifications";
  if (pathname.startsWith("/workspace/profile")) return "Profile";
  return "Overview";
}

function ProductSection({
  product,
  pathname,
  collapsed,
  onNavigate,
  inboxUnreadCount,
}: {
  product: ProductDefinition;
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
  inboxUnreadCount: number;
}) {
  const active = isItemActive(pathname, product.href);
  const showBadge = product.key === "inbox" && inboxUnreadCount > 0;

  return (
    <div className="space-y-1">
      <Link
        href={product.href}
        onClick={onNavigate}
        className={cn(
          "group relative flex items-center rounded-lg text-sm font-medium transition-all duration-200 no-underline",
          collapsed ? "justify-center px-2 py-2" : "gap-2.5 px-3 py-2.5",
          active
            ? "bg-[linear-gradient(135deg,rgba(232,160,32,0.18),rgba(232,160,32,0.04))] text-primary shadow-[inset_0_0_0_1px_rgba(232,160,32,0.16)]"
            : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground",
        )}
      >
        <product.icon className={cn("h-[18px] w-[18px] shrink-0", active && "text-primary")} />
        {!collapsed ? (
          <>
            <div className="min-w-0 flex-1">
              <span className="block">{product.name}</span>
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {product.description}
              </span>
            </div>
            {active ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-primary" />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            )}
          </>
        ) : null}
        {showBadge ? (
          <span
            className={cn(
              "shrink-0 rounded-full bg-primary text-[11px] font-semibold text-primary-foreground",
              collapsed ? "absolute right-1 top-1 min-w-[18px] px-1.5 py-0.5 text-center" : "px-2 py-0.5",
            )}
          >
            {inboxUnreadCount > 99 ? "99+" : inboxUnreadCount}
          </span>
        ) : null}
      </Link>

      {active && !collapsed ? (
        <div className="ml-4 space-y-1 border-l border-border/70 pl-3">
          {product.nav.map((item) => {
            const itemActive = isItemActive(pathname, item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm no-underline transition-colors",
                  itemActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
                )}
              >
                <item.icon className={cn("h-4 w-4 shrink-0", itemActive && "text-primary")} />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SidebarContent({
  collapsed,
  setCollapsed,
  user,
  hasPwaUpdate = false,
  onNavigate,
  orgs = [],
  activeOrgId = null,
}: {
  collapsed: boolean;
  setCollapsed?: (value: boolean) => void;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  hasPwaUpdate?: boolean;
  onNavigate?: () => void;
  orgs?: Org[];
  activeOrgId?: string | null;
}) {
  const pathname = usePathname();
  const activeProduct = getActiveProduct(pathname);
  const liveInboxUnreadCount = useWhatsappInboxUnreadCount();
  const accountName = user?.name ?? "Admin";
  const accountEmail = user?.email ?? "admin@kasitek.com";
  const initialsSource = accountName.includes(" ")
    ? accountName.split(" ").filter(Boolean).slice(0, 2)
    : (accountEmail.split("@")[0] || accountName).split(/[\s._-]+/).filter(Boolean).slice(0, 2);
  const initials = initialsSource.map((part) => part.slice(0, 1).toUpperCase()).join("") || "AD";
  const sectionLabel = getSectionLabel(pathname, activeProduct);
  const hasOrgs = orgs.length > 0;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden border-r border-border bg-card">
      <div
        className={cn(
          "flex h-14 items-center border-b border-border",
          collapsed ? "justify-center px-3" : "justify-between gap-2 px-3",
        )}
      >
        {hasOrgs ? (
          <div className={cn("min-w-0 flex-1", collapsed && "flex justify-center")}>
            <OrgSwitcher
              orgs={orgs}
              activeOrgId={activeOrgId}
              collapsed={collapsed}
              variant="header"
            />
          </div>
        ) : (
          <Link
            href="/workspace"
            onClick={onNavigate}
            className={cn("flex min-w-0 items-center gap-2 text-left no-underline transition-opacity hover:opacity-90", collapsed && "justify-center")}
          >
            <Image src="/logo.png" alt="KasiTek" width={32} height={32} className="h-8 w-8 rounded-sm" />
            {!collapsed ? (
              <div className="flex flex-col">
                <span className="font-display text-lg tracking-wide text-foreground">KasiTek</span>
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                  {sectionLabel}
                </span>
              </div>
            ) : null}
          </Link>
        )}

        {setCollapsed && !collapsed ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={() => setCollapsed(true)}
            >
              <PanelLeftOpen className="h-4 w-4 scale-x-[-1]" />
            </Button>
          </div>
        ) : null}
      </div>

      <nav className={cn("flex-1 space-y-1 overflow-x-hidden overflow-y-auto p-2.5", collapsed && "px-2")}>
        {!collapsed ? (
          <div className="px-3 pb-1">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Products
              </p>
              <span className="truncate text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {sectionLabel}
              </span>
            </div>
          </div>
        ) : null}
        {products.map((product) => (
          <ProductSection
            key={product.key}
            product={product}
            pathname={pathname}
            collapsed={collapsed}
            onNavigate={onNavigate}
            inboxUnreadCount={liveInboxUnreadCount}
          />
        ))}
      </nav>

      <div className={cn("space-y-1 border-t border-border p-2.5", collapsed && "px-2")}>
        {!collapsed ? (
          <div className="px-3 pb-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Account
            </p>
          </div>
        ) : null}
        <div className={cn("flex items-center gap-2.5 rounded-md px-3 py-1", collapsed && "justify-center px-2")}>
          <ThemeToggleSimple />
          {!collapsed ? <span className="text-sm text-muted-foreground">Theme</span> : null}
        </div>

        <Link
          href="/workspace/notifications"
          onClick={onNavigate}
          className={cn(
            "flex items-center rounded-lg text-sm font-medium text-muted-foreground no-underline transition-all duration-200 hover:bg-secondary/80 hover:text-foreground",
            collapsed ? "justify-center px-2 py-2" : "gap-2.5 px-3 py-2.5",
          )}
        >
          <Bell className="h-[18px] w-[18px] shrink-0" />
          {!collapsed ? <span>Notifications</span> : null}
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "flex w-full items-center rounded-lg text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-secondary/80 hover:text-foreground",
                collapsed ? "justify-center px-2 py-2" : "gap-2.5 px-3 py-2.5",
              )}
            >
              <Avatar className="h-7 w-7 border border-border">
                {user?.image ? <AvatarImage src={user.image} alt={user?.name ?? "User"} /> : null}
                <AvatarFallback className="bg-primary/20 text-primary text-xs">{initials}</AvatarFallback>
              </Avatar>
              {!collapsed ? (
                <div className="flex-1 text-left">
                  <p className="text-sm font-medium text-foreground">{accountName}</p>
                  <p className="truncate text-xs text-muted-foreground">{accountEmail}</p>
                </div>
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link href="/workspace/profile" onClick={onNavigate}>
                <UserRound className="mr-2 h-4 w-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            {activeProduct?.settingsHref ? (
              <DropdownMenuItem asChild>
                <Link href={activeProduct.settingsHref} onClick={onNavigate}>
                  <Settings className="mr-2 h-4 w-4" />
                  Product Settings
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild>
              <Link href="/workspace/team" onClick={onNavigate}>
                <Users className="mr-2 h-4 w-4" />
                Team
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={(event) => {
                event.preventDefault();
                void (async () => {
                  await fetch(apiUrl("/api/auth/logout"), {
                    method: "POST",
                    credentials: "include",
                  });
                  window.location.assign("/");
                })();
              }}
            >
              <LogOut className="mr-2 h-4 w-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {setCollapsed && collapsed ? (
          <div className="border-t border-border pt-3">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-full rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={() => setCollapsed(false)}
            >
              <PanelLeftOpen className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PwaUpdateBanner({
  visible,
}: {
  visible: boolean;
}) {
  if (!visible) return null;

  return (
    <div className="mx-auto max-w-[1600px] px-5 pt-5 lg:px-6 lg:pt-6">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-primary/20 bg-[linear-gradient(135deg,rgba(8,8,8,0.96),rgba(24,24,24,0.94))] p-3.5 text-white shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Update available</p>
          <p className="mt-1 text-sm text-white/70">
            A newer version of the app is ready. Refresh now to load the latest changes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("kasitek:apply-pwa-update"));
          }}
          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-foreground transition hover:bg-primary/90"
        >
          <Download className="h-4 w-4" />
          Update now
        </button>
      </div>
    </div>
  );
}

export function LayoutShell({
  children,
  user,
  inboxUnreadCount = 0,
  orgs = [],
  activeOrgId = null,
}: {
  children: React.ReactNode;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  inboxUnreadCount?: number;
  orgs?: Org[];
  activeOrgId?: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [hasPwaUpdate, setHasPwaUpdate] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const pathname = usePathname();
  const activeProduct = getActiveProduct(pathname);
  const sectionLabel = getSectionLabel(pathname, activeProduct);

  useEffect(() => {
    const onPwaUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<{ waiting?: boolean }>;
      setHasPwaUpdate(Boolean(customEvent.detail?.waiting));
    };

    window.addEventListener("kasitek:pwa-update", onPwaUpdate as EventListener);

    return () => {
      window.removeEventListener("kasitek:pwa-update", onPwaUpdate as EventListener);
    };
  }, []);

  return (
    <WhatsappRealtimeProvider initialInboxUnreadCount={inboxUnreadCount}>
      <>
        <div className="dashboard-theme flex h-screen bg-background">
          <aside className={cn("hidden lg:flex lg:flex-col", collapsed ? "w-[72px]" : "w-64")}>
              <SidebarContent
                collapsed={collapsed}
                setCollapsed={setCollapsed}
                user={user}
                hasPwaUpdate={hasPwaUpdate}
                orgs={orgs}
                activeOrgId={activeOrgId}
              />
            </aside>
          <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
            <div className="fixed inset-x-0 top-0 z-40 flex h-13 items-center justify-between border-b border-border bg-background/95 px-3 backdrop-blur lg:hidden">
              <div className="flex min-w-0 items-center gap-2">
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0">
                    <Menu className="h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <Link href="/workspace" onClick={() => setMobileSheetOpen(false)} className="flex min-w-0 items-center gap-2 text-left no-underline">
                  <Image src="/logo.png" alt="KasiTek" width={24} height={24} className="h-6 w-6 rounded-sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {activeProduct?.name ?? "KasiTek"}
                    </p>
                    <p className="truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      {sectionLabel}
                    </p>
                  </div>
                </Link>
              </div>
              {hasPwaUpdate ? <span className="h-2 w-2 rounded-full bg-primary" /> : <span className="w-2" />}
            </div>
            <SheetContent side="left" className="w-64 p-0">
              <SidebarContent
                collapsed={false}
                user={user}
                hasPwaUpdate={hasPwaUpdate}
                orgs={orgs}
                activeOrgId={activeOrgId}
                onNavigate={() => setMobileSheetOpen(false)}
              />
            </SheetContent>
          </Sheet>
          <main className="flex-1 overflow-auto pt-13 lg:pt-0">
            <PwaUpdateBanner visible={hasPwaUpdate} />
            <PushNotificationReminder />
            {children}
          </main>
        </div>
      </>
    </WhatsappRealtimeProvider>
  );
}
