"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Building2, Check, ChevronDown, Plus, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import type { Org } from "@/lib/orgs";

export function OrgSwitcher({
  orgs,
  activeOrgId,
  collapsed = false,
  variant = "panel",
}: {
  orgs: Org[];
  activeOrgId: string | null;
  collapsed?: boolean;
  variant?: "panel" | "header";
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? orgs[0];

  async function switchOrg(orgId: string) {
    await fetch("/api/orgs/set-active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId }),
    });
    startTransition(() => {
      router.refresh();
    });
  }

  if (!activeOrg) return null;

  const initials = activeOrg.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex w-full items-center gap-2 text-left transition-colors",
            variant === "header"
              ? "rounded-xl bg-transparent hover:bg-secondary/70"
              : "rounded-xl border border-border bg-secondary/40 hover:border-primary/20 hover:bg-secondary/70",
            collapsed
              ? "justify-center px-2 py-2"
              : variant === "header"
                ? "px-2 py-1.5"
                : "px-3 py-2",
          )}
        >
          <Avatar
            className={cn(
              "shrink-0 border border-border",
              variant === "header" ? "h-7 w-7 rounded-full" : "h-7 w-7 rounded-lg",
            )}
          >
            {activeOrg.logo ? (
              <AvatarImage src={activeOrg.logo} alt={activeOrg.name} />
            ) : null}
            <AvatarFallback
              className={cn(
                "bg-primary/20 text-[11px] font-semibold text-primary",
                variant === "header" ? "rounded-full" : "rounded-lg",
              )}
            >
              {initials}
            </AvatarFallback>
          </Avatar>
          {!collapsed ? (
            <>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">{activeOrg.name}</p>
                {variant === "header" ? (
                  null
                ) : (
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    Organisation
                  </p>
                )}
              </div>
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </>
          ) : null}
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-60">
        {orgs.map((org) => (
          <DropdownMenuItem
            key={org.id}
            onSelect={() => switchOrg(org.id)}
            className="flex items-center gap-2"
          >
            <Avatar className="h-6 w-6 shrink-0 rounded-md border border-border">
              {org.logo ? <AvatarImage src={org.logo} alt={org.name} /> : null}
              <AvatarFallback className="rounded-md bg-primary/20 text-[10px] font-semibold text-primary">
                {org.name
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0]?.toUpperCase() ?? "")
                  .join("")}
              </AvatarFallback>
            </Avatar>
            <span className="flex-1 truncate text-sm">{org.name}</span>
            {org.id === activeOrg.id ? (
              <Check className="h-3.5 w-3.5 text-primary" />
            ) : null}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <a href="/workspace/team" className="flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Manage organisation
          </a>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a href="/workspace/team/new" className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Create organisation
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
