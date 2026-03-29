import { cn } from "@/lib/utils";
import type { ComponentPropsWithoutRef } from "react";

export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-secondary/70", className)}
      {...props}
    />
  );
}
