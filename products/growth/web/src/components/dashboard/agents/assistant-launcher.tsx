import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

const POSITION_KEY = "kasitek:growth-assistant-launcher-position";
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
  return {
    left: Math.min(Math.max(gutter, position.left), maxLeft),
    top: Math.min(Math.max(gutter, position.top), maxTop),
  };
}

function readSavedPosition(): LauncherPosition | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(POSITION_KEY) ?? "null") as Partial<LauncherPosition> | null;
    if (typeof value?.left !== "number" || typeof value.top !== "number") return null;
    return clampPosition({ left: value.left, top: value.top });
  } catch {
    return null;
  }
}

function savePosition(position: LauncherPosition) {
  try {
    window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  } catch {
    // The launcher remains usable when storage is unavailable.
  }
}

export function GrowthAssistantLauncher({
  open,
  hidden = false,
  reduceMotion = false,
  onOpen,
}: {
  open: boolean;
  hidden?: boolean;
  reduceMotion?: boolean;
  onOpen: () => void;
}) {
  const launcherRef = useRef<HTMLDivElement | null>(null);
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
      const saved = readSavedPosition();
      if (saved) setLauncherPosition(saved);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [setLauncherPosition]);

  useEffect(() => {
    const onResize = () => {
      const current = positionRef.current;
      if (!current) return;
      const next = clampPosition(current);
      setLauncherPosition(next);
      savePosition(next);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [setLauncherPosition]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
    if (drag.moved) {
      suppressClickRef.current = true;
      if (positionRef.current) savePosition(positionRef.current);
    }
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      startLeft: rect.left,
      startTop: rect.top,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const left = event.clientX - drag.offsetX;
    const top = event.clientY - drag.offsetY;
    if (!drag.moved && Math.hypot(left - drag.startLeft, top - drag.startTop) >= DRAG_THRESHOLD) {
      drag.moved = true;
    }
    setLauncherPosition(clampPosition({ left, top }));
  }, [setLauncherPosition]);

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpen();
  }, [onOpen]);

  if (open || hidden) return null;

  const style: CSSProperties | undefined = position
    ? { left: position.left, top: position.top }
    : undefined;

  return (
    <div
      ref={launcherRef}
      className={cn(
        "fixed z-[var(--z-floating)] h-14 w-14",
        !position && "bottom-5 right-5 sm:bottom-6 sm:right-6",
      )}
      style={style}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -inset-2 rounded-full bg-primary/25 blur-md"
      />
      <Button
        type="button"
        data-growth-assistant-launcher
        aria-label="Open Growth assistant"
        title="Open Growth assistant"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        className={cn(
          "relative h-14 w-14 overflow-hidden rounded-full border border-white/30 bg-[#161b62] p-0 text-white shadow-[0_12px_30px_-8px_color-mix(in_srgb,var(--brand)_70%,transparent)] hover:scale-105 hover:brightness-110",
          dragging ? "cursor-grabbing scale-105" : "cursor-grab",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -inset-5 rounded-[45%] blur-[5px]",
            !reduceMotion && "motion-safe:animate-[assistant-wave_5s_ease-in-out_infinite]",
          )}
          style={{
            background:
              "radial-gradient(ellipse at 24% 28%, rgba(196,181,253,.98), transparent 48%), radial-gradient(ellipse at 78% 78%, rgba(37,99,235,.98), transparent 54%), linear-gradient(135deg, #312e81, #11154e 58%, #050817)",
          }}
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute -inset-6 rounded-[48%] opacity-75 blur-[4px]",
            !reduceMotion && "motion-safe:animate-[assistant-wave-secondary_7s_ease-in-out_infinite]",
          )}
          style={{
            background:
              "radial-gradient(ellipse at 72% 22%, rgba(129,140,248,.88), transparent 42%), radial-gradient(ellipse at 28% 78%, rgba(14,165,233,.78), transparent 48%)",
          }}
        />
        <Sparkles className="relative z-10 h-6 w-6 drop-shadow-[0_1px_3px_rgba(0,0,0,.4)]" aria-hidden="true" />
      </Button>
    </div>
  );
}
