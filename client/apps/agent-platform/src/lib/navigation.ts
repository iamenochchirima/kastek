import { useLocation, useNavigate, useRevalidator, useSearchParams as useRouteSearchParams, redirect as routeRedirect } from "react-router-dom";
export function appPath(href: string) {
  return /^\/(agents|studio|playground)(\/|\?|$)/.test(href) ? `/app${href}` : href;
}
export function redirect(href: string): never { throw routeRedirect(appPath(href)); }
export function notFound(): never { throw new Response("Page not found", { status: 404 }); }
export function usePathname() { return useLocation().pathname; }
export function useSearchParams() { return useRouteSearchParams()[0]; }
export function useRouter() {
  const navigate = useNavigate(); const revalidator = useRevalidator();
  return {
    push: (href: string, options?: { scroll?: boolean }) => navigate(appPath(href), { preventScrollReset: options?.scroll === false }),
    replace: (href: string, options?: { scroll?: boolean }) => navigate(appPath(href), { replace: true, preventScrollReset: options?.scroll === false }),
    refresh: () => revalidator.revalidate(),
    back: () => navigate(-1),
  };
}
