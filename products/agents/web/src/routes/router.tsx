import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, Link } from "react-router-dom";
import { WorkspaceShell } from "@/platform/shell";
import { AgentEditor } from "@/platform/agents";
import { KnowledgePage } from "@/platform/knowledge";
import { WebsiteChat } from "@/platform/website";

import { AutomationsPage } from "@/platform/automations";
import { TaskPage } from "@/platform/task";
import { Landing } from "@/platform/landing";
import { Login, Signup } from "@/platform/login";
import { AgentDirectory, AgentWelcome } from "@/platform/agent-directory";
import { TasksPage } from "@/platform/tasks";
import { SettingsPage } from "@/platform/settings";
import { ConnectionsPage } from "@/platform/connections";
import { CustomersPage } from "@/platform/customer-records";
import { InboxPage } from "@/platform/inbox";
import { OverviewPage } from "@/platform/overview";
import { AssistantPage } from "@/platform/assistant";
import { CustomerReturn } from "@/platform/customer-return";
import { McpConsent } from "@/platform/mcp-consent";
import { McpWebsiteReview } from "@/platform/mcp-website-review";
import { McpConfigReview } from "@/platform/mcp-config-review";
import { McpSourceReview } from "@/platform/mcp-source-review";

const LandingV2 = lazy(() => import("@/platform/landing-v2").then(module => ({ default: module.LandingV2 })));

function LandingV2Route() {
  return <Suspense fallback={<main aria-busy="true" aria-label="Loading Agents" style={{ minHeight: "100dvh", background: "#fefefd" }} />}><LandingV2 /></Suspense>;
}

function NotFound() {
  return <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground"><div className="mx-auto max-w-xl space-y-5"><h1 className="text-2xl font-semibold">Page not found</h1><Link to="/app/agents" className="text-sm underline underline-offset-4">Open Agents</Link></div></main>;
}
export const router = createBrowserRouter([
  { path: "/", Component: Landing },
  { path: "/landingv2", Component: LandingV2Route },
  { path: "/signup", Component: Signup },
  { path: "/login", Component: Login },
  { path: "/app/oauth/consent", Component: McpConsent },
  { path: "/app/mcp/website-review", Component: McpWebsiteReview },
  { path: "/app/mcp/config-review", Component: McpConfigReview },
  { path: "/app/mcp/source-review", Component: McpSourceReview },
  { path: "/chat/:deploymentId", Component: WebsiteChat },
  { path: "/support/return/:deploymentId", Component: CustomerReturn },
  { path: "/app", Component: WorkspaceShell, children: [
    { index: true, element: <Navigate to="overview" replace /> },
    { path: "overview", Component: OverviewPage },
    { path: "assistant", Component: AssistantPage },
    { path: "agents", Component: AgentDirectory, children: [
      { index: true, Component: AgentWelcome },
      { path: ":agentId", Component: AgentEditor },
      { path: ":agentId/conversations/:conversationId", Component: AgentEditor },
    ] },
    { path: "tasks", Component: TasksPage },
    { path: "inbox", Component: InboxPage },
    { path: "customers", Component: CustomersPage },
    { path: "settings", Component: SettingsPage },
    { path: "knowledge", Component: KnowledgePage },
    { path: "connections", Component: ConnectionsPage },
    { path: "automations", Component: AutomationsPage },
    { path: "tasks/:taskId", Component: TaskPage },
  ] },
  { path: "*", Component: NotFound },
]);
