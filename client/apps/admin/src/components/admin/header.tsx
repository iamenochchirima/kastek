"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { LogOut, Settings } from "lucide-react";
import ThemeToggle from "@/components/theme-toggle";
import { MobileNavigation } from "@/components/admin/sidebar";
import { buttonClassName } from "@/components/ui/button";

export default function Header({ userName }: { userName: string }) {
  const router = useRouter();
  async function handleSignOut() { await fetch("/api/core/admin/logout", { method: "POST", credentials: "include" }); router.push("/login"); }
  return <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6">
    <div className="flex items-center gap-2"><MobileNavigation /><span className="text-sm font-medium text-foreground lg:hidden">KasiTek Admin</span></div>
    <div className="flex items-center gap-1.5 sm:gap-2"><ThemeToggle /><span className="hidden max-w-40 truncate px-2 text-sm text-muted-foreground sm:block">{userName}</span><Link href="/settings/password" className={buttonClassName({ variant: "ghost", size: "icon" })} aria-label="Account settings" title="Account settings"><Settings className="size-4" /></Link><button type="button" onClick={handleSignOut} className={buttonClassName({ variant: "ghost", size: "icon" })} aria-label="Sign out" title="Sign out"><LogOut className="size-4" /></button></div>
  </header>;
}
