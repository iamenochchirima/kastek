import { useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Grip, Play, X } from "@/components/ui/interface-icons";
import type { SocialPostMedia } from "./social-shared";

type Attachment = Pick<SocialPostMedia, "assetId" | "kind" | "altText" | "fileName" | "durationMs">;
type Placement = { targetId: string; side: "before" | "after" };

function videoDuration(durationMs: number | null) {
  if (!durationMs) return "";
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ComposerMediaGrid({
  media,
  mediaUrl,
  onMove,
  onRemove,
}: {
  media: Attachment[];
  mediaUrl: (assetId: string) => string;
  onMove: (assetId: string, targetId: string, side: Placement["side"]) => void;
  onRemove: (assetId: string) => void;
}) {
  const pointer = useRef<{ id: number; assetId: string; x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const grid = useRef<HTMLOListElement>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [insertion, setInsertion] = useState<Placement | null>(null);
  const [announcement, setAnnouncement] = useState("");

  function endDrag() {
    pointer.current = null;
    setDragging(null);
    setInsertion(null);
  }

  function move(assetId: string, { targetId, side }: Placement) {
    const remaining = media.filter(item => item.assetId !== assetId);
    const targetIndex = remaining.findIndex(item => item.assetId === targetId);
    if (targetIndex < 0) return;
    const position = targetIndex + (side === "after" ? 1 : 0);
    if (media[position]?.assetId === assetId) return;
    onMove(assetId, targetId, side);
    setAnnouncement(`Moved to position ${position + 1} of ${media.length}.`);
  }

  function dropPlacement(event: PointerEvent<HTMLButtonElement>): Placement | null {
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    if (!hit || !grid.current?.contains(hit)) return null;
    const tile = hit.closest<HTMLElement>("[data-composer-media]") ?? Array.from(grid.current.querySelectorAll<HTMLElement>("[data-composer-media]")).find(item => {
      const { left, right, top, bottom } = item.getBoundingClientRect();
      return event.clientX >= left - 6 && event.clientX <= right + 6 && event.clientY >= top - 6 && event.clientY <= bottom + 6;
    });
    if (!tile) return null;
    const targetId = tile.dataset.composerMedia;
    if (!targetId || targetId === pointer.current?.assetId) return null;
    const { left, width } = tile.getBoundingClientRect();
    return { targetId, side: event.clientX < left + width / 2 ? "before" : "after" };
  }

  return (
    <>
      <ol ref={grid} aria-label="Media publishing order" className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {media.map((item, index) => {
          const number = index + 1;
          const label = item.altText || item.fileName || (item.kind === "VIDEO" ? "Video" : "Image");
          const marker = insertion?.targetId === item.assetId ? insertion.side : null;
          return (
            <li key={item.assetId} data-composer-media={item.assetId} className="relative min-w-0">
              {marker ? <span aria-hidden="true" data-insertion={marker} className={`pointer-events-none absolute inset-y-0 w-0.5 rounded-full bg-primary ${marker === "before" ? "-left-[7px]" : "-right-[7px]"}`} /> : null}
              <div className={`relative aspect-[2/1] overflow-hidden rounded-lg bg-muted ring-1 ring-inset ring-border ${dragging === item.assetId ? "z-10 outline-2 outline-primary shadow-lg motion-safe:-translate-y-1 motion-safe:rotate-1" : ""}`}>
                {item.kind === "VIDEO" ? (
                  <video className="h-full w-full object-cover" src={mediaUrl(item.assetId)} aria-label={label} muted playsInline preload="metadata" />
                ) : (
                  <img width={640} height={320} className="h-full w-full object-cover" src={mediaUrl(item.assetId)} alt={label} draggable={false} />
                )}
                <div aria-hidden="true" className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 text-xs font-medium">
                  <span className="grid min-w-6 place-items-center rounded bg-black/80 px-1.5 py-0.5 text-white">{number}</span>
                  {index === 0 && media.length > 1 ? <span className="rounded bg-primary px-1.5 py-0.5 text-primary-foreground">Cover</span> : null}
                </div>
                <Button type="button" variant="ghost" size="icon" className="absolute right-1 top-1 size-11 rounded-md sm:size-9 bg-black/75 text-white hover:bg-black hover:text-white" onClick={() => onRemove(item.assetId)} aria-label={`Remove media ${number}: ${label}`}>
                  <X className="size-4" />
                </Button>
                {media.length > 1 ? (
                  <DropdownMenu open={openMenu === item.assetId} onOpenChange={open => setOpenMenu(open ? item.assetId : null)}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute bottom-1 left-1 size-11 touch-none select-none cursor-grab rounded-md bg-black/75 text-white hover:bg-black hover:text-white active:cursor-grabbing sm:size-9"
                        aria-label={`Reorder media ${number}: ${label}`}
                        onPointerDown={event => {
                          if (event.button !== 0 || !event.isPrimary) return;
                          // Radix opens on pointer-down by default. Wait for a click so the same handle can drag.
                          event.preventDefault();
                          suppressClick.current = false;
                          pointer.current = { id: event.pointerId, assetId: item.assetId, x: event.clientX, y: event.clientY, moved: false };
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerMove={event => {
                          const active = pointer.current;
                          if (!active || active.id !== event.pointerId) return;
                          if (!active.moved && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 6) return;
                          if (!active.moved) {
                            active.moved = true;
                            setDragging(item.assetId);
                          }
                          const next = dropPlacement(event);
                          setInsertion(current => current?.targetId === next?.targetId && current?.side === next?.side ? current : next);
                        }}
                        onPointerUp={event => {
                          const active = pointer.current;
                          if (!active || active.id !== event.pointerId) return;
                          suppressClick.current = active.moved;
                          const next = active.moved ? dropPlacement(event) : null;
                          if (next) move(active.assetId, next);
                          endDrag();
                        }}
                        onPointerCancel={endDrag}
                        onLostPointerCapture={endDrag}
                        onClick={event => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          event.currentTarget.focus();
                          setOpenMenu(item.assetId);
                        }}
                      >
                        <Grip className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem disabled={index === 0} onSelect={() => move(item.assetId, { targetId: media[index - 1].assetId, side: "before" })}>Move earlier</DropdownMenuItem>
                      <DropdownMenuItem disabled={index === media.length - 1} onSelect={() => move(item.assetId, { targetId: media[index + 1].assetId, side: "after" })}>Move later</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
                {item.kind === "VIDEO" ? <span className="pointer-events-none absolute bottom-2 right-2 inline-flex items-center gap-1 rounded bg-black/80 px-1.5 py-0.5 text-xs text-white"><Play className="size-3" /><span className="sr-only">Video</span>{videoDuration(item.durationMs)}</span> : null}
              </div>
            </li>
          );
        })}
      </ol>
      <p role="status" className="sr-only">{announcement}</p>
    </>
  );
}
