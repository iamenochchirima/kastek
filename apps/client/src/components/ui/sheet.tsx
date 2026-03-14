"use client";

import { cn } from "@/lib/utils";
import * as React from "react";

const SheetContext = React.createContext<{ open: boolean; setOpen: React.Dispatch<React.SetStateAction<boolean>> } | null>(null);

export function Sheet({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return <SheetContext.Provider value={{ open, setOpen }}>{children}</SheetContext.Provider>;
}

export function SheetTrigger({ asChild, children }: { asChild?: boolean; children: React.ReactElement }) {
  const ctx = React.useContext(SheetContext);
  if (!ctx) return children;
  const props = { onClick: () => ctx.setOpen(true) };
  return asChild ? React.cloneElement(children, props) : <button {...props}>{children}</button>;
}

export function SheetContent({ children, className, side = "left" }: { children: React.ReactNode; className?: string; side?: "left" | "right" }) {
  const ctx = React.useContext(SheetContext);
  if (!ctx?.open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <button type="button" className="absolute inset-0 bg-black/40" onClick={() => ctx.setOpen(false)} aria-label="Close sheet" />
      <div className={cn("absolute inset-y-0 w-64 bg-card shadow-xl", side === "left" ? "left-0" : "right-0", className)}>
        {children}
      </div>
    </div>
  );
}
