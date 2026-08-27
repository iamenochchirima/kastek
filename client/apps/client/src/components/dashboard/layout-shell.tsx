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
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  Cable,
  CalendarDays,
  CalendarCheck,
  ChartColumn,
  Code2,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  ChevronRight,
  Download,
  Bot,
  FileText,
  Grid2x2,
  Headphones,
  HelpCircle,
  History,
  Inbox,
  LayoutTemplate,
  LayoutGrid,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
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
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  useWhatsappInboxUnreadCount,
  WhatsappRealtimeProvider,
} from "@/components/dashboard/whatsapp-realtime-provider";
import PushNotificationReminder from "@/components/dashboard/notifications/push-notification-reminder";
import { NotificationPopover } from "@/components/dashboard/notifications/notification-popover";
import { OrgSwitcher } from "@/components/dashboard/org-switcher";
import type { BillingSummary, CapabilityKey } from "@/lib/billing";
import type { Org } from "@/lib/orgs";
import type { ProductTourStatus } from "@/lib/product-tour";
import { ProductTour } from "@/components/dashboard/product-tour";
import { KasiAiChat } from "@/components/dashboard/kasiai/kasiai-chat";
import { KasiAiLauncher } from "@/components/dashboard/kasiai/kasiai-launcher";
import { CommandPalette } from "@/components/dashboard/command-palette";
import {
  applyTheme,
  resolveStoredTheme,
  serverThemeSnapshot,
  subscribeToThemeChange,
} from "@/lib/theme";
import { useAppearance } from "@/lib/appearance";
import { VANTAGE_LIST_ITEM_VARIANTS, VANTAGE_SELECTION_SPRING } from "@/lib/motion";

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
      { name: "Inbox", href: "/inbox", icon: Inbox },
      { name: "Live Chat", href: "/agents/conversations", icon: Headphones },
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
      { name: "Analytics", href: "/content/analytics", icon: Grid2x2 },
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
    ],
  },
];

function ThemeToggleSimple({ className, iconOnly = false }: { className?: string; iconOnly?: boolean }) {
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
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          key={theme}
          initial={{ opacity: 0, rotate: -90, scale: 0.8 }}
          animate={{ opacity: 1, rotate: 0, scale: 1 }}
          exit={{ opacity: 0, rotate: 90, scale: 0.8 }}
          transition={VANTAGE_SELECTION_SPRING}
          className="inline-flex"
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </motion.span>
      </AnimatePresence>
      <span className={iconOnly ? "sr-only" : undefined}>{theme === "dark" ? "Light" : "Dark"}</span>
    </button>
  );
}

function getActiveNavItem(pathname: string) {
  return navigationGroups
    .flatMap((group) => group.items)
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((left, right) => right.href.length - left.href.length);
}

function isItemActive(pathname: string, href: string) {
  return getActiveNavItem(pathname)[0]?.href === href;
}

function getSectionLabel(pathname: string, view?: string | null) {
  if (pathname === "/agents" && view === "external") return "External agents";
  return getActiveNavItem(pathname)[0]?.name ?? "Home";
}

