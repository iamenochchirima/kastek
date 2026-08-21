"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
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
      <div className="min-h-[calc(100dvh-4rem)] bg-background text-foreground">
      <header className="flex h-12 items-center gap-3 border-b border-border px-4 sm:px-5">
        <PanelLeft className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Developers</span>
      </header>

      <div className="grid min-h-[calc(100dvh-7rem)] grid-cols-1 md:grid-cols-[178px_minmax(0,1fr)]">
        <aside className="border-b border-border px-3 py-3 md:border-b-0 md:border-r md:py-4">
          <nav className="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-1 md:overflow-visible md:pb-0" aria-label="Developer resources">
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
                    "relative block min-h-9 shrink-0 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-0",
                    active
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground",
                  )}
                >
                  {active ? <motion.span layoutId="developers-nav-active" className="absolute inset-0 z-0 rounded-md bg-secondary" transition={{ type: "spring", stiffness: 300, damping: 30 }} /> : null}
                  <span className="relative z-[1]">{section.label}</span>
                </Link>
              );
            })}
          </nav>

          <Link
            href="/developers/api"
            className="mt-3 hidden items-center justify-center rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary md:flex md:mt-7"
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
