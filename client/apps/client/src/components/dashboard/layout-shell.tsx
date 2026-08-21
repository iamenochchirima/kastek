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
  CalendarCheck,
  ChartColumn,
  Code2,
  ChevronDown,
  ChevronRight,
  CreditCard,
  Download,
  Bot,
  FileText,
  Grid2x2,
  HelpCircle,
  History,
  LayoutTemplate,
  LayoutGrid,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  PanelLeftOpen,
  PhoneCall,
  Search,
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
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  useWhatsappInboxUnreadCount,
  WhatsappRealtimeProvider,
} from "@/components/dashboard/whatsapp-realtime-provider";
import PushNotificationReminder from "@/components/dashboard/notifications/push-notification-reminder";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import type { BillingSummary, CapabilityKey } from "@/lib/billing";
import type { Org } from "@/lib/orgs";
import type { ProductTourStatus } from "@/lib/product-tour";
import { ProductTour } from "@/components/dashboard/product-tour";
import { KasiAiChat, KasiAiTrigger } from "@/components/dashboard/kasiai/kasiai-chat";
import { CommandPalette } from "@/components/dashboard/command-palette";
import {
  applyTheme,
  resolveStoredTheme,
  serverThemeSnapshot,
  subscribeToThemeChange,
} from "@/lib/theme";

type NavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  featureKey?: CapabilityKey;
};

type NavigationGroup = {
  label: string;
  items: NavItem[];
};

const SIDEBAR_COLLAPSE_KEY = "kasitek-sidebar-collapsed";

function tourTarget(href: string) {
  return ({
    "/workspace": "overview",
    "/inbox": "inbox",
    "/connections": "connections",
    "/developers": "developers",
    "/agents": "agents",
    "/content": "content",
    "/bookings": "bookings",
    "/campaigns": "campaigns",
    "/workspace/team": "team",
    "/workspace/settings": "workspace-settings",
  } as Record<string, string | undefined>)[href];
}

const navigationGroups: NavigationGroup[] = [
  {
    label: "Home",
    items: [{ name: "Overview", href: "/workspace", icon: LayoutGrid }],
  },
  {
    label: "Customer",
    items: [
      { name: "Inbox", href: "/inbox", icon: Bell },
      { name: "Calls", href: "/calls", icon: PhoneCall },
      { name: "Contacts", href: "/contacts", icon: Users },
      { name: "Bookings", href: "/bookings", icon: CalendarCheck },
    ],
  },
  {
    label: "Content",
    items: [
      { name: "Posts", href: "/content", icon: Sparkles },
      { name: "Calendar", href: "/calendar", icon: CalendarDays },
      { name: "Analytics", href: "/analytics", icon: Grid2x2 },
    ],
  },
  {
    label: "Campaigns",
    items: [
      { name: "Campaigns", href: "/campaigns", icon: Send },
      { name: "Templates", href: "/templates", icon: FileText },
    ],
  },
  {
    label: "Automation",
    items: [
      { name: "Agents", href: "/agents", icon: Bot },
      { name: "Templates", href: "/agents/templates", icon: LayoutTemplate },
      { name: "Activity", href: "/agents/activity", icon: History },
      { name: "Analytics", href: "/agents/analytics", icon: ChartColumn },
    ],
  },
  {
    label: "Manage",
    items: [
      { name: "Developers", href: "/developers", icon: Code2 },
      { name: "Connections", href: "/connections", icon: Cable },
      { name: "Team", href: "/workspace/team", icon: Users },
      { name: "Billing and usage", href: "/billing", icon: CreditCard },
      { name: "Workspace settings", href: "/workspace/settings", icon: Settings },
    ],
  },
];

function ThemeToggleSimple({ className }: { className?: string }) {
  const theme = useSyncExternalStore(
    subscribeToThemeChange,
    resolveStoredTheme,
    serverThemeSnapshot,
  );

  return (
    <button
      type="button"
      onClick={() => {
        const nextTheme = theme === "dark" ? "light" : "dark";
        applyTheme(nextTheme);
      }}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
        className,
      )}
      aria-label="Toggle theme"
      data-tour="theme"
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      <span>{theme === "dark" ? "Light" : "Dark"}</span>
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

