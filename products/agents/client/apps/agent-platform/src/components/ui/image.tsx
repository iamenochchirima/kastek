import type { ComponentProps } from "react";
type Props = ComponentProps<"img"> & { fill?: boolean; priority?: boolean; unoptimized?: boolean };
export default function Image({ fill, priority, unoptimized: _unoptimized, style, loading, ...props }: Props) {
  void _unoptimized;
  return <img {...props} loading={loading ?? (priority ? "eager" : "lazy")} style={fill ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...style } : style} />;
}
