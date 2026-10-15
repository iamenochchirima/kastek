import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "secondary" | "outline" | "success" | "attention" | "danger" | "info";

const variants: Record<BadgeVariant, string> = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border bg-transparent text-foreground",
  success: "border-status-success/25 bg-status-success-soft text-status-success",
  attention: "border-status-attention/25 bg-status-attention-soft text-status-attention",
  danger: "border-status-danger/25 bg-status-danger-soft text-status-danger",
  info: "border-status-info/25 bg-status-info-soft text-status-info",
};

export function Badge({ className, variant = "default", ...props }: ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return <span data-slot="badge" className={cn("inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", variants[variant], className)} {...props} />;
}
