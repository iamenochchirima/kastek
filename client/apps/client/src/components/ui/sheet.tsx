"use client";

import { cn } from "@/lib/utils";
import * as React from "react";

const SheetContext = React.createContext<{ open: boolean; setOpen: React.Dispatch<React.SetStateAction<boolean>> } | null>(null);

export type SheetProps = {
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: React.Dispatch<React.SetStateAction<boolean>> | ((open: boolean) => void);
};

export const Sheet = ({ children, open: openProp, onOpenChange }: SheetProps) => {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : internalOpen;

  const setOpen = React.useCallback(
    (next: React.SetStateAction<boolean>) => {
      const resolved = typeof next === "function" ? next(open) : next;

      if (!isControlled) {
        setInternalOpen(resolved);
      }

      onOpenChange?.(resolved);
    },
    [isControlled, onOpenChange, open],
  );

  return <SheetContext.Provider value={{ open, setOpen }}>{children}</SheetContext.Provider>;
};

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
      <button type="button" className="absolute inset-0 bg-foreground/40" onClick={() => ctx.setOpen(false)} aria-label="Close sheet" />
      <div className={cn("absolute inset-y-0 w-64 bg-card shadow-xl", side === "left" ? "left-0" : "right-0", className)}>
        {children}
      </div>
    </div>
  );
}
