import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import type { AssistantLauncherProps } from "./assistant-types.js";
import { cn } from "../utils.js";

const LAUNCHER_SIZE = 56;
const DRAG_THRESHOLD = 4;

type LauncherPosition = { left: number; top: number };
type DragState = {
  pointerId: number;
  startLeft: number;
  startTop: number;
  offsetX: number;
  offsetY: number;
  moved: boolean;
};

function clampPosition(position: LauncherPosition): LauncherPosition {
  if (typeof window === "undefined") return position;
  const gutter = window.innerWidth < 640 ? 16 : 24;
  const maxLeft = Math.max(gutter, window.innerWidth - LAUNCHER_SIZE - gutter);
  const maxTop = Math.max(gutter, window.innerHeight - LAUNCHER_SIZE - gutter);
  return { left: Math.min(Math.max(gutter, position.left), maxLeft), top: Math.min(Math.max(gutter, position.top), maxTop) };
}

function readSavedPosition(storageKey: string): LauncherPosition | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<LauncherPosition> | null;
    if (typeof value?.left !== "number" || typeof value.top !== "number") return null;
    return clampPosition({ left: value.left, top: value.top });
  } catch { return null; }
}

function savePosition(storageKey: string, position: LauncherPosition) {
  try { window.localStorage.setItem(storageKey, JSON.stringify(position)); } catch { /* The launcher remains usable when storage is unavailable. */ }
}

export function AssistantLauncher({ open, onOpenChange, label, icon, storageKey, hidden = false, bottomInset = 0, className, dataAttributes, triggerRef }: AssistantLauncherProps) {
  const dragRef = useRef<DragState | null>(null);
  const positionRef = useRef<LauncherPosition | null>(null);
  const suppressClickRef = useRef(false);
  const [position, setPosition] = useState<LauncherPosition | null>(null);
  const [dragging, setDragging] = useState(false);

  const setLauncherPosition = useCallback((next: LauncherPosition | null) => {
    positionRef.current = next;
    setPosition(next);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setLauncherPosition(readSavedPosition(storageKey));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [storageKey, setLauncherPosition]);

  useEffect(() => {
    const onResize = () => {
      const current = positionRef.current;
      if (!current) return;
      const next = clampPosition(current);
      setLauncherPosition(next);
      savePosition(storageKey, next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [storageKey, setLauncherPosition]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    setDragging(false);
    if (drag.moved) {
      suppressClickRef.current = true;
      if (positionRef.current) savePosition(storageKey, positionRef.current);
    }
  }, [storageKey]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = { pointerId: event.pointerId, startLeft: rect.left, startTop: rect.top, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, moved: false };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const left = event.clientX - drag.offsetX;
    const top = event.clientY - drag.offsetY;
    if (!drag.moved && Math.hypot(left - drag.startLeft, top - drag.startTop) >= DRAG_THRESHOLD) drag.moved = true;
    setLauncherPosition(clampPosition({ left, top }));
  }, [setLauncherPosition]);

  if (open || hidden) return null;

  const style: CSSProperties | undefined = position
    ? { left: position.left, top: bottomInset ? `min(${position.top}px, calc(100dvh - ${LAUNCHER_SIZE + 24 + bottomInset}px))` : position.top }
    : bottomInset ? { bottom: bottomInset + 24 } : undefined;

  return <div className={cn("fixed z-[calc(var(--z-overlay)-1)] h-14 w-14", !position && "bottom-5 right-5 sm:bottom-6 sm:right-6", className)} style={style}>
    <span aria-hidden="true" className="pointer-events-none absolute -inset-2 rounded-full bg-primary/25 blur-md" />
    <button
      ref={triggerRef as RefObject<HTMLButtonElement | null> | undefined}
      type="button"
      {...dataAttributes}
      aria-label={label}
      title={label}
      onClick={() => { if (suppressClickRef.current) { suppressClickRef.current = false; return; } onOpenChange(true); }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      className={cn("relative size-14 overflow-hidden rounded-full border border-white/30 bg-[#161b62] p-0 text-white shadow-[0_12px_30px_-8px_color-mix(in_srgb,var(--brand)_70%,transparent)] transition-transform hover:scale-105 hover:brightness-110 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", dragging ? "cursor-grabbing scale-105" : "cursor-grab")}
    >
      <span aria-hidden="true" className="pointer-events-none absolute -inset-5 rounded-[45%] blur-[5px] motion-safe:animate-[assistant-wave_5s_ease-in-out_infinite]"
        style={{ background: "radial-gradient(ellipse at 24% 28%, rgba(196,181,253,.98), transparent 48%), radial-gradient(ellipse at 78% 78%, rgba(37,99,235,.98), transparent 54%), linear-gradient(135deg, #312e81, #11154e 58%, #050817)" }} />
      <span aria-hidden="true" className="pointer-events-none absolute -inset-6 rounded-[48%] opacity-75 blur-[4px] motion-safe:animate-[assistant-wave-secondary_7s_ease-in-out_infinite]"
        style={{ background: "radial-gradient(ellipse at 72% 22%, rgba(129,140,248,.88), transparent 42%), radial-gradient(ellipse at 28% 78%, rgba(14,165,233,.78), transparent 48%)" }} />
      <span className="relative z-10 grid place-items-center">{icon}</span>
    </button>
  </div>;
}
