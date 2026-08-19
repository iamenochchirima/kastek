"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeft } from "lucide-react";
import type { DevelopersBootstrap } from "@/lib/developers";
import { cn } from "@/lib/utils";
import { DevelopersDataProvider } from "./developers-data";

type DevelopersSection = {
  label: string;
  href: string;
};

const sections: DevelopersSection[] = [
  { label: "Quick Start", href: "/developers" },
  { label: "API Keys", href: "/developers/api-keys" },
  { label: "MCP", href: "/developers/mcp" },
  { label: "CLI", href: "/developers/cli" },
  { label: "API", href: "/developers/api" },
  { label: "Resources", href: "/developers/resources" },
];

export function DevelopersPortalShell({
  initial,
  children,
}: {
  initial: DevelopersBootstrap;
  children: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <DevelopersDataProvider value={initial}>
      <div className="min-h-[calc(100vh-4rem)] bg-background text-foreground">
      <header className="flex h-12 items-center gap-3 border-b border-border px-5">
        <PanelLeft className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Developers</span>
      </header>

      <div className="grid min-h-[calc(100vh-7rem)] grid-cols-[178px_minmax(0,1fr)]">
        <aside className="border-r border-border px-3 py-4">
          <nav className="space-y-1" aria-label="Developer resources">
            {sections.map((section) => {
              const active = section.href === "/developers"
                ? pathname === section.href
                : pathname === section.href || pathname.startsWith(`${section.href}/`);
              return (
                <Link
                  key={section.href}
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-secondary font-semibold text-foreground"
                      : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
                  )}
                >
                  {section.label}
                </Link>
              );
            })}
          </nav>

          <Link
            href="/developers/api"
            className="mt-7 flex items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Full docs
          </Link>
        </aside>

        <main className="min-w-0 overflow-x-hidden">{children}</main>
      </div>

      </div>
    </DevelopersDataProvider>
  );
}
