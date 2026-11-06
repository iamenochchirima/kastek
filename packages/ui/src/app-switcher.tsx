"use client"

import * as React from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu.js"
import { cn } from "./utils.js"

export type KasitekAppId = "growth" | "agents" | "agency"

export type KasitekAppLink = {
  id: KasitekAppId
  name: string
  tagline: string
  /** Absolute sibling-app URL or root-relative path. Omitted when unknown. */
  href?: string
  current?: boolean
}

const APP_META: Record<KasitekAppId, { name: string; tagline: string }> = {
  growth: { name: "Growth", tagline: "Marketing and customer workspace" },
  agents: { name: "Agents", tagline: "AI support workspace" },
  agency: { name: "Agency", tagline: "Partner and client workspaces" },
}

const APP_ORDER: KasitekAppId[] = ["growth", "agents", "agency"]

/** Absolute https/http URLs or root-relative paths only. Rejects executable and protocol-relative targets. */
export function isSafeAppUrl(href: string): boolean {
  const value = href.trim()
  if (!value || value.includes("\\")) return false
  if (value.startsWith("/") && !value.startsWith("//")) return true
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      return parsed.protocol === "http:" || parsed.protocol === "https:"
    } catch {
      return false
    }
  }
  return false
}

function normalizeUrl(href: string | undefined): string | undefined {
  if (!href) return undefined
  const value = href.trim().replace(/\/+$/, "") || "/"
  return isSafeAppUrl(value) ? value : undefined
}

export function buildKasitekAppLinks(input: {
  current: KasitekAppId
  growthUrl?: string
  agentsUrl?: string
  agencyUrl?: string
}): KasitekAppLink[] {
  const urls: Record<KasitekAppId, string | undefined> = {
    growth: normalizeUrl(input.growthUrl),
    agents: normalizeUrl(input.agentsUrl),
    agency: normalizeUrl(input.agencyUrl),
  }
  return APP_ORDER.map((id) => ({
    id,
    name: APP_META[id].name,
    tagline: APP_META[id].tagline,
    href: urls[id],
    current: id === input.current,
  })).filter((app) => app.current || app.href)
}

function AppSwitcherGridIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
    >
      {[2.5, 8, 13.5].map((cy) =>
        [2.5, 8, 13.5].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.6" />
        )),
      )}
    </svg>
  )
}

export function KasitekAppList({ apps }: { apps: KasitekAppLink[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {apps.map((app) =>
        app.current ? (
          <li
            key={app.id}
            aria-current="page"
            className="flex items-center gap-3 rounded-md bg-accent px-2.5 py-2"
          >
            <span
              aria-hidden="true"
              className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-xs font-semibold text-primary-foreground"
            >
              {app.name.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {app.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {app.tagline}
              </span>
            </span>
            <span className="shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              Current
            </span>
          </li>
        ) : (
          <li key={app.id}>
            <a
              href={app.href}
              className="flex items-center gap-3 rounded-md px-2.5 py-2 no-underline outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
            >
              <span
                aria-hidden="true"
                className="grid size-8 shrink-0 place-items-center rounded-md border bg-background text-xs font-semibold"
              >
                {app.name.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {app.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {app.tagline}
                </span>
              </span>
            </a>
          </li>
        ),
      )}
    </ul>
  )
}

export function AppSwitcher({
  current,
  apps,
  className,
}: {
  current: KasitekAppId
  apps: KasitekAppLink[]
  className?: string
}) {
  const ordered = React.useMemo(
    () =>
      [...apps].sort(
        (left, right) =>
          APP_ORDER.indexOf(left.id) - APP_ORDER.indexOf(right.id),
      ),
    [apps],
  )
  const currentName = APP_META[current].name
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Switch apps, current app ${currentName}`}
          title={`Switch apps, current app ${currentName}`}
          className={cn(
            "inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
            className,
          )}
        >
          <AppSwitcherGridIcon className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1.5">
        <DropdownMenuLabel>Switch apps</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="p-1">
          <KasitekAppList apps={ordered} />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
