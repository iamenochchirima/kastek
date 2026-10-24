"use client";

import type { ReactNode } from "react";
import { Link } from "react-router";
import { useLocation } from "react-router";
import { motion } from "framer-motion";
import { Code2 } from "lucide-react";
import type { DevelopersBootstrap } from "@/lib/developers";
import { cn } from "@/lib/utils";
import { DevelopersDataProvider } from "./developers-data";
import { VANTAGE_SELECTION_SPRING } from "@/lib/motion";

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
  const { pathname } = useLocation();

  return (
    <DevelopersDataProvider value={initial}>
      <div className="min-h-[100dvh] px-4 py-6 text-foreground lg:px-6">
        <div className="mx-auto max-w-[1440px]">
          <header>
            <div className="flex items-center gap-2">
              <Code2 className="size-5 text-primary" aria-hidden="true" />
              <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-foreground">Developers</h1>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">REST API and terminal setup.</p>
          </header>

          <div className="mt-6 flex flex-col gap-6 md:flex-row md:items-start">
            <aside className="shrink-0 md:w-[200px]">
              <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0" aria-label="Developer resources">
            {sections.map((section) => {
              const active = section.href === "/developers"
                ? pathname === section.href
                : pathname === section.href || pathname.startsWith(`${section.href}/`);
              return (
                <Link
                  key={section.href}
                  to={section.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-10 shrink-0 items-center rounded-md px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "text-primary"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  {active ? <motion.span layoutId="developers-nav-active" className="absolute inset-0 rounded-md bg-primary/10" transition={VANTAGE_SELECTION_SPRING} /> : null}
                  <span className="relative z-[1]">{section.label}</span>
                </Link>
              );
            })}
              </nav>

              <Link
                to="/developers/api"
                className="mt-4 hidden h-10 items-center justify-center rounded-md border border-border px-3 text-[13px] font-medium text-foreground transition-colors hover:bg-secondary md:flex"
              >
                Full docs
              </Link>
            </aside>

            <main className="min-w-0 w-full max-w-[760px] flex-1 overflow-x-hidden [&>div]:!min-h-0 [&>div]:!p-0 [&>div>div]:!max-w-none [&>div>div]:!space-y-5 [&_[data-slot=page-header]]:hidden">{children}</main>
          </div>
        </div>

      </div>
    </DevelopersDataProvider>
  );
}
