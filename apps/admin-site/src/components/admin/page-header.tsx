import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AdminPageHeader({ title, description, actions, eyebrow, className }: { title: string; description?: string; actions?: ReactNode; eyebrow?: string; className?: string }) {
  return (
    <header className={cn("flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="v-label mb-1">{eyebrow}</p> : null}
        <h1 className="text-[24px] font-semibold leading-8 tracking-[-0.02em] text-foreground">{title}</h1>
        {description ? <p className="mt-1 max-w-3xl text-[13px] text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

export function AdminSectionHeader({ title, description, actions, className }: { title: string; description?: string; actions?: ReactNode; className?: string }) {
  return <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}><div><h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">{title}</h2>{description ? <p className="mt-1 text-xs text-muted-foreground">{description}</p> : null}</div>{actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}</div>;
}

export function AdminMetric({ label, value, detail, tone = "default" }: { label: string; value: ReactNode; detail?: ReactNode; tone?: "default" | "attention" | "danger" | "success" | "info" }) {
  const toneClasses = {
    default: "v-card",
    attention: "border-status-attention/25 bg-status-attention-soft",
    danger: "border-status-danger/25 bg-status-danger-soft",
    success: "border-status-success/25 bg-status-success-soft",
    info: "border-status-info/25 bg-status-info-soft",
  };
  return <article className={`rounded-[calc(var(--radius)-1px)] border p-[var(--density-card-padding)] shadow-card ${toneClasses[tone]}`}><p className="v-label">{label}</p><p className="mt-2 text-2xl font-semibold tracking-[-0.04em] text-foreground">{value}</p>{detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}</article>;
}
