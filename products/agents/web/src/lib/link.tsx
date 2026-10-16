import { Link as RouterLink } from "react-router-dom";
import type { ComponentProps } from "react";
import { appPath } from "./navigation";
type Props = Omit<ComponentProps<"a">, "href"> & { href: string; prefetch?: boolean; scroll?: boolean; replace?: boolean };
export default function Link({ href, prefetch: _prefetch, scroll, replace, ...props }: Props) {
  void _prefetch;
  if (!href.startsWith("/") || href.startsWith("//")) return <a href={href} {...props} />;
  return <RouterLink to={appPath(href)} replace={replace} preventScrollReset={scroll === false} {...props} />;
}
