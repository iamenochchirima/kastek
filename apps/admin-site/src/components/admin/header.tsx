"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRight, LogOut, Palette } from "lucide-react";
import ThemeToggle from "@/components/theme-toggle";
import { MobileNavigation } from "@/components/admin/sidebar";
import { buttonClassName } from "@/components/ui/button";

const pageLabels: Array<[string, string]> = [
  ["/dashboard", "Overview"],
  ["/operations", "Operations"],
  ["/leads", "Leads"],
  ["/conversations", "Conversations"],
  ["/quotations", "Quotations"],
  ["/invoices", "Invoices"],
  ["/billing", "Billing"],
  ["/outreach", "Outreach"],
  ["/web-services", "Web services"],
  ["/access", "Access"],
  ["/agencies", "Agencies"],
  ["/organizations", "Growth organizations"],
  ["/settings", "Settings"],
];

export default function Header({ userName }: { userName: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const section = pageLabels.find(([href]) => pathname === href || pathname.startsWith(`${href}/`))?.[1] ?? "Overview";
  async function handleSignOut() { await fetch("/api/core/admin/logout", { method: "POST", credentials: "include" }); router.push("/login"); }
  return <header className="sticky top-0 z-[var(--z-topbar)] flex h-16 items-center justify-between gap-4 border-b border-line bg-canvas/80 px-4 backdrop-blur-[12px] sm:px-6 lg:px-8">
    <div className="flex min-w-0 items-center gap-2"><MobileNavigation /><nav className="hidden min-w-0 items-center gap-1.5 text-[13px] text-ink-2 lg:flex" aria-label="Breadcrumb"><span className="truncate">Kasitek Labs</span><ChevronRight className="size-[13px] shrink-0 text-ink-3" /><span className="truncate font-medium text-ink-1">{section}</span></nav><span className="truncate text-sm font-medium text-foreground lg:hidden">{section}</span></div>
    <div className="flex items-center gap-1.5 sm:gap-2"><ThemeToggle /><span className="hidden max-w-40 truncate px-2 text-sm text-muted-foreground sm:block">{userName}</span><Link href="/settings/appearance" className={buttonClassName({ variant: "ghost", size: "icon" })} aria-label="Appearance settings" title="Appearance settings"><Palette className="size-4" /></Link><button type="button" onClick={handleSignOut} className={buttonClassName({ variant: "ghost", size: "icon" })} aria-label="Sign out" title="Sign out"><LogOut className="size-4" /></button></div>
  </header>;
}
