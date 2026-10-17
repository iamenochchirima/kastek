import { createBrowserRouter, Navigate, Link } from "react-router-dom";
import { Login, WorkspaceShell } from "@/platform/shell";
import { AgentsList, AgentEditor } from "@/platform/agents";
import { KnowledgePage } from "@/platform/knowledge";
import { WebsiteChat } from "@/platform/website";

function NotFound() {
  return <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground"><div className="mx-auto max-w-xl space-y-5"><h1 className="text-2xl font-semibold">Page not found</h1><Link to="/app/agents" className="text-sm underline underline-offset-4">Open Agents</Link></div></main>;
}
export const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/app/agents" replace /> },
  { path: "/login", Component: Login },
  { path: "/chat/:deploymentId", Component: WebsiteChat },
  { path: "/app", Component: WorkspaceShell, children: [
    { index: true, element: <Navigate to="agents" replace /> },
    { path: "agents", Component: AgentsList },
    { path: "agents/:agentId", Component: AgentEditor },
    { path: "knowledge", Component: KnowledgePage },
  ] },
  { path: "*", Component: NotFound },
]);
