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
  CircleHelp,
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

type NavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

type ProductKey = "workspace" | "agents" | "reach" | "inbox" | "social";

type ProductDefinition = {
  key: ProductKey | "social";
  name: string;
  shortName: string;
  description: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  nav: NavItem[];
  settingsHref?: string;
  accent: string;
};

const products: ProductDefinition[] = [
  {
    key: "workspace",
    name: "Workspace",
    shortName: "Workspace",
    description: "Cross-product overview, activity, and navigation.",
    href: "/workspace",
    icon: LayoutGrid,
    accent: "text-primary",
    nav: [
      { name: "Overview", href: "/workspace", icon: LayoutGrid },
      { name: "Notifications", href: "/workspace/notifications", icon: Bell },
      { name: "Profile", href: "/workspace/profile", icon: UserRound },
    ],
  },
  {
    key: "agents",
    name: "KasiAgents",
    shortName: "Agents",
    description: "AI agents, workflows, and automation logic.",
    href: "/agents",
    icon: Bot,
    accent: "text-primary",
    nav: [{ name: "Overview", href: "/agents", icon: Bot }],
  },
  {
    key: "reach",
    name: "KasiReach",
    shortName: "Reach",
    description: "Contacts, templates, campaigns, and outbound growth.",
    href: "/reach",
    icon: Send,
    accent: "text-primary",
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
    accent: "text-primary",
    nav: [{ name: "Overview", href: "/inbox", icon: Bell }],
  },
  {
    key: "social",
    name: "KasiSocial",
    shortName: "Social",
    description: "Social planning, publishing, channels, and analytics.",
    href: "/social",
    icon: Sparkles,
    accent: "text-primary",
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

function resolveProduct(pathname: string): ProductDefinition {
  if (pathname.startsWith("/agents") || pathname.startsWith("/dashboard/bots")) {
    return products.find((product) => product.key === "agents")!;
  }

  if (
    pathname.startsWith("/reach") ||
    pathname.startsWith("/dashboard/contacts") ||
    pathname.startsWith("/dashboard/templates") ||
    pathname.startsWith("/dashboard/campaigns") ||
    pathname.startsWith("/dashboard/settings")
  ) {
    return products.find((product) => product.key === "reach")!;
  }

  if (pathname.startsWith("/inbox") || pathname.startsWith("/dashboard/inbox")) {
    return products.find((product) => product.key === "inbox")!;
  }

  if (pathname.startsWith("/social")) {
    return products.find((product) => product.key === "social")!;
  }

  return products.find((product) => product.key === "workspace")!;
}

function isItemActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function ProductSwitcher({
  currentProduct,
  open,
  onClose,
}: {
  currentProduct: ProductDefinition;
  open: boolean;
  onClose: () => void;
}) {
  const inboxUnreadCount = useWhatsappInboxUnreadCount();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/55 px-3 py-3 backdrop-blur-sm sm:items-center sm:px-4 sm:py-6" onClick={onClose}>
      <div
        className="flex max-h-[calc(100dvh-24px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_90px_rgba(0,0,0,0.45)] sm:max-h-[min(88vh,920px)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-6 sm:py-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Products</p>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">Switch workspace product</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              Jump between your overall workspace view and each focused product area without losing context.
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onClose}>
            <PanelLeftOpen className="h-4 w-4 rotate-90" />
          </Button>
        </div>

        <div className="overflow-y-auto px-4 py-4 sm:px-6 sm:py-6">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {products.map((product) => {
              const active = product.key === currentProduct.key;
              const Icon = product.icon;
              const unreadBadge =
                product.key === "inbox" && inboxUnreadCount > 0 ? (
                  <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
                    {inboxUnreadCount > 99 ? "99+" : inboxUnreadCount}
                  </span>
                ) : null;

              return (
                <Link
                  key={product.key}
                  href={product.href}
                  onClick={onClose}
                  className={cn(
                    "rounded-xl border p-4 no-underline transition-all duration-200 sm:p-5",
                    active
                      ? "border-primary/30 bg-primary/10 shadow-[inset_0_0_0_1px_rgba(232,160,32,0.18)]"
                      : "border-border bg-secondary/35 hover:border-primary/20 hover:bg-secondary/60",
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card">
                        <Icon className={cn("h-5 w-5", active ? "text-primary" : "text-foreground")} />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-base font-semibold text-foreground sm:text-lg">{product.name}</p>
                        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
                          {active ? "Current product" : "Open product"}
                        </p>
                      </div>
                    </div>
                    {unreadBadge}
                  </div>

                  <p className="mt-4 text-sm leading-6 text-muted-foreground">{product.description}</p>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarContent({
  collapsed,
  setCollapsed,
  user,
  hasPwaUpdate = false,
  onOpenSwitcher,
  onNavigate,
}: {
  collapsed: boolean;
  setCollapsed?: (value: boolean) => void;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  hasPwaUpdate?: boolean;
  onOpenSwitcher: () => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const currentProduct = resolveProduct(pathname);
  const liveInboxUnreadCount = useWhatsappInboxUnreadCount();
  const accountName = user?.name ?? "Admin";
  const accountEmail = user?.email ?? "admin@kasitek.com";
  const initialsSource = accountName.includes(" ")
    ? accountName.split(" ").filter(Boolean).slice(0, 2)
    : (accountEmail.split("@")[0] || accountName).split(/[\s._-]+/).filter(Boolean).slice(0, 2);
  const initials = initialsSource.map((part) => part.slice(0, 1).toUpperCase()).join("") || "AD";

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden border-r border-border bg-card">
      <div
        className={cn(
          "flex h-16 items-center border-b border-border",
          collapsed ? "justify-center px-3" : "justify-between px-4",
        )}
      >
        <button
          type="button"
          onClick={onOpenSwitcher}
          className={cn(
            "flex min-w-0 items-center gap-2 text-left no-underline transition-opacity hover:opacity-90",
            collapsed && "justify-center",
          )}
        >
          <Image src="/logo.png" alt="KasiTek" width={32} height={32} className="h-8 w-8 rounded-sm" />
          {!collapsed ? (
            <div className="flex flex-col">
              <span className="font-display text-lg tracking-wide text-foreground">KasiTek</span>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {currentProduct.shortName}
              </span>
            </div>
          ) : null}
        </button>

        {setCollapsed && !collapsed ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={onOpenSwitcher}>
              <span className="relative">
                <Grid2x2 className="h-4 w-4" />
                {hasPwaUpdate ? (
                  <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary" />
                ) : null}
              </span>
            </Button>
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

      {!collapsed ? (
        <div className="border-b border-border px-3 py-3">
          <button
            type="button"
            onClick={onOpenSwitcher}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-secondary/40 px-3 py-3 text-left transition-colors hover:border-primary/20 hover:bg-secondary/70"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card">
              <currentProduct.icon className="h-4 w-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">{currentProduct.name}</p>
              <p className="truncate text-xs text-muted-foreground">{currentProduct.description}</p>
            </div>
          </button>
        </div>
      ) : null}

      <nav className={cn("flex-1 space-y-1 overflow-x-hidden overflow-y-auto p-3", collapsed && "px-2")}>
        {currentProduct.nav.map((item) => {
          const active = isItemActive(pathname, item.href);
          const showInboxBadge = item.href === "/inbox" && liveInboxUnreadCount > 0;

          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={cn(
                "group relative flex items-center rounded-xl text-sm font-medium transition-all duration-200 no-underline",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3.5 py-3",
                active
                  ? "bg-[linear-gradient(135deg,rgba(232,160,32,0.18),rgba(232,160,32,0.04))] text-primary shadow-[inset_0_0_0_1px_rgba(232,160,32,0.16)]"
                  : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground",
              )}
            >
              <item.icon className={cn("h-5 w-5 shrink-0", active && "text-primary")} />
              {!collapsed ? <span className="flex-1">{item.name}</span> : null}
              {showInboxBadge ? (
                <span
                  className={cn(
                    "shrink-0 rounded-full bg-primary text-[11px] font-semibold text-primary-foreground",
                    collapsed ? "absolute right-1 top-1 min-w-[18px] px-1.5 py-0.5 text-center" : "px-2 py-0.5",
                  )}
                >
                  {liveInboxUnreadCount > 99 ? "99+" : liveInboxUnreadCount}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className={cn("space-y-1 border-t border-border p-3", collapsed && "px-2")}>
        <div className={cn("flex items-center gap-3 rounded-md px-3 py-1", collapsed && "justify-center px-2")}>
          <ThemeToggleSimple />
          {!collapsed ? <span className="text-sm text-muted-foreground">Theme</span> : null}
        </div>

        <Link
          href="/workspace/notifications"
          onClick={onNavigate}
          className={cn(
            "flex items-center rounded-xl text-sm font-medium text-muted-foreground no-underline transition-all duration-200 hover:bg-secondary/80 hover:text-foreground",
            collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3.5 py-3",
          )}
        >
          <Bell className="h-5 w-5 shrink-0" />
          {!collapsed ? <span>Notifications</span> : null}
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "flex w-full items-center rounded-xl text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-secondary/80 hover:text-foreground",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3.5 py-3",
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
              <Link href="/workspace" onClick={onNavigate}>
                <LayoutGrid className="mr-2 h-4 w-4" />
                Workspace
              </Link>
            </DropdownMenuItem>
            {currentProduct.settingsHref ? (
              <DropdownMenuItem asChild>
                <Link href={currentProduct.settingsHref} onClick={onNavigate}>
                  <Settings className="mr-2 h-4 w-4" />
                  Product Settings
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem asChild>
              <Link href="/workspace" onClick={onNavigate}>
                <CircleHelp className="mr-2 h-4 w-4" />
                Help
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
              className="h-10 w-full rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground"
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
    <div className="mx-auto max-w-[1600px] px-6 pt-6 lg:px-8 lg:pt-8">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-primary/20 bg-[linear-gradient(135deg,rgba(8,8,8,0.96),rgba(24,24,24,0.94))] p-4 text-white shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
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
          className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90"
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
}: {
  children: React.ReactNode;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  inboxUnreadCount?: number;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [hasPwaUpdate, setHasPwaUpdate] = useState(false);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const pathname = usePathname();
  const currentProduct = resolveProduct(pathname);

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
        <ProductSwitcher
          currentProduct={currentProduct}
          open={switcherOpen}
          onClose={() => setSwitcherOpen(false)}
        />

        <div className="dashboard-theme flex h-screen bg-background">
          <aside className={cn("hidden lg:flex lg:flex-col", collapsed ? "w-[72px]" : "w-64")}>
            <SidebarContent
              collapsed={collapsed}
              setCollapsed={setCollapsed}
              user={user}
              hasPwaUpdate={hasPwaUpdate}
              onOpenSwitcher={() => setSwitcherOpen(true)}
            />
          </aside>
          <Sheet open={mobileSheetOpen} onOpenChange={setMobileSheetOpen}>
            <div className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/95 px-3 backdrop-blur lg:hidden">
              <div className="flex min-w-0 items-center gap-2">
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0">
                    <Menu className="h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <button
                  type="button"
                  onClick={() => setSwitcherOpen(true)}
                  className="flex min-w-0 items-center gap-2 text-left"
                >
                  <Image src="/logo.png" alt="KasiTek" width={24} height={24} className="h-6 w-6 rounded-sm" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{currentProduct.name}</p>
                    <p className="truncate text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                      Workspace
                    </p>
                  </div>
                </button>
              </div>
              <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setSwitcherOpen(true)}>
                <span className="relative">
                  <Grid2x2 className="h-4 w-4" />
                  {hasPwaUpdate ? (
                    <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-primary" />
                  ) : null}
                </span>
              </Button>
            </div>
            <SheetContent side="left" className="w-64 p-0">
              <SidebarContent
                collapsed={false}
                user={user}
                hasPwaUpdate={hasPwaUpdate}
                onOpenSwitcher={() => setSwitcherOpen(true)}
                onNavigate={() => setMobileSheetOpen(false)}
              />
            </SheetContent>
          </Sheet>
          <main className="flex-1 overflow-auto pt-14 lg:pt-0">
            <PwaUpdateBanner visible={hasPwaUpdate} />
            <PushNotificationReminder />
            {children}
          </main>
        </div>
      </>
    </WhatsappRealtimeProvider>
  );
}
