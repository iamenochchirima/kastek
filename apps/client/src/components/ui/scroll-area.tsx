import { cn } from "@/lib/utils";
import * as React from "react";

export function ScrollArea({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-auto", className)} {...props} />;
}
