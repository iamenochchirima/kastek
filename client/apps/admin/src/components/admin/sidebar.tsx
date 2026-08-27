"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity, BarChart3, Building2, ChevronDown, ChevronLeft, ChevronRight, FileText, Gauge, Globe2, Handshake,
  Inbox, KeyRound, Mail, Menu, Palette, ReceiptText, Send, UserPlus, Users,
} from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: typeof Gauge };
type NavGroup = { label: string; items: NavItem[] };

const navigation: NavGroup[] = [
  { label: "Overview", items: [
    { href: "/dashboard", label: "Dashboard", icon: Gauge },
  ] },
  { label: "Analytics", items: [
    { href: "/analytics", label: "Overview", icon: Gauge },
    { href: "/analytics/usage", label: "Usage", icon: BarChart3 },
    { href: "/analytics/revenue", label: "Revenue", icon: ReceiptText },
    { href: "/analytics/customers", label: "Customers", icon: Users },
  ] },
  { label: "Activity", items: [
    { href: "/activity", label: "Live activity", icon: Activity },
    { href: "/reports", label: "Reports", icon: FileText },
  ] },
  { label: "Operations", items: [
    { href: "/operations", label: "Agent operations", icon: Activity },
    { href: "/operations/health", label: "System health", icon: Gauge },
    { href: "/operations/data-quality", label: "Data quality", icon: BarChart3 },
    { href: "/operations/audit", label: "Audit", icon: FileText },
    { href: "/leads", label: "Leads", icon: Users },
    { href: "/conversations", label: "Conversations", icon: Inbox },
  ] },
  { label: "Commercial", items: [
    { href: "/quotations", label: "Quotations", icon: FileText },
    { href: "/invoices", label: "Invoices", icon: ReceiptText },
    { href: "/billing", label: "Product billing", icon: Handshake },
  ] },
  { label: "Outreach", items: [
    { href: "/outreach", label: "AI services", icon: Send },
    { href: "/outreach/drafts", label: "Email drafts", icon: Mail },
    { href: "/outreach/delivery", label: "Delivery log", icon: Inbox },
    { href: "/web-services", label: "Web services", icon: Globe2 },
  ] },
  { label: "Platform", items: [
    { href: "/early-access", label: "Early access", icon: UserPlus },
    { href: "/access", label: "User access", icon: Users },
    { href: "/agencies", label: "Agencies", icon: Building2 },
  ] },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Navigation({ collapsed, onNavigate }: { collapsed?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(
    () => Object.fromEntries(navigation.map((group) => [group.label, true]))
  );

  useEffect(() => {
    const stored = window.localStorage.getItem("kasitek-labs-nav-groups");
    if (!stored) return;
    try {
      const parsed = JSON.parse(stored) as Record<string, boolean>;
      setOpenGroups((current) => ({ ...current, ...parsed }));
    } catch {
      // Ignore malformed local navigation preferences.
    }
  }, []);

  function toggleGroup(label: string) {
    setOpenGroups((current) => {
      const next = { ...current, [label]: !current[label] };
      window.localStorage.setItem("kasitek-labs-nav-groups", JSON.stringify(next));
      return next;
    });
  }

  return <nav className="space-y-4" aria-label="Admin navigation">
    {navigation.map((group) => {
      const groupId = `admin-navigation-${group.label.toLowerCase().replace(/\s+/g, "-")}`;
      const isOpen = collapsed || openGroups[group.label] !== false;
      return <section key={group.label}>
      {!collapsed ? <button type="button" onClick={() => toggleGroup(group.label)} className="mb-1 flex w-full items-center justify-between rounded-md px-2.5 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:bg-secondary hover:text-foreground" aria-expanded={isOpen} aria-controls={groupId}>
        <span>{group.label}</span><ChevronDown className={`size-3.5 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
      </button> : null}
      {isOpen ? <div id={groupId} className="space-y-0.5">
        {group.items.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return <Link key={item.href} href={item.href} onClick={onNavigate} title={collapsed ? item.label : undefined} aria-current={active ? "page" : undefined}
            className={cn("group flex min-h-9 items-center rounded-md text-[13px] font-medium", collapsed ? "justify-center px-2" : "gap-2.5 px-2.5", active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground")}>
            <Icon className="size-4 shrink-0" />{!collapsed ? <span>{item.label}</span> : null}
          </Link>;
        })}
      </div> : null}
    </section>;
    })}
  </nav>;
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return <Link href="/dashboard" aria-label="KasiTek Labs" className={`flex items-center gap-2.5 px-2 ${collapsed ? "justify-center" : ""}`}>
    <Image src="/logo.png" alt="" aria-hidden="true" width={32} height={32} priority className="size-8 shrink-0 object-contain" />
    {!collapsed ? <span className="flex items-center gap-1.5 text-sm font-semibold tracking-[-0.02em] text-foreground">Kasitek <span className="font-normal text-muted-foreground">Labs</span> <span className="rounded-full border border-current/25 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] text-muted-foreground">Beta</span></span> : null}
  </Link>;
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(window.localStorage.getItem("kasitek-admin-sidebar-collapsed") === "1"); }, []);
  function toggle() { setCollapsed((value) => { const next = !value; window.localStorage.setItem("kasitek-admin-sidebar-collapsed", next ? "1" : "0"); return next; }); }
  return <aside className={`hidden min-h-screen shrink-0 border-r border-sidebar-border bg-sidebar transition-[width] duration-[var(--v-motion-shell)] lg:flex lg:flex-col ${collapsed ? "w-[68px]" : "w-[264px]"}`}>
    <div className="flex h-16 items-center justify-between border-b border-sidebar-border px-3"><Brand collapsed={collapsed} /><button type="button" onClick={toggle} className={buttonClassName({ variant: "ghost", size: "icon", className: "size-8" })} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>{collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}</button></div>
    <div className="flex-1 overflow-y-auto px-3 py-5"><Navigation collapsed={collapsed} /></div>
    <div className="space-y-1 border-t border-sidebar-border p-3">
      <Link href="/settings/appearance" className={cn("flex min-h-9 items-center rounded-md py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground", collapsed ? "justify-center px-2" : "gap-2.5 px-2.5")} title={collapsed ? "Appearance" : undefined}><Palette className="size-4" />{!collapsed ? "Appearance" : null}</Link>
      <Link href="/settings/password" className={cn("flex min-h-9 items-center rounded-md py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground", collapsed ? "justify-center px-2" : "gap-2.5 px-2.5")} title={collapsed ? "Password settings" : undefined}><KeyRound className="size-4" />{!collapsed ? "Password settings" : null}</Link>
    </div>
  </aside>;
}

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger className={buttonClassName({ variant: "ghost", size: "icon", className: "lg:hidden" })} aria-label="Open navigation"><Menu className="size-5" /></SheetTrigger>
    <SheetContent side="left" className="w-[min(19rem,85vw)] bg-sidebar p-0">
      <SheetHeader className="flex h-16 flex-row items-center border-b border-sidebar-border px-3 py-0">
        <Brand />
        <SheetTitle className="sr-only">Admin navigation</SheetTitle>
      </SheetHeader>
      <div className="flex-1 overflow-y-auto px-3 py-5"><Navigation onNavigate={() => setOpen(false)} /></div>
      <div className="space-y-1 border-t border-sidebar-border p-3"><Link href="/settings/appearance" onClick={() => setOpen(false)} className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"><Palette className="size-4" />Appearance</Link><Link href="/settings/password" onClick={() => setOpen(false)} className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground"><KeyRound className="size-4" />Password settings</Link></div>
    </SheetContent>
  </Sheet>;
}
