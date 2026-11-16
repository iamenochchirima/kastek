import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PiSidebarSimple, PiX } from "react-icons/pi";
import type { AssistantPanelProps } from "./assistant-types.js";
import { AssistantNavigation } from "./assistant-navigation.js";
import { cn } from "../utils.js";

const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 900;
const DEFAULT_PANEL_WIDTH = 480;

function readWidth(storageKey: string): number {
  if (typeof window === "undefined") return DEFAULT_PANEL_WIDTH;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return DEFAULT_PANEL_WIDTH;
    const value = Number(stored);
    if (Number.isFinite(value)) return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, value));
  } catch { /* The panel remains usable when storage is unavailable. */ }
  return DEFAULT_PANEL_WIDTH;
}

function readExpanded(storageKey: string): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return true;
    return stored !== "false";
  } catch { return true; }
}

function saveValue(storageKey: string, value: string) {
  try { window.localStorage.setItem(storageKey, value); } catch { /* The panel remains usable when storage is unavailable. */ }
}

export function AssistantPanel({ open, onClose, hidden = false, identity, view, navigation, widthKey, navigationStorageKey, ariaLabel, backdropClassName, closeOnOutsideClick = true, headerActions, className, returnFocusRef, children }: AssistantPanelProps) {
  const panel = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const widthRef = useRef(width);
  widthRef.current = width;
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const expandedKey = navigationStorageKey ?? `${widthKey}.navigation`;
  const [navigationExpanded, setNavigationExpanded] = useState(true);

  useEffect(() => { setWidth(readWidth(widthKey)); }, [widthKey]);
  useEffect(() => { setNavigationExpanded(readExpanded(expandedKey)); }, [expandedKey]);
  useEffect(() => { if (!open) setMobileNavigationOpen(false); }, [open]);
  useEffect(() => { if (hidden && open) onClose(); }, [hidden, open, onClose]);

  const close = useCallback(() => { onClose(); }, [onClose]);

  useEffect(() => {
    if (!open || hidden) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => {
      panel.current?.querySelector<HTMLTextAreaElement>("textarea, input")?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      const previous = previousFocus.current;
      requestAnimationFrame(() => {
        const target = returnFocusRef?.current?.isConnected ? returnFocusRef.current : previous?.isConnected && previous !== document.body ? previous : null;
        if (target?.isConnected) target.focus();
      });
    };
  }, [open, hidden, returnFocusRef]);

  useEffect(() => {
    if (!open || hidden) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[data-slot="dialog-content"]')) return;
      if (mobileNavigationOpen) { setMobileNavigationOpen(false); return; }
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, hidden, mobileNavigationOpen, close]);

  useEffect(() => {
    if (!open || hidden || !closeOnOutsideClick) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || panel.current?.contains(target)) return;
      // Portaled selects, menus and application dialogs belong to the open panel flow.
      if (target.closest('[data-slot="dialog-content"],[role="alertdialog"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper]')) return;
      close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, hidden, closeOnOutsideClick, close]);

  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth < 640) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = { x: event.clientX, width: widthRef.current };
    setResizing(true);
  }, []);
  const moveResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return;
    const max = Math.min(MAX_PANEL_WIDTH, window.innerWidth);
    setWidth(Math.min(max, Math.max(Math.min(MIN_PANEL_WIDTH, window.innerWidth), resizeStart.current.width + resizeStart.current.x - event.clientX)));
  }, []);
  const finishResize = useCallback(() => {
    resizeStart.current = null;
    setResizing(false);
    saveValue(widthKey, String(widthRef.current));
  }, [widthKey]);
  const toggleNavigation = useCallback(() => {
    setNavigationExpanded(current => {
      const next = !current;
      saveValue(expandedKey, String(next));
      return next;
    });
  }, [expandedKey]);

  if (!open || hidden) return null;

  return createPortal(<div className="fixed inset-0 z-40" role="presentation">
    <div aria-hidden="true" className={cn("absolute inset-0 bg-black/40 sm:hidden", backdropClassName)} onClick={closeOnOutsideClick ? close : undefined} />
    <aside ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={ariaLabel ?? identity.name} style={{ width: `min(${width}px, 100vw)` }}
      className={cn("fixed inset-y-0 right-0 z-40 flex max-w-full flex-col border-l border-border bg-background shadow-2xl", resizing && "select-none", className)}>
      <div role="separator" aria-orientation="vertical" aria-label={`Resize ${identity.name} panel`} aria-valuemin={MIN_PANEL_WIDTH} aria-valuemax={MAX_PANEL_WIDTH} aria-valuenow={Math.round(width)}
        className="absolute inset-y-0 -left-2 z-10 hidden w-4 cursor-ew-resize touch-none sm:block" onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={finishResize} />
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:hidden" onClick={() => setMobileNavigationOpen(true)} aria-label={`Open ${identity.name} navigation`} aria-expanded={mobileNavigationOpen}>
            <PiSidebarSimple size={16} aria-hidden="true" />
          </button>
          {identity.icon ? <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">{identity.icon}</span> : null}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{identity.name}</h2>
            {identity.subtitle ? <p className="truncate text-[11px] text-muted-foreground">{identity.subtitle}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {headerActions}
          <button type="button" className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={close} aria-label={`Close ${identity.name}`}>
            <PiX size={18} aria-hidden="true" />
          </button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <div className="hidden min-h-0 shrink-0 sm:flex">
          <AssistantNavigation title={navigation.title} expanded={navigationExpanded} activeView={view} items={navigation.items} recents={navigation.recents}
            selectedConversationId={navigation.selectedConversationId} onToggle={toggleNavigation} onSelect={navigation.onSelect} onNewChat={navigation.onNewChat}
            onOpenConversation={navigation.onOpenConversation} />
        </div>
        {mobileNavigationOpen ? <>
          <div className="absolute inset-0 z-10 bg-black/40 sm:hidden" onClick={() => setMobileNavigationOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 z-20 flex w-64 max-w-[calc(100%-3rem)] sm:hidden">
            <AssistantNavigation title={navigation.title} expanded activeView={view} items={navigation.items} recents={navigation.recents}
              selectedConversationId={navigation.selectedConversationId} onToggle={() => setMobileNavigationOpen(false)} onSelect={navigation.onSelect}
              onNewChat={navigation.onNewChat} onOpenConversation={navigation.onOpenConversation} onNavigate={() => setMobileNavigationOpen(false)} />
          </div>
        </> : null}
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </aside>
  </div>, document.body);
}
