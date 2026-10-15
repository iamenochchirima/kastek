"use client";

import Link from "next/link";
import { ArrowUpRight, Check, CircleAlert, CircleDot, ExternalLink, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentDynamicUi, AgentUiAction, AgentUiBlock } from "@/lib/agent-platform";
import { cn } from "@/lib/utils";
import { useState } from "react";

function validInternalHref(href: string | undefined): href is string {
  return Boolean(href && href.startsWith("/") && !href.startsWith("//"));
}

export type AgentUiInteraction = { blockId: string; actionId: string; values?: Record<string, unknown> };

function ActionButton({ blockId, action, onInteraction }: { blockId: string; action: AgentUiAction; onInteraction?: (interaction: AgentUiInteraction) => void }) {
  if (action.kind === "navigate" && validInternalHref(action.href)) {
    return (
      <Button asChild type="button" variant="outline" size="sm" className="h-8 gap-1.5 rounded-lg px-2.5 text-xs">
        <Link href={action.href}>
          {action.label}
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    );
  }
  if (action.kind !== "navigate" && onInteraction) {
    return (
      <Button type="button" variant="outline" size="sm" className="h-8 rounded-lg px-2.5 text-xs" onClick={() => onInteraction({ blockId, actionId: action.id })}>
        {action.label}
      </Button>
    );
  }
  return null;
}

function StatusDot({ tone = "neutral" }: { tone?: "success" | "warning" | "danger" | "neutral" }) {
  return <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", tone === "success" ? "bg-status-success" : tone === "warning" ? "bg-status-warning" : tone === "danger" ? "bg-destructive" : "bg-muted-foreground")} />;
}

