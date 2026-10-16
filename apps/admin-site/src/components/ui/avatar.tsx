import type { ImgHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Avatar({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="avatar" className={cn("relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-xs font-semibold text-secondary-foreground", className)} {...props} />;
}

export function AvatarImage({ className, alt = "", ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  // Avatar images are intentionally native so the primitive stays usable for arbitrary external URLs.
  // eslint-disable-next-line @next/next/no-img-element
  return <img data-slot="avatar-image" className={cn("aspect-square size-full object-cover", className)} alt={alt} {...props} />;
}

export function AvatarFallback({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="avatar-fallback" className={cn("grid size-full place-items-center", className)} {...props} />;
}
