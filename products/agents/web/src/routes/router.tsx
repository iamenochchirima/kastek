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
import { InboxPage } from "@/platform/inbox";

function NotFound() {
  return <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground"><div className="mx-auto max-w-xl space-y-5"><h1 className="text-2xl font-semibold">Page not found</h1><Link to="/app/agents" className="text-sm underline underline-offset-4">Open Agents</Link></div></main>;
}
export const router = createBrowserRouter([
  { path: "/", Component: Landing },
  { path: "/signup", Component: Signup },
  { path: "/login", Component: Login },
  { path: "/chat/:deploymentId", Component: WebsiteChat },
  { path: "/app", Component: WorkspaceShell, children: [
    { index: true, element: <Navigate to="agents" replace /> },
    { path: "agents", Component: AgentDirectory, children: [
      { index: true, Component: AgentWelcome },
      { path: ":agentId", Component: AgentEditor },
      { path: ":agentId/conversations/:conversationId", Component: AgentEditor },
    ] },
    { path: "tasks", Component: TasksPage },
    { path: "inbox", Component: InboxPage },
    { path: "settings", Component: SettingsPage },
    { path: "knowledge", Component: KnowledgePage },
    { path: "connections", Component: ConnectionsPage },
    { path: "automations", Component: AutomationsPage },
    { path: "tasks/:taskId", Component: TaskPage },
  ] },
  { path: "*", Component: NotFound },
]);