function SummaryBlock({ block }: { block: Extract<AgentUiBlock, { type: "summary" }> }) {
  return (
    <section className="rounded-xl border border-border/80 bg-card/70 p-3 shadow-sm" aria-label={block.title ?? "Summary"}>
      {block.title ? <h3 className="mb-2 text-xs font-semibold text-foreground">{block.title}</h3> : null}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {block.items.map((item) => (
          <div key={item.label} className="rounded-lg border border-border/70 bg-background/70 px-2.5 py-2">
            <p className="truncate text-[10px] text-muted-foreground">{item.label}</p>
            <p className="mt-1 flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
              {item.status ? <StatusDot tone={item.status} /> : null}
              {item.value}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ListBlock({ block, onInteraction }: { block: Extract<AgentUiBlock, { type: "list" }>; onInteraction?: (interaction: AgentUiInteraction) => void }) {
  return (
    <section className="rounded-xl border border-border/80 bg-card/70 p-3 shadow-sm" aria-label={block.title ?? "List"}>
      {block.title ? <h3 className="mb-2 text-xs font-semibold text-foreground">{block.title}</h3> : null}
      {block.items.length ? (
        <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border/70 bg-background/60">
          {block.items.map((item) => (
            <div key={item.id ?? `${item.title}-${item.meta ?? ""}`} className="flex min-w-0 items-center gap-2.5 px-2.5 py-2.5">
              {item.status ? <StatusDot tone={item.status} /> : null}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{item.title}</p>
                {item.description ? <p className="truncate text-[11px] text-muted-foreground">{item.description}</p> : null}
              </div>
              {item.meta ? <span className="shrink-0 text-[10px] text-muted-foreground">{item.meta}</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">{block.emptyText ?? "Nothing to show"}</p>
      )}
      {block.actions?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {block.actions.map((action) => <ActionButton key={action.id} blockId={block.id} action={action} onInteraction={onInteraction} />)}
        </div>
      ) : null}
    </section>
  );
}

function FormBlock({ block, onInteraction }: { block: Extract<AgentUiBlock, { type: "form" }>; onInteraction?: (interaction: AgentUiInteraction) => void }) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitAction = block.actions.find((action) => action.kind === "submit");
  const submit = async () => {
    if (!submitAction || !onInteraction) return;
    const missing = block.fields.find((field) => field.required && (field.type === "checkbox" ? values[field.id] !== true : !String(values[field.id] ?? "").trim()));
    if (missing) {
      setError(`${missing.label} is required`);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onInteraction({ blockId: block.id, actionId: submitAction.id, values });
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="rounded-xl border border-border/80 bg-card/70 p-3 shadow-sm" aria-label={block.title ?? "Form"}>
      {block.title ? <h3 className="text-xs font-semibold text-foreground">{block.title}</h3> : null}
      {block.description ? <p className="mt-1 text-[11px] text-muted-foreground">{block.description}</p> : null}
      <div className="mt-3 space-y-3">
        {block.fields.map((field) => (
          <label key={field.id} className={cn("block text-xs", field.type === "checkbox" && "flex items-start gap-2")}>
            {field.type === "checkbox" ? (
              <input
                type="checkbox"
                checked={values[field.id] === true}
                onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.checked }))}
                className="mt-0.5 h-4 w-4 rounded border-border accent-primary"
              />
            ) : null}
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{field.label}{field.required ? <span className="text-destructive"> *</span> : null}</span>
              {field.description ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{field.description}</span> : null}
              {field.type === "select" ? (
                <select
                  value={String(values[field.id] ?? "")}
                  onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                  className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <option value="">Select an option</option>
                  {field.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              ) : field.type !== "checkbox" ? (
                field.type === "textarea" ? (
                  <textarea
                    value={String(values[field.id] ?? "")}
                    placeholder={field.placeholder}
                    maxLength={field.maxLength}
                    rows={3}
                    onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                    className="mt-1.5 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                ) : (
                  <input
                    type="text"
                    value={String(values[field.id] ?? "")}
                    placeholder={field.placeholder}
                    maxLength={field.maxLength}
                    onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))}
                    className="mt-1.5 h-9 w-full rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                )
              ) : null}
            </span>
          </label>
        ))}
      </div>
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {block.actions.map((action) => action.kind === "submit" ? (
          <Button key={action.id} type="button" size="sm" className="h-8 rounded-lg px-2.5 text-xs" disabled={submitting || !onInteraction} onClick={() => void submit()}>
            {submitting ? "Submitting…" : action.label}
          </Button>
        ) : <ActionButton key={action.id} blockId={block.id} action={action} onInteraction={onInteraction} />)}
      </div>
    </section>
  );
}

function ChoiceBlock({ block, onInteraction }: { block: Extract<AgentUiBlock, { type: "choice" }>; onInteraction?: (interaction: AgentUiInteraction) => void }) {
  return (
    <section className="rounded-xl border border-border/80 bg-card/70 p-3 shadow-sm" aria-label={block.title ?? "Choice"}>
      {block.title ? <h3 className="text-xs font-semibold text-foreground">{block.title}</h3> : null}
      {block.description ? <p className="mt-1 text-[11px] text-muted-foreground">{block.description}</p> : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {block.options.map((option) => (
          <Button key={option.id} type="button" variant="outline" className="h-auto min-h-9 justify-start rounded-lg px-3 py-2 text-left text-xs" disabled={!onInteraction} onClick={() => onInteraction?.({ blockId: block.id, actionId: option.id })}>
            <span>
              <span className="block font-medium">{option.label}</span>
              {option.description ? <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{option.description}</span> : null}
            </span>
          </Button>
        ))}
      </div>
    </section>
  );
}

function ProgressBlock({ block }: { block: Extract<AgentUiBlock, { type: "progress" }> }) {
  return (
    <section className="rounded-xl border border-border/80 bg-card/70 p-3 shadow-sm" aria-label={block.title ?? "Progress"}>
      {block.title ? <h3 className="mb-2 text-xs font-semibold text-foreground">{block.title}</h3> : null}
      <ol className="space-y-2">
        {block.steps.map((step, index) => {
          const Icon = step.status === "complete" ? Check : step.status === "error" ? CircleAlert : step.status === "active" ? LoaderCircle : CircleDot;
          return (
            <li key={`${step.label}-${index}`} className="flex items-start gap-2 text-xs">
              <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", step.status === "complete" ? "text-status-success" : step.status === "error" ? "text-destructive" : step.status === "active" ? "animate-spin text-primary" : "text-muted-foreground")} />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{step.label}</span>
                {step.detail ? <span className="mt-0.5 block text-[11px] text-muted-foreground">{step.detail}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function WorkspaceBlock({ block, onInteraction }: { block: Extract<AgentUiBlock, { type: "workspace" }>; onInteraction?: (interaction: AgentUiInteraction) => void }) {
  return (
    <section className="overflow-hidden rounded-xl border border-primary/25 bg-gradient-to-br from-primary/10 via-card to-card p-3 shadow-sm" aria-label={block.title}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground"><ExternalLink className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{block.title}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{block.description}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild type="button" size="sm" className="h-8 rounded-lg px-2.5 text-xs">
              <Link href={validInternalHref(block.href) ? block.href : "/"}>Open workspace <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" /></Link>
            </Button>
            {block.actions?.filter((action) => !(action.kind === "navigate" && action.href === block.href)).map((action) => <ActionButton key={action.id} blockId={block.id} action={action} onInteraction={onInteraction} />)}
          </div>
        </div>
      </div>
    </section>
  );
}

export function DynamicUiRenderer({ ui, onInteraction }: { ui?: AgentDynamicUi; onInteraction?: (interaction: AgentUiInteraction) => void | Promise<void> }) {
  if (!ui?.blocks?.length) return null;
  return (
    <div className={cn("mt-3 space-y-2", ui.mode === "expanded" && "sm:max-w-2xl")} aria-label="Interactive result">
      {ui.blocks.map((block) => {
        if (block.type === "summary") return <SummaryBlock key={block.id} block={block} />;
        if (block.type === "list") return <ListBlock key={block.id} block={block} onInteraction={onInteraction} />;
        if (block.type === "progress") return <ProgressBlock key={block.id} block={block} />;
        if (block.type === "workspace") return <WorkspaceBlock key={block.id} block={block} onInteraction={onInteraction} />;
        if (block.type === "form") return <FormBlock key={block.id} block={block} onInteraction={onInteraction} />;
        if (block.type === "choice") return <ChoiceBlock key={block.id} block={block} onInteraction={onInteraction} />;
        return null;
      })}
    </div>
  );
}
