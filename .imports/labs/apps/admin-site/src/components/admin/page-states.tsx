import type { ReactNode } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function AdminEmptyState({ title, description, action, className }: { title: string; description?: string; action?: ReactNode; className?: string }) {
  return <div className={cn("flex min-h-32 flex-col items-center justify-center rounded-md border border-dashed border-border px-5 py-8 text-center", className)}><p className="text-sm font-medium text-foreground">{title}</p>{description ? <p className="mt-1 max-w-md text-xs text-muted-foreground">{description}</p> : null}{action ? <div className="mt-4">{action}</div> : null}</div>;
}

export function AdminErrorState({ title = "Unable to load data", message, onRetry, className }: { title?: string; message?: string; onRetry?: () => void; className?: string }) {
  return <div role="alert" className={cn("flex min-h-32 flex-col items-center justify-center rounded-md border border-status-danger/25 bg-status-danger-soft px-5 py-8 text-center", className)}><AlertCircle className="size-5 text-status-danger" aria-hidden="true" /><p className="mt-2 text-sm font-medium text-status-danger">{title}</p>{message ? <p className="mt-1 max-w-md text-xs text-status-danger/80">{message}</p> : null}{onRetry ? <button type="button" onClick={onRetry} className={buttonClassName({ variant: "outline", size: "sm", className: "mt-4" })}><RefreshCw className="size-3.5" />Retry</button> : null}</div>;
}

export function AdminLoadingState({ rows = 3, className }: { rows?: number; className?: string }) {
  return <div aria-label="Loading" className={cn("space-y-3", className)}>{Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>;
}
