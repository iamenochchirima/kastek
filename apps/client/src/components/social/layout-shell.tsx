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
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  BarChart3,
  CalendarRange,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Grid2x2,
  ImagePlus,
  Layers3,
  LogOut,
  Menu,
  Moon,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  Wand2,
} from "lucide-react";

type Theme = "light" | "dark";
const storageKey = "kasiai-theme";

type NavItem = {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
};

const navigation: NavItem[] = [
  { name: "Overview", href: "/social", icon: Grid2x2 },
  { name: "Planner", href: "/social/planner", icon: Wand2 },
  { name: "Calendar", href: "/social/calendar", icon: CalendarRange },
  { name: "Posts", href: "/social/posts", icon: ImagePlus },
  { name: "Channels", href: "/social/channels", icon: Layers3 },
  { name: "Analytics", href: "/social/analytics", icon: BarChart3 },
];

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

function SidebarContent({
  collapsed,
  setCollapsed,
  user,
}: {
  collapsed: boolean;
  setCollapsed?: (value: boolean) => void;
  user?: { name?: string | null; email?: string | null; image?: string | null };
}) {
  const pathname = usePathname();
  const accountName = user?.name ?? "Admin";
  const accountEmail = user?.email ?? "admin@kasitek.com";
  const initialsSource = accountName.includes(" ")
    ? accountName.split(" ").filter(Boolean).slice(0, 2)
    : (accountEmail.split("@")[0] || accountName).split(/[\s._-]+/).filter(Boolean).slice(0, 2);
  const initials = initialsSource.map((part) => part.slice(0, 1).toUpperCase()).join("") || "KS";

  return (
    <div className="flex h-full flex-col bg-card border-r border-border">
      <div className="flex h-16 items-center justify-between border-b border-border px-4">
        <Link href="/social" className="flex items-center gap-2 no-underline">
          <div className="flex h-9 w-9 items-center justify-center rounded-sm bg-primary">
            <Sparkles className="h-4 w-4 text-primary-foreground" />
          </div>
          {!collapsed ? (
            <div className="flex flex-col">
              <span className="font-display text-lg tracking-wide text-foreground">KasiSocial</span>
              <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
                Social Workspace
              </span>
            </div>
          ) : null}
        </Link>
        {setCollapsed && !collapsed ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={() => setCollapsed(true)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="border-b border-border px-3 py-3">
        <Link href="/social/posts" className="no-underline">
          <Button className={cn("w-full justify-start gap-2", collapsed && "justify-center px-0")}>
            <Plus className="h-4 w-4" />
            {!collapsed ? "New Post" : null}
          </Button>
        </Link>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {navigation.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all duration-200 no-underline",
                active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              <item.icon className={cn("h-5 w-5 shrink-0", active && "text-primary")} />
              {!collapsed ? <span className="flex-1">{item.name}</span> : null}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-1 border-t border-border p-3">
        <div className={cn("flex items-center gap-3 rounded-md px-3 py-1", collapsed && "justify-center")}>
          <ThemeToggleSimple />
          {!collapsed ? <span className="text-sm text-muted-foreground">Theme</span> : null}
        </div>
        <Link
          href="/workspace"
          className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground no-underline transition-all duration-200 hover:bg-secondary hover:text-foreground"
        >
          <Settings2 className="h-5 w-5 shrink-0" />
          {!collapsed ? <span>Main Workspace</span> : null}
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-secondary hover:text-foreground">
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
                  <ChevronDown className="h-4 w-4 opacity-50" />
                </>
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem>
              <Settings2 className="mr-2 h-4 w-4" />
              Workspace Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive">
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
              className="h-9 w-full text-muted-foreground hover:text-foreground"
              onClick={() => setCollapsed(false)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function SocialLayoutShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user?: { name?: string | null; email?: string | null; image?: string | null };
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="dashboard-theme flex h-screen bg-background">
      <aside className={cn("hidden lg:flex lg:flex-col", collapsed ? "w-[72px]" : "w-64")}>
        <SidebarContent collapsed={collapsed} setCollapsed={setCollapsed} user={user} />
      </aside>
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="fixed left-4 top-4 z-50 lg:hidden">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0">
          <SidebarContent collapsed={false} user={user} />
        </SheetContent>
      </Sheet>
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
