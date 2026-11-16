import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AgentConversation } from "./agent-conversation";
import { useGrowthAgents } from "./agent-provider";
import { cn } from "@/lib/utils";

const MIN_PANEL_WIDTH = 360;
const MAX_PANEL_WIDTH = 900;
const DEFAULT_PANEL_WIDTH = 480;
const WIDTH_KEY_PREFIX = "kasitek:growth-assistant-width";

function restoreLauncherFocus() { requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-growth-assistant-launcher]")?.focus()); }

function subscribe(callback: () => void) { const query = window.matchMedia("(min-width: 1280px)"); query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); }
const snapshot = () => window.matchMedia("(min-width: 1280px)").matches;

function readWidth(key: string): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    if (Number.isFinite(value)) return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, value));
  } catch { /* The panel remains usable when storage is unavailable. */ }
  return DEFAULT_PANEL_WIDTH;
}

function saveWidth(key: string, value: number) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* The panel remains usable when storage is unavailable. */ }
}

export function GrowthAssistantDock() {
  const { panelOpen, closePanel, setPanelOpen, scopeKey } = useGrowthAgents();
  const desktop = useSyncExternalStore(subscribe, snapshot, () => false);
  const [viewport, setViewport] = useState<{ height: number; top: number } | null>(null);
  const widthKey = `${WIDTH_KEY_PREFIX}.${scopeKey}`;
  const [width, setWidth] = useState(DEFAULT_PANEL_WIDTH);
  const widthRef = useRef(width);
  widthRef.current = width;
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  useEffect(() => { setWidth(readWidth(widthKey)); }, [widthKey]);
  useEffect(() => {
    if (desktop || !panelOpen) return;
    const sync = () => setViewport({ height: window.visualViewport?.height ?? window.innerHeight, top: window.visualViewport?.offsetTop ?? 0 });
    const frame = requestAnimationFrame(sync);
    window.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("resize", sync);
    window.visualViewport?.addEventListener("scroll", sync);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", sync); window.visualViewport?.removeEventListener("resize", sync); window.visualViewport?.removeEventListener("scroll", sync); };
  }, [desktop, panelOpen]);
  const previousFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!panelOpen || !desktop) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector('[data-slot="dialog-content"]')) closePanel(); };
    document.addEventListener("keydown", close);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", close); if (previousFocus.current?.isConnected && previousFocus.current !== document.body) previousFocus.current.focus(); else if (!document.querySelector('[data-slot="dialog-content"]')) restoreLauncherFocus(); };
  }, [panelOpen, closePanel, desktop]);
  const beginResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
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
    if (!resizeStart.current) return;
    resizeStart.current = null;
    setResizing(false);
    saveWidth(widthKey, widthRef.current);
  }, [widthKey]);
  if (desktop) return panelOpen ? <aside ref={panel} aria-label="Growth assistant" style={{ width: `min(${width}px, 100vw)` }} className={cn("relative sticky top-14 z-20 h-[calc(100dvh-56px)] shrink-0 self-start border-l border-border", resizing && "select-none")}>
    <div role="separator" aria-orientation="vertical" aria-label="Resize Growth assistant panel" aria-valuemin={MIN_PANEL_WIDTH} aria-valuemax={MAX_PANEL_WIDTH} aria-valuenow={Math.round(width)}
      className="absolute inset-y-0 -left-2 z-10 w-4 cursor-ew-resize touch-none" onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={finishResize}>
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors hover:bg-primary" />
    </div>
    <AgentConversation onClose={closePanel} />
  </aside> : null;
  return <Dialog open={panelOpen} onOpenChange={setPanelOpen}><DialogContent showCloseButton={false} onCloseAutoFocus={(event) => { event.preventDefault(); restoreLauncherFocus(); }} style={{ height: viewport?.height, minHeight: viewport?.height ?? 0, maxHeight: viewport?.height, top: viewport?.top ?? 0 }} className="dashboard-theme inset-0 left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none"><DialogTitle className="sr-only">Growth assistant</DialogTitle><DialogDescription className="sr-only">Agent conversation</DialogDescription><AgentConversation onClose={closePanel} /></DialogContent></Dialog>;
}
