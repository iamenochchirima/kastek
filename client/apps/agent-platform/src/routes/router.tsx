import type { ReactNode } from "react";
import { createBrowserRouter, Navigate, Link, useLoaderData, useRouteError, isRouteErrorResponse, type LoaderFunctionArgs } from "react-router-dom";
import { AppShell } from "@/components/platform/app-shell";
import { Overview, PlannedFeature } from "@/components/platform/overview";
import { Landing, SignIn } from "@/components/platform/landing";
import { getSession } from "@/lib/session";
import { ApiError } from "@/lib/api-client";
import { redirect } from "@/lib/navigation";
type PageController = (props: { params: Promise<Record<string, string | undefined>>; searchParams: Promise<Record<string, string>> }) => Promise<ReactNode>;
function LoadedScreen() { return useLoaderData() as ReactNode; }
function RouteError() {
  const error = useRouteError();
  const status = error instanceof ApiError ? error.status : isRouteErrorResponse(error) ? error.status : undefined;
  return <div className="mx-auto max-w-xl px-6 py-20"><h1 className="text-2xl font-semibold">{status === 404 ? "This page or endpoint is not available yet" : "We couldn't open this page"}</h1><p className="mt-4 text-sm leading-6 text-muted-foreground">{error instanceof ApiError ? "We couldn’t connect to your workspace. Please try again shortly." : "Try again, or return to the home page."}</p><div className="mt-7 flex gap-5"><button className="text-sm text-primary" onClick={() => window.location.reload()}>Try again</button><Link className="text-sm text-primary" to="/">Back to home</Link></div></div>;
}
async function requireSession() {
  try { const session = await getSession(); if (!session?.user?.id) redirect("/login"); return session; }
  catch (error) { if (error instanceof ApiError && error.status === 401) redirect("/login"); throw error; }
}
export const router = createBrowserRouter([
  { path: "/", Component: Landing },
  { path: "/login", Component: SignIn },
  { path: "/signup", element: <SignIn signup /> },
  { path: "/app", Component: AppShell, loader: requireSession, errorElement: <RouteError />, children: [
    { index: true, Component: Overview },
    { path: "agents/:agentId/appearance", lazy: async () => {
      const page = await import("./screens/agents/[agentId]/appearance/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/:agentId", lazy: async () => {
      const page = await import("./screens/agents/[agentId]/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/:agentId/workflow", lazy: async () => {
      const page = await import("./screens/agents/[agentId]/workflow/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/activity/:runId", lazy: async () => {
      const page = await import("./screens/agents/activity/[runId]/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/activity", lazy: async () => {
      const page = await import("./screens/agents/activity/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/analytics", lazy: async () => {
      const page = await import("./screens/agents/analytics/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/connect", lazy: async () => {
      const page = await import("./screens/agents/connect/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/conversations", lazy: async () => {
      const page = await import("./screens/agents/conversations/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/new/general", lazy: async () => {
      const page = await import("./screens/agents/new/general/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/new", lazy: async () => {
      const page = await import("./screens/agents/new/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents", lazy: async () => {
      const page = await import("./screens/agents/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "agents/templates", lazy: async () => {
      const page = await import("./screens/agents/templates/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "playground", lazy: async () => {
      const page = await import("./screens/playground/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "studio/new", lazy: async () => {
      const page = await import("./screens/studio/new/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "studio", lazy: async () => {
      const page = await import("./screens/studio/page");
      return { loader: ({ params, request }: LoaderFunctionArgs) => (page.default as unknown as PageController)({ params: Promise.resolve(params), searchParams: Promise.resolve(Object.fromEntries(new URL(request.url).searchParams)) }), Component: LoadedScreen };
    } },
    { path: "inbox", element: <PlannedFeature title="Inbox" description="Live customer conversations, teammate replies and human handoff. The Agents-owned inbox will also connect to Growth." /> },
    { path: "knowledge", element: <PlannedFeature title="Knowledge" description="Manage the sources your agents use to answer questions." /> },
    { path: "connections", element: <PlannedFeature title="Connections" description="Connect channels, external tools and product capabilities to your agents." /> },
    { path: "usage", element: <PlannedFeature title="Usage" description="Review model usage, runtime costs and workspace budgets." /> },
    { path: "settings", element: <PlannedFeature title="Settings" description="Manage your organization, account and interface preferences." /> },
  ] },
  { path: "/agents/*", loader: ({ request }) => { const url = new URL(request.url); redirect(`/app${url.pathname}${url.search}`); } },
  { path: "/studio/*", loader: ({ request }) => { const url = new URL(request.url); redirect(`/app${url.pathname}${url.search}`); } },
  { path: "/playground", element: <Navigate to="/app/playground" replace /> },
  { path: "*", element: <RouteError /> },
]);
