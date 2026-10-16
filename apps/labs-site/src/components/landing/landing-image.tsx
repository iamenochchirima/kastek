import type { ComponentProps } from "react";

/** Local WebP assets keep the authored crops and work inside native HTML templates. */
export function LandingImage({ alt = "", ...props }: ComponentProps<"img">) {
  // eslint-disable-next-line @next/next/no-img-element -- Images are already optimized local assets.
  return <img {...props} alt={alt} />;
}
