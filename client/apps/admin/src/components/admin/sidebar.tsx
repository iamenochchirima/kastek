"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Building2, ChevronDown, ChevronLeft, ChevronRight, FileText, Gauge, Globe2, Handshake,
  Inbox, Mail, Menu, ReceiptText, Send, Settings, Users, X,
} from "lucide-react";
import { buttonClassName } from "@/components/ui/button";

type NavItem = { href: string; label: string; icon: typeof Gauge };
type NavGroup = { label: string; items: NavItem[] };

const navigation: NavGroup[] = [
  { label: "Overview", items: [{ href: "/dashboard", label: "Dashboard", icon: Gauge }] },
  { label: "Operations", items: [
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
          return <Link key={item.href} href={item.href} onClick={onNavigate} title={collapsed ? item.label : undefined}
            className={`flex min-h-9 items-center rounded-md text-[13px] font-medium transition-colors ${collapsed ? "justify-center px-2" : "gap-2.5 px-2.5"} ${active ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"}`}>
            <Icon className="size-4 shrink-0" />{!collapsed ? <span>{item.label}</span> : null}
          </Link>;
        })}
      </div> : null}
    </section>;
    })}
  </nav>;
}

function Brand({ collapsed = false }: { collapsed?: boolean }) {
  return <Link href="/dashboard" className={`flex items-center gap-2.5 px-2 ${collapsed ? "justify-center" : ""}`}>
    <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">K</span>
    {!collapsed ? <span className="text-sm font-semibold tracking-[-0.02em] text-foreground">Kasitek <span className="font-normal text-muted-foreground">Labs</span></span> : null}
  </Link>;
}

export default function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { setCollapsed(window.localStorage.getItem("kasitek-admin-sidebar-collapsed") === "1"); }, []);
  function toggle() { setCollapsed((value) => { const next = !value; window.localStorage.setItem("kasitek-admin-sidebar-collapsed", next ? "1" : "0"); return next; }); }
  return <aside className={`hidden min-h-screen shrink-0 border-r border-border bg-sidebar transition-[width] duration-150 lg:flex lg:flex-col ${collapsed ? "w-16" : "w-60"}`}>
    <div className="flex h-16 items-center justify-between border-b border-border px-3"><Brand collapsed={collapsed} /><button type="button" onClick={toggle} className={buttonClassName({ variant: "ghost", size: "icon", className: "size-8" })} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>{collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}</button></div>
    <div className="flex-1 overflow-y-auto px-3 py-5"><Navigation collapsed={collapsed} /></div>
    <div className="border-t border-border p-3"><Link href="/settings/password" className={`flex items-center rounded-md py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground ${collapsed ? "justify-center px-2" : "gap-2 px-2.5"}`} title={collapsed ? "Account settings" : undefined}><Settings className="size-4" />{!collapsed ? "Account settings" : null}</Link></div>
  </aside>;
}

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)} className={buttonClassName({ variant: "ghost", size: "icon", className: "lg:hidden" })} aria-label="Open navigation"><Menu className="size-5" /></button>
    {open ? <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation"><button type="button" className="absolute inset-0 bg-overlay" aria-label="Close navigation" onClick={() => setOpen(false)} /><aside className="relative flex h-full w-[min(19rem,85vw)] flex-col border-r border-border bg-sidebar shadow-2xl"><div className="flex h-16 items-center justify-between border-b border-border px-3"><Brand /><button type="button" onClick={() => setOpen(false)} className={buttonClassName({ variant: "ghost", size: "icon" })} aria-label="Close navigation"><X className="size-5" /></button></div><div className="flex-1 overflow-y-auto px-3 py-5"><Navigation onNavigate={() => setOpen(false)} /></div></aside></div> : null}
  </>;
}
