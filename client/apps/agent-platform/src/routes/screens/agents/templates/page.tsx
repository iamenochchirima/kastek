import { PlannedFeature } from "@/components/platform/overview";

export default async function AgentTemplatesPage() {
  return <PlannedFeature title="Agent templates" description="Template selection and its setup integrations are not connected yet. Create a hosted agent with your own instructions in Studio." action={{ href: "/app/studio/new", label: "Create in Studio" }} />;
}
