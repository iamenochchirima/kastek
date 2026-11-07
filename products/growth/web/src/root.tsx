import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError, isRouteErrorResponse, Link, useNavigation } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import PwaRegister from "@/components/pwa-register";
import ThemeScript from "@/components/theme-script";
import { ConfirmationProvider } from "@/components/ui/confirmation-provider";
import { Toaster } from "@/components/ui/sonner";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./app/globals.css";
export const meta = () => [{ name: "robots", content: "noindex, nofollow" }];
export function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head>
    <meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#111316" /><link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" /><link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" /><link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png" /><link rel="apple-touch-icon" href="/apple-touch-icon.png" /><Meta /><Links /><ThemeScript />
  </head><body className="font-sans antialiased">{children}<ScrollRestoration /><Scripts /></body></html>;
}
function NavigationProgress() {
  const navigation = useNavigation();
  return navigation.state === "idle" ? null : <div role="progressbar" aria-label="Loading page" className="fixed inset-x-0 top-0 z-[100] h-1 animate-pulse bg-primary" />;
}
export default function App() {
  return <QueryClientProvider client={queryClient}><ConfirmationProvider><NavigationProgress /><Outlet /></ConfirmationProvider><PwaRegister /><Toaster /></QueryClientProvider>;
}
export function HydrateFallback() {
  return <main className="mx-auto max-w-7xl space-y-6 p-8" aria-label="Loading workspace" aria-busy="true"><div className="h-8 w-48 animate-pulse rounded bg-secondary" /><div className="h-48 animate-pulse rounded bg-secondary" /></main>;
}
export function ErrorBoundary() {
  const error = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return <main className="mx-auto max-w-lg space-y-4 p-8"><title>{missing ? "Page not found" : "Unable to load workspace"}</title><meta name="robots" content="noindex" /><h1 className="text-2xl font-semibold">{missing ? "Page not found" : "Unable to load workspace"}</h1><p>{missing ? "Check the address and try again." : "Try again in a moment."}</p><Link to="/" className="underline">Home</Link><button className="ml-4 underline" onClick={() => window.location.reload()}>Retry</button></main>;
}
