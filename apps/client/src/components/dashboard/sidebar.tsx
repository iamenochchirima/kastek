
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: "◻" },
  { label: "Onboarding", href: "/dashboard/onboarding", icon: "💬" },
  { label: "My Bots", href: "/dashboard/bots", icon: "⚡" },
  { label: "Campaigns", href: "/dashboard/campaigns", icon: "📣" },
  { label: "Settings", href: "/dashboard/settings", icon: "⚙" },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:flex md:flex-col">
      <div className="p-6">
        <Link
          href="/"
          className="font-serif text-xl text-text no-underline"
        >
          Kasi<span className="text-accent">AI</span>
        </Link>
      </div>

      <nav className="flex-1 px-3">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/dashboard" && pathname.startsWith(item.href));

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`mb-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm no-underline transition-colors ${
                isActive
                  ? "bg-accent/10 text-accent"
                  : "text-text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              <span className="text-base">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
