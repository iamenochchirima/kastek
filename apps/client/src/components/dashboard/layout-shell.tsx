"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import { signOut } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Archive, BarChart3, Bell, Bot, ChevronDown, CircleHelp, Clock, FileText, LayoutGrid, List, LogOut, Menu, Moon, PanelLeftOpen, Plus, Send, Settings, Sun, UserRound, Users, Zap } from "lucide-react";

type NavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  submenu?: { name: string; href: string; icon: React.ComponentType<{ className?: string }> }[];
};

const navigation: NavItem[] = [
  { name: "Overview", href: "/dashboard", icon: LayoutGrid },
  { name: "My Bots", href: "/dashboard/bots", icon: Bot },
  { name: "Inbox", href: "/dashboard/inbox", icon: Bell },
  { name: "Contacts", href: "/dashboard/contacts", icon: Users },
  {
    name: "Templates",
    href: "/dashboard/templates",
    icon: FileText,
    submenu: [
      { name: "All Templates", href: "/dashboard/templates", icon: List },
      { name: "Create New", href: "/dashboard/templates/create", icon: Plus },
      { name: "Pending Review", href: "/dashboard/templates/pending", icon: Clock },
      { name: "Approved", href: "/dashboard/templates/approved", icon: Bell },
    ],
  },
  {
    name: "Campaigns",
    href: "/dashboard/campaigns",
    icon: Send,
    submenu: [
      { name: "All Campaigns", href: "/dashboard/campaigns", icon: List },
      { name: "Create Campaign", href: "/dashboard/campaigns/create", icon: Plus },
      { name: "Active", href: "/dashboard/campaigns/active", icon: Zap },
      { name: "Archived", href: "/dashboard/campaigns/archived", icon: Archive },
      { name: "Analytics", href: "/dashboard/campaigns/analytics", icon: BarChart3 },
    ],
  },
  { name: "Settings", href: "/dashboard/settings", icon: Settings },
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
      className={cn("inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground", className)}
      aria-label="Toggle theme"
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function SidebarContent({
  collapsed,
  setCollapsed,
  user,
  inboxUnreadCount = 0,
}: {
  collapsed: boolean;
  setCollapsed?: (v: boolean) => void;
  user?: { name?: string | null; email?: string | null; image?: string | null };
  inboxUnreadCount?: number;
}) {
  const pathname = usePathname();
  const [openSubmenus, setOpenSubmenus] = useState<string[]>([]);
  const [liveInboxUnreadCount, setLiveInboxUnreadCount] = useState(inboxUnreadCount);
  const reconcileTimerRef = useRef<number | null>(null);

  const toggleSubmenu = (name: string) => {
    setOpenSubmenus((prev) => (prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name]));
  };

  const isSubmenuOpen = (name: string) => openSubmenus.includes(name);
  const isActiveInSubmenu = (item: NavItem) => item.submenu?.some((sub) => pathname === sub.href) || pathname === item.href;
  const accountName = user?.name ?? "Admin";
  const accountEmail = user?.email ?? "admin@kasitek.com";
  const initialsSource = accountName.includes(" ") ? accountName.split(" ").filter(Boolean).slice(0, 2) : (accountEmail.split("@")[0] || accountName).split(/[\s._-]+/).filter(Boolean).slice(0, 2);
  const initials = initialsSource.map((part) => part.slice(0, 1).toUpperCase()).join("") || "AD";

  useEffect(() => {
    setLiveInboxUnreadCount(inboxUnreadCount);
  }, [inboxUnreadCount]);

  useEffect(() => {
    let cancelled = false;

    const syncUnreadCount = async () => {
      try {
        const response = await fetch("/api/whatsapp/inbox/unread-count", {
          cache: "no-store",
        });

        if (!response.ok) return;

        const payload = (await response.json()) as { unreadCount?: number };
        if (cancelled || typeof payload.unreadCount !== "number") return;

        setLiveInboxUnreadCount(Math.max(0, payload.unreadCount));
      } catch {
        // Ignore transient network errors and reconcile again on the next event.
      }
    };

    const scheduleSync = () => {
      if (reconcileTimerRef.current !== null) {
        window.clearTimeout(reconcileTimerRef.current);
      }

      reconcileTimerRef.current = window.setTimeout(() => {
        void syncUnreadCount();
      }, 250);
    };

    const source = new EventSource("/api/realtime/whatsapp");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WhatsappRealtimeEvent;

        if (payload.type === "message.created" && payload.message.sender === "customer") {
          setLiveInboxUnreadCount((current) => current + 1);
          scheduleSync();
          return;
        }

        if (payload.type === "conversation.updated") {
          scheduleSync();
        }
      } catch {
        // Ignore malformed realtime payloads.
      }
    };

    return () => {
      cancelled = true;
      source.close();
      if (reconcileTimerRef.current !== null) {
        window.clearTimeout(reconcileTimerRef.current);
        reconcileTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-x-hidden border-r border-border bg-card">
      <div
        className={cn(
          "flex h-16 items-center border-b border-border",
          collapsed ? "justify-center px-3" : "justify-between px-4",
        )}
      >
        <Link
          href="/dashboard"
          className={cn("flex min-w-0 items-center gap-2 no-underline", collapsed && "justify-center")}
        >
          <Image
            src="/logo.png"
            alt="KasiTek"
            width={32}
            height={32}
            className="h-8 w-8 rounded-sm"
          />
          {!collapsed ? (
            <div className="flex flex-col">
              <span className="font-display text-lg tracking-wide text-foreground">KasiTek</span>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Workspace</span>
            </div>
          ) : null}
        </Link>
        {setCollapsed && !collapsed ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:bg-secondary hover:text-foreground"
            onClick={() => setCollapsed(true)}
          >
            <PanelLeftOpen className="h-4 w-4 scale-x-[-1]" />
          </Button>
        ) : null}
      </div>

      <nav className={cn("flex-1 space-y-1 overflow-x-hidden overflow-y-auto p-3", collapsed && "px-2")}>
        {navigation.map((item) => {
          const isActive = pathname === item.href && !item.submenu;
          const hasSubmenu = !!item.submenu;
          const isOpen = isSubmenuOpen(item.name);
          const isParentActive = isActiveInSubmenu(item);

          if (hasSubmenu) {
            return (
              <div key={item.name}>
                <button
                  onClick={() => toggleSubmenu(item.name)}
                  className={cn(
                    "group flex w-full items-center rounded-md text-sm font-medium transition-all duration-200",
                    collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
                    isParentActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <item.icon className={cn("h-5 w-5 shrink-0", isParentActive && "text-primary")} />
                  {!collapsed ? (
                    <>
                      <span className="flex-1 text-left">{item.name}</span>
                      <ChevronDown className={cn("h-4 w-4 transition-transform duration-200", isOpen && "rotate-180")} />
                    </>
                  ) : null}
                </button>
                {isOpen && !collapsed ? (
                  <div className="ml-4 mt-1 space-y-1 border-l border-border pl-3">
                    {item.submenu?.map((subItem) => {
                      const isSubActive = pathname === subItem.href;
                      return (
                        <Link
                          key={subItem.href}
                          href={subItem.href}
                          className={cn("group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-all duration-200 no-underline", isSubActive ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}
                        >
                          <subItem.icon className={cn("h-4 w-4 shrink-0", isSubActive && "text-primary")} />
                          <span>{subItem.name}</span>
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          }

          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "group relative flex items-center rounded-md text-sm font-medium transition-all duration-200 no-underline",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
                isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <item.icon className={cn("h-5 w-5 shrink-0", isActive && "text-primary")} />
              {!collapsed ? <span className="flex-1">{item.name}</span> : null}
              {item.href === "/dashboard/inbox" && liveInboxUnreadCount > 0 ? (
                <span
                  className={cn(
                    "shrink-0 rounded-full bg-primary text-[11px] font-semibold text-primary-foreground",
                    collapsed
                      ? "absolute right-1 top-1 min-w-[18px] px-1.5 py-0.5 text-center"
                      : "px-2 py-0.5",
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
          href="/dashboard/notifications"
          className={cn(
            "flex items-center rounded-md text-sm font-medium text-muted-foreground no-underline transition-all duration-200 hover:bg-secondary hover:text-foreground",
            collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
          )}
        >
          <Bell className="h-5 w-5 shrink-0" />
          {!collapsed ? <span>Notifications</span> : null}
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "flex w-full items-center rounded-md text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-secondary hover:text-foreground",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
              )}
            >
              <Avatar className="h-7 w-7 border border-border">
                {user?.image ? <AvatarImage src={user.image} alt={user?.name ?? "User"} /> : null}
                <AvatarFallback className="bg-primary/20 text-primary text-xs">{initials}</AvatarFallback>
              </Avatar>
              {!collapsed ? (
                <>
                  <div className="flex-1 text-left">
                    <p className="text-sm font-medium text-foreground">{accountName}</p>
                    <p className="truncate text-xs text-muted-foreground">{accountEmail}</p>
                  </div>
                </>
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem asChild>
              <Link href="/dashboard/profile">
                <UserRound className="mr-2 h-4 w-4" />
                Profile
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/dashboard/settings">
                <Settings className="mr-2 h-4 w-4" />
                Account Settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/dashboard">
                <CircleHelp className="mr-2 h-4 w-4" />
                Help
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={(event) => {
                event.preventDefault();
                void signOut({ callbackUrl: "/" });
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
              className="h-10 w-full rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
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

  return (
    <div className="dashboard-theme flex h-screen bg-background">
      <aside className={cn("hidden lg:flex lg:flex-col", collapsed ? "w-[72px]" : "w-64")}>
        <SidebarContent
          collapsed={collapsed}
          setCollapsed={setCollapsed}
          user={user}
          inboxUnreadCount={inboxUnreadCount}
        />
      </aside>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="fixed left-4 top-4 z-50 lg:hidden">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SidebarContent collapsed={false} user={user} inboxUnreadCount={inboxUnreadCount} />
        </SheetContent>
      </Sheet>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
