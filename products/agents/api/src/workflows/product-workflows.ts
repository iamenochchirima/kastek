/**
 * Product workflow presentation metadata. These definitions point at the
 * existing product routes and capabilities; they are not a second workflow
 * engine and do not own business state.
 */
export type ProductWorkflowId = "agent_creation" | "social_connections" | "content_operations" | "workspace_reporting";

export interface ProductWorkflowDefinition {
  id: ProductWorkflowId;
  title: string;
  description: string;
  entryPath: string;
  capabilities: readonly string[];
}

export const PRODUCT_WORKFLOWS: readonly ProductWorkflowDefinition[] = [
  {
    id: "agent_creation",
    title: "Agent workspace",
    description: "Continue in the agent editor with a saved configuration.",
    entryPath: "/agents/new",
    capabilities: ["agent_definition.create", "agent_version.create", "agent_deployment.publish"],
  },
  {
    id: "social_connections",
    title: "Connections workspace",
    description: "Review connected accounts and provider access.",
    entryPath: "/connections",
    capabilities: ["connections.read", "connections.write"],
  },
  {
    id: "content_operations",
    title: "Content workspace",
    description: "Create, review, schedule, and publish workspace content.",
    entryPath: "/content",
    capabilities: ["content.read", "content.write", "content.publish"],
  },
  {
    id: "workspace_reporting",
    title: "Workspace report",
    description: "Review activity across connections, content, inbox, bookings, campaigns, and templates.",
    entryPath: "/workspace",
    capabilities: ["workspace.reporting.read"],
  },
];

const byId = new Map(PRODUCT_WORKFLOWS.map((workflow) => [workflow.id, workflow]));

export function getProductWorkflow(id: ProductWorkflowId): ProductWorkflowDefinition {
  return byId.get(id)!;
}
