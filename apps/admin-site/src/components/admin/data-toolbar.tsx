import type { ReactNode } from "react";
import { X } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DataToolbar({
  search,
  filters,
  actions,
  density,
  activeFilterCount = 0,
  onClearFilters,
  className,
}: {
  search?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  density?: ReactNode;
  activeFilterCount?: number;
  onClearFilters?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3 rounded-[calc(var(--radius)-1px)] border border-line bg-card p-3 shadow-card", className)}>
      {search ? <div className="min-w-[min(100%,16rem)] flex-1">{search}</div> : null}
      {filters ? <div className="flex min-w-0 flex-wrap items-center gap-2">{filters}</div> : null}
      {activeFilterCount > 0 && onClearFilters ? (
        <button type="button" onClick={onClearFilters} className={buttonClassName({ variant: "ghost", size: "sm" })}>
          <X className="size-3.5" aria-hidden="true" />
          Clear filters
          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] leading-none text-foreground">{activeFilterCount}</span>
        </button>
      ) : null}
      {density ? <div className="ml-auto flex items-center gap-2">{density}</div> : null}
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
