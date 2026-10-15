import { cn } from "@/lib/utils";
import type { ComponentPropsWithoutRef } from "react";

export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("bg-accent animate-pulse rounded-md", className)}
      {...props}
    />
  );
}
