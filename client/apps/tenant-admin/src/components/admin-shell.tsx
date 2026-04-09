"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Building2,
  LayoutDashboard,
  LogOut,
  Palette,
  Settings,
  Users,
} from "lucide-react";
import { useTenantAdminAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/clients", label: "Clients", icon: Users },
  { href: "/branding", label: "Branding", icon: Palette },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { logout } = useTenantAdminAuth();

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#13314c_0%,#08111b_35%,#05090f_100%)] text-white">
      <div className="mx-auto flex min-h-screen max-w-[1600px]">
        <aside className="hidden w-72 shrink-0 border-r border-white/10 bg-black/20 backdrop-blur md:flex md:flex-col">
          <div className="flex h-18 items-center gap-3 border-b border-white/10 px-6 py-5">
            <div className="rounded-2xl border border-cyan-400/30 bg-cyan-400/10 p-2">
              <Building2 className="h-5 w-5 text-cyan-300" />
            </div>
            <div>
              <div className="text-sm font-semibold tracking-[0.2em] text-cyan-200/80 uppercase">
                Tenant Admin
              </div>
              <div className="text-base font-semibold text-white">Agency Control</div>
            </div>
          </div>

          <nav className="flex-1 space-y-2 px-4 py-5">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-2xl px-4 py-3 text-sm transition-colors",
                    active
                      ? "bg-cyan-400/15 text-cyan-200"
                      : "text-white/70 hover:bg-white/6 hover:text-white",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-white/10 p-4">
            <button
              type="button"
              onClick={logout}
              className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-sm text-white/70 transition-colors hover:bg-white/6 hover:text-white"
            >
              <LogOut className="h-4 w-4" />
              <span>Logout</span>
            </button>
          </div>
        </aside>

        <main className="flex-1">
          <div className="border-b border-white/10 bg-black/10 px-6 py-5 backdrop-blur">
            <div className="text-xs font-medium uppercase tracking-[0.24em] text-white/45">
              Tenant Operations
            </div>
            <div className="mt-1 text-2xl font-semibold text-white">
              Manage your client workspaces
            </div>
          </div>
          <div className="p-6 md:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
