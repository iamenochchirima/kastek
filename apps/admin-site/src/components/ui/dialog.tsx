"use client";

import { createContext, createElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type HTMLAttributes, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { buttonClassName } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type DialogContextValue = { open: boolean; setOpen: (open: boolean) => void; titleId: string; descriptionId: string };
const DialogContext = createContext<DialogContextValue | null>(null);

function useDialogContext() {
  const context = useContext(DialogContext);
  if (!context) throw new Error("Dialog components must be used inside Dialog");
  return context;
}

export function Dialog({ open: controlledOpen, defaultOpen = false, onOpenChange, children }: { open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const id = useId();
  const setOpen = useCallback((nextOpen: boolean) => {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }, [controlledOpen, onOpenChange]);
  const contextValue = useMemo(() => ({ open, setOpen, titleId: `${id}-title`, descriptionId: `${id}-description` }), [id, open, setOpen]);
  return <DialogContext.Provider value={contextValue}>{children}</DialogContext.Provider>;
}

export function DialogTrigger({ asChild, children, className, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean; children: ReactNode }) {
  const context = useDialogContext();
  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => { onClick?.(event); if (!event.defaultPrevented) context.setOpen(true); };
  if (asChild && children && typeof children === "object" && "type" in children) {
    const child = children as ReactElement<{ onClick?: (event: React.MouseEvent<HTMLElement>) => void; className?: string }>;
    return createElement(child.type, { ...child.props, ...props, className: cn(child.props.className, className), onClick: (event: React.MouseEvent<HTMLElement>) => { onClick?.(event as React.MouseEvent<HTMLButtonElement>); child.props.onClick?.(event); if (!event.defaultPrevented) context.setOpen(true); } });
  }
  return <button type="button" {...props} onClick={handleClick} className={className}>{children}</button>;
}

export function DialogPortal({ children }: { children: ReactNode }) {
  const context = useDialogContext();
  if (!context.open) return null;
  return typeof document === "undefined" ? null : createPortal(children, document.body);
}

export function DialogOverlay({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  const context = useDialogContext();
  return <div data-slot="dialog-overlay" className={cn("fixed inset-0 z-[var(--z-overlay)] bg-overlay/70 backdrop-blur-sm", className)} {...props} onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented) context.setOpen(false); }} />;
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
}

export function DialogContent({ className, children, showCloseButton = true, ...props }: HTMLAttributes<HTMLDivElement> & { showCloseButton?: boolean }) {
  const context = useDialogContext();
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!context.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const content = contentRef.current;
    const initial = content?.querySelector<HTMLElement>("[data-dialog-autofocus]") ?? focusableElements(content ?? document.body)[0];
    initial?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); context.setOpen(false); return; }
      if (event.key !== "Tab" || !content) return;
      const focusable = focusableElements(content);
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); document.body.style.overflow = previousBodyOverflow; previous?.focus(); };
  }, [context]);

  return <DialogPortal><DialogOverlay /><div ref={contentRef} data-slot="dialog-content" role="dialog" aria-modal="true" aria-labelledby={context.titleId} aria-describedby={context.descriptionId} tabIndex={-1} className={cn("fixed left-1/2 top-1/2 z-[var(--z-overlay)] grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-[calc(var(--radius)-1px)] border border-border bg-card p-[var(--density-card-padding)] shadow-pop outline-none", className)} {...props} onClick={(event) => { props.onClick?.(event); event.stopPropagation(); }}>{children}{showCloseButton ? <DialogClose aria-label="Close dialog" className="absolute right-3 top-3" ><X className="size-4" /></DialogClose> : null}</div></DialogPortal>;
}

export function DialogClose({ className, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const context = useDialogContext();
  return <button type="button" {...props} onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented) context.setOpen(false); }} className={cn(buttonClassName({ variant: "ghost", size: "icon" }), className)}>{children ?? <X className="size-4" />}</button>;
}

export function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div data-slot="dialog-header" className={cn("flex flex-col gap-1.5", className)} {...props} />; }
export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div data-slot="dialog-footer" className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />; }
export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) { const context = useDialogContext(); return <h2 id={context.titleId} data-slot="dialog-title" className={cn("text-base font-semibold tracking-[-0.01em] text-foreground", className)} {...props} />; }
export function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) { const context = useDialogContext(); return <p id={context.descriptionId} data-slot="dialog-description" className={cn("text-sm text-muted-foreground", className)} {...props} />; }

export function Sheet({ open, defaultOpen, onOpenChange, children }: Parameters<typeof Dialog>[0]) { return <Dialog open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>{children}</Dialog>; }
export const SheetTrigger = DialogTrigger;
export const SheetClose = DialogClose;
export const SheetPortal = DialogPortal;
export const SheetOverlay = DialogOverlay;
export function SheetContent({ side = "right", className, children, ...props }: HTMLAttributes<HTMLDivElement> & { side?: "top" | "right" | "bottom" | "left" }) {
  const context = useDialogContext();
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!context.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const initial = contentRef.current?.querySelector<HTMLElement>("[data-dialog-autofocus]") ?? focusableElements(contentRef.current ?? document.body)[0];
    initial?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); context.setOpen(false); return; }
      if (event.key !== "Tab" || !contentRef.current) return;
      const focusable = focusableElements(contentRef.current);
      if (focusable.length === 0) { event.preventDefault(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); document.body.style.overflow = previousBodyOverflow; previous?.focus(); };
  }, [context]);
  const sideClass = { right: "inset-y-0 right-0 h-full w-[min(22rem,88vw)] border-l", left: "inset-y-0 left-0 h-full w-[min(22rem,88vw)] border-r", top: "inset-x-0 top-0 border-b", bottom: "inset-x-0 bottom-0 border-t" }[side];
  return <DialogPortal><DialogOverlay /><div ref={contentRef} data-slot="sheet-content" role="dialog" aria-modal="true" aria-labelledby={context.titleId} aria-describedby={context.descriptionId} className={cn("fixed z-[var(--z-overlay)] flex max-h-dvh flex-col gap-4 overflow-y-auto bg-card p-[var(--density-card-padding)] shadow-pop outline-none", sideClass, className)} {...props} onClick={(event) => { props.onClick?.(event); event.stopPropagation(); }}>{children}<DialogClose aria-label="Close panel" className="absolute right-3 top-3"><X className="size-4" /></DialogClose></div></DialogPortal>;
}
export const SheetHeader = DialogHeader;
export const SheetFooter = DialogFooter;
export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;
