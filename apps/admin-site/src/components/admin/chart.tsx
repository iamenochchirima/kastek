import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ChartColor = 1 | 2 | 3 | 4 | 5 | 6;

export type ChartSeries = {
  id: string;
  label: string;
  color: ChartColor;
  dashed?: boolean;
};

export function ChartCard({
  title,
  description,
  eyebrow,
  actions,
  children,
  footer,
  className,
}: {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("v-card overflow-hidden p-0", className)}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line px-[var(--density-card-padding)] py-4">
        <div className="min-w-0">
          {eyebrow ? <p className="v-label">{eyebrow}</p> : null}
          <h2 className="mt-1 text-base font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      <div className="p-[var(--density-card-padding)]">{children}</div>
      {footer ? <div className="border-t border-line px-[var(--density-card-padding)] py-3">{footer}</div> : null}
    </section>
  );
}

export function ChartLegend({ series, className }: { series: ChartSeries[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground", className)} aria-label="Chart legend">
      {series.map((item) => (
        <span key={item.id} className="inline-flex items-center gap-2">
          <span className={cn("size-2 rounded-full", item.dashed && "rounded-none bg-transparent border-t-2 border-dashed")} style={item.dashed ? { borderColor: `var(--chart-${item.color})` } : { backgroundColor: `var(--chart-${item.color})` }} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function ChartTooltip({
  title,
  values,
  className,
}: {
  title: string;
  values: Array<{ label: string; value: string; color?: ChartColor }>;
  className?: string;
}) {
  return (
    <div className={cn("pointer-events-none min-w-40 rounded-md border border-line bg-popover px-3 py-2 text-xs shadow-pop", className)} role="status">
      <p className="font-medium text-foreground">{title}</p>
      <div className="mt-1.5 space-y-1">
        {values.map((item) => <p key={item.label} className="flex items-center justify-between gap-4 text-muted-foreground"><span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full" style={{ backgroundColor: item.color ? `var(--chart-${item.color})` : "var(--muted-foreground)" }} aria-hidden="true" />{item.label}</span><span className="font-medium text-foreground">{item.value}</span></p>)}
      </div>
    </div>
  );
}

export function ChartState({
  kind,
  title,
  description,
  action,
}: {
  kind: "empty" | "unavailable" | "partial" | "stale" | "error";
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  const tone = kind === "error" ? "border-status-danger/25 bg-status-danger-soft" : kind === "stale" || kind === "partial" ? "border-status-attention/25 bg-status-attention-soft" : "border-dashed border-line bg-background/40";
  const titleTone = kind === "error" ? "text-status-danger" : kind === "stale" || kind === "partial" ? "text-status-attention" : "text-foreground";
  return (
    <div className={cn("flex min-h-56 items-center justify-center rounded-md border px-6 text-center", tone)} role={kind === "error" ? "alert" : "status"}>
      <div className="max-w-md">
        <p className={cn("text-sm font-medium", titleTone)}>{title}</p>
        {description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

export function ChartA11ySummary({ children }: { children: ReactNode }) {
  return <p className="sr-only">{children}</p>;
}
