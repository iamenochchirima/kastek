import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function TooltipProvider({ children }: { children: ReactNode }) { return <>{children}</>; }

export function Tooltip({ children, className, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return <span data-slot="tooltip" className={cn("group relative inline-flex", className)} {...props}>{children}</span>;
}

export function TooltipTrigger({ children, className, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return <span data-slot="tooltip-trigger" tabIndex={0} className={cn("outline-none focus-visible:ring-2 focus-visible:ring-ring/50", className)} {...props}>{children}</span>;
}

export function TooltipContent({ children, className, ...props }: HTMLAttributes<HTMLSpanElement> & { children: ReactNode }) {
  return <span role="tooltip" data-slot="tooltip-content" className={cn("pointer-events-none absolute bottom-full left-1/2 z-[var(--z-popover)] mb-2 w-max max-w-64 -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-xs text-background opacity-0 shadow-pop transition-opacity group-hover:opacity-100 group-focus-within:opacity-100", className)} {...props}>{children}</span>;
}
