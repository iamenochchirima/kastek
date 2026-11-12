"use client";

import * as React from "react";
import { PiCaretDown } from "react-icons/pi";
import { Button } from "./button.js";
import { Input } from "./input.js";
import { Skeleton } from "./skeleton.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog.js";
import { cn } from "./utils.js";

export interface AgentModelOption {
  id: string; label: string; provider?: string; disabled?: boolean; reason?: string;
  contextWindowTokens?: number | null; maxOutputTokens?: number | null;
  pricing?: { currency: "USD"; inputMicrosPerMillionTokens: number | null; outputMicrosPerMillionTokens: number | null } | null;
}
const tokens = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) && value > 0 ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: value >= 1_000_000 ? 1 : 0 }).format(value) : "Unavailable";
function modelPrice(pricing: AgentModelOption["pricing"]): string {
  if (!pricing) return "Pricing unavailable";
  if (pricing.inputMicrosPerMillionTokens === 0 && pricing.outputMicrosPerMillionTokens === 0) return "Free";
  const price = (value: number | null) => typeof value === "number" && Number.isFinite(value) && value >= 0
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: pricing.currency, minimumFractionDigits: 0, maximumFractionDigits: 6 }).format(value / 1_000_000) : "Unavailable";
  return `${price(pricing.inputMicrosPerMillionTokens)}/${price(pricing.outputMicrosPerMillionTokens)}`;
}
export interface AgentModelPickerProps {
  label: string; ariaLabel?: string; readOnly?: boolean; disabled?: boolean;
  open: boolean; onOpenChange(open: boolean): void;
  options: AgentModelOption[]; selectedId: string; onSelect(id: string): void;
  search: string; onSearch(value: string): void;
  loading?: boolean; saving?: boolean; error?: string | null; saveDisabled?: boolean;
  description?: string; footer?: React.ReactNode;
  onSave(): void; onReload(): void;
}

/** Shared model selection presentation. Each product owns catalogue access and saved configuration. */
export function AgentModelPicker({ label, ariaLabel, readOnly, disabled, open, onOpenChange, options, selectedId, onSelect,
  search, onSearch, loading, saving, error, saveDisabled, description = "Applies to new messages.", footer, onSave, onReload }: AgentModelPickerProps) {
  const group = React.useId(), term = search.trim().toLocaleLowerCase();
  const visible = options.filter(option => !term || `${option.label} ${option.provider ?? ""}`.toLocaleLowerCase().includes(term));
  if (readOnly) return <span className="max-w-[min(45vw,16rem)] truncate text-xs text-muted-foreground" title={label}>{label}</span>;
  return <>
    <Button type="button" variant="ghost" size="sm" className="min-h-11 min-w-0 max-w-[min(45vw,16rem)] gap-1.5 px-2 text-xs sm:min-h-8" title={label}
      aria-label={ariaLabel ?? `Chat model: ${label}`} disabled={disabled} onClick={() => onOpenChange(true)}><span className="truncate">{label}</span><PiCaretDown aria-hidden className="size-3 shrink-0" /></Button>
    <Dialog open={open} onOpenChange={value => { if (!saving) onOpenChange(value); }}><DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-lg">
      <DialogHeader><DialogTitle>Choose model</DialogTitle><DialogDescription className="sr-only">{description}</DialogDescription></DialogHeader>
      <Input className="min-h-11 sm:min-h-9" aria-label="Search models" placeholder="Search models" value={search} onChange={event => onSearch(event.target.value)} disabled={loading || saving} />
      {loading ? <div className="space-y-2" role="status" aria-label="Loading models">{[0,1,2].map(index => <Skeleton key={index} className="h-14 w-full" />)}</div>
        : <fieldset className="max-h-[45dvh] min-h-0 min-w-0 space-y-1 overflow-y-auto"><legend className="sr-only">Model</legend>{visible.map(option => <label key={option.id}
          className={cn("flex min-h-12 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm",selectedId === option.id ? "border-primary bg-primary/5" : "border-transparent hover:bg-secondary",option.disabled && "cursor-not-allowed opacity-50")}>
          <input type="radio" name={group} value={option.id} checked={selectedId === option.id} disabled={saving || option.disabled} onChange={() => onSelect(option.id)} className="size-4 shrink-0 accent-primary" />
          <span className="min-w-0 flex-1"><span className="block break-words font-medium">{option.label}</span>
            {option.reason ? <span className="block text-xs text-muted-foreground">{option.reason}</span> : null}</span>
          <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">
            {option.contextWindowTokens !== undefined ? <span className="block" title="Context window" aria-label={`Context window: ${tokens(option.contextWindowTokens)}`}>{tokens(option.contextWindowTokens)}</span> : null}
            {option.pricing !== undefined ? <span className="mt-0.5 block" title="Input / output price per million tokens">{modelPrice(option.pricing)}</span> : null}
          </span>
        </label>)}{!visible.length ? <p className="py-6 text-center text-sm text-muted-foreground">{term ? "No matching models" : "No models available"}</p> : null}</fieldset>}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {footer}
      <DialogFooter className="shrink-0"><Button className="min-h-11 sm:min-h-9" type="button" variant="ghost" disabled={loading || saving} onClick={onReload}>Refresh models</Button><Button className="min-h-11 sm:min-h-9" type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button><Button className="min-h-11 sm:min-h-9" type="button" disabled={loading || saving || saveDisabled || !options.some(option => option.id === selectedId && !option.disabled)} onClick={onSave}>{saving ? "Saving…" : "Save model"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
