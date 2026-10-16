import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Progress({ value = 0, max = 100, className, ...props }: HTMLAttributes<HTMLDivElement> & { value?: number; max?: number }) {
  const safeMax = max > 0 ? max : 100;
  const percentage = Math.min(100, Math.max(0, (value / safeMax) * 100));
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={Math.min(safeMax, Math.max(0, value))}
      className={cn("relative h-2 w-full overflow-hidden rounded-full bg-primary/15", className)}
      {...props}
    >
      <div data-slot="progress-indicator" className="h-full rounded-full bg-primary transition-[width] duration-[var(--v-motion-fast)]" style={{ width: `${percentage}%` }} />
    </div>
  );
}
