"use client";

import { useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { AgentModel, AgentModelProvider } from "@/lib/agent-platform";

export function AgentModelPicker({
  model,
  models,
  disabled,
  onSelect,
  compact = false,
  menuPlacement = "below",
  ariaLabel = "Choose this agent's model",
  pickerTitle = "Choose a model for this chat",
}: {
  model?: AgentModel;
  models: AgentModel[];
  disabled: boolean;
  onSelect: (model: string, provider: AgentModelProvider) => void;
  compact?: boolean;
  menuPlacement?: "above" | "below";
  ariaLabel?: string;
  pickerTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = model ? `${model.provider}:${model.model}` : "";
  const visible = open && !disabled;
  const normalizedSearch = search.trim().toLowerCase();
  const matchingModels = models.filter(
    (item) =>
      !normalizedSearch ||
      `${item.label} ${item.model} ${item.provider}`
        .toLowerCase()
        .includes(normalizedSearch),
  );
  const displayedModels = matchingModels.slice(0, normalizedSearch ? 100 : 30);

  const close = () => {
    setOpen(false);
    setSearch("");
  };

  return (
    <div className="relative min-w-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((value) => !value);
          setSearch("");
        }}
        className={compact
          ? "flex max-w-[14rem] items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
          : "flex h-10 w-full min-w-0 items-center justify-between gap-1.5 rounded-md border border-input bg-background px-3 text-left text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"}
        aria-haspopup="listbox"
        aria-expanded={visible}
      >
        <span className="truncate">{model?.label ?? (compact ? "Workspace default" : "Choose a model")}</span>
        <ChevronDown className={compact ? "h-3.5 w-3.5 shrink-0" : "h-4 w-4 shrink-0 text-muted-foreground"} />
      </button>
      {visible ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-10 cursor-default"
            onClick={close}
            aria-label="Close model picker"
          />
          <div
            className={`absolute left-0 z-20 w-72 min-w-[20rem] overflow-hidden rounded-lg border border-border bg-popover shadow-xl ${menuPlacement === "above" ? "bottom-full mb-2" : "top-full mt-2"}`}
            role="listbox"
            aria-label={ariaLabel}
          >
            <div className="border-b border-border px-3 py-2 text-[10px] text-muted-foreground">
              {pickerTitle}
            </div>
            <label className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search models or IDs…"
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <div className="max-h-64 overflow-y-auto p-1">
              {displayedModels.map((item) => {
                const value = `${item.provider}:${item.model}`;
                const active = value === selected;
                const unavailable = item.description === "Saved model is not in the current catalog.";
                return (
                  <button
                    type="button"
                    key={value}
                    role="option"
                    aria-selected={active}
                    onClick={() => {
                      onSelect(item.model, item.provider);
                      close();
                    }}
                    className={`w-full rounded-md px-2.5 py-2 text-left transition-colors${active ? " bg-primary/10 text-primary" : " hover:bg-muted"}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium">{item.label}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {unavailable ? "unavailable" : item.isFree ? "free" : item.tier}
                      </span>
                    </div>
                  </button>
                );
              })}
              {!matchingModels.length ? (
                <p className="px-2.5 py-4 text-xs text-muted-foreground">No models match that search.</p>
              ) : null}
              {matchingModels.length > displayedModels.length ? (
                <p className="px-2.5 py-2 text-[10px] text-muted-foreground">
                  Showing first {displayedModels.length} results. Search to narrow the list.
                </p>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
