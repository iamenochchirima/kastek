"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: "📊" },
  { href: "/leads", label: "Leads", icon: "👥" },
  { href: "/quotations", label: "Quotations", icon: "📄" },
  { href: "/invoices", label: "Invoices", icon: "🧾" },
  { href: "/outreach", label: "AI Services", icon: "📧" },
  { href: "/outreach/drafts", label: "Email Drafts", icon: "📝" },
  { href: "/outreach/delivery", label: "Delivery Log", icon: "📬" },
  { href: "/web-services", label: "Web Services", icon: "🌐" },
  { href: "/conversations", label: "Conversations", icon: "💬" },
  { href: "/agencies", label: "Agencies", icon: "🏢" },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("admin-sidebar-collapsed");
    if (stored === "1") setCollapsed(true);
  }, []);

  function toggleSidebar() {
    setCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem("admin-sidebar-collapsed", next ? "1" : "0");
      return next;
    });
  }

  return (
    <aside
      className={`bg-surface-raised border-r border-border min-h-screen flex flex-col transition-all duration-200 ${
        collapsed ? "w-20" : "w-64"
      }`}
    >
      <div className="p-4 border-b border-border flex items-center justify-between gap-2">
        <Link href="/dashboard" className="text-xl font-bold text-text whitespace-nowrap">
          {collapsed ? (
            <>
              K<span className="text-primary">T</span>
            </>
          ) : (
            <>
              Kasi<span className="text-primary">Tek</span>
              <span className="text-xs font-normal text-text-faint ml-2">Admin</span>
            </>
          )}
        </Link>
        <button
          type="button"
          onClick={toggleSidebar}
          className="h-8 w-8 rounded-lg border border-border text-text-faint hover:text-text hover:bg-surface-overlay transition-colors"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                collapsed ? "justify-center" : "gap-3"
              } ${
                isActive
                  ? "bg-primary/15 text-primary"
                  : "text-text-muted hover:bg-surface-overlay hover:text-text"
              }`}
              title={collapsed ? item.label : undefined}
            >
              <span>{item.icon}</span>
              {!collapsed ? item.label : null}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