function DesktopTopbar({
  organizationName,
  sectionLabel,
  user,
  onOpenCommand,
}: {
  organizationName: string;
  sectionLabel: string;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  onOpenCommand: () => void;
}) {
  const accountName = user?.name ?? "Account";
  const initials = accountName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "KT";

  return (
    <header className="sticky top-0 z-30 hidden h-16 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur-[12px] md:flex lg:px-6">
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-2" aria-label="Breadcrumb">
        <span className="truncate">{organizationName}</span>
        <ChevronRight className="size-[13px] shrink-0 text-ink-3" />
        <span className="truncate font-medium text-ink-1">{sectionLabel}</span>
      </nav>

      <div className="mx-auto w-full max-w-sm flex-1 px-2">
        <button type="button" onClick={onOpenCommand} className="flex h-9 w-full items-center gap-2 rounded-full border border-line bg-surface px-3.5 text-[13px] text-ink-3 transition-colors duration-150 hover:border-line-strong hover:text-ink-2">
          <Search className="size-3.5" />
          <span className="flex-1 text-left">Search or jump to…</span>
          <kbd className="rounded-sm border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-2">⌘K</kbd>
        </button>
      </div>

      <div className="flex items-center gap-2">
        <Link href="/workspace/notifications" aria-label="Notifications" className="relative grid size-9 place-items-center rounded-md border border-line bg-surface text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink-1">
          <Bell className="size-4" />
        </Link>
        <ThemeToggleSimple className="size-9 px-0 [&_span]:hidden" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Account" className="rounded-full">
              <Avatar className="size-9 ring-2 ring-brand-soft">
                {user?.image ? <AvatarImage src={user.image} alt={accountName} /> : null}
                <AvatarFallback className="bg-primary text-[11px] font-semibold text-primary-foreground">{initials}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <div className="px-2 py-1.5"><p className="truncate text-[13px] font-medium text-ink-1">{accountName}</p><p className="truncate text-[11px] text-ink-3">{user?.email ?? ""}</p></div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild><Link href="/workspace/profile"><UserRound className="mr-2 size-4" />Profile</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link href="/workspace/settings"><Settings className="mr-2 size-4" />Settings</Link></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
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
  const [isOpen, setIsOpen] = useState(true);

  return (
    <section className="space-y-0.5">
      {!collapsed ? (
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          className="flex w-full items-center justify-between px-2.5 pb-1 pt-2.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"
          aria-expanded={isOpen}
          aria-controls={`sidebar-section-${group.label.toLowerCase()}`}
        >
          <span>{group.label}</span>
          <ChevronDown className={cn("h-3 w-3 transition-transform duration-150", !isOpen && "-rotate-90")} />
        </button>
      ) : null}
      {(collapsed || isOpen) ? <div id={`sidebar-section-${group.label.toLowerCase()}`} className="space-y-0.5">{group.items.map((item) => {
        const active = isItemActive(pathname, item.href);
        const showBadge = item.href === "/inbox" && inboxUnreadCount > 0;
        const feature = item.featureKey
          ? billingSummary?.features?.find((candidate) => candidate.key === item.featureKey)
          : null;
        const locked = Boolean(item.featureKey && feature && !feature.enabled);
        const href = locked ? "/billing" : item.href;

        return (
          <Link
            key={item.href}
            href={href}
            data-tour={tourTarget(item.href)}
            onClick={onNavigate}
            className={cn(
              "relative flex min-h-9 items-center rounded-md text-[13px] font-normal leading-5 no-underline transition-colors",
              collapsed ? "justify-center px-2 py-2" : "gap-2 px-2.5 py-2",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
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
                  "ml-auto shrink-0 rounded-full bg-status-attention text-[11px] font-semibold text-primary-foreground",
                  collapsed ? "absolute right-1 top-1 min-w-[18px] px-1.5 py-0.5 text-center" : "px-2 py-0.5",
                )}
              >
                {inboxUnreadCount > 99 ? "99+" : inboxUnreadCount}
              </span>
            ) : null}
          </Link>
        );
      })}</div> : null}
    </section>
  );
}