function DesktopTopbar({
  organizationName,
  sectionLabel,
  user,
  orgs,
  activeOrgId,
  onOpenCommand,
}: {
  organizationName: string;
  sectionLabel: string;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  orgs: Org[];
  activeOrgId: string | null;
  onOpenCommand: () => void;
}) {
  const accountName = user?.name ?? "Account";
  const initials = accountName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "KT";

  return (
    <header className="sticky top-0 z-[var(--z-topbar)] hidden h-16 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur-[12px] md:flex lg:px-6">
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px] text-ink-2" aria-label="Breadcrumb">
        {orgs.length > 0 ? (
          <div className="min-w-0 max-w-[190px]" data-tour="workspace-switcher">
            <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} variant="header" />
          </div>
        ) : <span className="truncate">{organizationName}</span>}
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
        <NotificationPopover />
        <ThemeToggleSimple iconOnly className="size-9 px-0" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="Account" data-tour="profile" className="rounded-full">
              <Avatar className="size-9 ring-2 ring-brand-soft">
                {user?.image ? <AvatarImage src={user.image} alt={accountName} /> : null}
                <AvatarFallback className="bg-primary text-[11px] font-semibold text-primary-foreground">{initials}</AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <div className="flex items-center gap-2 px-2 py-2">
              <Avatar className="h-8 w-8 shrink-0 ring-1 ring-brand-soft">
                {user?.image ? <AvatarImage src={user.image} alt={accountName} /> : null}
                <AvatarFallback className="bg-primary text-[10px] font-semibold text-primary-foreground">{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-ink-1">{accountName}</p>
                <p className="truncate text-[11px] text-ink-3">{user?.email ?? ""}</p>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild><Link href="/workspace/settings?section=profile"><UserRound className="mr-2 size-4" />Profile</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link href="/workspace/team"><Users className="mr-2 size-4" />Team</Link></DropdownMenuItem>
            <DropdownMenuItem asChild><Link href="/workspace/settings"><Settings className="mr-2 size-4" />Settings</Link></DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                window.dispatchEvent(new CustomEvent("kasitek:restart-product-tour"));
              }}
            >
              <HelpCircle className="mr-2 size-4" />Take a tour
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={(event) => {
                event.preventDefault();
                void (async () => {
                  await fetch(apiUrl("/api/auth/logout"), { method: "POST", credentials: "include" });
                  window.location.assign("/");
                })();
              }}
            >
              <LogOut className="mr-2 size-4" />Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function MobileTopbar({
  sectionLabel,
  user,
  onOpenCommand,
}: {
  sectionLabel: string;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  onOpenCommand: () => void;
}) {
  const accountName = user?.name ?? "Account";
  const initials = accountName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "KT";

  return (
    <div className="fixed inset-x-0 top-0 z-[var(--z-mobile-topbar)] flex h-16 items-center gap-2 border-b border-line bg-canvas/80 px-3 backdrop-blur-[12px] md:hidden">
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>

      <Link href="/workspace" className="flex min-w-0 items-center gap-2 text-left no-underline">
        <Image src="/logo.png" alt="KasiTek" width={24} height={24} className="h-6 w-6 rounded-sm" />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-foreground">KasiTek <span className="rounded-full border border-current/25 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Beta</span></p>
          <p className="truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{sectionLabel}</p>
        </div>
      </Link>

      <div className="flex-1" />
      <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onOpenCommand} aria-label="Search">
        <Search className="h-4 w-4" />
      </Button>
      <NotificationPopover buttonClassName="border-0 bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground" />
      <ThemeToggleSimple iconOnly className="h-9 w-9 shrink-0 px-0" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Account" data-tour="profile" className="shrink-0 rounded-full">
            <Avatar className="h-8 w-8 ring-2 ring-brand-soft">
              {user?.image ? <AvatarImage src={user.image} alt={accountName} /> : null}
              <AvatarFallback className="bg-primary text-[10px] font-semibold text-primary-foreground">{initials}</AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <div className="flex items-center gap-2 px-2 py-2">
            <Avatar className="h-8 w-8 shrink-0 ring-1 ring-brand-soft">
              {user?.image ? <AvatarImage src={user.image} alt={accountName} /> : null}
              <AvatarFallback className="bg-primary text-[10px] font-semibold text-primary-foreground">{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-foreground">{accountName}</p>
              <p className="truncate text-[11px] text-muted-foreground">{user?.email ?? ""}</p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><Link href="/workspace/settings?section=profile"><UserRound className="mr-2 h-4 w-4" />Profile</Link></DropdownMenuItem>
          <DropdownMenuItem asChild><Link href="/workspace/team"><Users className="mr-2 h-4 w-4" />Team</Link></DropdownMenuItem>
          <DropdownMenuItem asChild><Link href="/workspace/settings"><Settings className="mr-2 h-4 w-4" />Settings</Link></DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              window.dispatchEvent(new CustomEvent("kasitek:restart-product-tour"));
            }}
          >
            <HelpCircle className="mr-2 h-4 w-4" />Take a tour
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={(event) => {
              event.preventDefault();
              void (async () => {
                await fetch(apiUrl("/api/auth/logout"), { method: "POST", credentials: "include" });
                window.location.assign("/");
              })();
            }}
          >
            <LogOut className="mr-2 h-4 w-4" />Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
          className="flex w-full items-center justify-between px-2.5 pb-1.5 pt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-sidebar-foreground/70 transition-colors hover:text-sidebar-foreground"
          aria-expanded={isOpen}
          aria-controls={`sidebar-section-${group.label.toLowerCase()}`}
        >
          <span>{group.label}</span>
          <ChevronDown className={cn("h-3 w-3 transition-transform duration-150", !isOpen && "-rotate-90")} />
        </button>
      ) : null}
      {(collapsed || isOpen) ? <div id={`sidebar-section-${group.label.toLowerCase()}`} className="space-y-0.5">{group.items.map((item, index) => {
        const active = isItemActive(pathname, item.href);
        const showBadge = item.href === "/inbox" && inboxUnreadCount > 0;
        const feature = item.featureKey
          ? billingSummary?.features?.find((candidate) => candidate.key === item.featureKey)
          : null;
        const locked = Boolean(item.featureKey && feature && !feature.enabled);
        const href = locked ? "/billing" : item.href;

        return (
          <motion.div key={item.href} variants={VANTAGE_LIST_ITEM_VARIANTS} initial="hidden" animate="visible" custom={index}>
          <Link
            href={href}
            data-tour={tourTarget(item.href)}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            aria-label={collapsed ? item.name : undefined}
            title={collapsed ? item.name : undefined}
            className={cn(
              "relative flex min-h-9 items-center rounded-md text-[13px] font-normal leading-5 no-underline transition-colors duration-[150ms]",
              collapsed ? "justify-center px-2 py-2" : "gap-2 px-2.5 py-2",
              active
                ? "text-sidebar-accent-foreground after:absolute after:left-0 after:top-1/2 after:h-5 after:w-[3px] after:-translate-y-1/2 after:rounded-r-full after:bg-primary"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
            >
            {active ? <motion.span layoutId="kasitek-sidebar-active" transition={VANTAGE_SELECTION_SPRING} className="absolute inset-0 rounded-md bg-sidebar-accent" /> : null}
              <item.icon className="relative z-10 h-4 w-4 shrink-0" />
            {!collapsed ? <span className="relative z-10">{item.name}</span> : null}
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
                  collapsed ? "absolute right-0 top-0 z-20 h-4 min-w-4 px-1 py-0 text-center text-[10px] leading-4" : "px-2 py-0.5",
                )}
              >
                {inboxUnreadCount > 99 ? "99+" : inboxUnreadCount}
              </span>
            ) : null}
          </Link>
          </motion.div>
        );
      })}</div> : null}
    </section>
  );
}

