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
  Cable,
  CalendarDays,
  CreditCard,
  Download,
  Bot,
  FileText,
  Grid2x2,
  LayoutGrid,
  LockKeyhole,
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
import type { BillingSummary } from "@/lib/billing";
import type { Org } from "@/lib/orgs";

type NavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  productKey?: "agents" | "reach" | "social";
};

type NavigationGroup = {
  label: string;
  items: NavItem[];
};

const navigationGroups: NavigationGroup[] = [
  {
    label: "Home",
    items: [{ name: "Overview", href: "/workspace", icon: LayoutGrid }],
  },
  {
    label: "Customer",
    items: [
      { name: "Inbox", href: "/inbox", icon: Bell },
      { name: "Contacts", href: "/reach/contacts", icon: Users },
    ],
  },
  {
    label: "Growth",
    items: [
      { name: "Campaigns", href: "/reach/campaigns", icon: Send, productKey: "reach" },
      { name: "Templates", href: "/reach/templates", icon: FileText, productKey: "reach" },
      { name: "Content", href: "/social/posts", icon: Sparkles, productKey: "social" },
      { name: "Calendar", href: "/social/calendar", icon: CalendarDays, productKey: "social" },
      { name: "Analytics", href: "/social/analytics", icon: Grid2x2, productKey: "social" },
    ],
  },
  {
    label: "Automation",
    items: [{ name: "Agents", href: "/agents", icon: Bot, productKey: "agents" }],
  },
  {
    label: "Manage",
    items: [
      { name: "Connections", href: "/connections", icon: Cable },
      { name: "Social accounts", href: "/social/channels", icon: Sparkles, productKey: "social" },
      { name: "Team", href: "/workspace/team", icon: Users },
      { name: "Billing and usage", href: "/billing", icon: CreditCard },
      { name: "Workspace settings", href: "/workspace/settings", icon: Settings },
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

function getSectionLabel(pathname: string) {
  return (
    navigationGroups.find((group) =>
      group.items.some((item) => isItemActive(pathname, item.href)),
    )?.label ?? "Home"
  );
}

function NavigationSection({
  group,
  pathname,
  collapsed,
  onNavigate,
  inboxUnreadCount,
  billingSummary,
}: {
  group: NavigationGroup;
  pathname: string;
  collapsed: boolean;
  onNavigate?: () => void;
  inboxUnreadCount: number;
  billingSummary: BillingSummary | null;
}) {
  return (
    <section className="space-y-1">
      {!collapsed ? (
        <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {group.label}
        </p>
      ) : null}
      {group.items.map((item) => {
        const active = isItemActive(pathname, item.href);
        const showBadge = item.href === "/inbox" && inboxUnreadCount > 0;
        const product = item.productKey
          ? billingSummary?.products.find((candidate) => candidate.key === item.productKey)
          : null;
        const locked = Boolean(item.productKey && product && !product.hasAccess);
        const href = locked ? "/billing" : item.href;

        return (
          <Link
            key={item.href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "relative flex items-center rounded-lg text-sm font-medium no-underline transition-all duration-200",
              collapsed ? "justify-center px-2 py-2.5" : "gap-2.5 px-3 py-2.5",
              active
                ? "bg-[linear-gradient(135deg,rgba(232,160,32,0.18),rgba(232,160,32,0.04))] text-primary shadow-[inset_0_0_0_1px_rgba(232,160,32,0.16)]"
                : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground",
            )}
            >
              <item.icon className={cn("h-[18px] w-[18px] shrink-0", active && "text-primary")} />
            {!collapsed ? <span>{item.name}</span> : null}
            {locked ? (
              <LockKeyhole
                className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", !collapsed && "ml-auto")}
                aria-label={`${item.name} requires an upgrade`}
              />
            ) : null}
            {showBadge ? (
              <span
                className={cn(
                  "ml-auto shrink-0 rounded-full bg-primary text-[11px] font-semibold text-primary-foreground",
                  collapsed ? "absolute right-1 top-1 min-w-[18px] px-1.5 py-0.5 text-center" : "px-2 py-0.5",
                )}
              >
                {inboxUnreadCount > 99 ? "99+" : inboxUnreadCount}
              </span>
            ) : null}
          </Link>
        );
      })}
    </section>
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
  billingSummary = null,
}: {
  collapsed: boolean;
  setCollapsed?: (value: boolean) => void;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  hasPwaUpdate?: boolean;
  onNavigate?: () => void;
  orgs?: Org[];
  activeOrgId?: string | null;
  billingSummary?: BillingSummary | null;
}) {
  const pathname = usePathname();
  const liveInboxUnreadCount = useWhatsappInboxUnreadCount();
  const accountName = user?.name ?? "Admin";
  const accountEmail = user?.email ?? "admin@kasitek.com";
  const initialsSource = accountName.includes(" ")
    ? accountName.split(" ").filter(Boolean).slice(0, 2)
    : (accountEmail.split("@")[0] || accountName).split(/[\s._-]+/).filter(Boolean).slice(0, 2);
  const initials = initialsSource.map((part) => part.slice(0, 1).toUpperCase()).join("") || "AD";
  const sectionLabel = getSectionLabel(pathname);
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
        {navigationGroups.map((group) => (
          <NavigationSection
            key={group.label}
            group={group}
            pathname={pathname}
            collapsed={collapsed}
            onNavigate={onNavigate}
            inboxUnreadCount={liveInboxUnreadCount}
            billingSummary={billingSummary}
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
  billingSummary = null,
}: {
  children: React.ReactNode;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  inboxUnreadCount?: number;
  orgs?: Org[];
  activeOrgId?: string | null;
  billingSummary?: BillingSummary | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [hasPwaUpdate, setHasPwaUpdate] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const pathname = usePathname();
  const sectionLabel = getSectionLabel(pathname);

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
    <WhatsappRealtimeProvider key={activeOrgId ?? "no-org"} initialInboxUnreadCount={inboxUnreadCount}>
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
                billingSummary={billingSummary}
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
                      KasiTek
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
                billingSummary={billingSummary}
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