function SidebarContent({
  collapsed,
  setCollapsed,
  user,
  onNavigate,
  orgs = [],
  activeOrgId = null,
  billingSummary = null,
  onOpenKasiAi,
}: {
  collapsed: boolean;
  setCollapsed?: (value: boolean) => void;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  onNavigate?: () => void;
  orgs?: Org[];
  activeOrgId?: string | null;
  billingSummary?: BillingSummary | null;
  onOpenKasiAi?: () => void;
}) {
  const pathname = usePathname();
  const liveInboxUnreadCount = useWhatsappInboxUnreadCount();
  const accountName = user?.name ?? "Admin";
  const accountEmail = user?.email ?? "admin@kasitek.com";
  const initialsSource = accountName.includes(" ")
    ? accountName.split(" ").filter(Boolean).slice(0, 2)
    : (accountEmail.split("@")[0] || accountName).split(/[\s._-]+/).filter(Boolean).slice(0, 2);
  const initials = initialsSource.map((part) => part.slice(0, 1).toUpperCase()).join("") || "AD";
  const hasOrgs = orgs.length > 0;

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div
        className={cn(
          "flex h-16 items-center border-b border-line",
          collapsed ? "justify-center px-3" : "justify-between gap-2 px-3",
        )}
      >
        <Link
          href="/workspace"
          onClick={onNavigate}
          className={cn("flex min-w-0 items-center gap-2 text-left no-underline transition-opacity hover:opacity-90", collapsed && "justify-center")}
        >
          <Image src="/logo.png" alt="KasiTek" width={32} height={32} className="h-8 w-8 rounded-md" />
          {!collapsed ? <span className="text-[13px] font-semibold text-foreground">KasiTek</span> : null}
        </Link>

        {setCollapsed && !collapsed ? (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:bg-secondary hover:text-foreground"
              onClick={() => setCollapsed(true)}
              data-tour="sidebar-toggle"
            >
              <PanelLeftOpen className="h-4 w-4 scale-x-[-1]" />
            </Button>
          </div>
        ) : null}
      </div>

      <nav className={cn("sidebar-nav-scroll flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto px-3 py-4", collapsed && "px-2")}>
        {hasOrgs ? (
          <div className="mb-3.5" data-tour="workspace-switcher">
            <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} collapsed={collapsed} variant="panel" />
          </div>
        ) : null}
        {onOpenKasiAi ? (
          <div className="mb-3 border-b border-sidebar-border pb-3">
            <KasiAiTrigger collapsed={collapsed} onClick={onOpenKasiAi} />
          </div>
        ) : null}
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
        <div className={cn("flex items-center", collapsed && "justify-center")}>
          <ThemeToggleSimple className={collapsed ? "w-9 px-0 [&_span]:hidden" : undefined} />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex min-h-9 w-full items-center rounded-md text-[13px] font-normal leading-5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                collapsed ? "justify-center px-2 py-2" : "gap-2 px-2.5 py-2",
              )}
              title="Help"
            >
              <HelpCircle className="h-[18px] w-[18px] shrink-0" />
              {!collapsed ? <span>Help</span> : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                window.dispatchEvent(new CustomEvent("kasitek:restart-product-tour"));
              }}
            >
              <HelpCircle className="mr-2 h-4 w-4" />
              Take a tour
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Link
          href="/workspace/notifications"
          onClick={onNavigate}
          className={cn(
            "flex min-h-9 items-center rounded-md text-[13px] font-normal leading-5 text-muted-foreground no-underline transition-colors hover:bg-secondary hover:text-foreground",
            collapsed ? "justify-center px-2 py-2" : "gap-2 px-2.5 py-2",
          )}
        >
          <Bell className="h-[18px] w-[18px] shrink-0" />
          {!collapsed ? <span>Notifications</span> : null}
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              data-tour="profile"
              className={cn(
                "flex min-h-9 w-full items-center rounded-md text-[13px] font-normal leading-5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                collapsed ? "justify-center px-2 py-2" : "gap-2 px-2.5 py-2",
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
              data-tour="sidebar-toggle"
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
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card p-3.5 text-foreground">
        <div className="min-w-0">
          <p className="text-sm font-semibold">Update available</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A newer version of the app is ready. Refresh now to load the latest changes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("kasitek:apply-pwa-update"));
          }}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
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
  productTourStatus = null,
}: {
  children: React.ReactNode;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  inboxUnreadCount?: number;
  orgs?: Org[];
  activeOrgId?: string | null;
  billingSummary?: BillingSummary | null;
  productTourStatus?: ProductTourStatus | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [hasPwaUpdate, setHasPwaUpdate] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [kasiaiOpen, setKasiaiOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const pathname = usePathname();
  const sectionLabel = getSectionLabel(pathname);
  const organizationName = orgs.find((org) => org.id === activeOrgId)?.name ?? "Workspace";
  const setSidebarCollapsed = useCallback((value: boolean) => {
    setCollapsed(value);
    window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, value ? "1" : "0");
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px) and (max-width: 1279px)");
    const apply = () => {
      if (query.matches) {
        setCollapsed(true);
        return;
      }
      setCollapsed(window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1");
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

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
          <aside className={cn("hidden shrink-0 md:flex md:flex-col", collapsed ? "w-[68px]" : "w-[264px]")}>
              <SidebarContent
                collapsed={collapsed}
                setCollapsed={setSidebarCollapsed}
                user={user}
                orgs={orgs}
                activeOrgId={activeOrgId}
                billingSummary={billingSummary}
                onOpenKasiAi={() => setKasiaiOpen(true)}
              />
            </aside>
          <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
            <div className="fixed inset-x-0 top-0 z-40 flex h-13 items-center justify-between border-b border-line bg-canvas/80 px-3 backdrop-blur-[12px] md:hidden">
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
                orgs={orgs}
                activeOrgId={activeOrgId}
                billingSummary={billingSummary}
                onOpenKasiAi={() => {
                  setMobileSheetOpen(false);
                  setKasiaiOpen(true);
                }}
                onNavigate={() => setMobileSheetOpen(false)}
              />
            </SheetContent>
          </Sheet>
          <main className="flex min-w-0 flex-1 flex-col overflow-auto pt-13 md:pt-0">
            <DesktopTopbar
              organizationName={organizationName}
              sectionLabel={sectionLabel}
              user={user}
              onOpenCommand={() => setCommandOpen(true)}
            />
            <PwaUpdateBanner visible={hasPwaUpdate} />
            <PushNotificationReminder />
            {children}
          </main>
          <ProductTour status={productTourStatus} />
          <KasiAiChat open={kasiaiOpen} onOpenChange={setKasiaiOpen} leftOffset={collapsed ? 68 : 264} />
          <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        </div>
      </>
    </WhatsappRealtimeProvider>
  );
}
