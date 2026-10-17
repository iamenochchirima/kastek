import { PlannedFeature } from "@/components/platform/overview";

export default async function AgentTemplatesPage() {
  return <PlannedFeature title="Agent templates" description="Templates are not available yet. Create a support assistant with your own instructions." action={{ href: "/app/agents/new", label: "Create support assistant" }} />;
}