function SidebarContent({
  collapsed,
  setCollapsed,
  onNavigate,
  billingSummary = null,
}: {
  collapsed: boolean;
  setCollapsed?: (value: boolean) => void;
  onNavigate?: () => void;
  billingSummary?: BillingSummary | null;
}) {
  const pathname = usePathname();
  const liveInboxUnreadCount = useWhatsappInboxUnreadCount();

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
          {!collapsed ? <span className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">KasiTek <span className="rounded-full border border-current/25 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Beta</span></span> : null}
        </Link>

      </div>

      <nav className={cn("sidebar-nav-scroll min-h-0 flex-1 space-y-0.5 overflow-x-hidden overflow-y-auto px-3 py-4", collapsed && "px-2")}>
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

      {setCollapsed ? (
        <div className="shrink-0 border-t border-border p-2">
          <Button
            variant="ghost"
            className={cn("h-8 w-full rounded-md text-xs text-muted-foreground hover:bg-secondary hover:text-foreground", collapsed ? "px-0" : "justify-center gap-2")}
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            data-tour="sidebar-toggle"
          >
            {collapsed ? <ChevronsRight className="h-4 w-4" /> : <ChevronsLeft className="h-4 w-4" />}
            {!collapsed ? <span>Collapse</span> : null}
          </Button>
        </div>
      ) : null}
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
    <div className="mx-auto max-w-[1440px] px-5 pt-5 lg:px-6 lg:pt-6">
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
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const appearance = useAppearance();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const sectionLabel = getSectionLabel(pathname, searchParams.get("view"));
  const organizationName = orgs.find((org) => org.id === activeOrgId)?.name ?? "Workspace";
  const setSidebarCollapsed = useCallback((value: boolean) => {
    setCollapsed(value);
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, value ? "1" : "0");
    } catch {
      // Sidebar state is an enhancement; blocked storage must not break navigation.
    }
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
    const frame = window.requestAnimationFrame(() => setMobileSheetOpen(false));
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

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
    <MotionConfig reducedMotion={appearance.interface.reduceMotion ? "always" : "user"}>
      <WhatsappRealtimeProvider key={activeOrgId ?? "no-org"} initialInboxUnreadCount={inboxUnreadCount}>
        <>
        <div className="dashboard-theme flex min-h-[100dvh] bg-canvas">
          <aside className={cn("fixed inset-y-0 left-0 z-20 hidden transition-[width] duration-[var(--v-motion-shell)] ease-out md:flex md:flex-col", collapsed ? "w-[68px]" : "w-[264px]")}>
              <SidebarContent
                collapsed={collapsed}
                setCollapsed={setSidebarCollapsed}
                billingSummary={billingSummary}
              />
            </aside>
          <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
            <MobileTopbar sectionLabel={sectionLabel} user={user} onOpenCommand={() => setCommandOpen(true)} />
            <SheetContent side="left" className="flex w-64 flex-col gap-0 overflow-hidden p-0">
              <SheetTitle className="sr-only">Workspace navigation</SheetTitle>
              <SheetDescription className="sr-only">Navigate between KasiTek workspace sections.</SheetDescription>
              {orgs.length > 0 ? (
                <div className="shrink-0 border-b border-line p-3" data-tour="workspace-switcher">
                  <OrgSwitcher orgs={orgs} activeOrgId={activeOrgId} variant="header" />
                </div>
              ) : null}
              <div className="min-h-0 flex-1">
                <SidebarContent
                  collapsed={false}
                  billingSummary={billingSummary}
                  onNavigate={() => setMobileSheetOpen(false)}
                />
              </div>
            </SheetContent>
          </Sheet>
          <KasiAiLauncher
            open={assistantOpen}
            hidden={mobileSheetOpen}
            reduceMotion={appearance.interface.reduceMotion}
            onOpen={() => setAssistantOpen(true)}
          />
          <main className={cn("flex min-w-0 flex-1 flex-col pt-16 transition-[padding] duration-[var(--v-motion-shell)] ease-out md:pt-0", collapsed ? "md:pl-[68px]" : "md:pl-[264px]")}>
            <DesktopTopbar
              organizationName={organizationName}
              sectionLabel={sectionLabel}
              user={user}
              orgs={orgs}
              activeOrgId={activeOrgId}
              onOpenCommand={() => setCommandOpen(true)}
            />
            <PwaUpdateBanner visible={hasPwaUpdate} />
            <PushNotificationReminder />
            <div key={pathname} className="v-route-enter min-w-0 flex-1">
              {children}
            </div>
          </main>
          <ProductTour status={productTourStatus} />
          <KasiAiChat open={assistantOpen} onOpenChange={setAssistantOpen} leftOffset={collapsed ? 68 : 264} />
          <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        </div>
        </>
      </WhatsappRealtimeProvider>
    </MotionConfig>
  );
}
