"use client";

import { createContext, useContext, useId, useState, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type TabsContextValue = { value: string; setValue: (value: string) => void; baseId: string };
const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const context = useContext(TabsContext);
  if (!context) throw new Error("Tabs components must be used inside Tabs");
  return context;
}

export function Tabs({ defaultValue, value: controlledValue, onValueChange, children, className, ...props }: HTMLAttributes<HTMLDivElement> & { defaultValue?: string; value?: string; onValueChange?: (value: string) => void; children: ReactNode }) {
  const baseId = useId();
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue ?? "");
  const value = controlledValue ?? uncontrolledValue;
  function setValue(nextValue: string) {
    if (controlledValue === undefined) setUncontrolledValue(nextValue);
    onValueChange?.(nextValue);
  }
  return <TabsContext.Provider value={{ value, setValue, baseId }}><div data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props}>{children}</div></TabsContext.Provider>;
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="tablist" data-slot="tabs-list" className={cn("inline-flex h-9 w-fit items-center justify-center rounded-md bg-secondary p-1 text-muted-foreground", className)} {...props} />;
}

export function TabsTrigger({ value, className, children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const context = useTabsContext();
  const selected = context.value === value;
  const contentId = `${context.baseId}-content-${value}`;
  return <button id={`${context.baseId}-trigger-${value}`} type="button" role="tab" aria-selected={selected} aria-controls={contentId} data-state={selected ? "active" : "inactive"} onClick={(event) => { onClick?.(event); if (!event.defaultPrevented) context.setValue(value); }} className={cn("inline-flex h-full items-center justify-center rounded px-3 py-1 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-card disabled:pointer-events-none disabled:opacity-50", className)} {...props}>{children}</button>;
}

export function TabsContent({ value, className, children, ...props }: HTMLAttributes<HTMLDivElement> & { value: string }) {
  const context = useTabsContext();
  const active = context.value === value;
  const triggerId = `${context.baseId}-trigger-${value}`;
  const contentId = `${context.baseId}-content-${value}`;
  return <div role="tabpanel" id={contentId} aria-labelledby={triggerId} hidden={!active} data-state={active ? "active" : "inactive"} data-slot="tabs-content" className={cn("flex-1 outline-none", className)} {...props}>{children}</div>;
}
